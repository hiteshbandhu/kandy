import {
  FolderGit2,
  Gauge,
  LayoutList,
  Moon,
  Plus,
  Settings2,
  Sun,
} from "lucide-react"
import type { AgentInfo, Board, BoardView } from "@kandy/core"
import { Button, Hint, Kbd, Separator, StatusPill } from "@/ui"
import { Wordmark } from "@/brand/Logo"
import { AgentMark, agentLabel } from "@/features/agents/AgentMark"
import type { Theme } from "@/hooks/useTheme"
import { cn, money } from "@/lib/utils"

export type View = "board" | "usage" | "settings"

/**
 * Standing context and navigation.
 *
 * Everything here is a fact about the whole workspace rather than about one
 * note, which is why none of it belongs in the list. It never gets covered by
 * anything: losing sight of what else is waiting is the one thing this app
 * cannot afford to do.
 */
export function Sidebar({
  boards,
  boardId,
  view,
  agents,
  connected,
  page,
  theme,
  onPage,
  onTheme,
  onBoardChange,
  onNewBoard,
  onNewNote,
}: {
  boards: Board[]
  boardId: string | null
  view: BoardView | null
  agents: AgentInfo[]
  connected: boolean
  page: View
  theme: Theme
  onPage: (v: View) => void
  onTheme: (t: Theme) => void
  onBoardChange: (id: string) => void
  onNewBoard: () => void
  onNewNote: () => void
}) {
  const notes = view?.notes ?? []
  const n = (f: (s: string) => boolean) => notes.filter((x) => f(x.status)).length
  const attention = n((s) => s === "blocked" || s === "failed")
  // Ahead of everything, including `attention`: an agent standing still with a
  // question is the one thing on a board that cannot make progress without you.
  const waiting = view?.prompts.length ?? 0
  const review = n((s) => s === "review")
  const running = n((s) => s === "running")

  const runs = view?.runs ?? []
  const spend = runs.reduce((t, r) => t + (r.costUsd ?? 0), 0)
  const estimated = runs.some((r) => r.costSource === "estimated")

  return (
    <aside className="bg-sidebar flex w-[244px] shrink-0 flex-col border-r">
      <div className="flex items-center px-4 pt-4 pb-3">
        <Wordmark />
      </div>

      <nav className="space-y-0.5 px-2.5">
        {/* The primary action, built from the same NavItem as the rows under
            it — a filled button here spoke a different visual language from
            everything else in the sidebar. It leads because writing a note is
            what you came to do, and carries its shortcut the way the board's
            own composer does. */}
        <NavItem icon={Plus} label="New note" active={false} onClick={onNewNote}>
          <Kbd>C</Kbd>
        </NavItem>

        <NavItem icon={LayoutList} label="Board" active={page === "board"} onClick={() => onPage("board")}>
          {waiting > 0 ? (
            <StatusPill tone="lemon" pulse className="px-1.5 py-0 text-[10px]">
              {waiting}
            </StatusPill>
          ) : attention > 0 ? (
            <StatusPill tone="berry" pulse className="px-1.5 py-0 text-[10px]">
              {attention}
            </StatusPill>
          ) : review > 0 ? (
            <StatusPill tone="mint" className="px-1.5 py-0 text-[10px]">
              {review}
            </StatusPill>
          ) : running > 0 ? (
            <StatusPill tone="lemon" pulse className="px-1.5 py-0 text-[10px]">
              {running}
            </StatusPill>
          ) : null}
        </NavItem>
        <NavItem icon={Gauge} label="Usage" active={page === "usage"} onClick={() => onPage("usage")}>
          {spend > 0 && (
            <span className="text-muted-foreground text-[11px] tabular-nums">
              {estimated ? "≈" : ""}
              {money(spend)}
            </span>
          )}
        </NavItem>
        <NavItem
          icon={Settings2}
          label="Settings"
          active={page === "settings"}
          onClick={() => onPage("settings")}
        />
      </nav>

      <Separator className="my-3" />

      <div className="min-h-0 flex-1 overflow-y-auto px-2.5">
        <p className="label px-1.5 pb-1.5">Repos</p>
        <div className="space-y-0.5">
          {boards.map((b) => (
            <button
              key={b.id}
              onClick={() => {
                onBoardChange(b.id)
                onPage("board")
              }}
              className={cn(
                "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] transition-colors",
                b.id === boardId && page === "board"
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              )}
            >
              <FolderGit2 className="size-3.5 shrink-0 opacity-70" />
              <span className="truncate">{b.name}</span>
            </button>
          ))}
          <button
            onClick={onNewBoard}
            className="text-muted-foreground hover:bg-accent/60 hover:text-foreground flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] transition-colors"
          >
            <Plus className="size-3.5 shrink-0" />
            Add a repo
          </button>
        </div>

      </div>

      <div className="space-y-3 px-2.5 pb-3">
        <Separator />

        <div>
          <p className="label px-1.5 pb-1.5">Agents</p>
          <div className="space-y-0.5">
            {agents
              .filter((a) => a.installed)
              .map((a) => (
                <Hint
                  key={a.id}
                  text={`${agentLabel(a.id)}${a.version ? ` — ${a.version}` : ""}${a.authed ? "" : " · not signed in"}`}
                >
                  <span className="flex items-center gap-2 px-1.5 py-0.5">
                    <AgentMark agent={a.id} size={13} />
                    <span
                      className={cn(
                        "text-[11.5px]",
                        a.authed ? "text-muted-foreground" : "text-muted-foreground/50",
                      )}
                    >
                      {agentLabel(a.id)}
                    </span>
                  </span>
                </Hint>
              ))}
          </div>
        </div>

        <div className="flex items-center gap-1 px-1.5">
          <Hint text={theme === "dark" ? "Switch to light" : "Switch to dark"}>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => onTheme(theme === "dark" ? "light" : "dark")}
              aria-label="Toggle theme"
            >
              {theme === "dark" ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
            </Button>
          </Hint>
          <span className="text-muted-foreground/70 ml-auto text-[10.5px]">
            <kbd className="bg-muted rounded border px-1 py-px text-[10px]">⌘K</kbd> for anything
          </span>
        </div>
      </div>
    </aside>
  )
}

function NavItem({
  icon: Icon,
  label,
  active,
  onClick,
  children,
}: {
  icon: typeof LayoutList
  label: string
  active: boolean
  onClick: () => void
  children?: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors",
        active
          ? "bg-accent text-accent-foreground font-medium"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
      )}
    >
      <Icon className="size-4 shrink-0 opacity-80" />
      <span className="flex-1">{label}</span>
      {children}
    </button>
  )
}
