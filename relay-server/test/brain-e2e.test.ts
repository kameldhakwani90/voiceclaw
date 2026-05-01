import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { createServer, type Server as HttpServer } from "node:http"
import { createServer as createNetServer } from "node:net"
import type { AddressInfo } from "node:net"
import { context, propagation, trace } from "@opentelemetry/api"
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base"
import { W3CTraceContextPropagator } from "@opentelemetry/core"
import { AsyncHooksContextManager } from "@opentelemetry/context-async-hooks"
import { askBrain } from "../src/tools/brain.js"
import { RelaySession } from "../src/session.js"
import type { ProviderAdapter } from "../src/adapters/types.js"
import type { RelayEvent, SessionConfigEvent } from "../src/types.js"
import { spawn, type ChildProcess } from "node:child_process"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const relayRoot = resolve(here, "..")

// ---------------------------------------------------------------------------
// brain:e2e:mock — fast in-process tests using a stubbed HTTP gateway
// ---------------------------------------------------------------------------

describe("brain:e2e:mock — askBrain + session routing with stubbed gateway", () => {
  let mockServer: HttpServer
  let mockPort: number

  beforeAll(async () => {
    const provider = new BasicTracerProvider()
    trace.setGlobalTracerProvider(provider)
    propagation.setGlobalPropagator(new W3CTraceContextPropagator())
    const ctxManager = new AsyncHooksContextManager().enable()
    context.setGlobalContextManager(ctxManager)

    mockPort = await getFreePort()

    await new Promise<void>((res, rej) => {
      mockServer = createServer((req, resp) => {
        if (req.url !== "/v1/chat/completions") {
          resp.writeHead(404).end()
          return
        }
        resp.writeHead(200, { "Content-Type": "text/event-stream" })
        const choice = { choices: [{ delta: { content: "Hello from mock brain" } }] }
        resp.write(`data: ${JSON.stringify(choice)}\n\n`)
        resp.write("data: [DONE]\n\n")
        resp.end()
      })
      mockServer.listen(mockPort, "127.0.0.1", () => res())
      mockServer.on("error", rej)
    })
  }, 10_000)

  afterAll(async () => {
    await new Promise<void>((res) => mockServer.close(() => res()))
    delete process.env.BRAIN_GATEWAY_URL
  })

  it("askBrain returns non-empty content from mock gateway within 10s", async () => {
    const result = await askBrain(
      "what is 2+2?",
      {
        gatewayUrl: `http://127.0.0.1:${mockPort}`,
        authToken: "test-token",
        sessionId: "e2e-mock-session",
      },
      () => {},
      "e2e-call-1",
    )

    expect(result).toBeTruthy()
    expect(typeof result).toBe("string")
    expect(result.length).toBeGreaterThan(0)
    expect(result).not.toContain('"error"')
  }, 10_000)

  it("brain.result carries upstream detail when gateway returns empty SSE stream", async () => {
    const emptyPort = await getFreePort()
    const emptyServer = createServer((req, resp) => {
      if (req.url !== "/v1/chat/completions") { resp.writeHead(404).end(); return }
      resp.writeHead(200, { "Content-Type": "text/event-stream" })
      resp.write("data: [DONE]\n\n")
      resp.end()
    })
    await new Promise<void>((res, rej) => { emptyServer.listen(emptyPort, "127.0.0.1", () => res()); emptyServer.on("error", rej) })

    process.env.BRAIN_GATEWAY_URL = `http://127.0.0.1:${emptyPort}`

    const sentEvents: RelayEvent[] = []
    const ws = makeFakeWs((data) => sentEvents.push(JSON.parse(data) as RelayEvent))
    const session = new RelaySession(ws as unknown as never)
    const adapter = makeFakeAdapter({ onInjectContext: () => {}, onSendToolResult: () => {} })
    attachConfigAndAdapter(session, adapter)

    await invokeAskBrain(session, "e2e-empty-call", { query: "what is 2+2?" })

    const brainEvent = sentEvents.find((e) => e.type === "brain.result") as
      | { type: "brain.result"; callId: string; query: string; result?: string; error?: string }
      | undefined
    expect(brainEvent).toBeDefined()
    expect(brainEvent?.error).toBeTruthy()

    const errorPayload = (() => {
      try { return JSON.parse(brainEvent?.error ?? "") as Record<string, unknown> }
      catch { return null }
    })()
    expect(errorPayload).not.toBeNull()
    expect(errorPayload?.error).toBe("Empty response from brain agent")
    const upstream = errorPayload?.upstream as Record<string, unknown> | undefined
    expect(upstream).toBeTruthy()
    expect(upstream?.openclawLogHint).toContain("openclaw-gateway.log")
    expect(upstream?.httpStatus).toBe(200)

    await new Promise<void>((res) => emptyServer.close(() => res()))
    delete process.env.BRAIN_GATEWAY_URL
  }, 15_000)

  it("brain.result error includes ECONNREFUSED detail when gateway is unreachable", async () => {
    const deadPort = await getFreePort()

    process.env.BRAIN_GATEWAY_URL = `http://127.0.0.1:${deadPort}`

    const sentEvents: RelayEvent[] = []
    const ws = makeFakeWs((data) => sentEvents.push(JSON.parse(data) as RelayEvent))
    const session = new RelaySession(ws as unknown as never)
    const adapter = makeFakeAdapter({ onInjectContext: () => {}, onSendToolResult: () => {} })
    attachConfigAndAdapter(session, adapter)

    await invokeAskBrain(session, "e2e-dead-call", { query: "what is 2+2?" })

    const brainEvent = sentEvents.find((e) => e.type === "brain.result") as
      | { type: "brain.result"; callId: string; query: string; result?: string; error?: string }
      | undefined
    expect(brainEvent).toBeDefined()
    expect(brainEvent?.error).toBeTruthy()

    const errStr = brainEvent?.error ?? ""
    const errorPayload = (() => {
      try { return JSON.parse(errStr) as Record<string, unknown> }
      catch { return null }
    })()

    if (errorPayload) {
      expect(String(errorPayload.error)).toContain("Brain unreachable")
      const upstream = errorPayload.upstream as Record<string, unknown> | undefined
      expect(upstream).toBeTruthy()
      expect(upstream?.errorClass).toBeTruthy()
      expect(upstream?.url).toContain(String(deadPort))
    } else {
      expect(errStr).toContain("Brain unreachable")
    }

    delete process.env.BRAIN_GATEWAY_URL
  }, 15_000)
})

// ---------------------------------------------------------------------------
// brain:e2e:real — optional test using real openclaw subprocess
// ---------------------------------------------------------------------------

describe("brain:e2e:real — real openclaw subprocess (skipped when GEMINI_E2E_API_KEY absent)", () => {
  const geminiKey = process.env.GEMINI_E2E_API_KEY ?? process.env.GEMINI_API_KEY

  it.skipIf(!geminiKey)("returns non-empty response from real openclaw within 30s", async () => {
    if (!geminiKey) return

    const { existsSync } = await import("node:fs")
    const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")

    const openclawScript = resolve(relayRoot, "..", "vendor", "openclaw", "openclaw.mjs")
    if (!existsSync(openclawScript)) {
      console.warn("[e2e:real] vendor/openclaw/openclaw.mjs not found — skipping")
      return
    }

    const tmpDir = mkdtempSync(join(tmpdir(), "voiceclaw-brain-e2e-"))
    const stateDir = join(tmpDir, "openclaw")
    const workspaceDir = join(stateDir, "workspace")
    mkdirSync(workspaceDir, { recursive: true })

    const authToken = "e2e-real-token"
    const cfg = {
      gateway: { mode: "local", auth: { token: authToken, mode: "token" } },
      models: { providers: { google: { apiKey: geminiKey } } },
      agents: { defaults: { model: { primary: "google/gemini-2.0-flash-lite" } } },
      workspace: { dir: workspaceDir },
    }
    const configPath = join(stateDir, "openclaw.json")
    writeFileSync(configPath, JSON.stringify(cfg, null, 2))

    for (const name of ["SOUL.md", "IDENTITY.md", "AGENTS.md", "USER.md", "BOOTSTRAP.md"]) {
      writeFileSync(join(workspaceDir, name), `# ${name.replace(".md", "")}\nTest workspace.\n`)
    }

    const openclawPort = await getFreePort()
    const openclawProc = spawn(
      process.execPath,
      [openclawScript, "gateway", "--port", String(openclawPort)],
      {
        env: { ...process.env, OPENCLAW_CONFIG: configPath, HOME: tmpDir },
        stdio: "pipe",
      }
    )
    openclawProc.stderr?.on("data", () => {})
    openclawProc.stdout?.on("data", () => {})

    try {
      await waitForHealthy(`http://127.0.0.1:${openclawPort}/health`, 25_000).catch(() => {
        console.warn("[e2e:real] openclaw /health not reachable — attempting call anyway")
      })

      const result = await askBrain(
        "Reply with one word: ready",
        { gatewayUrl: `http://127.0.0.1:${openclawPort}`, authToken, sessionId: "e2e-real" },
        () => {},
        "e2e-real-call",
      )

      expect(result).toBeTruthy()
      expect(result.length).toBeGreaterThan(0)
      expect(result).not.toContain('"error":"Empty response')
    } finally {
      openclawProc.kill("SIGTERM")
      try {
        const { rmSync } = await import("node:fs")
        rmSync(tmpDir, { recursive: true, force: true })
      } catch { /* best-effort */ }
    }
  }, 45_000)
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getFreePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createNetServer()
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port
      srv.close(() => res(port))
    })
    srv.on("error", rej)
  })
}

async function waitForHealthy(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`${url} did not become healthy within ${timeoutMs}ms`)
}

function makeFakeWs(onSend: (data: string) => void) {
  return {
    readyState: 1, // OPEN
    OPEN: 1,
    send: (data: string) => onSend(data),
    on: () => {},
    once: () => {},
    off: () => {},
    close: () => {},
  }
}

function makeFakeAdapter(opts: {
  onInjectContext: (text: string) => void
  onSendToolResult: (callId: string, output: string) => void
}): ProviderAdapter {
  return {
    capabilities: { blockingToolResponse: false },
    connect: async () => {},
    disconnect: () => {},
    sendAudio: () => {},
    commitAudio: () => {},
    createResponse: () => {},
    cancelResponse: () => {},
    sendToolResult: opts.onSendToolResult,
    injectContext: opts.onInjectContext,
    getTranscript: () => [],
    sendFrame: () => {},
  } as unknown as ProviderAdapter
}

function attachConfigAndAdapter(session: RelaySession, adapter: ProviderAdapter) {
  const config: SessionConfigEvent = {
    type: "session.config",
    provider: "gemini",
    voice: "Puck",
    brainAgent: "enabled",
    apiKey: "test-api-key",
    sessionKey: "e2e-test-session",
  }
  ;(session as unknown as Record<string, unknown>)["config"] = config
  ;(session as unknown as Record<string, unknown>)["adapter"] = adapter
}

async function invokeAskBrain(
  session: RelaySession,
  callId: string,
  args: { query: string },
): Promise<void> {
  const s = session as unknown as Record<string, unknown>
  s["toolCallStartMs"] = s["toolCallStartMs"] ?? new Map()
  ;(s["toolCallStartMs"] as Map<string, number>).set(callId, Date.now())

  await new Promise<void>((resolve) => {
    const tracer = s["tracer"] as Record<string, unknown>
    const origEnd = tracer["endToolCall"]?.bind(tracer)
    tracer["endToolCall"] = (...args: unknown[]) => {
      origEnd?.(...args)
      setTimeout(resolve, 50)
    }
    ;(session as unknown as { handleAskBrain(callId: string, args: string): void })
      ["handleAskBrain"](callId, JSON.stringify(args))
  })
}
