# Board settings

Every repository kandy works on is a **board**, and each board has its own
settings. Open them in the browser — `kandy open`, then **Settings** in the
sidebar. Skills and MCP servers can also be managed from the terminal.

Settings apply to notes as they start, so a change takes effect on the next run
— nothing needs restarting.

## Appearance

**System**, **light** or **dark**. kandy follows your system unless you choose.
This one is per browser, not per board.

## Models

The model each agent runs on this board. Leave it blank for the agent's own
default. A note can still pick its own, which wins.

The menus come from the agents themselves where they can say — see
[Models](/agents/#models).

## Agent access

What a new note on this board starts as:

| | What it means |
| --- | --- |
| **Full access** (default) | Notes can run any command, without asking — each agent's own "skip permissions" mode. |
| **Repo only** | The agent edits files in its worktree. Anything else — running tests, installing, a build — is asked about first by Claude Code, and refused by agents that can't ask. |

A new board starts with what you chose when you first ran kandy (`kandy setup`
asks again), or in the **New board** dialog — full access if you never chose.
Switching an existing board to full access asks you to confirm first.

A note can be changed on its own at any time, and notes already on the board
keep what they have. Each [agent's page](/agents/) says exactly what the two
levels mean for it.

## Workspace

Every note runs in a fresh git worktree — a new checkout of your repository on
the note's branch. A fresh checkout has none of what git ignores: no
`node_modules`, no `.env`, no build cache. These two settings make it ready
before the agent arrives.

### Setup command

Runs in each new worktree before the agent starts. It's guessed when the board
is created, from what's in the repository:

| If the repository has | kandy runs |
| --- | --- |
| `pnpm-lock.yaml` | `pnpm install --prefer-offline` |
| `yarn.lock` | `yarn install --prefer-offline` |
| `bun.lock` or `bun.lockb` | `bun install` |
| `package-lock.json` | `npm ci --prefer-offline` |
| `package.json`, no lockfile | `npm install --no-package-lock` |
| `uv.lock` | `uv sync` |
| `poetry.lock` | `poetry install` |
| `Cargo.toml` | `cargo fetch` |
| `go.mod` | `go mod download` |
| none of these | nothing |

Change it to anything a shell can run — `pnpm install && pnpm build`, say, if
agents need built packages. The stream shows it running
(`preparing workspace: …`) and how long it took. If it fails, the note fails
before the agent starts, with the command and its exit code; run it in your own
checkout to see why.

It runs once per worktree, not on every follow-up — and again if `kandy gc`
has since reclaimed the note's `node_modules`.

### Carried files

Files and folders git ignores, copied into each new worktree — secrets and
caches your code needs but git deliberately doesn't track. Comma-separated.
Guessed when the board is created, from those that exist:

`.env`, `.env.local`, `.env.development`, `.env.development.local`, `.turbo`,
`.nx`

They're copied **by reference** where the disk allows it — a clone on macOS
(APFS) and on Linux filesystems with reflinks — so even a large cache costs
almost nothing until something changes it.

::: warning
Carried files end up where the agent can read them. Carry `.env` only if you're
comfortable with the agent seeing what's in it.
:::

## Capabilities

What agents on this board can reach beyond its files.

- **Skills** — instructions an agent loads when a task calls for them. They live
  in the repository, in `.agents/skills`, and reach a note only once they're
  committed.
- **MCP servers** — tools every agent on the board can call, handed to each
  agent in its own format, every run. Secrets are written as `${NAME}` and
  filled in from each machine's own environment, so the board never holds one.

From the terminal:

```sh
kandy skills                            # what's here, and which runs can see it
kandy skills add <owner/repo>           # install one for every agent
kandy skills commit                     # commit the ones no run can see yet
kandy mcp                               # the board's MCP servers
kandy mcp add github --env 'GITHUB_TOKEN=${GITHUB_TOKEN}' -- npx -y @modelcontextprotocol/server-github
kandy mcp add linear --url https://mcp.linear.app/mcp --header 'Authorization: Bearer ${LINEAR_TOKEN}'
kandy mcp rm linear
```

The whole story, including which agents get what, is in
[Skills and MCP servers](/guide/capabilities).

## Attribution

Whether kandy signs the work it produces. **Both are off**, and stay off unless
you turn them on.

- **Commit trailers** — adds `Kandy-Note`, `Kandy-Run`, `Kandy-Agent` and a
  `Co-Authored-By` naming the agent to the commits kandy makes. These are
  permanent: they stay in your history, survive rebases, and a repository with
  commit linting or a DCO check may reject them.
- **Pull request footer** — adds a line to PR descriptions saying which agent
  and model wrote the branch. Cosmetic: anyone can edit it out, and nothing is
  written to your history.

## Repository

Where the board's work happens, and **Remove board** — which forgets the board,
its notes and any leftover worktrees. The repository itself, and anything you
already merged, is untouched. Running `kandy` in the repository
again makes a fresh board.

## Settings that aren't per board

| Setting | Where |
| --- | --- |
| How many notes run at once | `kandy serve --slots N` (default 4) |
| kandy's port | `kandy serve --port N` (default 4477) — pass the same `--port` to every command |
| Who may run notes on your machine, on a team | `kandy consent` — see [Who decides what](/modes/permissions) |
| Just me, or a team | `kandy setup` |
| Your own board while on a team | `KANDY_LOCAL=1 kandy …` |
| Skip the first-run question | `KANDY_NO_SETUP=1` |
| No colour in the terminal | `NO_COLOR=1` |
