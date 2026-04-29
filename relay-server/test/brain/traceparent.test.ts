import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { context, propagation, trace } from "@opentelemetry/api"
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base"
import { W3CTraceContextPropagator } from "@opentelemetry/core"
import { AsyncHooksContextManager } from "@opentelemetry/context-async-hooks"
import { askBrain } from "../../src/tools/brain.js"

describe("askBrain traceparent injection", () => {
  let server: Server | null = null
  let port = 0
  let capturedTraceparent: string | undefined

  beforeAll(() => {
    const provider = new BasicTracerProvider()
    trace.setGlobalTracerProvider(provider)
    propagation.setGlobalPropagator(new W3CTraceContextPropagator())
    const ctxManager = new AsyncHooksContextManager().enable()
    context.setGlobalContextManager(ctxManager)
  })

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()))
      server = null
    }
    capturedTraceparent = undefined
  })

  it("injects a W3C traceparent matching the active span context", async () => {
    ;({ server, port } = await startCaptureServer((tp) => { capturedTraceparent = tp }))

    const tracer = trace.getTracer("test")
    const span = tracer.startSpan("parent-tool-span")
    const ctx = trace.setSpan(context.active(), span)
    const spanCtx = span.spanContext()

    await context.with(ctx, () =>
      askBrain(
        "hello",
        { gatewayUrl: `http://127.0.0.1:${port}`, authToken: "x", sessionId: "t" },
        () => {},
        "call-1",
      ),
    )
    span.end()

    expect(capturedTraceparent).toBeDefined()
    const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(capturedTraceparent!)
    expect(match).not.toBeNull()
    const [, traceId, parentSpanId] = match!
    expect(traceId).toBe(spanCtx.traceId)
    expect(parentSpanId).toBe(spanCtx.spanId)
  })

  it("does not inject a traceparent when there is no active span", async () => {
    ;({ server, port } = await startCaptureServer((tp) => { capturedTraceparent = tp }))

    await askBrain(
      "hello",
      { gatewayUrl: `http://127.0.0.1:${port}`, authToken: "x", sessionId: "t" },
      () => {},
      "call-nocontext",
    )

    expect(capturedTraceparent).toBeUndefined()
  })
})

async function startCaptureServer(onTraceparent: (tp: string | undefined) => void): Promise<{ server: Server, port: number }> {
  const server = createServer((req, res) => {
    onTraceparent(req.headers["traceparent"] as string | undefined)
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n')
    res.write("data: [DONE]\n\n")
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  return { server, port }
}
