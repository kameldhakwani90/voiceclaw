# OpenClaw cli-backend: capture and surface subprocess stderr on failure

Design note for the openclaw fork. Today the gateway swallows subprocess stderr
when a `cli-backend` run (e.g. `claude-cli`, `codex`) fails, leaving operators
to guess at root causes. Reference incident: voiceclaw 2026-04-28 15:35 — 5
`claude-cli` candidates all failed with empty `is_error: true` envelopes.

## 1. Symptom

When the spawned CLI subprocess fails, openclaw's gateway emits one log line
per failed candidate that looks like this (truncated, single line):

```json
{"type":"result","subtype":"error_during_execution","duration_ms":0,
 "duration_api_ms":0,"is_error":true,"num_turns":0,"stop_reason":null,
 "session_id":"fa13ed62-...","total_cost_usd":0,
 "usage":{"input_tokens":0,...},"service_tier":"stand…"}
```

Logged via `cliBackendLog` and (on failover) propagated to
`~/.openclaw/logs/gateway.err.log` with `reason=unknown`. The actual `claude`
CLI subprocess wrote its real diagnostic to **stderr** (e.g. `auth expired`,
`command not found`, `Connection reset by peer`) but that text is dropped.

The result envelope above is the entire signal the operator gets. Every field
that would let you triage — exit code, stderr text, the human-readable error
message from the binary — is missing.

## 2. Why it's a problem

Concrete user-facing impact from today (2026-04-28):

- A voice command ("Open the Google Maps link") triggered 5 model-fallback
  attempts in ~24 seconds. All 5 failed. The user got no answer.
- Debugging took ~30 minutes because the only ground truth was the envelope
  above. We could not distinguish:
  - auth-fail (token expired / wrong profile)
  - PATH problem (wrong `claude` binary picked up)
  - binary-missing (`claude` not installed in this shell env)
  - network (Anthropic API unreachable)
  - rate-limit (429 from upstream)
- The only way to narrow it down was running `claude -p "say hi"` manually
  in the same shell. That isn't reproducible from CI logs and isn't an option
  on a remote/headless gateway.
- The eventual fix was a config workaround (route to `codex`), but the
  observability gap that delayed diagnosis remains.

In short: the gateway has the data. It captures `result.stderr` on every spawn.
It just throws it away when emitting the structured failure result.

## 3. Where to fix

The cli-backend subprocess flow lives in
`src/agents/cli-runner/execute.ts`. The relevant points:

- **Spawn site**: `src/agents/cli-runner/execute.ts:406`
  — `supervisor.spawn({ ... })` returns a `managedRun` whose `.wait()` resolves
  with `{ stdout, stderr, exitCode, reason, ... }`.
- **Stderr is captured**: `src/agents/cli-runner/execute.ts:455-456`
  — `const stdout = result.stdout.trim(); const stderr = result.stderr.trim();`
- **Stderr is logged only when env-gated**:
  `src/agents/cli-runner/execute.ts:457-472`
  — `if (logOutputText) { cliBackendLog.info(...) }`
  — `logOutputText` requires `process.env.OPENCLAW_CLI_BACKEND_LOG_OUTPUT` to
  be truthy (see `src/agents/cli-runner/log.ts:4`,
  `src/agents/cli-runner/execute.ts:275-276`). In production it's off.
- **Non-zero exit path uses stderr in the failover error**:
  `src/agents/cli-runner/execute.ts:507-519` — `primaryErrorText = stderr || stdout`
  feeds `extractCliErrorMessage` and the `FailoverError`. This branch is
  basically fine.
- **The dropped-stderr bug**: `src/agents/cli-runner/execute.ts:522-538`
  — when `result.exitCode === 0` AND `result.reason === "exit"`, control falls
  through to `parseCliOutput({ raw: stdout, ... })`. `result.stderr` is never
  inspected. If the CLI exits cleanly but emits an `is_error: true` envelope
  on stdout — which is exactly what `error_during_execution` looks like — the
  parsed result is returned to the gateway with no surfaced error context. The
  `is_error: true` envelope is honored later by
  `collectExplicitCliErrorText()` in `src/agents/cli-output.ts:202-204`, but
  by then `result.stderr` is gone forever.

That last bullet is the actual fix site.

## 4. Proposed change

Keep the spawn behavior unchanged. The supervisor already pipes both streams.
The change is in three places, all in
`src/agents/cli-runner/execute.ts`:

1. **Always retain captured stderr** for the duration of the result handler.
   No change here — already the case via `const stderr = result.stderr.trim()`
   at line 456.

2. **In the parsed-output path (line 522)**: after `parseCliOutput(...)`
   returns, inspect the parsed envelope for `is_error === true` (or any
   recognised error subtype like `error_during_execution`). When that's true:
   - Attach a bounded `stderr_excerpt` field to the structured result envelope
     returned upward. Cap at 2 KiB. Suffix with `... [truncated]` if cut.
   - Log the **full** stderr (uncapped, but with control-character scrubbing —
     see edge cases) at `cliBackendLog.warn` level, correlated with the
     `session_id` from the envelope and the supervisor `pid`. This lands in
     `gateway.err.log` without needing the env-gated verbose flag.
   - Promote the resulting failover reason from `unknown` to whatever
     `classifyFailoverReason(stderr_excerpt, { provider })` returns; today
     classification only sees the empty envelope text and falls through to
     `unknown` (see `pi-embedded-helpers/failover-matches.ts:126`).

3. **In the non-zero-exit path (lines 474-519)**: this branch already uses
   `stderr` correctly. Add the same `stderr_excerpt` field to the
   `FailoverError` payload so it propagates to gateway-level logging in the
   same shape. The `cliBackendLog.warn` line for `result.exitCode !== 0`
   should also log the bounded excerpt verbatim (not via
   `extractCliErrorMessage`) so the raw text is in `gateway.err.log` for
   forensics.

Shape of the new field on the structured result envelope:

```ts
{
  // ... existing CliOutput fields ...
  stderr_excerpt?: string  // up to 2048 bytes, control chars scrubbed
}
```

Bounded by design: 2 KiB on the in-result excerpt, full stderr only to disk
log (which already rotates).

## 5. Edge cases

- **CLI prints to stderr in normal operation.** Many CLIs use stderr as a
  progress channel (Codex prints token counts, model names, etc.). Do **not**
  surface `stderr_excerpt` on the success path. Gate surfacing on
  `is_error === true` from the parsed envelope OR `result.exitCode !== 0` OR
  `result.reason !== "exit"`. This avoids false positives on healthy runs.
- **CLI hangs.** Already handled via `noOutputTimeoutMs` and `overall-timeout`
  (lines 475-506). When the supervisor terminates a stuck child, `result.stderr`
  may be partial or empty. Behavior: if stderr is empty on a timeout, set
  `stderr_excerpt: "<no stderr captured before timeout>"` rather than omitting
  the field — operators should see the absence.
- **Binary / control characters in stderr.** Some CLIs emit ANSI color codes
  or progress-bar escape sequences. Before assigning to `stderr_excerpt`,
  strip ANSI sequences (`\x1b\[[0-9;]*[a-zA-Z]`) and replace remaining
  non-printable bytes with `?`. Keeps `gateway.err.log` greppable.
- **Very long stderr.** Cap the in-envelope excerpt at 2 KiB, truncate the
  middle (keep first 1 KiB + last 1 KiB) so both the original error and any
  trailing stack frames survive. Disk log gets the full text once.
- **Stderr is huge (gigabytes, runaway loop).** Apply a hard 1 MiB cap on
  what we even read into memory at the supervisor layer; truncate further
  bytes. (If supervisor doesn't already cap, that's a separate ticket — note
  it but don't block this change on it.)
- **Multiple JSONL records on stdout.** `parseCliOutput` already iterates;
  if any record has `is_error: true`, surface stderr.

## 6. Test plan

Add a unit test alongside `src/agents/cli-runner.spawn.test.ts` that stubs the
process supervisor with a fixture matching the production failure mode.

Fixture: a fake `managedRun.wait()` returning:

```ts
{
  stdout: '{"type":"result","subtype":"error_during_execution","is_error":true,"session_id":"fa13ed62-test"}',
  stderr: 'auth expired',
  exitCode: 0,
  reason: "exit",
  noOutputTimedOut: false,
}
```

Assertions:

1. The structured result envelope returned from the runner contains
   `stderr_excerpt: "auth expired"`.
2. `cliBackendLog.warn` is called once with a message containing
   `auth expired` and the session id `fa13ed62-test`.
3. The failover reason is no longer `unknown` for inputs containing known
   markers (`auth expired`, `command not found`, etc.).

Smoke test under `OPENCLAW_LIVE_TEST=1`: point a `cli-backend` config at a
fake `claude` shim that does
`echo '{"type":"result","is_error":true,"session_id":"smoke-1"}'; echo 'auth expired' >&2; exit 1`,
trigger one run, verify `gateway.err.log` contains both `auth expired` and
`smoke-1`, and the failover reason is not `unknown`.

Negative test: same fixture but `is_error: false` and `exitCode: 0`. Assert
`stderr_excerpt` is **not** present (no false-positive surfacing on healthy
runs that happened to write to stderr).

## Out of scope

- Supervisor stream handling, failover order, or the codex workaround.
- Anything in voiceclaw — this is a one-side openclaw change.
