import { describe, expect, it } from "vitest"

const COLLECTOR_URL = process.env.COLLECTOR_URL ?? "http://127.0.0.1:4320/v1/traces"
const DB_PATH = process.env.TEST_DB ?? "/tmp/voiceclaw-tracing-test.db"
const RUN_E2E = process.env.RUN_COLLECTOR_E2E === "1"

describe("tracing-collector ns precision", () => {
  it.skipIf(!RUN_E2E)("stores int64 ns timestamps without rounding through Number", async () => {
    const { NodeSDK } = await import("@opentelemetry/sdk-node")
    const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-http")
    const { BatchSpanProcessor } = await import("@opentelemetry/sdk-trace-base")
    const { SpanKind, trace } = await import("@opentelemetry/api")
    const { default: Database } = await import("better-sqlite3")

    const sdk = new NodeSDK({
      serviceName: "precision-test",
      spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: COLLECTOR_URL }))],
    })
    sdk.start()

    const tracer = trace.getTracer("precision-test")
    const span = tracer.startSpan("precision-probe", { kind: SpanKind.INTERNAL })
    const traceId = span.spanContext().traceId
    const spanId = span.spanContext().spanId
    const emitNsApprox = BigInt(Date.now()) * 1_000_000n
    await new Promise((r) => setTimeout(r, 5))
    span.end()

    await sdk.shutdown()
    await new Promise((r) => setTimeout(r, 500))

    const db = new Database(DB_PATH, { readonly: true })
    const row = db
      .prepare("SELECT start_time_ns, end_time_ns FROM traces WHERE trace_id = ?")
      .safeIntegers(true)
      .get(traceId) as { start_time_ns: bigint; end_time_ns: bigint | null } | undefined
    const obs = db
      .prepare("SELECT start_time_ns, end_time_ns, duration_ms FROM observations WHERE span_id = ?")
      .safeIntegers(true)
      .get(spanId) as
      | { start_time_ns: bigint; end_time_ns: bigint | null; duration_ms: bigint | null }
      | undefined
    db.close()

    expect(row).toBeDefined()
    expect(obs).toBeDefined()

    const deltaMs = Number((row!.start_time_ns - emitNsApprox) / 1_000_000n)
    expect(Math.abs(deltaMs)).toBeLessThanOrEqual(100)
  })
})
