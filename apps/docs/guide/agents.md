# Agents and models

kandy spawns the agent CLI you already installed and logged into. It never
reads, stores or forwards a credential — the child process inherits your login,
the same way a Makefile would.

## Supported today

**Claude Code** — the reference adapter. The prompt travels over stdin rather
than argv, because `--input-format stream-json` is what makes steering possible:
the same channel carries further turns. It is the only agent that accepts a
message mid-run.

**Codex** — speaks a thread/turn/item vocabulary rather than messages. It
reports tokens but no dollar figure, so cost is computed (see [Cost](/guide/cost)).
Its stdin is closed immediately after spawn; left open, it waits on
`Reading additional input from stdin…` forever.

**Cursor** — `cursor-agent -p`, sandboxed by the operating system rather than
by an approval mode, because `-p` already grants every tool. kandy always passes
`--trust`: without it Cursor refuses the worktree and exits *zero*, which is a
run that did nothing and reported success. Tokens but no dollar figure.

**opencode** — `opencode run --format json`. Provider-agnostic, so models are
addressed as `provider/model` and a run is priced by opencode itself when it has
a price. Your own `permission` config is what a repo-only note obeys; full access
is what overrides it.

**Aider** — no credential check at all: it configures its own provider, and
installed means available.

Gemini and Grok appear in the data model but have no adapter yet.

::: tip
Cursor and opencode cannot be steered mid-run and cannot be asked for
permission — neither CLI has a channel for it. A follow-up message becomes a
queued run that resumes the same session instead, and a refusal shows up on the
note as blocked rather than as a question.
:::

## Models

A model can be chosen in three places, most specific first:

1. **On the note** — pins that model for this job.
2. **On the board** — the default for each agent in this repo, in Settings.
3. **Neither** — the agent's own default.

The menu is built from the price table kandy already fetches, filtered to what
each agent can actually run. It is a menu, not a promise: the agent still
refuses one you have no access to.

Two agents are deliberately not filtered from that table. Cursor's catalogue is
its own and depends on your plan — `cursor-agent --list-models` is the only
authority on it — so kandy offers `auto` plus whatever Cursor is already
configured for, and you can type the rest. opencode addresses models as
`provider/model`, so its menu is the same set rewritten into that form. Neither
gets a default picked for it: both already resolve one from their own config,
and overriding a working choice with a guess off a price list helps nobody.

::: tip
Aliases come first for Claude — `opus`, `sonnet`, `haiku` — because an alias
keeps pointing at the current model when a new one ships, and a pinned id does
not.
:::

## Permissions

Two levels, per note:

- **Repo only** — the agent edits files freely. Most shell commands are refused,
  including the tests it just wrote.
- **Full access** — it can run anything.

A worktree bounds what an agent can damage *inside the repository*. It does
nothing about `$HOME` or the network, which is why full access is a decision
kandy asks you to make rather than one it makes for you.
