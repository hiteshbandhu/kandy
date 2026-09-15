import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { configuredModel as codexModel } from "./agents/codex.js"
import { configuredModel as cursorModel } from "./agents/cursor.js"
import { configuredModel as opencodeModel } from "./agents/opencode.js"

/**
 * Prices for agents that report tokens but not money.
 *
 * Claude Code reports `total_cost_usd` directly. Codex reports only a token
 * count, so a dollar figure has to be computed — and the result is an estimate,
 * tracked as such, never presented as a billed amount.
 *
 * The table is LiteLLM's `model_prices_and_context_window.json`, which is what
 * ccusage and t3code both price against. Per-token rates keyed by the exact
 * model string, fetched once a day and cached on disk; a fetch failure falls
 * back to whatever is cached, and having nothing cached means unpriced rather
 * than guessed.
 */
const URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"
const TTL_MS = 24 * 60 * 60 * 1000

type Rates = {
  input_cost_per_token?: number
  output_cost_per_token?: number
  cache_read_input_token_cost?: number
  cache_creation_input_token_cost?: number
}

export type Usage = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

const CACHE_DIR = path.join(
  process.env["XDG_CACHE_HOME"] ?? path.join(homedir(), ".cache"),
  "kandy",
)
const CACHE_FILE = path.join(CACHE_DIR, "prices.json")

let table: Record<string, Rates> | null = null
let loading: Promise<void> | null = null

function readCache(): { at: number; data: Record<string, Rates> } | null {
  try {
    if (!existsSync(CACHE_FILE)) return null
    return JSON.parse(readFileSync(CACHE_FILE, "utf8"))
  } catch {
    return null
  }
}

/**
 * Load the table, refreshing at most once a day.
 *
 * Never throws and never blocks a run: pricing a turn is a nicety, and an agent
 * finishing its work must not depend on GitHub being reachable.
 */
export function warmPrices(): Promise<void> {
  if (loading) return loading

  loading = (async () => {
    const cached = readCache()
    if (cached) table = cached.data
    if (cached && Date.now() - cached.at < TTL_MS) return

    try {
      const res = await fetch(URL, { signal: AbortSignal.timeout(15_000) })
      if (!res.ok) return
      const data = (await res.json()) as Record<string, Rates>
      table = data
      mkdirSync(CACHE_DIR, { recursive: true })
      writeFileSync(CACHE_FILE, JSON.stringify({ at: Date.now(), data }))
    } catch {
      // Offline, rate-limited, whatever. The cache (or nothing) stands.
    }
  })()

  return loading
}

/**
 * Model ids a given agent can plausibly run, newest-looking first.
 *
 * Derived from the price table we already fetch, filtered to the provider that
 * agent talks to. It is a menu, not a guarantee — the agent still rejects one
 * it does not have access to — but it beats asking someone to type an exact
 * model string from memory.
 */
type Menu = {
  /** Shown first: what the CLI documents as a shorthand. */
  aliases: string[]
  /** Which table entries belong to this agent at all. */
  keep: RegExp
  /** Entries that exist in the table but the agent cannot actually run. */
  drop: RegExp
  /**
   * Rewrite a surviving table key into the id this CLI actually takes. The
   * table is keyed bare — `claude-opus-5` — while opencode addresses models as
   * `provider/model`, and an id in the wrong dialect is a menu entry that
   * fails at spawn time.
   */
  map?: (name: string) => string
}

/** Which opencode provider serves a model, by the shape of its name. */
function opencodeProvider(name: string): string | null {
  if (name.startsWith("claude-")) return "anthropic"
  if (/^(?:gpt|o\d)/.test(name)) return "openai"
  if (name.startsWith("gemini-")) return "google"
  return null
}

/**
 * What each agent can actually be asked to run.
 *
 * Deliberately not "everything in the price table with the right prefix" — that
 * offered Codex a menu of o3-mini and o4-mini, which it does not run, and
 * offered Claude forty dated ids nobody types. Aliases come first because they
 * are what the CLIs document and what stays correct when a new model ships.
 */
const MENU: Record<string, Menu> = {
  aider: {
    aliases: [],
    keep: /^(?:(?:anthropic\/)?claude-|(?:openai\/)?gpt-|deepseek\/deepseek-|gemini\/gemini-)/,
    drop: /(audio|realtime|search|transcribe|tts|image|embedding|instruct|codex|:|-\d{8})/,
  },
  claude: {
    aliases: ["fable", "opus", "sonnet", "haiku"],
    keep: /^claude-(opus|sonnet|haiku)-\d/,
    // Dated ids and provider-suffixed ones are the same models wearing a
    // deployment name; the aliases already cover "the latest".
    drop: /(bedrock|vertex|latest|@|:|-\d{8})/,
  },
  codex: {
    aliases: [],
    // Codex runs its own tuned models, not everything OpenAI prices. Offering
    // gpt-5.6 produced "the 'gpt-5.6' model is not supported" from the API —
    // a menu that lists things the tool rejects is worse than no menu.
    keep: /-codex(-mini)?$/,
    // The table also carries the same models routed through other vendors —
    // "openrouter/openai/gpt-5.3-codex" is not something the Codex CLI takes.
    drop: /(audio|realtime|search|transcribe|tts|image|embedding|instruct|chat-latest|:|-\d{8}|\/)/,
  },
  gemini: {
    aliases: [],
    keep: /^gemini-[23](\.\d+)?-(pro|flash)$/,
    drop: /(vision|embedding|tuned|thinking)/,
  },
  grok: { aliases: [], keep: /^grok-\d/, drop: /(vision|image)/ },
  /*
   * Cursor's catalogue is its own, and it is account-specific: the ids are
   * things like `cursor-grok-4.6-high` and `claude-opus-5-thinking-high`,
   * which appear in no price table, and which of them you may run depends on
   * your plan. `cursor-agent --list-models` is the only authority, and it
   * needs the CLI, a network round trip and a sign-in to answer.
   *
   * So the table contributes nothing here and is not consulted. What is
   * offered is `auto` — always available, and what Cursor picks by default —
   * plus whatever this machine is already configured for, which is the one id
   * known to work. Anything else the user can type.
   */
  cursor: { aliases: ["auto"], keep: /.^/, drop: /.^/ },
  /*
   * opencode is provider-agnostic and addresses models as `provider/model`,
   * so the menu is the same set aider would see, rewritten into that dialect.
   */
  opencode: {
    aliases: [],
    keep: /^(?:claude-(?:opus|sonnet|haiku|fable)-\d|gpt-\d|gemini-[23])/,
    drop: /(audio|realtime|search|transcribe|tts|image|embedding|instruct|chat-latest|:|\/|-\d{8})/,
    map: (name) => {
      const provider = opencodeProvider(name)
      return provider ? `${provider}/${name}` : name
    },
  },
}

/**
 * Agents that record their own choice of model somewhere we can read.
 *
 * Whatever a CLI is already set up to run is the one id known to work on this
 * machine, which a price table can only ever guess at.
 */
const CONFIGURED: Record<string, () => string | null> = {
  codex: codexModel,
  cursor: cursorModel,
  opencode: opencodeModel,
}

export function modelsFor(agent: string): string[] {
  const menu = MENU[agent]
  if (!menu) return []

  // The configured model is known-good even when the table has never heard of
  // it, so it always belongs on the menu.
  const configured = CONFIGURED[agent]?.() ?? null
  const seed = configured ? [configured] : []
  if (!table) return [...seed, ...menu.aliases]

  const named = Object.entries(table)
    .filter(([name, rates]) => {
      if (!menu.keep.test(name) || menu.drop.test(name)) return false
      // An entry with no input price is a table stub, not a runnable model.
      return typeof rates.input_cost_per_token === "number"
    })
    .map(([name]) => name)
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .slice(0, 12)
    .map((name) => menu.map?.(name) ?? name)

  return [...new Set([...seed, ...menu.aliases, ...named])]
}

/**
 * The model a fresh board should use for an agent.
 *
 * The strongest coding model each vendor offers, by alias where one exists —
 * an alias keeps pointing at the current model when a new one ships, which a
 * pinned id does not.
 */
export function defaultModelFor(agent: string): string | null {
  // Aider chooses its provider from the user's existing configuration.
  if (agent === "aider") return null
  if (agent === "claude") return "opus"
  // Whatever the agent is already configured to run is the one choice we know
  // works on this machine; a table entry is only ever a guess.
  if (agent === "codex") return codexModel() ?? modelsFor("codex")[0] ?? null
  /*
   * Cursor and opencode both resolve a model themselves — from their own
   * config, then the last one used — and both catalogues are wider than
   * anything kandy can verify. Picking for them would override a working
   * choice the user already made with a guess off a price list.
   */
  if (agent === "cursor" || agent === "opencode") return null
  return modelsFor(agent)[0] ?? null
}

/** Rates for a model, trying the most specific name first. */
function ratesFor(model: string): Rates | null {
  if (!table) return null
  if (table[model]) return table[model]!

  // Providers prefix and version their ids in ways the table does not always
  // mirror — "anthropic/claude-opus-5", "claude-opus-5-20260101".
  const bare = model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model
  if (table[bare]) return table[bare]!

  const undated = bare.replace(/-\d{8}$/, "")
  if (table[undated]) return table[undated]!

  // Last resort: the longest table key that is a prefix of this model. Avoids
  // matching "gpt-5" against "gpt-5.4-codex" the wrong way round.
  let best: { key: string; rates: Rates } | null = null
  for (const [key, rates] of Object.entries(table)) {
    if (!undated.startsWith(key)) continue
    if (!best || key.length > best.key.length) best = { key, rates }
  }
  return best?.rates ?? null
}

/**
 * Cost in USD, or null when the model isn't in the table.
 *
 * Reasoning tokens are already inside `output` for both agents we support, so
 * they are deliberately not billed a second time. A missing cache rate falls
 * back to the input rate rather than to free — the wrong direction to round.
 */
export function priceUsage(model: string | null, usage: Usage): number | null {
  if (!model) return null
  const r = ratesFor(model)
  if (!r) return null

  const input = r.input_cost_per_token ?? 0
  const output = r.output_cost_per_token ?? 0
  const cacheRead = r.cache_read_input_token_cost ?? input
  const cacheWrite = r.cache_creation_input_token_cost ?? input
  if (input === 0 && output === 0) return null

  return (
    usage.input * input +
    usage.output * output +
    usage.cacheRead * cacheRead +
    usage.cacheWrite * cacheWrite
  )
}
