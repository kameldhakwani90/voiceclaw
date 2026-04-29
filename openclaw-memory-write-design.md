# OpenClaw memory-write design recon for transcript sync

**Author:** Claude (recon, read-only)
**Date:** 2026-04-29
**Scope:** Why VoiceClaw's `syncTranscriptToBrain()` does not land as durable brain memory, and what to do instead.

## 1. Current behavior

`relay-server/src/session.ts:syncTranscriptToBrain()` POSTs to openclaw's `POST /v1/chat/completions` with a single `user`-role message containing the full voice transcript prefixed by "Please remember the key facts...". OpenClaw's chat-completions handler (`src/gateway/openai-http.ts`) is a thin OpenAI-compatible facade: it accepts only `model`, `messages`, `stream`, `stream_options`, `user` — it ignores any `tools`, `tool_choice`, `temperature`, etc. It funnels every request into `agentCommandFromIngress(...)` which spawns the configured agent (here `claude-cli` / `claude-haiku-4-5` per `~/.openclaw/openclaw.json`) with the prompt as a regular chat turn. The agent decides what to do with it. As a side effect, the gateway appends the prompt + assistant reply to `~/.openclaw/workspace/memory/.dreams/session-corpus/YYYY-MM-DD.txt`, where the nightly "dreaming" sweep at 03:00 (per gateway.log line 64436+) is supposed to promote it into `memory/YYYY-MM-DD.md`.

## 2. Why it's not landing as memory

Two compounding problems:

1. **No write tool.** The `memory-core` plugin only exposes two tools to the agent: `memory_search` and `memory_get` (see `extensions/memory-core/src/tools.ts:188,200` and `src/gateway/tools-invoke-http.ts:34` `MEMORY_TOOL_NAMES = new Set(["memory_search","memory_get"])`). There is no `memory_save`, `memory_write`, or `memory_remember` tool anywhere in the openclaw fork — neither in the plugin nor over HTTP. The only way to get content into `memory/YYYY-MM-DD.md` is for the agent itself to use generic file-write tools (Edit/Write — which `claude-cli` has) to append to that file, which it does only when a memory-flush turn or the workspace `AGENTS.md` "remember this" rule (`~/.openclaw/workspace/AGENTS.md:43`) explicitly triggers it.
2. **Wrong framing.** The relay sends the transcript as a `user` message. `buildAgentPrompt` (`src/gateway/openai-http.ts:374`) renders that as `User: <prompt>` in the agent's conversation. Claude-haiku-4-5 then runs the prompt as a normal chat task — sometimes complying ("Saved." — see today's `session-corpus/2026-04-28.txt:32`), sometimes treating "remember the key facts, decisions, action items" as an open-ended question ("which project should I pull the latest main from?" — gateway.log:64068). The probability of "actually write to the daily memory file" varies per run because the prompt does not match openclaw's canonical memory-flush scaffolding (`extensions/memory-core/src/flush-plan.ts:14-30`: "Pre-compaction memory flush... Store durable memories only in `memory/YYYY-MM-DD.md`... If memory/YYYY-MM-DD.md already exists, APPEND new content only..."). And even when the agent says "Saved.", the actual landed content is the assistant's mental note, not a structured Voice Note section that survives dreaming consolidation.

The downstream "I don't see any conversation history from today" miss at 15:21:23 is the same root cause: today's transcript only exists in `.dreams/session-corpus/2026-04-28.txt`, which is **not** indexed by `memory_search` (see `extensions/memory-core/src/tools.ts:188` description: "search MEMORY.md + memory/*.md (and optional session transcripts)"). It only lands in `memory/2026-04-28.md` after the 3am dreaming sweep promotes it — and only if a candidate clears the confidence threshold.

## 3. Available paths to fix

### (a) Different openclaw HTTP endpoint (e.g., `POST /v1/memory/save`)

**Inventory of what the gateway actually exposes** (from `src/gateway/server-http.ts`):

- `/v1/chat/completions`, `/v1/responses`, `/v1/embeddings`, `/v1/models` — OpenAI-compat
- `/tools/invoke` — explicit tool invocation, but allowlisted to read-only memory tools only
- `/sessions/:id/kill`, `/sessions/:id/history` — session lifecycle

There is **no** `/v1/memory/save`, `/v1/memory/append`, or any HTTP write surface for memory. Adding one would mean editing openclaw — see §6.

**Pros:** cleanest separation; fire-and-forget with no agent latency; deterministic.
**Cons:** requires editing openclaw (the fork is 4k commits behind upstream per task #23; landing changes is painful and risks divergence).

### (b) Different request shape on existing endpoint

Two sub-options on `/v1/chat/completions`:

- **(b1) Add a `system` message** scaffolding the request as a memory flush turn. `buildAgentPrompt` (`src/gateway/openai-http.ts:396-401`) collects all `system`/`developer` role messages into `extraSystemPrompt`, which the agent receives as a system-prompt addendum. We can paste in openclaw's own `DEFAULT_MEMORY_FLUSH_SYSTEM_PROMPT` text (`extensions/memory-core/src/flush-plan.ts:33-40`) verbatim and put the transcript in the user message.
- **(b2) Custom `x-openclaw-message-channel` header** (`src/gateway/http-utils.ts:391`) to mark the channel as something other than "webchat", e.g., `voice-memory-flush`. This would change agent prompt context but the agent has no built-in handler for that channel — pure cosmetic without (b1) or core changes.

**Pros:** no openclaw edits needed; uses an existing, documented mechanism (the same scaffolding openclaw uses internally for compaction-time memory flush).
**Cons:** still relies on the agent being well-behaved (claude-haiku-4-5 might still occasionally drift); still goes through the chat-completions latency path.

### (c) Different prompt phrasing

Rewrite the user-message prompt to match what the workspace `AGENTS.md` (`~/.openclaw/workspace/AGENTS.md:43`) trains the agent to act on: literally start with "Remember this:" and explicitly instruct "append to `memory/YYYY-MM-DD.md` under a `## Voice Note (HH:MM)` heading, then reply only `[no-reply]`."

**Pros:** zero openclaw changes, minimal relay changes.
**Cons:** still probabilistic on agent compliance; still no guarantee the agent uses the canonical Voice Note section the dreaming sweep recognizes.

### (d) Direct file write from the relay

The relay knows the workspace path (`~/.openclaw/workspace/memory/YYYY-MM-DD.md`). It could just `fs.appendFile` a `## Voice Note (HH:MM)` block with the transcript verbatim, no LLM in the loop. The dreaming sweep would pick it up the next night exactly the same way it picks up agent-written voice notes (the existing `## Voice Note` section in today's `memory/2026-04-28.md:1` proves the format works).

**Pros:** deterministic, zero LLM latency, no openclaw changes, byte-identical output to the existing voice-note section pattern, automatically benefits from existing dreaming/promotion machinery.
**Cons:** couples the relay to openclaw's workspace filesystem layout (cross-host deployments would break — but per `feedback_relay_is_per_user`, the relay is already per-user co-located with that user's openclaw workspace, so this is acceptable). No deduplication or summarization — raw transcript dumps will inflate the daily file (mitigated by an LLM-summarized variant if we want, see §4).

## 4. Recommended path

**(b1) + light variant of (d): send the transcript via chat-completions but scaffold it with openclaw's own canonical memory-flush system prompt, AND also append a raw `## Voice Note (HH:MM)` block directly to `memory/YYYY-MM-DD.md` from the relay as a belt-and-suspenders backstop.** The system-prompt scaffolding gets us a curated, agent-summarized entry on the happy path; the direct file append guarantees the raw transcript is captured even if the agent run drifts, fails, or gets aborted. Both feed the same daily file the dreaming sweep already consumes, so no openclaw changes are required and no new failure surfaces are introduced. This is also the lowest-risk path given the fork drift constraint in §6.

## 5. What changes in voiceclaw

- `relay-server/src/session.ts:syncTranscriptToBrain()`: add a `system` message to the chat-completions request containing openclaw's canonical memory-flush system prompt (mirror `extensions/memory-core/src/flush-plan.ts:33-40` text — keep our copy in sync via a constant in the relay). Move the transcript to the `user` message and prefix with "Pre-compaction memory flush. Store this voice transcript under a `## Voice Note (HH:MM PT)` heading in `memory/YYYY-MM-DD.md`, append-only, then reply `[no-reply]`."
- `relay-server/src/session.ts`: before/in-parallel-with the chat-completions call, do a `fs.appendFile` to `${workspaceDir}/memory/${todayDateStamp}.md` with a `## Voice Note (HH:MM)` block containing the verbatim transcript. Resolve `workspaceDir` from `agents.defaults.workspace` in `~/.openclaw/openclaw.json` (or a new `BRAIN_WORKSPACE_DIR` env var with that path as default). Skip the file-append if the env var is empty (allows non-co-located deployments to fall back to chat-completions only).
- `relay-server/src/tools/brain.ts`: extend `askBrain` to accept an optional `systemMessage` parameter so callers (transcript-sync vs voice-turn ask_brain) can frame requests differently; default keeps current behavior.
- Update tracing span name from `memory.save-transcript` to `memory.flush-transcript` to match openclaw's terminology and improve cross-system correlation in Langfuse.
- Add a Starlight docs page at `voiceclaw/docs/src/content/docs/architecture/transcript-sync.md` documenting the dual-write design, the canonical memory file format, and the workspace-path coupling (per `feedback_ship_docs_with_features`).

## 6. What changes in openclaw

**None required for the recommended path.** This is deliberate: the fork is 4k commits behind upstream (per task #23) and any local edit increases rebase pain. The dual-write design works entirely within existing openclaw contracts — system-prompt scaffolding and the documented `memory/YYYY-MM-DD.md` storage convention.

If we later decide we want a deterministic, agent-free server-side path (option (a)), the right place would be a new HTTP endpoint at `src/gateway/memory-http.ts` exposing `POST /v1/memory/append` that takes `{ workspaceDir, dateStamp, section, content }`, calls `appendMemoryHostEvent` (already used by the dreaming pipeline at `extensions/memory-core/src/dreaming-markdown.ts`), and writes the entry. This should be proposed upstream first rather than landed on the fork — it's a small, generally-useful contract for any external system that wants to feed memory without going through the agent.

## 7. Cross-references

- VoiceClaw transcript-sync source: `relay-server/src/session.ts:522-585`
- VoiceClaw brain client: `relay-server/src/tools/brain.ts:14-78`
- OpenClaw chat-completions handler: `openclaw/src/gateway/openai-http.ts:374-440,498-625`
- OpenClaw tools-invoke endpoint allowlist: `openclaw/src/gateway/tools-invoke-http.ts:34`
- OpenClaw memory tools (read-only): `openclaw/extensions/memory-core/src/tools.ts:188,200`
- OpenClaw memory-flush prompt template: `openclaw/extensions/memory-core/src/flush-plan.ts:14-40`
- OpenClaw workspace agent rules: `~/.openclaw/workspace/AGENTS.md:20-46`
- Memory file format example: `~/.openclaw/workspace/memory/2026-04-28.md:1` (`## Voice Note` section)
- Today's session-corpus (where transcript-sync currently lands): `~/.openclaw/workspace/memory/.dreams/session-corpus/2026-04-28.txt`
- Gateway log evidence of misrouted run: `~/.openclaw/logs/gateway.log:64067-64068` ("which project should I pull the latest main from?")
- Gateway log evidence of dreaming sweep: `~/.openclaw/logs/gateway.log:64436-64466` (03:00 nightly promotion)
