import { app } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { allocatePort } from '../ports'
import { getProviderKey, type ProviderId } from '../provider-keys'
import { serviceManager } from './service-manager'

// Packaged builds find the binary under process.resourcesPath; dev
// builds (where __dirname is out/main/) walk up to desktop/resources/.
// Without the binary present we no-op so `yarn dev` keeps working.

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
    env: buildRelayEnv(),
    port,
    healthCheckUrl: `http://127.0.0.1:${port}/health`,
    logFile: 'relay-server.log',
  })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FORWARDED_KEYS = [
  'TAVILY_API_KEY',
  'BRAIN_GATEWAY_URL',
  'RELAY_API_KEY',
  'LANGFUSE_PUBLIC_KEY',
  'LANGFUSE_SECRET_KEY',
  'LANGFUSE_BASE_URL',
  'TRACING_UI_COLLECTOR_URL',
  'GIT_SHA',
  'RELAY_VERSION',
] as const

const PROVIDER_ENV_KEYS: Record<ProviderId, string> = {
  gemini: 'GEMINI_API_KEY',
  openai: 'OPENAI_API_KEY',
  xai: 'XAI_API_KEY',
}

function forwardedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of FORWARDED_KEYS) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

function buildRelayEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = forwardedEnv()
  for (const provider of Object.keys(PROVIDER_ENV_KEYS) as ProviderId[]) {
    const envKey = PROVIDER_ENV_KEYS[provider]
    if (env[envKey]) continue
    const stored = getProviderKey(provider)
    if (stored) env[envKey] = stored
  }
  // Tavily is stored in the renderer-side settings KV today, not the
  // provider-keys vault, so the relay reads it from process.env via the
  // forwarded passthrough above when the user has exported it.
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
