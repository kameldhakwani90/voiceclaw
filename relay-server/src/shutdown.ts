import { log, warn } from "./log.js"

interface TrackedTask {
  promise: Promise<unknown>
  label: string
}

const tasks = new Set<TrackedTask>()
let shuttingDown = false

export function trackBackgroundTask(promise: Promise<unknown>, label: string): void {
  const entry: TrackedTask = { promise, label }
  tasks.add(entry)
  promise.finally(() => {
    tasks.delete(entry)
  })
}

export function inFlightTaskCount(): number {
  return tasks.size
}

export async function gracefulShutdown(timeoutMs: number): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true

  const pending = Array.from(tasks)
  if (pending.length === 0) return

  log(`[shutdown] awaiting ${pending.length} in-flight background task(s) (cap ${timeoutMs}ms)`)

  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs)
    timer.unref()
  })

  const settled = Promise.allSettled(pending.map((t) => t.promise)).then(() => "done" as const)

  const outcome = await Promise.race([settled, timeout])
  if (timer) clearTimeout(timer)

  if (outcome === "timeout") {
    const unfinished = pending.filter((t) => tasks.has(t)).map((t) => t.label)
    warn(`[shutdown] timed out after ${timeoutMs}ms with ${unfinished.length} unfinished task(s): ${unfinished.join(", ")}`)
  } else {
    log("[shutdown] all background tasks settled")
  }
}

export function __resetShutdownStateForTests(): void {
  tasks.clear()
  shuttingDown = false
}
