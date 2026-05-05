#!/usr/bin/env node
// Build the ax-capture Swift sidecar as a universal binary and stage it
// under desktop/resources/bin/ so electron-builder picks it up via
// extraResources.
//
// Output: desktop/resources/bin/ax-capture (arm64+x86_64 universal)
import { execSync, spawnSync } from "node:child_process"
import { mkdirSync, copyFileSync, existsSync, readdirSync, statSync } from "node:fs"
import { dirname, resolve, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const desktopRoot = resolve(here, "..")
const pkgDir = resolve(desktopRoot, "native/ax-capture")
const sourcesDir = resolve(pkgDir, "Sources")
const packageManifest = resolve(pkgDir, "Package.swift")
const outDir = resolve(desktopRoot, "resources/bin")
const outBin = resolve(outDir, "ax-capture")

if (!existsSync(pkgDir)) {
  console.error(`[build-ax-capture] package missing: ${pkgDir}`)
  process.exit(1)
}

mkdirSync(outDir, { recursive: true })

// Skip the rebuild when no Swift source has changed since the last output.
// Keeps `yarn dev` tight — the Swift compile is ~4 s otherwise, paid on
// every Electron restart even when nothing has moved.
if (existsSync(outBin) && process.env.AX_FORCE_REBUILD !== "1") {
  const outMtime = statSync(outBin).mtimeMs
  const newest = newestSourceMtime(sourcesDir, statSync(packageManifest).mtimeMs)
  if (newest <= outMtime) {
    console.log("[build-ax-capture] up-to-date, skipping (AX_FORCE_REBUILD=1 to override)")
    process.exit(0)
  }
}

// Distribution builds (yarn dist:mac sets ELECTRON_BUILDER_RUNNING=1 via
// scripts/with-build-env.mjs) MUST produce a universal binary; shipping a
// silent arm64-only sidecar would crash on Intel installs. Dev builds may
// fall back to arm64-only when the x86_64 toolchain is missing.
const requireUniversal =
  process.env.ELECTRON_BUILDER_RUNNING === "1" ||
  process.env.AX_REQUIRE_UNIVERSAL === "1"

const archs = ["arm64", "x86_64"]
const builtBins = []
for (const arch of archs) {
  console.log(`[build-ax-capture] swift build --arch ${arch}`)
  const r = spawnSync(
    "swift",
    ["build", "-c", "release", "--arch", arch, "--package-path", pkgDir],
    { stdio: "inherit" },
  )
  if (r.status !== 0) {
    if (arch === "x86_64" && !requireUniversal) {
      console.warn(
        "[build-ax-capture] x86_64 build failed (likely missing toolchain on Apple Silicon dev). Falling back to arm64-only.",
      )
      continue
    }
    console.error(
      `[build-ax-capture] ${arch} build failed; aborting (universal required for distribution builds)`,
    )
    process.exit(r.status ?? 1)
  }
  const built = execSync(
    `swift build -c release --arch ${arch} --package-path "${pkgDir}" --show-bin-path`,
  ).toString().trim()
  builtBins.push(resolve(built, "AXCapture"))
}

if (builtBins.length === 0) {
  console.error("[build-ax-capture] no architectures built")
  process.exit(1)
}

if (builtBins.length === 1) {
  copyFileSync(builtBins[0], outBin)
} else {
  const lipo = spawnSync("lipo", ["-create", "-output", outBin, ...builtBins], { stdio: "inherit" })
  if (lipo.status !== 0) {
    console.error("[build-ax-capture] lipo failed; aborting")
    process.exit(lipo.status ?? 1)
  }
}
const chmod = spawnSync("chmod", ["+x", outBin])
if (chmod.status !== 0) {
  console.error("[build-ax-capture] chmod failed; aborting")
  process.exit(chmod.status ?? 1)
}
if (!existsSync(outBin)) {
  console.error(`[build-ax-capture] expected ${outBin} after build but it is missing`)
  process.exit(1)
}

console.log(`[build-ax-capture] -> ${outBin}`)

function newestSourceMtime(root, seed) {
  let newest = seed
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) stack.push(p)
      else newest = Math.max(newest, statSync(p).mtimeMs)
    }
  }
  return newest
}
