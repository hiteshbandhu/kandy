import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { cn } from "@/lib/utils"

/**
 * Agents write markdown. Showing it raw means reading `**Verified**:` and
 * counting backticks — which is exactly the reading-a-log feeling this panel
 * is supposed to replace.
 *
 * Rendered through react-markdown rather than a string-to-HTML library: agent
 * output is untrusted text, and this way there is no innerHTML anywhere near
 * it. Links open in a new tab and never navigate the board away.
 */
export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn("md text-[14.5px] leading-[1.65] text-ink", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer noopener" className="text-sky underline underline-offset-2" />
          ),
          code: ({ node: _node, className: cls, children, ...props }) => {
            const inline = !String(cls ?? "").includes("language-")
            return inline ? (
              <code
                {...props}
                className="rounded bg-raised px-1 py-px font-mono text-[13px] text-[#d9c8a0]"
              >
                {children}
              </code>
            ) : (
              <code {...props} className="font-mono text-[13px]">
                {children}
              </code>
            )
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}
