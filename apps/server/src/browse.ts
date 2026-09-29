import { execFile } from "node:child_process"
import { readdirSync, existsSync, statSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"

const exec = promisify(execFile)

export type Entry = {
  name: string
  path: string
  isRepo: boolean
}

export type Listing = {
  path: string
  parent: string | null
  entries: Entry[]
  /** True when this directory is itself a git repo. */
  isRepo: boolean
}

/**
 * Browse the filesystem from the daemon.
 *
 * A browser cannot hand us a path — `<input type=file webkitdirectory>` gives
 * file handles, not a directory path, and we need a path to run git in. Since
 * the daemon is already local, it can list directories for a picker that
 * behaves like a real one.
 */
export function list(dir: string): Listing {
  const full = resolve(dir)
  const entries: Entry[] = []

  for (const name of readdirSync(full)) {
    // Dotfiles are noise in a project picker; .git is the thing we detect, not
    // something you would ever want to open.
    if (name.startsWith(".")) continue
    const p = path.join(full, name)
    try {
      if (!statSync(p).isDirectory()) continue
      entries.push({ name, path: p, isRepo: existsSync(path.join(p, ".git")) })
    } catch {
      // Permission denied on a single entry shouldn't empty the whole listing.
    }
  }

  entries.sort((a, b) =>
    a.isRepo === b.isRepo ? a.name.localeCompare(b.name) : a.isRepo ? -1 : 1,
  )

  const parent = path.dirname(full)
  return {
    path: full,
    parent: parent === full ? null : parent,
    entries,
    isRepo: existsSync(path.join(full, ".git")),
  }
}

export function resolve(dir: string): string {
  const p = dir.startsWith("~") ? path.join(homedir(), dir.slice(1)) : dir
  return path.resolve(p || homedir())
}

const codeDirs = ["Developer", "Projects", "code", "src", "work", "repos", "dev", "git", "Documents", "Programming"]

type SearchLocations = { home: string; drives: string[]; extra: string[] }

function searchLocations(): SearchLocations {
  return { home: homedir(), drives: driveRoots(), extra: configuredRoots() }
}

export function suggestions(locations = searchLocations()): Entry[] {
  const { home, drives, extra } = locations
  const out: Entry[] = [{ name: "Home", path: home, isRepo: false }]
  const seen = new Set([home])
  const add = (p: string) => {
    if (seen.has(p) || !existsSync(p)) return
    seen.add(p)
    out.push({ name: path.basename(p) || p, path: p, isRepo: existsSync(path.join(p, ".git")) })
  }
  for (const c of codeDirs) add(path.join(home, c))
  for (const drive of drives) {
    add(drive)
    for (const c of codeDirs) add(path.join(drive, c))
  }
  for (const dir of extra) add(dir)
  return out
}

function driveRoots(): string[] {
  if (process.platform !== "win32") return []
  return Array.from({ length: 26 }, (_, i) => `${String.fromCharCode(65 + i)}:\\`)
    .filter((root) => existsSync(root))
}

function configuredRoots(): string[] {
  return (process.env.KANDY_REPO_DIRS ?? "")
    .split(path.delimiter)
    .map((dir) => dir.trim())
    .filter(Boolean)
    .map(resolve)
}

/**
 * The git repositories on this machine, most recently touched first.
 *
 * The old home-only search missed a repo directly in home or on another
 * Windows drive. Search immediate children of home and each drive root, plus
 * one level inside common code directories and KANDY_REPO_DIRS. Stop there:
 * deeper scans are slow and find vendored repos in places such as node_modules.
 */
export function repos(limit = 40, locations = searchLocations()): Entry[] {
  const { home, drives, extra } = locations
  const found: { entry: Entry; at: number }[] = []
  const seen = new Set<string>()
  const scanned = new Set<string>()

  const consider = (dir: string) => {
    if (seen.has(dir) || !existsSync(path.join(dir, ".git"))) return
    seen.add(dir)
    let at = 0
    try {
      at = statSync(path.join(dir, ".git")).mtimeMs
    } catch {
      // Unreadable is not a reason to hide it; it just sorts last.
    }
    found.push({ entry: { name: path.basename(dir), path: dir, isRepo: true }, at })
  }

  const scan = (root: string) => {
    if (scanned.has(root) || !existsSync(root)) return
    scanned.add(root)
    consider(root)
    let kids: string[] = []
    try {
      kids = readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith("."))
        .map((d) => path.join(root, d.name))
    } catch {
      return
    }
    for (const k of kids) consider(k)
  }

  scan(home)
  for (const name of codeDirs) scan(path.join(home, name))
  for (const drive of drives) {
    scan(drive)
    for (const name of codeDirs) scan(path.join(drive, name))
  }
  for (const root of extra) scan(root)

  return found.sort((a, b) => b.at - a.at).slice(0, limit).map((f) => f.entry)
}

/**
 * The macOS folder chooser for clients of POST /repo/pick.
 *
 * The web picker uses list() on every platform. This endpoint remains for
 * existing clients, though a runner may have no foreground desktop to show it.
 */
export async function nativePick(): Promise<string | null> {
  if (process.platform !== "darwin") return null
  try {
    const { stdout } = await exec(
      "osascript",
      ["-e", 'POSIX path of (choose folder with prompt "Choose a repository for kandy")'],
      { timeout: 120_000 },
    )
    return stdout.trim().replace(/\/$/, "") || null
  } catch {
    // Cancelling the dialog exits non-zero. That is a choice, not a failure.
    return null
  }
}
