import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildTestApp, createMockPool } from './setup.js'
import { makeUsersTable, makeNoPkTable, makeTableWithNonPublicFk, makeDatabaseSchema } from '../fixtures/tables.js'

describe('Schema Routes', () => {
  let app: FastifyInstance
  const users = makeUsersTable()
  const noPk = makeNoPkTable()
  const dbSchema = makeDatabaseSchema([users, noPk])

  beforeAll(async () => {
    app = await buildTestApp({ dbSchema, pool: createMockPool() as any })
  })

  afterAll(async () => {
    await app.close()
  })

  describe('GET /api/_schema', () => {
    it('returns full schema with api and tables keys', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/_schema' })
      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body).toHaveProperty('api')
      expect(body).toHaveProperty('tables')
      expect(body.tables).toHaveLength(2)
    })

    it('includes api info with pagination config', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/_schema' })
      const body = res.json()
      expect(body.api.baseUrl).toBe('/api')
      expect(body.api.pagination).toBeDefined()
      expect(body.api.filtering.operators).toContain('eq')
    })

    it('includes correct operations for table with PK', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/_schema' })
      const body = res.json()
      const usersTable = body.tables.find((t: any) => t.name === 'users')
      expect(usersTable.operations).toEqual(['list', 'create', 'read', 'update', 'replace', 'delete'])
    })

    it('includes only list and create for table without PK', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/_schema' })
      const body = res.json()
      const auditTable = body.tables.find((t: any) => t.name === 'audit_logs')
      expect(auditTable.operations).toEqual(['list', 'create'])
    })
  })

  describe('GET /api/_schema/:table', () => {
    it('returns schema for specific table', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/_schema/users' })
      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body).toHaveProperty('api')
      expect(body).toHaveProperty('table')
      expect(body.table.name).toBe('users')
    })

    it('returns 404 for non-existent table', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/_schema/nonexistent' })
      expect(res.statusCode).toBe(404)
      expect(res.json().error).toContain('not found')
    })

    it('includes column details in table schema', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/_schema/users' })
      const body = res.json()
      expect(body.table.columns).toHaveLength(4)
      const nameCol = body.table.columns.find((c: any) => c.name === 'name')
      expect(nameCol.type).toBe('string')
      expect(nameCol.insertRequired).toBe(true)
    })
  })
})

describe('Schema Routes - Non-public FK ref', () => {
  let app: FastifyInstance
  const reports = makeTableWithNonPublicFk()
  const dbSchema = makeDatabaseSchema([reports])

  beforeAll(async () => {
    app = await buildTestApp({ dbSchema, pool: createMockPool() as any })
  })

  afterAll(async () => {
    await app.close()
  })

  it('generates refPath with schema__table for non-public FK references', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/_schema/reports' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    const fk = body.table.foreignKeys[0]
    expect(fk.refPath).toBe('/api/reporting__metrics')
  })
})
