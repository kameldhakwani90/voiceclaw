import { describe, expect, it } from "vitest"
import { OpenAIAdapter } from "../../src/adapters/openai.js"
import { GeminiAdapter } from "../../src/adapters/gemini.js"
import type { RelayEvent, SessionConfigEvent } from "../../src/types.js"

describe("OpenAI adapter latency emission", () => {
  it("emits server_eos endpoint metric for a normal turn", async () => {
    const { adapter, events } = setupOpenAi()

    fireUpstream(adapter, { type: "input_audio_buffer.speech_started" })
    adapter.sendAudio("AAAA")
    await sleep(20)
    adapter.sendAudio("BBBB")
    fireUpstream(adapter, { type: "input_audio_buffer.speech_stopped" })
    await sleep(50)
    fireUpstream(adapter, { type: "response.audio.delta", delta: "AAAA" })
    await sleep(5)
    fireUpstream(adapter, { type: "response.audio.delta", delta: "BBBB" })
    fireUpstream(adapter, { type: "response.done", response: { status: "completed" } })

    const latency = events.find(
      (e): e is Extract<RelayEvent, { type: "latency.metrics" }> => e.type === "latency.metrics",
    )
    expect(latency).toBeDefined()
    expect(latency!.endpointSource).toBe("server_eos")
    expectPositiveNumber(latency!.endpointMs)
    expectPositiveNumber(latency!.providerFirstByteMs)
    expectPositiveNumber(latency!.firstAudioFromTurnStartMs)
  })

  it("does not emit latency.metrics when a turn is interrupted", async () => {
    const { adapter, events } = setupOpenAi()
    ;(adapter as unknown as { isResponseActive: boolean }).isResponseActive = true

    fireUpstream(adapter, { type: "input_audio_buffer.speech_started" })
    adapter.sendAudio("AAAA")
    fireUpstream(adapter, { type: "input_audio_buffer.speech_stopped" })
    fireUpstream(adapter, { type: "response.audio.delta", delta: "AAAA" })
    adapter.cancelResponse()
    fireUpstream(adapter, { type: "response.done", response: { status: "cancelled" } })

    expect(events.find((e) => e.type === "latency.metrics")).toBeUndefined()
  })
})

describe("Gemini adapter latency emission", () => {
  it("emits transcription_proxy endpoint metric for a normal turn", async () => {
    const { adapter, events } = setupGemini()

    adapter.sendAudio(silentAudioBase64())
    await sleep(10)
    fireGemini(adapter, { inputTranscription: { text: "hello" } })
    adapter.sendAudio(silentAudioBase64())
    await sleep(20)
    fireGemini(adapter, { inputTranscription: { text: " there" } })
    await sleep(60)
    fireGemini(adapter, { modelTurn: { parts: [{ inlineData: { data: "AAAA" } }] } })
    fireGemini(adapter, { turnComplete: true })

    const latency = events.find(
      (e): e is Extract<RelayEvent, { type: "latency.metrics" }> => e.type === "latency.metrics",
    )
    expect(latency).toBeDefined()
    expect(latency!.endpointSource).toBe("transcription_proxy")
    expectPositiveNumber(latency!.endpointMs)
    expectPositiveNumber(latency!.providerFirstByteMs)
    expectPositiveNumber(latency!.firstAudioFromTurnStartMs)
  })

  it("does not emit latency.metrics when a turn is interrupted", async () => {
    const { adapter, events } = setupGemini()

    adapter.sendAudio(silentAudioBase64())
    fireGemini(adapter, { inputTranscription: { text: "hello" } })
    fireGemini(adapter, { modelTurn: { parts: [{ inlineData: { data: "AAAA" } }] } })
    fireGemini(adapter, { interrupted: true })
    fireGemini(adapter, { turnComplete: true })

    expect(events.find((e) => e.type === "latency.metrics")).toBeUndefined()
  })
})

function setupOpenAi(): { adapter: OpenAIAdapter, events: RelayEvent[] } {
  const adapter = new OpenAIAdapter()
  ;(adapter as unknown as { sendUpstream: () => boolean }).sendUpstream = () => true
  const events: RelayEvent[] = []
  ;(adapter as unknown as { sendToClient: (e: RelayEvent) => void }).sendToClient = (e) => events.push(e)
  ;(adapter as unknown as { config: SessionConfigEvent }).config = fakeConfig("openai")
  return { adapter, events }
}

function setupGemini(): { adapter: GeminiAdapter, events: RelayEvent[] } {
  const adapter = new GeminiAdapter()
  ;(adapter as unknown as { sendUpstream: () => void }).sendUpstream = () => {}
  const events: RelayEvent[] = []
  ;(adapter as unknown as { sendToClient: (e: RelayEvent) => void }).sendToClient = (e) => events.push(e)
  ;(adapter as unknown as { config: SessionConfigEvent }).config = fakeConfig("gemini")
  return { adapter, events }
}

function fakeConfig(provider: "openai" | "gemini"): SessionConfigEvent {
  return {
    type: "session.config",
    provider,
    voice: "default",
    brainAgent: "none",
    apiKey: "test",
  }
}

function fireUpstream(adapter: OpenAIAdapter, event: Record<string, unknown>) {
  ;(adapter as unknown as { handleUpstreamEvent: (e: Record<string, unknown>) => void }).handleUpstreamEvent(event)
}

function fireGemini(adapter: GeminiAdapter, serverContent: Record<string, unknown>) {
  ;(adapter as unknown as { handleServerContent: (s: Record<string, unknown>) => void }).handleServerContent(serverContent)
}

function expectPositiveNumber(v: unknown) {
  expect(typeof v).toBe("number")
  expect(Number.isFinite(v as number)).toBe(true)
  expect(v as number).toBeGreaterThanOrEqual(0)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function silentAudioBase64(): string {
  return Buffer.alloc(10 * 2).toString("base64")
}
