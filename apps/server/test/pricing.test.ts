import test from "node:test"
import assert from "node:assert/strict"

import { defaultModelFor, modelsFor, priceUsage, warmPrices } from "../dist/pricing.js"

// One network fetch, cached on disk; every test below reads the same table.
await warmPrices()

const USAGE = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }

test("an unknown model is unpriced rather than guessed", () => {
  assert.equal(priceUsage("not-a-real-model-xyz", USAGE), null)
  assert.equal(priceUsage(null, USAGE), null)
})

test("cache tiers are billed at their own rates", () => {
  const inputOnly = priceUsage("claude-opus-5", { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0 })
  const cacheOnly = priceUsage("claude-opus-5", { input: 0, output: 0, cacheRead: 1000, cacheWrite: 0 })
  assert.ok(inputOnly && cacheOnly)
  // Cache reads are cheaper than fresh input; billing them the same would
  // overstate every long session.
  assert.ok(cacheOnly < inputOnly, `${cacheOnly} should be under ${inputOnly}`)
})

test("output costs more than input", () => {
  const inp = priceUsage("claude-opus-5", { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0 })!
  const out = priceUsage("claude-opus-5", { input: 0, output: 1000, cacheRead: 0, cacheWrite: 0 })!
  assert.ok(out > inp)
})

test("a dated or vendor-prefixed id resolves to the same model", () => {
  const plain = priceUsage("claude-sonnet-4-5", USAGE)
  assert.ok(plain)
  assert.equal(priceUsage("claude-sonnet-4-5-20250929", USAGE), plain)
  assert.equal(priceUsage("anthropic/claude-sonnet-4-5", USAGE), plain)
})

test("codex is only offered models codex can run", () => {
  const menu = modelsFor("codex")
  assert.ok(menu.length > 0)
  for (const m of menu) {
    // Offering gpt-5.6 produced "the 'gpt-5.6' model is not supported" from
    // the API, and cross-vendor routes are not things the CLI accepts.
    assert.ok(!m.includes("/"), `${m} is a cross-vendor route`)
    assert.ok(!/o[134]-mini|^gpt-[0-9.]+$/.test(m), `${m} is not a codex model`)
  }
})

test("claude's aliases come first, because they stay correct", () => {
  const menu = modelsFor("claude")
  assert.deepEqual(menu.slice(0, 4), ["fable", "opus", "sonnet", "haiku"])
})

test("no menu contains a dated id or a deployment name", () => {
  for (const agent of ["claude", "codex"]) {
    for (const m of modelsFor(agent)) {
      assert.ok(!/-\d{8}$/.test(m), `${m} is dated`)
      assert.ok(!m.includes(":"), `${m} is a deployment name`)
    }
  }
})

test("agents with no model menu get an empty one, not everything", () => {
  assert.deepEqual(modelsFor("nonexistent-agent"), [])
})

test("cursor is offered auto, because its catalogue is not the price table's", () => {
  // Cursor's ids are its own — `cursor-grok-4.6-high`, `claude-opus-5-thinking-high`
  // — and which of them you may run depends on your plan. Filtering the table
  // would offer a menu of things the CLI rejects, so the table is not consulted
  // at all; `auto` always works, and anything else the user can type.
  const menu = modelsFor("cursor")
  assert.ok(menu.includes("auto"))
  for (const m of menu) {
    assert.ok(!m.includes("/"), `${m} is not a cursor model id`)
  }
})

test("opencode is offered models in the provider/model form it takes", () => {
  // opencode addresses models as `provider/model`. A bare table key is a menu
  // entry that fails at spawn time.
  const menu = modelsFor("opencode")
  assert.ok(menu.length > 0)
  for (const m of menu) {
    assert.match(m, /^(anthropic|openai|google)\/./, `${m} is not addressable by opencode`)
    assert.ok(!/-\d{8}$/.test(m), `${m} is dated`)
  }
})

test("a provider-prefixed opencode id still prices", () => {
  // modelsFor and priceUsage have to agree, or every opencode run is unpriced.
  const [first] = modelsFor("opencode")
  assert.ok(first)
  assert.ok(priceUsage(first, USAGE), `${first} came off the menu but does not price`)
})

test("cursor and opencode keep the model choice they already made", () => {
  // Both resolve a model themselves, from their own config and then the last
  // one used. Picking for them would override a working choice with a guess.
  assert.equal(defaultModelFor("cursor"), null)
  assert.equal(defaultModelFor("opencode"), null)
})

test("a new board gets a default that the agent can actually run", () => {
  assert.equal(defaultModelFor("claude"), "opus")
  const codex = defaultModelFor("codex")
  assert.ok(codex, "codex must get a default")
  assert.ok(!codex!.includes("/"))
})
