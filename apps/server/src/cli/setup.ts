import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createInterface } from "node:readline/promises"
import { detectAll } from "../agents/index.js"
import { joinedHub } from "../joined.js"
import { CONFIG_DIR, DB_PATH } from "../paths.js"
import { explain, tailscaleStatus } from "../tailscale.js"
import { banner, bold, dim, faint, lemon, mint } from "./banner.js"
import { cmdJoin } from "./join.js"
import type { Policy } from "@kandy/core"

/**
 * The first time kandy runs, one question: how will you use it?
 *
 * There are exactly three answers — just me, join my team, start a hub for
 * my team — and each needs something different next. Asked once, because
 * a tool that interviews you on every run is a tool you stop running; never
 * asked where nobody can answer (a pipe, a script, CI); and `kandy setup`
 * asks it again for anyone who picked wrong.
 *
 * People who used kandy before this existed are not asked: they already have
 * a board, and a questionnaire between them and it would be a regression.
 */

const FILE = path.join(CONFIG_DIR, "setup.json")
const out = (s = "") => process.stdout.write(s + "\n")

type Mode = "solo" | "team" | "hub"

export function needsSetup(): boolean {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false
  if (process.env["CI"] || process.env["KANDY_NO_SETUP"]) return false
  if (existsSync(FILE)) return false
  // Already set up in every way that matters, just before this file existed.
  if (joinedHub() || existsSync(DB_PATH)) {
    remember("solo")
    return false
  }
  return true
}

function remember(mode: Mode, policy?: Policy): void {
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(FILE, JSON.stringify({ mode, ...(policy ? { policy } : {}), at: Date.now() }, null, 2) + "\n")
}

/**
 * What new boards on this machine let agents do: chosen at setup, and full
 * access when nobody chose. A board's own setting changes it afterwards.
 */
export function preferredPolicy(): Policy {
  try {
    return (JSON.parse(readFileSync(FILE, "utf8")) as { policy?: Policy }).policy === "repo" ? "repo" : "full"
  } catch {
    return "full"
  }
}

export function setupMode(): Mode | null {
  try {
    return (JSON.parse(readFileSync(FILE, "utf8")) as { mode: Mode }).mode
  } catch {
    return null
  }
}

/**
 * Returns true when the caller should carry on into what it was doing — the
 * board, for bare `kandy` — and false when setup has already done the thing
 * (joined a team, explained a hub) and should end there.
 */
export async function runSetup(): Promise<boolean> {
  process.stdout.write(banner())
  out(`  ${bold("Welcome.")} ${faint("Each note is one job: an agent does it in its own git worktree,")}`)
  out(`  ${faint("and it comes back as a diff you review and merge.")}`)
  out()

  // What can run here, before anything is asked — a board with no agent to
  // run its notes is the first thing worth knowing.
  const agents = (await detectAll()).filter((a) => a.installed)
  const ready = agents.filter((a) => a.authed)
  out(
    `  ${dim("agents here")}  ` +
      (ready.length ? ready.map((a) => mint(a.id)).join("  ") : lemon("none signed in")) +
      (agents.length > ready.length ? faint(`   signed out: ${agents.filter((a) => !a.authed).map((a) => a.id).join(", ")}`) : ""),
  )
  if (!ready.length) {
    out(faint("  Sign in to one first — claude · codex login · cursor-agent login — or notes will have nothing to run them."))
  }
  out()

  out(`  ${bold("How will you use it?")}`)
  out(`    ${bold("1")}  Just me, on this machine          ${faint("(enter)")}`)
  out(`    ${bold("2")}  Join my team's hub`)
  out(`    ${bold("3")}  Start a hub for my team`)
  out()

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const ask = async (q: string) => (await rl.question(q)).trim()
  try {
    const pick = await ask(`  ${dim("›")} `)
    const mode: Mode = pick === "2" ? "team" : pick === "3" ? "hub" : "solo"

    // A hub runs no agents, so it has nothing to ask about access.
    let policy: Policy | undefined
    if (mode !== "hub") {
      out()
      out(`  ${bold("What may agents do?")} ${faint("for new boards — each board can change it later")}`)
      out(`    ${bold("1")}  Full access: run anything, never ask   ${faint("(enter)")}`)
      out(`    ${bold("2")}  Repo only: edit the worktree, ask before anything else`)
      out()
      policy = (await ask(`  ${dim("›")} `)) === "2" ? "repo" : "full"
    }

    if (mode === "solo") {
      remember("solo", policy)
      // Straight on to the board — its footer carries the keys. The lines
      // below are for the case where there is no repository here to show.
      if (process.stdout.isTTY) return true
      out()
      out(`  ${mint("Set.")} ${faint("Inside any repository:")}`)
      out(`    ${bold('kandy "fix the login flash"')}   ${faint("a note, run by an agent")}`)
      out(`    ${bold("kandy")}                          ${faint("the board, here in the terminal")}`)
      out(faint("  The repo becomes a board the first time you write a note in it. kandy -h for the rest."))
      out()
      return true
    }

    if (mode === "team") {
      out()
      out(faint("  The hub's url is something like https://kandy-hub.your-tailnet.ts.net — its owner has it."))
      const url = await ask(`  ${dim("hub url ›")} `)
      rl.close()
      if (!url) {
        out(faint("  Later, then: kandy join <hub-url>"))
        return false
      }
      out()
      const code = await cmdJoin(url, { repos: [] })
      if (code === 0) remember("team", policy)
      return false
    }

    // A hub: say where it can live and how, and offer to start it here.
    remember("hub")
    out()
    out(`  ${bold("A hub")} ${faint("is the board your team shares. It runs no agents and holds no keys —")}`)
    out(faint("  so it can live on a spare machine, a small VPS, or in Docker. It needs to stay on."))
    const ts = await tailscaleStatus()
    out()
    if (ts.ok) {
      out(`  ${dim("tailscale")}  ${mint("up")} ${faint(`— this machine is ${ts.self.dnsName}`)}`)
    } else {
      out(`  ${dim("tailscale")}  ${lemon("not ready")} ${faint(`— ${explain(ts.reason)}`)}`)
    }
    out()
    out(`  ${dim("on the machine that will host it")}`)
    out(`    ${bold("kandy hub --tailscale")}`)
    out(`  ${dim("or in Docker, from the kandy repository")}`)
    out(`    ${bold("TS_AUTHKEY=… KANDY_TAILNET_HOST=… docker compose up -d")}`)
    out()
    out(faint("  Open its url — the first person in owns it — then invite people from the Team page."))
    out(faint("  Your own laptop joins like everyone else's: kandy join <hub-url>. kandy help teams for more."))
    if (ts.ok) {
      const now = await ask(`\n  ${dim("start it on this machine now? [y/N] ›")} `)
      rl.close()
      if (/^y/i.test(now)) {
        const { runHub } = await import("./roles.js")
        // 4488, not 4477: this machine's own board keeps its port.
        await runHub({ port: 4488, tailscale: true, identity: null, tailnetHost: null, bind: "127.0.0.1", httpsPort: 443, json: false })
        // Serving now. Returning would let the CLI exit and take the hub
        // with it; it stops on ctrl-c, through runHub's own handler.
        await new Promise(() => {})
      }
    }
    return false
  } finally {
    rl.close()
  }
}
