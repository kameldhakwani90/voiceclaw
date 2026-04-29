import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MediaCapture } from "../../src/media/capture.js"

describe("MediaCapture", () => {
  let root: string
  let capture: MediaCapture

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "voiceclaw-media-test-"))
    capture = new MediaCapture({ enabled: true, rootDir: root })
    capture.startSession("unit-session")
  })

  afterEach(async () => {
    await capture.endSession().catch(() => { /* already ended */ })
  })

  it("writes per-turn pcm files, sidecars, and video timings; finalize returns expected attrs", async () => {
    capture.startTurn("turn-001")

    const chunk = Buffer.alloc(320)
    for (let i = 0; i < 50; i++) {
      capture.onUserAudioChunk(chunk.toString("base64"))
      capture.onAssistantAudioChunk(chunk.toString("base64"))
    }
    const rawChunk = Buffer.alloc(640)
    for (let i = 0; i < 10; i++) {
      capture.onUserAudioChunkCaptureOnly(rawChunk.toString("base64"))
    }

    capture.onVideoFrame(Buffer.from([0xff, 0xd8]).toString("base64"), 0)
    capture.onVideoFrame(Buffer.from([0xff, 0xd8]).toString("base64"), 250)

    const attrs = await capture.finalizeTurn()

    const expectedUserPath = join(root, "unit-session", "user-turn-001.pcm")
    const expectedUserCapturePath = join(root, "unit-session", "user-capture-turn-001.pcm")
    const expectedAssistantPath = join(root, "unit-session", "assistant-turn-001.pcm")
    const expectedVideoDir = join(root, "unit-session", "video-turn-001")

    expect(attrs["media.user_audio.path"]).toBe(expectedUserCapturePath)
    expect(attrs["media.user_audio.gated_path"]).toBe(expectedUserPath)
    expect(attrs["media.user_audio.capture_path"]).toBe(expectedUserCapturePath)
    expect(attrs["media.assistant_audio.path"]).toBe(expectedAssistantPath)
    expect(attrs["media.user_audio.codec"]).toBe("pcm_s16le")
    expect(attrs["media.user_audio.provider"]).toBe("local")

    expect(existsSync(expectedUserPath)).toBe(true)
    expect(existsSync(expectedUserCapturePath)).toBe(true)
    expect(existsSync(expectedUserPath + ".json")).toBe(true)
    expect(existsSync(expectedUserCapturePath + ".json")).toBe(true)
    expect(existsSync(expectedAssistantPath)).toBe(true)

    expect(readFileSync(expectedUserPath).byteLength).toBe(50 * 320)
    expect(readFileSync(expectedUserCapturePath).byteLength).toBe(10 * 640)

    const timings = JSON.parse(readFileSync(join(expectedVideoDir, "timings.json"), "utf8"))
    expect(timings.frames).toHaveLength(2)
    expect(timings.frames[0].offset_ms).toBe(0)
    expect(timings.frames[1].offset_ms).toBe(250)
  })

  it("writes a second turn to distinct files without clobbering the first", async () => {
    const chunk = Buffer.alloc(320)
    const rawChunk = Buffer.alloc(640)

    capture.startTurn("turn-001")
    for (let i = 0; i < 50; i++) capture.onUserAudioChunk(chunk.toString("base64"))
    for (let i = 0; i < 10; i++) capture.onUserAudioChunkCaptureOnly(rawChunk.toString("base64"))
    await capture.finalizeTurn()

    const turn1UserPath = join(root, "unit-session", "user-turn-001.pcm")
    const turn1CapturePath = join(root, "unit-session", "user-capture-turn-001.pcm")

    capture.startTurn("turn-002")
    capture.onUserAudioChunk(chunk.toString("base64"))
    capture.onUserAudioChunkCaptureOnly(rawChunk.toString("base64"))
    const attrs2 = await capture.finalizeTurn()

    expect(attrs2["media.user_audio.path"]).not.toBe(turn1CapturePath)
    expect(existsSync(turn1UserPath)).toBe(true)
    expect(existsSync(turn1CapturePath)).toBe(true)
  })

  it("session wav prefers capture-only PCM bytes when finalizing the session", async () => {
    const chunk = Buffer.alloc(320)
    const rawChunk = Buffer.alloc(640)

    capture.startTurn("turn-001")
    for (let i = 0; i < 50; i++) capture.onUserAudioChunk(chunk.toString("base64"))
    for (let i = 0; i < 10; i++) capture.onUserAudioChunkCaptureOnly(rawChunk.toString("base64"))
    await capture.finalizeTurn()

    capture.startTurn("turn-002")
    capture.onUserAudioChunk(chunk.toString("base64"))
    capture.onUserAudioChunkCaptureOnly(rawChunk.toString("base64"))
    await capture.finalizeTurn()

    const sessionAttrs = await capture.finalizeSession()
    const sessionUserWav = sessionAttrs["media.session_audio.user.path"]
    expect(typeof sessionUserWav).toBe("string")

    const expectedSessionUserBytes = 44 + 10 * 640 + 640
    expect(readFileSync(sessionUserWav as string).byteLength).toBe(expectedSessionUserBytes)
  })

  it("is a no-op when capture is disabled", async () => {
    const noop = new MediaCapture({ enabled: false, rootDir: root })
    noop.startSession("unit-session")
    noop.startTurn("turn-x")
    noop.onUserAudioChunk(Buffer.alloc(320).toString("base64"))
    const attrs = await noop.finalizeTurn()
    expect(Object.keys(attrs)).toHaveLength(0)
  })
})
