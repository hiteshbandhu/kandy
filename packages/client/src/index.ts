import type {
  ActivityFrame,
  AgentId,
  AgentInfo,
  Attribution,
  Board,
  BoardView,
  Delivery,
  Forge,
  KandyEvent,
  Listing,
  OutputLine,
  Policy,
  PullRequest,
  Rejection,
  RepoCheck,
  StagedFile,
  Stats,
  UploadFile,
  StreamFrame,
  TranscriptFrame,
  McpServer,
  Member,
  Role,
  RunnerInfo,
  SkillInfo,
} from "@kandy/core"
import { EVENT_TYPES } from "@kandy/core"
import { installEventSource } from "./sse.js"

export { installEventSource, NodeEventSource, SseDecoder, type SseMessage } from "./sse.js"

export type ClientOptions = {
  baseUrl?: string
  token?: string | (() => string | Promise<string>)
}

export class KandyError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message)
    this.name = "KandyError"
  }
}

/**
 * Typed client for the server API. Shared by the web app and the TUI —
 * neither client gets its own copy of the wire format.
 */
export class KandyClient {
  private baseUrl: string
  private token: ClientOptions["token"]

  constructor(opts: ClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? "http://127.0.0.1:4477").replace(/\/$/, "")
    this.token = opts.token
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = method === "GET" || method === "HEAD" ? undefined
      : typeof this.token === "function" ? await this.token() : this.token
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    const json = (await res.json()) as unknown
    if (!res.ok) {
      const e = (json as { error?: { code?: string; message?: string; detail?: unknown } }).error
      throw new KandyError(e?.code ?? "internal", e?.message ?? res.statusText, e?.detail)
    }
    return json as T
  }

  health() {
    return this.req<{ version: string; uptime: number; pid: number }>("GET", "/health")
  }
  agents() {
    return this.req<{ agents: AgentInfo[] }>("GET", "/agents")
  }
  models(agent: string) {
    return this.req<{ models: string[] }>("GET", `/agents/${agent}/models`)
  }
  /** Replace the models you added yourself for one agent. */
  setCustomModels(agent: string, models: string[]) {
    return this.req<{ models: string[] }>("POST", `/agents/${agent}/models`, { models })
  }
  boards() {
    return this.req<{ boards: Board[] }>("GET", "/boards")
  }
  browse(path?: string) {
    const q = path ? `?path=${encodeURIComponent(path)}` : ""
    return this.req<Listing>("GET", `/repo/browse${q}`)
  }
  /** Opens the OS folder chooser on the machine running the daemon. */
  pickFolder() {
    return this.req<{ path: string | null; supported: boolean }>("POST", "/repo/pick", {})
  }
  checkRepo(path: string) {
    return this.req<RepoCheck>("GET", `/repo/check?path=${encodeURIComponent(path)}`)
  }
  createBoard(name: string, repoPath: string, setup?: string | null, carry?: string[], defaultPolicy?: Policy) {
    return this.req<{ board: Board; seq: number }>("POST", "/boards", {
      name,
      repoPath,
      setup,
      carry,
      defaultPolicy,
    })
  }
  setBoardSetup(boardId: string, setup: string | null, carry?: string[]) {
    return this.req<{ seq: number }>("POST", `/boards/${boardId}/setup`, { setup, carry })
  }
  view(boardId: string) {
    return this.req<BoardView>("GET", `/boards/${boardId}/view`)
  }

  createNote(boardId: string, columnId: string, title: string, body = "", files?: UploadFile[]) {
    return this.req<{ noteId: string; seq: number; attachments: StagedFile[]; rejected: Rejection[] }>(
      "POST",
      "/notes",
      { boardId, columnId, title, body, files },
    )
  }
  /** Attach to a note: its worktree if it has one, otherwise held until it runs. */
  attach(noteId: string, files: UploadFile[]) {
    return this.req<{ attachments: StagedFile[]; rejected: Rejection[]; seq: number }>(
      "POST",
      `/notes/${noteId}/attach`,
      { files },
    )
  }
  unattach(noteId: string, name: string) {
    return this.req<{ attachments: StagedFile[]; seq: number }>("POST", `/notes/${noteId}/unattach`, {
      name,
    })
  }
  /** What is waiting for this note's worktree. Survives a reload; nothing local does. */
  attachments(noteId: string) {
    return this.req<{ attachments: StagedFile[] }>("GET", `/notes/${noteId}/attachments`)
  }
  editNote(noteId: string, patch: { title?: string; body?: string }) {
    return this.req<{ seq: number }>("POST", `/notes/${noteId}/edit`, patch)
  }
  /** Say which neighbours it lands between; the server computes the key. */
  moveNote(noteId: string, columnId: string, neighbours: { after?: string; before?: string } = {}) {
    return this.req<{ seq: number }>("POST", `/notes/${noteId}/move`, { columnId, ...neighbours })
  }
  assignNote(noteId: string, agent: AgentId) {
    return this.req<{ seq: number }>("POST", `/notes/${noteId}/assign`, { agent })
  }
  stats(boardId: string) {
    return this.req<Stats>("GET", `/boards/${boardId}/stats`)
  }
  /** Tell the daemon this note's checkout has been removed from disk. */
  noteReclaimed(noteId: string) {
    return this.req<{ seq: number }>("POST", `/notes/${noteId}/reclaimed`)
  }
  /** Tracked paths in the board's repo, for the composer's `@` picker. */
  files(boardId: string) {
    return this.req<{ files: string[]; dirs: string[] }>("GET", `/boards/${boardId}/files`)
  }
  forge(boardId: string) {
    return this.req<Forge>("GET", `/boards/${boardId}/forge`)
  }
  /** Who this request is, and whether the daemon is a hub. Answers on every daemon. */
  me() {
    return this.req<{
      hub: boolean
      email: string | null
      role: Role | null
      /** False for someone on the tailnet whom no owner has added yet. */
      admitted: boolean
      /** Who can add people, so "ask an owner" can name one. */
      owners: string[]
    }>("GET", "/me")
  }
  /** The latest events someone can be named for, newest first. */
  activity(limit = 50) {
    return this.req<{ events: KandyEvent[] }>("GET", `/activity?limit=${limit}`)
  }
  /** Every machine that has connected to this hub, and whether it is here now. */
  runners() {
    return this.req<{ runners: RunnerInfo[] }>("GET", "/runners")
  }
  members() {
    return this.req<{ members: Member[]; identity: boolean }>("GET", "/members")
  }
  /** Admit, change or remove someone. `role: null` removes. Owners only. */
  setMember(email: string, role: Role | null) {
    return this.req<{ seq: number; members: Member[] }>("POST", "/members", { email, role })
  }
  /**
   * Answer a request to run a note on your machine. Only the machine's owner
   * may; `always` also approves the requester for every note after this one.
   */
  consent(noteId: string, accept: boolean, always = false) {
    return this.req<{ seq: number; runId: string | null }>("POST", `/notes/${noteId}/consent`, { accept, always })
  }
  /**
   * Give a note to someone's machine — `to` a person, or `runner` a machine.
   * If it was worked on elsewhere, that machine pushes the branch first.
   */
  assign(noteId: string, target: { to: string } | { runner: string }) {
    return this.req<{ seq: number; runner: string; branch?: string }>("POST", `/notes/${noteId}/give`, target)
  }
  /** Replace the board's MCP servers. The server refuses the whole list if one is malformed. */
  setMcp(boardId: string, servers: McpServer[]) {
    return this.req<{ seq: number; servers: McpServer[] }>("POST", `/boards/${boardId}/mcp`, { servers })
  }
  skills(boardId: string) {
    return this.req<{ skills: SkillInfo[] }>("GET", `/boards/${boardId}/skills`)
  }
  addSkills(boardId: string, source: string, skill?: string) {
    return this.req<{ skills: SkillInfo[] }>("POST", `/boards/${boardId}/skills`, {
      source,
      ...(skill ? { skill } : {}),
    })
  }
  removeSkill(boardId: string, name: string) {
    return this.req<{ skills: SkillInfo[] }>("POST", `/boards/${boardId}/skills/remove`, { name })
  }
  commitSkills(boardId: string) {
    return this.req<{ committed: string[]; skills: SkillInfo[] }>(
      "POST",
      `/boards/${boardId}/skills/commit`,
      {},
    )
  }
  /** What opening a PR would say — the starting point for the dialog. */
  prPreview(noteId: string) {
    return this.req<{ title: string; body: string }>("GET", `/notes/${noteId}/pr`)
  }
  openPr(noteId: string, opts: { draft?: boolean; title?: string; body?: string } = {}) {
    return this.req<{ pr: PullRequest; seq: number }>("POST", `/notes/${noteId}/pr`, {
      draft: opts.draft ?? false,
      ...(opts.title !== undefined ? { title: opts.title } : {}),
      ...(opts.body !== undefined ? { body: opts.body } : {}),
    })
  }
  setModel(noteId: string, model: string | null) {
    return this.req<{ seq: number }>("POST", `/notes/${noteId}/model`, { model })
  }
  removeBoard(boardId: string) {
    return this.req<{ seq: number }>("POST", `/boards/${boardId}/remove`, {})
  }
  setBoardModels(boardId: string, models: Record<string, string>) {
    return this.req<{ seq: number }>("POST", `/boards/${boardId}/models`, { models })
  }
  /** What notes written on this board start as. Existing notes keep theirs. */
  setBoardPolicy(boardId: string, defaultPolicy: Policy) {
    return this.req<{ seq: number }>("POST", `/boards/${boardId}/policy`, { defaultPolicy })
  }
  /** Raise a refused note to full access and continue it in the same worktree. */
  escalateNote(noteId: string) {
    return this.req<{ delivery: Delivery; seq: number }>("POST", `/notes/${noteId}/escalate`, {})
  }
  /** Commit trailers and the PR footer, independently. Both off by default. */
  setBoardAttribution(boardId: string, attribution: Attribution) {
    return this.req<{ seq: number }>("POST", `/boards/${boardId}/attribution`, { attribution })
  }
  setPolicy(noteId: string, policy: Policy) {
    return this.req<{ seq: number }>("POST", `/notes/${noteId}/policy`, { policy })
  }
  deleteNote(noteId: string) {
    return this.req<{ seq: number }>("POST", `/notes/${noteId}/delete`, {})
  }
  /**
   * Run a note. On a hub whose target machine has not said yes to the person
   * asking, the answer is `held: true` and no run id: accepted, not started.
   */
  runNote(noteId: string, agent?: AgentId) {
    return this.req<{ runId: string | null; seq: number; held?: boolean }>("POST", `/notes/${noteId}/run`, { agent })
  }
  reviewNote(noteId: string, decision: "merge" | "discard" | "revise", comment?: string) {
    return this.req<{ seq: number }>("POST", `/notes/${noteId}/review`, { decision, comment })
  }
  /** Steer a note: reaches a live agent if it takes stdin, else queues a follow-up. */
  message(noteId: string, text: string, files?: UploadFile[]) {
    return this.req<{ delivery: Delivery; seq: number; rejected: Rejection[] }>(
      "POST",
      `/notes/${noteId}/message`,
      { text, files },
    )
  }
  diff(noteId: string) {
    return this.req<{
      diff: string
      stat: string
      branch: string | null
      /** Where a local merge would land it. Null once the worktree is gone. */
      baseBranch: string | null
      /** Non-null when the worktree is gone and this is the review-time snapshot. */
      capturedAt: number | null
    }>(
      "GET",
      `/notes/${noteId}/diff`,
    )
  }
  transcript(runId: string, after = 0) {
    return this.req<{ frames: TranscriptFrame[]; nextAfter: number | null }>(
      "GET",
      `/runs/${runId}/transcript?after=${after}`,
    )
  }
  /**
   * Answer a waiting permission prompt.
   *
   * `scope: "note"` also writes the rule, so the same kind of call is not
   * asked about again on this note. A denial's `comment` reaches the agent —
   * it is the difference between "no" and "no, use pnpm".
   */
  respond(
    runId: string,
    requestId: string,
    decision: "allow" | "deny",
    opts: { scope?: "once" | "note"; comment?: string } = {},
  ) {
    return this.req<{ answered: boolean; seq: number }>("POST", `/runs/${runId}/respond`, {
      requestId,
      decision,
      ...opts,
    })
  }
  cancelRun(runId: string) {
    return this.req<{ seq: number }>("POST", `/runs/${runId}/cancel`, {})
  }
  output(runId: string, after = 0) {
    return this.req<{ lines: OutputLine[]; nextAfter: number | null }>(
      "GET",
      `/runs/${runId}/output?after=${after}`,
    )
  }

  /**
   * Subscribe to the event stream. Returns an unsubscribe function.
   *
   * EventSource handles reconnect and Last-Event-ID for us, which is most of
   * why the transport is SSE rather than a WebSocket we'd have to babysit.
   *
   * Node has no global EventSource on the versions we support, so install the
   * polyfill here rather than making every CLI caller remember to. It is a
   * no-op in the browser and on any runtime that ships a real one.
   */
  events(
    after: number,
    handlers: {
      onEvent: (e: KandyEvent) => void
      onError?: (e: Event) => void
      onTranscript?: (f: TranscriptFrame) => void
      onActivity?: (f: ActivityFrame) => void
    },
  ): () => void {
    // baseUrl may be relative ("/api" behind a dev proxy), which `new URL`
    // rejects without a base. Resolve against the page origin when there is
    // one; fall back to a bare string for non-browser callers.
    const origin = globalThis.location?.origin
    const url = origin
      ? new URL(this.baseUrl + "/events", origin)
      : new URL(this.baseUrl + "/events")
    url.searchParams.set("after", String(after))

    installEventSource()
    const es = new EventSource(url)
    const handler = (ev: MessageEvent) => {
      try {
        const frame = JSON.parse(ev.data) as StreamFrame
        if (!("kind" in frame)) handlers.onEvent(frame)
        else if (frame.kind === "transcript") handlers.onTranscript?.(frame)
        else if (frame.kind === "activity") handlers.onActivity?.(frame)
      } catch (err) {
        console.error("[kandy] bad event payload", err)
      }
    }
    // Named SSE events don't fire onmessage, so bind each type explicitly.
    for (const type of [...EVENT_TYPES, "transcript", "activity"]) {
      es.addEventListener(type, handler as EventListener)
    }
    if (handlers.onError) es.onerror = handlers.onError

    return () => es.close()
  }
}
