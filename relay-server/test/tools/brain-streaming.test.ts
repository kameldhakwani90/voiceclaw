import { afterEach, describe, expect, it } from "vitest"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { askBrain, PARTIAL_FLUSH_MIN_CHARS } from "../../src/tools/brain.js"

describe("askBrain SSE delta streaming", () => {
  let server: Server | null = null

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()))
      server = null
    }
  })

  it("flushes at sentence boundaries", async () => {
    const partials: string[] = []
    const handle = await startSseServer([
      "Today we ",
      "talked ",
      "about SF. ",
      "We ",
      "decided to ",
      "reach out to Amir.",
    ])
    server = handle.server

    const result = await askBrain(
      "test",
      { gatewayUrl: handle.url, authToken: "x", sessionId: "s" },
      () => {},
      "call-boundaries",
      undefined,
      (chunk) => { partials.push(chunk) },
    )

    expect(result).toBe("Today we talked about SF. We decided to reach out to Amir.")
    expect(partials).toHaveLength(2)
    expect(partials[0]).toBe("Today we talked about SF. ")
    expect(partials[1]).toBe("We decided to reach out to Amir.")
  })

  it("flushes at the 200-char boundary when no sentence terminator is seen", async () => {
    const partials: string[] = []
    const wordChunks = Array.from({ length: 60 }, (_, i) => `word${i.toString().padStart(2, "0")} `)
    const handle = await startSseServer(wordChunks)
    server = handle.server

    await askBrain(
      "test",
      { gatewayUrl: handle.url, authToken: "x", sessionId: "s" },
      () => {},
      "call-charcap",
      undefined,
      (chunk) => { partials.push(chunk) },
    )

    expect(partials.length).toBeGreaterThanOrEqual(1)
    expect(partials[0].length).toBeGreaterThanOrEqual(PARTIAL_FLUSH_MIN_CHARS)
    expect(/[.!?]/.test(partials[0])).toBe(false)
  })

  it("does not emit a partial flush for a single short response", async () => {
    const partials: string[] = []
    const handle = await startSseServer(["OK."])
    server = handle.server

    const result = await askBrain(
      "test",
      { gatewayUrl: handle.url, authToken: "x", sessionId: "s" },
      () => {},
      "call-short",
      undefined,
      (chunk) => { partials.push(chunk) },
    )

    expect(result).toBe("OK.")
    expect(partials).toHaveLength(0)
  })

  it("ignores chunks without delta.content", async () => {
    const partials: string[] = []
    const handle = await startSseServer([], {
      rawLines: [
        'data: {"choices":[{"delta":{}}]}',
        'data: {"choices":[{"delta":{"content":""}}]}',
        'data: {"choices":[{"delta":{"role":"assistant"}}]}',
        'data: {"choices":[{"delta":{"content":"hi"}}]}',
        "data: [DONE]",
      ],
    })
    server = handle.server

    const result = await askBrain(
      "test",
      { gatewayUrl: handle.url, authToken: "x", sessionId: "s" },
      () => {},
      "call-empty",
      undefined,
      (chunk) => { partials.push(chunk) },
    )

    expect(result).toBe("hi")
    expect(partials).toHaveLength(0)
  })

  it("does not call onPartial when no callback is provided", async () => {
    const handle = await startSseServer(["A. ", "B. ", "C."])
    server = handle.server

    const result = await askBrain(
      "test",
      { gatewayUrl: handle.url, authToken: "x", sessionId: "s" },
      () => {},
      "call-no-cb",
    )

    expect(result).toBe("A. B. C.")
  })
})

interface StartOptions {
  rawLines?: string[]
}

async function startSseServer(
  contentChunks: string[],
  options: StartOptions = {},
): Promise<{ server: Server, url: string }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" })
    if (options.rawLines) {
      for (const line of options.rawLines) {
        res.write(`${line}\n\n`)
      }
    } else {
      for (const chunk of contentChunks) {
        const payload = JSON.stringify({ choices: [{ delta: { content: chunk } }] })
        res.write(`data: ${payload}\n\n`)
      }
      res.write("data: [DONE]\n\n")
    }
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  return { server, url: `http://127.0.0.1:${port}` }
}
