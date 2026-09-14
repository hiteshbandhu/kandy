import { daemonToken } from "@/lib/daemon-token"
import { cn } from "@/lib/utils"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { KandyClient } from "@kandy/client"
import { usePanelRef } from "react-resizable-panels"
import type { AgentId, AgentInfo, Board, Forge } from "@kandy/core"
import {
  Button,
  Empty,
  LoadingBlock,
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/ui"
import { Backdrop } from "@/brand/Backdrop"
import { Logo } from "@/brand/Logo"
import { Composer } from "@/features/notes/Composer"
import { NewBoardDialog } from "@/features/boards/NewBoardDialog"
import { useBoard } from "@/hooks/useBoard"
import { useTheme } from "@/hooks/useTheme"
import { useRoute } from "@/hooks/useRoute"
import { TooltipProvider } from "@/ui"
import { CommandPalette } from "./CommandPalette"
import { SettingsPage } from "./SettingsPage"
import { UsagePage } from "./UsagePage"
import { NoteDetail } from "./NoteDetail"
import { Sidebar, type View } from "./Sidebar"
import { TriageList } from "./TriageList"

const DETAIL_SIZE_KEY = "kandy.detail-size"

function readDetailSize(): number {
  try {
    const n = Number(localStorage.getItem(DETAIL_SIZE_KEY))
    return Number.isFinite(n) && n >= 22 && n <= 78 ? n : 34
  } catch {
    return 34
  }
}

export function App() {
  const client = useMemo(() => new KandyClient({ baseUrl: "/api", token: daemonToken }), [])
  const [boards, setBoards] = useState<Board[]>([])
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [forge, setForge] = useState<Forge | null>(null)

  const [composing, setComposing] = useState(false)
  const [newBoard, setNewBoard] = useState(false)
  const [palette, setPalette] = useState(false)
  /**
   * A file the daemon would not take.
   *
   * The composer applies the same rule before uploading, so this is the
   * backstop — but a refusal must be said out loud wherever it happens, since a
   * screenshot that never arrives looks exactly like an agent ignoring it.
   */
  const [notice, setNotice] = useState<string | null>(null)
  const { theme, setTheme } = useTheme()

  /*
   * Where you are lives in the URL rather than in three useStates, so a
   * refresh — or a link pasted to yourself — lands back on the same note.
   *
   * These keep the setter shapes the rest of the component already uses,
   * including the updater-function forms, so the change is where the state is
   * kept and not how every call site talks to it.
   */
  /*
   * How wide you like the detail pane, kept across sessions.
   *
   * The library's own layout persistence cannot do this here: the pane
   * collapses when you close a note, and it saves that collapsed layout, so
   * reopening later restored 0 and fell back to the minimum. Storing only
   * expanded sizes keeps "wide enough for a diff" meaning what it did before.
   *
   * Sizes are strings because v4 reads a bare number as *pixels* and only a
   * string as a percentage — passing 62 asks for 62px, not 62%.
   */
  const detailPanel = usePanelRef()
  const detailSize = useRef(readDetailSize())
  const rememberDetailSize = useCallback((pct: number) => {
    if (pct < 1) return // A collapse is not a width.
    detailSize.current = pct
    try {
      localStorage.setItem(DETAIL_SIZE_KEY, String(pct))
    } catch {
      // Blocked storage just means it lasts the session.
    }
  }, [])

  const { route, go } = useRoute()
  const { page, boardId, noteId: selected } = route

  type Update<T> = T | ((cur: T) => T)
  const apply = <T,>(v: Update<T>, cur: T): T =>
    typeof v === "function" ? (v as (c: T) => T)(cur) : v

  /*
   * Moving *away* closes the open note; re-affirming where you already are
   * does not. The difference matters on boot: resolving the default board
   * fires setBoardId with the board the URL already named, and clearing the
   * note unconditionally there threw away the deep link on every refresh —
   * which is the entire thing this is for.
   */
  const setPage = useCallback(
    (v: Update<View>) =>
      go((cur) => {
        const page = apply(v, cur.page)
        return { ...cur, page, noteId: page === cur.page ? cur.noteId : null }
      }),
    [go],
  )
  const setSelected = useCallback(
    (v: Update<string | null>) => go((cur) => ({ ...cur, noteId: apply(v, cur.noteId) })),
    [go],
  )
  const setBoardId = useCallback(
    (v: Update<string | null>, replace = false) =>
      go((cur) => {
        const boardId = apply(v, cur.boardId)
        return { ...cur, boardId, noteId: boardId === cur.boardId ? cur.noteId : null }
      }, { replace }),
    [go],
  )

  const { view, connected, error, act, transcript, activity, loadTranscript, clearError } =
    useBoard(boardId)

  useEffect(() => {
    void client.boards().then((r) => {
      setBoards(r.boards)
      setBoardId((id) => id ?? r.boards[0]?.id ?? null, true)
    })
    void client.agents().then((r) => setAgents(r.agents))
  }, [client])

  useEffect(() => {
    setForge(null)
    if (!boardId) return
    void client.forge(boardId).then(setForge).catch(() => setForge(null))
  }, [boardId, client])

  const note = view?.notes.find((n) => n.id === selected) ?? null
  const defaultAgent = agents.find((a) => a.installed && a.authed)?.id ?? null

  useEffect(() => {
    if (note?.runId) void loadTranscript(note.runId)
  }, [note?.runId, loadTranscript])

  // Open and close the pane with the note, keeping whatever width it was
  // dragged to — collapse/expand restores the last size, a resize would not.
  useEffect(() => {
    const panel = detailPanel.current
    if (!panel) return
    // resize() rather than expand(): expand restores whatever the library last
    // saw, which after a reload is nothing.
    if (note) panel.resize(String(detailSize.current))
    else panel.collapse()
  }, [note, detailPanel])

  /** Ordered exactly as the list renders, so j/k match what the eye does. */
  const ordered = useMemo(() => view?.notes.map((n) => n.id) ?? [], [view])

  const move = useCallback(
    (delta: number) => {
      const rows = [...document.querySelectorAll<HTMLElement>("[data-note]")]
      const ids = rows.map((r) => r.dataset["note"]!)
      if (ids.length === 0) return
      const i = selected ? ids.indexOf(selected) : -1
      const next = ids[Math.max(0, Math.min(ids.length - 1, i + delta))]
      if (next) {
        setSelected(next)
        document.querySelector(`[data-note="${next}"]`)?.scrollIntoView({ block: "nearest" })
      }
    },
    [selected],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing =
        e.target instanceof HTMLElement &&
        (e.target.tagName === "INPUT" ||
          e.target.tagName === "TEXTAREA" ||
          e.target.isContentEditable)

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault()
        setPalette((p) => !p)
        return
      }
      if (typing) return

      if (e.key === "Escape") {
        if (composing) setComposing(false)
        else if (selected) setSelected(null)
      }
      if (e.key === "j") move(1)
      if (e.key === "k") move(-1)
      if (e.key === "c") {
        e.preventDefault()
        setComposing(true)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [composing, selected, move, ordered])

  async function refreshBoards(nextId?: string) {
    const r = await client.boards()
    setBoards(r.boards)
    // Fall through to whatever is left, so removing the open board doesn't
    // leave the app staring at nothing.
    setBoardId(
      (cur) => nextId ?? (r.boards.some((b) => b.id === cur) ? cur : (r.boards[0]?.id ?? null)),
      true,
    )
  }

  return (
    <TooltipProvider delayDuration={250}>
    <div className="flex h-full">
      <Backdrop />

      <Sidebar
        boards={boards}
        boardId={boardId}
        view={view}
        agents={agents}
        connected={connected}
        page={page}
        theme={theme}
        onPage={setPage}
        onTheme={setTheme}
        onBoardChange={(id) => {
          setBoardId(id)
          setSelected(null)
        }}
        onNewBoard={() => setNewBoard(true)}
        onNewNote={() => {
          if (!boardId) return void setNewBoard(true)
          setPage("board")
          setComposing(true)
        }}
      />

      {/*
        The board and the open note split the space, with a handle between
        them. Two hard-coded widths could not be right for both a one-line
        status check and a thousand-line diff, and the size is remembered per
        person rather than decided here.
      */}
      <ResizablePanelGroup
        orientation="horizontal"
        className="min-w-0 flex-1"
      >
        <ResizablePanel id="board" minSize="28">
          <main className="flex h-full min-w-0 flex-col">
        {(error ?? notice) && (
          <button
            onClick={() => {
              clearError()
              setNotice(null)
            }}
            className="shrink-0 border-b border-[#4a2b38] bg-[#241419] px-4 py-2.5 text-left text-[12px] text-[#efb9cb]"
          >
            {error ?? notice} <span className="ml-2 text-faint">dismiss</span>
          </button>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {page === "usage" ? (
            <UsagePage view={view} />
          ) : page === "settings" ? (
            <SettingsPage
              view={view}
              agents={agents}
              client={client}
              theme={theme}
              onTheme={setTheme}
              onSaved={() => void refreshBoards()}
              onRemoved={() => {
                setPage("board")
                setSelected(null)
                setBoardId(null)
                void refreshBoards()
              }}
            />
          ) : view ? (
            <TriageList
              view={view}
              activity={activity}
              selectedId={selected}
              onSelect={setSelected}
              onCompose={() => setComposing(true)}
              onDelete={(id) => {
                // Close the detail pane if it is showing the note being removed.
                setSelected((cur) => (cur === id ? null : cur))
                void act((c) => c.deleteNote(id))
              }}
            />
          ) : boards.length === 0 ? (
            <Empty
              className="pt-[18vh]"
              icon={<Logo size={44} />}
              title="Point kandy at a repository"
              body="Every note you write becomes one job for one agent — run in its own worktree, on its own branch, so several can work at once without colliding."
              action={
                <Button variant="default" size="default" onClick={() => setNewBoard(true)}>
                  Choose a repo
                </Button>
              }
            />
          ) : (
            <LoadingBlock className="pt-24" label="Opening the board" />
          )}
        </div>
          </main>
        </ResizablePanel>

        {/*
          The detail pane stays mounted and collapses, rather than unmounting
          with its note.

          A panel that comes and goes changes the group's shape, and the group
          saves its layout by shape: on reload the board mounts alone, that
          one-panel layout is written over the two-panel one, and the pane you
          had dragged wider comes back at its default. Collapsing keeps the
          shape — and the remembered width — stable.
        */}
        <ResizableHandle withHandle className={cn(!note && "hidden")} />
        <ResizablePanel
          id="detail"
          panelRef={detailPanel}
          collapsible
          collapsedSize="0"
          defaultSize={String(detailSize.current)}
          onResize={(size) => rememberDetailSize(size.asPercentage)}
          minSize="22"
          maxSize="78"
        >
          {note && view && (
            <NoteDetail
          onWiden={(wide) => detailPanel.current?.resize(wide ? "62" : "34")}
          note={note}
          view={view}
          agents={agents}
          frames={note.runId ? (transcript[note.runId] ?? []) : []}
          activity={note.runId ? activity[note.runId] : undefined}
          forge={forge}
          prompts={view.prompts.filter((q) => q.noteId === note.id)}
          onClose={() => setSelected(null)}
          onRun={(agent) => void act((c) => c.runNote(note.id, agent))}
          onCancel={(runId) => void act((c) => c.cancelRun(runId))}
          onAssign={(agent) => void act((c) => c.assignNote(note.id, agent))}
          onPolicy={(policy) => void act((c) => c.setPolicy(note.id, policy))}
          onModel={(model) => void act((c) => c.setModel(note.id, model))}
          onEdit={async (patch) => (await act((c) => c.editNote(note.id, patch))) !== undefined}
          onSteer={async (text, files) => {
            const sent = await act((c) =>
              c.message(
                note.id,
                text,
                files?.map((f) => ({ name: f.name, data: f.data })),
              ),
            )
            if (sent?.rejected?.length) setNotice(sent.rejected.map((r) => r.reason).join("; "))
            return sent?.delivery
          }}
          loadStaged={async () => (await act((c) => c.attachments(note.id)))?.attachments ?? []}
          onUnstage={async (name) =>
            (await act((c) => c.unattach(note.id, name)))?.attachments ?? []
          }
          onReview={(decision) => void act((c) => c.reviewNote(note.id, decision))}
          onAnswer={async (prompt, answer) => {
            const res = await act((c) =>
              c.respond(prompt.runId, prompt.requestId, answer.decision, {
                ...(answer.scope ? { scope: answer.scope } : {}),
                ...(answer.comment ? { comment: answer.comment } : {}),
              }),
            )
            // The prompt is gone either way — the stream will drop it. Only an
            // answer that arrived too late needs saying out loud, since the
            // card vanishing would otherwise read as "done".
            if (res && !res.answered) {
              setNotice("That question was already answered or had timed out.")
            }
          }}
          onEscalate={async () => {
            await act((c) => c.escalateNote(note.id))
          }}
          onOpenPr={async () => {
            await act((c) => c.openPr(note.id))
          }}
          onDelete={() => {
            setSelected(null)
            void act((c) => c.deleteNote(note.id))
          }}
          loadDiff={() => act((c) => c.diff(note.id))}
        />
          )}
        </ResizablePanel>
      </ResizablePanelGroup>

      {composing && view && (
        <Composer
          agents={agents}
          defaultAgent={defaultAgent}
          onCancel={() => setComposing(false)}
          onCreate={async (title, body, agent, model, run, files) => {
            setComposing(false)
            const column = view.columns[0]?.id
            if (!column) return
            // The files travel with the note. They have nowhere else to be —
            // the worktree that will hold them does not exist until it runs.
            const created = await act((c) =>
              c.createNote(
                view.board.id,
                column,
                title,
                body,
                files.map((f) => ({ name: f.name, data: f.data })),
              ),
            )
            if (!created) return
            if (created.rejected?.length) setNotice(created.rejected.map((r) => r.reason).join("; "))
            if (agent) await act((c) => c.assignNote(created.noteId, agent))
            if (model) await act((c) => c.setModel(created.noteId, model))
            if (run && agent) await act((c) => c.runNote(created.noteId, agent))
            setSelected(created.noteId)
          }}
        />
      )}

      <NewBoardDialog
        open={newBoard}
        onOpenChange={setNewBoard}
        client={client}
        onCreated={(id) => void refreshBoards(id)}
      />

      <CommandPalette
        open={palette}
        onClose={() => setPalette(false)}
        view={view}
        boards={boards}
        agents={agents}
        onSelectNote={setSelected}
        onCompose={() => setComposing(true)}
        onNewBoard={() => setNewBoard(true)}
        onBoardChange={(id) => {
          setBoardId(id)
          setSelected(null)
        }}
        onRunNote={(noteId, agent) => {
          setSelected(noteId)
          void act(async (c) => {
            await c.assignNote(noteId, agent)
            return c.runNote(noteId, agent)
          })
        }}
      />
    </div>
    </TooltipProvider>
  )
}
