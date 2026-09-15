# Agents, auth, and the policy question

## The mechanism

We spawn the user's already-installed CLI as a child process. It inherits the environment, and
therefore inherits whatever credential the user already logged in with. We never read a token,
never store one, never transmit one.

We do now read the **metadata beside** the tokens — when the sign-in expires and which plan it is
on — and nothing else. The reason is that existence was not enough: a credential file outlives the
credential inside it, so an expired Claude Code sign-in still looked ready and the first sign of
trouble was a run failing. Two fields, no secrets:

| Agent | Read | Not read |
| --- | --- | --- |
| Claude Code | `claudeAiOauth.refreshTokenExpiresAt`, `subscriptionType` | `accessToken`, `refreshToken` |
| Codex | `auth_mode`, and whether `OPENAI_API_KEY` is set | `tokens.*` |

**Source order matters, and getting it wrong shipped a false alarm.** On macOS the live
credential is in the Keychain (`Claude Code-credentials`) and `~/.claude/.credentials.json` is
left behind from before Claude Code moved. Reading the file first reported a sign-in that had
expired a month earlier while the real one had another fortnight on it — telling a signed-in
person to sign in again, which is worse than not checking. The Keychain is consulted first and the
file only when it yields nothing, so a relic can never outvote the credential in use.

Reading the Keychain item is silent: it is the user's own item and `security` hands it over
without a prompt. If it ever refuses, the answer is null.

[T3 Code declines to probe for this at all](https://github.com/pingdotgg/t3code/issues/7878) —
Claude Code's local init succeeds on cached credentials, so their reliable signal is a 401 at run
time. They are right that a file is a guess, so kandy does both.

## The certain signal: a run that was refused

`isAuthFailure` in core reads an agent's failure text, and a match marks that agent as rejected
until one of its runs completes. It outranks everything above: a credential that looks fine proves
nothing, a run that actually tried and was refused proves quite a lot.

Two things this had to get right, and both were found by running it rather than reading it.

**Either pipe.** Claude Code reports the refusal as a JSON error on stdout, which becomes a
transcript frame. A CLI that has simply lost its login writes to stderr and exits — and stderr is
deliberately kept out of the transcript, so watching only transcript frames missed that kind
entirely. Both are watched now.

**Narrowly.** On the board this was written against, one error frame in ten was an auth failure;
the rest were a failed `git worktree add`, an unsupported model, and a hook-trust warning.
Matching "failed" or "token" would have sent someone to re-login over a git error — the same false
alarm as trusting a stale credential file, which this file already has one story about.

The state is in memory, not the log. It is an observation about this machine now, not a fact about
the board, and a restart should re-learn it rather than repeat a stale warning.

Codex records no expiry. kandy reports `expiresAt: null` there rather than deriving one from
`last_refresh`, because a guess wearing a timestamp is worse than saying nothing: null means "it
did not say", never "it is fine".

Observed credential locations:

| Agent | Credential |
| --- | --- |
| Claude Code | macOS Keychain (`Claude Code-credentials`); `~/.claude/.credentials.json` elsewhere |
| Codex | `~/.codex/auth.json` (`$CODEX_HOME`), mode 0600 |
| Cursor | `~/.cursor/` — exact file undocumented |
| opencode | `~/.local/share/opencode/auth.json`, mode 0600, plaintext |
| Gemini | `~/.gemini/oauth_creds.json` |
| Grok Build | `~/.grok/auth.json`, mode 0600 |

This is the cleanest possible position: the credential never enters our process.

## The policy question — read this before building the pitch

**Anthropic reportedly restricted third-party wrapping of Claude Code's subscription OAuth
(~Feb 2026)**, limiting subscription auth to Claude Code and claude.ai themselves. The
sanctioned path for a third-party orchestrator is a user-supplied `ANTHROPIC_API_KEY`.

*This is reported, not confirmed from primary source.* It needs verifying against Anthropic's
current Usage Policy and Claude Code terms **before** it is load-bearing for the product
narrative, because it changes the answer to "does my Claude Max subscription work in kandy."

The other providers are less clear-cut. OpenAI, Google, and xAI terms center on not reselling
or pooling one subscription across many users — which a single-user local orchestrator
plausibly does not do. But none of them explicitly blesses "wrap me in your product," and
absence of prohibition is not permission.

**Practical stance for v1:**

- Support `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / etc. as a first-class, documented path.
- Spawn the user's CLI as-is when it is present — we are invoking a tool the user installed on
  their own machine, the same way a Makefile would.
- Never re-implement or proxy a provider's OAuth flow ourselves. That is the line that
  separates "a tool that runs your tools" from "a client pretending to be another client."
- Make the agent layer pluggable so a provider becoming unavailable is a config change, not a
  rewrite. **Do not build a business that depends on exactly one provider's goodwill.**

## Adapter notes

**Claude Code** — `-p --output-format stream-json --verbose`. The `--verbose` flag is
*required* for line-by-line streaming; without it output buffers to the end. Session id arrives
in the `system`/`init` event. `--resume <uuid>`, and `--session-id` can pre-assign an id.
`@anthropic-ai/claude-agent-sdk` is the more idiomatic TS integration than parsing stdout.

**Codex** — `codex exec --json`, `--output-last-message <file>` for just the final answer,
`-s read-only|workspace-write|danger-full-access` for its own sandboxing. Session id cannot be
pre-assigned; capture it from the stream. Resume via `codex exec resume <id>`.

The `codex exec --json` event vocabulary:

- `thread.started` carries `thread_id`, the session id used for
  `codex exec resume <thread_id>`.
- `turn.completed` carries a `usage` object with `input_tokens`,
  `cached_input_tokens`, and `output_tokens`.
- Items arrive as `item.started` / `item.completed`, with `item.type` of
  `agent_message`, `command_execution`, `file_change`, `reasoning`, or `error`.
- Codex refusals appear as a `command_execution` item with a non-zero `exit_code`,
  not as a distinct event type.

Codex reports tokens but no dollar cost.

**Cursor** — `cursor-agent -p --output-format stream-json --trust`. Events: `system`,
`thinking`, `assistant`, `tool_call`, `result`. Session id arrives on the `system`/`init`
frame and on every line after it; resume via `--resume <chatId>`.

`--trust` is not optional. Cursor refuses an untrusted workspace by printing
`⚠ Workspace Trust Required` and exiting **zero** — a run that did nothing and looked like a
success. kandy spawns into a worktree the user already asked an agent to work in, so the
decision was made before the process started. The banner is parsed anyway: a flag can be
dropped by a future version, and a silent no-op must not be silent twice.

`-p` already grants every tool including write and shell, so an approval mode is not what
repo policy buys — the OS sandbox is. Repo passes `--sandbox enabled`; full access passes
`--force --sandbox disabled`. A refusal therefore arrives as an ordinary non-zero exit with
the operating system's phrasing on stderr, so — as for Codex — an actual failure is required
before the wording is consulted at all.

A tool's identity is the *key* inside `tool_call`, not a field: `{ shellToolCall: { args,
result } }`. The name is derived from the key so a tool Cursor adds later still appears.
`result` is `{ success }` or `{ failure }`. Cursor reports tokens but no dollar figure, and
unlike Codex its `inputTokens` *excludes* the cache buckets, so they add rather than subtract.
The model on the init frame is a display name — "Cursor Grok 4.6 High Fast" — never a model
id, so it is not used to price anything.

**opencode** — `opencode run --format json`. Every line is one flat object,
`{ type, timestamp, sessionID, ...data }`, with types `step_start`, `text`, `reasoning`,
`tool_use`, `step_finish` and `error`. Session id is `sessionID`, camel-cased, on every line;
resume via `-s <id>`.

This is *not* the `opencode acp` route sketched earlier in this document. Agent Client
Protocol is bidirectional JSON-RPC and needs a stateful client that answers requests; the
`AgentAdapter` contract here is one line of stdout in, zero or more events out. Adopting ACP
means reshaping that contract — worth doing as the reference adapter, but it is a change to
how every agent is driven, not the addition of one. `run --format json` is defined in
opencode's own `packages/opencode/src/cli/cmd/run.ts` and fits the contract as it stands.

Two consequences of that file worth knowing. `tool_use` is only emitted once a call has
completed or errored, so there is no started frame to pair with and none is invented.
And a permission refusal never becomes JSON at all — opencode prints
`! permission requested: <permission> (<patterns>); auto-rejecting` as prose on the same
stdout and carries on, so the adapter matches that whole phrase to recover the block.

opencode's default is to allow, and `--auto` additionally approves whatever the user's own
config marks `ask`. Repo policy therefore means "the user's permission rules stand"; full
access is what overrides them. Explicit `deny` rules survive either way — opencode enforces
those itself. It computes its own cost from models.dev prices, which beats anything kandy
could derive, except that a subscription or a local model reports `0.00` and zero is
indistinguishable from free; a zero cost is handed back unpriced, with the tokens, rather
than recorded as a run that cost nothing.

**Gemini** — `gemini -o json`. Known gap: headless JSON output does not reliably surface the
session id, so resume is unreliable. Ship it without resume rather than faking it.

**Grok Build** — `grok -p --output-format streaming-json`; NDJSON events `step_start`, `text`,
`tool_use`, `step_finish`, `error`. Requires a SuperGrok/X Premium+ subscription.

**Aider** — `aider --message <prompt> --yes-always --no-pretty --no-stream`.
The adapter leaves provider configuration and authentication to the child and
checks no credential files. Installed means available; provider authentication
is validated by aider when it runs. The model defaults to aider's own configured
choice. Auto/dirty commits are disabled. Repo policy also disables suggested
shell commands, automatic linting and automatic tests; aider has no OS sandbox.
Live steering and session-ID resume are not supported by this adapter.

Plain output is preserved as transcript text, with applied edits normalized to
tool frames. Token counts use aider's rounded sent/received figures. Per-message
costs accumulate; cumulative session costs are ignored. Split token/cost lines
are emitted separately without counting tokens or turns twice. Process exit,
not a usage summary, finishes the run. Output formats follow
[aider's implementation](https://github.com/Aider-AI/aider/blob/main/aider/coders/base_coder.py)
and flags follow its [scripting interface](https://aider.chat/docs/scripting.html).

## What this means for the Usage page

Every agent kandy ships an adapter for is normally used on a plan — Claude Code on a
subscription, Codex on a ChatGPT account, Cursor and opencode on theirs. On a plan there is no per-token bill, so **no figure on
the Usage page is a charge anyone makes.**

On top of that, only Claude reports a dollar amount for a turn at all. Codex reports tokens and
kandy prices them from a rate table, which is arithmetic on an assumed rate for a model kandy may
not even know: of 24 Codex runs on this repo's own board, zero carried a cost from the agent and
seventeen carried no model either.

kandy used to mark the derived ones with a `≈`. That drew the wrong line — it implied the
unmarked figures were exact when none of them is a bill. Usage says it once, in a sentence, and
the numbers are left clean. `costSource` is still recorded per run, because provenance is worth
keeping even when it is not worth printing on every row.
