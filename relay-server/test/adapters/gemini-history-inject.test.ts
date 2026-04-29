import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { WebSocketServer, WebSocket as WsSocket } from "ws"
import { GeminiAdapter } from "../../src/adapters/gemini.js"
import type { SessionConfigEvent } from "../../src/types.js"

interface MockUpstream {
  port: number
  setups: Record<string, unknown>[]
  clientContent: Record<string, unknown>[]
  close: () => Promise<void>
}

describe("GeminiAdapter conversation history injection", () => {
  let upstream: MockUpstream | null = null
  const adapters: GeminiAdapter[] = []

  beforeAll(() => {
    process.env.GEMINI_API_KEY = "test-key"
    process.env.OPENAI_API_KEY = ""
  })

  afterEach(async () => {
    for (const a of adapters) a.disconnect()
    adapters.length = 0
    if (upstream) {
      await upstream.close()
      upstream = null
    }
  })

  it("folds recent history into systemInstruction and sends no clientContent", async () => {
    upstream = await mountMockUpstream()
    const config = makeConfig([
      { role: "user", text: "Hi" },
      { role: "assistant", text: "Hello! How can I help?" },
      { role: "user", text: "" },
      { role: "user", text: "What's the weather?" },
      { role: "assistant", text: "Sunny." },
    ])

    const adapter = makeAdapter(adapters, upstream.port)
    await adapter.connect(config, () => {})
    await waitMs(200)

    expect(upstream.setups).toHaveLength(1)
    const setup = upstream.setups[0] as {
      historyConfig?: unknown
      systemInstruction?: { parts?: { text?: string }[] }
    }
    expect(setup.historyConfig).toBeUndefined()
    expect(upstream.clientContent).toHaveLength(0)

    const sysText = setup.systemInstruction?.parts?.[0]?.text ?? ""
    expect(sysText).toContain("Most recent turns (verbatim)")
    expect(sysText).toContain("User: Hi")
    expect(sysText).toContain("Assistant: Hello! How can I help?")
    expect(sysText).toContain("User: What's the weather?")
    expect(sysText).toContain("Assistant: Sunny.")
    expect(/^User:\s*$/m.test(sysText)).toBe(false)
    expect(/^Assistant:\s*$/m.test(sysText)).toBe(false)
  })

  it("preserves order of consecutive same-role turns", async () => {
    upstream = await mountMockUpstream()
    const config = makeConfig([
      { role: "user", text: "first" },
      { role: "user", text: "second" },
      { role: "assistant", text: "ok" },
    ])

    const adapter = makeAdapter(adapters, upstream.port)
    await adapter.connect(config, () => {})
    await waitMs(200)

    const sys = (upstream.setups[0] as { systemInstruction?: { parts?: { text?: string }[] } })
      ?.systemInstruction?.parts?.[0]?.text ?? ""
    expect(sys).toContain("User: first")
    expect(sys).toContain("User: second")
    expect(sys.indexOf("User: first")).toBeLessThan(sys.indexOf("User: second"))
    expect(sys.indexOf("User: second")).toBeLessThan(sys.indexOf("Assistant: ok"))
    expect(upstream.clientContent).toHaveLength(0)
  })

  it("omits history sections when no history is provided", async () => {
    upstream = await mountMockUpstream()
    const config = makeConfig(undefined)

    const adapter = makeAdapter(adapters, upstream.port)
    await adapter.connect(config, () => {})
    await waitMs(150)

    const sys = (upstream.setups[0] as { systemInstruction?: { parts?: { text?: string }[] } })
      ?.systemInstruction?.parts?.[0]?.text ?? ""
    expect(sys).not.toContain("Most recent turns")
    expect(sys).not.toContain("Earlier in this conversation")
    expect(upstream.clientContent).toHaveLength(0)
  })

  it("omits history when every entry is whitespace or empty", async () => {
    upstream = await mountMockUpstream()
    const config = makeConfig([
      { role: "user", text: "" },
      { role: "assistant", text: "   " },
    ])

    const adapter = makeAdapter(adapters, upstream.port)
    await adapter.connect(config, () => {})
    await waitMs(150)

    const sys = (upstream.setups[0] as { systemInstruction?: { parts?: { text?: string }[] } })
      ?.systemInstruction?.parts?.[0]?.text ?? ""
    expect(sys).not.toContain("Most recent turns")
    expect(upstream.clientContent).toHaveLength(0)
  })
})

async function mountMockUpstream(): Promise<MockUpstream> {
  const setups: Record<string, unknown>[] = []
  const clientContent: Record<string, unknown>[] = []
  const wss = new WebSocketServer({ port: 0 })
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()))
  const address = wss.address()
  const port = typeof address === "object" && address ? address.port : 0

  wss.on("connection", (ws: WsSocket) => {
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw))
      if (msg.setup) {
        setups.push(msg.setup)
        ws.send(JSON.stringify({ setupComplete: {} }))
      } else if (msg.clientContent) {
        clientContent.push(msg.clientContent)
      }
    })
  })

  return {
    port,
    setups,
    clientContent,
    close: () => new Promise<void>((resolve) => wss.close(() => resolve())),
  }
}

function makeConfig(history: SessionConfigEvent["conversationHistory"]): SessionConfigEvent {
  return {
    type: "session.config",
    provider: "gemini",
    model: "gemini-3.1-flash-live-preview",
    voice: "Zephyr",
    apiKey: "test",
    brainAgent: "none",
    deviceContext: { timezone: "UTC", locale: "en-US", deviceModel: "mock" },
    conversationHistory: history,
  }
}

function makeAdapter(pool: GeminiAdapter[], port: number): GeminiAdapter {
  const adapter = new GeminiAdapter()
  ;(adapter as unknown as { wsUrlOverride: string }).wsUrlOverride = `ws://localhost:${port}`
  pool.push(adapter)
  return adapter
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
