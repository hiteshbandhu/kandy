import { useEffect, useMemo, useState } from "react"
import { ChevronLeft, Folder, FolderGit2, Search } from "lucide-react"
import type { KandyClient } from "@kandy/client"
import type { DirEntry, Listing } from "@kandy/core"
import { Button } from "@/ui"
import { cn, tailPath } from "@/lib/utils"

function repoParent(repo: string): string {
  const shortened = repo.replace(/^(?:[A-Za-z]:\\Users\\|\/Users\/)[^\\/]+/, "~")
  const parent = shortened.replace(/[\\/][^\\/]+$/, "")
  return /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent
}

/**
 * Choosing the repo, in one field.
 *
 * The field filters the repos found by the runner and also accepts a path.
 * Browse opens the runner's directory listing for repos outside the shallow
 * search. A native dialog would depend on the runner having a foreground
 * desktop, which a background runner on Windows may not have.
 */
export function RepoPicker({
  client,
  query,
  onQuery,
  onPick,
  taken,
}: {
  client: KandyClient
  /** The field's text. Owned by the dialog, which also validates it. */
  query: string
  onQuery: (v: string) => void
  onPick: (path: string) => void
  /** Repo paths that already have a board, so they can say so. */
  taken: Set<string>
}) {
  const [repos, setRepos] = useState<DirEntry[]>([])
  const [pick, setPick] = useState(0)
  const [browsing, setBrowsing] = useState(false)
  const [listing, setListing] = useState<Listing | null>(null)
  const [browseError, setBrowseError] = useState<string | null>(null)

  async function openDirectory(dir?: string) {
    setBrowsing(true)
    setBrowseError(null)
    try {
      setListing(await client.browse(dir))
    } catch {
      setBrowseError("Could not open this folder. Choose another location.")
    } finally {
      setBrowsing(false)
    }
  }

  useEffect(() => {
    let stale = false
    void client
      .browse()
      .then((r) => !stale && setRepos(r.repos ?? []))
      .catch(() => undefined)
    return () => {
      stale = true
    }
  }, [client])

  /* A path is anything with a separator or a leading ~ — the one shape that
     can't also be someone searching for a repo by name. */
  const isPath = /[\\/~]/.test(query)

  const hits = useMemo(() => {
    if (isPath) return []
    const q = query.trim().toLowerCase()
    /* Matched on the name alone. Matching the path too looked more generous
       and was worse: every repo lives under ~/Developer, so "eve" returned
       every repo on the machine. */
    const matches = q ? repos.filter((r) => r.name.toLowerCase().includes(q)) : repos
    return matches
      .slice()
      .sort((a, b) => {
        // Repos you've already added sort last: you came here to add a new one.
        const at = taken.has(a.path) ? 1 : 0
        const bt = taken.has(b.path) ? 1 : 0
        if (at !== bt) return at - bt
        if (!q) return 0
        const an = a.name.toLowerCase().startsWith(q) ? 0 : 1
        const bn = b.name.toLowerCase().startsWith(q) ? 0 : 1
        return an - bn || a.name.length - b.name.length
      })
      .slice(0, 6)
  }, [query, repos, isPath, taken])

  useEffect(() => setPick(0), [query])

  return (
    <div>
      <div className="flex items-center gap-2 rounded-lg border border-line bg-raised px-2.5 transition-colors focus-within:border-grape/45">
        <Search className="size-3.5 shrink-0 text-faint" />
        <input
          autoFocus
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Search your repos, or paste a path"
          className={cn(
            "w-full bg-transparent py-2 text-ui outline-none placeholder:text-faint",
            isPath && "font-mono",
          )}
          onKeyDown={(e) => {
            if (listing || hits.length === 0) return
            if (e.key === "ArrowDown") {
              e.preventDefault()
              setPick((i) => (i + 1) % hits.length)
            } else if (e.key === "ArrowUp") {
              e.preventDefault()
              setPick((i) => (i - 1 + hits.length) % hits.length)
            } else if (e.key === "Enter" && !isPath) {
              e.preventDefault()
              const selected = hits[pick] ?? hits[0]
              if (selected) onPick(selected.path)
            }
          }}
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={browsing}
          onClick={() => {
            if (listing) {
              setListing(null)
              setBrowseError(null)
            } else {
              void openDirectory()
            }
          }}
          className="-mr-1.5 shrink-0 text-dim"
        >
          {browsing ? "Opening…" : listing ? "Close" : "Browse…"}
        </Button>
      </div>

      {!listing && hits.length > 0 && (
        <ul className="mt-2 overflow-hidden rounded-lg border border-hairline p-1.5">
          {hits.map((r, i) => (
            <li key={r.path}>
              <button
                type="button"
                onMouseEnter={() => setPick(i)}
                onClick={() => onPick(r.path)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
                  i === pick ? "bg-raised" : "hover:bg-raised/60",
                )}
              >
                <FolderGit2 className="size-3.5 shrink-0 text-faint" />
                <span className="text-aux text-ink">{r.name}</span>
                {taken.has(r.path) && <span className="text-micro text-faint">on a board</span>}
                {/* The parent, not the path: the name is already the row's
                    subject, and repeating it makes the line read twice. */}
                <span className="min-w-0 flex-1 truncate text-right font-mono text-micro text-faint">
                  {tailPath(repoParent(r.path), 30)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {listing && (
        <div className="mt-2 rounded-lg border border-hairline p-2">
          <div className="mb-2 flex items-center gap-2">
            {listing.parent && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={browsing}
                onClick={() => {
                  if (listing.parent) void openDirectory(listing.parent)
                }}
                aria-label="Parent folder"
              >
                <ChevronLeft className="size-4" />
              </Button>
            )}
            <span className="min-w-0 flex-1 truncate font-mono text-micro text-dim" title={listing.path}>
              {listing.path}
            </span>
            {listing.isRepo && (
              <Button type="button" size="sm" onClick={() => onPick(listing.path)}>
                Choose repo
              </Button>
            )}
          </div>
          <div className="max-h-52 overflow-y-auto">
            {listing.entries.map((entry) => (
              <button
                key={entry.path}
                type="button"
                disabled={browsing}
                onClick={() => void openDirectory(entry.path)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-raised/60"
              >
                {entry.isRepo
                  ? <FolderGit2 className="size-3.5 shrink-0 text-faint" />
                  : <Folder className="size-3.5 shrink-0 text-faint" />}
                <span className="min-w-0 flex-1 truncate text-aux" title={entry.path}>
                  {entry.name}
                </span>
                {entry.isRepo && <span className="text-micro text-faint">repo</span>}
              </button>
            ))}
          </div>
          {listing.suggestions.length > 0 && (
            <div className="mt-2 border-t border-hairline pt-2">
              <div className="mb-1 text-micro text-faint">Places</div>
              <div className="flex flex-wrap gap-1">
                {listing.suggestions.map((place) => (
                  <Button
                    key={place.path}
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={browsing}
                    onClick={() => void openDirectory(place.path)}
                    title={place.path}
                  >
                    {place.name}
                  </Button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
      {browseError && <p role="alert" className="mt-2 text-micro text-red-500">{browseError}</p>}
    </div>
  )
}
