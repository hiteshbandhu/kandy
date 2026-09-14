import { useCallback, useEffect, useRef, useState } from "react"

export type Page = "board" | "usage" | "settings"

/** Everything about where you are, and nothing about what is loaded there. */
export type Route = {
  page: Page
  boardId: string | null
  noteId: string | null
}

/**
 * The URL is the app's state, so a refresh lands where you left off.
 *
 * Paths rather than a hash, because `kandy serve` already falls back to
 * index.html for anything that is not the API — so a deep link survives a
 * reload without a second server.
 *
 * The shape is `/b/<board>/n/<note>`, with `/usage` and `/settings` hanging off
 * the board. The `/b` and `/n` segments are not decoration: they keep note ids
 * from ever being mistaken for a page name, and they keep the whole scheme
 * clear of the daemon's own top-level routes. The daemon answers `boards`,
 * `notes`, `runs`, `agents`, `events`, `health`, `repo` and `auth` at the root
 * for the CLI's benefit, and a browser route colliding with one of those would
 * be served JSON instead of the app.
 */
const PAGES: Page[] = ["usage", "settings"]

export function parseRoute(pathname: string): Route {
  const parts = pathname.split("/").filter(Boolean)
  if (parts[0] !== "b" || !parts[1]) return { page: "board", boardId: null, noteId: null }

  const boardId = parts[1]
  const rest = parts.slice(2)
  if (rest[0] === "n" && rest[1]) return { page: "board", boardId, noteId: rest[1] }

  const page = PAGES.find((p) => p === rest[0])
  return { page: page ?? "board", boardId, noteId: null }
}

export function routeHref(r: Route): string {
  if (!r.boardId) return "/"
  const base = `/b/${r.boardId}`
  if (r.noteId) return `${base}/n/${r.noteId}`
  if (r.page !== "board") return `${base}/${r.page}`
  return base
}

export function useRoute() {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname))

  /*
   * The live route, mirrored outside React's state.
   *
   * Call sites legitimately do two things at once — picking a repo in the
   * sidebar changes the board *and* returns you to the board page. Both land in
   * the same tick, and if each computed its next URL from the `route` captured
   * by its render, the second would be written from a value the first had
   * already replaced and would quietly undo it. Composing through a ref means
   * sequential calls see each other.
   */
  const live = useRef(route)

  useEffect(() => {
    const onPop = () => {
      const next = parseRoute(window.location.pathname)
      live.current = next
      setRoute(next)
    }
    window.addEventListener("popstate", onPop)
    return () => window.removeEventListener("popstate", onPop)
  }, [])

  const go = useCallback(
    (update: (cur: Route) => Route, opts?: { replace?: boolean }) => {
      const next = update(live.current)
      live.current = next
      setRoute(next)

      const href = routeHref(next)
      if (href === window.location.pathname) return
      // `replace` is for corrections nobody asked for — landing on `/` and
      // resolving it to your first board should not become a back-button stop
      // that bounces you straight forward again.
      if (opts?.replace) window.history.replaceState(null, "", href)
      else window.history.pushState(null, "", href)
    },
    [],
  )

  return { route, go }
}
