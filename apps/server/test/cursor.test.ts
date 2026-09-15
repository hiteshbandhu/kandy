import test from "node:test"
import assert from "node:assert/strict"

import { cursor } from "../dist/agents/cursor.js"

/**
 * Every line below is real output, captured from
 * `cursor-agent -p --output-format stream-json` (2026.09.11-76b1558), trimmed
 * to the fields the adapter reads.
 */
const line = (o: unknown) => JSON.stringify(o)

const POLICY = { cwd: "/w", prompt: "go", policy: "repo" as const }

test("the session id comes off the init frame, which is what --resume takes", () => {
  const out = cursor.parse(
    line({
      type: "system",
      subtype: "init",
      session_id: "7d400fa2-0e41-4b5e-be2a-8745d4ddb901",
      model: "Cursor Grok 4.6 High Fast",
    }),
  )
  assert.deepEqual(out, [
    { kind: "session", sessionId: "7d400fa2-0e41-4b5e-be2a-8745d4ddb901" },
  ])
})

test("the workspace trust banner is an error, not a line of prose", () => {
  // It arrives as plain text and Cursor then exits *zero*. Left as text this
  // is a run that did nothing and reported success.
  const out = cursor.parse("⚠ Workspace Trust Required")
  assert.equal(out[0]?.kind, "error")
})

test("--trust is always passed, because without it the run silently does nothing", () => {
  const spec = cursor.spawn(POLICY)
  assert.ok(spec.args.includes("--trust"))
})

test("repo policy sandboxes; full access is the only thing that turns it off", () => {
  const repo = cursor.spawn(POLICY)
  assert.deepEqual(
    repo.args.slice(repo.args.indexOf("--sandbox"), repo.args.indexOf("--sandbox") + 2),
    ["--sandbox", "enabled"],
  )
  assert.ok(!repo.args.includes("--force"), "repo policy must not force-allow commands")

  const full = cursor.spawn({ ...POLICY, policy: "full" })
  assert.ok(full.args.includes("--force"))
  assert.ok(full.args.includes("disabled"))
})

test("a resumed run carries the session id Cursor gave us", () => {
  const spec = cursor.spawn({ ...POLICY, resume: "abc-123" })
  assert.deepEqual(
    spec.args.slice(spec.args.indexOf("--resume"), spec.args.indexOf("--resume") + 2),
    ["--resume", "abc-123"],
  )
})

test("a tool is named by its key, not by a field", () => {
  // `{ tool_call: { shellToolCall: … } }` — the identity is the key, so a tool
  // Cursor adds later still lands in the transcript under its own name.
  const out = cursor.parse(
    line({
      type: "tool_call",
      subtype: "started",
      tool_call: { shellToolCall: { args: { command: "touch sandboxed.txt" } } },
    }),
  )
  assert.deepEqual(out, [
    { kind: "tool", tool: "shell", detail: "touch sandboxed.txt", status: "started" },
  ])
})

test("an unfamiliar tool keeps its own name rather than vanishing", () => {
  const out = cursor.parse(
    line({
      type: "tool_call",
      subtype: "completed",
      tool_call: { somethingNewToolCall: { args: { description: "does a thing" } } },
    }),
  )
  assert.deepEqual(out, [
    { kind: "tool", tool: "somethingNew", detail: "does a thing", status: "completed" },
  ])
})

test("a sandbox refusal is blocked; an ordinary failure is not", () => {
  const refused = cursor.parse(
    line({
      type: "tool_call",
      subtype: "completed",
      tool_call: {
        shellToolCall: {
          args: { command: "touch /etc/x" },
          toolCallId: "call-1",
          result: {
            failure: { exitCode: 1, stderr: "touch: /etc/x: Permission denied\n" },
          },
        },
      },
    }),
  )
  assert.equal(refused[0]?.kind, "blocked")

  const failed = cursor.parse(
    line({
      type: "tool_call",
      subtype: "completed",
      tool_call: {
        shellToolCall: {
          args: { command: "npm test" },
          result: { failure: { exitCode: 1, stderr: "1 failing" } },
        },
      },
    }),
  )
  assert.equal(failed[0]?.kind, "tool")
  assert.equal(failed[0]?.kind === "tool" && failed[0].status, "failed")
})

test("output mentioning permissions does not block a command that succeeded", () => {
  // The Codex lesson, applied here before it can bite: `cat` of a document
  // about permissions must not mark the note blocked.
  const out = cursor.parse(
    line({
      type: "tool_call",
      subtype: "completed",
      tool_call: {
        shellToolCall: {
          args: { command: "cat docs/05-agent-auth.md" },
          result: { success: { exitCode: 0, stdout: "… permission denied …" } },
        },
      },
    }),
  )
  assert.equal(out[0]?.kind, "tool")
  assert.equal(out[0]?.kind === "tool" && out[0].status, "completed")
})

test("result reports usage with cache counted on top, not backed out", () => {
  // Cursor's inputTokens excludes the cache buckets — the captured run shows
  // 23,853 input beside 24,448 cache reads, which cannot both describe one
  // inclusive figure.
  const out = cursor.parse(
    line({
      type: "result",
      subtype: "success",
      is_error: false,
      usage: { inputTokens: 23853, outputTokens: 577, cacheReadTokens: 24448, cacheWriteTokens: 0 },
    }),
  )
  const usage = out.find((e) => e.kind === "usage")
  assert.ok(usage && usage.kind === "usage")
  assert.deepEqual(usage.usage, { input: 23853, output: 577, cacheRead: 24448, cacheWrite: 0 })
  assert.equal(usage.tokens, 48878)
  assert.equal(usage.costUsd, null, "Cursor bills a subscription and reports no money")
  assert.ok(out.some((e) => e.kind === "turn_end"))
})

test("the display name Cursor reports is never used to price a run", () => {
  // "Cursor Grok 4.6 High Fast" is not a model id. Pricing against it would
  // either miss or prefix-match something unrelated.
  cursor.spawn(POLICY)
  cursor.parse(line({ type: "system", subtype: "init", model: "Cursor Grok 4.6 High Fast" }))
  const out = cursor.parse(line({ type: "result", usage: { inputTokens: 1, outputTokens: 1 } }))
  const usage = out.find((e) => e.kind === "usage")
  assert.ok(usage && usage.kind === "usage")
  assert.equal(usage.model, null)
})

test("a pinned model is what prices the run", () => {
  cursor.spawn({ ...POLICY, model: "claude-opus-5" })
  const out = cursor.parse(line({ type: "result", usage: { inputTokens: 1, outputTokens: 1 } }))
  const usage = out.find((e) => e.kind === "usage")
  assert.ok(usage && usage.kind === "usage")
  assert.equal(usage.model, "claude-opus-5")
})

test("thinking deltas and our own echoed prompt stay out of the transcript", () => {
  assert.deepEqual(cursor.parse(line({ type: "thinking", subtype: "delta", text: "hm" })), [])
  assert.deepEqual(
    cursor.parse(
      line({ type: "user", message: { role: "user", content: [{ type: "text", text: "go" }] } }),
    ),
    [],
  )
})

test("what the agent says becomes text", () => {
  const out = cursor.parse(
    line({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "`a.txt` says hello." }] },
    }),
  )
  assert.deepEqual(out, [{ kind: "text", text: "`a.txt` says hello." }])
})

test("cursor does not claim it can be asked", () => {
  // `-p` decides alone. Advertising otherwise shows a question that never
  // arrives. Keep in step with ASK_CAPABLE in @kandy/core.
  assert.ok(!cursor.asks)
  assert.equal(cursor.live, undefined)
})
