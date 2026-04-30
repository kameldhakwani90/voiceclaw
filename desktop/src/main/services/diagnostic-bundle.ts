import { app } from 'electron'
import { createRequire } from 'module'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  createWriteStream,
} from 'fs'
import { join } from 'path'
import { release } from 'os'
import { getDb } from '../db'
import { getLogDir } from '../logs'
import { serviceManager } from './service-manager'
import { getOpenClawConfigPath } from './openclaw-gateway'
import { getDistinctId } from '../telemetry'

const require = createRequire(import.meta.url)
const archiver = require('archiver') as typeof import('archiver').default

export type BundleResult = { ok: true; path: string } | { ok: false; error: string }

export async function buildDiagnosticBundle(): Promise<BundleResult> {
  const timestamp = formatTimestamp(new Date())
  const tempDir = join(app.getPath('temp'), `voiceclaw-diag-${timestamp}`)
  const outPath = join(app.getPath('home'), 'Downloads', `voiceclaw-diagnostics-${timestamp}.zip`)

  try {
    mkdirSync(tempDir, { recursive: true })

    await Promise.all([
      writeSystemInfo(tempDir),
      writeLogs(tempDir),
      writeOpenClawConfig(tempDir),
      writeWorkspaceManifest(tempDir),
      writeDbDump(tempDir),
      writeServiceHealth(tempDir),
    ])

    await zipDir(tempDir, outPath)
    return { ok: true, path: outPath }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // best-effort cleanup
    }
  }
}

// ---------------------------------------------------------------------------
// Bundle sections
// ---------------------------------------------------------------------------

async function writeSystemInfo(dir: string): Promise<void> {
  const distinctId = safeGet(() => getDistinctId()) ?? null
  const info = {
    appVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    osRelease: release(),
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    bundledAt: new Date().toISOString(),
    telemetryDistinctId: distinctId,
  }
  writeJson(join(dir, 'system.json'), info)
}

function writeLogs(dir: string): Promise<void> {
  return new Promise((resolve) => {
    const logDir = safeGet(() => getLogDir())
    if (!logDir || !existsSync(logDir)) {
      resolve()
      return
    }
    const destDir = join(dir, 'logs')
    mkdirSync(destDir, { recursive: true })
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
    let entries: string[] = []
    try {
      entries = readdirSync(logDir)
    } catch {
      resolve()
      return
    }
    for (const name of entries) {
      if (!name.endsWith('.log')) continue
      const src = join(logDir, name)
      try {
        const st = statSync(src)
        if (st.mtimeMs < cutoff) continue
        writeFileSync(join(destDir, name), readFileSync(src))
      } catch {
        // skip unreadable files
      }
    }
    resolve()
  })
}

function writeOpenClawConfig(dir: string): Promise<void> {
  return new Promise((resolve) => {
    const configPath = safeGet(() => getOpenClawConfigPath())
    if (!configPath || !existsSync(configPath)) {
      resolve()
      return
    }
    try {
      const raw = readFileSync(configPath, 'utf8')
      const parsed = JSON.parse(raw) as Record<string, unknown>
      const redacted = redactOpenClawConfig(parsed)
      writeJson(join(dir, 'openclaw-config.redacted.json'), redacted)
    } catch {
      // missing or invalid config — skip without crashing
    }
    resolve()
  })
}

function writeWorkspaceManifest(dir: string): Promise<void> {
  return new Promise((resolve) => {
    const stateDir = join(app.getPath('userData'), 'openclaw')
    const workspaceDir = join(stateDir, 'workspace')
    if (!existsSync(workspaceDir)) {
      resolve()
      return
    }
    const lines: string[] = ['# Workspace file inventory (names + sizes; no contents)']
    try {
      for (const name of readdirSync(workspaceDir)) {
        try {
          const st = statSync(join(workspaceDir, name))
          lines.push(`${name}\t${st.size} bytes`)
        } catch {
          lines.push(`${name}\t(unreadable)`)
        }
      }
    } catch {
      // empty workspace or no access
    }
    writeFileSync(join(dir, 'workspace-manifest.txt'), lines.join('\n') + '\n')
    resolve()
  })
}

function writeDbDump(dir: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      const db = getDb()

      const schemaRows = db
        .prepare('SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type, name')
        .all() as { sql: string }[]
      const schemaText = schemaRows.map((r) => r.sql + ';').join('\n\n')
      writeFileSync(join(dir, 'schema.sql'), schemaText + '\n')

      const settingKeys = db
        .prepare('SELECT key FROM settings ORDER BY key')
        .all() as { key: string }[]
      writeFileSync(
        join(dir, 'settings-keys.txt'),
        '# Setting keys (no values)\n' + settingKeys.map((r) => r.key).join('\n') + '\n',
      )

      const telemetryRow = db
        .prepare("SELECT value FROM settings WHERE key = 'telemetry_distinct_id'")
        .get() as { value: string } | undefined
      if (telemetryRow) {
        writeFileSync(join(dir, 'telemetry-id.txt'), telemetryRow.value + '\n')
      }

      const providerInventory = safeGet(() => {
        const rows = db
          .prepare('SELECT provider FROM provider_keys ORDER BY provider')
          .all() as { provider: string }[]
        return rows.map((r) => r.provider)
      }) ?? []
      writeFileSync(
        join(dir, 'provider-keys-inventory.txt'),
        '# Providers with a saved key (no key values)\n' + providerInventory.join('\n') + '\n',
      )
    } catch {
      // DB not initialized on fresh install — skip
    }
    resolve()
  })
}

function writeServiceHealth(dir: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      const statuses = serviceManager.getAllStatuses()
      writeJson(join(dir, 'services-health.json'), statuses)
    } catch {
      // serviceManager unavailable
    }
    resolve()
  })
}

// ---------------------------------------------------------------------------
// ZIP
// ---------------------------------------------------------------------------

function zipDir(srcDir: string, outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(outPath)
    const archive = archiver('zip', { zlib: { level: 6 } })

    output.on('close', resolve)
    archive.on('error', reject)
    archive.pipe(output)
    archive.directory(srcDir, false)
    archive.finalize()
  })
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

export function redactOpenClawConfig(config: Record<string, unknown>): Record<string, unknown> {
  const copy = deepClone(config)
  redactProviderKeys(copy)
  redactGatewayToken(copy)
  return copy
}

function redactProviderKeys(obj: Record<string, unknown>): void {
  const models = obj.models as Record<string, unknown> | undefined
  if (!models) return
  const providers = models.providers as Record<string, unknown> | undefined
  if (!providers) return
  for (const providerName of Object.keys(providers)) {
    const provider = providers[providerName] as Record<string, unknown> | undefined
    if (provider && typeof provider === 'object' && 'apiKey' in provider) {
      provider.apiKey = '<redacted>'
    }
  }
}

function redactGatewayToken(obj: Record<string, unknown>): void {
  const gateway = obj.gateway as Record<string, unknown> | undefined
  if (!gateway) return
  const auth = gateway.auth as Record<string, unknown> | undefined
  if (!auth) return
  if ('token' in auth) {
    auth.token = '<redacted>'
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n')
}

function safeGet<T>(fn: () => T): T | undefined {
  try {
    return fn()
  } catch {
    return undefined
  }
}

function formatTimestamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}`
  )
}
