import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import type { AgentAdapter, AgentEvent } from "./types.js"

/**
 * Cursor Agent adapter, written against real captured output from
 * `cursor-agent -p --output-format stream-json` (2026.09.11-76b1558), not docs.
 *
 * The envelope looks like Claude's — `system`/`assistant`/`result`, a
 * `session_id` on every line — and then stops looking like it:
 *
 *   system   { subtype: "init", session_id, model }   ← the id `--resume` takes
 *   thinking { subtype: "delta" | "completed", text }
 *   assistant{ message: { content: [{ type: "text", text }] } }
 *   tool_call{ subtype: "started" | "completed",
 *              tool_call: { <name>ToolCall: { args, result } } }
 *   result   { is_error, usage: { inputTokens, outputTokens, … } }
 *
 * Tool calls are not a tagged union on `type`: the tool's identity is the name
 * of the single key inside `tool_call` — `readToolCall`, `shellToolCall`,
 * `editToolCall`. New tools therefore arrive as new keys rather than new enum
 * values, so the name is derived from the key instead of matched against a
 * list that would silently drop anything Cursor adds later.
 *
 * The one flag that is not optional is `--trust`. Without it Cursor refuses an
 * untrusted workspace by printing `⚠ Workspace Trust Required` and exiting
 * **zero** — a run that did nothing, reported nothing, and looked like a
 * success. kandy spawns into a worktree the user already asked an agent to
 * work in, so the trust decision was made before the process started; the
 * banner is also parsed below, because a flag can always be dropped by a
 * future version and a silent no-op must never be silent twice.
 *
 * Cursor reports tokens but never a dollar figure — it bills against a
 * subscription, not per call — so cost stays null and kandy prices the tokens.
 */

/** Set by spawn(), read by parse() — the model this process was told to use. */
let pinnedModel: string | undefined

export const cursor: AgentAdapter = {
  id: "cursor",
  bin: "cursor-agent",
  readAuth: () => readCursorAuth(),
  // Written on first launch and kept whether or not anyone is signed in, which
  // is why `readAuth` below has the final word.
  credentials: [path.join(homedir(), ".cursor", "cli-config.json")],

  spawn({ prompt, resume, policy, model }) {
    const full = policy === "full"
    pinnedModel = model

    return {
      command: "cursor-agent",
      args: [
        "-p",
        "--output-format",
        "stream-json",
        // See above: without this the run is a no-op that exits 0.
        "--trust",
        // `-p` already grants every tool including write and shell, so the
        // sandbox — not an approval mode — is what `repo` actually buys. Full
        // access turns it off and allows commands outright, which is the
        // user's explicit choice and never our default.
        ...(full ? ["--force", "--sandbox", "disabled"] : ["--sandbox", "enabled"]),
        ...(model ? ["--model", model] : []),
        ...(resume ? ["--resume", resume] : []),
        prompt,
      ],
    }
  },

  parse(line) {
    const text = line.replace(/\r$/, "")
    if (!text.trim()) return []

    let msg: Record<string, any>
    try {
      msg = JSON.parse(text)
    } catch {
      // Cursor's own diagnostics are plain text on the same stream. The trust
      // banner is the one that matters: it ends the run without an error, so
      // nothing downstream would ever notice it.
      if (/workspace trust required/i.test(text)) {
        return [
          {
            kind: "error",
            message: `${text.trim()} — cursor-agent refused the worktree; --trust was not honoured`,
          },
        ]
      }
      return [{ kind: "text", text }]
    }

    const out: AgentEvent[] = []
    if (typeof msg["session_id"] === "string") {
      out.push({ kind: "session", sessionId: msg["session_id"] })
    }

    switch (msg["type"]) {
      case "assistant": {
        for (const block of msg["message"]?.content ?? []) {
          if (block?.type === "text" && block.text?.trim()) {
            out.push({ kind: "text", text: block.text })
          }
        }
        break
      }

      case "tool_call":
        out.push(...fromToolCall(msg))
        break

      case "result": {
        const u = (msg["usage"] ?? {}) as Record<string, number>
        const cacheRead = u["cacheReadTokens"] ?? 0
        const cacheWrite = u["cacheWriteTokens"] ?? 0
        // Unlike Codex, Cursor's inputTokens excludes the cache buckets — the
        // captured runs report 23,853 input alongside 24,448 cache reads, which
        // could not both be true of one inclusive figure. So they add rather
        // than subtract.
        const input = u["inputTokens"] ?? 0
        const output = u["outputTokens"] ?? 0
        const tokens = input + output + cacheRead + cacheWrite

        out.push({
          kind: "usage",
          text: `${tokens.toLocaleString()} tokens`,
          // Cursor bills a subscription and reports no money.
          costUsd: null,
          tokens,
          turns: 1,
          /*
           * Only the model we pinned. The `system` init line carries one too,
           * but it is a display name — "Cursor Grok 4.6 High Fast" — and
           * feeding that to the price table either misses or, worse, prefix-
           * matches something unrelated. No pin means unpriced, which is the
           * honest answer.
           */
          model: pinnedModel ?? null,
          usage: { input, output, cacheRead, cacheWrite },
        })

        if (msg["is_error"]) {
          out.push({ kind: "error", message: String(msg["result"] ?? "run failed") })
        }
        out.push({ kind: "turn_end" })
        break
      }

      // The agent thinking out loud, streamed a few words at a time. Useful in
      // a terminal, noise in a transcript someone reviews later — and at delta
      // granularity it would be hundreds of frames per run.
      case "thinking":
      // Our own prompt, echoed back. kandy already recorded it.
      case "user":
      case "system":
        break
    }
    return out
  },
}

/**
 * Wording that means the command did not run, as opposed to ran and failed.
 *
 * Under `--sandbox enabled` a refusal reaches us as an ordinary non-zero exit
 * with the operating system's own phrasing on stderr, so — exactly as for
 * Codex — an actual failure is required first and the phrasing is kept tight.
 * Matching output text alone turns every command that prints the word
 * "permission" into a blocked note.
 */
const REFUSAL = /permission denied|operation not permitted|not permitted|read-only file system|sandbox/i

function fromToolCall(msg: Record<string, any>): AgentEvent[] {
  const started = msg["subtype"] === "started"
  const status: "started" | "completed" = started ? "started" : "completed"
  const call = (msg["tool_call"] ?? {}) as Record<string, any>

  // The tool's identity is the key, not a field: `{ shellToolCall: { … } }`.
  const key = Object.keys(call).find((k) => k.endsWith("ToolCall"))
  if (!key) return []
  const body = (call[key] ?? {}) as Record<string, any>
  const tool = NAMES[key] ?? key.slice(0, -"ToolCall".length)

  const args = (body["args"] ?? {}) as Record<string, any>
  const detail = summarize(args)
  // Cursor's call ids contain a literal newline — they are two ids joined —
  // and a request id is something we put in a log line and a UI label.
  const id = String(body["toolCallId"] ?? msg["call_id"] ?? "").replace(/\s+/g, " ").trim()

  // `result` is one of `{ success: … }` or `{ failure: … }`; absent while the
  // call is still running.
  const failure = (body["result"] ?? {})["failure"] as Record<string, any> | undefined
  if (!started && failure) {
    const why = String(failure["stderr"] ?? failure["message"] ?? "")
    if (REFUSAL.test(why)) {
      return [{ kind: "blocked", requestId: id, detail: (why || detail).slice(0, 600) }]
    }
    return [{ kind: "tool", tool, detail: detail.slice(0, 200), status: "failed" }]
  }

  return [{ kind: "tool", tool, detail: detail.slice(0, 200), status }]
}

/** Cursor's key names, in kandy's vocabulary where the two disagree. */
const NAMES: Record<string, string> = {
  shellToolCall: "shell",
  editToolCall: "edit",
  writeToolCall: "edit",
  deleteToolCall: "edit",
  readToolCall: "read",
  lsToolCall: "read",
  globToolCall: "search",
  grepToolCall: "search",
  searchToolCall: "search",
}

/** A one-line gloss of a tool call, for the transcript. */
function summarize(args: Record<string, any>): string {
  const pick = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : null)
  const first =
    pick("command") ??
    pick("path") ??
    pick("file_path") ??
    pick("pattern") ??
    pick("query") ??
    pick("description") ??
    ""
  // Paths are absolute and long; the last two segments are what identifies a
  // file to someone reading the board.
  const short = first.startsWith("/") ? first.split("/").slice(-2).join("/") : first
  return short.replace(/\s+/g, " ")
}

/**
 * Whether anyone is actually signed in to Cursor.
 *
 * `cli-config.json` is written on first launch and survives `cursor-agent
 * logout`, so its existence says only that the CLI has been run. The `authInfo`
 * block is what appears at sign-in and disappears at sign-out, which makes it
 * the difference between "there is a file" and "you can run something".
 *
 * No token is read: the credential itself does not live here, and kandy has no
 * use for it — the spawned child already has its own.
 *
 * Cursor records no expiry anywhere we can see, so that stays null. Null means
 * "it did not say", never "it is fine".
 */
function readCursorAuth(): { expiresAt: number | null; plan: string | null; authed?: boolean } | null {
  try {
    const raw = readFileSync(path.join(homedir(), ".cursor", "cli-config.json"), "utf8")
    const info = (JSON.parse(raw) as Record<string, any>)?.["authInfo"]
    const signedIn = Boolean(info && (info["userId"] || info["email"]))
    return { expiresAt: null, plan: null, authed: signedIn }
  } catch {
    // Unreadable or absent. We know nothing, so we claim nothing.
    return null
  }
}

/**
 * The model Cursor is set to run, from its own config.
 *
 * Cursor's catalogue is account- and plan-specific — `cursor-agent
 * --list-models` is the only authority on it — so kandy does not enumerate it.
 * What it can say is which model this machine is already configured for, and
 * that one is known to work.
 */
export function configuredModel(): string | null {
  try {
    const raw = readFileSync(path.join(homedir(), ".cursor", "cli-config.json"), "utf8")
    const cfg = JSON.parse(raw) as Record<string, any>
    const id = cfg?.["model"]?.["modelId"] ?? cfg?.["selectedModel"]?.["modelId"]
    return typeof id === "string" && id ? id : null
  } catch {
    return null
  }
}
