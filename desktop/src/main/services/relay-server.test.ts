import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const isPackagedRef = { value: false }
const existsRef = { fn: (_p: string) => false as boolean }
let originalResourcesPath: string | undefined
let originalArch: string

vi.mock('electron', () => ({
  app: {
    get isPackaged(): boolean {
      return isPackagedRef.value
    },
  },
}))

vi.mock('fs', () => ({
  existsSync: (path: string) => existsRef.fn(path),
}))

describe('resolveBundledBinary', () => {
  beforeEach(() => {
    originalResourcesPath = process.resourcesPath
    originalArch = process.arch
    isPackagedRef.value = false
    existsRef.fn = () => false
  })

  afterEach(() => {
    if (originalResourcesPath !== undefined) {
      Object.defineProperty(process, 'resourcesPath', {
        value: originalResourcesPath,
        configurable: true,
      })
    }
    Object.defineProperty(process, 'arch', { value: originalArch, configurable: true })
    vi.resetModules()
  })

  it('returns packaged path when app.isPackaged and binary exists', async () => {
    isPackagedRef.value = true
    Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true })
    Object.defineProperty(process, 'resourcesPath', {
      value: '/Applications/VoiceClaw.app/Contents/Resources',
      configurable: true,
    })
    existsRef.fn = (p: string) =>
      p === '/Applications/VoiceClaw.app/Contents/Resources/bin/relay-server-darwin-arm64'

    const { resolveBundledBinary } = await import('./relay-server')
    expect(resolveBundledBinary()).toBe(
      '/Applications/VoiceClaw.app/Contents/Resources/bin/relay-server-darwin-arm64',
    )
  })

  it('returns null in packaged mode when binary is missing', async () => {
    isPackagedRef.value = true
    Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true })
    Object.defineProperty(process, 'resourcesPath', {
      value: '/Applications/VoiceClaw.app/Contents/Resources',
      configurable: true,
    })
    existsRef.fn = () => false

    const { resolveBundledBinary } = await import('./relay-server')
    expect(resolveBundledBinary()).toBeNull()
  })

  it('returns dev path when not packaged and binary exists in resources/bin', async () => {
    isPackagedRef.value = false
    Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true })
    existsRef.fn = (p: string) =>
      p.endsWith('/resources/bin/relay-server-darwin-arm64')

    const { resolveBundledBinary } = await import('./relay-server')
    const resolved = resolveBundledBinary()
    expect(resolved).not.toBeNull()
    expect(resolved!.endsWith('/resources/bin/relay-server-darwin-arm64')).toBe(true)
  })

  it('returns null in dev when binary is absent (the common dev case)', async () => {
    isPackagedRef.value = false
    Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true })
    existsRef.fn = () => false

    const { resolveBundledBinary } = await import('./relay-server')
    expect(resolveBundledBinary()).toBeNull()
  })

  it('selects x64 binary on Intel macs', async () => {
    isPackagedRef.value = true
    Object.defineProperty(process, 'arch', { value: 'x64', configurable: true })
    Object.defineProperty(process, 'resourcesPath', {
      value: '/Applications/VoiceClaw.app/Contents/Resources',
      configurable: true,
    })
    existsRef.fn = (p: string) =>
      p === '/Applications/VoiceClaw.app/Contents/Resources/bin/relay-server-darwin-x64'

    const { resolveBundledBinary } = await import('./relay-server')
    expect(resolveBundledBinary()).toBe(
      '/Applications/VoiceClaw.app/Contents/Resources/bin/relay-server-darwin-x64',
    )
  })
})
