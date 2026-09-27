import { useEffect, useMemo, useState } from "react"
import type { KandyClient } from "@kandy/client"
import type { Board, Policy, RepoCheck } from "@kandy/core"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/ui"
import { RepoPicker } from "@/features/boards/RepoPicker"
import { Button } from "@/ui"
import { Input } from "@/ui"
import { cn } from "@/lib/utils"

/**
 * A board is a repo, so this dialog has one real question.
 *
 * It used to ask three: browse or type, which folder, and what to call it —
 * two of which have obvious answers. Picking from the repos on this machine
 * answers the first two at once, and the name defaults to the folder, so it
 * only appears once there is a repo to name.
 *
 * The path is still validated as it settles rather than at the first run three
 * clicks later, which is the difference between a tool that feels solid and
 * one that feels like it's guessing.
 */
export function NewBoardDialog({
  open,
  onOpenChange,
  client,
  boards,
  onCreated,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  client: KandyClient
  /** What's already here, so the same repo isn't added twice by accident. */
  boards: Board[]
  onCreated: (boardId: string) => void
}) {
  const [query, setQuery] = useState("")
  const [name, setName] = useState("")
  const [check, setCheck] = useState<RepoCheck | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [policy, setPolicy] = useState<Policy>("full")

  const taken = useMemo(() => new Set(boards.map((b) => b.repoPath)), [boards])
  // Only a path can be checked; a half-typed repo name is a search, not a guess
  // at a directory, and checking it would flash "not a git repository" at
  // someone who is still typing.
  const path = /[/~]/.test(query) ? query.trim() : ""

  useEffect(() => {
    if (!path) return setCheck(null)
    let stale = false
    // Debounced: every keystroke would otherwise be a git process.
    const t = setTimeout(() => {
      void client
        .checkRepo(path)
        .then((r) => !stale && setCheck(r))
        .catch(() => !stale && setCheck(null))
    }, 250)
    return () => {
      stale = true
      clearTimeout(t)
    }
  }, [path, client])

  function reset() {
    setQuery("")
    setName("")
    setCheck(null)
    setError(null)
    setPolicy("full")
  }

  async function create() {
    if (!check?.isRepo || busy) return
    setBusy(true)
    setError(null)
    try {
      const { board } = await client.createBoard(name.trim() || check.name || "board", check.path, undefined, undefined, policy)
      onCreated(board.id)
      onOpenChange(false)
      reset()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v)
        if (!v) reset()
      }}
    >
      <DialogContent>
        <DialogTitle>New board</DialogTitle>
        <DialogDescription>
          Point it at a git repository. Every note runs in its own worktree off that repo.
        </DialogDescription>

        <div className="mt-5 space-y-3">
          <RepoPicker
            client={client}
            query={query}
            onQuery={setQuery}
            // Picking writes the path into the same field, in the short form —
            // so what you chose is visible and still editable, rather than
            // being swallowed by a control that now says nothing.
            onPick={(p) => setQuery(short(p))}
            taken={taken}
          />

          <RepoStatus query={path} check={check} taken={taken} />

          {/* Naming is a detail of a repo you've already chosen, so it waits
              until there is one. Blank means the folder name. */}
          {check?.isRepo && (
            <label className="flex items-center gap-3">
              <span className="label shrink-0">Call it</span>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={check.name ?? "board"}
                onKeyDown={(e) => e.key === "Enter" && void create()}
              />
            </label>
          )}

          {/* What its notes may do. Full access by default: repo only
              refuses most commands, builds and tests included. Each board
              can change it later in its settings. */}
          {check?.isRepo && (
            <div className="flex items-center gap-3">
              <span className="label shrink-0">Agents</span>
              <div className="flex gap-2">
                <Button
                  variant={policy === "full" ? "default" : "outline"}
                  size="sm"
                  onClick={() => setPolicy("full")}
                  className={cn(policy === "full" && "border-lemon/30 bg-lemon-bg text-lemon")}
                >
                  Full access
                </Button>
                <Button variant={policy === "repo" ? "default" : "outline"} size="sm" onClick={() => setPolicy("repo")}>
                  Repo only
                </Button>
              </div>
            </div>
          )}
        </div>

        {error && (
          <p className="mt-4 rounded-lg border border-berry/25 bg-berry-bg px-3 py-2 text-aux text-berry">
            {error}
          </p>
        )}

        <div className="mt-6 flex items-center gap-2">
          <Button
            variant="default"
            size="default"
            disabled={!check?.isRepo || busy}
            onClick={() => void create()}
          >
            {busy ? "Creating…" : "Create board"}
          </Button>
          <Button variant="ghost" size="default" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** `/Users/you/x` is `~/x`. The home prefix is noise in every one of these. */
function short(p: string): string {
  return p.replace(/^\/Users\/[^/]+/, "~")
}

function RepoStatus({
  query,
  check,
  taken,
}: {
  query: string
  check: RepoCheck | null
  taken: Set<string>
}) {
  if (!query) return null
  if (!check) return <p className="text-meta text-faint">Checking…</p>

  if (!check.isRepo) {
    return <p className="text-meta text-berry">{check.error ?? "Not a git repository."}</p>
  }

  return (
    <div className="space-y-1 text-meta">
      <div className="flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-mint" />
        {/* The path only when it isn't already the thing you typed — repeating
            the field back is filler; resolving `.` or a symlink is news. */}
        {short(check.path) !== query && (
          <span className="font-mono text-dim">{short(check.path)}</span>
        )}
        <span className="text-faint">
          on {check.branch} at {check.head}
        </span>
      </div>
      {taken.has(check.path) && (
        <div className="text-lemon">This repo already has a board. You'll get a second one.</div>
      )}
      {/* Worth saying plainly: notes branch from HEAD and will not see
          uncommitted work. Discovering that later feels like a betrayal. */}
      {check.dirty && (
        <div className="text-lemon">
          Uncommitted changes — agents branch from HEAD and won't see them.
        </div>
      )}
    </div>
  )
}
