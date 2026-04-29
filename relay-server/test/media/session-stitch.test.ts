import { describe, expect, it } from "vitest"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MediaCapture } from "../../src/media/capture.js"

const SESSION_KEY = "stitch-e2e-session"
const TURN_COUNT = 4
const CHUNKS_PER_TURN = 24
const FRAMES_PER_TURN = 8

describe("MediaCapture finalizeSession", () => {
  it("stitches per-turn PCM into session wavs, peaks, and thumbnails", async () => {
    const root = mkdtempSync(join(tmpdir(), "voiceclaw-stitch-test-"))
    const capture = new MediaCapture({ enabled: true, rootDir: root })

    capture.startSession(SESSION_KEY)

    for (let turn = 0; turn < TURN_COUNT; turn++) {
      if (turn > 0) await waitMs(50)
      const turnId = `turn-${turn}`
      capture.startTurn(turnId)

      for (let i = 0; i < CHUNKS_PER_TURN; i++) {
        const buf = Buffer.alloc(320)
        for (let s = 0; s < 160; s++) {
          const v = Math.round(8000 * Math.sin((i * 160 + s) * 0.02) * (turn + 1) * 0.25)
          buf.writeInt16LE(v, s * 2)
        }
        capture.onUserAudioChunk(buf.toString("base64"))
        capture.onAssistantAudioChunk(buf.toString("base64"))
      }

      for (let f = 0; f < FRAMES_PER_TURN; f++) {
        capture.onVideoFrame(Buffer.from([0xff, 0xd8, f, turn]).toString("base64"), f * 5)
      }

      await capture.finalizeTurn()
    }

    const sessionAttrs = await capture.finalizeSession()
    await capture.endSession()

    const sessionDir = join(root, SESSION_KEY, "session")
    const userWav = join(sessionDir, "user.wav")
    const assistantWav = join(sessionDir, "assistant.wav")
    const peaksPath = join(sessionDir, "peaks.json")
    const thumbsPath = join(sessionDir, "thumbnails.json")

    expect(existsSync(userWav)).toBe(true)
    expect(existsSync(assistantWav)).toBe(true)
    expect(existsSync(peaksPath)).toBe(true)
    expect(existsSync(thumbsPath)).toBe(true)

    expect(sessionAttrs["media.session_audio.user.path"]).toBe(userWav)
    expect(sessionAttrs["media.session_audio.assistant.path"]).toBe(assistantWav)
    expect(sessionAttrs["media.session_audio.peaks_path"]).toBe(peaksPath)
    expect(sessionAttrs["media.session_video.thumbnails_path"]).toBe(thumbsPath)

    expectWav(userWav)
    expectWav(assistantWav)

    const peaks = JSON.parse(readFileSync(peaksPath, "utf8"))
    expect(Array.isArray(peaks.user)).toBe(true)
    expect(Array.isArray(peaks.assistant)).toBe(true)
    expect(peaks.user.length).toBeGreaterThan(0)
    expect(peaks.assistant.length).toBeGreaterThan(0)
    expect(peaks.user.length).toBeLessThanOrEqual(2500)
    expect(peaks.assistant.length).toBeLessThanOrEqual(2500)
    expect(typeof peaks.sampleRate).toBe("number")
    expect(peaks.sampleRate).toBeGreaterThan(0)
    expect(typeof peaks.userDurationMs).toBe("number")
    expect(peaks.userDurationMs).toBeGreaterThan(0)

    const maxUserPeak = Math.max(...peaks.user.map((v: number) => Math.abs(v)))
    expect(maxUserPeak).toBeGreaterThanOrEqual(0.01)
    expect(maxUserPeak).toBeLessThanOrEqual(1.001)

    const thumbs = JSON.parse(readFileSync(thumbsPath, "utf8"))
    expect(Array.isArray(thumbs.frames)).toBe(true)
    expect(thumbs.frames.length).toBeGreaterThan(0)
    expect(thumbs.frames.length).toBeLessThanOrEqual(20)

    const totalFrames = TURN_COUNT * FRAMES_PER_TURN
    if (totalFrames < 20) expect(thumbs.frames).toHaveLength(totalFrames)

    for (let i = 1; i < thumbs.frames.length; i++) {
      expect(thumbs.frames[i].timeMs).toBeGreaterThanOrEqual(thumbs.frames[i - 1].timeMs)
    }
  })
})

function expectWav(path: string) {
  const buf = readFileSync(path)
  expect(buf.length).toBeGreaterThanOrEqual(44)
  expect(buf.slice(0, 4).toString("ascii")).toBe("RIFF")
  expect(buf.slice(8, 12).toString("ascii")).toBe("WAVE")
  expect(buf.readUInt32LE(24)).toBeGreaterThan(0)
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
