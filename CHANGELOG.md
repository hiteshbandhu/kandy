# Changelog

## Unreleased

- **Agents get full access by default.** New boards run their notes in each
  agent's "skip permissions" mode. First-run setup asks which you want, and the
  **New board** dialog has the choice too; repo only is still one setting away.
  → [Board settings](https://hiteshbandhu.github.io/kandy/guide/settings)

## 0.2.0-alpha.3 — the terminal board is a kanban

September 2026. **Extremely experimental** — see [Status](https://github.com/hiteshbandhu/kandy/tree/main/apps/docs/status.md). Install or
update:

```sh
npm i -g https://github.com/hiteshbandhu/kandy/releases/latest/download/kandy.tgz
kandy stop   # if kandy was already running, so the new version starts
```

### New

- **The terminal board is a kanban.** Columns side by side, each note a sticky
  note coloured by what it's waiting for; every note action works straight from
  its card. → [The terminal board](https://hiteshbandhu.github.io/kandy/guide/terminal)
- **The mouse**: click a card, double-click to open, drag to reorder or to act —
  a draft dropped on Running runs, a review dropped on Done merges — scroll a
  column, click a tab or a key in the footer. `KANDY_NO_MOUSE=1` turns it off.
- **Several boards**, as tabs with how many notes need you on each; `[` `]` to
  switch, `B` to add a repository.
- **The team, in the terminal**: `t` shows who may run notes on this machine
  (and changes it), the machines connected, the people and their roles — owners
  invite and change roles from there — and what everyone did.
- **A runner reconnects when its hub goes quiet**, rather than sitting "online"
  on a dead connection after a network drop or a hub restart.
- Team activity names who asked, not whose machine wrote it down: *bob asked to
  run «…» on alice-laptop*.

### Fixed

- **opencode edited the wrong checkout.** opencode takes its directory from
  `$PWD`, and kandy passed on the daemon's — so a note run with opencode changed
  the folder the daemon was started in, and its own worktree showed +0 −0.
  Every agent now gets its note's worktree as `PWD` too.
- **opencode's tool calls never reached the transcript** or the card's live
  activity: opencode reports a call only once it has finished, and those were
  dropped. Checked against opencode 1.18 with a real run.
- **Windows, first contact.** kandy now installs and runs on Windows 10: a
  repository path like `C:\Users\…\my repos\app` was refused as "not
  absolute", and a Windows remote read as an ssh host called `C`. The mouse is
  left to the terminal there, since Node drops Windows console mouse events.
- **No more SQLite warning** above every command on Node 22.
- **A runner that vanished shows as offline.** Runners check in every 20s and the
  hub drops one it hasn't heard from in a minute — before, a runner killed
  behind `tailscale serve` stayed "online" and teammates' notes waited for it.

## 0.2.0-alpha.2 — a first run that works

September 2026. **Extremely experimental** — see [Status](https://github.com/hiteshbandhu/kandy/tree/main/apps/docs/status.md). Install or
update:

```sh
npm i -g https://github.com/hiteshbandhu/kandy/releases/latest/download/kandy.tgz
kandy stop   # if kandy was already running, so the new version starts
```

### Fixed — found by running real boards end to end

- **Light mode was unreadable.** The board's background painted near-black on
  light themes, and the waiting-for-you cards, permission questions, failed
  notes and errors used dark-only colours. All follow the theme now.
- **A repo with no GitHub remote couldn't land a note** in the browser — only
  Discard was offered. **Merge into main** is back wherever there's nowhere to
  open a pull request, naming the branch it lands on.
- **Allowed commands were shown as refused.** A note whose tests you allowed,
  and which then passed, still said "refused before the question could reach
  you".
- **A repo without a lockfile got one** at the top of every diff: setup ran
  `npm install`, which wrote `package-lock.json`. It now installs without
  writing one.
- **The terminal printed agents' markdown raw.** Bold, code, bullets, headings
  and code blocks render as formatting.
- **An old Node failed cryptically** with `ERR_UNKNOWN_BUILTIN_MODULE:
  node:sqlite`. It now says kandy needs Node 22 or newer.

### Better

- **`kandy stop`** stops kandy on this machine; any command starts it again.
- **Short paths in transcripts** — `src/app.js`, not the note's whole worktree
  path, in the terminal and the browser.
- **The terminal's merge prompt names the branch**: *Merge … into main?*
- The sidebar says *checking agents…* while it checks, rather than *no agent
  ready*.

### Docs

- A new landing page built from real screenshots, in light and dark.
- **Get started** as ten steps from a real run, each with its real screen.
- **Troubleshooting**, led by kandy's exact messages.
- **A page per agent** — Claude Code, Codex, Cursor, opencode, aider.
- **Board settings**, every one.
- `/llms.txt` and a markdown copy of every page, for agents.

## 0.2.0-alpha.1 — teams, capabilities, the terminal

September 2026. **Extremely experimental** — see [Status](https://github.com/hiteshbandhu/kandy/tree/main/apps/docs/status.md).

**Installable.** One command, from the GitHub release — no clone:

```sh
npm i -g https://github.com/hiteshbandhu/kandy/releases/latest/download/kandy.tgz
```

### Teams

- **Three modes.** Just you, as before; **join a team** with
  `kandy join <hub-url>`; or **run a hub** with `kandy hub --tailscale` or
  `deploy/try-hub.sh`. → [The three modes](https://github.com/hiteshbandhu/kandy/tree/main/apps/docs/modes/index.md)
- **Your notes run on your machine**, with your agents and logins, even on a
  shared board. A hub keeps the log and runs nothing — no agents, no keys, no
  repositories.
- **Identity from Tailscale.** No accounts or passwords: the tailnet says who you
  are. Requests with no identity (tagged devices) are refused, not trusted.
- **Owners, members, viewers**, with `kandy invite` and a Team page — people,
  machines, and who did what. The first person to open a hub owns it.
- **Consent at the edge.** A note someone sends to your machine waits for you:
  run it, always allow them, or decline. Only a machine's owner can answer for
  it, and only they can answer its agent's permission prompts.
- **Hand work to a teammate.** Give to… pushes your branch; their machine
  continues it, with a briefing for whichever agent they use. → [Handoff](https://github.com/hiteshbandhu/kandy/tree/main/apps/docs/modes/handoff.md)
- **Onboarding in one command.** `kandy join` checks reachability, identity,
  admission, agents and clones, says what to fix, and starts the runner.
- **A hub image**: Docker, with a Tailscale sidecar; no agents or git inside.
- **A published runner protocol**, with a conformance test.

### Agents reach more

- **MCP servers on the board**, given to Claude Code, Codex, Cursor and opencode
  in each one's own format, every run. Secrets are `${NAME}` and never leave the
  machine. → [Skills and MCP](https://github.com/hiteshbandhu/kandy/tree/main/apps/docs/guide/capabilities.md)
- **Skills**, installed with the `skills` CLI, with uncommitted ones flagged —
  a note runs in a checkout of git, so they'd reach no agent.
- **Change agent mid-note.** The next agent gets a [briefing](https://github.com/hiteshbandhu/kandy/tree/main/apps/docs/concepts/briefings.md),
  not a transcript.
- **Claude asks before running commands** under repo-only access, on the board.
- **Model menus from the agents themselves** — Codex and Cursor are asked which
  models your account can run.
- **Rate limits** for your Claude subscription, beside the agent.

### The terminal

- **`kandy` opens the board in your terminal** — run, steer, diff, merge, answer
  prompts and consent requests from the keyboard. → [The terminal board](https://github.com/hiteshbandhu/kandy/tree/main/apps/docs/guide/terminal.md)
- **First run asks one question** — just me, join a team, or start a hub — and
  never in a script. `kandy setup` asks again.
- **`kandy -h` is one screen**, with `kandy help <topic>` and
  `kandy <command> -h` for depth.
- **The real logo**, drawn in the terminal.

### Fixed

- `kandy "…"` now runs the note; without `--agent` it used to write a draft and
  stop.
- The daemon refuses reads from anywhere but this machine unless they bring a
  credential; before, anything that could reach the port could read every board.
- `kandy gc` reclaims `node_modules` and caches from notes in review, not only
  finished ones.
- A finished note's checkout is tidied away after its branch is pushed.

## 0.1.0-alpha.1

First tagged version. Alpha in the honest sense: it runs real work every day on
its own repository, and the parts that are unfinished are named below rather
than discovered.

Not published. Install it from a clone — `pnpm build`, then `pnpm link
--global` from `apps/server`.

### What works

- **Boards** point at a git repository. Notes are units of work with a
  lifecycle: draft → queued → running → review → done.
- **Isolation.** Every note runs in its own `git worktree` on its own branch, so
  several agents work the same repo at once without seeing each other's writes.
  Your working tree is never touched.
- **Workspaces are ready.** Gitignored paths are carried in by reference
  (`clonefile` on APFS, `--reflink` on Linux) and a setup command guessed from
  the repo's lockfiles runs before the agent arrives. Measured on this repo:
  worktree 0.07s, `pnpm install` 0.85s.
- **Agents.** Claude Code and Codex, written against their real captured output.
  Credentials are never read — the spawned CLI inherits your existing login.
- **Steering.** Send a message to a running agent, or queue a follow-up that
  resumes its session in the same worktree. Files can be attached.
- **Review.** A diff per file, then merge locally, open a PR, or discard. Each
  asks first, and says what will happen to that branch.
- **Cost.** Claude reports dollars; Codex reports tokens and is priced from the
  LiteLLM table. Which is which is tracked, so a mixed total says how much of it
  is estimated.
- **A CLI** — `kandy "do the thing"` from any repo — and a skill so other agents
  can queue work onto a board.

### Known gaps

- **`blocked` can be seen but not answered.** Refusals surface; you cannot
  approve one in flight. That needs the agent running in-process.
- **Only two agents.** Cursor, opencode, Gemini and Grok are named in the model
  but have no adapter.
- **No auth on the HTTP port.** It binds `127.0.0.1`, so nothing is exposed, but
  `--port` has no token yet.
- **No worktree GC.** Abandoned worktrees accumulate until a note is reviewed.
- **Codex cost is an estimate.** Codex reports no dollar figure, and a price
  table goes stale.
