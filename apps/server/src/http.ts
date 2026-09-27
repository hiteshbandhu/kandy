import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import {
  between,
  checkMcpServers,
  event,
  ROLES,
  type ActorId,
  type Hello,
  type Role,
  type LogBatch,
  type Reply,
  id,
  isEphemeral,
  notesIn,
  type AgentId,
  type BoardView,
  type ErrorCode,
  type StreamFrame,
} from "@kandy/core"
import type { PrWatch } from "./prwatch.js"
import type { Permissions } from "./permission.js"
import type { Workshop } from "./workshop.js"
import { isBundleAsset, serveStatic } from "./static.js"
import { kandyVersion } from "./version.js"
import { computeStats } from "./stats.js"
import type { Engine } from "./engine.js"
import { coerceAttribution, commitTrailers, prBody } from "./attribution.js"

import { authorized } from "./auth.js"
import type { Identity } from "./identity.js"
import type { Members } from "./members.js"
import type { Runners } from "./hub.js"

const VERSION = kandyVersion()
const STARTED = Date.now()

/**
 * Hosts this daemon will answer to, beyond its own loopback names.
 *
 * Configuration rather than a constant, because every way of reaching kandy
 * from somewhere else arrives under a name that is not `localhost` — a
 * tailnet's `laptop.tailnet.ts.net`, a tunnel's hostname, a hub. The
 * allowlist was written to defeat DNS rebinding and it still does; what it
 * must stop doing is deciding, as a side effect, that remote access is
 * impossible.
 *
 * Parsed here and passed in by the CLI rather than read from the environment
 * where it is used: a module-level `process.env` read happens once at import,
 * which no test can arrange after the fact, and the rule it decides is one
 * that badly wants testing.
 */
export function parseHosts(spec: string | undefined): Set<string> {
  return new Set(
    (spec ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  )
}

/** Whether the Host header names this machine, rather than a route to it. */
export function isLoopbackHost(host: string, port: number | undefined): boolean {
  const h = host.toLowerCase()
  for (const name of ["127.0.0.1", "localhost", "[::1]"]) {
    if (h === `${name}:${port}` || h === `${name}:5477`) return true
  }
  return false
}

/** Host must match a loopback name on our port, or be named in `KANDY_HOSTS`. */
export function allowedHost(host: string, port: number | undefined, extra: ReadonlySet<string>): boolean {
  const h = host.toLowerCase()
  // A configured host may be given with or without its port; comparing both
  // ways keeps `KANDY_HOSTS=hub.example.com` working behind a proxy on 443.
  if (extra.has(h) || extra.has(h.replace(/:\d+$/, ""))) return true
  return isLoopbackHost(h, port)
}

/**
 * Whether the socket's peer is this machine.
 *
 * Node reports an IPv4 peer on a dual-stack listener as `::ffff:127.0.0.1`,
 * so the mapped form has to be understood or every request looks remote. An
 * address we cannot read at all is treated as remote: the failure that costs
 * a token is better than the one that skips the check.
 */
export function isLoopback(address: string | undefined): boolean {
  if (!address) return false
  const a = address.startsWith("::ffff:") ? address.slice(7) : address
  return a === "::1" || a === "127.0.0.1" || a.startsWith("127.")
}

export type ServerDeps = {
  engine: Engine
  /**
   * The machine that holds the repositories and runs the agents.
   *
   * Everything a route needs from a checkout, a CLI or the local disk goes
   * through here and nowhere else, so this file can one day answer from a hub
   * that has none of those. See `workshop.ts`.
   */
  workshop: Workshop
  prs: PrWatch
  token: string
  /** Absent when the daemon was built without a way to ask. */
  permissions?: Permissions
  /** Extra Host names to answer to, from `KANDY_HOSTS`. */
  hosts?: ReadonlySet<string>
  /**
   * A hub's parts. All absent on `kandy serve`, which is one person on one
   * machine and has nobody to tell apart.
   *
   * `identity` says who a request is from; `members` says whether they are on
   * the team and what they may do; `runners` is who is connected; and
   * `workshopFor` builds a workshop that knows who is asking, because "your
   * own machine" means nothing without a "you".
   */
  identity?: Identity
  members?: Members
  runners?: Runners
  workshopFor?: (actor: ActorId | null) => Workshop
  /** Stamped on every event this request emits. Set per request, never passed in. */
  actor?: ActorId | null
}

const EMPTY: ReadonlySet<string> = new Set()

export function createHttpServer(deps: ServerDeps) {
  return createServer((req, res) => {
    void handle(deps, req, res).catch((err) => {
      /*
       * A status on the error is a failure that means something — a hub whose
       * runner is offline is a 503, a note placed nowhere is a 409 — and the
       * person asking should get that, not "internal". Only an error that
       * carries no status is a bug of ours.
       */
      const status = (err as { status?: unknown }).status
      if (typeof status === "number" && status >= 400 && status < 600) {
        if (res.headersSent) return void res.end()
        return send(res, status, {
          ok: false,
          error: { code: status === 403 ? "forbidden" : status === 404 ? "note_not_found" : "bad_request", message: (err as Error).message },
        })
      }
      console.error("[http]", err)
      if (res.headersSent) return void res.end()
      send(res, 500, { ok: false, error: { code: "internal", message: String(err) } })
    })
  })
}

async function handle(deps: ServerDeps, req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://localhost")

  // The web client always talks to "/api". In dev that is a Vite proxy; when
  // the daemon serves the bundle itself it is the same origin. Stripping the
  // prefix here means the client needs no knowledge of which it is.
  const apiPath = url.pathname.startsWith("/api/")
    ? url.pathname.slice(4)
    : url.pathname === "/api"
      ? "/"
      : null
  const routed = apiPath ?? url.pathname
  const parts = routed.split("/").filter(Boolean)

  // No cross-origin API access. The development UI uses Vite's /api proxy.
  // Validate Host too: a rebound attacker hostname must not expose the token.
  const port = req.socket.localPort
  const host = req.headers.host ?? ""
  const origin = req.headers.origin
  /*
   * Same host, either scheme. Behind `tailscale serve` the page is https and
   * the browser's own requests say so; comparing against http alone turned
   * the hub's first real deployment into a blank page, its script and
   * stylesheet refused as foreign. The Host is already checked, so the
   * scheme adds nothing an attacker could use.
   */
  const sameOrigin = origin === undefined || origin === `http://${host}` || origin === `https://${host}`
  if (!allowedHost(host, port, deps.hosts ?? EMPTY) || !sameOrigin) {
    return send(res, 403, { ok: false, error: { code: "forbidden", message: "Untrusted origin or host" } })
  }
  if (req.method === "OPTIONS") return void res.writeHead(204).end()

  /*
   * Where the request came in, which decides what it may do without a token.
   *
   * Until now the answer was "anything, as long as it only reads": writes
   * checked the bearer and reads checked nothing, so `GET /boards`,
   * `GET /events` and `GET /repo/browse` each answered an anonymous caller in
   * full — every board, the live transcript stream, and the name of every
   * repository on the disk. What stood between that and the network was the
   * Host allowlist above, and the whole point of `KANDY_HOSTS` is that a hub
   * or a tunnel will one day need it opened.
   *
   * So the two change together. On loopback nothing here is new — that is the
   * single-player daemon, and the token is handed to any same-origin fetch on
   * this machine anyway, so demanding it back would be ceremony. Off loopback
   * the default is deny, for reads as much as writes.
   *
   * The socket alone cannot answer this, and that is the whole subtlety. A
   * reverse proxy dials the backend from the backend's own machine, so with
   * `tailscale serve` in front every request on the tailnet arrives from
   * 127.0.0.1 and would be waved through — the entire tailnet reading every
   * transcript, which is exactly the hole this gate was opened to close.
   * Tailscale's own identity headers do not save us either: they are
   * populated for users and not for tagged devices, so a tagged node is
   * indistinguishable from localhost by header as well.
   *
   * What a proxy does carry through is the name the caller asked for. So both
   * have to agree: the peer is this machine *and* it was addressed as this
   * machine. A request that arrived as `laptop.tailnet.ts.net` is remote,
   * however local its socket looks.
   */
  const local = isLoopback(req.socket.remoteAddress) && isLoopbackHost(host, port)

  /*
   * Who is asking, on a hub that can tell.
   *
   * Off this machine, a hub with an identity provider takes nothing else: not
   * the bearer token, which never leaves the box, and not a claim in the
   * request. Tailscale says who it is, the member list says whether they are
   * on the team, and the role says what they may do. Someone the tailnet let
   * through but no owner has admitted is told exactly who they are and who to
   * ask — an empty board would be a worse answer.
   */
  let actor: ActorId | null = null
  if (deps.identity && deps.members && !local) {
    const person = deps.identity.identify(req)
    if (!person) {
      return fail(
        res,
        401,
        "unauthorized",
        "no Tailscale identity on this request. Tagged devices and anything that did not come through tailscale serve are refused.",
      )
    }
    const role = deps.members.arrive(person)
    if (!role) {
      /*
       * On the tailnet, not on the team — yet. Two questions still get an
       * answer, because the rest of onboarding depends on them: who am I
       * (so the page and `kandy join` can say "you are bob@…, ask alice@…"),
       * and the empty token the web app needs to load far enough to say it.
       * The owners are named because "ask an owner" is useless without a
       * name, and everyone asking is already on the company's network.
       */
      // The app itself, too: it is a public build artifact, and without it
      // there is no page to say any of this on. Only real files in the build
      // — a bare API path like `/boards` is not one, even without `/api`.
      if (req.method === "GET" && apiPath === null && isBundleAsset(url.pathname)) {
        return void serveStatic(url.pathname, res)
      }
      if (req.method === "GET" && (routed === "/me" || routed === "/auth/token")) {
        res.setHeader("Cache-Control", "no-store")
        const owners = deps.members.list().filter((m) => m.role === "owner").map((m) => m.email)
        return send(
          res,
          200,
          routed === "/me"
            ? { hub: true, email: person.email, name: person.name, role: null, admitted: false, owners }
            : { token: "", identity: { email: person.email, name: person.name, role: null } },
        )
      }
      return fail(res, 403, "forbidden", `you are ${person.email}, and nobody has added you to this hub yet — ask one of its owners`)
    }
    actor = person.email
    if (routed === "/auth/token") {
      // The identity is the credential here, so there is no token to hand
      // over — and the one this hub has never leaves the machine.
      res.setHeader("Cache-Control", "no-store")
      return send(res, 200, { token: "", identity: { email: person.email, name: person.name, role } })
    }
    const reads = req.method === "GET" || req.method === "HEAD"
    if (!deps.members.allows(actor, reads ? "board:read" : "board:write")) {
      return fail(res, 403, "forbidden", `a ${role} can look but not change anything here`)
    }
  }

  if (req.method === "GET" && routed === "/auth/token") {
    // Never off-machine: this is the credential itself, and a caller that
    // reached us from elsewhere has no claim on it.
    // Custom headers require preflight cross-origin, which we never allow.
    if (!local || req.headers["x-kandy-client"] !== "web" ||
        (req.headers["sec-fetch-site"] !== undefined && req.headers["sec-fetch-site"] !== "same-origin")) {
      return send(res, 403, { ok: false, error: { code: "forbidden", message: "Same-origin client required" } })
    }
    res.setHeader("Cache-Control", "no-store")
    return send(res, 200, { token: deps.token })
  }

  // The bundle bootstraps the UI that then authenticates, so it is served to
  // anyone the Host allowlist let through. It is a public build artifact; the
  // data behind it is what this gate protects.
  const reading = req.method === "GET" || req.method === "HEAD"
  const open = reading && (routed === "/health" || (apiPath === null && isBundleAsset(url.pathname)))

  if (actor === null && !open && !(local && reading) && !authorized(req.headers.authorization, deps.token)) {
    res.setHeader("WWW-Authenticate", "Bearer")
    return send(res, 401, { ok: false, error: { code: "unauthorized", message: "Valid bearer token required" } })
  }

  // Everything below sees who is asking, and a workshop that knows it.
  deps = {
    ...deps,
    actor,
    workshop: deps.workshopFor ? deps.workshopFor(actor) : deps.workshop,
  }

  if (routed.startsWith("/runner/") && deps.runners) {
    return runnerRoute(deps, deps.runners, routed, req, res, url, actor)
  }

  // GET /me — who this request is, and what this hub is. Answers on every
  // daemon, so a client can ask without first knowing which kind it has.
  if (req.method === "GET" && routed === "/me") {
    return send(res, 200, {
      hub: Boolean(deps.runners),
      email: actor,
      role: deps.members?.roleOf(actor) ?? null,
      // Past the gate means admitted: a single-player daemon and a token hub
      // have nobody to keep out.
      admitted: true,
      owners: deps.members?.list().filter((m) => m.role === "owner").map((m) => m.email) ?? [],
    })
  }

  // GET /activity — who did what lately, newest first. Empty on `kandy serve`,
  // where nobody is named.
  if (req.method === "GET" && routed === "/activity") {
    return send(res, 200, { events: deps.engine.store.attributed(Number(url.searchParams.get("limit") ?? 50) || 50) })
  }

  // GET /runners — every machine that has said hello, and whether it is here now.
  if (req.method === "GET" && routed === "/runners") {
    return send(res, 200, { runners: deps.runners?.list() ?? [] })
  }

  // A hub with no identity has nobody to tell apart: whoever holds its token
  // is the one person. Said as an answer, not a missing route.
  if (routed === "/members" && deps.runners && !deps.members) {
    if (req.method === "GET") return send(res, 200, { members: [], identity: false })
    return fail(res, 400, "bad_request", "this hub has no identity to add people by — start it with `kandy hub --tailscale`")
  }

  // GET /members, POST /members — who is on this hub.
  if (routed === "/members" && deps.members) {
    if (req.method === "GET") return send(res, 200, { members: deps.members.list(), identity: true })
    if (req.method === "POST") {
      const b = await json<{ email?: string; role?: Role | null }>(req)
      if (typeof b?.email !== "string") return fail(res, 400, "bad_request", "email is required")
      if (b.role !== null && b.role !== undefined && !ROLES.includes(b.role)) {
        return fail(res, 400, "bad_request", `role must be one of ${ROLES.join(", ")}, or null to remove`)
      }
      try {
        deps.members.set(actor as string, b.email, b.role ?? null)
      } catch (err) {
        const e = err as { status?: number; message?: string }
        return fail(res, e.status ?? 400, e.status === 403 ? "forbidden" : "bad_request", e.message ?? String(err))
      }
      return send(res, 200, { ok: true, seq: deps.engine.head(), members: deps.members.list() })
    }
  }

  /*
   * POST /notes/:id/give — give a note to another machine.
   *
   * `to` names a person, and the note goes to their machine; `runner` names a
   * machine directly, for a hub with no identity to name people by. If the
   * note has already been worked on somewhere else, that machine commits
   * what it has and pushes the branch first — with its owner's own git
   * credentials, because the hub has none — and the receiver continues that
   * branch with a briefing. The hub moves nothing but the record of where
   * the work is.
   *
   * Assigning does not run it. Whoever it now belongs to runs it, or someone
   * asks them to — and their machine's consent rule answers that.
   */
  // `/give`, not `/assign`: that path already sets a note's *agent*, and on a
  // hub this route answered it instead — "use claude" read as "hand it to a
  // machine", failing every note run from the CLI on a hub.
  if (req.method === "POST" && parts[0] === "notes" && parts[2] === "give" && deps.runners) {
    const noteId = parts[1]!
    const view = deps.engine.boardOf(noteId)
    const note = view?.notes.find((n) => n.id === noteId)
    if (!view || !note) return fail(res, 404, "note_not_found", "no such note")
    if (deps.members && !deps.members.allows(deps.actor ?? null, "run:assign")) {
      return fail(res, 403, "forbidden", "only members can give work to someone")
    }
    if (note.status === "running" || note.status === "queued") {
      return fail(res, 409, "invalid_transition", "it is running — hand it over once it stops")
    }
    const b = await json<{ to?: string; runner?: string }>(req)
    const target = b?.runner
      ? deps.runners.get(b.runner)
      : typeof b?.to === "string"
        ? deps.runners.pick(view.board.id, b.to.trim().toLowerCase())
        : null
    if (!target || !target.online) {
      return fail(res, 409, "invalid_transition", b?.to ? `${b.to} has no machine connected with this repository` : "that machine is not connected")
    }
    if (!target.boards.includes(view.board.id)) {
      return fail(res, 409, "invalid_transition", `${target.name} does not have this repository checked out`)
    }

    const from = deps.runners.placement(noteId)
    if (from === target.runnerId) return send(res, 200, { ok: true, seq: deps.engine.head(), runner: target.runnerId })

    // Never worked on anywhere: nothing to carry, only a place to be.
    if (!from || !note.branch) {
      deps.runners.place(noteId, target.runnerId, deps.actor ?? null)
      return send(res, 200, { ok: true, seq: deps.engine.head(), runner: target.runnerId })
    }

    const { branch } = await deps.runners.call<{ branch: string }>(from, "handoff", [view.board.repoPath, noteId])
    const e = emit(deps, event("note.handed", { noteId, from, to: target.runnerId, branch }))
    return send(res, 200, { ok: true, seq: e.seq, runner: target.runnerId, branch })
  }

  /*
   * POST /notes/:id/consent — the owner of the machine a note is waiting on,
   * answering. Nobody else may: that is the entire point of consent living on
   * the runner. An admin of the hub cannot answer for someone's laptop.
   */
  if (req.method === "POST" && parts[0] === "notes" && parts[2] === "consent" && deps.runners) {
    const noteId = parts[1]!
    const view = deps.engine.boardOf(noteId)
    const note = view?.notes.find((n) => n.id === noteId)
    if (!view || !note) return fail(res, 404, "note_not_found", "no such note")
    if (!note.held) return fail(res, 409, "invalid_transition", "this note is not waiting on anyone")
    const runner = deps.runners.get(note.held.runnerId)
    if (!runner || runner.owner !== actor) {
      return fail(res, 403, "forbidden", "only the owner of the machine it would run on can answer this")
    }
    const b = await json<{ accept?: boolean; always?: boolean }>(req)
    try {
      const runId = await deps.runners.call<string>(runner.runnerId, "consent", [
        view.board.id,
        noteId,
        b?.accept === true,
        b?.always === true,
        note.held.requestedBy,
        note.held.agent,
      ])
      return send(res, 200, { ok: true, seq: deps.engine.head(), runId: runId || null })
    } catch (err) {
      const e = err as { status?: number; message?: string }
      return fail(res, e.status ?? 502, "bad_request", e.message ?? String(err))
    }
  }

  if (req.method === "GET" && routed === "/health") {
    return send(res, 200, { version: VERSION, uptime: Date.now() - STARTED, pid: process.pid })
  }

  if (req.method === "GET" && routed === "/events") {
    return sse(deps, req, res, Number(req.headers["last-event-id"] ?? url.searchParams.get("after") ?? 0))
  }

  // GET /agents/:id/models — a menu for the model pickers
  if (req.method === "GET" && parts[0] === "agents" && parts[2] === "models") {
    return send(res, 200, { models: await deps.workshop.models(parts[1]!) })
  }

  // POST /agents/:id/models — replace the models you added yourself
  if (req.method === "POST" && parts[0] === "agents" && parts[2] === "models") {
    const body = await json<{ models?: unknown }>(req)
    const ids = Array.isArray(body?.models)
      ? body.models.filter((m): m is string => typeof m === "string")
      : []
    return send(res, 200, { models: await deps.workshop.setModels(parts[1]!, ids) })
  }

  if (req.method === "GET" && routed === "/agents") {
    return send(res, 200, { agents: await deps.workshop.agents() })
  }

  // POST /notes/:id/reclaimed — gc removed this note's checkout
  if (req.method === "POST" && parts[0] === "notes" && parts[2] === "reclaimed" && parts[1]) {
    const view = deps.engine.boardOf(parts[1]!)
    if (!view) return fail(res, 404, "note_not_found", "no such note")
    // gc runs in the CLI and removes directories itself, so it has to tell the
    // daemon — otherwise the note keeps naming a checkout that is gone.
    const e = emit(deps, event("note.reclaimed", { noteId: parts[1]! }))
    return send(res, 200, { ok: true, seq: e.seq })
  }

  // GET /notes/:id/pr — what opening a PR would say, before it says it
  if (req.method === "GET" && parts[0] === "notes" && parts[2] === "pr" && parts[1]) {
    const view = deps.engine.boardOf(parts[1]!)
    const note = view?.notes.find((n) => n.id === parts[1])
    if (!view || !note) return fail(res, 404, "note_not_found", "no such note")
    return send(res, 200, {
      title: note.title,
      body: prBody(note, {
        model: note.model ?? (note.agent ? view.board.models?.[note.agent] : null) ?? null,
        footer: view.board.attribution?.pr === true,
        summary: note.runId ? deps.engine.store.lastSaid(note.runId) : null,
      }),
    })
  }

  // GET /boards/:id/files — tracked paths, for the composer's `@` picker
  if (req.method === "GET" && parts[0] === "boards" && parts[2] === "files" && parts[1]) {
    const view = deps.engine.view(parts[1]!)
    if (!view) return fail(res, 404, "board_not_found", "no such board")
    return send(res, 200, await deps.workshop.files(view.board.repoPath))
  }

  // GET /repo/browse?path=... — directory listing for the picker
  if (req.method === "GET" && routed === "/repo/browse") {
    const p = url.searchParams.get("path")
    try {
      return send(res, 200, await deps.workshop.browse(p))
    } catch (err) {
      return fail(res, 400, "bad_request", err instanceof Error ? err.message : String(err))
    }
  }

  // POST /repo/pick — the OS folder chooser, where the platform has one
  if (req.method === "POST" && routed === "/repo/pick") {
    return send(res, 200, await deps.workshop.pick())
  }

  if (req.method === "GET" && routed === "/repo/check") {
    const p = url.searchParams.get("path") ?? ""
    return send(res, 200, await deps.workshop.checkRepo(p))
  }

  if (req.method === "GET" && routed === "/boards") {
    return send(res, 200, { boards: deps.engine.projections.boards() })
  }

  if (req.method === "POST" && routed === "/boards") {
    const body = await json<{
      name?: string
      repoPath: string
      setup?: string | null
      carry?: string[]
      defaultPolicy?: "repo" | "full"
    }>(req)
    if (!body?.repoPath) return fail(res, 400, "bad_request", "repoPath required")
    if (body.defaultPolicy !== undefined && body.defaultPolicy !== "repo" && body.defaultPolicy !== "full")
      return fail(res, 400, "bad_request", "defaultPolicy must be 'repo' or 'full'")

    // Validate here rather than at first run. A board pointed at a
    // non-repo is a board that looks fine until the moment it matters.
    const check = await deps.workshop.checkRepo(body.repoPath)
    if (!check.isRepo) {
      return fail(res, 400, "not_a_repo", check.error ?? `${body.repoPath} is not a git repository`)
    }

    const boardId = id("board")
    const name = body.name?.trim() || check.name || "board"

    const models = await deps.workshop.defaultModels()
    emit(
      deps,
      event("board.created", {
        boardId,
        name,
        repoPath: check.path,
        // Default to what the repo's lockfiles imply, so a board works on
        // first run without anyone having to know this setting exists.
        setup: body.setup === undefined ? check.suggestedSetup : body.setup,
        carry: body.carry ?? check.suggestedCarry,
        models,
        // Full access unless whoever added the board chose otherwise — at
        // setup, or in the dialog. Repo only asks about or refuses anything
        // outside the worktree, which stalls most real work.
        defaultPolicy: body.defaultPolicy ?? "full",
        // How a teammate's runner will recognise its own clone of this repo.
        remote: check.remote ?? null,
      }),
    )
    // Seed the lifecycle lanes. Each declares the lane it represents, so the
    // server can move notes between them as their status changes.
    const LANES = [
      { name: "Inbox", lane: "inbox" },
      { name: "Queued", lane: "queued" },
      { name: "Running", lane: "running" },
      { name: "Review", lane: "review" },
      { name: "Done", lane: "done" },
    ] as const
    for (const [i, col] of LANES.entries()) {
      emit(
        deps,
        event("column.created", {
          columnId: id("col"),
          boardId,
          name: col.name,
          lane: col.lane,
          pos: between(null, null) + String(i),
        }),
      )
    }
    const view = deps.engine.view(boardId)!
    return send(res, 200, { ok: true, seq: view.seq, board: view.board })
  }

  // GET /boards/:id/stats
  if (req.method === "GET" && parts[0] === "boards" && parts[2] === "stats") {
    const view = deps.engine.view(parts[1]!)
    if (!view) return fail(res, 404, "board_not_found", "no such board")
    return send(res, 200, computeStats(view, deps.engine.store))
  }

  // GET /boards/:id/forge
  if (req.method === "GET" && parts[0] === "boards" && parts[2] === "forge") {
    const view = deps.engine.view(parts[1]!)
    if (!view) return fail(res, 404, "board_not_found", "no such board")
    return send(res, 200, await deps.workshop.forge(view.board.repoPath))
  }

  // POST /boards/:id/remove
  if (req.method === "POST" && parts[0] === "boards" && parts[2] === "remove") {
    const board = deps.engine.view(parts[1]!)
    if (!board) return fail(res, 404, "board_not_found", "no such board")
    await deps.workshop.removeBoard(board.board.repoPath, board.notes.map((n) => n.id))
    const e = emit(deps, event("board.removed", { boardId: parts[1]! }))
    return send(res, 200, { ok: true, seq: e.seq })
  }

  // POST /boards/:id/models
  if (req.method === "POST" && parts[0] === "boards" && parts[2] === "models") {
    const b = await json<{ models: Record<string, string> }>(req)
    if (!deps.engine.view(parts[1]!)) return fail(res, 404, "board_not_found", "no such board")
    const e = emit(deps, event("board.models", { boardId: parts[1]!, models: b?.models ?? {} }))
    return send(res, 200, { ok: true, seq: e.seq })
  }

  // POST /boards/:id/policy — what notes written here start as
  if (req.method === "POST" && parts[0] === "boards" && parts[2] === "policy") {
    const b = await json<{ defaultPolicy: "repo" | "full" }>(req)
    if (b?.defaultPolicy !== "repo" && b?.defaultPolicy !== "full")
      return fail(res, 400, "bad_request", "defaultPolicy must be 'repo' or 'full'")
    if (!deps.engine.view(parts[1]!)) return fail(res, 404, "board_not_found", "no such board")
    const e = emit(
      deps,
      event("board.policy", { boardId: parts[1]!, defaultPolicy: b.defaultPolicy }),
    )
    return send(res, 200, { ok: true, seq: e.seq })
  }

  // POST /boards/:id/mcp — the board's MCP servers, replaced as a whole
  if (req.method === "POST" && parts[0] === "boards" && parts[2] === "mcp" && parts.length === 3) {
    const body = await json<{ servers: unknown }>(req)
    if (!deps.engine.view(parts[1]!)) return fail(res, 404, "board_not_found", "no such board")
    // Refused whole rather than half-applied: a list with one bad entry is a
    // list the user is still writing, not one to act on.
    const checked = checkMcpServers(body?.servers)
    if (!checked.ok) return fail(res, 400, "bad_request", checked.error)
    const e = emit(deps, event("board.mcp", { boardId: parts[1]!, servers: checked.servers }))
    return send(res, 200, { ok: true, seq: e.seq, servers: checked.servers })
  }

  /*
   * Skills. They live in the repository, so they are the workshop's to read
   * and write; see `LocalWorkshop` for why they are never kept in the log.
   */
  if (parts[0] === "boards" && parts[2] === "skills" && parts[1]) {
    const view = deps.engine.view(parts[1]!)
    if (!view) return fail(res, 404, "board_not_found", "no such board")
    const repo = view.board.repoPath
    try {
      if (req.method === "GET" && parts.length === 3) {
        return send(res, 200, { skills: await deps.workshop.skills(repo) })
      }
      if (req.method === "POST" && parts.length === 3) {
        const b = await json<{ source?: string; skill?: string }>(req)
        if (typeof b?.source !== "string") return fail(res, 400, "bad_request", "source is required")
        return send(res, 200, { skills: await deps.workshop.addSkills(repo, b.source, b.skill) })
      }
      if (req.method === "POST" && parts[3] === "remove") {
        const b = await json<{ name?: string }>(req)
        if (typeof b?.name !== "string") return fail(res, 400, "bad_request", "name is required")
        return send(res, 200, { skills: await deps.workshop.removeSkill(repo, b.name) })
      }
      if (req.method === "POST" && parts[3] === "commit") {
        return send(res, 200, await deps.workshop.commitSkills(repo))
      }
    } catch (err) {
      // Already the CLI's own words, trimmed, by the workshop that ran it.
      return fail(res, 400, "bad_request", err instanceof Error ? err.message : String(err))
    }
  }

  // POST /boards/:id/attribution
  if (req.method === "POST" && parts[0] === "boards" && parts[2] === "attribution") {
    const body = await json<{ attribution: unknown }>(req)
    if (!deps.engine.view(parts[1]!)) return fail(res, 404, "board_not_found", "no such board")
    // Coerced rather than trusted: a half-sent object must resolve to "off"
    // for the key it omitted, never to "on" by accident. Writing someone's
    // git history because a field was undefined is not a mistake to allow.
    const e = emit(
      deps,
      event("board.attribution", {
        boardId: parts[1]!,
        attribution: coerceAttribution(body?.attribution),
      }),
    )
    return send(res, 200, { ok: true, seq: e.seq })
  }

  // POST /boards/:id/setup
  if (req.method === "POST" && parts[0] === "boards" && parts[2] === "setup") {
    const body = await json<{ setup: string | null; carry?: string[] }>(req)
    if (!deps.engine.view(parts[1]!)) return fail(res, 404, "board_not_found", "no such board")
    const e = emit(
      deps,
      event("board.setup", {
        boardId: parts[1]!,
        setup: body?.setup ?? null,
        ...(body?.carry ? { carry: body.carry } : {}),
      }),
    )
    return send(res, 200, { ok: true, seq: e.seq })
  }

  // GET /boards/:id/view
  if (req.method === "GET" && parts[0] === "boards" && parts[2] === "view") {
    const view = deps.engine.view(parts[1]!)
    if (!view) return fail(res, 404, "board_not_found", `no board ${parts[1]}`)
    return send(res, 200, view)
  }

  if (req.method === "POST" && routed === "/notes") {
    const body = await json<{
      boardId: string
      columnId: string
      title: string
      body?: string
      files?: { name: string; data: string }[]
    }>(req)
    if (!body?.boardId || !body?.columnId || !body?.title)
      return fail(res, 400, "bad_request", "boardId, columnId and title required")

    const view = deps.engine.view(body.boardId)
    if (!view) return fail(res, 404, "board_not_found", `no board ${body.boardId}`)

    const last = notesIn(view, body.columnId).at(-1)
    const noteId = id("note")
    const e = emit(
      deps,
      event("note.created", {
        noteId,
        boardId: body.boardId,
        columnId: body.columnId,
        title: body.title,
        body: body.body ?? "",
        pos: between(last?.pos ?? null, null),
      }),
    )

    // A note being composed has no worktree — worktrees are made at run time —
    // so its files wait in the state dir under this id until it runs. Nothing
    // is written into the user's repository for a note nobody has run.
    const attached = body.files?.length
      ? await deps.workshop.stage(noteId, body.files)
      : { staged: [], rejected: [] }

    return send(res, 200, {
      ok: true,
      seq: e.seq,
      noteId,
      attachments: attached.staged,
      rejected: attached.rejected,
    })
  }

  // GET /notes/:id/attachments — what is staged for a note that hasn't run.
  if (req.method === "GET" && parts[0] === "notes" && parts[2] === "attachments") {
    const noteId = parts[1]!
    if (!deps.engine.boardOf(noteId)) return fail(res, 404, "note_not_found", `no note ${noteId}`)
    return send(res, 200, { attachments: await deps.workshop.staged(noteId) })
  }

  // GET /notes/:id/diff
  //
  // The live worktree is the truth while it exists — a note can still be
  // running, and its diff grows under us. Once review is decided the worktree
  // is gone, so we fall back to the snapshot taken when review opened.
  if (req.method === "GET" && parts[0] === "notes" && parts[2] === "diff") {
    const noteId = parts[1]!
    const live = await deps.workshop.diff(noteId)
    if (live) return send(res, 200, { ...live, capturedAt: null })
    const saved = deps.engine.store.savedDiff(noteId)
    if (!saved)
      return send(res, 200, { diff: "", stat: "", branch: null, baseBranch: null, capturedAt: null })
    return send(res, 200, {
      diff: saved.diff,
      stat: saved.stat,
      branch: saved.branch,
      baseBranch: null,
      capturedAt: saved.ts,
    })
  }

  // POST /notes/:id/<action>
  if (req.method === "POST" && parts[0] === "notes" && parts[1]) {
    return noteAction(deps, res, parts[1], parts[2] ?? "", req)
  }

  // GET /runs/:id/transcript
  if (req.method === "GET" && parts[0] === "runs" && parts[2] === "transcript") {
    const after = Number(url.searchParams.get("after") ?? 0)
    const frames = deps.engine.store.transcriptSince(parts[1]!, after)
    return send(res, 200, { frames, nextAfter: frames.at(-1)?.seq ?? null })
  }

  // POST /runs/:id/permission — the agent asking, via its MCP sidecar.
  //
  // The one request in this API that is allowed to take minutes: it is held
  // open for exactly as long as the question is on the board. The daemon owns
  // that clock, so nothing here needs a timeout of its own.
  if (req.method === "POST" && parts[0] === "runs" && parts[2] === "permission") {
    if (!deps.permissions)
      return fail(res, 409, "run_not_live", "this daemon cannot ask — nothing is listening")
    const b = await json<{ tool: string; input?: Record<string, unknown> }>(req)
    if (!b?.tool) return fail(res, 400, "bad_request", "tool required")

    // If the agent goes away mid-question, the question goes with it. Without
    // this the card would sit on the board until it timed out, inviting
    // someone to answer something nothing is listening for.
    const gone = new AbortController()
    res.on("close", () => {
      if (!res.writableEnded) gone.abort()
    })

    const verdict = await deps.permissions.request(parts[1]!, b.tool, b.input ?? {}, gone.signal)
    return send(res, 200, { ok: true, seq: deps.engine.head(), verdict })
  }

  // POST /runs/:id/respond — the user answering.
  if (req.method === "POST" && parts[0] === "runs" && parts[2] === "respond") {
    const b = await json<{
      requestId: string
      decision: "allow" | "deny"
      scope?: "once" | "note"
      comment?: string
    }>(req)
    if (!b?.requestId) return fail(res, 400, "bad_request", "requestId required")
    /*
     * On a hub, only the person whose machine is asking may answer. A shell
     * command an agent wants to run on Alice's laptop is Alice's to allow;
     * the hub relays the question and the answer, and decides neither.
     */
    if (deps.runners && deps.actor !== undefined) {
      const run = deps.engine.projections
        .boards()
        .flatMap((x) => deps.engine.view(x.id)?.runs ?? [])
        .find((r) => r.id === parts[1])
      const placed = run ? deps.runners.placement(run.noteId) : null
      const owner = placed ? deps.runners.get(placed)?.owner ?? null : null
      if (owner !== null && owner !== deps.actor) {
        return fail(res, 403, "forbidden", "only the owner of the machine running this can answer it")
      }
    }
    if (b.decision !== "allow" && b.decision !== "deny")
      return fail(res, 400, "bad_request", "decision must be 'allow' or 'deny'")
    if (b.scope !== undefined && b.scope !== "once" && b.scope !== "note")
      return fail(res, 400, "bad_request", "scope must be 'once' or 'note'")

    const answered = deps.permissions?.answer(b.requestId, {
      decision: b.decision,
      ...(b.scope ? { scope: b.scope } : {}),
      ...(b.comment ? { comment: b.comment } : {}),
    })
    // Two tabs on the same board is the normal case, and the second one to
    // press a button has done nothing wrong. Say what happened, don't fail.
    return send(res, 200, { ok: true, seq: deps.engine.head(), answered: answered === true })
  }

  // POST /runs/:id/cancel
  if (req.method === "POST" && parts[0] === "runs" && parts[2] === "cancel") {
    return send(res, 200, { ok: true, seq: deps.engine.head(), cancelled: await deps.workshop.cancel(parts[1]!) })
  }

  // GET /runs/:id/output
  if (req.method === "GET" && parts[0] === "runs" && parts[2] === "output") {
    const after = Number(url.searchParams.get("after") ?? 0)
    const lines = deps.engine.store.outputSince(parts[1]!, after)
    return send(res, 200, { lines, nextAfter: lines.at(-1)?.seq ?? null })
  }

  // Anything that isn't the API is the web client, if one is built.
  if (req.method === "GET" && apiPath === null && serveStatic(url.pathname, res)) return

  return fail(res, 404, "bad_request", `no route for ${req.method} ${url.pathname}`)
}

async function noteAction(
  deps: ServerDeps,
  res: ServerResponse,
  noteId: string,
  action: string,
  req: IncomingMessage,
) {
  const view = deps.engine.boardOf(noteId)
  if (!view) return fail(res, 404, "note_not_found", `no note ${noteId}`)
  const note = view.notes.find((n) => n.id === noteId)
  if (!note) return fail(res, 404, "note_not_found", `no note ${noteId}`)

  switch (action) {
    case "edit": {
      const b = await json<{ title?: string; body?: string }>(req)
      const e = emit(deps, event("note.edited", { noteId, ...b }))
      return send(res, 200, { ok: true, seq: e.seq })
    }
    case "move": {
      const b = await json<{ columnId: string; before?: string; after?: string }>(req)
      if (!b?.columnId) return fail(res, 400, "bad_request", "columnId required")
      // Positions come from neighbour ids, not raw keys — the client says
      // "between these two", the server computes the key. One source of truth.
      const siblings = notesIn(view, b.columnId).filter((n) => n.id !== noteId)
      const afterPos = b.after ? (siblings.find((n) => n.id === b.after)?.pos ?? null) : null
      const beforePos = b.before ? (siblings.find((n) => n.id === b.before)?.pos ?? null) : null
      const e = emit(
        deps,
        event("note.moved", { noteId, columnId: b.columnId, pos: between(afterPos, beforePos) }),
      )
      return send(res, 200, { ok: true, seq: e.seq })
    }
    case "assign": {
      const b = await json<{ agent: AgentId }>(req)
      if (!b?.agent) return fail(res, 400, "bad_request", "agent required")
      const e = emit(deps, event("note.assigned", { noteId, agent: b.agent }))
      return send(res, 200, { ok: true, seq: e.seq })
    }
    case "pr": {
      if (!note.branch) return fail(res, 409, "no_branch", "this note has not produced a branch yet")

      const forge = await deps.workshop.forge(view.board.repoPath)
      if (!forge.available) return fail(res, 409, "no_forge", forge.reason ?? "no forge available")

      const b = await json<{ draft?: boolean; title?: string; body?: string }>(req)
      try {
        // Whatever the person edited in the dialog wins; the composed version
        // is only a starting point, and a PR nobody could edit before it
        // existed is how you get a wall of mechanical descriptions.
        const pr = await deps.workshop.openPr(
          view.board.repoPath,
          note.branch,
          b?.title?.trim() || note.title,
          b?.body ??
              prBody(note, {
              model: note.model ?? (note.agent ? view.board.models?.[note.agent] : null) ?? null,
              footer: view.board.attribution?.pr === true,
              summary: note.runId ? deps.engine.store.lastSaid(note.runId) : null,
            }),
          b?.draft ?? false,
        )
        const e = emit(deps, event("note.pr", { noteId, pr }))
        return send(res, 200, { ok: true, seq: e.seq, pr })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        // A PR may already exist for this branch; if so, adopt it rather than
        // reporting a failure the user can do nothing about.
        await deps.prs.refresh(view.board.id, noteId)
        const now = deps.engine.boardOf(noteId)?.notes.find((n) => n.id === noteId)
        if (now?.pr) return send(res, 200, { ok: true, seq: deps.engine.head(), pr: now.pr })
        return fail(res, 409, "internal", message)
      }
    }

    case "model": {
      const b = await json<{ model: string | null }>(req)
      const model = b?.model?.trim() || null
      const e = emit(deps, event("note.model", { noteId, model }))
      return send(res, 200, { ok: true, seq: e.seq })
    }

    case "policy": {
      const b = await json<{ policy: "repo" | "full" }>(req)
      if (b?.policy !== "repo" && b?.policy !== "full")
        return fail(res, 400, "bad_request", "policy must be 'repo' or 'full'")
      const e = emit(deps, event("note.policy", { noteId, policy: b.policy }))
      return send(res, 200, { ok: true, seq: e.seq })
    }

    /**
     * The blunt instrument: raise the whole note to full access and continue.
     *
     * Not the same thing as answering a prompt — `POST /runs/:id/respond` is
     * that, and it is the one to reach for. This is the after-the-fact answer
     * for a note that was already refused, for an agent that cannot be asked
     * at all, or for a run where the honest answer is "stop asking me, I trust
     * this one". It changes the note's policy and resumes the agent in the
     * same worktree with what it was refused now permitted.
     */
    case "escalate": {
      if (!note.agent) return fail(res, 400, "bad_request", "note has no agent assigned")
      // There is nothing to continue from. Setting the policy and running from
      // scratch is what the note's own toggle and Run button are for.
      if (!note.runId)
        return fail(res, 409, "invalid_transition", "this note has not run yet — set its policy and run it")

      if (note.policy !== "full") emit(deps, event("note.policy", { noteId, policy: "full" }))

      try {
        const delivery = await deps.workshop.escalate(view.board.id, noteId)
        return send(res, 200, { ok: true, seq: deps.engine.head(), delivery })
      } catch (err) {
        return fail(res, 400, "bad_request", err instanceof Error ? err.message : String(err))
      }
    }

    case "attach": {
      const b = await json<{ files: { name: string; data: string }[] }>(req)
      if (!b?.files?.length) return fail(res, 400, "bad_request", "files required")
      const { attachments, rejected } = await deps.workshop.attach(noteId, b.files)
      return send(res, 200, { ok: true, seq: deps.engine.head(), attachments, rejected })
    }

    case "unattach": {
      const b = await json<{ name: string }>(req)
      if (!b?.name) return fail(res, 400, "bad_request", "name required")
      const attachments = await deps.workshop.unattach(noteId, b.name)
      return send(res, 200, { ok: true, seq: deps.engine.head(), attachments })
    }

    case "delete": {
      // Its checkout and anything staged go with it; the branch stays.
      await deps.workshop.deleteNote(view.board.repoPath, noteId, note.worktree)

      const e = emit(deps, event("note.deleted", { noteId }))
      return send(res, 200, { ok: true, seq: e.seq })
    }
    case "run": {
      const b = await json<{ agent?: AgentId }>(req)
      const agent = b?.agent ?? note.agent
      if (!agent) return fail(res, 400, "bad_request", "note has no agent assigned")
      if (note.status === "running" || note.status === "queued")
        return fail(res, 409, "invalid_transition", `note is already ${note.status}`)

      const runId = await deps.workshop.request(view.board.id, noteId, agent)
      // Empty means the machine's owner has been asked first. Accepted, not done.
      if (runId === "") return send(res, 202, { ok: true, seq: deps.engine.head(), runId: null, held: true })
      return send(res, 200, { ok: true, seq: deps.engine.head(), runId })
    }
    case "message": {
      const b = await json<{ text: string; files?: { name: string; data: string }[] }>(req)
      if (!b?.text?.trim() && !b?.files?.length)
        return fail(res, 400, "bad_request", "text or files required")

      // Files go wherever the agent will be able to open them — its worktree,
      // or the stage the next run adopts. Refusing a note with no worktree
      // was the old behaviour and it made attaching to a not-yet-run note
      // impossible for no reason the user could see.
      let text = (b.text ?? "").trim()
      const rejected: { name: string; reason: string }[] = []
      if (b.files?.length) {
        const carried = await deps.workshop.messageFiles(noteId, b.files)
        rejected.push(...carried.rejected)
        text += carried.mention
        // A message that was nothing but a file we would not take has nothing
        // left to send. Say why, rather than poking the agent with "".
        if (!text && rejected.length === b.files.length)
          return fail(res, 400, "bad_request", rejected.map((r) => r.reason).join("; "))
      }

      try {
        const delivery = await deps.workshop.steer(view.board.id, noteId, text)
        return send(res, 200, { ok: true, seq: deps.engine.head(), delivery, rejected })
      } catch (err) {
        return fail(res, 400, "bad_request", err instanceof Error ? err.message : String(err))
      }
    }

    case "review": {
      const b = await json<{ decision: "merge" | "discard" | "revise"; comment?: string }>(req)
      if (!b?.decision) return fail(res, 400, "bad_request", "decision required")

      // `revise` is steering, not a verdict: keep the worktree and the
      // session, hand the agent the comment, and let it keep going.
      if (b.decision === "revise") {
        if (!b.comment?.trim())
          return fail(res, 400, "bad_request", "revise needs a comment saying what to change")
        const delivery = await deps.workshop.steer(view.board.id, noteId, b.comment.trim())
        const e = emit(deps, event("review.decided", { noteId, decision: "revise", comment: b.comment }))
        return send(res, 200, { ok: true, seq: e.seq, delivery })
      }

      // The merge commit is the one commit that is definitely still in
      // history after the branch is deleted, so it is the one worth
      // signing — when the board asked to be signed at all.
      const model = note.model ?? (note.agent ? view.board.models?.[note.agent] : null) ?? null
      const trailers = view.board.attribution?.commit
        ? commitTrailers({ noteId, runId: note.runId, agent: note.agent, model })
        : []
      // The subject and body are the note's own words; the footer is what
      // the run turned out to be. Both are already on the board — the
      // merge commit is the last chance to write them down somewhere that
      // outlives it. The workshop only writes them into git.
      const run = view.runs.find((r) => r.id === note.runId)
      const outcome = await deps.workshop.review(
        view.board.repoPath,
        noteId,
        b.decision === "merge"
          ? {
              decision: "merge",
              land: {
                note: { id: noteId, title: note.title, body: note.body },
                facts: { stat: note.stat, agent: note.agent, model, turns: run?.turns ?? null },
                trailers,
              },
            }
          : { decision: "discard" },
      )
      if (outcome.checkout === "conflict") {
        // Leave everything exactly as it was. A conflict is the user's
        // call, and they still have the branch and the worktree.
        return fail(
          res,
          409,
          "worktree_failed",
          `merge conflict on ${outcome.branch} — resolve it yourself, the branch is intact:\n${outcome.conflict}`,
        )
      }
      // What the disk did is written down here, where the log is: the
      // checkout going is an event, and one it could not safely take is a
      // line on the run's transcript saying why it is still there.
      if (outcome.checkout === "removed") {
        emit(deps, event("note.reclaimed", { noteId }))
      } else if (outcome.checkout === "kept" && note.runId) {
        deps.engine.say(note.runId, "system", `kept the checkout: ${outcome.reason}`)
      }

      const e = emit(deps, event("review.decided", { noteId, ...b }))
      await deps.workshop.syncColumn(view.board.id, noteId)
      return send(res, 200, { ok: true, seq: e.seq })
    }
    default:
      return fail(res, 404, "bad_request", `unknown note action "${action}"`)
  }
}

/** SSE: one multiplexed stream, replayed from `after`, heartbeat every 15s. */
function sse(deps: ServerDeps, req: IncomingMessage, res: ServerResponse, after: number) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  })

  for (const e of deps.engine.store.since(after)) write(res, e)

  const unsubscribe = deps.engine.bus.subscribe((f) => write(res, f))
  const beat = setInterval(() => res.write(":\n\n"), 15_000)

  req.on("close", () => {
    clearInterval(beat)
    unsubscribe()
  })
}

function write(res: ServerResponse, f: StreamFrame) {
  // Transcript frames deliberately carry no `id:`. Per the SSE spec that
  // leaves the client's Last-Event-ID untouched, so a reconnect resumes the
  // domain log exactly where it left off instead of replaying agent chatter.
  if (isEphemeral(f)) {
    res.write(`event: ${f.kind}\ndata: ${JSON.stringify(f)}\n\n`)
    return
  }
  res.write(`id: ${f.seq}\nevent: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`)
}

function emit(deps: ServerDeps, pending: Parameters<Engine["emit"]>[0]) {
  return deps.engine.emit(pending, deps.actor ?? null)
}

/**
 * The runner protocol's four routes. See docs/18-runner-protocol.md.
 *
 * A runner authenticates exactly as a person does — it is a person's
 * machine, and on a tailnet Tailscale says whose. Its owner is that person,
 * or nobody on a hub with no identity.
 */
async function runnerRoute(
  deps: ServerDeps,
  runners: Runners,
  routed: string,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  owner: ActorId | null,
): Promise<void> {
  try {
    if (req.method === "POST" && routed === "/runner/hello") {
      return send(res, 200, runners.hello((await json<Hello>(req)) as Hello, owner))
    }
    if (req.method === "GET" && routed === "/runner/stream") {
      return runners.attach(
        url.searchParams.get("runner") ?? "",
        owner,
        req,
        res,
        Number(url.searchParams.get("after") ?? 0) || 0,
      )
    }
    if (req.method === "POST" && routed === "/runner/log") {
      runners.log((await json<LogBatch>(req)) as LogBatch, owner)
      return send(res, 200, { ok: true, seq: deps.engine.head() })
    }
    if (req.method === "POST" && routed === "/runner/reply") {
      runners.reply((await json<Reply>(req)) as Reply, owner)
      return send(res, 200, { ok: true })
    }
    return fail(res, 404, "bad_request", "no such runner route")
  } catch (err) {
    const e = err as { status?: number; message?: string }
    if (res.headersSent) return void res.end()
    return fail(res, e.status ?? 400, e.status === 403 ? "forbidden" : "bad_request", e.message ?? String(err))
  }
}

async function json<T>(req: IncomingMessage): Promise<T | null> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  if (chunks.length === 0) return null
  try {
    return JSON.parse(Buffer.concat(chunks).toString()) as T
  } catch {
    return null
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(body))
}

function fail(res: ServerResponse, status: number, code: ErrorCode, message: string) {
  send(res, status, { ok: false, error: { code, message } })
}
