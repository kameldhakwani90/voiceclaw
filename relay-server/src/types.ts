// Relay protocol types — normalized event set that hides provider differences

// Client → Relay events
export type ClientEvent =
  | SessionConfigEvent
  | AudioAppendEvent
  | AudioAppendCaptureOnlyEvent
  | AudioCommitEvent
  | FrameAppendEvent
  | ResponseCreateEvent
  | ResponseCancelEvent
  | ToolResultEvent
  | ClientTimingEvent
  | TextInputEvent
  | MintTokenEvent
  | ToolExecEvent
  | SessionPrepEvent

export interface SessionConfigEvent {
  type: "session.config"
  provider: "openai" | "gemini" | "xai"
  voice: string
  model?: string
  brainAgent: "enabled" | "none"
  apiKey: string
  // Tavily API key for the web_search tool. When present (either here or via
  // TAVILY_API_KEY env on the relay), web_search is registered as a tool the
  // realtime model can call for fast lookups that don't need the brain agent.
  tavilyApiKey?: string
  sessionKey?: string
  // Stable identifier for the human behind this session (telegram chat id,
  // app user id, etc.). Propagated to Langfuse so traces group per-user.
  userId?: string
  deviceContext?: {
    timezone?: string
    locale?: string
    deviceModel?: string
    location?: string
  }
  watchdog?: "enabled" | "disabled"
  instructionsOverride?: string
  conversationHistory?: { role: "user" | "assistant", text: string, timestamp?: number, relativeMs?: number }[]
  // When true, the realtime model is given direct tools (read/write/edit/bash)
  // and ask_brain is removed from the exposed tool list. Default off — opt-in
  // via session config so production keeps today's behavior unchanged.
  experimentalDirectTools?: boolean
}

export interface AudioAppendEvent {
  type: "audio.append"
  data: string // base64 PCM16
}

export interface AudioAppendCaptureOnlyEvent {
  type: "audio.append_capture_only"
  data: string // base64 PCM16, local recording only; never forwarded upstream
}

export interface AudioCommitEvent {
  type: "audio.commit"
}

export interface FrameAppendEvent {
  type: "frame.append"
  data: string // base64 JPEG — composite when annotated, raw capture otherwise
  mimeType?: string // default "image/jpeg"
  // Sibling artifacts captured alongside the composite when on-screen drawing
  // is active. Saved into the per-turn trace as separate files; never sent
  // upstream to the realtime model (data is what the model sees).
  annotation?: {
    original: string // base64 JPEG of the un-annotated capture
    strokesPng: string // base64 PNG of strokes-only canvas, transparent background
  }
}

export interface ResponseCreateEvent {
  type: "response.create"
}

export interface ResponseCancelEvent {
  type: "response.cancel"
}

export interface ToolResultEvent {
  type: "tool.result"
  callId: string
  output: string
}

// Text-only user turn — used by mobile text-chat to send a message through the
// same realtime session voice uses. The relay forwards it to the active adapter
// via injectContext, which on both Gemini and OpenAI triggers a model response
// that streams back as transcript.delta / transcript.done (role=assistant).
export interface TextInputEvent {
  type: "text.input"
  text: string
}

// Emitted by the mobile client to attribute latency across the pipeline
// (e.g., mic-open → first-audio-chunk, turn-started → first-tts-sample).
// Relay attaches these to the Langfuse generation span identified by turnId.
// turnId is issued by the relay in TurnStartedEvent; echoing it back avoids
// attributing a late-arriving timing to the wrong turn.
export interface ClientTimingEvent {
  type: "client.timing"
  phase: string
  ms: number
  turnId?: string
}

// Relay → Client events
export type RelayEvent =
  | SessionReadyEvent
  | AudioDeltaEvent
  | TranscriptDeltaEvent
  | TranscriptDoneEvent
  | ToolCallEvent
  | ToolProgressEvent
  | ToolCallCompletedEvent
  | ToolCallFailedEvent
  | TurnStartedEvent
  | TurnEndedEvent
  | SessionEndedEvent
  | SessionRotatingEvent
  | SessionRotatedEvent
  | UsageMetricsEvent
  | LatencyMetricsEvent
  | ToolCancelledEvent
  | BrainResultEvent
  | ErrorEvent
  | TokenEvent
  | TokenErrorEvent
  | StandaloneToolResultEvent
  | StandaloneToolErrorEvent
  | SessionPrepResultEvent
  | SessionPrepErrorEvent

export interface SessionReadyEvent {
  type: "session.ready"
  sessionId: string
}

export interface AudioDeltaEvent {
  type: "audio.delta"
  data: string // base64 PCM16
}

export interface TranscriptDeltaEvent {
  type: "transcript.delta"
  text: string
  role: "user" | "assistant"
}

export interface TranscriptDoneEvent {
  type: "transcript.done"
  text: string
  role: "user" | "assistant"
}

export interface ToolCallEvent {
  type: "tool.call"
  callId: string
  name: string
  arguments: string
}

// Emitted when a server-side tool call finishes successfully.
// durationMs is wall-clock time from the matching tool.call event.
// result is the raw string payload returned by the tool (JSON or plain text,
// keep ≤ 4 KB — strip audio/embedding fields before sending).
export interface ToolCallCompletedEvent {
  type: "tool_call.completed"
  callId: string
  name: string
  durationMs: number
  result: string
}

// Emitted when a server-side tool call finishes with an error or is cancelled.
// cancelled=true distinguishes a mid-turn barge-in abort from an actual failure.
export interface ToolCallFailedEvent {
  type: "tool_call.failed"
  callId: string
  name: string
  durationMs: number
  error: string
  cancelled: boolean
}

export interface ToolProgressEvent {
  type: "tool.progress"
  callId: string
  summary?: string
  step?: string
  textDelta?: string
}

export interface TurnStartedEvent {
  type: "turn.started"
  turnId?: string
}

export interface TurnEndedEvent {
  type: "turn.ended"
}

export interface SessionEndedEvent {
  type: "session.ended"
  summary: string
  durationSec: number
  turnCount: number
}

export interface SessionRotatingEvent {
  type: "session.rotating"
}

export interface SessionRotatedEvent {
  type: "session.rotated"
  sessionId: string
}

// Emitted by adapters with per-turn token/audio usage. Consumed internally
// by the tracer to attribute cost on Langfuse generations; not forwarded to
// the mobile client.
export interface UsageMetricsEvent {
  type: "usage.metrics"
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  inputAudioTokens?: number
  outputAudioTokens?: number
}

// Emitted by adapters with per-turn latency measurements observable from the
// provider wire protocol. Consumed internally by the tracer and stamped onto
// the voice-turn span as raw OTel attributes under the vendor-neutral voice.*
// namespace; not forwarded to the mobile client. Boundaries and source-kind
// semantics documented on TurnTracer.attachLatency.
export interface LatencyMetricsEvent {
  type: "latency.metrics"
  // End-of-speech signal → first model audio byte. Covers the provider's VAD
  // endpointing wait plus model TTFT. What the user perceives as "how fast did
  // it reply". Adapters should not emit this when the turn was interrupted or
  // produced no model audio — a missing metric is better than a misleading one.
  endpointMs?: number
  // How end-of-speech was determined: "server_eos" (explicit provider event),
  // "transcription_proxy" (derived from last input-transcription delta — loose),
  // "last_audio_frame" (derived from last upstream audio write — rough fallback).
  endpointSource?: string
  // Last upstream audio frame written → first model byte received. Relay-local,
  // no device clock needed. NOT a pure network RTT: includes provider queueing
  // and any remaining VAD wait before generation starts.
  providerFirstByteMs?: number
  // turn.started → first model audio byte. Our existing turn boundary is "user
  // started talking" (first input-transcription delta or speech_started), so
  // this captures the full wait including endpointing.
  firstAudioFromTurnStartMs?: number
  // turn.started → first model TEXT delta. VoiceClaw accepts text output too
  // (links, structured replies, fallback when the model declines audio); this
  // lets dashboards see both modalities separately.
  firstTextFromTurnStartMs?: number
  // turn.started → first model output byte, regardless of modality. This is
  // the "TTFT" we surface to the UI by default — whichever came first.
  firstOutputFromTurnStartMs?: number
  // Which modality won the race to first-output. "audio" | "text".
  firstOutputModality?: string
}

// Adapter signals that the upstream model gave up on a tool call
// (e.g., Gemini toolCallCancellation). Session uses this to abort the matching
// in-flight server-side fetch so the gateway slot is released, then forwards
// the event to the client so it can update UI (drop speculative prefixes,
// clear spinners, etc.).
export interface ToolCancelledEvent {
  type: "tool.cancelled"
  callIds: string[]
}

// Raw brain agent answer surfaced to the client as soon as it returns,
// independent of whether the realtime model successfully speaks it. The client
// persists this directly into local conversation history so the structured
// response survives provider drops mid-injection and isn't degraded to the
// model's spoken paraphrase across cross-session loads.
export interface BrainResultEvent {
  type: "brain.result"
  callId: string
  query: string
  result?: string
  error?: string
}

export interface ErrorEvent {
  type: "error"
  message: string
  code: number
  userMessage?: string
  actionUrl?: string | null
  actionLabel?: string
  httpStatus?: number | null
}

// "Direct to provider" capabilities — clients connecting straight to Gemini for
// audio still talk to the relay for two things: minting an ephemeral provider
// auth token (mint_token → token) and delegating tool execution back to the
// desktop (tool.exec → tool.progress* → tool.result | tool.error). Both work
// on the same /ws route and do NOT require session.config.

export interface MintTokenEvent {
  type: "mint_token"
  provider: "gemini" | "openai" | "xai"
  model?: string
}

export interface TokenEvent {
  type: "token"
  provider: "gemini"
  token: string
  // Wall-clock ms epoch at which the token stops being usable to start new
  // sessions. Clients should refresh before this.
  expiresAt: number
  // true when the token is a freshly-minted short-lived auth_tokens.create
  // result; false when the upstream API was unavailable and the relay fell
  // back to handing the raw GEMINI_API_KEY through (dev/tailnet only).
  ephemeral: boolean
  model?: string
}

export interface TokenErrorEvent {
  type: "token.error"
  provider: "gemini" | "openai" | "xai"
  message: string
}

export interface ToolExecEvent {
  type: "tool.exec"
  callId: string
  name: "read" | "write" | "edit" | "bash"
  // JSON-encoded argument object — same shape the in-session direct tools
  // accept (read: {path, offset?, limit?}; write: {path, content};
  // edit: {path, old_string, new_string, replace_all?};
  // bash: {command, timeout_ms?, background?}).
  arguments: string
}

export interface StandaloneToolResultEvent {
  type: "tool.result"
  callId: string
  name: string
  result: string
  durationMs: number
}

export interface StandaloneToolErrorEvent {
  type: "tool.error"
  callId: string
  name: string
  error: string
  durationMs?: number
}

// "Direct to provider" — when the mobile client opens its own WS straight to
// Gemini Live, it still needs the system instructions (identity / SOUL / facts
// / memory preamble + tools guidance) and the function declarations the relay
// would have wired in. Only the relay can assemble these (workspace, env). The
// client sends session.prep with the same fields it would have sent as
// session.config; the relay replies with the built instructions string and the
// Gemini-shaped tool declarations to splice into the upstream setup message.
export interface SessionPrepEvent {
  type: "session.prep"
  config: SessionConfigEvent
}

interface GeminiFunctionDeclaration {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface SessionPrepResultEvent {
  type: "session.prep.result"
  instructions: string
  tools: GeminiFunctionDeclaration[]
}

export interface SessionPrepErrorEvent {
  type: "session.prep.error"
  message: string
}
