import { cn } from "@/lib/utils"

/**
 * The kandy mark: three lanes of work inside one board.
 *
 * This replaces a lowercase "k" built from the same three candy pieces. The
 * letterform said nothing about the product; a rail holding three parallel
 * bars is literally what kandy is — one board, several agents, each in its
 * own lane.
 *
 * The rail is stroked rather than filled so the bars read as sitting *inside*
 * something, and it carries ink at low opacity so it never competes with the
 * three colours it holds.
 */
export function Logo({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      className={cn("shrink-0", className)}
      aria-hidden="true"
    >
      <rect
        x="3.5"
        y="5.5"
        width="25"
        height="21"
        rx="4"
        fill="none"
        stroke="var(--color-ink)"
        strokeWidth="1.4"
        opacity="0.35"
      />
      <rect x="7" y="9" width="4.2" height="14" rx="1.5" fill="var(--color-berry)" />
      <rect x="13.9" y="9" width="4.2" height="14" rx="1.5" fill="var(--color-lemon)" />
      <rect x="20.8" y="9" width="4.2" height="14" rx="1.5" fill="var(--color-mint)" />
    </svg>
  )
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("flex items-center gap-2", className)}>
      <Logo size={19} />
      <span className="text-[14.5px] font-semibold tracking-[-0.03em]">kandy</span>
    </span>
  )
}
