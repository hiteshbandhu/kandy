import test from "node:test"
import assert from "node:assert/strict"

import { opencode } from "../dist/agents/opencode.js"

/**
 * Shapes taken from opencode's own `run` command — the `emit()` helper in
 * packages/opencode/src/cli/cmd/run.ts and the part schemas it serialises —
 * which is where `--format json` is defined rather than documented.
 */
const line = (o: unknown) => JSON.stringify(o)

const POLICY = { cwd: "/w", prompt: "go", policy: "repo" as const }

test("the session id is on every line, spelled sessionID", () => {
  // Not `session_id` (Claude) and not `thread_id` (Codex). Getting it wrong
  // does not fail loudly — resume and follow-up runs just stop working.
  const out = opencode.parse(line({ type: "step_start", sessionID: "ses_abc", part: {} }))
  assert.deepEqual(out, [{ kind: "session", sessionId: "ses_abc" }])
})

test("a permission refusal arrives as prose, and is still a block", () => {
  // opencode never puts this on the JSON stream. Unparsed it reads as the
  // agent merely choosing not to do the work.
  const out = opencode.parse("!  permission requested: bash (rm -rf *); auto-rejecting")
  assert.equal(out[0]?.kind, "blocked")
  assert.match(
    out[0]?.kind === "blocked" ? out[0].detail : "",
    /permission requested: bash \(rm -rf \*\); auto-rejecting/,
  )
})

test("prose that merely mentions permissions is not a block", () => {
  const out = opencode.parse("Reading docs/05-agent-auth.md — permission denied is discussed there")
  assert.equal(out[0]?.kind, "text")
})

test("full access is the only thing that overrides the user's own rules", () => {
  assert.ok(!opencode.spawn(POLICY).args.includes("--auto"))
  assert.ok(opencode.spawn({ ...POLICY, policy: "full" }).args.includes("--auto"))
})

test("a resumed run continues opencode's session, not a fresh one", () => {
  const spec = opencode.spawn({ ...POLICY, resume: "ses_abc" })
  assert.deepEqual(spec.args.slice(spec.args.indexOf("-s"), spec.args.indexOf("-s") + 2), [
    "-s",
    "ses_abc",
  ])
})

test("the prompt is the last argument, after every flag", () => {
  const spec = opencode.spawn({ ...POLICY, model: "anthropic/claude-opus-5", resume: "ses_abc" })
  assert.equal(spec.args.at(-1), "go")
  assert.equal(spec.args[0], "run")
})

test("step_finish reports tokens with reasoning left out of the buckets", () => {
  const out = opencode.parse(
    line({
      type: "step_finish",
      sessionID: "ses_abc",
      part: {
        type: "step-finish",
        cost: 0.0123,
        tokens: { input: 1000, output: 50, reasoning: 200, cache: { read: 600, write: 100 } },
      },
    }),
  )
  const usage = out.find((e) => e.kind === "usage")
  assert.ok(usage && usage.kind === "usage")
  // Reasoning is already inside output for every provider opencode routes to.
  // Adding it would bill thinking twice.
  assert.deepEqual(usage.usage, { input: 1000, output: 50, cacheRead: 600, cacheWrite: 100 })
  assert.equal(usage.tokens, 1750)
  assert.equal(usage.costUsd, 0.0123, "opencode's own price is better than ours")
})

test("a zero cost is unpriced, not free", () => {
  // A subscription or a local model reports 0.00, which is indistinguishable
  // from free. Recording it as a run that cost nothing understates the board.
  const out = opencode.parse(
    line({
      type: "step_finish",
      sessionID: "ses_abc",
      part: { type: "step-finish", cost: 0, tokens: { input: 10, output: 2, cache: { read: 0, write: 0 } } },
    }),
  )
  const usage = out.find((e) => e.kind === "usage")
  assert.ok(usage && usage.kind === "usage")
  assert.equal(usage.costUsd, null)
  assert.equal(usage.tokens, 12, "tokens still travel, so kandy can price it")
})

test("a finished tool is reported completed, never as still running", () => {
  // opencode only emits tool_use once a call has completed or errored, so
  // there is no started frame to pair with and none is invented.
  const out = opencode.parse(
    line({
      type: "tool_use",
      sessionID: "ses_abc",
      part: {
        type: "tool",
        tool: "bash",
        callID: "c1",
        state: { status: "completed", input: { command: "npm test" } },
      },
    }),
  )
  assert.deepEqual(out.filter((e) => e.kind === "tool"), [
    { kind: "tool", tool: "shell", detail: "npm test", status: "completed" },
  ])
})

test("a tool that ran and failed is a failure, not a refusal", () => {
  const out = opencode.parse(
    line({
      type: "tool_use",
      sessionID: "ses_abc",
      part: {
        type: "tool",
        tool: "bash",
        callID: "c1",
        state: { status: "error", input: { command: "npm test" }, error: { message: "1 failing" } },
      },
    }),
  )
  assert.equal(out.find((e) => e.kind !== "session")?.kind, "tool")
})

test("errors prefer the message a human can act on over the error's name", () => {
  const out = opencode.parse(
    line({
      type: "error",
      sessionID: "ses_abc",
      error: { name: "ProviderAuthError", data: { message: "anthropic: refresh token expired" } },
    }),
  )
  const err = out.find((e) => e.kind === "error")
  assert.ok(err && err.kind === "error")
  assert.equal(err.message, "anthropic: refresh token expired")
})

test("reasoning and step_start stay out of the transcript", () => {
  const reasoning = opencode.parse(
    line({ type: "reasoning", sessionID: "s", part: { type: "reasoning", text: "hm" } }),
  )
  assert.deepEqual(reasoning.filter((e) => e.kind !== "session"), [])
})

test("what the agent says becomes text", () => {
  const out = opencode.parse(
    line({ type: "text", sessionID: "s", part: { type: "text", text: "Done." } }),
  )
  assert.deepEqual(out.filter((e) => e.kind === "text"), [{ kind: "text", text: "Done." }])
})

test("opencode does not claim it can be asked", () => {
  // It replies to its own permission prompts in-process; there is no channel
  // to route one back to us. Keep in step with ASK_CAPABLE in @kandy/core.
  assert.ok(!opencode.asks)
  assert.equal(opencode.live, undefined)
})
