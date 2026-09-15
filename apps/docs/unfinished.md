# What's unfinished

kandy is alpha. It runs real work every day on its own repository, and these are
the parts that do not work yet — named here rather than left to be discovered.

## A refusal can be seen and escalated, but not answered

When an agent is refused something, kandy shows what was refused — the exact
command — and offers to grant that note full access and continue it in the same
worktree. That is a decision you make once, after the fact.

What it still is not: a prompt that stops and asks you, with the choice a
terminal would give you. The agent has already moved on by the time you see it,
and "allow everything from here" is a blunter answer than "allow this one
command."

This used to be described here as an architectural fork requiring the agent to
run in-process. That was wrong, and the correction is worth stating plainly:
Claude Code takes `--permission-prompt-tool`, which routes prompts to a tool of
our choosing rather than auto-denying them. The work is real but it is a
feature, not a rewrite. Codex's non-interactive `exec` has no equivalent, so
this will land for one agent before the others.

## Five agents, and not all of them proven

Claude Code and Codex are used daily.

The Cursor adapter is written and tested against output captured from a real
`cursor-agent` run — including a real sandbox refusal — and detection was
exercised against a real sign-in. It has not yet driven a note end to end
through kandy's own runner.

The aider and opencode adapters have never driven a real install: neither was
present on the machine they were built on. aider was written against captured
output; opencode was written against its own `run.ts`, which defines the
`--format json` wire format, rather than against docs — but source is not a run,
and the first real one will find something.

opencode is also driven the plain way, over `run --format json`, not over
`opencode acp`. ACP is bidirectional JSON-RPC and wants a stateful client;
`AgentAdapter` is a line in and events out. Making ACP the reference adapter is
still the right shape, and it is a change to how every agent is driven rather
than a sixth adapter.

Gemini and Grok appear in the data model and the UI and do nothing.

## Codex cost is an estimate

Codex reports tokens and no dollar figure. kandy prices those against a table
that will go stale. Everywhere such a number appears it is marked `≈`, and any
total says how many runs were unpriced — but for anything that matters, check
your provider's billing.

## Notes cannot be reordered meaningfully

Fractional indexing is implemented and works, but the triage list sorts by
urgency, so manual ordering has nowhere to show. It matters if a board view
comes back.

## No sync, and a spike that says why it is hard

One daemon owns the state. Clients are views. That is correct for the local case
and wrong for anything else — offline editing, two people on one board, or a
board that exists without a daemon running.

There is a spike for sharing a board over a git orphan branch, and its finding
is the useful part: the transport holds and is boring, and the product around it
does not. A note handed to a teammate arrives with a branch and a diffstat but
no reachable diff, because the worktree path is a lie on their disk. Review is
the whole point of a handoff and it is the step that does not survive the trip.

## A daemon restart kills running agents

Agents are child processes of the daemon. Restart it — to pick up a new build,
say — and every run in flight dies. Startup reconciliation marks them failed
rather than leaving the board lying about it, and the worktree survives so the
note can be resumed, but the turn is lost.

## What is no longer here

Two entries were on this page this morning and are not any more: the HTTP port
had no authentication, and worktrees were never collected. Both shipped — the
daemon mints a token for writes, and `kandy gc` reclaims checkouts from finished
notes.
