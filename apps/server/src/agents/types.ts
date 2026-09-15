import type { AgentId, Policy } from "@kandy/core"

/** What an adapter emits after parsing one line of its CLI's output. */
export type AgentEvent =
  | { kind: "session"; sessionId: string }
  /** Something the agent said. Goes in the transcript the user reads. */
  | { kind: "text"; text: string }
  | { kind: "tool"; tool: string; detail: string; status: "started" | "completed" | "failed" }
  | { kind: "blocked"; requestId: string; detail: string }
  | {
      kind: "usage"
      text: string
      /** Dollars, when the agent actually reports them. Null means "price it". */
      costUsd: number | null
      tokens: number | null
      turns: number | null
      /** The model that ran, so a token-only agent can still be priced. */
      model?: string | null
      /** Per-bucket tokens; cache tiers are billed at different rates. */
      usage?: { input: number; output: number; cacheRead: number; cacheWrite: number }
    }
  /**
   * The agent finished a turn. Agents we hold stdin open for (to steer them)
   * will otherwise sit waiting for more input forever, so this is what tells
   * the runner it is safe to close the pipe and let the process exit.
   */
  | { kind: "turn_end" }
  | { kind: "error"; message: string }

export type SpawnOptions = {
  /** The note's worktree. Never the user's actual working tree. */
  cwd: string
  prompt: string
  /** Agent's own session id, to continue a previous run in this worktree. */
  resume?: string
  /** How much the user has allowed this note to do. */
  policy: Policy
  /** Model to run, or undefined to let the agent use its own default. */
  model?: string | undefined
  /**
   * Where this agent should send a permission prompt instead of auto-denying
   * it. Present only for agents that can ask at all, and only under `repo` —
   * full access asks nobody anything.
   */
  ask?: AskChannel | undefined
}

/** See `permission.ts`: the MCP sidecar an agent routes its prompts through. */
export type AskChannel = {
  configPath: string
  toolName: string
}

/**
 * Steering. Some CLIs accept further user messages on stdin mid-run; for the
 * rest the runner falls back to queueing a follow-up run that resumes the
 * session. Adapters that can do the former implement this.
 */
export type LiveInput = {
  /** The line to write to the child's stdin, or null if unsupported. */
  encode(text: string): string | null
}

export type SpawnSpec = {
  command: string
  args: string[]
  env?: Record<string, string>
  /**
   * Written to the child's stdin immediately after spawn. Agents that take
   * their prompt over a stream-json stdin rather than argv use this — and it
   * is the same channel steering messages travel on later.
   */
  stdin?: string
}

/**
 * Adapters normalize each CLI's headless output into our event vocabulary.
 * They never touch credentials: the spawned child inherits whatever the user
 * already logged in with. See docs/05-agent-auth.md.
 */
export type AgentAdapter = {
  id: AgentId
  /** Binary to look for on PATH. */
  bin: string
  /** Credential paths. Existence is the floor; `readAuth` may say more. */
  credentials: string[]
  /**
   * Non-secret facts from the credential file: when it expires, what plan it
   * is on. Tokens are never read, only the metadata beside them — which is the
   * difference between "there is a file" and "you can actually run something".
   * Omit it for an agent that validates its own setup.
   */
  readAuth?: () => {
    expiresAt: number | null
    plan: string | null
    /**
     * Whether anyone is signed in at all, for CLIs whose credential file
     * outlives the sign-in. Omit it when the file's existence is the signal —
     * absent means "not asked", never "no".
     */
    authed?: boolean
  } | null
  spawn(opts: SpawnOptions): SpawnSpec
  /** One line of stdout → zero or more events. */
  parse(line: string): AgentEvent[]
  /** Present only on agents that accept mid-run steering. */
  live?: LiveInput
  /**
   * Whether this CLI can route a permission prompt back to us rather than
   * deciding alone. True for Claude Code; Codex's non-interactive exec has no
   * equivalent, and pretending otherwise would show a question that never
   * arrives. Keep in step with `ASK_CAPABLE` in `@kandy/core`, which is what
   * the clients read.
   */
  asks?: boolean
}
