// Brain agent tool — sends queries to the brain gateway via /v1/chat/completions
// Uses SSE streaming to get responses, signals step completions for live progress injection

import { context, propagation } from "@opentelemetry/api"
import type { SendToClient } from "../adapters/types.js"
import { log, error as logError } from "../log.js"

interface BrainConfig {
  gatewayUrl: string
  authToken: string
  sessionId: string
}

export type PartialFlush = (chunk: string) => void

// Heuristics for streaming brain SSE deltas back into the model context.
// The provider call can take 5–20 s end-to-end; streaming partial chunks lets
// the assistant start speaking from a forming answer instead of waiting for
// the full reply, while the boundary checks keep us from injecting mid-word
// fragments that would read as garbage.
export const PARTIAL_FLUSH_MIN_CHARS = 200
export const PARTIAL_FLUSH_BOUNDARY_RE = /([.!?])\s$|\n\n$/

export async function askBrain(
  query: string,
  config: BrainConfig,
  sendToClient: SendToClient,
  callId: string,
  externalSignal?: AbortSignal,
  onPartial?: PartialFlush,
): Promise<string> {
  const url = `${config.gatewayUrl.replace(/\/$/, "")}/v1/chat/completions`

  log(`[brain] Sending query to ${url}: ${query.substring(0, 80)}...`)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error("local 120s timeout")), 120_000) // 2 min — gateway may need exec approval
  const requestStart = Date.now()
  const onExternalAbort = () => {
    const reason = externalSignal?.reason
    controller.abort(reason instanceof Error ? reason : new Error(String(reason ?? "external abort")))
  }
  if (externalSignal) {
    if (externalSignal.aborted) {
      onExternalAbort()
    } else {
      externalSignal.addEventListener("abort", onExternalAbort, { once: true })
    }
  }
  controller.signal.addEventListener("abort", () => {
    const reason = controller.signal.reason
    const reasonMsg = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason)
    logError(`[brain] signal aborted after ${Date.now() - requestStart}ms — reason: ${reasonMsg}`)
  })

  const cleanup = () => {
    clearTimeout(timeout)
    externalSignal?.removeEventListener("abort", onExternalAbort)
  }

  // W3C trace context propagation. When this fetch runs inside the
  // ask_brain tool span's OTel context (session.ts wraps it in context.with),
  // propagation.inject writes a `traceparent` header whose trace-id matches
  // the relay's active trace. The openclaw gateway extracts it on the other
  // side and opens its root span as a child, giving us one unified trace
  // across both services in Langfuse.
  const traceHeaders: Record<string, string> = {}
  propagation.inject(context.active(), traceHeaders)

  let response: Response
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${config.authToken}`,
        "x-openclaw-session-key": config.sessionId,
        ...traceHeaders,
      },
      body: JSON.stringify({
        model: "openclaw",
        messages: [
          { role: "user", content: query },
        ],
        stream: true,
      }),
      signal: controller.signal,
    })
  } catch (err) {
    cleanup()
    if (controller.signal.aborted) {
      return JSON.stringify({ error: "Brain agent request aborted" })
    }
    throw err
  }

  if (!response.ok) {
    const text = await response.text()
    logError(`[brain] Error ${response.status}: ${text.substring(0, 200)}`)
    return JSON.stringify({ error: `Brain agent returned ${response.status}` })
  }

  // Parse SSE stream
  const reader = response.body?.getReader()
  if (!reader) {
    return JSON.stringify({ error: "No response body" })
  }

  const decoder = new TextDecoder()
  let fullResponse = ""
  let buffer = ""
  let pendingDelta = ""
  let partialFlushCount = 0

  const flushPartial = () => {
    if (!onPartial || !pendingDelta) return
    const chunk = pendingDelta
    pendingDelta = ""
    partialFlushCount++
    log(`[brain] Streaming partial chunk #${partialFlushCount} (${chunk.length} chars) to model`)
    try {
      onPartial(chunk)
    } catch (err) {
      logError(`[brain] onPartial threw — continuing without further partials:`, err)
    }
  }

  let readCount = 0
  while (true) {
    let read: ReadableStreamReadResult<Uint8Array>
    try {
      read = await reader.read()
    } catch (err) {
      reader.cancel().catch(() => {})
      cleanup()
      const elapsed = Date.now() - requestStart
      logError(`[brain] reader.read() threw after ${elapsed}ms readCount=${readCount} aborted=${controller.signal.aborted}:`, err)
      if (controller.signal.aborted) {
        return JSON.stringify({ error: "Brain agent request aborted" })
      }
      throw err
    }
    readCount++
    const { done, value } = read
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue
      const data = line.slice(6).trim()

      if (data === "[DONE]") continue

      try {
        const parsed = JSON.parse(data)

        // Check for step completion signals (live progress injection)
        if (parsed.type === "step_complete" && parsed.summary) {
          log(`[brain] Step complete: ${parsed.summary}`)
          sendToClient({
            type: "tool.progress",
            callId,
            summary: parsed.summary,
          })
          continue
        }

        // Standard OpenAI-compatible SSE chunk
        const delta = parsed.choices?.[0]?.delta?.content
        if (typeof delta === "string" && delta.length > 0) {
          fullResponse += delta
          if (onPartial) {
            pendingDelta += delta
            if (
              PARTIAL_FLUSH_BOUNDARY_RE.test(pendingDelta) ||
              pendingDelta.length >= PARTIAL_FLUSH_MIN_CHARS
            ) {
              flushPartial()
            }
          }
        }
      } catch {
        // Skip unparseable chunks
      }
    }
  }

  cleanup()
  // Only flush the leftover when we already emitted at least one mid-stream
  // chunk. For short answers that never crossed a boundary, the caller's
  // final injectContext handles delivery — flushing the leftover too would
  // duplicate the entire response into the model's context.
  if (pendingDelta && partialFlushCount > 0) flushPartial()
  log(`[brain] Response: ${fullResponse.substring(0, 100)}... (partial flushes: ${partialFlushCount})`)
  return fullResponse || JSON.stringify({ error: "Empty response from brain agent" })
}
