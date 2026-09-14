import { useEffect, useState } from "react"
import type {
  ActivityFrame,
  AgentId,
  AgentInfo,
  BoardView,
  Forge,
  Note,
  PermissionPrompt,
  Policy,
  StagedFile,
  TranscriptFrame,
} from "@kandy/core"
import { canAsk } from "@kandy/core"
import { Maximize2, Minimize2, Paperclip, X } from "lucide-react"
import { ActivityLine, Button, Confirm, Hint, LoadingBlock, StatusPill, Textarea } from "@/ui"
import { AgentMark, agentLabel } from "@/features/agents/AgentMark"
import { AgentSelect } from "@/features/agents/AgentSelect"
import { ModelSelect } from "@/features/agents/ModelSelect"
import { DiffView } from "@/features/diff/DiffView"
import { Ask, type Answer } from "@/features/notes/Ask"
import { Attachments, type Attached } from "@/features/notes/Attachments"
import { InlineEdit } from "@/features/notes/InlineEdit"
import { PrBadge } from "@/features/notes/PrBadge"
import { LOOK } from "@/features/notes/status"
import { Transcript } from "@/features/stream/Transcript"
import { cn, compact, cost, duration } from "@/lib/utils"
import { useTick } from "@/hooks/useTick"

export type NoteDetailProps = {
  note: Note
  view: BoardView
  agents: AgentInfo[]
  frames: TranscriptFrame[]
  activity: ActivityFrame | undefined
  forge: Forge | null
  /** Questions this note's agent is standing still waiting for. Usually empty. */
  prompts: PermissionPrompt[]
  onClose: () => void
  onRun: (agent?: AgentId) => void
  onCancel: (runId: string) => void
  onAssign: (agent: AgentId) => void
  onPolicy: (policy: Policy) => void
  onModel: (model: string | null) => void
  onEdit: (patch: { title?: string; body?: string }) => Promise<boolean>
  onSteer: (text: string, files?: Attached[]) => Promise<"live" | "queued" | undefined>
  /** Files held for this note until it has a worktree to put them in. */
  loadStaged: () => Promise<StagedFile[]>
  onUnstage: (name: string) => Promise<StagedFile[]>
  onReview: (decision: "merge" | "discard") => void
  /** Answer one waiting question. */
  onAnswer: (prompt: PermissionPrompt, answer: Answer) => Promise<void>
  /** Ask the surrounding pane for more or less room. */
  onWiden?: (wide: boolean) => void
  /** Raise this note to full access and continue it. */
  onEscalate: () => Promise<void>
  onOpenPr: () => Promise<void>
  onDelete: () => void
  loadDiff: () => Promise<
    { diff: string; capturedAt: number | null; baseBranch: string | null } | undefined
  >
}

/**
 * Everything about one note.
 *
 * A pane beside the list by default, because reading a stream while scanning
 * what else is waiting is the normal motion. Full screen puts the stream and
 * the diff side by side, which is the review motion — what the agent said it
 * did, next to what it actually did.
 */
export function NoteDetail(p: NoteDetailProps) {
  const [tab, setTab] = useState<"stream" | "diff">("stream")
  const [diff, setDiff] = useState<{
    text: string
    capturedAt: number | null
    baseBranch: string | null
  } | null>(null)
  const [draft, setDraft] = useState("")
  const [sending, setSending] = useState(false)
  const [delivery, setDelivery] = useState<string | null>(null)
  const [pring, setPring] = useState(false)
  const [files, setFiles] = useState<Attached[]>([])
  const [staged, setStaged] = useState<StagedFile[]>([])
  const [full, setFull] = useState(false)
  const [ask, setAsk] = useState<null | "merge" | "pr" | "discard" | "delete" | "escalate">(null)
  const [busy, setBusy] = useState(false)

  const run = p.view.runs.find((r) => r.id === p.note.runId)
  const live = p.note.status === "running" || p.note.status === "blocked"
  const policy = p.note.policy ?? "repo"

  // What this note was actually refused. The transcript already carries it —
  // the adapter writes each denial as a system frame tagged `permission` — so
  // the answer to "why did this stop" is here rather than somewhere the user
  // has to go hunting for it.
  const refused = p.frames.filter((f) => f.meta === "permission")
  // An agent that cannot be asked is a different situation from one that
  // hasn't been asked yet, and the pane should not imply otherwise.
  const askable = canAsk(p.note.agent)
  const canEscalate = refused.length > 0 && policy !== "full" && p.note.status !== "queued"
  const reviewable = p.note.status === "review"
  const look = LOOK[p.note.status]
  const split = full && Boolean(p.note.branch)
  useTick(live)

  useEffect(() => {
    // Keep whatever we already have on screen while the next one loads:
    // clearing first made the panel blink white on every tab switch.
    let stale = false
    if (tab === "diff" || split) {
      void p.loadDiff().then((d) => {
        if (!stale && d)
          setDiff({ text: d.diff, capturedAt: d.capturedAt, baseBranch: d.baseBranch })
      })
    }
    return () => {
      stale = true
    }
  }, [tab, split, p.note.id])

  // A different note's diff must not be shown under this note's title.
  useEffect(() => {
    setDiff(null)
  }, [p.note.id])

  // Staged files live on the daemon, not in this component's state, which is
  // the whole point: they are still here after a reload. Re-read them whenever
  // the note changes or a run starts, since starting one moves them out.
  useEffect(() => {
    let stale = false
    setStaged([])
    void p.loadStaged().then((s) => !stale && setStaged(s))
    return () => {
      stale = true
    }
  }, [p.note.id, p.note.runId])

  useEffect(() => {
    if (reviewable) setTab("diff")
  }, [reviewable])

  // What each confirmation needs to state about this particular note.
  const base = diff?.baseBranch ?? p.forge?.defaultBranch ?? "the base branch"
  const facts = [
    ...(p.note.branch ? [{ label: "Branch", value: p.note.branch }] : []),
    ...(p.note.stat
      ? [
          {
            label: "Changes",
            value: (
              <>
                <span className="text-mint">+{p.note.stat.insertions}</span>{" "}
                <span className="text-berry">−{p.note.stat.deletions}</span>
                <span className="text-muted-foreground">
                  {" "}
                  in {p.note.stat.files} file{p.note.stat.files === 1 ? "" : "s"}
                </span>
              </>
            ),
          },
        ]
      : []),
    ...(p.note.pr ? [{ label: "Pull request", value: `#${p.note.pr.number}` }] : []),
  ]

  async function confirmAction(action: () => void | Promise<void>) {
    setBusy(true)
    try {
      await action()
      setAsk(null)
    } finally {
      setBusy(false)
    }
  }

  async function send() {
    const text = draft.trim()
    if ((!text && files.length === 0) || sending) return
    setSending(true)
    const how = await p.onSteer(text, files)
    setSending(false)
    if (how) {
      setDraft("")
      setFiles([])
      setDelivery(how === "live" ? "sent to the running agent" : "queued as a follow-up")
      setTimeout(() => setDelivery(null), 4000)
    }
  }

  const body = (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="px-4 pb-3.5 pt-4">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill tone={look.tone} pulse={p.note.status === "running"}>
                {look.label}
              </StatusPill>
              {p.note.agent && (
                <span className="flex items-center gap-1.5 text-[11.5px] text-dim">
                  <AgentMark agent={p.note.agent} size={12} />
                  {agentLabel(p.note.agent)}
                </span>
              )}
            </div>

            <h2 className="mt-2.5 text-[16px] font-medium leading-snug tracking-[-0.015em]">
              <InlineEdit
                key={p.note.id}
                value={p.note.title}
                label="Edit title"
                required
                rows={2}
                onSave={(title) => p.onEdit({ title })}
              />
            </h2>
          </div>

          <div className="-mr-1.5 -mt-1 flex shrink-0 items-center">
            <Hint text={full ? "Narrow" : "Widen — stream beside diff"}>
              <Button
                variant="ghost"
                size="icon"
                onClick={() =>
                  setFull((f) => {
                    // The split needs the room to be worth anything, so the
                    // button asks for it. Dragging afterwards still wins.
                    p.onWiden?.(!f)
                    return !f
                  })
                }
              >
                {full ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
              </Button>
            </Hint>
            <Button variant="ghost" size="icon" onClick={p.onClose} aria-label="Close">
              <X className="size-3.5" />
            </Button>
          </div>
        </div>

        {run && (
          <div className="mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11.5px] text-dim">
            <span className={cn("tabular-nums", live && "text-lemon")}>
              {duration(run.startedAt, run.endedAt)}
            </span>
            {run.model && (
              <>
                <Sep />
                <span className="font-mono text-[11px]">{run.model}</span>
              </>
            )}
            {run.turns !== null && <><Sep /><span className="tabular-nums">{run.turns} turns</span></>}
            {run.tokens !== null && <><Sep /><span className="tabular-nums">{compact(run.tokens)} tok</span></>}
            {run.costUsd !== null ? (
              <>
                <Sep />
                <Hint
                  text={
                    run.costSource === "estimated"
                      ? `Estimated from ${run.tokens?.toLocaleString() ?? "?"} tokens${run.model ? ` at ${run.model} rates` : ""} — this agent reports no cost.`
                      : "Reported by the agent."
                  }
                >
                  <span className="tabular-nums">{cost(run.costUsd, run.costSource)}</span>
                </Hint>
              </>
            ) : run.tokens !== null ? (
              <>
                <Sep />
                <Hint text={`No price for ${run.model ?? "this model"}, so the cost is unknown.`}>
                  <span className="text-faint">unpriced</span>
                </Hint>
              </>
            ) : null}
          </div>
        )}

        {p.note.branch && (
          <div className="mt-2.5 flex items-center gap-2.5">
            <span className="min-w-0 truncate font-mono text-[11px] text-faint" title={p.note.branch}>
              {p.note.branch}
            </span>
            {p.note.pr && <PrBadge pr={p.note.pr} onDark />}
            {p.note.stat && (
              <span className="ml-auto shrink-0 text-[11px] tabular-nums">
                <span className="text-mint">+{p.note.stat.insertions}</span>{" "}
                <span className="text-berry">−{p.note.stat.deletions}</span>
              </span>
            )}
          </div>
        )}

        <div className="mt-3.5 flex flex-wrap items-center gap-2">
          <AgentSelect
            value={p.note.agent}
            agents={p.agents}
            onChange={p.onAssign}
            className="w-[150px]"
          />

          <ModelSelect
            agent={p.note.agent}
            value={p.note.model}
            onChange={p.onModel}
            placeholder={
              p.note.agent && p.view.board.models?.[p.note.agent]
                ? `${p.view.board.models[p.note.agent]} (repo)`
                : "Agent default"
            }
            className="w-[190px]"
          />

          <PolicyToggle value={policy} onChange={p.onPolicy} disabled={live} askable={askable} />

          {!live && !reviewable && (
            <Button variant="default" onClick={() => p.onRun()} disabled={!p.note.agent}>
              {p.note.status === "failed" ? "Retry" : "Run"}
            </Button>
          )}
          {live && run && (
            <Button onClick={() => p.onCancel(run.id)}>Stop</Button>
          )}
          {/* Where this work can go: two destinations and a bin, so "merge"
              never has to mean two different things. Each asks first, and the
              question says what will actually happen to this branch. */}
          {reviewable && (
            <>
              <Button size="sm" onClick={() => setAsk("merge")}>
                Merge here
              </Button>
              {p.forge?.available && !p.note.pr && (
                <Button variant="outline" size="sm" onClick={() => setAsk("pr")} disabled={pring}>
                  {pring ? "Opening…" : "Open a PR"}
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                className="text-berry"
                onClick={() => setAsk("discard")}
              >
                Discard
              </Button>
            </>
          )}
        </div>
      </header>

      {/* Above everything, including the refusals: a question with someone
          waiting behind it outranks a list of things already refused. */}
      {p.prompts.map((prompt) => (
        <Ask
          key={prompt.requestId}
          prompt={prompt}
          onAnswer={(answer) => p.onAnswer(prompt, answer)}
        />
      ))}

      {canEscalate && (
        <Refused frames={refused} askable={askable} onAsk={() => setAsk("escalate")} />
      )}

      {!split && (
        <nav className="flex items-center gap-1 border-y border-hairline px-4 py-1.5">
          {(["stream", "diff"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn(
                "rounded-lg px-2.5 py-1.5 text-[12.5px] capitalize transition-colors",
                tab === t ? "bg-raised text-ink" : "text-dim hover:text-ink",
              )}
            >
              {t}
              {t === "diff" && p.note.stat && p.note.stat.files > 0 && (
                <span className="ml-1.5 text-[11px] tabular-nums text-faint">{p.note.stat.files}</span>
              )}
            </button>
          ))}
          <button
            onClick={() => setAsk("delete")}
            className="ml-auto rounded-lg px-2.5 py-1.5 text-[11.5px] text-faint transition-colors hover:bg-[#241419] hover:text-berry"
          >
            Delete
          </button>
        </nav>
      )}

      {staged.length > 0 && (
        <div className="border-t border-hairline px-4 py-2.5">
          <p className="text-faint mb-1.5 text-[11px]">
            Waiting for a workspace — handed to the agent when this note runs.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {staged.map((f) => (
              <span
                key={f.name}
                className="bg-muted flex items-center gap-1.5 rounded-md py-1 pr-1 pl-2 text-[11.5px]"
              >
                <Paperclip className="size-3 opacity-60" />
                <span className="max-w-[160px] truncate">{f.name}</span>
                <span className="text-muted-foreground/70 tabular-nums">
                  {Math.ceil(f.bytes / 1024)}KB
                </span>
                <button
                  onClick={() => void p.onUnstage(f.name).then(setStaged)}
                  aria-label={`Remove ${f.name}`}
                  className="hover:bg-background rounded p-0.5"
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
          </div>
        </div>
      )}

      <div className={cn("flex min-h-0 flex-1", split && "border-t border-hairline")}>
        {(tab === "stream" || split) && (
          <div className={cn("flex min-w-0 flex-col", split ? "flex-1 border-r border-hairline" : "flex-1")}>
            <Transcript
              key={p.note.id}
              frames={p.frames}
              prompt={p.note.body}
              onEditPrompt={(b) => p.onEdit({ body: b })}
            />
          </div>
        )}
        {(tab === "diff" || split) && (
          <div className={cn("flex min-w-0 flex-col", split ? "flex-[1.25]" : "flex-1")}>
            {diff === null ? (
              <LoadingBlock label="Reading the diff" />
            ) : (
              <DiffView diff={diff.text} capturedAt={diff.capturedAt} />
            )}
          </div>
        )}
      </div>

      {live && p.activity && (
        <div className="border-t border-hairline bg-[#1c180f] px-4 py-2.5">
          <div className="flex items-baseline gap-2.5">
            <span className="shrink-0 text-[11px] font-medium uppercase tracking-[0.06em] text-lemon">
              {p.activity.tool}
            </span>
            <span className="truncate font-mono text-[11.5px] text-[#b9a06a]" title={p.activity.detail}>
              {p.activity.detail}
            </span>
          </div>
          <ActivityLine className="mt-1.5" />
        </div>
      )}

      <div className="border-t p-3">
        <Attachments files={files} onChange={setFiles}>
          {({ onPaste }) => (
            <Textarea
              rows={2}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onPaste={onPaste}
              placeholder={
                live ? "Steer the agent — paste or drop files too" : "Say what to change, then send"
              }
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send()
                e.stopPropagation()
              }}
            />
          )}
        </Attachments>
        <div className="mt-1 flex items-center gap-2">
          <Button
            size="sm"
            onClick={() => void send()}
            disabled={(!draft.trim() && files.length === 0) || sending}
          >
            Send
          </Button>
          <span className="text-muted-foreground/70 text-[11px]">
            {delivery ?? "⌘↵ to send"}
          </span>
        </div>
      </div>
    </div>
  )

  // Never an overlay. Covering the sidebar to read a diff means losing the one
  // thing the app is for — seeing what else is waiting on you. It is a resizable
  // pane rather than two fixed widths: how much room a diff needs is a property
  // of the diff, not something this component can know.
  return (
    <aside className="bg-card flex h-full w-full flex-col border-l">
      {body}

      <Confirm
        open={ask === "merge"}
        onOpenChange={(v) => !v && setAsk(null)}
        title="Merge here"
        body={
          <>
            Merges this note's branch into <b>{base}</b> on this machine. Nothing is pushed. The
            branch and its worktree are removed afterwards; your own working tree is not touched.
          </>
        }
        facts={facts}
        confirmLabel="Merge"
        busy={busy}
        onConfirm={() => confirmAction(() => p.onReview("merge"))}
      />

      <Confirm
        open={ask === "pr"}
        onOpenChange={(v) => !v && setAsk(null)}
        title="Open a pull request"
        body={
          <>
            Pushes this branch to <b>{p.forge?.repo ?? "the remote"}</b> and opens a PR against{" "}
            <b>{p.forge?.defaultBranch ?? base}</b>. This is the first thing kandy does that leaves
            your machine. The note lands here automatically once the PR is merged.
          </>
        }
        facts={facts}
        confirmLabel="Push and open PR"
        busy={busy || pring}
        onConfirm={() =>
          confirmAction(async () => {
            setPring(true)
            await p.onOpenPr()
            setPring(false)
          })
        }
      />

      <Confirm
        open={ask === "discard"}
        onOpenChange={(v) => !v && setAsk(null)}
        title="Discard this work"
        body={
          <>
            Deletes the branch and its worktree. Everything the agent wrote is lost, and this
            cannot be undone. The note stays, so you can run it again.
          </>
        }
        facts={facts}
        confirmLabel="Discard"
        destructive
        busy={busy}
        onConfirm={() => confirmAction(() => p.onReview("discard"))}
      />

      <Confirm
        open={ask === "escalate"}
        onOpenChange={(v) => !v && setAsk(null)}
        title="Give this note full access"
        body={
          <>
            This note's agent will be able to run <b>any shell command</b>, with no approval — the
            build and the tests it was refused, and equally anything else a shell can do. Its
            worktree bounds what it can damage <i>inside</i> this repository. It does not bound what
            it can reach outside one: your home directory, your credentials, the network.
            <br />
            <br />
            It then continues where it left off, in the same worktree, resuming the same session.
            Only this note changes — the repo's default is not touched.
          </>
        }
        facts={[
          { label: "Repo", value: p.view.board.repoPath },
          { label: "Agent", value: p.note.agent ? agentLabel(p.note.agent) : "none assigned" },
          {
            label: "Refused",
            value: `${refused.length} command${refused.length === 1 ? "" : "s"}`,
          },
        ]}
        confirmLabel="Grant full access and continue"
        busy={busy}
        onConfirm={() => confirmAction(p.onEscalate)}
      />

      <Confirm
        open={ask === "delete"}
        onOpenChange={(v) => !v && setAsk(null)}
        title="Delete this note"
        body={
          <>
            Removes the note and its history from the board.
            {p.note.branch ? " Its branch is left in the repository." : ""} This cannot be undone.
          </>
        }
        facts={[{ label: "Note", value: p.note.title }]}
        confirmLabel="Delete"
        destructive
        busy={busy}
        onConfirm={() => confirmAction(p.onDelete)}
      />
    </aside>
  )
}

function Sep() {
  return <span className="text-muted-foreground/60">·</span>
}

/**
 * What this note was refused, and the one thing you can do about it.
 *
 * Repo-only means the agent can write a test and then be refused the command
 * that runs it — so the run ends having verified nothing. Without this the
 * only evidence is a line buried in the stream, and the only cure was editing
 * the policy and starting over. Here it is the first thing you see, with the
 * exact commands, and one button that answers it.
 */
function Refused({
  frames,
  askable,
  onAsk,
}: {
  frames: TranscriptFrame[]
  /** Whether this agent could have been asked, rather than just refused. */
  askable: boolean
  onAsk: () => void
}) {
  // The last few, newest first: a long run can be refused the same command
  // twenty times, and twenty identical rows say nothing the first three don't.
  const shown = [...frames].reverse().slice(0, 3)
  const more = frames.length - shown.length

  return (
    <div className="border-y border-[#3d2621] bg-[#1a1211] px-4 py-3">
      <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-berry">
        <span className="h-1.5 w-1.5 rounded-full bg-berry" />
        Refused — repo only
      </div>

      <ul className="mt-2 space-y-1">
        {shown.map((f) => (
          <li
            key={`${f.runId}-${f.seq}`}
            className="truncate font-mono text-[11.5px] leading-[1.6] text-[#e8b3a8]"
            title={f.text}
          >
            {f.text}
          </li>
        ))}
      </ul>
      {more > 0 && (
        <p className="mt-1 text-[11px] text-faint">
          and {more} more — the full list is in the stream
        </p>
      )}

      {/* Codex decides alone and tells us afterwards — there was never a
          moment at which anyone could have been asked. Saying so beats
          leaving the reader to wonder why nothing asked them. */}
      <p className="mt-2 text-[11px] text-faint">
        {askable
          ? "These were refused before the question could reach you."
          : "This agent runs non-interactively — it cannot ask, so anything outside the repo is refused outright."}
      </p>

      <Button size="sm" variant="outline" className="mt-2.5 text-lemon" onClick={onAsk}>
        Grant full access and continue
      </Button>
    </div>
  )
}

/**
 * The one place we ask the user to accept risk, so it says what the risk is
 * rather than hiding behind a word like "sandbox".
 */
function PolicyToggle({
  value,
  onChange,
  disabled,
  askable,
}: {
  value: Policy
  onChange: (p: Policy) => void
  disabled: boolean
  /** Whether "repo only" means "it will ask" or "it will simply be refused". */
  askable: boolean
}) {
  const full = value === "full"
  return (
    <Hint
      text={
        full
          ? "Full access: this agent can run any command, including outside the repo."
          : askable
            ? "Repo only: it can edit files, and anything else stops and asks you."
            : "Repo only: it can edit files, but most shell commands are refused — this agent cannot ask, so it is refused outright."
      }
    >
      <Button
        variant={full ? "outline" : "ghost"}
        disabled={disabled}
        onClick={() => onChange(full ? "repo" : "full")}
        className={cn(full && "border-[#4a3a20] bg-[#241d10] text-lemon")}
      >
        <span className={cn("h-1.5 w-1.5 rounded-full", full ? "bg-lemon" : "bg-faint")} />
        {full ? "Full access" : "Repo only"}
      </Button>
    </Hint>
  )
}
