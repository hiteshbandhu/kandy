# Diagrams

[`01-architecture.md`](01-architecture.md) argues the shape. This file draws it, against the
code that exists today. Every box names a real file, so a diagram that drifts from the tree is a
diagram you can catch.

## 1. Processes

Only one process holds state. Everything else is a renderer or a child.

```
   your terminal              a browser tab              another agent
        │                          │                          │
  ┌─────┴──────┐            ┌──────┴──────┐           ┌───────┴───────┐
  │ kandy CLI  │            │  web board  │           │ `kandy skill` │
  │ apps/server│            │  apps/web   │           │  (MCP client) │
  │  /src/cli  │            │             │           └───────┬───────┘
  └─────┬──────┘            └──────┬──────┘                   │
        │  ┌─────────────┐         │                          │
        │  │ apps/tui    │─────────┤                          │
        │  └─────────────┘         │                          │
        │                          │                          │
        └──── HTTP POST ───────────┴───── GET /events (SSE) ───┘
                                   │
                    127.0.0.1:4477 │ bearer token, loopback only
        ┌──────────────────────────┴──────────────────────────────┐
        │  kandy daemon — one process, single writer               │
        │  apps/server/src/cli.ts `serve`                          │
        └──────────────────────────┬──────────────────────────────┘
                                   │ spawn, cwd = the note's worktree
        ┌──────────────┬───────────┴───────────┬──────────────┐
        ▼              ▼                       ▼              ▼
    claude -p      codex exec              aider …      permission-mcp.ts
   (stream-json)    (--json)                             (sidecar the agent
                                                          itself spawns)
```

The CLI starts the daemon for you if it isn't up (`cli/daemon.ts` `ensureUp`), detached, so the
shell that queued the note isn't what keeps the agents alive.

## 2. Inside the daemon

```
   POST /boards/… /notes/… /runs/…            GET /events
              │                                    ▲
              ▼                                    │ SSE frames
      ┌───────────────┐                     ┌──────┴───────┐
      │   http.ts     │                     │    bus.ts    │  in-process fan-out
      │  routes+auth  │                     │  Set<listener>│
      └───────┬───────┘                     └──────▲───────┘
              │ command                            │ publish
              ▼                                    │
      ╔═══════════════════════════════════════════════════════╗
      ║ engine.ts — the ONE place a state change happens       ║
      ║                                                       ║
      ║   append ──────────► apply ──────────► publish         ║
      ╚═══╪═══════════════════╪═══════════════════════════════╝
          │                   │
          ▼                   ▼
  ┌───────────────┐   ┌─────────────────┐
  │   store.ts    │   │  projection.ts  │  Map<boardId, BoardView>
  │  node:sqlite  │   │  folds each     │  replayed once at startup,
  │  append-only  │──►│  event via      │  incremental after that
  └───────────────┘   │  core/reduce.ts │
                      └─────────────────┘
          ▲                   ▲
          │ emit              │ reads view
  ┌───────┴───────────────────┴───────┐      ┌──────────────────────────┐
  │           runner.ts               │◄────►│     permission.ts        │
  │  slots, queue, child processes    │      │  holds the `ask` promise │
  └───────┬───────────────────────────┘      └──────────────────────────┘
          │
          ▼
  ┌───────────────┐   ┌──────────────┐   ┌──────────────┐  ┌─────────────┐
  │  worktree.ts  │   │  agents/*.ts │   │  forge.ts    │  │ prwatch.ts  │
  │  git plumbing │   │  adapters    │   │  `gh` CLI    │  │  polls PRs  │
  └───────────────┘   └──────────────┘   └──────────────┘  └─────────────┘
```

`Engine.emit` is append → apply → publish, in that order, always. Two call sites doing this by
hand is how a projection quietly drifts from its log.

## 3. The write path, end to end

```
 client            http.ts        engine.ts       store.ts     projection.ts     bus.ts
   │                  │               │               │              │             │
   │ POST /runs       │               │               │              │             │
   ├─────────────────►│               │               │              │             │
   │                  │ authorized()  │               │              │             │
   │                  │ runner.request│               │              │             │
   │                  ├──────────────►│               │              │             │
   │                  │               │ append ──────►│              │             │
   │                  │               │               │ seq = N      │             │
   │                  │               │◄──────────────┤              │             │
   │                  │               │ apply ───────────────────────►│            │
   │                  │               │               │   reduce(view, e)          │
   │                  │               │ publish ──────────────────────────────────►│
   │                  │               │               │              │             │
   │◄─ 200 {runId} ───┤               │               │              │             │
   │                                                                               │
   │◄══════ id: N  event: run.requested ═══════════════════════════════════════════┤
```

Every connected client gets frame N off the same bus. A reconnect sends `Last-Event-ID: N` and
`store.since(N)` replays the gap — no snapshot diffing, no reconciliation.

**Two kinds of frame go down that one wire** (`core/events.ts` `StreamFrame`):

| Frame | Durable? | Carries SSE `id:`? | Why |
| --- | --- | --- | --- |
| `KandyEvent` | `events` table | yes | it *is* the board's state |
| `TranscriptFrame` | `transcript` table | **no** | a reconnect must not replay megabytes of agent chatter |
| `ActivityFrame` | never stored | no | "running tests right now" is true for four seconds |

## 4. A note's life

```
  note.created ──► note.assigned ──► run.requested
                                          │
                        slot free? ───no──► queue[]
                                          │ yes
                                          ▼
                              worktree.ts createWorktree
                              .kandy/worktrees/<noteId>/
                              branch kandy/<noteId>-<slug>
                                          │
                                   runSetup (board.setup)
                                          │
                                          ▼
                              spawn(agent, { cwd: worktree })  ──► run.started
                                          │
                              ┌───────────┴────────────┐
                              │  stdout JSONL, line by │
                              │  line → adapter.parse  │
                              └───────────┬────────────┘
                                          │
              ┌──────────────┬────────────┼─────────────┬──────────────┐
              ▼              ▼            ▼             ▼              ▼
        run.output     TranscriptFrame  run.tool   run.metrics    run.blocked
        (output tbl)   (transcript tbl) Activity   (cost/tokens)  (§5)
                                          │
                                    child exits
                                          ▼
                          commitLeftovers ─► diffNumbers + diff
                                          ▼
                           run.finished ─► review.opened  (diffs table)
                                          │
                              ┌───────────┴───────────┐
                              ▼           ▼           ▼
                           merge       discard      revise
                     mergeBranch   deleteBranch   follow-up run,
                                                  same worktree,
                                                  resumed session
```

Steering a live note (`runner.steer`) either reaches the running agent on stdin or queues a
follow-up run in the *same* worktree with the session resumed — and the caller is told which,
because "it heard me" and "it will hear me next turn" feel like different products.

## 5. The permission loop

The one flow that leaves the daemon and comes back.

```
   agent wants `rm -rf build`
        │
        │ --permission-prompt-tool
        ▼
  permission-mcp.ts        ── a sidecar the agent spawns, JSON-RPC over stdio,
   (own tiny process)         zero dependencies; stdout is the protocol
        │
        │ POST /runs/:id/ask   (KANDY_TOKEN)
        ▼
  http.ts ──► permission.ts
        │
        │ pure decision first: core/permission.ts (tool, args, rules) → allow | deny | ask
        │
        ├─ allow/deny ──────────────────────────────► answer, immediately
        │
        └─ ask ──► promise held open
                     │  emit run.blocked { ask: true } ──► SSE ──► every client
                     │
                     │  someone clicks Allow  ──► POST /runs/:id/answer
                     │  nobody clicks         ──► ASK_TIMEOUT_MS (10 min)
                     ▼
              run.unblocked { decision: allow | deny | timeout }
                     │
                     ▼  resolves the promise → back down the sidecar → the agent continues
```

`timeout` is recorded as itself, not as a denial, so a transcript never implies a person made a
decision they didn't make.

## 6. Where bytes live

```
~/.local/state/kandy/
  kandy.db        events · transcript · diffs · output · shared      (WAL, node:sqlite)
  token           0600, bearer credential, survives daemon restarts

<your repo>/
  .kandy/worktrees/<noteId>/     one full checkout per running note
  branch kandy/<noteId>-<slug>   the deliverable; survives gc
```

Worktrees live inside the target repo — not in the state dir — so git object sharing works and
so you can find them without our help. `gc.ts` reclaims the checkouts of finished notes and
leaves every branch exactly where it is.

## 7. Package map

```
  packages/core  ─────────── the source of truth, depends on nothing
    domain · events · reduce · permission · api · position · id · attachments
        │
        ├──────────────► packages/client   typed KandyClient + SSE decoder
        │                      │
        │                      ├──────► apps/web    React board
        │                      ├──────► apps/tui    ANSI, read-only, same reducer
        │                      └──────► apps/server CLI talks to its own daemon
        │
        └──────────────► apps/server       validates against it, serves it
```

`reduce()` runs in three places — server projection, web app, TUI — and is the same function
each time. That is the anti-drift mechanism; nothing about the wire format is written twice.

## 8. File map

| Concern | File |
| --- | --- |
| Command routes, auth, SSE endpoint | `apps/server/src/http.ts` |
| Append → apply → publish | `apps/server/src/engine.ts` |
| SQLite tables and replay | `apps/server/src/store.ts` |
| Cached board views | `apps/server/src/projection.ts` |
| Fan-out to SSE listeners | `apps/server/src/bus.ts` |
| Slots, queue, child processes, steering | `apps/server/src/runner.ts` |
| git worktrees, branches, diffs, merge | `apps/server/src/worktree.ts` |
| Agent adapters + registry | `apps/server/src/agents/` |
| Held-open questions | `apps/server/src/permission.ts` |
| The sidecar agents call | `apps/server/src/permission-mcp.ts` |
| PRs via `gh`, and polling them | `apps/server/src/forge.ts`, `prwatch.ts` |
| Cost from tokens | `apps/server/src/pricing.ts` |
| Commit trailers and PR footers | `apps/server/src/attribution.ts`, `message.ts` |
| Reclaiming worktrees | `apps/server/src/gc.ts` |
| Not wired in — the share spike | `apps/server/src/share.ts` ([12](12-spike-git-share.md)) |
