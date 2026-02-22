import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildTestApp, createMockPool } from './setup.js'
import { makeUsersTable, makeNonPublicSchemaTable, makeDatabaseSchema } from '../fixtures/tables.js'
import { generateApiKey } from '../../src/auth/api-key.js'

const SECRET = 'test-auth-secret'

describe('Auth Hook Integration', () => {
  let app: FastifyInstance
  let mockPool: ReturnType<typeof createMockPool>

  beforeAll(async () => {
    mockPool = createMockPool()
    app = await buildTestApp({
      dbSchema: makeDatabaseSchema([makeUsersTable()]),
      pool: mockPool as any,
      authEnabled: true,
      authSecret: SECRET,
    })
  })

  afterAll(async () => {
    await app.close()
  })

  it('rejects unauthenticated requests with 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/users' })
    expect(res.statusCode).toBe(401)
    expect(res.json().error).toBe('Unauthorized')
  })

  it('allows requests with valid Bearer token', async () => {
    const key = generateApiKey('test', SECRET);
    (mockPool.query as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ total: '0' }], rowCount: 1 })

    const res = await app.inject({
      method: 'GET',
      url: '/api/users',
      headers: { authorization: `Bearer ${key}` },
    })
    expect(res.statusCode).toBe(200)
  })

  it('allows requests with valid X-API-Key header', async () => {
    const key = generateApiKey('test', SECRET);
    (mockPool.query as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ total: '0' }], rowCount: 1 })

    const res = await app.inject({
      method: 'GET',
      url: '/api/users',
      headers: { 'x-api-key': key },
    })
    expect(res.statusCode).toBe(200)
  })

  it('rejects requests with invalid key', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/users',
      headers: { authorization: 'Bearer pgcrud_fake.invalidhmac' },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json().message).toContain('Invalid API key')
  })

  it('allows health check without auth', async () => {
    (mockPool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [{ '?column?': 1 }], rowCount: 1 })

    const res = await app.inject({ method: 'GET', url: '/api/_health' })
    expect(res.statusCode).not.toBe(401)
  })

  it('allows /docs path without auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/docs' })
    // Will be 404 since swagger isn't registered, but NOT 401
    expect(res.statusCode).not.toBe(401)
  })

  it('allows /docs/json path without auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/docs/json' })
    expect(res.statusCode).not.toBe(401)
  })

  it('rejects request with missing key (only header, no value)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/users',
      headers: { authorization: 'Bearer ' },
    })
    expect(res.statusCode).toBe(401)
  })
})

describe('Auth Hook - Schema Permissions', () => {
  let app: FastifyInstance
  let mockPool: ReturnType<typeof createMockPool>

  beforeAll(async () => {
    mockPool = createMockPool()
    app = await buildTestApp({
      dbSchema: makeDatabaseSchema([makeUsersTable(), makeNonPublicSchemaTable()]),
      pool: mockPool as any,
      authEnabled: true,
      authSecret: SECRET,
    })
  })

  afterAll(async () => {
    await app.close()
  })

  it('allows read with read-only key', async () => {
    const key = generateApiKey('reader', SECRET, { public: 'r' });
    (mockPool.query as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ total: '0' }], rowCount: 1 })

    const res = await app.inject({
      method: 'GET',
      url: '/api/users',
      headers: { authorization: `Bearer ${key}` },
    })
    expect(res.statusCode).toBe(200)
  })

  it('denies write with read-only key (403)', async () => {
    const key = generateApiKey('reader', SECRET, { public: 'r' })

    const res = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { authorization: `Bearer ${key}` },
      payload: { name: 'Alice', email: 'alice@test.com' },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().error).toBe('Forbidden')
  })

  it('denies read for schema not in permissions (403)', async () => {
    const key = generateApiKey('public-only', SECRET, { public: 'rw' })

    const res = await app.inject({
      method: 'GET',
      url: '/api/reporting__metrics',
      headers: { authorization: `Bearer ${key}` },
    })
    expect(res.statusCode).toBe(403)
  })

  it('allows access with wildcard permissions', async () => {
    const key = generateApiKey('full', SECRET, { '*': 'rw' });
    (mockPool.query as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ total: '0' }], rowCount: 1 })

    const res = await app.inject({
      method: 'GET',
      url: '/api/reporting__metrics',
      headers: { authorization: `Bearer ${key}` },
    })
    expect(res.statusCode).toBe(200)
  })

  it('legacy key (no permissions) has full access', async () => {
    const key = generateApiKey('admin', SECRET);
    (mockPool.query as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ rows: [{ id: 1, metric_name: 'test', value: 42 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ total: '1' }], rowCount: 1 })

    const res = await app.inject({
      method: 'GET',
      url: '/api/reporting__metrics',
      headers: { authorization: `Bearer ${key}` },
    })
    expect(res.statusCode).toBe(200)
  })

  it('filters meta tables by schema permissions', async () => {
    const key = generateApiKey('public-only', SECRET, { public: 'rw' })

    const res = await app.inject({
      method: 'GET',
      url: '/api/_meta/tables',
      headers: { authorization: `Bearer ${key}` },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    // Should only see 'public' schema tables, not 'reporting'
    expect(body.tables.every((t: any) => t.schema === 'public')).toBe(true)
    expect(body.count).toBe(1)
  })

  it('filters schema endpoint by permissions', async () => {
    const key = generateApiKey('public-only', SECRET, { public: 'r' })

    const res = await app.inject({
      method: 'GET',
      url: '/api/_schema',
      headers: { authorization: `Bearer ${key}` },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.tables.every((t: any) => t.schema === 'public')).toBe(true)
  })

  it('returns 404 for schema/:table when key lacks permission', async () => {
    const key = generateApiKey('public-only', SECRET, { public: 'r' })

    const res = await app.inject({
      method: 'GET',
      url: '/api/_schema/reporting__metrics',
      headers: { authorization: `Bearer ${key}` },
    })
    expect(res.statusCode).toBe(404)
  })

  it('returns 404 for meta table detail when key lacks permission', async () => {
    const key = generateApiKey('public-only', SECRET, { public: 'r' })

    const res = await app.inject({
      method: 'GET',
      url: '/api/_meta/tables/reporting__metrics',
      headers: { authorization: `Bearer ${key}` },
    })
    expect(res.statusCode).toBe(404)
  })

  it('write-only key allows POST but denies GET', async () => {
    const key = generateApiKey('writer', SECRET, { public: 'w' })

    // GET should be denied
    const getRes = await app.inject({
      method: 'GET',
      url: '/api/users',
      headers: { authorization: `Bearer ${key}` },
    })
    expect(getRes.statusCode).toBe(403);

    // POST should be allowed
    (mockPool.query as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ rows: [{ id: 1, name: 'Alice', email: 'a@b.com', active: true }], rowCount: 1 })

    const postRes = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { authorization: `Bearer ${key}` },
      payload: { name: 'Alice', email: 'a@b.com' },
    })
    expect(postRes.statusCode).toBe(201)
  })

  it('denies PUT with read-only key', async () => {
    const key = generateApiKey('reader', SECRET, { public: 'r' })

    const res = await app.inject({
      method: 'PUT',
      url: '/api/users/1',
      headers: { authorization: `Bearer ${key}` },
      payload: { name: 'Updated', email: 'u@b.com', active: true },
    })
    expect(res.statusCode).toBe(403)
  })

  it('denies PATCH with read-only key', async () => {
    const key = generateApiKey('reader', SECRET, { public: 'r' })

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/users/1',
      headers: { authorization: `Bearer ${key}` },
      payload: { name: 'Updated' },
    })
    expect(res.statusCode).toBe(403)
  })

  it('denies DELETE with read-only key', async () => {
    const key = generateApiKey('reader', SECRET, { public: 'r' })

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/users/1',
      headers: { authorization: `Bearer ${key}` },
    })
    expect(res.statusCode).toBe(403)
  })

  it('allows GET by PK with read permission', async () => {
    const key = generateApiKey('reader', SECRET, { public: 'r' });
    (mockPool.query as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ rows: [{ id: 1, name: 'Alice', email: 'a@b.com', active: true }], rowCount: 1 })

    const res = await app.inject({
      method: 'GET',
      url: '/api/users/1',
      headers: { authorization: `Bearer ${key}` },
    })
    expect(res.statusCode).toBe(200)
  })

  it('denies GET by PK with write-only key', async () => {
    const key = generateApiKey('writer', SECRET, { public: 'w' })

    const res = await app.inject({
      method: 'GET',
      url: '/api/users/1',
      headers: { authorization: `Bearer ${key}` },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().error).toBe('Forbidden')
  })
})
