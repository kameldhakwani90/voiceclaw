// `bash` direct tool — runs a shell command, streams stdout/stderr to the
// client as tool.progress.textDelta, returns exit code + tail in the final
// result.
//
// Safety knobs (day-one):
//  - Pattern denylist (checkBashCommand in workspace.ts).
//  - Workspace-root cwd by default.
//  - Per-stream tail cap (16 KB) so a `gh pr diff` on a huge PR doesn't
//    blow the model's context.
//  - Timeout: default 30s, hard cap 120s.

import { spawn, type ChildProcess } from "node:child_process"
import { checkBashCommand, ensureWorkspace, getWorkspaceRoot } from "../../workspace.js"

export const BASH_TOOL_NAME = "bash"

export const BASH_TOOL_DESCRIPTION = `Runs a shell command and streams stdout/stderr back as the output arrives.

- The command runs through /bin/sh -c with the voiceclaw workspace as cwd by default.
- Output is streamed to the user via tool.progress while the command runs — speak a short verbal bridge ("running that now…") and then narrate the output as it arrives.
- Each of stdout and stderr is capped at 16 KB tail; older output past the cap is dropped with a marker in the final result.
- Default timeout is 30 seconds. Pass timeout_ms (max 120000) for longer-running work.
- Day-one denylist blocks rm -r, sudo/doas, pipe-to-shell from curl/wget, credential-dir reads, and disk/mount commands. Use only for legitimate tasks.
- For multi-step coding work (refactors, bug fixes, writing new code), invoke an imperative-loop agent like \`bash claude -p "<task>"\` or \`bash codex "<task>"\` rather than chaining many small tool calls.`

export const BASH_TOOL_PARAMETERS = {
  type: "object",
  properties: {
    command: {
      type: "string",
      description: "The shell command to run. Goes through /bin/sh -c verbatim.",
    },
    timeout_ms: {
      type: "integer",
      description: "Hard timeout in milliseconds. Default 30000 (30s). Max 120000 (120s).",
      minimum: 1,
    },
  },
  required: ["command"],
} as const

export const DEFAULT_TIMEOUT_MS = 30_000
export const MAX_TIMEOUT_MS = 120_000
export const PER_STREAM_CAP_BYTES = 16 * 1024

export interface BashArgs {
  command: string
  timeout_ms?: number
}

export interface BashProgressEvent {
  textDelta?: string
  step?: string
}

export interface BashResult {
  exitCode: number | null
  signal?: string | null
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
  durationMs: number
  timedOut: boolean
}

export interface BashError {
  error: string
}

export interface BashRunOptions {
  signal?: AbortSignal
  onProgress?: (event: BashProgressEvent) => void
  /** Override cwd. Defaults to the workspace root. */
  cwd?: string
  /** Override env. Defaults to inheriting process.env. */
  env?: NodeJS.ProcessEnv
}

export async function runBash(args: BashArgs, opts: BashRunOptions = {}): Promise<BashResult | BashError> {
  if (typeof args.command !== "string" || args.command.length === 0) {
    return { error: "command is required" }
  }

  const denyCheck = checkBashCommand(args.command)
  if (!denyCheck.ok) {
    return { error: `command denied by safety policy: ${denyCheck.reason}` }
  }

  const requested = typeof args.timeout_ms === "number" ? args.timeout_ms : DEFAULT_TIMEOUT_MS
  const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1, Math.floor(requested)))

  await ensureWorkspace().catch(() => undefined)
  const cwd = opts.cwd ?? getWorkspaceRoot()

  const startedAt = Date.now()
  const onProgress = opts.onProgress ?? (() => {})

  return new Promise<BashResult | BashError>((resolve) => {
    let child: ChildProcess
    try {
      child = spawn("/bin/sh", ["-c", args.command], {
        cwd,
        env: opts.env ?? process.env,
        stdio: ["ignore", "pipe", "pipe"],
      })
    } catch (err) {
      resolve({ error: `spawn failed: ${(err as Error).message}` })
      return
    }

    const stdoutBuf = new CappedTail(PER_STREAM_CAP_BYTES)
    const stderrBuf = new CappedTail(PER_STREAM_CAP_BYTES)
    let settled = false
    let timedOut = false

    const finish = (result: BashResult | BashError) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutHandle)
      opts.signal?.removeEventListener("abort", onAbort)
      resolve(result)
    }

    const onAbort = () => {
      if (settled) return
      // SIGTERM first; the timeout below will SIGKILL if the child ignores it.
      try { child.kill("SIGTERM") } catch { /* ignore */ }
      setTimeout(() => {
        try { child.kill("SIGKILL") } catch { /* ignore */ }
      }, 500).unref()
    }
    if (opts.signal) {
      if (opts.signal.aborted) {
        onAbort()
      } else {
        opts.signal.addEventListener("abort", onAbort, { once: true })
      }
    }

    const timeoutHandle = setTimeout(() => {
      timedOut = true
      try { child.kill("SIGTERM") } catch { /* ignore */ }
      setTimeout(() => {
        try { child.kill("SIGKILL") } catch { /* ignore */ }
      }, 500).unref()
    }, timeoutMs)

    child.stdout?.on("data", (chunk: Buffer) => {
      const str = chunk.toString("utf-8")
      stdoutBuf.append(str)
      onProgress({ textDelta: str })
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      const str = chunk.toString("utf-8")
      stderrBuf.append(str)
      onProgress({ textDelta: str })
    })

    child.on("error", (err) => {
      finish({ error: `process error: ${err.message}` })
    })

    child.on("close", (exitCode, signal) => {
      const durationMs = Date.now() - startedAt
      const externalAbort = opts.signal?.aborted === true
      finish({
        exitCode: exitCode ?? null,
        signal: signal ?? null,
        stdout: stdoutBuf.value(),
        stderr: stderrBuf.value(),
        stdoutTruncated: stdoutBuf.truncated,
        stderrTruncated: stderrBuf.truncated,
        durationMs,
        timedOut: timedOut && !externalAbort,
      })
    })
  })
}

// Bounded buffer that keeps the most-recent N bytes. Older data is dropped
// silently — the consumer reads `.truncated` to decide whether to show a hint.
class CappedTail {
  truncated = false
  private parts: string[] = []
  private bytes = 0
  constructor(private readonly capBytes: number) {}

  append(chunk: string): void {
    this.parts.push(chunk)
    this.bytes += Buffer.byteLength(chunk, "utf-8")
    while (this.parts.length > 1 && this.bytes > this.capBytes) {
      const dropped = this.parts.shift()!
      this.bytes -= Buffer.byteLength(dropped, "utf-8")
      this.truncated = true
    }
    if (this.parts.length === 1 && this.bytes > this.capBytes) {
      // The single chunk itself is larger than the cap — trim from the front
      // so the tail stays the freshest. Use slice with byte safety.
      const only = this.parts[0]
      const overflow = this.bytes - this.capBytes
      const trimmed = only.slice(overflow) // char-based slice is approximate
      this.parts[0] = trimmed
      this.bytes = Buffer.byteLength(trimmed, "utf-8")
      this.truncated = true
    }
  }

  value(): string {
    return this.parts.join("")
  }
}
