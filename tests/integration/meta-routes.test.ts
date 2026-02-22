import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildTestApp, createMockPool } from './setup.js'
import { makeUsersTable, makeCompositePkTable, makeDatabaseSchema } from '../fixtures/tables.js'

describe('Meta Routes', () => {
  let app: FastifyInstance
  const users = makeUsersTable()
  const compositePk = makeCompositePkTable()
  const dbSchema = makeDatabaseSchema([users, compositePk])

  beforeAll(async () => {
    app = await buildTestApp({ dbSchema, pool: createMockPool() as any })
  })

  afterAll(async () => {
    await app.close()
  })

  describe('GET /api/_meta/tables', () => {
    it('returns list of all tables with count', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/_meta/tables' })
      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.count).toBe(2)
      expect(body.tables).toHaveLength(2)
    })

    it('includes table metadata', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/_meta/tables' })
      const body = res.json()
      const usersTable = body.tables.find((t: any) => t.table === 'users')
      expect(usersTable).toBeDefined()
      expect(usersTable.schema).toBe('public')
      expect(usersTable.path).toBe('/api/users')
      expect(usersTable.primaryKeys).toEqual(['id'])
      expect(usersTable.columnCount).toBe(4)
    })

    it('includes foreign key info', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/_meta/tables' })
      const body = res.json()
      const rolesTable = body.tables.find((t: any) => t.table === 'user_roles')
      expect(rolesTable.foreignKeys).toHaveLength(1)
      expect(rolesTable.foreignKeys[0].column).toBe('user_id')
    })
  })

  describe('GET /api/_meta/tables/:table', () => {
    it('returns specific table details', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/_meta/tables/users' })
      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.table).toBe('users')
      expect(body.schema).toBe('public')
      expect(body.columns).toHaveLength(4)
      expect(body.primaryKeys).toEqual(['id'])
    })

    it('returns 404 for non-existent table', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/_meta/tables/nonexistent' })
      expect(res.statusCode).toBe(404)
      expect(res.json().error).toContain('not found')
    })

    it('includes column details', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/_meta/tables/users' })
      const body = res.json()
      const idCol = body.columns.find((c: any) => c.name === 'id')
      expect(idCol.isPrimaryKey).toBe(true)
      expect(idCol.hasDefault).toBe(true)
    })
  })
})
