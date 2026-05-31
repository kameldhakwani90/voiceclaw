import { getDb } from './db'
import { capture as telemetryCapture } from './telemetry'
import { createDeviceToken, getSystemDeviceToken } from './device-tokens'

// Onboarding state — single-row table (id=1) capturing the wizard's
// resume point and accumulated payload. Renderer reads on mount; if
// completed_at is null, we show the wizard. Each step transition
// merges a payload patch and bumps current_step so a quit-mid-flow
// resumes cleanly.

export type WizardStepId =
  | 'welcome'
  | 'signin'
  | 'permissions'
  | 'provider'
  | 'brain'
  | 'identity'
  | 'testcall'

export type OnboardingPayload = {
  signedIn?: boolean
  permissions?: {
    mic?: 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown'
    screen?: 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown'
  }
  provider?: 'gemini' | 'openai' | 'xai'
  providerKeyValidated?: boolean
  brain?: 'openclaw' | 'claude' | 'codex' | { url: string }
  identity?: {
    name?: string
    description?: string
    voice?: string
  }
  user?: { id?: string; email?: string | null; name?: string | null }
}

export type OnboardingState = {
  currentStep: WizardStepId
  payload: OnboardingPayload
  completedAt: string | null
}

export function ensureOnboardingSchema(): void {
  const db = getDb()
  db.exec(`
    CREATE TABLE IF NOT EXISTS onboarding_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      current_step TEXT NOT NULL DEFAULT 'welcome',
      payload TEXT NOT NULL DEFAULT '{}',
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS provider_keys (
      provider TEXT PRIMARY KEY,
      key_enc BLOB NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      user_email TEXT,
      user_name TEXT,
      token_enc BLOB NOT NULL,
      platform TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS device_tokens (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER,
      revoked INTEGER NOT NULL DEFAULT 0,
      kind TEXT NOT NULL DEFAULT 'user'
    );

    CREATE INDEX IF NOT EXISTS idx_device_tokens_hash ON device_tokens(token_hash);
  `)
  // Older installs may have the device_tokens table without a `kind` column.
  // SQLite's ALTER TABLE ADD COLUMN is the only way to migrate in place; we
  // ignore "duplicate column" errors so this runs idempotently.
  try {
    db.exec(`ALTER TABLE device_tokens ADD COLUMN kind TEXT NOT NULL DEFAULT 'user'`)
  } catch {
    // column already exists
  }
}

export function getOnboardingState(): OnboardingState {
  ensureOnboardingSchema()
  const db = getDb()
  const row = db
    .prepare(
      'SELECT current_step as currentStep, payload, completed_at as completedAt FROM onboarding_state WHERE id = 1',
    )
    .get() as { currentStep: WizardStepId; payload: string; completedAt: string | null } | undefined

  if (!row) {
    db.prepare(
      "INSERT INTO onboarding_state (id, current_step, payload, completed_at) VALUES (1, 'welcome', '{}', NULL)",
    ).run()
    return { currentStep: 'welcome', payload: {}, completedAt: null }
  }

  return {
    currentStep: row.currentStep,
    payload: parsePayload(row.payload),
    completedAt: row.completedAt,
  }
}

export function updateOnboardingStep(
  step: WizardStepId,
  payloadPatch: OnboardingPayload = {},
): OnboardingState {
  ensureOnboardingSchema()
  const current = getOnboardingState()
  const merged = mergePayload(current.payload, payloadPatch)
  const db = getDb()
  db.prepare(
    'UPDATE onboarding_state SET current_step = ?, payload = ? WHERE id = 1',
  ).run(step, JSON.stringify(merged))
  return { currentStep: step, payload: merged, completedAt: current.completedAt }
}

export function markOnboardingComplete(): OnboardingState {
  ensureOnboardingSchema()
  const completedAt = new Date().toISOString()
  const db = getDb()
  db.prepare('UPDATE onboarding_state SET completed_at = ? WHERE id = 1').run(completedAt)
  telemetryCapture('onboarding_completed')
  return { ...getOnboardingState(), completedAt }
}

export type BundledDefaults = {
  relayApiKey: string
  serverUrlPlaceholder: string | null
}

// First-launch (and reset) bootstrap. Mints the un-revokable 'system'
// device token that represents THIS Mac in the device_tokens table, and
// surfaces its plaintext through the existing `realtime_api_key` settings
// row so the renderer's ChatPage can keep reading it just-in-time without
// the relay needing a separate master key.
//
// Migration: if an old `realtime_api_key` UUID exists from before the
// drop-master-key cutover, it's overwritten by the new device-token
// plaintext on this same boot — before the renderer makes its first WS
// request — so nothing 401s mid-session. The old UUID is dropped from
// settings rather than kept around as a parallel auth path.
export function ensureBundledRelayDefaults(options: { force?: boolean } = {}): BundledDefaults {
  ensureOnboardingSchema()
  const db = getDb()
  let apiKey = ''
  const existingSystem = getSystemDeviceToken()
  if (options.force || !existingSystem) {
    // Mint a fresh system row. We can't recover an existing system row's
    // plaintext (only the sha256 hash is stored), so the only safe path
    // when the row is missing is to mint anew — the previous plaintext is
    // unrecoverable anyway.
    const created = createDeviceToken('This Mac', { kind: 'system' })
    apiKey = created.plaintext
    db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?',
    ).run('realtime_api_key', apiKey, apiKey)
  } else {
    const existing = db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get('realtime_api_key') as { value: string } | undefined
    apiKey = existing?.value ?? ''
  }
  if (options.force) {
    db.prepare('DELETE FROM settings WHERE key = ?').run('realtime_server_url')
  }
  return { relayApiKey: apiKey, serverUrlPlaceholder: null }
}

export function getBundledRelayApiKey(): string | null {
  ensureOnboardingSchema()
  const db = getDb()
  const row = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get('realtime_api_key') as { value: string } | undefined
  return row?.value ?? null
}

export function getTavilyApiKey(): string | null {
  ensureOnboardingSchema()
  const db = getDb()
  const enabledRow = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get('tavily_enabled') as { value: string } | undefined
  if (enabledRow?.value === 'false') return null
  const keyRow = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get('tavily_api_key') as { value: string } | undefined
  const key = keyRow?.value
  return key && key.length > 0 ? key : null
}

export function resetOnboarding(): OnboardingState {
  ensureOnboardingSchema()
  const db = getDb()
  db.prepare('DELETE FROM onboarding_state').run()
  // Don't wipe provider_keys / devices here — those are useful even if
  // the user re-runs the wizard. Reset only the wizard's resume cursor.
  return getOnboardingState()
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parsePayload(raw: string): OnboardingPayload {
  try {
    const parsed = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? (parsed as OnboardingPayload) : {}
  } catch {
    return {}
  }
}

function mergePayload(
  current: OnboardingPayload,
  patch: OnboardingPayload,
): OnboardingPayload {
  return {
    ...current,
    ...patch,
    permissions: patch.permissions
      ? { ...(current.permissions ?? {}), ...patch.permissions }
      : current.permissions,
    user: patch.user ? { ...(current.user ?? {}), ...patch.user } : current.user,
  }
}
