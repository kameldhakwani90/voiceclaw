// Verifies the voice-turn trace input mirrors what the realtime provider
// actually saw: base instructions + provider-folded resume preamble in the
// system block, plus any recent verbatim turns the adapter injected.
//
// Run: yarn workspace relay-server tsx test/test-tracing-includes-resume-preamble.ts

import { composeTurnInput, TurnTracer } from "../src/tracing/turn-tracer.js"
import { GeminiAdapter } from "../src/adapters/gemini.js"
import { OpenAIAdapter } from "../src/adapters/openai.js"
import type { SessionConfigEvent } from "../src/types.js"
import { WebSocketServer, WebSocket as WsSocket } from "ws"

type RelayEvent = { type: string }

let passed = 0
let failed = 0

function assert(condition: boolean, name: string) {
  if (condition) {
    console.log(`  PASS: ${name}`)
    passed++
  } else {
    console.log(`  FAIL: ${name}`)
    failed++
  }
}

async function runComposeUnitTests() {
  console.log("composeTurnInput unit tests")
  console.log("===========================")

  {
    const out = composeTurnInput("BASE", null, [], "")
    assert(out.length === 1, "system-only when no preamble, no history, no user text")
    assert(out[0].role === "system" && out[0].content === "BASE", "system content equals base")
  }

  {
    const out = composeTurnInput("BASE", "PREAMBLE", [], "hello")
    assert(out.length === 2, "system + user when preamble + user text")
    assert(out[0].role === "system" && out[0].content === "BASE\n\nPREAMBLE", "system content concatenates base + preamble")
    assert(out[1].role === "user" && out[1].content === "hello", "user content is current user text")
  }

  {
    const history = [
      { role: "user" as const, text: "u1" },
      { role: "assistant" as const, text: "a1" },
      { role: "user" as const, text: "u2" },
    ]
    const out = composeTurnInput("BASE", null, history, "now")
    assert(out.length === 5, "system + 3 history + current user")
    assert(out[1].role === "user" && out[1].content === "u1", "history[0] preserved")
    assert(out[2].role === "assistant" && out[2].content === "a1", "history[1] preserved")
    assert(out[3].role === "user" && out[3].content === "u2", "history[2] preserved")
    assert(out[4].role === "user" && out[4].content === "now", "current user is last")
  }

  {
    const out = composeTurnInput(null, null, [], "lonely")
    assert(out.length === 1, "user-only when no system content")
    assert(out[0].role === "user" && out[0].content === "lonely", "user content preserved")
  }
}

async function runGeminiPreambleWiringTest() {
  console.log("\nGemini adapter exposes resumePreamble for the tracer")
  console.log("====================================================")

  process.env.GEMINI_API_KEY = "test-key"

  const MOCK_PORT = 19911
  const wss = await new Promise<WebSocketServer>((resolve) => {
    const server = new WebSocketServer({ port: MOCK_PORT })
    server.on("connection", (ws: WsSocket) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(String(raw))
        if (msg.setup) ws.send(JSON.stringify({ setupComplete: {} }))
      })
    })
    server.on("listening", () => resolve(server))
  })

  try {
    const longHistory = Array.from({ length: 20 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      text: `turn ${i}`,
    }))
    const config: SessionConfigEvent = {
      type: "session.config",
      provider: "gemini",
      voice: "Zephyr",
      brainAgent: "none",
      apiKey: "test",
      conversationHistory: longHistory,
    }

    const adapter = new GeminiAdapter()
    ;(adapter as unknown as { wsUrlOverride: string }).wsUrlOverride = `ws://localhost:${MOCK_PORT}`

    await adapter.connect(config, (_e: RelayEvent) => {})

    const preamble = adapter.getResumePreamble?.() ?? ""
    assert(preamble.length > 0, "Gemini adapter exposes a non-empty resume preamble")
    assert(preamble.includes("turn 19"), "preamble includes the most recent turn verbatim")

    const tracer = new TurnTracer()
    tracer.startSession("session-1", "user-1", "gemini-test", "BASE_INSTRUCTIONS")
    tracer.setSessionPreamble(preamble)
    tracer.setResumeHistory(adapter.getResumeHistory?.() ?? [])

    const composed = composeTurnInput(
      "BASE_INSTRUCTIONS",
      preamble,
      adapter.getResumeHistory?.() ?? [],
      "current user utterance",
    )
    assert(composed[0].role === "system", "composed[0] is system")
    assert(composed[0].content.startsWith("BASE_INSTRUCTIONS"), "system starts with base instructions")
    assert(composed[0].content.includes("turn 19"), "system includes recent-turn verbatim from preamble")
    assert(composed[composed.length - 1].role === "user", "last message is current user turn")
    assert(composed[composed.length - 1].content === "current user utterance", "last message content matches")

    adapter.disconnect()
  } finally {
    await new Promise<void>((resolve) => wss.close(() => resolve()))
  }
}

async function runOpenAIHistoryWiringTest() {
  console.log("\nOpenAI adapter exposes recent verbatim turns for the tracer")
  console.log("===========================================================")

  process.env.OPENAI_API_KEY = "test-key"

  const MOCK_PORT = 19912
  const wss = await new Promise<WebSocketServer>((resolve) => {
    const server = new WebSocketServer({ port: MOCK_PORT })
    server.on("connection", (ws: WsSocket) => {
      ws.on("message", () => {
        // discard
      })
      ws.send(JSON.stringify({ type: "session.created" }))
    })
    server.on("listening", () => resolve(server))
  })

  try {
    const history = [
      { role: "user" as const, text: "where did we leave off?" },
      { role: "assistant" as const, text: "we were debugging the trace input" },
      { role: "user" as const, text: "right, the system block" },
      { role: "assistant" as const, text: "yes, missing the preamble" },
    ]
    const config: SessionConfigEvent = {
      type: "session.config",
      provider: "openai",
      voice: "marin",
      brainAgent: "none",
      apiKey: "test",
      conversationHistory: history,
    }

    const adapter = new OpenAIAdapter({
      providerName: "openai-test",
      realtimeUrl: `ws://localhost:${MOCK_PORT}`,
      apiKeyEnv: "OPENAI_API_KEY",
      defaultModel: "gpt-realtime-mini",
      defaultVoice: "marin",
      authHeaders: {},
      sessionFormat: "openai",
    })

    await adapter.connect(config, (_e: RelayEvent) => {})

    const exposedHistory = adapter.getResumeHistory?.() ?? []
    assert(exposedHistory.length === history.length, "OpenAI adapter exposes all recent verbatim turns")
    assert(exposedHistory[0].text === history[0].text, "first verbatim turn preserved")
    assert(exposedHistory[history.length - 1].text === history[history.length - 1].text, "last verbatim turn preserved")

    adapter.disconnect()
  } finally {
    await new Promise<void>((resolve) => wss.close(() => resolve()))
  }
}

async function main() {
  await runComposeUnitTests()
  await runGeminiPreambleWiringTest()
  await runOpenAIHistoryWiringTest()

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
