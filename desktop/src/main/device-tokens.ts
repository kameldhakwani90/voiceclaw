import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { getDb } from './db'
import { ensureOnboardingSchema } from './onboarding'

// Per-device pairing tokens. Each paired mobile device gets its own
// 256-bit token, surfaced as plaintext ONCE at creation time (inside
// the QR payload) and stored ONLY as a sha256 hex digest. Tokens can
// be revoked individually so losing a phone can't lock the rest of
// the household out.
//
// `kind` partitions rows into 'user' (a paired phone/tablet) and
// 'system' (this Mac's self-connect identity). System rows are
// un-revokable from the UI/IPC so the user can't lock themselves
// out of their own desktop.

const TOKEN_PREFIX = 'vcd_'

export type DeviceTokenKind = 'user' | 'system'

export type DeviceTokenRow = {
  id: string
  label: string
  createdAt: number
  lastUsedAt: number | null
  revoked: boolean
  kind: DeviceTokenKind
}

export type CreatedDeviceToken = {
  id: string
  label: string
  plaintext: string
  createdAt: number
  kind: DeviceTokenKind
}

export function createDeviceToken(
  label: string,
  options: { kind?: DeviceTokenKind } = {},
): CreatedDeviceToken {
  ensureOnboardingSchema()
  const trimmed = label.trim()
  if (trimmed.length === 0) throw new Error('label is required')
  const kind: DeviceTokenKind = options.kind ?? 'user'
  const id = randomUUID()
  const plaintext = TOKEN_PREFIX + randomBytes(32).toString('base64url')
  const tokenHash = hashDeviceToken(plaintext)
  const createdAt = Date.now()
  const db = getDb()
  db.prepare(
    `INSERT INTO device_tokens (id, label, token_hash, created_at, last_used_at, revoked, kind)
     VALUES (?, ?, ?, ?, NULL, 0, ?)`,
  ).run(id, trimmed, tokenHash, createdAt, kind)
  return { id, label: trimmed, plaintext, createdAt, kind }
}

export function listDeviceTokens(): DeviceTokenRow[] {
  ensureOnboardingSchema()
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT id, label, created_at AS createdAt, last_used_at AS lastUsedAt, revoked, kind
       FROM device_tokens
       ORDER BY created_at DESC`,
    )
    .all() as { id: string; label: string; createdAt: number; lastUsedAt: number | null; revoked: number; kind: string | null }[]
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    createdAt: r.createdAt,
    lastUsedAt: r.lastUsedAt,
    revoked: r.revoked !== 0,
    kind: (r.kind === 'system' ? 'system' : 'user') as DeviceTokenKind,
  }))
}

function getDeviceTokenKind(id: string): DeviceTokenKind | null {
  const db = getDb()
  const row = db
    .prepare('SELECT kind FROM device_tokens WHERE id = ?')
    .get(id) as { kind: string | null } | undefined
  if (!row) return null
  return row.kind === 'system' ? 'system' : 'user'
}

export function revokeDeviceToken(id: string): void {
  ensureOnboardingSchema()
  const kind = getDeviceTokenKind(id)
  if (kind === 'system') {
    throw new Error("Can't revoke this Mac's own device token.")
  }
  const db = getDb()
  db.prepare('UPDATE device_tokens SET revoked = 1 WHERE id = ?').run(id)
}

export function renameDeviceToken(id: string, label: string): void {
  ensureOnboardingSchema()
  const trimmed = label.trim()
  if (trimmed.length === 0) throw new Error('label is required')
  const db = getDb()
  db.prepare('UPDATE device_tokens SET label = ? WHERE id = ?').run(trimmed, id)
}

export function removeDeviceToken(id: string): void {
  ensureOnboardingSchema()
  const kind = getDeviceTokenKind(id)
  if (kind === 'system') {
    throw new Error("Can't remove this Mac's own device token.")
  }
  const db = getDb()
  db.prepare('DELETE FROM device_tokens WHERE id = ?').run(id)
}

// Read-side helpers used by the localhost device-token bridge that the
// relay calls to validate inbound credentials. The bridge does not see
// plaintext — the relay hashes locally and asks "is this hash valid?".
export function lookupDeviceTokenByHash(
  tokenHash: string,
): { id: string; revoked: boolean } | null {
  ensureOnboardingSchema()
  const db = getDb()
  const row = db
    .prepare('SELECT id, revoked FROM device_tokens WHERE token_hash = ?')
    .get(tokenHash) as { id: string; revoked: number } | undefined
  if (!row) return null
  return { id: row.id, revoked: row.revoked !== 0 }
}

// Default labels minted by the desktop start with this prefix (see
// buildDefaultLabel in renderer/src/lib/pair.ts). The mobile-initiated
// rename only fires when the row still wears that auto-label so a
// user's manual rename is never clobbered.
export const DEFAULT_LABEL_PREFIX = 'New device'

export function renameDeviceTokenIfDefault(tokenHash: string, name: string): boolean {
  ensureOnboardingSchema()
  const trimmed = name.trim()
  if (trimmed.length === 0) return false
  const db = getDb()
  const row = db
    .prepare('SELECT id, label FROM device_tokens WHERE token_hash = ?')
    .get(tokenHash) as { id: string; label: string } | undefined
  if (!row) return false
  if (!row.label.startsWith(DEFAULT_LABEL_PREFIX)) return false
  db.prepare('UPDATE device_tokens SET label = ? WHERE id = ?').run(trimmed, row.id)
  return true
}

export function touchDeviceToken(id: string): void {
  ensureOnboardingSchema()
  const db = getDb()
  db.prepare('UPDATE device_tokens SET last_used_at = ? WHERE id = ?').run(Date.now(), id)
}

export function hashDeviceToken(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex')
}

// Returns the existing 'system' row (one-per-install identity for this Mac)
// or null if none has been minted yet. Used by the bootstrap path to decide
// whether to mint or reuse.
export function getSystemDeviceToken(): DeviceTokenRow | null {
  ensureOnboardingSchema()
  const db = getDb()
  const row = db
    .prepare(
      `SELECT id, label, created_at AS createdAt, last_used_at AS lastUsedAt, revoked, kind
       FROM device_tokens
       WHERE kind = 'system'
       ORDER BY created_at ASC
       LIMIT 1`,
    )
    .get() as { id: string; label: string; createdAt: number; lastUsedAt: number | null; revoked: number; kind: string } | undefined
  if (!row) return null
  return {
    id: row.id,
    label: row.label,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    revoked: row.revoked !== 0,
    kind: 'system',
  }
}
