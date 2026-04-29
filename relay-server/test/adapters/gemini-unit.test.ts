import { describe, expect, it } from "vitest"

describe("Gemini audio resampling (24kHz → 16kHz)", () => {
  it("converts 24 input samples into 16 output samples", () => {
    const inputBuf = Buffer.alloc(24 * 2)
    for (let i = 0; i < 24; i++) inputBuf.writeInt16LE(1000, i * 2)

    const outputBuf = Buffer.from(downsample24to16(inputBuf.toString("base64")), "base64")
    expect(outputBuf.length / 2).toBe(16)
  })

  it("preserves a constant signal through resampling", () => {
    const inputBuf = Buffer.alloc(48 * 2)
    for (let i = 0; i < 48; i++) inputBuf.writeInt16LE(5000, i * 2)

    const outputBuf = Buffer.from(downsample24to16(inputBuf.toString("base64")), "base64")
    const samples = outputBuf.length / 2
    for (let i = 0; i < samples; i++) {
      expect(outputBuf.readInt16LE(i * 2)).toBe(5000)
    }
  })

  it("interpolates linearly between input samples", () => {
    const inputBuf = Buffer.alloc(6 * 2)
    for (let i = 0; i < 6; i++) inputBuf.writeInt16LE(i * 1500, i * 2)

    const outputBuf = Buffer.from(downsample24to16(inputBuf.toString("base64")), "base64")
    const samples = outputBuf.length / 2
    expect(samples).toBe(4)

    const expected = [0, 2250, 4500, 6750]
    for (let i = 0; i < samples; i++) {
      expect(outputBuf.readInt16LE(i * 2)).toBe(expected[i])
    }
  })

  it("returns empty output for empty input", () => {
    const outputBuf = Buffer.from(downsample24to16(Buffer.alloc(0).toString("base64")), "base64")
    expect(outputBuf.length).toBe(0)
  })
})

function downsample24to16(base64Audio: string): string {
  const inputBuf = Buffer.from(base64Audio, "base64")
  const inputSamples = inputBuf.length / 2
  const outputSamples = Math.floor(inputSamples * 16000 / 24000)
  const outputBuf = Buffer.alloc(outputSamples * 2)
  const ratio = 24000 / 16000

  for (let i = 0; i < outputSamples; i++) {
    const srcPos = i * ratio
    const srcIdx = Math.floor(srcPos)
    const frac = srcPos - srcIdx

    const s0 = inputBuf.readInt16LE(srcIdx * 2)
    const s1 = srcIdx + 1 < inputSamples
      ? inputBuf.readInt16LE((srcIdx + 1) * 2)
      : s0

    const sample = Math.round(s0 * (1 - frac) + s1 * frac)
    outputBuf.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i * 2)
  }

  return outputBuf.toString("base64")
}
