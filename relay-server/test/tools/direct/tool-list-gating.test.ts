import { describe, expect, it, afterEach } from "vitest"
import { getRelayTools } from "../../../src/tools/index.js"
import type { SessionConfigEvent } from "../../../src/types.js"

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

describe("tool list gating", () => {
  afterEach(() => {
    delete process.env.TAVILY_API_KEY
  })

  it("flag OFF: exposes echo_tool, ask_brain (and web_search when Tavily is set); no direct tools", () => {
    process.env.TAVILY_API_KEY = "tvly-test"
    const tools = getRelayTools(makeConfig({ experimentalDirectTools: false }))
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual(["ask_brain", "echo_tool", "web_search"])
  })

  it("flag OFF without Tavily: just echo_tool + ask_brain", () => {
    const tools = getRelayTools(makeConfig({ experimentalDirectTools: false }))
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual(["ask_brain", "echo_tool"])
  })

  it("flag ON: exposes the 5 direct-mode tools (read/write/edit/bash + web_search when Tavily set) and drops ask_brain", () => {
    process.env.TAVILY_API_KEY = "tvly-test"
    const tools = getRelayTools(makeConfig({ experimentalDirectTools: true }))
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual(["bash", "echo_tool", "edit", "read", "web_search", "write"])
    expect(names).not.toContain("ask_brain")
  })

  it("flag ON without Tavily: 4 direct tools, ask_brain still dropped", () => {
    const tools = getRelayTools(makeConfig({ experimentalDirectTools: true }))
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual(["bash", "echo_tool", "edit", "read", "write"])
    expect(names).not.toContain("ask_brain")
  })

  it("flag-off tool list is identical to a baseline session.config (no behavior drift)", () => {
    const before = getRelayTools(makeConfig({ experimentalDirectTools: false }))
    const baseline = getRelayTools(makeConfig({}))
    expect(before).toEqual(baseline)
  })

  it("brainAgent='none' + flag ON still exposes the 4 direct tools without ask_brain", () => {
    const tools = getRelayTools(makeConfig({ experimentalDirectTools: true, brainAgent: "none" }))
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual(["bash", "echo_tool", "edit", "read", "write"])
  })

  it("direct tools have the expected latency classes", () => {
    const tools = getRelayTools(makeConfig({ experimentalDirectTools: true }))
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.latencyClass]))
    expect(byName.read).toBe("fast")
    expect(byName.write).toBe("fast")
    expect(byName.edit).toBe("fast")
    expect(byName.bash).toBe("streaming")
  })
})
