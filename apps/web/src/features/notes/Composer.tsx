import { useRef, useState } from "react"
import { CornerDownLeft } from "lucide-react"
import { splitPrompt, type AgentId, type AgentInfo } from "@kandy/core"
import { Button, Dialog, DialogContent, DialogTitle, Kbd, Textarea } from "@/ui"
import { AgentSelect } from "@/features/agents/AgentSelect"
import { ModelSelect } from "@/features/agents/ModelSelect"
import { Attachments, type Attached } from "@/features/notes/Attachments"

/**
 * Writing a note is writing a prompt.
 *
 * Two named fields rather than one box split on a newline. The split was
 * invisible magic — you could not tell what you were defining until after you
 * had typed it — and the agent is given both, so the distinction is about what
 * shows in the list, not about what gets sent.
 *
 * Built on the same Dialog as every other modal — the hand-rolled overlay it
 * used to have had its own dimming, its own animation and no focus trap, and
 * sat so close in tone to the dimmed board behind it that it barely read as a
 * layer at all.
 */
export function Composer({
  agents,
  defaultAgent,
  onCancel,
  onCreate,
}: {
  agents: AgentInfo[]
  defaultAgent: AgentId | null
  onCancel: () => void
  onCreate: (
    title: string,
    body: string,
    agent: AgentId | null,
    model: string | null,
    run: boolean,
    files: Attached[],
  ) => void
}) {
  const [title, setTitle] = useState("")
  const [body, setBody] = useState("")
  const [agent, setAgent] = useState<AgentId | "">(defaultAgent ?? "")
  const [model, setModel] = useState<string | null>(null)
  const [files, setFiles] = useState<Attached[]>([])
  const detail = useRef<HTMLTextAreaElement>(null)

  const submit = (run: boolean) => {
    const t = title.trim()
    if (!t) return
    onCreate(t, body.trim(), (agent || null) as AgentId | null, model, run, files)
  }

  /**
   * A paste into the single-line title.
   *
   * Pasting a paragraph into an <input> keeps the first line and throws the
   * rest away without saying so. A note is already a first line plus a
   * remainder, so the paste is split the way `promptFor` would have joined it:
   * line one titles the note, everything after it lands in the detail. A
   * single-line paste is left to the browser.
   */
  function pasteIntoTitle(e: React.ClipboardEvent<HTMLInputElement>) {
    const text = e.clipboardData.getData("text/plain")
    if (!text.includes("\n") && !text.includes("\r")) return

    e.preventDefault()
    const split = splitPrompt(text)
    const el = e.currentTarget
    const before = title.slice(0, el.selectionStart ?? title.length)
    const after = title.slice(el.selectionEnd ?? title.length)
    setTitle((before + split.title + after).trim())
    if (split.body) setBody((b) => (b.trim() ? `${b.trimEnd()}\n\n${split.body}` : split.body))
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onCancel()}>
      <DialogContent
        showCloseButton={false}
        className="top-[16vh] grid-cols-[minmax(0,1fr)] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-[660px]"
      >
        {/* Present for screen readers; the placeholder is the visible prompt. */}
        <DialogTitle className="sr-only">New note</DialogTitle>

        <div className="px-4 pt-4 pb-3">
          {/*
            Both fields sit inside one drop target, and both take a pasted
            screenshot — the clipboard does not know which box you were in.
          */}
          <Attachments files={files} onChange={setFiles}>
            {({ onPaste }) => (
              /*
                One field surface holding both inputs. They were flush against
                the dialog's own edge with no inset of their own, which read as
                text dropped onto the panel rather than something to type into.
                The border is the cheapest way to say "this is the input", and
                focus-within lights the whole thing so the two boxes keep
                behaving as one field.
              */
              <div className="border-hairline bg-bg/40 focus-within:border-grape/40 focus-within:ring-grape/15 space-y-2 rounded-xl border px-3.5 py-3 transition-colors focus-within:ring-3">
                <input
                  autoFocus
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  onPaste={(e) => {
                    onPaste(e)
                    if (!e.defaultPrevented) pasteIntoTitle(e)
                  }}
                  placeholder="What should the agent do?"
                  className="placeholder:text-muted-foreground/45 w-full bg-transparent text-[16px] font-medium tracking-[-0.01em] outline-none placeholder:font-normal"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
                      e.preventDefault()
                      detail.current?.focus()
                    }
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(!e.shiftKey)
                    e.stopPropagation()
                  }}
                />

                {/*
                  The base Textarea is a bordered field with its own padding and
                  a dark-mode fill. Here it is the continuation of the title
                  above it, so all three go — including `dark:bg-input/30`, which
                  `bg-transparent` alone does not outrank and which left it
                  reading as a sunken slab.
                */}
                <Textarea
                  ref={detail}
                  rows={4}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  // Text pastes into the detail exactly as the browser does it;
                  // only files are intercepted.
                  onPaste={onPaste}
                  placeholder="Constraints, how to verify — optional"
                  className="placeholder:text-muted-foreground/45 min-h-[92px] resize-none border-0 bg-transparent p-0 text-[13.5px] leading-[1.6] shadow-none focus-visible:ring-0 dark:bg-transparent"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(!e.shiftKey)
                    e.stopPropagation()
                  }}
                />
              </div>
            )}
          </Attachments>
        </div>

        <div className="bg-muted/50 flex flex-wrap items-center gap-2 border-t px-4 py-3">
          <AgentSelect
            value={agent || null}
            agents={agents}
            onChange={setAgent}
            className="w-[150px]"
          />
          <ModelSelect
            agent={agent || null}
            value={model}
            onChange={setModel}
            className="w-[176px]"
          />

          <div className="ml-auto flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => submit(false)} disabled={!title.trim()}>
              Save
            </Button>
            <Button size="sm" onClick={() => submit(true)} disabled={!title.trim() || !agent}>
              Save &amp; run
              <CornerDownLeft className="size-3 opacity-70" />
            </Button>
          </div>
        </div>

        <div className="text-muted-foreground/60 flex items-center gap-3 border-t px-4 py-2 text-[11px]">
          <span className="flex items-center gap-1">
            <Kbd>⌘↵</Kbd> save &amp; run
          </span>
          <span className="flex items-center gap-1">
            <Kbd>⇧⌘↵</Kbd> save
          </span>
          <span className="flex items-center gap-1">
            <Kbd>esc</Kbd> cancel
          </span>
        </div>
      </DialogContent>
    </Dialog>
  )
}
