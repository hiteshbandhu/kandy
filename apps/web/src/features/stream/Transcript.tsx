import { useEffect, useRef, useState } from "react"
import { Eye, EyeOff } from "lucide-react"
import type { TranscriptFrame } from "@kandy/core"
import { InlineEdit } from "@/features/notes/InlineEdit"
import { Markdown } from "@/features/stream/Markdown"
import { cn } from "@/lib/utils"

/**
 * The agent's stream, as rows rather than a wall of log.
 *
 * Tool calls collapse to one line each — a name and its target — because
 * thirty of them scrolling past is texture, not information. What the agent
 * *said* gets room; what it *ran* gets a line; what it was *refused* gets a
 * callout, because that's the part a person has to act on.
 */
const TOOLS_KEY = "kandy.showTools"

export function Transcript({ frames, prompt, onEditPrompt }: {
  frames: TranscriptFrame[]
  prompt: string
  onEditPrompt?: (body: string) => Promise<boolean>
}) {
  const end = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const [pinned, setPinned] = useState(true)

  // Tool calls are texture most of the time and the whole story occasionally,
  // so the choice is the reader's — and it is remembered, because having to
  // make it again on every note is worse than either default.
  const [showTools, setShowTools] = useState(() => {
    try {
      return localStorage.getItem(TOOLS_KEY) !== "0"
    } catch {
      return true
    }
  })
  const toggleTools = () => {
    setShowTools((v) => {
      try {
        localStorage.setItem(TOOLS_KEY, v ? "0" : "1")
      } catch {
        // Blocked storage just means the preference lasts this session.
      }
      return !v
    })
  }

  const toolCount = frames.filter((f) => f.role === "tool").length
  const shown = showTools ? frames : frames.filter((f) => f.role !== "tool")

  useEffect(() => {
    // Only autoscroll when already at the bottom. Yanking someone back down
    // while they're reading is the rudest thing a log can do.
    if (pinned) end.current?.scrollIntoView({ block: "end" })
  }, [frames.length, pinned])

  return (
    <>
    {toolCount > 0 && (
      <div className="border-b px-4 py-1.5">
        <button
          onClick={toggleTools}
          className="text-muted-foreground/70 hover:text-foreground hover:bg-accent flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] transition-colors"
        >
          {showTools ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
          {showTools ? "Hide" : "Show"} {toolCount} tool {toolCount === 1 ? "call" : "calls"}
        </button>
      </div>
    )}
    <div
      ref={box}
      onScroll={() => {
        const el = box.current
        if (el) setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 48)
      }}
      className="flex-1 space-y-2.5 overflow-y-auto overflow-x-hidden px-4 py-4"
    >
      {(prompt || onEditPrompt) && (
        <div className="rounded-xl border border-hairline bg-raised px-3 py-3">
          <div className="text-[10.5px] font-medium uppercase tracking-[0.08em] text-faint">
            Prompt
          </div>
          <div className="mt-1.5 whitespace-pre-wrap text-[14.5px] leading-[1.6] text-dim">
            {onEditPrompt ? (
              <InlineEdit
                value={prompt}
                label="Edit prompt"
                placeholder="Add a prompt…"
                rows={4}
                onSave={onEditPrompt}
              />
            ) : prompt}
          </div>
        </div>
      )}


      {frames.length === 0 && (
        <p className="py-6 text-center text-[13px] text-faint">Nothing yet.</p>
      )}

      {shown.map((f) => (
        <Frame key={`${f.runId}-${f.seq}`} frame={f} />
      ))}
      <div ref={end} />
    </div>
    </>
  )
}

function Frame({ frame: f }: { frame: TranscriptFrame }) {
  const denied = f.meta === "permission"

  if (denied || f.role === "error") {
    return (
      <div className="rounded-xl border border-[#3d2621] bg-[#1a1211] px-3 py-3">
        <div className="flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-[0.08em] text-berry">
          <span className="h-1.5 w-1.5 rounded-full bg-berry" />
          {denied ? "Refused" : "Error"}
        </div>
        <p className="mt-1.5 whitespace-pre-wrap break-words text-[14px] leading-[1.55] text-[#e8b3a8]">
          {f.text}
        </p>
      </div>
    )
  }

  if (f.role === "user") {
    return (
      <div className="rounded-xl border border-[#22304d] bg-[#121826] px-3 py-3">
        <div className="text-[10.5px] font-medium uppercase tracking-[0.08em] text-sky">You</div>
        <p className="mt-1.5 whitespace-pre-wrap break-words text-[14.5px] leading-[1.6] text-[#c7d6f5]">
          {f.text}
        </p>
      </div>
    )
  }

  if (f.role === "tool") {
    return (
      <div className="flex items-baseline gap-2.5 px-1 py-0.5">
        <span className="shrink-0 rounded-md bg-raised px-1.5 py-0.5 text-[11.5px] font-medium text-dim">
          {f.meta ?? "tool"}
        </span>
        <span className="truncate font-mono text-[12.5px] text-faint" title={f.text}>
          {f.text}
        </span>
      </div>
    )
  }

  if (f.role === "system") {
    // A rule with a caption. The caption must be allowed to wrap — several of
    // these are full sentences, and a fixed-width divider row turns them into
    // a horizontal scrollbar across the whole panel.
    return (
      <div className="flex items-center gap-2.5 px-1 py-1.5">
        <span className="h-px w-4 shrink-0 bg-hairline" />
        <span className="min-w-0 text-[12px] leading-relaxed text-faint">{f.text}</span>
        <span className="h-px flex-1 bg-hairline" />
      </div>
    )
  }

  // Assistant messages are markdown. Rendering them is the difference between
  // reading a message and reading a log.
  return <Markdown className="px-1">{f.text}</Markdown>
}
