import { describe, expect, it } from "vitest"
import { usageToOtelAttrs } from "../../src/tracing/turn-tracer.js"

describe("usageToOtelAttrs", () => {
  it("maps all usage fields to vendor-neutral OTel attrs", () => {
    const attrs = usageToOtelAttrs({
      promptTokens: 123,
      completionTokens: 45,
      inputAudioTokens: 67,
      outputAudioTokens: 89,
    })

    expect(attrs["gen_ai.usage.input_tokens"]).toBe(123)
    expect(attrs["gen_ai.usage.output_tokens"]).toBe(45)
    expect(attrs["gen_ai.usage.input_audio_tokens"]).toBe(67)
    expect(attrs["gen_ai.usage.output_audio_tokens"]).toBe(89)
  })

  it("only sets keys for fields that were provided", () => {
    const partial = usageToOtelAttrs({ inputAudioTokens: 10 })
    expect(Object.keys(partial)).toHaveLength(1)
    expect(partial["gen_ai.usage.input_audio_tokens"]).toBe(10)
  })

  it("returns an empty object when no fields are provided", () => {
    const empty = usageToOtelAttrs({})
    expect(Object.keys(empty)).toHaveLength(0)
  })
})
