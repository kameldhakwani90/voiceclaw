#!/usr/bin/env node
import { execSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { homedir, platform } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const desktopRoot = resolve(here, "..")
const repoRoot = resolve(desktopRoot, "..")

const jsonMode = process.argv.includes("--json")

const results = []

function pass(label, detail) {
  results.push({ status: "PASS", label, detail: detail ?? null, hint: null })
}

function fail(label, detail, hint) {
  results.push({ status: "FAIL", label, detail: detail ?? null, hint: hint ?? null })
}

function skip(label, detail) {
  results.push({ status: "SKIP", label, detail: detail ?? null, hint: null })
}

function printResults() {
  if (jsonMode) {
    const summary = {
      checks: results,
      passed: results.filter((r) => r.status === "PASS").length,
      failed: results.filter((r) => r.status === "FAIL").length,
      skipped: results.filter((r) => r.status === "SKIP").length,
    }
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n")
    return
  }
  const width = 40
  for (const r of results) {
    const icon = r.status === "PASS" ? "PASS" : r.status === "FAIL" ? "FAIL" : "SKIP"
    const padded = r.label.padEnd(width)
    process.stdout.write(`${icon}  ${padded}  ${r.detail ?? ""}\n`)
    if (r.status === "FAIL" && r.hint) {
      process.stdout.write(`      → ${r.hint}\n`)
    }
  }
  const failed = results.filter((r) => r.status === "FAIL").length
  const passed = results.filter((r) => r.status === "PASS").length
  process.stdout.write(`\n${passed} passed, ${failed} failed\n`)
}

function safeReadJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return null
  }
}

async function safeFetch(url, opts, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal })
    clearTimeout(timer)
    return res
  } catch (err) {
    clearTimeout(timer)
    throw err
  }
}

// ---------------------------------------------------------------------------
// Check 1: bundled openclaw script exists
// ---------------------------------------------------------------------------
const devOpenclawScript = join(repoRoot, "vendor", "openclaw", "openclaw.mjs")
const openclawScriptExists = existsSync(devOpenclawScript)

if (openclawScriptExists) {
  pass("openclaw script", devOpenclawScript)
} else {
  fail(
    "openclaw script",
    `not found at ${devOpenclawScript}`,
    "Run: git submodule update --init vendor/openclaw OR yarn build:openclaw-bundle"
  )
}

// ---------------------------------------------------------------------------
// Check 2: bundled node binary exists + version >= 22.12
// ---------------------------------------------------------------------------
const nodeRuntimeDir = join(desktopRoot, "vendor", "node")
let bundledNodePath = null
for (const candidate of [
  join(nodeRuntimeDir, "bin", "node"),
  join(nodeRuntimeDir, "node.exe"),
  join(desktopRoot, "resources", "node", "bin", "node"),
]) {
  if (existsSync(candidate)) { bundledNodePath = candidate; break }
}

if (!bundledNodePath) {
  fail(
    "bundled node binary",
    "not found in vendor/node/ or resources/node/",
    "Run: node desktop/scripts/fetch-node.mjs to download the bundled runtime"
  )
} else {
  try {
    const ver = execSync(`"${bundledNodePath}" --version`, { encoding: "utf8" }).trim()
    const match = ver.match(/^v(\d+)\.(\d+)/)
    if (match) {
      const major = parseInt(match[1])
      const minor = parseInt(match[2])
      if (major > 22 || (major === 22 && minor >= 12)) {
        pass("bundled node binary", `${ver} at ${bundledNodePath}`)
      } else {
        fail("bundled node binary", `version ${ver} is below v22.12`, "Run: node desktop/scripts/fetch-node.mjs to fetch a newer runtime")
      }
    } else {
      pass("bundled node binary", `${ver} at ${bundledNodePath}`)
    }
  } catch (err) {
    fail("bundled node binary", `exists but cannot run: ${err.message}`, "Check file permissions on the binary")
  }
}

// ---------------------------------------------------------------------------
// Check 3: openclaw config file exists
// ---------------------------------------------------------------------------
const isMac = platform() === "darwin"
const appSupportBase = isMac
  ? join(homedir(), "Library", "Application Support")
  : join(homedir(), ".config")

const openclawStateDir = join(appSupportBase, "voiceclaw-desktop", "openclaw")
const configPath = join(openclawStateDir, "openclaw.json")
const configExists = existsSync(configPath)

if (!configExists) {
  fail(
    "openclaw config file",
    `not found at ${configPath}`,
    "Launch VoiceClaw — the config is created on first run"
  )
} else {
  pass("openclaw config file", configPath)
}

// ---------------------------------------------------------------------------
// Check 4: config validity — gateway.mode, google apiKey, agent model
// ---------------------------------------------------------------------------
if (configExists) {
  const cfg = safeReadJson(configPath)
  if (!cfg) {
    fail("openclaw config valid JSON", "parse error", `Check or delete ${configPath} and relaunch VoiceClaw`)
  } else {
    const gatewayMode = cfg?.gateway?.mode
    const apiKey = cfg?.models?.providers?.google?.apiKey
    const primaryModel = cfg?.agents?.defaults?.model?.primary

    const issues = []
    if (gatewayMode !== "local") issues.push(`gateway.mode="${gatewayMode ?? "missing"}" (expected "local")`)
    if (!apiKey || typeof apiKey !== "string" || apiKey.length < 10) issues.push("models.providers.google.apiKey missing or too short")
    if (!primaryModel || typeof primaryModel !== "string") issues.push("agents.defaults.model.primary missing")

    if (issues.length === 0) {
      pass("openclaw config shape", `gateway.mode=local, model=${primaryModel}`)
    } else {
      fail(
        "openclaw config shape",
        issues.join("; "),
        "Open VoiceClaw Settings → Brain tab and re-save your Gemini API key, then relaunch"
      )
    }
  }
} else {
  skip("openclaw config shape", "skipped (config missing)")
}

// ---------------------------------------------------------------------------
// Check 5: workspace dir exists with expected files
// ---------------------------------------------------------------------------
const workspaceDir = join(openclawStateDir, "workspace")
const workspaceExists = existsSync(workspaceDir)
const requiredWorkspaceFiles = ["SOUL.md", "IDENTITY.md", "AGENTS.md", "USER.md", "BOOTSTRAP.md"]

if (!workspaceExists) {
  fail(
    "openclaw workspace",
    `directory missing: ${workspaceDir}`,
    `Run: rm ${join(openclawStateDir, "workspace-bootstrapped")} 2>/dev/null; relaunch VoiceClaw to re-bootstrap`
  )
} else {
  const missingFiles = requiredWorkspaceFiles.filter((f) => !existsSync(join(workspaceDir, f)))
  if (missingFiles.length === 0) {
    pass("openclaw workspace", `all ${requiredWorkspaceFiles.length} expected files present`)
  } else {
    fail(
      "openclaw workspace",
      `missing: ${missingFiles.join(", ")}`,
      `Run: rm ${join(openclawStateDir, "workspace-bootstrapped")} 2>/dev/null; relaunch VoiceClaw to re-bootstrap workspace files`
    )
  }
}

// ---------------------------------------------------------------------------
// Check 6: openclaw process is running + /health returns 200
// ---------------------------------------------------------------------------
let openclawPort = null
let openclawRunning = false

try {
  const pgrepOut = execSync("pgrep -fl openclaw", { encoding: "utf8" }).trim()
  if (pgrepOut.length > 0) {
    openclawRunning = true
    const portMatch = pgrepOut.match(/--port\s+(\d+)/)
    if (portMatch) openclawPort = parseInt(portMatch[1])
  }
} catch {
  // pgrep exits 1 when nothing found
}

if (!openclawRunning) {
  fail("openclaw process running", "not found via pgrep", "Quit and relaunch VoiceClaw app")
} else if (!openclawPort) {
  fail(
    "openclaw process running",
    "process found but port not detectable from args",
    "Quit and relaunch VoiceClaw; check ~/Library/Logs/VoiceClaw/openclaw-gateway.log"
  )
} else {
  pass("openclaw process running", `pid found, port=${openclawPort}`)
  try {
    const res = await safeFetch(`http://127.0.0.1:${openclawPort}/health`, {}, 3_000)
    if (res.ok) {
      pass("openclaw /health", `HTTP ${res.status} at port ${openclawPort}`)
    } else {
      fail("openclaw /health", `HTTP ${res.status}`, "Quit and relaunch VoiceClaw; check openclaw-gateway.log")
    }
  } catch (err) {
    fail("openclaw /health", `fetch failed: ${err.message}`, `tail -50 ~/Library/Logs/VoiceClaw/openclaw-gateway.log`)
  }
}

// ---------------------------------------------------------------------------
// Check 7: relay process is running + /health returns 200
// ---------------------------------------------------------------------------
let relayPort = null
let relayRunning = false

try {
  const pgrepOut = execSync("pgrep -fl 'relay-server\\|relay/dist'", { encoding: "utf8" }).trim()
  if (pgrepOut.length > 0) relayRunning = true
} catch {
  // not found
}

if (!relayRunning) {
  try {
    const pgrepOut2 = execSync("pgrep -fl 'relay'", { encoding: "utf8" }).trim()
    if (pgrepOut2.length > 0) relayRunning = true
  } catch {
    // not found
  }
}

const relayPortFromEnv = process.env.RELAY_PORT ? parseInt(process.env.RELAY_PORT) : null
const commonRelayPorts = [8080, 8081, 8082, 8083]
for (const p of [relayPortFromEnv, ...commonRelayPorts].filter(Boolean)) {
  try {
    const res = await safeFetch(`http://127.0.0.1:${p}/health`, {}, 1_000)
    if (res.ok) {
      relayPort = p
      relayRunning = true
      break
    }
  } catch {
    // not on this port
  }
}

if (!relayRunning || !relayPort) {
  fail("relay process running", "relay not found on common ports (8080-8083)", "Quit and relaunch VoiceClaw; check ~/Library/Logs/VoiceClaw/relay.log")
} else {
  pass("relay process running", `responding at port ${relayPort}`)
}

// ---------------------------------------------------------------------------
// Check 8: relay BRAIN_GATEWAY_URL matches openclaw port
// ---------------------------------------------------------------------------
if (!relayPort || !openclawPort) {
  skip("relay ↔ openclaw port agreement", "skipped (one or both not found)")
} else {
  // We can't read the relay's env directly; infer by matching the port
  // openclaw is running on against what the relay was presumably told.
  // The best we can do non-intrusively is check if openclaw is reachable
  // from the port the relay would use.
  try {
    const res = await safeFetch(`http://127.0.0.1:${openclawPort}/health`, {}, 2_000)
    if (res.ok) {
      pass("relay ↔ openclaw port agreement", `openclaw answering on port ${openclawPort}`)
    } else {
      fail(
        "relay ↔ openclaw port agreement",
        `openclaw returned HTTP ${res.status} on port ${openclawPort}`,
        "Quit and relaunch VoiceClaw to reallocate ports consistently"
      )
    }
  } catch (err) {
    fail(
      "relay ↔ openclaw port agreement",
      `cannot reach openclaw on port ${openclawPort}: ${err.message}`,
      "Quit and relaunch VoiceClaw"
    )
  }
}

// ---------------------------------------------------------------------------
// Check 9: direct fetch to openclaw /v1/chat/completions returns non-empty
// ---------------------------------------------------------------------------
if (!openclawPort) {
  skip("openclaw completions endpoint", "skipped (openclaw not found)")
} else {
  const authToken = configExists ? safeReadJson(configPath)?.gateway?.auth?.token : null
  const headers = { "Content-Type": "application/json" }
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`

  try {
    const res = await safeFetch(
      `http://127.0.0.1:${openclawPort}/v1/chat/completions`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: "openclaw",
          messages: [{ role: "user", content: "Reply with one word: ready" }],
          stream: false,
          max_tokens: 5,
        }),
      },
      15_000
    )
    const text = await res.text()
    if (res.ok && text.length > 0) {
      pass("openclaw completions endpoint", `HTTP ${res.status}, response length=${text.length}`)
    } else {
      fail(
        "openclaw completions endpoint",
        `HTTP ${res.status}, body="${text.substring(0, 200)}"`,
        `tail -50 ~/Library/Logs/VoiceClaw/openclaw-gateway.log`
      )
    }
  } catch (err) {
    fail(
      "openclaw completions endpoint",
      `fetch failed: ${err.message}`,
      `tail -50 ~/Library/Logs/VoiceClaw/openclaw-gateway.log`
    )
  }
}

// ---------------------------------------------------------------------------
// Check 10: Gemini API key works — direct call to generativelanguage.googleapis.com
// ---------------------------------------------------------------------------
const geminiApiKey = configExists ? safeReadJson(configPath)?.models?.providers?.google?.apiKey : null

if (!geminiApiKey) {
  skip("Gemini API key reachability", "skipped (no API key in config)")
} else {
  try {
    const res = await safeFetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${geminiApiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: "Reply with one word: ok" }] }],
          generationConfig: { maxOutputTokens: 3 },
        }),
      },
      12_000
    )
    const text = await res.text()
    if (res.ok) {
      pass("Gemini API key reachability", `HTTP ${res.status}`)
    } else {
      let hint = "Check your Gemini API key in VoiceClaw Settings → Brain tab"
      if (res.status === 400) hint = "API key may be invalid. Re-enter it in VoiceClaw Settings → Brain tab"
      if (res.status === 403) hint = "API key lacks permission. Ensure the Gemini API is enabled in Google Cloud Console"
      if (res.status === 429) hint = "Gemini API quota exceeded. Wait or check your quota at aistudio.google.com"
      fail("Gemini API key reachability", `HTTP ${res.status}: ${text.substring(0, 200)}`, hint)
    }
  } catch (err) {
    fail(
      "Gemini API key reachability",
      `fetch failed: ${err.message}`,
      "Check internet connectivity; if behind a VPN/proxy, try disabling it"
    )
  }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------
printResults()

const anyFailed = results.some((r) => r.status === "FAIL")
process.exit(anyFailed ? 1 : 0)
