import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildInstructions } from "../src/instructions.js"
import { ensureWorkspace, getMemoryDir, getAgentsMdPath, getWorkspaceRoot } from "../src/workspace.js"
import type { SessionConfigEvent } from "../src/types.js"

function makeConfig(overrides: Partial<SessionConfigEvent> = {}): SessionConfigEvent {
  return {
    type: "session.config",
    provider: "openai",
    voice: "marin",
    brainAgent: "enabled",
    apiKey: "test-key",
    ...overrides,
  }
}

describe("buildInstructions — direct-tools mode", () => {
  let tmpRoot: string
  let prevEnv: string | undefined

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "voiceclaw-instr-"))
    prevEnv = process.env.VOICECLAW_WORKSPACE
    process.env.VOICECLAW_WORKSPACE = join(tmpRoot, "workspace")
    await ensureWorkspace()
  })

  afterEach(async () => {
    if (prevEnv === undefined) delete process.env.VOICECLAW_WORKSPACE
    else process.env.VOICECLAW_WORKSPACE = prevEnv
    await rm(tmpRoot, { recursive: true, force: true })
  })

  it("does NOT include the direct-tools preamble when the flag is off", () => {
    const instructions = buildInstructions(makeConfig({ experimentalDirectTools: false }))
    expect(instructions).not.toMatch(/Your direct tools/)
    expect(instructions).not.toMatch(/Workspace context/)
  })

  it("includes the direct-tools preamble when the flag is on", () => {
    const instructions = buildInstructions(makeConfig({ experimentalDirectTools: true }))
    expect(instructions).toMatch(/Your direct tools/)
    expect(instructions).toMatch(/read.*to inspect files/i)
    expect(instructions).toMatch(/write.*and.*edit/i)
    expect(instructions).toMatch(/bash/)
    expect(instructions).toMatch(/web_search/)
  })

  it("includes the workspace context section with AGENTS.md and memory", async () => {
    // Custom AGENTS.md
    await writeFile(getAgentsMdPath(), "MY-AGENTS-MARKER\n", "utf-8")
    // Three memory files: today, two days ago, ten days ago (the last should be excluded).
    const today = new Date()
    const ymd = (d: Date) => {
      const y = d.getFullYear().toString().padStart(4, "0")
      const m = (d.getMonth() + 1).toString().padStart(2, "0")
      const day = d.getDate().toString().padStart(2, "0")
      return `${y}-${m}-${day}`
    }
    const writeMemory = async (offsetDays: number, body: string) => {
      const d = new Date(today.getTime())
      d.setDate(d.getDate() - offsetDays)
      await mkdir(getMemoryDir(), { recursive: true })
      await writeFile(join(getMemoryDir(), `${ymd(d)}.md`), body, "utf-8")
    }
    await writeMemory(0, "TODAY-NOTE")
    await writeMemory(2, "TWO-DAYS-NOTE")
    await writeMemory(10, "TEN-DAYS-NOTE")

    const instructions = buildInstructions(makeConfig({ experimentalDirectTools: true }))
    expect(instructions).toMatch(/Workspace context \(preloaded\)/)
    expect(instructions).toMatch(/MY-AGENTS-MARKER/)
    expect(instructions).toMatch(/TODAY-NOTE/)
    expect(instructions).toMatch(/TWO-DAYS-NOTE/)
    // Older than 7 days — must not appear
    expect(instructions).not.toMatch(/TEN-DAYS-NOTE/)
  })

  it("shows a stub when no memory files exist", () => {
    const instructions = buildInstructions(makeConfig({ experimentalDirectTools: true }))
    expect(instructions).toMatch(/No memory files yet/)
  })

  it("flag-off path is unchanged: produces the same instructions across calls", () => {
    const a = buildInstructions(makeConfig({ experimentalDirectTools: false }))
    const b = buildInstructions(makeConfig({ experimentalDirectTools: false }))
    expect(a).toBe(b)
  })

  it("uses the default AGENTS.md if the file is somehow missing", async () => {
    // Wipe the AGENTS.md file
    await rm(getAgentsMdPath(), { force: true })
    const instructions = buildInstructions(makeConfig({ experimentalDirectTools: true }))
    // Default AGENTS.md mentions the workspace path
    expect(instructions).toMatch(/Voiceclaw Agent Workspace/)
    expect(instructions).toMatch(/~\/\.voiceclaw\/workspace/)
    void getWorkspaceRoot
  })
})
