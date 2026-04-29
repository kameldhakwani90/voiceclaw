import { describe, it } from "vitest"

const COLLECTOR_URL = process.env.TRACING_UI_COLLECTOR_URL
const RUN_E2E = !!COLLECTOR_URL

describe("relay → collector usage attrs e2e", () => {
  it.skipIf(!RUN_E2E)("exports a voice-turn span with usage attrs to the running collector", async () => {
    const { initLangfuse, shutdownLangfuse } = await import("../../src/tracing/langfuse.js")
    const { TurnTracer } = await import("../../src/tracing/turn-tracer.js")

    initLangfuse()

    const tracer = new TurnTracer()
    const sessionKey = `usage-e2e-${Date.now()}`
    tracer.startSession(sessionKey, "usage-e2e-user", "gpt-realtime-mini", "test instructions")
    tracer.startTurn()
    tracer.appendUserText("hello")
    tracer.appendAssistantText("hi")
    tracer.attachUsage({
      promptTokens: 11,
      completionTokens: 7,
      inputAudioTokens: 13,
      outputAudioTokens: 17,
    })
    tracer.endSession()
    await shutdownLangfuse()
  })
})
