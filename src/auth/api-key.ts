import { createHmac, timingSafeEqual } from 'node:crypto'
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'

// ─── Schema Permissions ───────────────────────────────────────────────

/** Per-schema access: "r" (read), "w" (write), or "rw" (both). Use "*" key for all schemas. */
export type SchemaPermission = 'r' | 'w' | 'rw'
export type SchemaPermissions = Record<string, SchemaPermission>

declare module 'fastify' {
  interface FastifyRequest {
    apiKeyLabel?: string;
    /** null = full access (legacy key). undefined = auth disabled. */
    apiKeyPermissions?: SchemaPermissions | null;
  }
}

const KEY_PREFIX = 'pgcrud_'
const LABEL_PATTERN = /^[a-zA-Z0-9_-]+$/
const VALID_PERMISSIONS = new Set(['r', 'w', 'rw'])

const PUBLIC_PATHS = ['/api/_health', '/docs']

function isPublicPath (url: string): boolean {
  // Strip query string for matching
  const path = url.split('?')[0]
  return PUBLIC_PATHS.some((p) => path === p || path.startsWith(p + '/'))
}

// ─── Base64url helpers (no padding) ───────────────────────────────────

function toBase64url (str: string): string {
  return Buffer.from(str, 'utf8').toString('base64url')
}

function fromBase64url (b64: string): string {
  return Buffer.from(b64, 'base64url').toString('utf8')
}

// ─── Permissions validation ───────────────────────────────────────────

export function validatePermissions (permissions: SchemaPermissions): void {
  const entries = Object.entries(permissions)
  if (entries.length === 0) {
    throw new Error('Permissions must contain at least one schema entry')
  }
  for (const [schema, perm] of entries) {
    if (!schema || schema.trim() === '') {
      throw new Error('Schema name must not be empty')
    }
    if (!VALID_PERMISSIONS.has(perm)) {
      throw new Error(`Invalid permission "${perm}" for schema "${schema}". Must be "r", "w", or "rw"`)
    }
  }
}

// ─── Key Generation ──────────────────────────────────────────────────

/**
 * Generate an API key, optionally embedding schema permissions.
 *
 * - Without permissions: `pgcrud_{label}.{hmac}` (full access)
 * - With permissions:    `pgcrud_{label}:{base64url_json}.{hmac}`
 *
 * The HMAC covers the full data portion, making permissions tamper-proof.
 */
export function generateApiKey (label: string, secret: string, permissions?: SchemaPermissions): string {
  if (!LABEL_PATTERN.test(label)) {
    throw new Error('Label must contain only alphanumeric characters, hyphens, and underscores')
  }

  let data: string = label
  if (permissions) {
    validatePermissions(permissions)
    const encoded = toBase64url(JSON.stringify(permissions))
    data = `${label}:${encoded}`
  }

  const hmac = createHmac('sha256', secret).update(data).digest('hex')
  return `${KEY_PREFIX}${data}.${hmac}`
}

// ─── Key Verification ────────────────────────────────────────────────

export interface VerifyResult {
  valid: boolean;
  label?: string;
  /** null = full access (legacy key without permissions). Only set when valid. */
  permissions?: SchemaPermissions | null;
}

interface ParsedKeyData {
  label: string;
  permissions: SchemaPermissions | null;
}

/**
 * Parse the data portion of a key into label + optional permissions.
 * Returns null if the data is malformed.
 */
function parseKeyData (data: string): ParsedKeyData | null {
  const colonIndex = data.indexOf(':')

  if (colonIndex <= 0) {
    // Legacy format: label only (full access)
    return LABEL_PATTERN.test(data) ? { label: data, permissions: null } : null
  }

  // New format: label:base64url_permissions
  const label = data.slice(0, colonIndex)
  if (!LABEL_PATTERN.test(label)) return null

  const permEncoded = data.slice(colonIndex + 1)
  if (permEncoded.length === 0) return null

  try {
    const parsed = JSON.parse(fromBase64url(permEncoded))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null
    }
    for (const val of Object.values(parsed)) {
      if (!VALID_PERMISSIONS.has(val as string)) return null
    }
    return { label, permissions: parsed as SchemaPermissions }
  } catch {
    return null
  }
}

function verifyHmac (data: string, providedHmac: string, secret: string): boolean {
  const expectedHmac = createHmac('sha256', secret).update(data).digest('hex')
  const providedBuffer = Buffer.from(providedHmac, 'hex')
  const expectedBuffer = Buffer.from(expectedHmac, 'hex')

  if (providedBuffer.length !== expectedBuffer.length) return false
  return timingSafeEqual(providedBuffer, expectedBuffer)
}

export function verifyApiKey (key: string, secret: string): VerifyResult {
  if (!key.startsWith(KEY_PREFIX)) {
    return { valid: false }
  }

  const withoutPrefix = key.slice(KEY_PREFIX.length)
  const dotIndex = withoutPrefix.lastIndexOf('.')
  if (dotIndex <= 0) {
    return { valid: false }
  }

  const data = withoutPrefix.slice(0, dotIndex)
  const providedHmac = withoutPrefix.slice(dotIndex + 1)

  if (providedHmac.length === 0) {
    return { valid: false }
  }

  const parsed = parseKeyData(data)
  if (!parsed) {
    return { valid: false }
  }

  if (!verifyHmac(data, providedHmac, secret)) {
    return { valid: false }
  }

  return { valid: true, label: parsed.label, permissions: parsed.permissions }
}

// ─── Permission Checking ─────────────────────────────────────────────

/**
 * Check if a permissions set grants the requested access on a schema.
 * - null/undefined permissions = full access (legacy key or auth disabled)
 * - "*" key = wildcard for all schemas
 */
export function hasPermission (
  permissions: SchemaPermissions | null | undefined,
  schema: string,
  access: 'r' | 'w'
): boolean {
  if (permissions === null || permissions === undefined) return true
  const perm = permissions[schema] ?? permissions['*']
  if (!perm) return false
  return perm === 'rw' || perm === access
}

/**
 * Check if a permissions set grants any access (read or write) on a schema.
 */
export function hasAnyPermission (
  permissions: SchemaPermissions | null | undefined,
  schema: string
): boolean {
  if (permissions === null || permissions === undefined) return true
  const perm = permissions[schema] ?? permissions['*']
  return !!perm
}

// ─── Parse permissions string ────────────────────────────────────────

/**
 * Parse a CLI permissions string like "public:rw,reporting:r" into SchemaPermissions.
 */
export function parsePermissionsString (input: string): SchemaPermissions {
  const result: SchemaPermissions = {}
  const pairs = input.split(',').map((s) => s.trim()).filter(Boolean)
  for (const pair of pairs) {
    const colonIdx = pair.lastIndexOf(':')
    if (colonIdx <= 0) {
      throw new Error(`Invalid permission format "${pair}". Expected "schema:permission" (e.g., "public:rw")`)
    }
    const schema = pair.slice(0, colonIdx).trim()
    const perm = pair.slice(colonIdx + 1).trim()
    if (!VALID_PERMISSIONS.has(perm)) {
      throw new Error(`Invalid permission "${perm}" for schema "${schema}". Must be "r", "w", or "rw"`)
    }
    result[schema] = perm as SchemaPermission
  }
  if (Object.keys(result).length === 0) {
    throw new Error('No permissions specified')
  }
  return result
}

// ─── Auth Hook ───────────────────────────────────────────────────────

export function extractApiKey (request: FastifyRequest): string | null {
  const authHeader = request.headers.authorization
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7).trim()
  }

  const apiKeyHeader = request.headers['x-api-key']
  if (typeof apiKeyHeader === 'string' && apiKeyHeader.length > 0) {
    return apiKeyHeader.trim()
  }

  return null
}

export function registerAuthHook (app: FastifyInstance, secret: string): void {
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    if (isPublicPath(request.url)) {
      return
    }

    const key = extractApiKey(request)
    if (!key) {
      reply.status(401).send({
        error: 'Unauthorized',
        message: 'API key required. Provide via Authorization: Bearer <key> or X-API-Key header.',
      })
      return
    }

    const result = verifyApiKey(key, secret)
    if (!result.valid) {
      reply.status(401).send({
        error: 'Unauthorized',
        message: 'Invalid API key.',
      })
      return
    }

    request.apiKeyLabel = result.label
    request.apiKeyPermissions = result.permissions
  })
}
