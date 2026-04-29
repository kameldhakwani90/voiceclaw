import { app } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { allocatePort } from '../ports'
import { serviceManager } from './service-manager'

// Bundled relay-server spawn. The signed binary ships under
// Resources/bin/relay-server-darwin-<arch> via the dist:mac pipeline
// (yarn workspace relay-server build:bin runs before electron-builder).
// In dev the binary is absent; the root `yarn dev` orchestrator already
// runs the relay via tsx, so this module no-ops and the renderer keeps
// talking to ws://localhost:8080/ws.

export async function startBundledRelayServer(): Promise<void> {
  const binaryPath = resolveBundledBinary()
  if (!binaryPath) {
    console.info('[relay] bundled binary not found; skipping spawn')
    return
  }

  const port = await allocatePort('relay')

  await serviceManager.start({
    name: 'relay',
    command: binaryPath,
    args: [],
    env: forwardedEnv(),
    port,
    healthCheckUrl: `http://127.0.0.1:${port}/health`,
    logFile: 'relay-server.log',
  })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FORWARDED_KEYS = [
  'GEMINI_API_KEY',
  'OPENAI_API_KEY',
  'XAI_API_KEY',
  'TAVILY_API_KEY',
  'BRAIN_GATEWAY_URL',
  'RELAY_API_KEY',
  'LANGFUSE_PUBLIC_KEY',
  'LANGFUSE_SECRET_KEY',
  'LANGFUSE_BASE_URL',
  'TRACING_UI_COLLECTOR_URL',
] as const

function forwardedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of FORWARDED_KEYS) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

export function resolveBundledBinary(): string | null {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const binaryName = `relay-server-darwin-${arch}`

  if (app.isPackaged) {
    const packaged = join(process.resourcesPath, 'bin', binaryName)
    return existsSync(packaged) ? packaged : null
  }

  const dev = join(__dirname, '..', '..', 'resources', 'bin', binaryName)
  return existsSync(dev) ? dev : null
}
