#!/usr/bin/env node
import { execFileSync } from "node:child_process"
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Build the one file a person installs: `release/kandy.tgz`.
 *
 * The server package depends on @kandy/core and @kandy/client as workspace
 * packages, which exist nowhere but this repo — so a plain `npm pack` of
 * apps/server makes a tarball that fails to install. Here both are staged
 * inside the package and listed as bundleDependencies, so npm ships them in
 * the tarball and resolves only ink and react from the registry.
 *
 * The file layout stays exactly what the tests ran against: nothing is
 * bundled or rewritten, only copied.
 *
 *   node scripts/release.mjs            build, stage, pack
 *   node scripts/release.mjs --no-build pack what's already built
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const out = path.join(root, "release")
const stage = path.join(out, "stage")
const read = (p) => JSON.parse(readFileSync(path.join(root, p), "utf8"))

/**
 * Run the package managers that build and pack the release.
 *
 * Windows exposes npm and pnpm as .cmd shims, which execFileSync cannot start
 * without a shell. The Windows arguments below are fixed literals. Keep paths
 * in cwd rather than this command string so cmd.exe cannot reinterpret them.
 */
const isWindows = process.platform === "win32"
const run = (cmd, args, cwd = root) =>
  isWindows
    ? execFileSync([cmd, ...args].join(" "), { cwd, stdio: "inherit", shell: true })
    : execFileSync(cmd, args, { cwd, stdio: "inherit" })

if (!process.argv.includes("--no-build")) run("pnpm", ["build"])

rmSync(out, { recursive: true, force: true })
mkdirSync(stage, { recursive: true })

const server = read("apps/server/package.json")
const core = read("packages/core/package.json")
const client = read("packages/client/package.json")
const version = server.version

// The two workspace packages, as installed packages inside this one.
for (const [pkg, dir] of [
  [core, "packages/core"],
  [client, "packages/client"],
]) {
  const to = path.join(stage, "node_modules", pkg.name)
  cpSync(path.join(root, dir, "dist"), path.join(to, "dist"), { recursive: true })
  const deps = Object.fromEntries(Object.keys(pkg.dependencies ?? {}).map((d) => [d, version]))
  writeFileSync(
    path.join(to, "package.json"),
    JSON.stringify({ ...pick(pkg, "name", "type", "main", "types", "exports"), version, dependencies: deps }, null, 2),
  )
}

cpSync(path.join(root, "apps/server/dist"), path.join(stage, "dist"), { recursive: true })
for (const f of ["README.md", "LICENSE"]) copyFileSync(path.join(root, f), path.join(stage, f))

const internal = ["@kandy/core", "@kandy/client"]
writeFileSync(
  path.join(stage, "package.json"),
  JSON.stringify(
    {
      ...pick(server, "name", "version", "description", "type", "bin", "license", "engines", "keywords", "repository", "homepage"),
      dependencies: {
        ...Object.fromEntries(Object.entries(server.dependencies).filter(([d]) => !internal.includes(d))),
        ...Object.fromEntries(internal.map((d) => [d, version])),
      },
      bundleDependencies: internal,
      files: ["dist", "README.md", "LICENSE"],
    },
    null,
    2,
  ) + "\n",
)

run("npm", ["pack", "--silent", "--pack-destination", ".."], stage)
const [tgz] = readdirSync(out).filter((f) => f.endsWith(".tgz"))
// A fixed name as well, so `releases/latest/download/kandy.tgz` is one URL forever.
copyFileSync(path.join(out, tgz), path.join(out, "kandy.tgz"))
rmSync(stage, { recursive: true, force: true })
console.log(`\n  release/${tgz}\n  release/kandy.tgz`)

function pick(o, ...keys) {
  return Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]))
}
