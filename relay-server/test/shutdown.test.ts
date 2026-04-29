import { afterEach, describe, expect, it } from "vitest"
import {
  __resetShutdownStateForTests,
  gracefulShutdown,
  inFlightTaskCount,
  trackBackgroundTask,
} from "../src/shutdown.js"

describe("gracefulShutdown", () => {
  afterEach(() => {
    __resetShutdownStateForTests()
  })

  it("awaits in-flight tasks and resolves shortly after they settle", async () => {
    let resolved = false
    const task = new Promise<void>((resolve) => {
      setTimeout(() => {
        resolved = true
        resolve()
      }, 200)
    })
    trackBackgroundTask(task, "test-task")

    const start = Date.now()
    await gracefulShutdown(1000)
    const elapsed = Date.now() - start

    expect(resolved).toBe(true)
    expect(elapsed).toBeGreaterThanOrEqual(150)
    expect(elapsed).toBeLessThan(500)
    expect(inFlightTaskCount()).toBe(0)
  })

  it("returns within the cap when a task never resolves", async () => {
    const stuck = new Promise<void>(() => {})
    trackBackgroundTask(stuck, "stuck-task")

    const start = Date.now()
    await gracefulShutdown(100)
    const elapsed = Date.now() - start

    expect(elapsed).toBeGreaterThanOrEqual(80)
    expect(elapsed).toBeLessThan(250)
  })

  it("is idempotent — second call is a no-op", async () => {
    let resolved = false
    const task = new Promise<void>((resolve) => {
      setTimeout(() => {
        resolved = true
        resolve()
      }, 100)
    })
    trackBackgroundTask(task, "idempotent-task")

    await gracefulShutdown(500)
    expect(resolved).toBe(true)

    let secondTaskRan = false
    const second = new Promise<void>((resolve) => {
      setTimeout(() => {
        secondTaskRan = true
        resolve()
      }, 200)
    })
    trackBackgroundTask(second, "second-task")

    const start = Date.now()
    await gracefulShutdown(500)
    const elapsed = Date.now() - start

    expect(elapsed).toBeLessThan(50)
    expect(secondTaskRan).toBe(false)

    await second
  })
})
