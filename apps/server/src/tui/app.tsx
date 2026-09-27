/**
 * The terminal board. State and effects live here; what each screen shows is
 * decided by the pure modules beside it (board, kanban, transcript, diff,
 * keys, editor, mouse) and drawn by the thin pieces in ui.tsx and
 * kanban-view.tsx.
 *
 * The screen is a fixed grid: the header (board tabs) on row 0, a rule on row
 * 1, the body from row 2, and the footer's rows at the bottom. The mouse is
 * mapped back through the same numbers, so every click lands on what was
 * drawn under it.
 */
import type { KandyClient } from "@kandy/client"
import {
  AGENT_NAMES,
  activityActor,
  activityContext,
  activityPhrase,
  isTeamActivity,
  INSTALL_COMMAND,
  promptsFor,
  splitPrompt,
  type AgentId,
  type AgentInfo,
  type Board,
  type BoardView,
  type KandyEvent,
  type Member,
  type Note,
  type PermissionPrompt,
  type Role,
  type RunnerInfo,
} from "@kandy/core"
import { Box, Text, useApp, useInput, useWindowSize } from "ink"
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react"
import { ConsentStore, type Accept } from "../consent.js"
import { joinedHub } from "../joined.js"
import {
  agentLabel,
  boardRows,
  defaultAgent,
  diffstat,
  formatDuration,
  giveTargets,
  glyph,
  heldForMe,
  inboxColumn,
  isLive,
  machineName,
  moveSelection,
  needsYou,
  noteClock,
  readyAgents,
  reconcileSelection,
  rowIndex,
  runOf,
  runningCount,
  runsOf,
  scrollOffset,
  selectFirst,
  selectLast,
  type Row,
} from "./board.js"
import { clampOffset, jumpFile, parseDiff, type ParsedDiff } from "./diff.js"
import { editKey, emptyEditor, type Editor } from "./editor.js"
import {
  COL_GAP,
  MIN_COL_W,
  dropAction,
  dropIndex,
  hitTest,
  kanbanColumns,
  layout as kanbanLayout,
  moveFocus,
  reconcileFocus,
  type Drop,
  type Focus,
  type Layout,
} from "./kanban.js"
import { Kanban, type DragState } from "./kanban-view.js"
import { fitHints, helpSections, hints, keyAction, stageOf, type Action, type Hint, type KeyCtx } from "./keys.js"
import type { LiveBoard } from "./live.js"
import { clickCounter, isMouse, parseMouse, type MouseEvent } from "./mouse.js"
import { palette, toneProps, type Palette, type Tone } from "./theme.js"
import { fit, textWidth, tildify, truncate, truncateStart, wrap } from "./text.js"
import { FOLLOWING, scroll, toBottom, toTop, transcriptRows, viewStart, type Follow, type Seg } from "./transcript.js"
import { Fill, Hints, Rule, Segs, Split } from "./ui.js"
import { preferredPolicy } from "../cli/setup.js"

export type AppProps = {
  client: KandyClient
  live: LiveBoard
  boards: Board[]
  boardId: string | null
  hub: boolean | undefined
  /** Somewhere for stray console output to go instead of the screen. */
  onLog: (sink: ((text: string) => void) | null) => void
}

type Screen =
  | { kind: "board" }
  | { kind: "note"; noteId: string }
  | { kind: "diff"; noteId: string }
  | { kind: "help" }
  | { kind: "team" }

type InputPurpose = "new" | "new-hold" | "message" | "revise" | "deny" | "filter" | "edit" | "add-board" | "invite"
type ConfirmPurpose = "merge" | "discard" | "delete" | "full"
type PickPurpose = "agent" | "board" | "runner" | "role" | "consent"
type Overlay =
  | { kind: "input"; purpose: InputPurpose; editor: Editor; noteId: string | null; prompt: PermissionPrompt | null }
  | { kind: "confirm"; purpose: ConfirmPurpose; noteId: string; base?: string | null }
  | { kind: "pick"; purpose: PickPurpose; title: string; items: PickItem[]; index: number; noteId: string | null; target?: string }

type PickItem = { id: string; label: string; hint: string }

type Toast = { text: string; tone: Tone }

type DiffState = {
  noteId: string
  status: "loading" | "ready" | "error"
  parsed: ParsedDiff
  stat: string
  branch: string | null
  base: string | null
  offset: number
}

type Me = { hub: boolean; email: string | null; role: Role | null }

type TeamState = {
  loading: boolean
  members: Member[]
  identity: boolean
  events: KandyEvent[]
  error: string | null
}

const INPUT_LABEL: Record<InputPurpose, string> = {
  new: "New note — runs on enter",
  "new-hold": "New note — saved to Inbox, not run",
  message: "Message the agent",
  revise: "Send back with a comment",
  deny: "Deny — say why (optional)",
  filter: "Filter",
  edit: "Edit — the first line is the title",
  "add-board": "Add a board — a git repository on this machine",
  invite: "Invite — their email (they join as a member)",
}

const MULTILINE: Record<InputPurpose, boolean> = {
  new: true,
  "new-hold": true,
  message: true,
  revise: true,
  deny: false,
  filter: false,
  edit: true,
  "add-board": false,
  invite: false,
}

const MAX_INPUT_ROWS = 5
const LIVE_RUN = new Set(["starting", "running", "blocked"])
/** The body starts under the header and its rule. */
const BODY_TOP = 2
/** Narrower than two columns and the kanban is a list with extra steps. */
const KANBAN_MIN_WIDTH = MIN_COL_W * 2 + COL_GAP

const ACCEPT_LABEL: Record<Accept, string> = {
  nobody: "only you",
  approved: "you, and people you've approved",
  team: "anyone on the team",
}

function errText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.replace(/\s+/g, " ").trim() || "Something went wrong"
}

/** "Claude Code wants to run: npm test" */
export function promptLine(prompt: PermissionPrompt, agent: string | null): string {
  const who = agent ? (AGENT_NAMES[agent] ?? agent) : "The agent"
  const verb = /^(bash|shell|exec|command|run_shell_command)$/i.test(prompt.tool) ? "run" : `use ${prompt.tool}`
  return `${who} wants to ${verb}: ${prompt.command.replace(/\s+/g, " ").trim()}`
}

export function App({ client, live, boards: initialBoards, boardId: initialBoardId, hub: hubOpt, onLog }: AppProps) {
  const { exit } = useApp()
  const { columns, rows: termRows } = useWindowSize()
  const width = Math.max(20, columns)
  const height = Math.max(8, termRows)
  const p: Palette = useMemo(() => palette(), [])

  const state = useSyncExternalStore(live.subscribe, live.getSnapshot)
  const view = state.view

  const [boards, setBoards] = useState(initialBoards)
  const [boardId, setBoardId] = useState(initialBoardId)
  const [stack, setStack] = useState<Screen[]>([{ kind: "board" }])
  const screen = stack[stack.length - 1]!
  const [overlay, setOverlay] = useState<Overlay | null>(null)
  const [toast, setToast] = useState<Toast | null>(null)
  const [filter, setFilter] = useState("")
  const [selected, setSelected] = useState<string | null>(null)
  const [focus, setFocus] = useState<Focus | null>(null)
  const [mode, setMode] = useState<"kanban" | "list">("kanban")
  const [drag, setDrag] = useState<DragState | null>(null)
  const [follow, setFollow] = useState<Follow>(FOLLOWING)
  const [diff, setDiff] = useState<DiffState | null>(null)
  const [helpOffset, setHelpOffset] = useState(0)
  const [tick, setTick] = useState(0)
  const [me, setMe] = useState<Me | null>(null)
  const [agents, setAgents] = useState<AgentInfo[] | null>(null)
  const [runners, setRunners] = useState<RunnerInfo[]>([])
  const [waiting, setWaiting] = useState<Record<string, number>>({})
  const [team, setTeam] = useState<TeamState>({ loading: false, members: [], identity: false, events: [], error: null })
  const [memberIndex, setMemberIndex] = useState(0)
  const [invited, setInvited] = useState<string[] | null>(null)
  const [consent, setConsent] = useState(() => new ConsentStore().get())
  const hub = hubOpt ?? me?.hub ?? false

  // --- effects ---------------------------------------------------------------

  const flash = useCallback((text: string, tone: Tone = "plain") => setToast({ text, tone }), [])
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), toast.tone === "berry" ? 5000 : 3000)
    return () => clearTimeout(t)
  }, [toast])

  useEffect(() => {
    onLog((text) => flash(text.split("\n")[0] ?? text, "dim"))
    return () => onLog(null)
  }, [onLog, flash])

  useEffect(() => {
    if (boardId) void live.open(boardId)
  }, [boardId, live])

  // No board yet: someone may be creating one in the web app. Wait for it.
  useEffect(() => {
    if (boardId) return
    const t = setInterval(() => {
      client
        .boards()
        .then(({ boards }) => {
          setBoards(boards)
          if (boards[0]) setBoardId(boards[0].id)
        })
        .catch(() => {})
    }, 2000)
    return () => clearInterval(t)
  }, [boardId, client])

  useEffect(() => {
    client.me().then((m) => setMe({ hub: m.hub, email: m.email, role: m.role }), () => {})
    client.agents().then((a) => setAgents(a.agents), () => {})
  }, [client])

  useEffect(() => {
    if (!hub) return
    const load = () => void client.runners().then((r) => setRunners(r.runners), () => {})
    load()
    const t = setInterval(load, 15_000)
    return () => clearInterval(t)
  }, [client, hub])

  // The other boards' tabs say how many notes wait on you there. A board is
  // added in the browser as often as here, so the list is refreshed too.
  useEffect(() => {
    const load = async () => {
      try {
        const { boards: list } = await client.boards()
        setBoards(list)
        const counts: Record<string, number> = {}
        await Promise.all(
          list
            .filter((b) => b.id !== boardId)
            .map(async (b) => {
              counts[b.id] = needsYou(await client.view(b.id))
            }),
        )
        setWaiting(counts)
      } catch {
        // Tabs without counts are still tabs.
      }
    }
    void load()
    const t = setInterval(load, 15_000)
    return () => clearInterval(t)
  }, [client, boardId])

  // Motion only while something is live; otherwise just keep clocks honest.
  const anyRunning = !!view?.notes.some((n) => n.status === "running")
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), anyRunning ? 100 : 5000)
    return () => clearInterval(t)
  }, [anyRunning])

  const loadTeam = useCallback(async () => {
    setConsent(new ConsentStore().get())
    if (!hub) return
    setTeam((t) => ({ ...t, loading: true, error: null }))
    try {
      const [m, r, a] = await Promise.all([client.members(), client.runners(), client.activity(30)])
      setRunners(r.runners)
      setTeam({ loading: false, members: m.members, identity: m.identity, events: a.events, error: null })
    } catch (err) {
      setTeam((t) => ({ ...t, loading: false, error: errText(err) }))
    }
  }, [client, hub])

  // --- derived ---------------------------------------------------------------

  const kanbanOn = mode === "kanban" && width >= KANBAN_MIN_WIDTH
  const rows = useMemo<Row[]>(() => (view ? boardRows(view, filter) : []), [view, filter])
  const cols = useMemo(() => (view ? kanbanColumns(view, filter) : []), [view, filter])
  const kFocus = reconcileFocus(cols, focus)
  const lastIndex = useRef(0)
  const boardOffset = useRef(0)
  const effectiveSelected = reconcileSelection(rows, selected, lastIndex.current)
  const selIndex = rowIndex(rows, effectiveSelected)
  if (selIndex >= 0) lastIndex.current = selIndex
  const boardSel = kanbanOn ? (kFocus?.note ?? null) : effectiveSelected

  const focusId = screen.kind === "note" || screen.kind === "diff" ? screen.noteId : screen.kind === "board" ? boardSel : null
  const focusNote: Note | null = (view && focusId && view.notes.find((n) => n.id === focusId)) || null
  const focusPrompts = view && focusNote ? promptsFor(view, focusNote.id) : []
  const heldMine = !!focusNote && hub && heldForMe(focusNote, runners, me?.email ?? null)
  const owner = me?.role === "owner"
  const member = team.members[Math.min(memberIndex, team.members.length - 1)] ?? null

  const ctx: KeyCtx = {
    screen: screen.kind,
    hub,
    filtering: filter !== "",
    prompt: focusPrompts.length > 0,
    heldMine,
    note: !!focusNote,
    stage: focusNote && !focusNote.held ? stageOf(focusNote.status) : null,
    kanban: kanbanOn,
    owner: hub && owner,
    member: member !== null,
  }

  // --- layout ----------------------------------------------------------------

  const inputRows =
    overlay?.kind === "input"
      ? Math.min(MAX_INPUT_ROWS, wrapEditor(overlay.editor, width - 4).length) + 1
      : 0
  const pinned = screen.kind === "note" && focusNote ? pinnedRows(focusPrompts, focusNote, view, heldMine, runners, width, p) : []
  const footerRows = 2 + inputRows + pinned.length
  const bodyHeight = Math.max(1, height - BODY_TOP - footerRows)

  // Kept between frames: where each column was scrolled to, and the layout
  // the mouse is mapped back through.
  const kFirst = useRef(0)
  const kScroll = useRef<Record<string, number>>({})
  const kLayout = useRef<Layout | null>(null)
  const kl: Layout | null =
    view && kanbanOn && screen.kind === "board"
      ? kanbanLayout({ cols, width, height: bodyHeight, focus: kFocus, first: kFirst.current, scroll: kScroll.current })
      : null
  if (kl) {
    kFirst.current = kl.first
    for (const c of kl.columns) kScroll.current[c.column.id] = c.scroll
  }
  kLayout.current = kl

  // --- actions ---------------------------------------------------------------

  const act = useCallback(
    async <T,>(fn: () => Promise<T>, ok?: string | ((r: T) => string | null)): Promise<T | undefined> => {
      try {
        const r = await fn()
        const msg = typeof ok === "function" ? ok(r) : ok
        if (msg) flash(msg, "mint")
        return r
      } catch (err) {
        flash(errText(err), "berry")
        return undefined
      }
    },
    [flash],
  )

  const ready = readyAgents(agents)

  const runWith = useCallback(
    (noteId: string, agent: AgentId) =>
      act(
        () => client.runNote(noteId, agent),
        (r) => (r.held ? "Held — waiting for the machine's owner to say yes" : `Running with ${agentLabel(agent)}`),
      ),
    [act, client],
  )

  const pickAgent = (noteId: string) => {
    if (ready.length === 0) return flash("No agent is ready — install one and sign in first", "lemon")
    setOverlay({
      kind: "pick",
      purpose: "agent",
      title: "Run with",
      noteId,
      index: 0,
      items: ready.map((a) => {
        const info = agents?.find((i) => i.id === a)
        return { id: a, label: agentLabel(a), hint: info?.version ?? "" }
      }),
    })
  }

  const run = (note: Note) => {
    if (note.held) return flash("Already asked — waiting for the machine's owner", "lemon")
    if (isLive(note)) return flash("Already running", "dim")
    if (note.agent) void runWith(note.id, note.agent)
    else pickAgent(note.id)
  }

  const select = (noteId: string) => {
    setSelected(noteId)
    const home = cols.find((c) => c.notes.some((n) => n.id === noteId))
    if (home) setFocus({ column: home.id, note: noteId })
  }

  const createNote = async (text: string, andRun: boolean) => {
    if (!view) return
    const { title, body } = splitPrompt(text)
    if (!title) return flash("A note needs a title", "lemon")
    const column = inboxColumn(view)
    if (!column) return flash("This board has no columns", "berry")
    const created = await act(() => client.createNote(view.board.id, column, title, body))
    if (!created) return
    select(created.noteId)
    setSelected(created.noteId)
    setFocus({ column, note: created.noteId })
    if (created.rejected.length) flash(created.rejected.map((r) => r.reason).join("; "), "lemon")
    if (!andRun) return flash("Saved to Inbox", "mint")
    const agent = defaultAgent(view, ready)
    if (agent) await runWith(created.noteId, agent)
    else pickAgent(created.noteId)
  }

  const openDiff = (noteId: string) => {
    setDiff({ noteId, status: "loading", parsed: { rows: [], files: [] }, stat: "", branch: null, base: null, offset: 0 })
    push({ kind: "diff", noteId })
    client.diff(noteId).then(
      (d) =>
        setDiff((cur) =>
          cur && cur.noteId === noteId
            ? { ...cur, status: "ready", parsed: parseDiff(d.diff), stat: d.stat.trim(), branch: d.branch, base: d.baseBranch }
            : cur,
        ),
      (err: unknown) => {
        setDiff((cur) => (cur && cur.noteId === noteId ? { ...cur, status: "error" } : cur))
        flash(errText(err), "berry")
      },
    )
  }

  const push = (s: Screen) => setStack((st) => [...st, s])
  const back = () => setStack((st) => (st.length > 1 ? st.slice(0, -1) : st))

  const openNote = (noteId: string) => {
    setFollow(FOLLOWING)
    push({ kind: "note", noteId })
  }

  const switchTo = (id: string) => {
    if (id === boardId) return
    setStack([{ kind: "board" }])
    setSelected(null)
    setFocus(null)
    kScroll.current = {}
    kFirst.current = 0
    setFilter("")
    setBoardId(id)
  }

  const switchBoard = async () => {
    const res = await act(() => client.boards())
    const list = res?.boards ?? boards
    setBoards(list)
    if (list.length === 0) return flash("No boards", "lemon")
    setOverlay({
      kind: "pick",
      purpose: "board",
      title: "Switch board",
      noteId: null,
      index: Math.max(0, list.findIndex((b) => b.id === boardId)),
      items: list.map((b) => ({ id: b.id, label: b.name, hint: tildify(b.repoPath) })),
    })
  }

  const addBoard = async (path: string) => {
    const check = await act(() => client.checkRepo(path))
    if (!check) return
    if (!check.isRepo) return flash(`${tildify(path)}: ${check.error ?? "not a git repository"}`, "berry")
    const existing = boards.find((b) => b.repoPath === check.path)
    if (existing) {
      switchTo(existing.id)
      return flash(`${existing.name} is already a board`, "dim")
    }
    const created = await act(
      () => client.createBoard(check.name ?? "board", check.path, check.suggestedSetup ?? null, check.suggestedCarry ?? [], preferredPolicy()),
      `Added ${check.name}`,
    )
    if (!created) return
    const list = await client.boards().catch(() => ({ boards }))
    setBoards(list.boards)
    switchTo(created.board.id)
  }

  const answer = (prompt: PermissionPrompt, decision: "allow" | "deny", scope: "once" | "note", comment?: string) =>
    act(
      () => client.respond(prompt.runId, prompt.requestId, decision, { scope, ...(comment ? { comment } : {}) }),
      decision === "deny" ? "Denied" : scope === "note" ? "Allowed for this note" : "Allowed once",
    )

  const confirmMerge = (note: Note) => {
    // Say which branch it lands on. Known already if the diff was opened;
    // otherwise asked for, and filled in while the question is on screen.
    const known = diff?.noteId === note.id ? diff.base : null
    setOverlay({ kind: "confirm", purpose: "merge", noteId: note.id, base: known })
    if (!known)
      client.diff(note.id).then(
        (d) => setOverlay((cur) => (cur?.kind === "confirm" && cur.noteId === note.id ? { ...cur, base: d.baseBranch } : cur)),
        () => {},
      )
  }

  /** A card dropped somewhere — by the mouse or by H/L/J/K. */
  const performDrop = (d: Drop, note: Note) => {
    switch (d.kind) {
      case "reorder":
      case "move":
        return void act(() =>
          client.moveNote(note.id, d.column, { ...(d.before ? { before: d.before } : {}), ...(d.after ? { after: d.after } : {}) }),
        )
      case "run":
        return run(note)
      case "merge":
        return confirmMerge(note)
      case "refuse":
        return flash(d.why, "lemon")
      case "none":
        return
    }
  }

  const invite = async (email: string) => {
    if (!email.includes("@")) return flash("That doesn't look like an email", "lemon")
    const r = await act(() => client.setMember(email, "member"), `Added ${email}`)
    if (!r) return
    setTeam((t) => ({ ...t, members: r.members }))
    const url = joinedHub()?.url ?? "the hub's address"
    setInvited([
      `You're on the kandy hub at ${url}`,
      `1. Make sure you're on our Tailscale network.`,
      `2. Install kandy:  ${INSTALL_COMMAND}`,
      `3. Connect your machine:  kandy join ${url}`,
    ])
  }

  // --- the transcript (note screen) ------------------------------------------

  const noteRuns = useMemo(
    () => (view && focusNote && screen.kind === "note" ? runsOf(view, focusNote.id) : []),
    [view, focusNote, screen.kind],
  )
  useEffect(() => {
    for (const r of noteRuns) void live.loadTranscript(r.id)
  }, [noteRuns, live])
  const tRows = useMemo(
    () =>
      transcriptRows(
        noteRuns.map((run) => ({ run, frames: state.transcripts[run.id] ?? [] })),
        width - 2,
      ),
    // Clocks in run separators move with `tick`; recomputing is cheap thanks to the per-frame cache.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [noteRuns, state.transcripts, width, tick],
  )

  // --- keys ------------------------------------------------------------------

  const metrics = useRef({ transcriptHeight: 1, diffHeight: 1, helpRows: 0, teamRows: 0, pickStart: 0 })
  const clicks = useRef(clickCounter())
  const press = useRef<{ note: string; x: number; y: number; moved: boolean } | null>(null)
  const teamOffset = useRef(0)

  useInput((input, key) => {
    // Mouse reports arrive through the same channel as keys; they are never keys.
    if (isMouse(input)) {
      const m = parseMouse(input)
      if (m) onMouse(m)
      return
    }
    if (key.ctrl && input === "c") return exit()

    if (overlay?.kind === "input") {
      const res = editKey(overlay.editor, input, key, { multiline: MULTILINE[overlay.purpose] })
      if (overlay.purpose === "filter") {
        if (res.done === "cancel") {
          setFilter("")
          return setOverlay(null)
        }
        setFilter(res.editor.text)
        if (res.done === "submit") return setOverlay(null)
        return setOverlay({ ...overlay, editor: res.editor })
      }
      if (res.done === "cancel") return setOverlay(null)
      if (res.done !== "submit") return setOverlay({ ...overlay, editor: res.editor })
      const text = res.editor.text.trim()
      setOverlay(null)
      const noteId = overlay.noteId
      switch (overlay.purpose) {
        case "new":
        case "new-hold":
          if (text) void createNote(text, overlay.purpose === "new")
          return
        case "message":
          if (text && noteId)
            void act(
              () => client.message(noteId, text),
              (r) => (r.delivery === "live" ? "Sent to the agent" : "Queued as a follow-up"),
            )
          return
        case "revise":
          if (noteId) void act(() => client.reviewNote(noteId, "revise", text || undefined), "Sent back to the agent")
          return
        case "deny":
          if (overlay.prompt) void answer(overlay.prompt, "deny", "once", text || undefined)
          return
        case "edit": {
          if (!noteId) return
          const { title, body } = splitPrompt(text)
          if (!title) return flash("A note needs a title", "lemon")
          return void act(() => client.editNote(noteId, { title, body }), "Saved")
        }
        case "add-board":
          if (text) void addBoard(text.replace(/^~(?=\/|$)/, process.env["HOME"] ?? "~"))
          return
        case "invite":
          if (text) void invite(text)
          return
      }
      return
    }

    if (overlay?.kind === "confirm") {
      if (input === "y" || key.return) confirmYes(overlay)
      else if (input === "n" || key.escape || input === "q") setOverlay(null)
      return
    }

    if (overlay?.kind === "pick") {
      const n = overlay.items.length
      if (key.escape || input === "q") return setOverlay(null)
      if (key.upArrow || input === "k") return setOverlay({ ...overlay, index: (overlay.index - 1 + n) % n })
      if (key.downArrow || input === "j") return setOverlay({ ...overlay, index: (overlay.index + 1) % n })
      const digit = /^[1-9]$/.test(input) ? Number(input) - 1 : -1
      if (!key.return && (digit < 0 || digit >= n)) return
      return pickItem(overlay, digit >= 0 ? digit : overlay.index)
    }

    const action = keyAction(ctx, input, key)
    if (action) handle(action)
  })

  const confirmYes = (o: Extract<Overlay, { kind: "confirm" }>) => {
    const { noteId, purpose } = o
    setOverlay(null)
    const leave = () => {
      if (screen.kind === "note" || screen.kind === "diff") setStack([{ kind: "board" }])
    }
    if (purpose === "merge" || purpose === "discard")
      return void act(() => client.reviewNote(noteId, purpose), purpose === "merge" ? "Merged" : "Discarded").then((r) => r && leave())
    if (purpose === "delete") return void act(() => client.deleteNote(noteId), "Deleted").then((r) => r && leave())
    if (purpose === "full") return void act(() => client.setPolicy(noteId, "full"), "Full access — it can run any command")
  }

  const pickItem = (o: Extract<Overlay, { kind: "pick" }>, index: number) => {
    const item = o.items[index]
    setOverlay(null)
    if (!item) return
    switch (o.purpose) {
      case "agent":
        if (o.noteId) void runWith(o.noteId, item.id as AgentId)
        return
      case "runner":
        if (o.noteId) {
          const noteId = o.noteId
          void act(() => client.assign(noteId, { runner: item.id }), `Given to ${item.label}`)
        }
        return
      case "board":
        return switchTo(item.id)
      case "role": {
        const email = o.target
        if (!email) return
        const role = item.id === "remove" ? null : (item.id as Role)
        return void act(() => client.setMember(email, role), role ? `${email} is now ${role === "owner" ? "an" : "a"} ${role}` : `Removed ${email}`).then(
          (r) => r && setTeam((t) => ({ ...t, members: r.members })),
        )
      }
      case "consent": {
        const accept = item.id as Accept
        new ConsentStore().setAccept(accept)
        setConsent(new ConsentStore().get())
        return flash(`Notes that run here: ${ACCEPT_LABEL[accept]}`, "mint")
      }
    }
  }

  const handle = (a: Action) => {
    const note = focusNote
    switch (a.type) {
      case "quit":
        return exit()
      case "back":
        if (screen.kind === "help") setHelpOffset(0)
        return back()
      case "help":
        if (screen.kind === "help") return back()
        setHelpOffset(0)
        return push({ kind: "help" })
      case "boards":
        return void switchBoard()
      case "boardStep": {
        if (boards.length < 2) return flash("This is the only board — B adds another", "dim")
        const i = boards.findIndex((b) => b.id === boardId)
        const next = boards[(i + a.by + boards.length) % boards.length]!
        return switchTo(next.id)
      }
      case "addBoard":
        return setOverlay({ kind: "input", purpose: "add-board", editor: emptyEditor(tildify(process.cwd())), noteId: null, prompt: null })
      case "team":
        if (screen.kind === "team") return back()
        setInvited(null)
        void loadTeam()
        return push({ kind: "team" })
      case "view":
        if (width < KANBAN_MIN_WIDTH) return flash("Too narrow for columns — widen the terminal", "dim")
        setMode((m) => (m === "kanban" ? "list" : "kanban"))
        return
      case "filter":
        return setOverlay({ kind: "input", purpose: "filter", editor: emptyEditor(filter), noteId: null, prompt: null })
      case "clearFilter":
        return setFilter("")
      case "new":
        return setOverlay({ kind: "input", purpose: a.run ? "new" : "new-hold", editor: emptyEditor(), noteId: null, prompt: null })
      case "move":
      case "page":
      case "top":
      case "bottom":
      case "column":
        return scrollAction(a)
      case "file":
        if (!diff) return
        return setDiff({
          ...diff,
          offset: clampOffset(jumpFile(diff.parsed.files, diff.offset, a.dir), diff.parsed.rows.length, metrics.current.diffHeight),
        })
      case "invite":
        setInvited(null)
        return setOverlay({ kind: "input", purpose: "invite", editor: emptyEditor(), noteId: null, prompt: null })
      case "role": {
        if (!member) return
        return setOverlay({
          kind: "pick",
          purpose: "role",
          title: `${member.email} — currently ${member.role}`,
          noteId: null,
          target: member.email,
          index: Math.max(0, ["owner", "member", "viewer"].indexOf(member.role)),
          items: [
            { id: "owner", label: "Owner", hint: "can add people and change roles" },
            { id: "member", label: "Member", hint: "can write and run notes" },
            { id: "viewer", label: "Viewer", hint: "can read the board" },
            { id: "remove", label: "Remove from the team", hint: "" },
          ],
        })
      }
      case "consentSetting":
        return setOverlay({
          kind: "pick",
          purpose: "consent",
          title: "Whose notes may run on this machine?",
          noteId: null,
          index: Math.max(0, (["nobody", "approved", "team"] as Accept[]).indexOf(consent.accept)),
          items: (["nobody", "approved", "team"] as Accept[]).map((k) => ({ id: k, label: k, hint: ACCEPT_LABEL[k] })),
        })
      case "refresh":
        return void loadTeam()
    }
    if (!note) return
    switch (a.type) {
      case "open":
        return openNote(note.id)
      case "run":
        return run(note)
      case "cancel": {
        const r = view ? runOf(view, note) : undefined
        if (!r || !LIVE_RUN.has(r.status)) return flash("Nothing running", "dim")
        return void act(() => client.cancelRun(r.id), "Cancelled")
      }
      case "diff":
        return openDiff(note.id)
      case "message":
        return setOverlay({ kind: "input", purpose: "message", editor: emptyEditor(), noteId: note.id, prompt: null })
      case "revise":
        return setOverlay({ kind: "input", purpose: "revise", editor: emptyEditor(), noteId: note.id, prompt: null })
      case "merge":
        return confirmMerge(note)
      case "discard":
        return setOverlay({ kind: "confirm", purpose: "discard", noteId: note.id })
      case "delete":
        if (isLive(note)) return flash("It's running — x cancels it first", "lemon")
        return setOverlay({ kind: "confirm", purpose: "delete", noteId: note.id })
      case "edit":
        return setOverlay({
          kind: "input",
          purpose: "edit",
          editor: emptyEditor(note.body ? `${note.title}\n${note.body}` : note.title),
          noteId: note.id,
          prompt: null,
        })
      case "policy":
        if (note.policy === "full") return void act(() => client.setPolicy(note.id, "repo"), "Repo only — commands are asked about")
        return setOverlay({ kind: "confirm", purpose: "full", noteId: note.id })
      case "shift": {
        const col = cols.findIndex((c) => c.notes.some((n) => n.id === note.id))
        if (col < 0) return
        if (a.dx !== 0) {
          const target = cols[col + a.dx]
          if (!target) return
          return performDrop(dropAction(cols, note, target.id, 0), note)
        }
        const at = cols[col]!.notes.findIndex((n) => n.id === note.id)
        // Indexes count the card in its old place: down one is "after the next".
        const index = a.dy < 0 ? at - 1 : at + 2
        if (index < 0 || index > cols[col]!.notes.length) return
        return performDrop(dropAction(cols, note, cols[col]!.id, index), note)
      }
      case "give": {
        if (!hub || !view) return
        const targets = giveTargets(runners, view.board.id, note)
        if (targets.length === 0) return flash("No other machine online has this board", "lemon")
        return setOverlay({
          kind: "pick",
          purpose: "runner",
          title: "Give to",
          noteId: note.id,
          index: 0,
          items: targets.map((r) => ({ id: r.runnerId, label: r.name, hint: r.owner ?? "" })),
        })
      }
      case "allow": {
        const prompt = focusPrompts[0]
        if (!prompt) return
        if (a.scope === "note" && !prompt.rule) return flash("This one can't be allowed for the whole note — a allows it once", "lemon")
        return void answer(prompt, "allow", a.scope)
      }
      case "deny": {
        const prompt = focusPrompts[0]
        if (!prompt) return
        return setOverlay({ kind: "input", purpose: "deny", editor: emptyEditor(), noteId: note.id, prompt })
      }
      case "consent":
        return void act(
          () => client.consent(note.id, a.accept, a.always),
          a.accept ? (a.always ? "Allowed — and always from now on" : "Running it") : "Declined",
        )
    }
  }

  const scrollAction = (a: Extract<Action, { type: "move" | "page" | "top" | "bottom" | "column" }>) => {
    if (screen.kind === "board" && kanbanOn) {
      if (!kFocus) return
      if (a.type === "column") return setFocus(moveFocus(cols, kFocus, a.by, 0))
      const col = cols.find((c) => c.id === kFocus.column)
      if (!col || col.notes.length === 0) return
      if (a.type === "top") return setFocus({ column: col.id, note: col.notes[0]!.id })
      if (a.type === "bottom") return setFocus({ column: col.id, note: col.notes[col.notes.length - 1]!.id })
      const by = a.type === "move" ? a.by : a.by * Math.max(1, kl?.slots ?? 1)
      return setFocus(moveFocus(cols, kFocus, 0, by))
    }
    if (a.type === "column") return
    if (screen.kind === "board") {
      if (a.type === "top") return setSelected(selectFirst(rows))
      if (a.type === "bottom") return setSelected(selectLast(rows))
      const by = a.type === "move" ? a.by : a.by * Math.max(1, bodyHeight - 2)
      return setSelected(moveSelection(rows, effectiveSelected, by))
    }
    if (screen.kind === "note") {
      const h = metrics.current.transcriptHeight
      if (a.type === "top") return setFollow(toTop())
      if (a.type === "bottom") return setFollow(toBottom())
      const by = a.type === "move" ? a.by : a.by * Math.max(1, h - 1)
      return setFollow((f) => scroll(f, by, tRows.length, h))
    }
    if (screen.kind === "diff" && diff) {
      const h = metrics.current.diffHeight
      const total = diff.parsed.rows.length
      const offset =
        a.type === "top" ? 0 : a.type === "bottom" ? total : diff.offset + (a.type === "move" ? a.by : a.by * Math.max(1, h - 1))
      return setDiff({ ...diff, offset: clampOffset(offset, total, h) })
    }
    if (screen.kind === "help") {
      const max = Math.max(0, metrics.current.helpRows - bodyHeight)
      const by = a.type === "move" ? a.by : a.type === "page" ? a.by * bodyHeight : a.type === "top" ? -1e9 : 1e9
      return setHelpOffset((o) => Math.max(0, Math.min(max, o + by)))
    }
    if (screen.kind === "team") {
      const n = team.members.length
      if (n === 0) return
      const by = a.type === "move" ? a.by : a.type === "page" ? a.by * 5 : a.type === "top" ? -1e9 : 1e9
      return setMemberIndex((i) => Math.max(0, Math.min(n - 1, i + by)))
    }
  }

  // --- the mouse --------------------------------------------------------------

  const hintBar = (): Hint[] => fitHints(overlay ? overlayHints(overlay) : hints(ctx), width)
  const tabBar = () => tabSegs(boards, boardId, view, waiting, width, p, statusSegs(view, state.connected, hub))

  const onMouse = (m: MouseEvent) => {
    // The footer's hints are buttons.
    if (m.type === "down" && m.button === "left" && m.y === height - 1) {
      const hit = hitHints(hintBar(), m.x)
      if (!hit) return
      if (overlay?.kind === "confirm") return hit.key === "y" ? confirmYes(overlay) : setOverlay(null)
      if (overlay?.kind === "pick") return hit.key === "enter" ? pickItem(overlay, overlay.index) : setOverlay(null)
      if (overlay?.kind === "input") return
      if (hit.action) handle(hit.action)
      return
    }

    if (overlay?.kind === "pick") {
      if (m.type === "wheel") {
        const n = overlay.items.length
        return setOverlay({ ...overlay, index: (overlay.index + (m.dir === "down" ? 1 : n - 1)) % n })
      }
      if (m.type === "down" && m.button === "left") {
        const i = metrics.current.pickStart + (m.y - BODY_TOP - 2)
        if (i >= 0 && i < overlay.items.length) {
          if (i === overlay.index || clicks.current(`pick:${i}`) > 1) return pickItem(overlay, i)
          return setOverlay({ ...overlay, index: i })
        }
      }
      return
    }
    if (overlay) return

    // The header's tabs.
    if (m.type === "down" && m.button === "left" && m.y === 0) {
      const t = tabBar().regions.find((r) => m.x >= r.x0 && m.x < r.x1)
      if (!t) return
      if (t.target === "+") return handle({ type: "addBoard" })
      if (t.target === "boards") return handle({ type: "boards" })
      return switchTo(t.target)
    }

    const y = m.y - BODY_TOP
    if (m.type === "wheel") {
      const by = m.dir === "down" ? 1 : -1
      if (screen.kind === "board" && kl) {
        const hit = hitTest(kl, m.x, y)
        if (!hit) return
        const col = kl.columns.find((c) => c.column.id === hit.column)
        if (!col) return
        kScroll.current[hit.column] = Math.max(0, Math.min(col.column.notes.length - kl.slots, col.scroll + by))
        // Keep the keyboard's card on screen: if it scrolled out, take the nearest one.
        if (kFocus?.column === hit.column) {
          const at = col.column.notes.findIndex((n) => n.id === kFocus.note)
          const s = kScroll.current[hit.column]!
          const clamped = Math.max(s, Math.min(s + kl.slots - 1, at))
          if (clamped !== at && col.column.notes[clamped]) return setFocus({ column: hit.column, note: col.column.notes[clamped]!.id })
        }
        return setTick((t) => t + 1)
      }
      return handle({ type: "move", by: by * 3 })
    }

    if (screen.kind === "board" && kl) {
      const hit = hitTest(kl, m.x, y)
      if (m.type === "down" && m.button === "left") {
        if (!hit) return
        if (hit.kind === "card") {
          const count = clicks.current(`card:${hit.note}`)
          setFocus({ column: hit.column, note: hit.note })
          setSelected(hit.note)
          if (count >= 2) {
            press.current = null
            return openNote(hit.note)
          }
          press.current = { note: hit.note, x: m.x, y: m.y, moved: false }
          return
        }
        const col = cols.find((c) => c.id === hit.column)
        return setFocus({ column: hit.column, note: col?.notes[0]?.id ?? null })
      }
      if (m.type === "drag" && press.current) {
        if (!press.current.moved && Math.abs(m.x - press.current.x) + Math.abs(m.y - press.current.y) < 2) return
        press.current.moved = true
        return setDrag({ note: press.current.note, over: hit?.column ?? null })
      }
      if (m.type === "up") {
        const held = press.current
        press.current = null
        setDrag(null)
        if (!held?.moved || !hit || !view) return
        const note = view.notes.find((n) => n.id === held.note)
        if (!note) return
        return performDrop(dropAction(cols, note, hit.column, dropIndex(kl, hit.column, y)), note)
      }
      return
    }

    if (screen.kind === "board" && m.type === "down" && m.button === "left") {
      const row = rows[boardOffset.current + y]
      if (row?.kind !== "note") return
      if (clicks.current(`row:${row.key}`) >= 2) return openNote(row.key)
      return setSelected(row.key)
    }

    if (screen.kind === "team" && m.type === "down" && m.button === "left" && owner) {
      const i = y - (metrics.current.teamRows - team.members.length) + teamOffset.current
      if (i >= 0 && i < team.members.length) {
        if (i === memberIndex && clicks.current(`member:${i}`) >= 2) return handle({ type: "role" })
        clicks.current(`member:${i}`)
        return setMemberIndex(i)
      }
    }
  }

  // --- render ----------------------------------------------------------------

  const now = Date.now()
  let body: ReactNode[] | ReactNode
  if (overlay?.kind === "pick") body = pickRows(overlay, width, bodyHeight, p, metrics.current)
  else if (!boardId) body = messageRows(["No boards yet.", "Run kandy inside a git repository and it becomes one — or press B to add one."], width, p)
  else if (!view) body = messageRows([state.error ? `Couldn't load the board: ${state.error}` : "Loading board…"], width, p, state.error ? "berry" : "dim")
  else if (screen.kind === "board") body = kl ? kanbanBody(view, kl) : listBody()
  else if (screen.kind === "help") body = helpBody()
  else if (screen.kind === "team") body = teamBody()
  else if (!focusNote) body = messageRows(["That note is gone."], width, p, "dim")
  else if (screen.kind === "note") body = noteBody(view, focusNote)
  else body = diffBody(focusNote)

  function kanbanBody(v: BoardView, l: Layout): ReactNode {
    return (
      <Kanban
        l={l}
        view={v}
        focus={kFocus}
        drag={drag}
        now={now}
        tick={tick}
        hub={hub}
        runners={runners}
        p={p}
        empty={(c) =>
          filter
            ? "nothing matches"
            : c.column.lane === "inbox"
              ? "n writes a note"
              : c.column.lane === "running"
                ? "nothing running"
                : c.column.lane === "review"
                  ? "nothing to review"
                  : "—"
        }
      />
    )
  }

  function listBody(): ReactNode[] {
    if (!view) return []
    if (rows.length === 0 || !rows.some((r) => r.kind === "note")) {
      const lanes = rows.map((r) => (r.kind === "lane" ? laneRow(r.name, r.count, width, r.key) : null))
      return [
        ...lanes,
        <Text key="empty-gap"> </Text>,
        <Text key="empty" dimColor>
          {filter ? `  Nothing matches “${filter}”. esc clears the filter.` : "  No notes yet — press n to write one."}
        </Text>,
      ]
    }
    const offset = scrollOffset(boardOffset.current, selIndex, bodyHeight, rows.length)
    boardOffset.current = offset
    return rows.slice(offset, offset + bodyHeight).map((r) =>
      r.kind === "lane"
        ? laneRow(r.name, r.count, width, r.key)
        : noteRow(view, r.note, r.key === effectiveSelected, runners, hub, width, now, tick, p),
    )
  }

  function noteBody(v: BoardView, note: Note): ReactNode[] {
    const head = noteHeader(v, note, state.activity, runners, hub, width, p)
    const h = Math.max(1, bodyHeight - head.length)
    metrics.current.transcriptHeight = h
    let content: ReactNode[]
    if (tRows.length === 0) {
      const lines = [
        ...(note.body ? wrap(note.body, width - 2).map((t) => ({ t, tone: "plain" as Tone })) : []),
        ...(note.body ? [{ t: "", tone: "plain" as Tone }] : []),
        {
          t: noteRuns.length === 0 ? "Not run yet — r runs it." : isLive(note) ? "Waiting for the agent to say something…" : "No transcript.",
          tone: "dim" as Tone,
        },
      ]
      content = lines.map((l, i) => (
        <Text key={`b${i}`} {...toneProps(p, l.tone)} wrap="truncate-end">
          {" " + l.t}
        </Text>
      ))
    } else {
      const start = viewStart(follow, tRows.length, h)
      content = tRows.slice(start, start + h).map((r, i) => <Segs key={`t${start + i}`} segs={[{ text: " ", tone: "plain" }, ...r]} p={p} />)
      if (!follow.follow && start + h < tRows.length) {
        const more = tRows.length - start - h
        content[content.length - 1] = (
          <Text key="more" {...toneProps(p, "lemon")}>
            {fit(` ↓ ${more} more — G to follow`, width)}
          </Text>
        )
      }
    }
    return [...head, ...content]
  }

  function diffBody(note: Note): ReactNode[] {
    const head: ReactNode[] = [
      <Text key="dt" bold wrap="truncate-end">
        {" " + truncate(note.title, width - 2)}
      </Text>,
      <Segs
        key="ds"
        p={p}
        segs={[
          { text: " ", tone: "plain" },
          ...(note.stat
            ? [
                { text: `${note.stat.files} file${note.stat.files === 1 ? "" : "s"}  `, tone: "dim" as Tone },
                { text: `+${note.stat.insertions} `, tone: "mint" as Tone },
                { text: `−${note.stat.deletions}`, tone: "berry" as Tone },
              ]
            : []),
          ...(diff?.branch ? [{ text: `  ${diff.branch}${diff.base ? ` → ${diff.base}` : ""}`, tone: "dim" as Tone }] : []),
        ]}
      />,
      <Rule key="dr" width={width} p={p} />,
    ]
    const h = Math.max(1, bodyHeight - head.length)
    metrics.current.diffHeight = h
    if (!diff || diff.noteId !== note.id || diff.status === "loading") return [...head, <Text key="dl" dimColor> Loading diff…</Text>]
    if (diff.status === "error") return [...head, <Text key="de" {...toneProps(p, "berry")}> Couldn't load the diff.</Text>]
    if (diff.parsed.rows.length === 0) return [...head, <Text key="d0" dimColor> No changes.</Text>]
    const start = clampOffset(diff.offset, diff.parsed.rows.length, h)
    return [
      ...head,
      ...diff.parsed.rows.slice(start, start + h).map((r, i) => (
        <Text key={`d${start + i}`} {...toneProps(p, r.tone)} bold={r.bold} wrap="truncate-end">
          {" " + truncate(r.text, width - 1)}
        </Text>
      )),
    ]
  }

  function helpBody(): ReactNode[] {
    const out: ReactNode[] = []
    for (const s of helpSections()) {
      out.push(<Text key={`h-${s.title}`} bold>{" " + s.title}</Text>)
      for (const k of s.keys)
        out.push(
          <Text key={`h-${s.title}-${k.key}-${k.label}`} wrap="truncate-end">
            <Text bold>{"   " + fit(k.key, 12)}</Text>
            <Text dimColor>{k.label}</Text>
          </Text>,
        )
      out.push(<Text key={`h-${s.title}-gap`}> </Text>)
    }
    metrics.current.helpRows = out.length
    return out.slice(helpOffset, helpOffset + bodyHeight)
  }

  function teamBody(): ReactNode[] {
    const out: ReactNode[] = []
    const section = (key: string, title: string, note?: string) => {
      out.push(<Text key={`gap-${key}`}> </Text>)
      out.push(
        <Text key={`s-${key}`} wrap="truncate-end">
          <Text bold>{" " + title.toUpperCase()}</Text>
          {note ? <Text dimColor>{"  " + note}</Text> : null}
        </Text>,
      )
    }
    const hubUrl = joinedHub()?.url ?? null

    out.push(
      <Split
        key="t-head"
        width={width}
        p={p}
        left={[
          { text: " Team", tone: "plain", bold: true },
          { text: hub ? `  ${hubUrl ?? "this hub"}` : "  just you, on this machine", tone: "dim" },
        ]}
        right={hub && me?.email ? [{ text: `${me.email}${me.role ? ` · ${me.role}` : ""} `, tone: "dim" }] : []}
      />,
    )

    if (!hub) {
      section("solo", "Share a board")
      for (const [i, l] of [
        "This machine isn't on a team. To share a board, one person starts a hub on a machine",
        "that stays on, and everyone joins it. Everyone's notes still run on their own machine.",
        "",
        "  kandy hub --tailscale       start a hub here",
        "  kandy join <hub-url>        join one someone else started",
      ].entries())
        out.push(
          <Text key={`solo-${i}`} dimColor={!l.startsWith("  ")} wrap="truncate-end">
            {" " + l}
          </Text>,
        )
    }

    section("consent", "This machine", "c changes it")
    out.push(
      <Text key="consent" wrap="truncate-end">
        <Text dimColor>{"   Whose notes may run here: "}</Text>
        <Text bold>{consent.accept}</Text>
        <Text dimColor>{` — ${ACCEPT_LABEL[consent.accept]}`}</Text>
      </Text>,
    )
    if (consent.approved.length)
      out.push(
        <Text key="approved" dimColor wrap="truncate-end">
          {"   Approved: " + consent.approved.join(", ")}
        </Text>,
      )

    if (hub) {
      if (team.error) out.push(<Text key="terr" {...toneProps(p, "berry")}>{" " + team.error}</Text>)
      section("machines", `Machines ${runners.length}`)
      if (runners.length === 0) out.push(<Text key="m0" dimColor>{"   none connected"}</Text>)
      for (const r of runners) {
        const ready = r.agents.filter((a) => a.installed && a.authed).map((a) => a.id)
        out.push(
          <Split
            key={`m-${r.runnerId}`}
            width={width}
            p={p}
            left={[
              { text: r.online ? "   ● " : "   ○ ", tone: r.online ? "mint" : "dim" },
              { text: r.name, tone: "plain", bold: true },
              { text: r.owner ? `  ${r.owner}` : "", tone: "dim" },
              { text: ready.length ? `  ${ready.join(" ")}` : "  no agent signed in", tone: ready.length ? "dim" : "lemon" },
            ]}
            right={[{ text: `${r.boards.length} board${r.boards.length === 1 ? "" : "s"} · ${r.online ? "online" : `seen ${formatDuration(now - r.lastSeen)} ago`} `, tone: "dim" }]}
          />,
        )
      }

      section("people", `People ${team.members.length}`, owner ? "i invites · enter changes a role" : "")
      const peopleTop = out.length
      if (team.loading && team.members.length === 0) out.push(<Text key="p-load" dimColor>{"   loading…"}</Text>)
      team.members.forEach((m, i) => {
        const sel = owner && i === memberIndex
        out.push(
          <Split
            key={`p-${m.email}`}
            width={width}
            p={p}
            left={[
              { text: sel ? "  › " : "    ", tone: "mint", bold: true },
              { text: m.email, tone: "plain", bold: sel },
              { text: `  ${m.role}`, tone: m.role === "owner" ? "lemon" : "dim" },
              { text: m.email === me?.email ? "  you" : "", tone: "dim" },
            ]}
            right={[{ text: `${m.addedBy ? `added by ${m.addedBy.split("@")[0]}, ` : ""}${formatDuration(now - m.addedAt)} ago `, tone: "dim" }]}
          />,
        )
      })
      metrics.current.teamRows = peopleTop + team.members.length

      if (invited) {
        section("invite", "Send them this")
        invited.forEach((l, i) => out.push(<Text key={`inv-${i}`} wrap="truncate-end">{"   " + l}</Text>))
      }

      section("activity", "Recent")
      if (!team.events.some(isTeamActivity)) out.push(<Text key="a0" dimColor>{"   nothing yet"}</Text>)
      const actx = activityContext(team.events, view, runners)
      for (const e of team.events.filter(isTeamActivity).slice(0, 15)) {
        out.push(
          <Split
            key={`a-${e.seq}`}
            width={width}
            p={p}
            left={[
              { text: "   " + (activityActor(e)?.split("@")[0] ?? "someone"), tone: "plain", bold: true },
              { text: " " + activityPhrase(e, actx), tone: "dim" },
            ]}
            right={[{ text: `${formatDuration(now - e.ts)} `, tone: "dim" }]}
          />,
        )
      }
    }

    // Keep the selected person on screen.
    const selRow = metrics.current.teamRows - team.members.length + memberIndex
    let off = teamOffset.current
    if (selRow < off) off = Math.max(0, selRow - 1)
    if (selRow >= off + bodyHeight) off = selRow - bodyHeight + 1
    teamOffset.current = Math.max(0, Math.min(off, Math.max(0, out.length - bodyHeight)))
    return out.slice(teamOffset.current, teamOffset.current + bodyHeight)
  }

  const tabs = tabBar()
  const header = <Segs segs={tabs.segs} p={p} />

  return (
    <Box flexDirection="column" width={width} height={height}>
      {header}
      <Rule width={width} p={p} />
      <Box flexDirection="column" height={bodyHeight} overflow="hidden">
        {Array.isArray(body) ? <Fill rows={body} height={bodyHeight} /> : body}
      </Box>
      {pinned}
      {overlay?.kind === "input" ? inputBox(overlay, width, p) : null}
      {statusLine(overlay, toast, view, drag, width, p)}
      <Hints hints={hintBar()} width={width} p={p} />
    </Box>
  )
}

// --- pieces ------------------------------------------------------------------

type TabTarget = string | "+" | "boards"

/**
 * The header: the mark, a tab per board (with how many notes wait on you
 * there), a + to add one, and on the right what's live. Returned with where
 * each tab is, for the mouse.
 */
function tabSegs(
  boards: readonly Board[],
  boardId: string | null,
  view: BoardView | null,
  waiting: Readonly<Record<string, number>>,
  width: number,
  p: Palette,
  right: Seg[],
): { segs: Seg[]; regions: { x0: number; x1: number; target: TabTarget }[] } {
  const segs: Seg[] = [
    { text: " ▮", tone: "berry" },
    { text: "▮", tone: "lemon" },
    { text: "▮ ", tone: "mint" },
  ]
  const regions: { x0: number; x1: number; target: TabTarget }[] = []
  let x = 4
  const rightW = right.reduce((n, s) => n + textWidth(s.text), 0)
  const room = width - rightW - 1
  const add = (text: string, tone: Tone, target: TabTarget, extra: Partial<Seg> = {}) => {
    const w = textWidth(text)
    if (x + w > room) return false
    segs.push({ text, tone, ...extra })
    regions.push({ x0: x, x1: x + w, target })
    x += w
    return true
  }
  const list = boards.length ? boards : view ? [view.board] : []
  let shown = 0
  for (const b of list) {
    const active = b.id === boardId
    const n = active && view ? needsYou(view) : (waiting[b.id] ?? 0)
    const label = ` ${truncate(b.name, 18)}${n ? ` ${n}` : ""} `
    if (!add(label, active ? "plain" : "dim", b.id, active ? { bold: true, inverse: true } : {})) break
    shown++
    segs.push({ text: " ", tone: "plain" })
    x += 1
  }
  if (shown < list.length) add(`+${list.length - shown} more `, "dim", "boards")
  add(" + ", "dim", "+")
  const used = segs.reduce((n, s) => n + textWidth(s.text), 0)
  segs.push({ text: " ".repeat(Math.max(1, width - used - rightW)), tone: "plain" })
  void p
  return { segs: [...segs, ...right], regions }
}

function statusSegs(view: BoardView | null, connected: boolean, hub: boolean): Seg[] {
  if (!view) return []
  const running = runningCount(view)
  const need = needsYou(view)
  const segs: Seg[] = []
  if (running > 0) segs.push({ text: `${running} running`, tone: "mint" }, { text: " · ", tone: "dim" })
  segs.push({ text: `${need} need you`, tone: need > 0 ? "lemon" : "dim", bold: need > 0 })
  segs.push({ text: " · ", tone: "dim" })
  if (hub) segs.push({ text: "team", tone: "dim" }, { text: " · ", tone: "dim" })
  segs.push(connected ? { text: "● live ", tone: "mint" } : { text: "○ reconnecting ", tone: "lemon" })
  return segs
}

/** The hint under x, laid out exactly as <Hints> draws them. */
function hitHints(hs: readonly Hint[], x: number): Hint | null {
  let at = 1
  for (const h of hs) {
    const w = textWidth(h.key) + 1 + textWidth(h.label) + 2
    if (x >= at && x < at + w - 2) return h
    at += w
  }
  return null
}

function laneRow(name: string, count: number, width: number, key: string): ReactNode {
  const head = ` ${name.toUpperCase()} ${count} `
  return (
    <Text key={key} wrap="truncate-end">
      <Text bold>{` ${name.toUpperCase()}`}</Text>
      <Text dimColor>{` ${count} ` + "─".repeat(Math.max(0, width - textWidth(head) - 1))}</Text>
    </Text>
  )
}

function noteRow(
  view: BoardView,
  note: Note,
  selected: boolean,
  runners: readonly RunnerInfo[],
  hub: boolean,
  width: number,
  now: number,
  tick: number,
  p: Palette,
): ReactNode {
  const g = glyph(view, note, tick)
  const right: Seg[] = []
  const stat = diffstat(note)
  if (stat && note.stat) {
    right.push({ text: `+${note.stat.insertions}`, tone: "mint" }, { text: ` −${note.stat.deletions}  `, tone: "berry" })
  }
  if (note.agent) right.push({ text: note.agent + "  ", tone: "dim" })
  if (hub && (note.runner || note.held)) {
    const m = machineName(runners, note.held?.runnerId ?? note.runner)
    if (m) right.push({ text: `on ${truncate(m, 14)}  `, tone: note.held ? "lemon" : "dim" })
  }
  right.push({ text: noteClock(view, note, now).padStart(3) + " ", tone: "dim" })
  const titleTone: Tone = note.status === "done" ? "dim" : "plain"
  return (
    <Split
      key={note.id}
      width={width}
      p={p}
      left={[
        { text: selected ? " ›" : "  ", tone: "mint", bold: true },
        { text: ` ${g.char} `, tone: g.tone, bold: g.tone === "lemon" },
        { text: note.title.replace(/\s+/g, " "), tone: titleTone, bold: selected, inverse: false },
      ]}
      right={right}
    />
  )
}

function noteHeader(
  view: BoardView,
  note: Note,
  activity: Readonly<Record<string, { tool: string; detail: string }>>,
  runners: readonly RunnerInfo[],
  hub: boolean,
  width: number,
  p: Palette,
): ReactNode[] {
  const g = glyph(view, note)
  const run = runOf(view, note)
  const model = note.model ?? run?.model ?? (note.agent ? view.board.models[note.agent] : undefined) ?? null
  const meta: Seg[] = [
    { text: " " + g.char + " ", tone: g.tone, bold: true },
    { text: note.held ? "held" : note.status, tone: g.tone === "plain" ? "plain" : g.tone },
  ]
  const dot = (): Seg => ({ text: " · ", tone: "dim" })
  if (note.agent) meta.push(dot(), { text: agentLabel(note.agent), tone: "plain" })
  if (model) meta.push(dot(), { text: model, tone: "dim" })
  if (note.branch) meta.push(dot(), { text: note.branch, tone: "dim" })
  if (note.stat && (note.stat.insertions || note.stat.deletions))
    meta.push(dot(), { text: `+${note.stat.insertions}`, tone: "mint" }, { text: ` −${note.stat.deletions}`, tone: "berry" })
  meta.push(dot(), { text: note.policy === "full" ? "full access" : "repo only", tone: note.policy === "full" ? "lemon" : "dim" })
  if (hub && note.runner) meta.push(dot(), { text: `on ${machineName(runners, note.runner)}`, tone: "dim" })
  if (run?.costUsd != null) meta.push(dot(), { text: `$${run.costUsd.toFixed(2)}`, tone: "dim" })

  const rows: ReactNode[] = [
    <Text key="nt" bold wrap="truncate-end">
      {" " + truncate(note.title.replace(/\s+/g, " "), width - 2)}
    </Text>,
    <Segs key="nm" segs={meta} p={p} />,
  ]
  const now = run && LIVE_RUN.has(run.status) ? activity[run.id] : undefined
  if (now) {
    rows.push(
      <Segs
        key="na"
        p={p}
        segs={[
          { text: "   ", tone: "plain" },
          { text: now.tool + " ", tone: "dim", bold: true },
          { text: now.detail.replace(/\s+/g, " "), tone: "dim" },
        ]}
      />,
    )
  }
  rows.push(<Rule key="nr" width={width} p={p} />)
  return rows
}

/** Questions and held-run answers, pinned above the footer on the note screen. */
function pinnedRows(
  prompts: readonly PermissionPrompt[],
  note: Note,
  view: BoardView | null,
  heldMine: boolean,
  runners: readonly RunnerInfo[],
  width: number,
  p: Palette,
): ReactNode[] {
  const out: ReactNode[] = []
  if (prompts.length > 0 && view) {
    const agent = view.runs.find((r) => r.id === prompts[0]!.runId)?.agent ?? note.agent
    out.push(<Rule key="pr" width={width} p={p} tone="lemon" />)
    for (const [i, prompt] of prompts.slice(0, 2).entries()) {
      out.push(
        <Text key={`pq${i}`} {...toneProps(p, "lemon")} bold wrap="truncate-end">
          {" ? " + truncate(promptLine(prompt, agent), width - 4)}
        </Text>,
      )
    }
    if (prompts.length > 2) out.push(<Text key="pm" dimColor>{`   +${prompts.length - 2} more waiting`}</Text>)
    const first = prompts[0]!
    out.push(
      <Segs
        key="pk"
        p={p}
        segs={[
          { text: "   a", tone: "plain", bold: true },
          { text: " allow once  ", tone: "dim" },
          ...(first.rule
            ? [
                { text: "A", tone: "plain" as Tone, bold: true },
                { text: " allow for this note  ", tone: "dim" as Tone },
              ]
            : []),
          { text: "D", tone: "plain", bold: true },
          { text: " deny", tone: "dim" },
        ]}
      />,
    )
  }
  if (note.held) {
    const runner = runners.find((r) => r.runnerId === note.held!.runnerId)
    const who = note.held.requestedBy ?? "Someone"
    out.push(<Rule key="hr" width={width} p={p} tone="lemon" />)
    out.push(
      <Text key="hq" {...toneProps(p, "lemon")} wrap="truncate-end">
        {heldMine
          ? ` ! ${who} wants to run this on your machine with ${agentLabel(note.held.agent)}.`
          : ` ! Waiting for ${runner?.owner ?? "the machine's owner"} to allow it on ${runner?.name ?? "their machine"}.`}
      </Text>,
    )
    if (heldMine)
      out.push(
        <Segs
          key="hk"
          p={p}
          segs={[
            { text: "   y", tone: "plain", bold: true },
            { text: " run it  ", tone: "dim" },
            { text: "Y", tone: "plain", bold: true },
            { text: ` always allow ${who}  `, tone: "dim" },
            { text: "n", tone: "plain", bold: true },
            { text: " decline", tone: "dim" },
          ]}
        />,
      )
  }
  return out
}

function wrapEditor(ed: Editor, width: number): string[] {
  const text = ed.text.slice(0, ed.cursor) + "█" + ed.text.slice(ed.cursor)
  return wrap(text, Math.max(4, width))
}

function inputBox(o: Extract<Overlay, { kind: "input" }>, width: number, p: Palette): ReactNode {
  // The cursor is drawn as an inverse cell: wrap with a placeholder glyph,
  // then split each row on it.
  const lines = wrapEditor(o.editor, width - 4)
  const cursorLine = lines.findIndex((l) => l.includes("█"))
  const start = Math.max(0, Math.min(cursorLine - MAX_INPUT_ROWS + 1, lines.length - MAX_INPUT_ROWS))
  const shown = lines.slice(start, start + MAX_INPUT_ROWS)
  return (
    <Box flexDirection="column">
      <Text {...toneProps(p, "mint")} bold wrap="truncate-end">
        {" " + INPUT_LABEL[o.purpose]}
      </Text>
      {shown.map((l, i) => {
        const at = l.indexOf("█")
        const prefix = i === 0 && start === 0 ? " › " : "   "
        if (at === -1)
          return (
            <Text key={i} wrap="truncate-end">
              {prefix + l}
            </Text>
          )
        return (
          <Text key={i} wrap="truncate-end">
            {prefix + l.slice(0, at)}
            <Text inverse> </Text>
            {l.slice(at + 1)}
          </Text>
        )
      })}
    </Box>
  )
}

function overlayHints(o: Overlay): Hint[] {
  switch (o.kind) {
    case "input":
      return o.purpose === "filter"
        ? [
            { key: "enter", label: "keep" },
            { key: "esc", label: "clear" },
          ]
        : [
            {
              key: "enter",
              label:
                o.purpose === "new"
                  ? "create & run"
                  : o.purpose === "new-hold"
                    ? "create"
                    : o.purpose === "edit"
                      ? "save"
                      : o.purpose === "add-board"
                        ? "add"
                        : o.purpose === "invite"
                          ? "invite"
                          : "send",
            },
            ...(MULTILINE[o.purpose] ? [{ key: "ctrl+j", label: "newline" }] : []),
            { key: "esc", label: "cancel" },
          ]
    case "confirm":
      return [
        { key: "y", label: o.purpose === "full" ? "give full access" : o.purpose },
        { key: "n", label: "cancel" },
      ]
    case "pick":
      return [
        { key: "↑↓", label: "choose" },
        { key: "enter", label: "select" },
        { key: "esc", label: "cancel" },
      ]
  }
}

function statusLine(
  overlay: Overlay | null,
  toast: Toast | null,
  view: BoardView | null,
  drag: DragState | null,
  width: number,
  p: Palette,
): ReactNode {
  if (overlay?.kind === "confirm") {
    const note = view?.notes.find((n) => n.id === overlay.noteId)
    const title = `“${note?.title ?? "this note"}”`
    const text =
      overlay.purpose === "merge"
        ? `Merge ${title} into ${overlay.base ?? "the base branch"}?`
        : overlay.purpose === "discard"
          ? `Discard ${title}? The branch and worktree are thrown away.`
          : overlay.purpose === "delete"
            ? `Delete ${title}? The note and its history go; merged work stays in git.`
            : `Give ${title} full access? It can then run any command, without asking.`
    const tone: Tone = overlay.purpose === "merge" ? "mint" : overlay.purpose === "full" ? "lemon" : "berry"
    return (
      <Text {...toneProps(p, tone)} bold wrap="truncate-end">
        {" " + truncate(`${text}  y / n`, width - 2)}
      </Text>
    )
  }
  if (drag) {
    const note = view?.notes.find((n) => n.id === drag.note)
    const to = view?.columns.find((c) => c.id === drag.over)
    return (
      <Text {...toneProps(p, "cyan")} wrap="truncate-end">
        {" " + truncate(`Moving “${note?.title ?? ""}”${to ? ` → ${to.name}` : ""} — let go to drop`, width - 2)}
      </Text>
    )
  }
  if (toast)
    return (
      <Text {...toneProps(p, toast.tone)} wrap="truncate-end">
        {" " + truncate(toast.text, width - 2)}
      </Text>
    )
  return <Text> </Text>
}

function pickRows(
  o: Extract<Overlay, { kind: "pick" }>,
  width: number,
  height: number,
  p: Palette,
  metrics: { pickStart: number },
): ReactNode[] {
  const rows: ReactNode[] = [
    <Text key="pt" bold>
      {" " + o.title}
    </Text>,
    <Text key="pg"> </Text>,
  ]
  const room = Math.max(1, height - rows.length)
  const start = Math.max(0, Math.min(o.index - room + 1, o.items.length - room))
  metrics.pickStart = start
  o.items.slice(start, start + room).forEach((item, j) => {
    const i = start + j
    const sel = i === o.index
    rows.push(
      <Split
        key={`pi${i}`}
        width={width}
        p={p}
        left={[
          { text: sel ? " › " : "   ", tone: "mint", bold: true },
          { text: i < 9 ? `${i + 1} ` : "  ", tone: "dim" },
          { text: item.label, tone: "plain", bold: sel },
          { text: item.hint ? "  " + item.hint : "", tone: "dim" },
        ]}
        right={[]}
      />,
    )
  })
  return rows
}

function messageRows(lines: string[], width: number, p: Palette, tone: Tone = "plain"): ReactNode[] {
  return [
    <Text key="m-gap"> </Text>,
    ...lines.map((l, i) => (
      <Text key={`m${i}`} {...toneProps(p, i === 0 ? tone : "dim")} wrap="truncate-end">
        {"  " + truncate(l, width - 4)}
      </Text>
    )),
  ]
}
