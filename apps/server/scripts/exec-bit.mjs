import { chmodSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Keep the POSIX executable bits without making Windows builds depend on chmod.
 *
 * The old shell command failed on Windows after tsc had written both files.
 * npm creates a command shim there, so these files need no executable bit.
 * On POSIX, a missing file or a failed chmod still fails the build.
 */
const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

if (process.platform === "win32") {
  console.log("  exec-bit: no executable bit on Windows")
} else {
  for (const rel of ["dist/cli.js", "dist/bin.js"]) {
    chmodSync(path.join(pkg, rel), 0o755)
  }
}
