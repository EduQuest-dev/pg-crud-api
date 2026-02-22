import { describe, it, expect } from 'vitest'
import {
  generateApiKey,
  verifyApiKey,
  hasPermission,
  hasAnyPermission,
  validatePermissions,
  parsePermissionsString,
} from '../../src/auth/api-key.js'

const SECRET = 'test-secret-value'

describe('generateApiKey', () => {
  it('produces key with pgcrud_ prefix', () => {
    const key = generateApiKey('admin', SECRET)
    expect(key).toMatch(/^pgcrud_/)
  })

  it('produces key in format pgcrud_{label}.{64-hex}', () => {
    const key = generateApiKey('admin', SECRET)
    expect(key).toMatch(/^pgcrud_admin\.[0-9a-f]{64}$/)
  })

  it('is deterministic (same label + secret = same key)', () => {
    const key1 = generateApiKey('admin', SECRET)
    const key2 = generateApiKey('admin', SECRET)
    expect(key1).toBe(key2)
  })

  it('produces different keys for different labels', () => {
    const key1 = generateApiKey('admin', SECRET)
    const key2 = generateApiKey('service', SECRET)
    expect(key1).not.toBe(key2)
  })

  it('produces different keys for different secrets', () => {
    const key1 = generateApiKey('admin', 'secret-a')
    const key2 = generateApiKey('admin', 'secret-b')
    expect(key1).not.toBe(key2)
  })

  it('accepts labels with alphanumeric, hyphens, underscores', () => {
    expect(() => generateApiKey('my-service_v2', SECRET)).not.toThrow()
  })

  it('rejects label with spaces', () => {
    expect(() => generateApiKey('has spaces', SECRET)).toThrow()
  })

  it('rejects label with dots', () => {
    expect(() => generateApiKey('has.dot', SECRET)).toThrow()
  })

  it('rejects label with special characters', () => {
    expect(() => generateApiKey('user@org', SECRET)).toThrow()
  })

  it('rejects empty label', () => {
    expect(() => generateApiKey('', SECRET)).toThrow()
  })

  // ── With permissions ──
  it('produces key with permissions embedded', () => {
    const key = generateApiKey('reader', SECRET, { public: 'r' })
    expect(key).toMatch(/^pgcrud_reader:.+\.[0-9a-f]{64}$/)
  })

  it('is deterministic with same permissions', () => {
    const perms = { public: 'rw' as const, reporting: 'r' as const }
    const key1 = generateApiKey('svc', SECRET, perms)
    const key2 = generateApiKey('svc', SECRET, perms)
    expect(key1).toBe(key2)
  })

  it('produces different keys for different permissions', () => {
    const key1 = generateApiKey('svc', SECRET, { public: 'r' })
    const key2 = generateApiKey('svc', SECRET, { public: 'rw' })
    expect(key1).not.toBe(key2)
  })

  it('produces different key from one without permissions', () => {
    const key1 = generateApiKey('admin', SECRET)
    const key2 = generateApiKey('admin', SECRET, { '*': 'rw' })
    expect(key1).not.toBe(key2)
  })

  it('rejects invalid permission value', () => {
    expect(() => generateApiKey('svc', SECRET, { public: 'x' as any })).toThrow(/Invalid permission/)
  })

  it('rejects empty permissions object', () => {
    expect(() => generateApiKey('svc', SECRET, {})).toThrow(/at least one schema/)
  })

  it('rejects empty schema name in permissions', () => {
    expect(() => generateApiKey('svc', SECRET, { '': 'r' })).toThrow(/must not be empty/)
  })
})

describe('verifyApiKey', () => {
  it('validates a correctly generated key', () => {
    const key = generateApiKey('myservice', SECRET)
    const result = verifyApiKey(key, SECRET)
    expect(result).toEqual({ valid: true, label: 'myservice', permissions: null })
  })

  it('roundtrips with various labels', () => {
    for (const label of ['admin', 'service-a', 'worker_1', 'A']) {
      const key = generateApiKey(label, SECRET)
      expect(verifyApiKey(key, SECRET)).toEqual({ valid: true, label, permissions: null })
    }
  })

  it('rejects key with wrong secret', () => {
    const key = generateApiKey('admin', SECRET)
    expect(verifyApiKey(key, 'wrong-secret')).toEqual({ valid: false })
  })

  it('rejects tampered HMAC', () => {
    const key = generateApiKey('admin', SECRET)
    const tampered = key.slice(0, -4) + '0000'
    expect(verifyApiKey(tampered, SECRET)).toEqual({ valid: false })
  })

  it('rejects key without pgcrud_ prefix', () => {
    expect(verifyApiKey('admin.abc123def456', SECRET)).toEqual({ valid: false })
  })

  it('rejects empty string', () => {
    expect(verifyApiKey('', SECRET)).toEqual({ valid: false })
  })

  it('rejects key with no dot separator', () => {
    expect(verifyApiKey('pgcrud_adminnodot', SECRET)).toEqual({ valid: false })
  })

  it('rejects key with dot at start (empty label)', () => {
    expect(verifyApiKey('pgcrud_.abcdef1234567890', SECRET)).toEqual({ valid: false })
  })

  it('rejects key with invalid label characters', () => {
    expect(verifyApiKey('pgcrud_bad label.abcdef', SECRET)).toEqual({ valid: false })
  })

  it('rejects key with invalid label characters in permissions format', () => {
    const encoded = Buffer.from(JSON.stringify({ public: 'r' }), 'utf8').toString('base64url')
    expect(verifyApiKey(`pgcrud_bad label:${encoded}.abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890`, SECRET)).toEqual({ valid: false })
  })

  it('rejects key with truncated HMAC (wrong buffer length)', () => {
    const key = generateApiKey('admin', SECRET)
    const truncated = key.slice(0, key.indexOf('.') + 5) // only 4 hex chars
    expect(verifyApiKey(truncated, SECRET)).toEqual({ valid: false })
  })

  // ── With permissions ──
  it('roundtrips key with permissions', () => {
    const perms = { public: 'rw' as const, reporting: 'r' as const }
    const key = generateApiKey('svc', SECRET, perms)
    const result = verifyApiKey(key, SECRET)
    expect(result).toEqual({ valid: true, label: 'svc', permissions: perms })
  })

  it('returns null permissions for legacy key (no permissions)', () => {
    const key = generateApiKey('admin', SECRET)
    const result = verifyApiKey(key, SECRET)
    expect(result.permissions).toBeNull()
  })

  it('roundtrips wildcard permissions', () => {
    const perms = { '*': 'rw' as const }
    const key = generateApiKey('full', SECRET, perms)
    const result = verifyApiKey(key, SECRET)
    expect(result).toEqual({ valid: true, label: 'full', permissions: perms })
  })

  it('rejects key with tampered permissions', () => {
    const key = generateApiKey('svc', SECRET, { public: 'r' })
    // Change the base64url part between : and .
    const colonIdx = key.indexOf(':')
    const dotIdx = key.lastIndexOf('.')
    const tampered = key.slice(0, colonIdx + 1) +
      Buffer.from(JSON.stringify({ public: 'rw' }), 'utf8').toString('base64url') +
      key.slice(dotIdx)
    expect(verifyApiKey(tampered, SECRET)).toEqual({ valid: false })
  })

  it('rejects key with empty permissions section (colon but no data)', () => {
    // Manually craft: pgcrud_label:.{hmac}
    expect(verifyApiKey('pgcrud_label:.abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890', SECRET)).toEqual({ valid: false })
  })

  it('rejects key with invalid base64 in permissions', () => {
    expect(verifyApiKey('pgcrud_label:!!!invalid!!!.abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890', SECRET)).toEqual({ valid: false })
  })

  it('rejects key with non-object permissions (array)', () => {
    const encoded = Buffer.from(JSON.stringify(['r', 'w']), 'utf8').toString('base64url')
    const data = `label:${encoded}`
    const hmac = require('node:crypto').createHmac('sha256', SECRET).update(data).digest('hex')
    expect(verifyApiKey(`pgcrud_${data}.${hmac}`, SECRET)).toEqual({ valid: false })
  })

  it('rejects key with invalid permission value in payload', () => {
    const encoded = Buffer.from(JSON.stringify({ public: 'x' }), 'utf8').toString('base64url')
    const data = `label:${encoded}`
    const hmac = require('node:crypto').createHmac('sha256', SECRET).update(data).digest('hex')
    expect(verifyApiKey(`pgcrud_${data}.${hmac}`, SECRET)).toEqual({ valid: false })
  })

  it('rejects permission stripping attack (removing permissions to get full access)', () => {
    // Attacker has a scoped key: pgcrud_svc:{perms}.{hmac}
    // They try to strip permissions to make a legacy key: pgcrud_svc.{hmac}
    const scopedKey = generateApiKey('svc', SECRET, { public: 'r' })
    const dotIdx = scopedKey.lastIndexOf('.')
    const hmac = scopedKey.slice(dotIdx + 1)
    // Attempt 1: reuse the same HMAC with just the label
    const stripped = `pgcrud_svc.${hmac}`
    expect(verifyApiKey(stripped, SECRET)).toEqual({ valid: false })
  })

  it('rejects permission escalation (adding schemas not in original key)', () => {
    // Attacker has key for public:r, tries to add reporting:rw
    const key = generateApiKey('svc', SECRET, { public: 'r' })
    const colonIdx = key.indexOf(':')
    const dotIdx = key.lastIndexOf('.')
    const escalated = key.slice(0, colonIdx + 1) +
      Buffer.from(JSON.stringify({ public: 'r', reporting: 'rw' }), 'utf8').toString('base64url') +
      key.slice(dotIdx)
    expect(verifyApiKey(escalated, SECRET)).toEqual({ valid: false })
  })

  it('rejects permission upgrade attack (r → rw)', () => {
    const key = generateApiKey('svc', SECRET, { public: 'r' })
    const colonIdx = key.indexOf(':')
    const dotIdx = key.lastIndexOf('.')
    const upgraded = key.slice(0, colonIdx + 1) +
      Buffer.from(JSON.stringify({ public: 'rw' }), 'utf8').toString('base64url') +
      key.slice(dotIdx)
    expect(verifyApiKey(upgraded, SECRET)).toEqual({ valid: false })
  })

  it('cannot forge a valid key without the secret', () => {
    // Attacker crafts a key with their own HMAC using a guessed secret
    const { createHmac } = require('node:crypto')
    const data = 'admin'
    const fakeHmac = createHmac('sha256', 'wrong-secret').update(data).digest('hex')
    expect(verifyApiKey(`pgcrud_${data}.${fakeHmac}`, SECRET)).toEqual({ valid: false })
  })

  it('cannot forge a scoped key without the secret', () => {
    const { createHmac } = require('node:crypto')
    const perms = Buffer.from(JSON.stringify({ '*': 'rw' }), 'utf8').toString('base64url')
    const data = `admin:${perms}`
    const fakeHmac = createHmac('sha256', 'wrong-secret').update(data).digest('hex')
    expect(verifyApiKey(`pgcrud_${data}.${fakeHmac}`, SECRET)).toEqual({ valid: false })
  })

  it('rejects key with empty HMAC after dot', () => {
    expect(verifyApiKey('pgcrud_admin.', SECRET)).toEqual({ valid: false })
  })
})

describe('hasPermission', () => {
  it('returns true for null permissions (full access)', () => {
    expect(hasPermission(null, 'public', 'r')).toBe(true)
    expect(hasPermission(null, 'public', 'w')).toBe(true)
  })

  it('returns true for undefined permissions (auth disabled)', () => {
    expect(hasPermission(undefined, 'public', 'r')).toBe(true)
    expect(hasPermission(undefined, 'public', 'w')).toBe(true)
  })

  it("grants read when permission is 'r'", () => {
    expect(hasPermission({ public: 'r' }, 'public', 'r')).toBe(true)
  })

  it("denies write when permission is 'r'", () => {
    expect(hasPermission({ public: 'r' }, 'public', 'w')).toBe(false)
  })

  it("grants write when permission is 'w'", () => {
    expect(hasPermission({ public: 'w' }, 'public', 'w')).toBe(true)
  })

  it("denies read when permission is 'w'", () => {
    expect(hasPermission({ public: 'w' }, 'public', 'r')).toBe(false)
  })

  it("grants both read and write when permission is 'rw'", () => {
    expect(hasPermission({ public: 'rw' }, 'public', 'r')).toBe(true)
    expect(hasPermission({ public: 'rw' }, 'public', 'w')).toBe(true)
  })

  it('denies access to unlisted schema', () => {
    expect(hasPermission({ public: 'rw' }, 'reporting', 'r')).toBe(false)
  })

  it("uses wildcard '*' for unlisted schemas", () => {
    expect(hasPermission({ '*': 'r' }, 'anything', 'r')).toBe(true)
    expect(hasPermission({ '*': 'r' }, 'anything', 'w')).toBe(false)
  })

  it('prefers specific schema over wildcard', () => {
    const perms = { public: 'r' as const, '*': 'rw' as const }
    expect(hasPermission(perms, 'public', 'r')).toBe(true)
    expect(hasPermission(perms, 'public', 'w')).toBe(false)
    expect(hasPermission(perms, 'other', 'w')).toBe(true)
  })
})

describe('hasAnyPermission', () => {
  it('returns true for null permissions', () => {
    expect(hasAnyPermission(null, 'public')).toBe(true)
  })

  it('returns true for undefined permissions', () => {
    expect(hasAnyPermission(undefined, 'public')).toBe(true)
  })

  it('returns true for schema with any access', () => {
    expect(hasAnyPermission({ public: 'r' }, 'public')).toBe(true)
    expect(hasAnyPermission({ public: 'w' }, 'public')).toBe(true)
    expect(hasAnyPermission({ public: 'rw' }, 'public')).toBe(true)
  })

  it('returns false for unlisted schema', () => {
    expect(hasAnyPermission({ public: 'rw' }, 'reporting')).toBe(false)
  })

  it('uses wildcard for unlisted schemas', () => {
    expect(hasAnyPermission({ '*': 'r' }, 'anything')).toBe(true)
  })
})

describe('validatePermissions', () => {
  it('accepts valid permissions', () => {
    expect(() => validatePermissions({ public: 'rw', reporting: 'r' })).not.toThrow()
  })

  it('rejects empty object', () => {
    expect(() => validatePermissions({})).toThrow(/at least one/)
  })

  it('rejects invalid permission value', () => {
    expect(() => validatePermissions({ public: 'x' as any })).toThrow(/Invalid permission/)
  })

  it('rejects empty schema name', () => {
    expect(() => validatePermissions({ '': 'r' })).toThrow(/must not be empty/)
  })

  it('rejects whitespace-only schema name', () => {
    expect(() => validatePermissions({ '  ': 'r' })).toThrow(/must not be empty/)
  })
})

describe('parsePermissionsString', () => {
  it('parses single schema:permission pair', () => {
    expect(parsePermissionsString('public:rw')).toEqual({ public: 'rw' })
  })

  it('parses multiple schema:permission pairs', () => {
    expect(parsePermissionsString('public:rw,reporting:r')).toEqual({ public: 'rw', reporting: 'r' })
  })

  it('trims whitespace', () => {
    expect(parsePermissionsString(' public : rw , reporting : r ')).toEqual({ public: 'rw', reporting: 'r' })
  })

  it('accepts wildcard schema', () => {
    expect(parsePermissionsString('*:rw')).toEqual({ '*': 'rw' })
  })

  it('rejects invalid permission value', () => {
    expect(() => parsePermissionsString('public:x')).toThrow(/Invalid permission/)
  })

  it('rejects missing colon', () => {
    expect(() => parsePermissionsString('publicrw')).toThrow(/Invalid permission format/)
  })

  it('rejects empty input', () => {
    expect(() => parsePermissionsString('')).toThrow(/No permissions/)
  })

  it('handles schema name containing colon (uses last colon)', () => {
    // e.g., "my:schema:rw" → schema="my:schema", perm="rw"
    expect(parsePermissionsString('my:schema:rw')).toEqual({ 'my:schema': 'rw' })
  })
})
