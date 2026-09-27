# Agents

kandy doesn't have an AI of its own. It runs the coding agents you already use —
their CLIs, installed on your machine and signed in with your accounts — and
gives each one a note to do, in its own git worktree.

It never reads, stores or forwards a credential. It starts the agent's command,
and the agent uses the login it already has, the same way a script would.

## Which agents

| | [Claude Code](/agents/claude-code) | [Codex](/agents/codex) | [Cursor](/agents/cursor) | [opencode](/agents/opencode) | [aider](/agents/aider) |
| --- | --- | --- | --- | --- | --- |
| **How tested** | daily, on kandy itself | real runs | real runs | against its real output | against its real output |
| **Asks before running a command** | ✓ | — | — | — | — |
| **Message it while it runs** | ✓ | next turn | next turn | next turn | — |
| **Follow-ups resume its session** | ✓ | ✓ | ✓ | ✓ | — |
| **Skills and MCP servers** | ✓ | ✓ | ✓ | ✓ | — |
| **Cost** | dollars, from Claude | tokens, priced by kandy ≈ | tokens, priced by kandy ≈ | dollars, from opencode | dollars, when aider has a price |
| **Model menu** | a curated list | your account's models | your plan's models | your own list | your own list |
| **Plan limits shown** | ✓ | — | — | — | — |

"Next turn" means a message sent while it runs is delivered when the current
turn ends, as a follow-up in the same session — the CLI has no way to take one
mid-turn. `≈` marks a cost kandy estimated from a public price table; your
provider's billing is the source of truth.

**Start with Claude Code** if you're choosing: it's what kandy is built and
tested against every day, and the only agent that can stop and ask you before
running a command rather than failing.

Gemini and Grok are in kandy's data model but have no adapter yet.

## Is it ready?

```sh
kandy status
```

lists every agent as **ready**, **signed out** or **not installed**. "Ready"
means kandy found the agent's login where the agent keeps it — not that the
login still works. If a note fails at once with an authentication error, sign
in again ([troubleshooting](/guide/troubleshooting#an-agent-says-ready-but-every-run-fails)).

## Choosing one for a note

- `kandy "…" --agent codex` on the command line.
- The agent picker under the composer in the browser, or <kbd>r</kbd> on a note
  in the terminal board.
- With none given, the last agent used on this board — or the first one signed
  in.

A note can **change agent** between runs: finish with Claude, then have Cursor
continue. The next agent gets a [briefing](/concepts/briefings) — what was
asked, what was done and decided, what failed — rather than a transcript it
can't read.

## Models

A model can be chosen in three places, most specific first:

1. **On the note** — pins that model for this job.
2. **On the board** — the default for each agent in this repository, in
   **Settings → Models**.
3. **Neither** — the agent's own default.

The menu comes from the agents themselves wherever they'll say:

- **Codex** is asked over its app-server (`model/list`) — the models *your
  account* can run, and nothing it has hidden.
- **Cursor** is asked with `cursor-agent models`, which depends on your plan.
- **Claude Code** has no way to list its models, so kandy keeps a short list of
  what the CLI accepts — aliases first.
- **Any agent** — add your own model ids and they're offered beside the rest.

Each list is cached for an hour and refreshed in the background, so a menu never
waits on the network. It's a menu, not a promise: an agent can still refuse a
model your account can't use.

::: tip
Aliases come first for Claude — `opus`, `sonnet`, `haiku` — because an alias
keeps pointing at the current model when a new one ships, and a pinned id does
not.
:::

## Access

Two levels, per note — and a default per board in **Settings → Agent access**.
New boards get full access unless you picked repo only at setup (`kandy setup`)
or in the **New board** dialog.

- **Full access** (the default) — it can run anything, without asking: the
  agent's own "skip permissions" mode.
- **Repo only** — the agent edits files freely in its worktree.
  Shell commands are put to you first by Claude Code, and refused outright by
  agents that can't ask — the note then shows as **blocked**, with a one-click
  way to continue with full access.

<p class="k-shot"><img class="only-light" src="/shots/site/askpane-light.webp" alt="A note waiting on you: the agent asks to run a shell command, with Allow once and Deny"><img class="only-dark" src="/shots/site/askpane-dark.webp" alt="A note waiting on you: the agent asks to run a shell command, with Allow once and Deny"></p>

A worktree bounds what an agent can damage *inside the repository*. It does
nothing about your home directory or the network, which is why full access is a
decision kandy asks you to make rather than one it makes for you. Each agent's
page says exactly what the two levels mean for it.
