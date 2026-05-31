import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Row = { value: string } | undefined
const settings = new Map<string, string>()

const fakeStmt = {
  get: (key: string): Row => {
    const value = settings.get(key)
    return value === undefined ? undefined : { value }
  },
  run: (...args: unknown[]) => {
    if (args.length === 1) {
      settings.delete(String(args[0]))
      return
    }
    if (args.length >= 2) {
      const key = String(args[0])
      const value = String(args[1])
      settings.set(key, value)
    }
  },
  all: () => Array.from(settings.entries()).map(([key, value]) => ({ key, value })),
}

const fakeDb = {
  exec: () => undefined,
  prepare: () => fakeStmt,
}

vi.mock('./db', () => ({
  getDb: () => fakeDb,
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/voiceclaw-onboarding-test',
  },
}))

// device-tokens lives over the same SQLite layer in production. The
// onboarding tests stub it because they only care that bootstrap
// minted-or-reused the system row and surfaced the plaintext into the
// settings KV — not that the device_tokens INSERT SQL is wired right
// (that's covered in device-tokens.test.ts).
let systemRow: { id: string; label: string; createdAt: number; lastUsedAt: number | null; revoked: boolean; kind: 'system' } | null = null
let mintCount = 0
vi.mock('./device-tokens', () => ({
  getSystemDeviceToken: () => systemRow,
  createDeviceToken: (label: string, opts: { kind?: 'user' | 'system' } = {}) => {
    mintCount += 1
    const plaintext = `vcd_test_${mintCount}_${Math.random().toString(36).slice(2)}`
    const row = {
      id: `id-${mintCount}`,
      label,
      createdAt: Date.now(),
      lastUsedAt: null,
      revoked: false,
      kind: (opts.kind ?? 'user') as 'user' | 'system',
    }
    if (row.kind === 'system') systemRow = row as typeof systemRow
    return { id: row.id, label, plaintext, createdAt: row.createdAt, kind: row.kind }
  },
}))

describe('ensureBundledRelayDefaults', () => {
  beforeEach(() => {
    settings.clear()
    systemRow = null
    mintCount = 0
  })

  afterEach(() => {
    vi.resetModules()
  })

  it("mints a system device-token and surfaces its plaintext as 'realtime_api_key' when nothing exists yet", async () => {
    const { ensureBundledRelayDefaults } = await import('./onboarding')
    const result = ensureBundledRelayDefaults()
    expect(result.relayApiKey).toMatch(/^vcd_test_/)
    expect(settings.get('realtime_api_key')).toBe(result.relayApiKey)
    expect(systemRow?.kind).toBe('system')
  })

  it('is idempotent: a second call reuses the existing system row + stored plaintext, mints only once', async () => {
    const { ensureBundledRelayDefaults } = await import('./onboarding')
    const first = ensureBundledRelayDefaults()
    const second = ensureBundledRelayDefaults()
    expect(second.relayApiKey).toBe(first.relayApiKey)
    expect(mintCount).toBe(1)
  })

  it('migrates an installation with an old UUID realtime_api_key (no system row) by minting a system token and overwriting the setting', async () => {
    settings.set('realtime_api_key', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
    const { ensureBundledRelayDefaults } = await import('./onboarding')
    const result = ensureBundledRelayDefaults()
    expect(result.relayApiKey).not.toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
    expect(result.relayApiKey).toMatch(/^vcd_test_/)
    expect(settings.get('realtime_api_key')).toBe(result.relayApiKey)
    expect(systemRow?.kind).toBe('system')
  })

  it('force=true rotates: mints a fresh system row + new plaintext, and clears realtime_server_url', async () => {
    systemRow = {
      id: 'old', label: 'This Mac', createdAt: 0, lastUsedAt: null, revoked: false, kind: 'system',
    }
    settings.set('realtime_api_key', 'old-plaintext')
    settings.set('realtime_server_url', 'ws://example.com/ws')
    const { ensureBundledRelayDefaults } = await import('./onboarding')
    const result = ensureBundledRelayDefaults({ force: true })
    expect(result.relayApiKey).not.toBe('old-plaintext')
    expect(result.relayApiKey).toMatch(/^vcd_test_/)
    expect(settings.has('realtime_server_url')).toBe(false)
  })
})

describe('getBundledRelayApiKey', () => {
  beforeEach(() => {
    settings.clear()
  })

  afterEach(() => {
    vi.resetModules()
  })

  it('returns null when nothing has been seeded yet', async () => {
    const { getBundledRelayApiKey } = await import('./onboarding')
    expect(getBundledRelayApiKey()).toBeNull()
  })

  it('returns the seeded key when present', async () => {
    settings.set('realtime_api_key', 'baked')
    const { getBundledRelayApiKey } = await import('./onboarding')
    expect(getBundledRelayApiKey()).toBe('baked')
  })
})
