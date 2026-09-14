import { useCallback, useMemo, useState } from "react"
import { ChevronRight } from "lucide-react"
import type { ActivityFrame, BoardView, Note, PermissionPrompt } from "@kandy/core"
import { Button, Confirm, Empty, Kbd } from "@/ui"
import { Logo } from "@/brand/Logo"
import { GROUPS, LOOK } from "@/features/notes/status"
import { cn } from "@/lib/utils"
import { NoteRow } from "./NoteRow"

/**
 * The list, grouped by what you should deal with first.
 *
 * Sorted by urgency rather than by column, because status here is machine
 * state — a note arrives in "running" because a process started, not because
 * someone dragged it. A kanban board asks you to read five columns to find the
 * one thing that is waiting on you; this puts it at the top.
 */
export function TriageList({
  view,
  activity,
  selectedId,
  onSelect,
  onCompose,
  onDelete,
}: {
  view: BoardView
  activity: Record<string, ActivityFrame>
  selectedId: string | null
  onSelect: (id: string) => void
  onCompose: () => void
  onDelete: (id: string) => void
}) {
  // Done is collapsed to start: eight finished notes should not take as much
  // room as the one thing waiting on you.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set(["done"]))

  /* One dialog for the whole list rather than one per row: a Confirm inside
     NoteRow would mount a Dialog for every note on the board, and NoteRow is
     memoised precisely because this list repaints on every streamed event. */
  const [pending, setPending] = useState<Note | null>(null)
  const [busy, setBusy] = useState(false)

  /* Stable identity, or every row's memo() breaks on each render. */
  const requestDelete = useCallback((note: Note) => setPending(note), [])

  const groups = useMemo(() => {
    return GROUPS.map((g) => ({
      ...g,
      notes: view.notes
        .filter((n) => g.statuses.includes(n.status))
        .sort(byUrgencyThenRecency),
    })).filter((g) => g.notes.length > 0)
  }, [view.notes])

  if (view.notes.length === 0) {
    return (
      <Empty
        className="pt-24"
        icon={<Logo size={40} />}
        title="Nothing on the board"
        body="A note is one job for one agent. Write what you want done — it runs in its own worktree, on its own branch, and comes back as a diff."
        action={
          <Button variant="default" size="default" onClick={onCompose}>
            Write the first note
          </Button>
        }
      />
    )
  }

  const open = view.notes.filter((n) => n.status !== "done").length

  return (
    <div className="mx-auto w-full max-w-[820px] px-4 pb-16 pt-4">
      {/* The primary action, shaped like the thing it makes. A dashed button at
          the bottom of a list is where you put something you hope nobody
          needs. */}
      <button
        onClick={onCompose}
        className="bg-card hover:border-grape/40 group mb-5 flex w-full items-center gap-3 rounded-2xl border px-4 py-3 text-left transition-colors"
      >
        <Logo size={17} className="opacity-80" />
        <span className="text-muted-foreground group-hover:text-foreground flex-1 text-[13.5px] transition-colors">
          What should the agent do?
        </span>
        <Kbd>C</Kbd>
      </button>

      {/* Above every group, including "Needs you". A blocked note was refused
          and carried on; these are agents standing still with a person in the
          loop, and nothing else on the board outranks that. */}
      {view.prompts.length > 0 && (
        <section className="mb-5">
          <h2 className="mb-2 px-3 text-[12px] font-semibold tracking-[-0.005em] text-lemon">
            Waiting for your answer
          </h2>
          <div className="space-y-1.5">
            {view.prompts.map((prompt) => (
              <Waiting
                key={prompt.requestId}
                prompt={prompt}
                title={view.notes.find((n) => n.id === prompt.noteId)?.title ?? "a note"}
                onSelect={onSelect}
              />
            ))}
          </div>
        </section>
      )}

      {open > 0 && (
        <p className="text-muted-foreground/60 mb-3 px-3 text-[11.5px]">
          {open} open · {view.notes.length - open} done
        </p>
      )}

      {groups.map((g) => {
        const open = !collapsed.has(g.key)
        return (
        <section key={g.key} className="mb-5">
          <button
            onClick={() =>
              setCollapsed((c) => {
                const next = new Set(c)
                next.has(g.key) ? next.delete(g.key) : next.add(g.key)
                return next
              })
            }
            className="bg-background/85 text-muted-foreground hover:text-foreground sticky top-0 z-10 flex w-full items-center gap-1.5 px-3 py-2 text-left backdrop-blur transition-colors"
          >
            <ChevronRight
              className={cn("size-3 transition-transform", open && "rotate-90")}
            />
            <h2 className="text-[12px] font-semibold tracking-[-0.005em]">{g.title}</h2>
            <span className="text-muted-foreground/60 text-[11px] tabular-nums">
              {g.notes.length}
            </span>
          </button>

          <div className={cn("space-y-0.5", !open && "hidden")}>
            {g.notes.map((note) => (
              <NoteRow
                key={note.id}
                note={note}
                run={view.runs.find((r) => r.id === note.runId)}
                activity={note.runId ? activity[note.runId] : undefined}
                selected={selectedId === note.id}
                statusImplied={g.statuses.length === 1}
                onSelect={onSelect}
                onRequestDelete={requestDelete}
              />
            ))}
          </div>
        </section>
        )
      })}

      <Confirm
        open={pending !== null}
        onOpenChange={(v) => !v && setPending(null)}
        title="Delete this note"
        body={
          <>
            Removes the note and its history from the board.
            {pending?.branch ? " Its branch is left in the repository." : ""} This cannot be undone.
          </>
        }
        facts={pending ? [{ label: "Note", value: pending.title }] : undefined}
        confirmLabel="Delete"
        destructive
        busy={busy}
        onConfirm={() => {
          if (!pending) return
          setBusy(true)
          onDelete(pending.id)
          setBusy(false)
          setPending(null)
        }}
      />
    </div>
  )
}

/**
 * One waiting question, on the board rather than buried in a note.
 *
 * It names the tool and shows the command, because "an agent needs permission"
 * is not enough to decide anything from. Answering happens in the note pane —
 * a decision with a message attached needs more room than a list row — so this
 * opens it.
 */
function Waiting({
  prompt,
  title,
  onSelect,
}: {
  prompt: PermissionPrompt
  title: string
  onSelect: (id: string) => void
}) {
  return (
    <button
      data-note={prompt.noteId}
      onClick={() => onSelect(prompt.noteId)}
      className="flex w-full items-start gap-3 rounded-2xl border border-[#4a3a20] bg-[#1c180f] px-4 py-3 text-left transition-colors hover:border-lemon/50"
    >
      <span className="mt-1.5 h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-lemon" />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="truncate text-[13px] text-ink">{title}</span>
          <span className="shrink-0 text-[11px] text-lemon">{prompt.tool}</span>
        </span>
        <span className="mt-1 block truncate font-mono text-[11.5px] text-[#b9a06a]" title={prompt.command}>
          {prompt.command}
        </span>
      </span>
      <span className="shrink-0 self-center text-[11.5px] text-lemon">Answer</span>
    </button>
  )
}

/** Most urgent first; within a group, most recently touched first. */
function byUrgencyThenRecency(a: Note, b: Note): number {
  const d = LOOK[a.status].urgency - LOOK[b.status].urgency
  return d !== 0 ? d : b.updatedAt - a.updatedAt
}
