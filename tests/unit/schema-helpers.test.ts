import { describe, it, expect, vi } from 'vitest'

import { mapPgType, buildAgentColumn, buildAgentTable, buildApiInfo } from '../../src/routes/schema.js'
import { config } from '../../src/config.js'
import { makeColumn, makeUsersTable, makeNoPkTable, makeTableWithForeignKeys, makeNonPublicSchemaTable } from '../fixtures/tables.js'

vi.mock('../../src/config.js', () => ({
  config: {
    apiKeysEnabled: true,
    defaultPageSize: 50,
    maxPageSize: 1000,
    maxBulkInsertRows: 1000,
  },
}))

// ── mapPgType ───────────────────────────────────────────────────────

describe('mapPgType', () => {
  it.each([
    ['int2', 'integer'],
    ['int4', 'integer'],
    ['serial', 'integer'],
    ['int8', 'integer'],
    ['bigserial', 'integer'],
    ['oid', 'integer'],
  ])('maps %s to integer', (udtName, expectedType) => {
    expect(mapPgType(makeColumn({ udtName }))).toEqual({ type: expectedType })
  })

  it.each(['float4', 'float8', 'numeric', 'decimal', 'money'])(
    'maps %s to number',
    (udtName) => {
      expect(mapPgType(makeColumn({ udtName }))).toEqual({ type: 'number' })
    }
  )

  it('maps bool to boolean', () => {
    expect(mapPgType(makeColumn({ udtName: 'bool' }))).toEqual({ type: 'boolean' })
  })

  it.each(['json', 'jsonb'])('maps %s to object', (udtName) => {
    expect(mapPgType(makeColumn({ udtName }))).toEqual({ type: 'object' })
  })

  it('maps uuid to string with uuid format', () => {
    expect(mapPgType(makeColumn({ udtName: 'uuid' }))).toEqual({ type: 'string', format: 'uuid' })
  })

  it('maps date to string with date format', () => {
    expect(mapPgType(makeColumn({ udtName: 'date' }))).toEqual({ type: 'string', format: 'date' })
  })

  it.each(['timestamp', 'timestamptz'])('maps %s to date-time', (udtName) => {
    expect(mapPgType(makeColumn({ udtName }))).toEqual({ type: 'string', format: 'date-time' })
  })

  it.each(['time', 'timetz'])('maps %s to time', (udtName) => {
    expect(mapPgType(makeColumn({ udtName }))).toEqual({ type: 'string', format: 'time' })
  })

  it('maps bytea to string with byte format', () => {
    expect(mapPgType(makeColumn({ udtName: 'bytea' }))).toEqual({ type: 'string', format: 'byte' })
  })

  it.each(['_int2', '_int4', '_int8'])('maps %s to integer array', (udtName) => {
    expect(mapPgType(makeColumn({ udtName }))).toEqual({ type: 'array', items: { type: 'integer' } })
  })

  it.each(['_float4', '_float8', '_numeric'])('maps %s to number array', (udtName) => {
    expect(mapPgType(makeColumn({ udtName }))).toEqual({ type: 'array', items: { type: 'number' } })
  })

  it('maps _bool to boolean array', () => {
    expect(mapPgType(makeColumn({ udtName: '_bool' }))).toEqual({ type: 'array', items: { type: 'boolean' } })
  })

  it.each(['_text', '_varchar', '_char', '_name'])('maps %s to string array', (udtName) => {
    expect(mapPgType(makeColumn({ udtName }))).toEqual({ type: 'array', items: { type: 'string' } })
  })

  it('maps _uuid to uuid string array', () => {
    expect(mapPgType(makeColumn({ udtName: '_uuid' }))).toEqual({ type: 'array', items: { type: 'string', format: 'uuid' } })
  })

  it.each(['_json', '_jsonb'])('maps %s to object array', (udtName) => {
    expect(mapPgType(makeColumn({ udtName }))).toEqual({ type: 'array', items: { type: 'object' } })
  })

  it('maps unknown types to string', () => {
    expect(mapPgType(makeColumn({ udtName: 'xml' }))).toEqual({ type: 'string' })
  })
})

// ── buildAgentColumn ────────────────────────────────────────────────

describe('buildAgentColumn', () => {
  const users = makeUsersTable()

  it('sets pk flag for PK column', () => {
    const idCol = users.columns.find((c) => c.name === 'id')!
    const result = buildAgentColumn(idCol, users)
    expect(result.pk).toBe(true)
  })

  it('does not set pk flag for non-PK column', () => {
    const nameCol = users.columns.find((c) => c.name === 'name')!
    const result = buildAgentColumn(nameCol, users)
    expect(result.pk).toBeUndefined()
  })

  it('sets insertRequired for non-nullable no-default column', () => {
    const nameCol = users.columns.find((c) => c.name === 'name')!
    const result = buildAgentColumn(nameCol, users)
    expect(result.insertRequired).toBe(true)
  })

  it('does not set insertRequired for nullable column', () => {
    const activeCol = users.columns.find((c) => c.name === 'active')!
    const result = buildAgentColumn(activeCol, users)
    expect(result.insertRequired).toBeUndefined()
  })

  it('does not set insertRequired for column with default', () => {
    const idCol = users.columns.find((c) => c.name === 'id')!
    const result = buildAgentColumn(idCol, users)
    expect(result.insertRequired).toBeUndefined()
  })

  it('includes maxLength when present', () => {
    const nameCol = users.columns.find((c) => c.name === 'name')!
    const result = buildAgentColumn(nameCol, users)
    expect(result.maxLength).toBe(255)
  })

  it('does not include maxLength when null', () => {
    const idCol = users.columns.find((c) => c.name === 'id')!
    const result = buildAgentColumn(idCol, users)
    expect(result.maxLength).toBeUndefined()
  })

  it('includes format for typed columns', () => {
    const col = makeColumn({ udtName: 'uuid', name: 'external_id' })
    const table = { ...users, columns: [...users.columns, col] }
    const result = buildAgentColumn(col, table)
    expect(result.format).toBe('uuid')
  })

  it('includes items for array columns', () => {
    const col = makeColumn({ udtName: '_int4', name: 'tags' })
    const table = { ...users, columns: [...users.columns, col] }
    const result = buildAgentColumn(col, table)
    expect(result.items).toEqual({ type: 'integer' })
  })
})

// ── buildAgentTable ─────────────────────────────────────────────────

describe('buildAgentTable', () => {
  it('includes all CRUD operations for table with PK', () => {
    const users = makeUsersTable()
    const result = buildAgentTable(users, new Map())
    expect(result.operations).toEqual(['list', 'create', 'read', 'update', 'replace', 'delete'])
  })

  it('includes only list and create for table without PK', () => {
    const noPk = makeNoPkTable()
    const result = buildAgentTable(noPk, new Map())
    expect(result.operations).toEqual(['list', 'create'])
  })

  it('includes correct path for public schema table', () => {
    const users = makeUsersTable()
    const result = buildAgentTable(users, new Map())
    expect(result.path).toBe('/api/users')
  })

  it('includes correct path for non-public schema table', () => {
    const nonPublic = makeNonPublicSchemaTable()
    const result = buildAgentTable(nonPublic, new Map())
    expect(result.path).toBe('/api/reporting__metrics')
  })

  it('maps foreign keys with correct refPath (public schema)', () => {
    const orders = makeTableWithForeignKeys()
    const result = buildAgentTable(orders, new Map())
    const fk = result.foreignKeys[0]
    expect(fk.column).toBe('user_id')
    expect(fk.references).toBe('users.id')
    expect(fk.refPath).toBe('/api/users')
  })

  it('identifies searchable columns (varchar/text types)', () => {
    const users = makeUsersTable()
    const result = buildAgentTable(users, new Map())
    // name and email are varchar
    expect(result.searchableColumns).toContain('name')
    expect(result.searchableColumns).toContain('email')
    // id (int4) and active (bool) are not searchable
    expect(result.searchableColumns).not.toContain('id')
    expect(result.searchableColumns).not.toContain('active')
  })

  it('includes primaryKeys', () => {
    const users = makeUsersTable()
    const result = buildAgentTable(users, new Map())
    expect(result.primaryKeys).toEqual(['id'])
  })

  it('includes columns with correct metadata', () => {
    const users = makeUsersTable()
    const result = buildAgentTable(users, new Map())
    expect(result.columns).toHaveLength(4)
    const nameCol = result.columns.find((c: any) => c.name === 'name') as any
    expect(nameCol.type).toBe('string')
    expect(nameCol.insertRequired).toBe(true)
  })
})

// ── buildApiInfo ────────────────────────────────────────────────────

describe('buildApiInfo', () => {
  it('returns correct base structure', () => {
    const info = buildApiInfo()
    expect(info.baseUrl).toBe('/api')
    expect(info.auth.enabled).toBe(true)
    expect(info.auth.methods).toEqual(['Bearer', 'X-API-Key'])
  })

  it('includes pagination config', () => {
    const info = buildApiInfo()
    expect(info.pagination.defaultPageSize).toBe(50)
    expect(info.pagination.maxPageSize).toBe(1000)
  })

  it('includes all filter operators', () => {
    const info = buildApiInfo()
    expect(info.filtering.operators).toEqual(
      ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in']
    )
  })

  it('includes sorting params', () => {
    const info = buildApiInfo()
    expect(info.sorting.params).toEqual(['sortBy', 'sortOrder'])
  })

  it('includes bulk insert max rows', () => {
    const info = buildApiInfo()
    expect(info.bulkInsert.maxRows).toBe(1000)
  })

  it('shows empty methods when auth is disabled', () => {
    (config as any).apiKeysEnabled = false
    const info = buildApiInfo()
    expect(info.auth.enabled).toBe(false)
    expect(info.auth.methods).toEqual([]);
    // Reset
    (config as any).apiKeysEnabled = true
  })
})
