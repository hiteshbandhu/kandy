import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { repos, suggestions } from "../dist/browse.js"

test("repo discovery covers home, drive roots, and configured roots without descending into vendors", () => {
  const root = mkdtempSync(path.join(tmpdir(), "kandy-browse-"))
  const home = path.join(root, "home")
  const drive = path.join(root, "drive")
  const outside = path.join(root, "outside-home")
  const homeRepo = path.join(home, "direct-repo")
  const driveRepo = path.join(drive, "direct-repo")
  const codeRepo = path.join(drive, "Programming", "code-repo")
  const extraRepo = path.join(outside, "extra-repo")
  const nested = path.join(codeRepo, "vendor", "nested")
  try {
    for (const repo of [homeRepo, driveRepo, codeRepo, extraRepo]) {
      mkdirSync(path.join(repo, ".git"), { recursive: true })
    }
    mkdirSync(path.join(nested, ".git"), { recursive: true })
    writeFileSync(path.join(outside, ".git"), "gitdir: elsewhere")
    const locations = { home, drives: [drive], extra: [outside] }

    const paths = repos(100, locations).map((entry) => entry.path)
    assert.ok(paths.includes(homeRepo), "a repo directly in home is found")
    assert.ok(paths.includes(driveRepo), "a repo directly at the drive root is found")
    assert.ok(paths.includes(codeRepo), "a repo inside a drive's code directory is found")
    assert.ok(paths.includes(outside), "the configured root can itself be a repo")
    assert.ok(paths.includes(extraRepo), "repos immediately beneath an explicit root are found")
    assert.ok(!paths.includes(nested), "the search must not descend through a repo into vendors")
    const places = suggestions(locations).map((entry) => entry.path)
    assert.ok(places.includes(drive))
    assert.ok(places.includes(path.join(drive, "Programming")))
    assert.ok(places.includes(outside))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("KANDY_REPO_DIRS accepts the platform's path-list separator", () => {
  const root = mkdtempSync(path.join(tmpdir(), "kandy-repo-dirs-"))
  const previous = process.env.KANDY_REPO_DIRS
  const first = path.join(root, "first")
  const second = path.join(root, "second")
  try {
    mkdirSync(path.join(first, "one", ".git"), { recursive: true })
    mkdirSync(path.join(second, "two", ".git"), { recursive: true })
    process.env.KANDY_REPO_DIRS = [first, second].join(path.delimiter)
    const paths = repos(100).map((entry) => entry.path)
    assert.ok(paths.includes(path.join(first, "one")))
    assert.ok(paths.includes(path.join(second, "two")))
  } finally {
    if (previous === undefined) delete process.env.KANDY_REPO_DIRS
    else process.env.KANDY_REPO_DIRS = previous
    rmSync(root, { recursive: true, force: true })
  }
})
