import { describe, it, expect, vi } from 'vitest'

import {
  buildSelectQuery,
  buildCountQuery,
  buildSelectByPkQuery,
  buildInsertQuery,
  buildBulkInsertQuery,
  buildUpdateQuery,
  buildDeleteQuery,
  hasSoftDelete,
  hasUpdatedAt,
} from '../../src/db/query-builder.js'
import { makeColumn, makeUsersTable, makeCompositePkTable, makeSoftDeleteTable } from '../fixtures/tables.js'
import type { TableInfo } from '../../src/db/introspector.js'

vi.mock('../../src/config.js', () => ({
  config: {
    defaultPageSize: 50,
    maxPageSize: 1000,
    maxBulkInsertRows: 1000,
  },
}))

const users = makeUsersTable()
const softDeleteTable = makeSoftDeleteTable()
const compositePk = makeCompositePkTable()

// ── buildSelectQuery ────────────────────────────────────────────────

describe('buildSelectQuery', () => {
  it('generates basic SELECT with default pagination', () => {
    const result = buildSelectQuery(users, {})
    expect(result.text).toContain('SELECT *')
    expect(result.text).toContain('FROM "public"."users"')
    expect(result.text).toContain('ORDER BY')
    expect(result.text).toMatch(/LIMIT \$\d+ OFFSET \$\d+/)
    // defaults: pageSize=50, offset=0
    expect(result.values).toContain(50)
    expect(result.values).toContain(0)
  })

  it('sorts by first PK column by default', () => {
    const result = buildSelectQuery(users, {})
    expect(result.text).toContain('"id" ASC')
  })

  it('applies custom page and pageSize', () => {
    const result = buildSelectQuery(users, { page: 3, pageSize: 10 })
    expect(result.values).toContain(10)  // LIMIT
    expect(result.values).toContain(20)  // OFFSET = (3-1)*10
  })

  it('clamps page to minimum of 1', () => {
    const result = buildSelectQuery(users, { page: -5, pageSize: 10 })
    expect(result.values).toContain(0)   // OFFSET = (1-1)*10 = 0
  })

  it('clamps pageSize to maxPageSize', () => {
    const result = buildSelectQuery(users, { pageSize: 9999 })
    expect(result.values).toContain(1000) // clamped to maxPageSize
  })

  it('applies column selection', () => {
    const result = buildSelectQuery(users, { select: ['id', 'name'] })
    expect(result.text).toContain('"id", "name"')
    expect(result.text).not.toContain('SELECT *')
  })

  it('applies sorting with valid column and desc order', () => {
    const result = buildSelectQuery(users, { sortBy: 'name', sortOrder: 'desc' })
    expect(result.text).toContain('"name" DESC')
  })

  it('defaults to ASC when sortOrder not specified', () => {
    const result = buildSelectQuery(users, { sortBy: 'email' })
    expect(result.text).toContain('"email" ASC')
  })

  it('falls back to PK sort when sortBy is invalid', () => {
    const result = buildSelectQuery(users, { sortBy: 'nonexistent' })
    expect(result.text).toContain('"id" ASC')
  })

  it('applies eq filter', () => {
    const result = buildSelectQuery(users, { filters: { name: 'eq:John' } })
    expect(result.text).toContain('"name" = $1')
    expect(result.values[0]).toBe('John')
  })

  it('applies neq filter', () => {
    const result = buildSelectQuery(users, { filters: { name: 'neq:John' } })
    expect(result.text).toContain('"name" != $1')
  })

  it('applies gt filter', () => {
    const result = buildSelectQuery(users, { filters: { id: 'gt:10' } })
    expect(result.text).toContain('"id" > $1')
    expect(result.values[0]).toBe('10')
  })

  it('applies gte filter', () => {
    const result = buildSelectQuery(users, { filters: { id: 'gte:10' } })
    expect(result.text).toContain('"id" >= $1')
  })

  it('applies lt filter', () => {
    const result = buildSelectQuery(users, { filters: { id: 'lt:10' } })
    expect(result.text).toContain('"id" < $1')
  })

  it('applies lte filter', () => {
    const result = buildSelectQuery(users, { filters: { id: 'lte:10' } })
    expect(result.text).toContain('"id" <= $1')
  })

  it('applies like filter', () => {
    const result = buildSelectQuery(users, { filters: { name: 'like:%john%' } })
    expect(result.text).toContain('"name" LIKE $1')
    expect(result.values[0]).toBe('%john%')
  })

  it('applies ilike filter', () => {
    const result = buildSelectQuery(users, { filters: { name: 'ilike:%john%' } })
    expect(result.text).toContain('"name" ILIKE $1')
  })

  it('applies is:null filter', () => {
    const result = buildSelectQuery(users, { filters: { active: 'is:null' } })
    expect(result.text).toContain('"active" IS NULL')
  })

  it('applies is:notnull filter', () => {
    const result = buildSelectQuery(users, { filters: { active: 'is:notnull' } })
    expect(result.text).toContain('"active" IS NOT NULL')
  })

  it('applies in filter', () => {
    const result = buildSelectQuery(users, { filters: { name: 'in:alice,bob,charlie' } })
    expect(result.text).toContain('"name" IN ($1, $2, $3)')
    expect(result.values[0]).toBe('alice')
    expect(result.values[1]).toBe('bob')
    expect(result.values[2]).toBe('charlie')
  })

  it('applies multiple filters with AND', () => {
    const result = buildSelectQuery(users, {
      filters: { name: 'eq:John', active: 'eq:true' },
    })
    expect(result.text).toContain('WHERE')
    expect(result.text).toContain('AND')
  })

  it('applies ILIKE search on searchColumns', () => {
    const result = buildSelectQuery(users, {
      search: 'john',
      searchColumns: ['name', 'email'],
    })
    expect(result.text).toContain('ILIKE')
    expect(result.text).toContain('"name"::text ILIKE')
    expect(result.text).toContain('"email"::text ILIKE')
    expect(result.text).toContain(' OR ')
    // search value should be wrapped in %...%
    expect(result.values).toContain('%john%')
  })

  it('escapes LIKE wildcards in search', () => {
    const result = buildSelectQuery(users, {
      search: '100%',
      searchColumns: ['name'],
    })
    expect(result.values).toContain('%100\\%%')
  })

  it('combines filters and search', () => {
    const result = buildSelectQuery(users, {
      filters: { active: 'eq:true' },
      search: 'john',
      searchColumns: ['name'],
    })
    expect(result.text).toContain('"active" = $1')
    expect(result.text).toContain('ILIKE')
    expect(result.text).toContain('AND')
  })

  it('throws on invalid filter column', () => {
    expect(() =>
      buildSelectQuery(users, { filters: { nonexistent: 'eq:x' } })
    ).toThrow('does not exist')
  })

  it('throws on invalid select column', () => {
    expect(() =>
      buildSelectQuery(users, { select: ['nonexistent'] })
    ).toThrow('None of the requested columns exist')
  })

  it('throws when IN filter exceeds 100 values', () => {
    const values = Array.from({ length: 101 }, (_, i) => `v${i}`).join(',')
    expect(() =>
      buildSelectQuery(users, { filters: { name: `in:${values}` } })
    ).toThrow('IN filter limited to 100 values')
  })

  it('treats value without known operator prefix as eq', () => {
    const result = buildSelectQuery(users, { filters: { name: 'John' } })
    expect(result.text).toContain('"name" = $1')
    expect(result.values[0]).toBe('John')
  })

  it('treats unrecognized operator prefix as eq with full value', () => {
    const result = buildSelectQuery(users, { filters: { name: 'foo:bar' } })
    expect(result.text).toContain('"name" = $1')
    expect(result.values[0]).toBe('foo:bar')
  })

  it('ignores search when all searchColumns are invalid', () => {
    const result = buildSelectQuery(users, {
      search: 'john',
      searchColumns: ['nonexistent'],
    })
    expect(result.text).not.toContain('ILIKE')
  })
})

// ── buildCountQuery ─────────────────────────────────────────────────

describe('buildCountQuery', () => {
  it('generates basic COUNT query', () => {
    const result = buildCountQuery(users, {})
    expect(result.text).toContain('SELECT COUNT(*) AS total')
    expect(result.text).toContain('FROM "public"."users"')
    expect(result.values).toEqual([])
  })

  it('includes same WHERE clause as buildSelectQuery for filters', () => {
    const opts = { filters: { name: 'eq:John' } }
    const selectResult = buildSelectQuery(users, opts)
    const countResult = buildCountQuery(users, opts)

    // Extract WHERE clause up to ORDER BY for select
    const selectWhere = selectResult.text.match(/WHERE (.+?) ORDER/)?.[1]
    const countWhere = countResult.text.match(/WHERE (.+)$/)?.[1]
    expect(selectWhere).toBe(countWhere)
  })

  it('includes same WHERE clause as buildSelectQuery for search', () => {
    const opts = { search: 'john', searchColumns: ['name', 'email'] }
    const selectResult = buildSelectQuery(users, opts)
    const countResult = buildCountQuery(users, opts)

    const selectWhere = selectResult.text.match(/WHERE (.+?) ORDER/)?.[1]
    const countWhere = countResult.text.match(/WHERE (.+)$/)?.[1]
    expect(selectWhere).toBe(countWhere)
  })

  it('includes same WHERE clause for combined filters + search', () => {
    const opts = {
      filters: { active: 'eq:true' },
      search: 'john',
      searchColumns: ['name'],
    }
    const selectResult = buildSelectQuery(users, opts)
    const countResult = buildCountQuery(users, opts)

    const selectWhere = selectResult.text.match(/WHERE (.+?) ORDER/)?.[1]
    const countWhere = countResult.text.match(/WHERE (.+)$/)?.[1]
    expect(selectWhere).toBe(countWhere)
  })
})

// ── buildSelectByPkQuery ────────────────────────────────────────────

describe('buildSelectByPkQuery', () => {
  it('generates query for single PK', () => {
    const result = buildSelectByPkQuery(users, { id: '42' })
    expect(result.text).toContain('"id" = $1')
    expect(result.text).toContain('LIMIT 1')
    expect(result.values).toEqual(['42'])
  })

  it('generates query for composite PK', () => {
    const result = buildSelectByPkQuery(compositePk, { user_id: '42', role_id: '7' })
    expect(result.text).toContain('"user_id" = $1')
    expect(result.text).toContain('"role_id" = $2')
    expect(result.values).toEqual(['42', '7'])
  })

  it('supports column selection', () => {
    const result = buildSelectByPkQuery(users, { id: '42' }, ['name', 'email'])
    expect(result.text).toContain('"name", "email"')
    expect(result.text).not.toContain('SELECT *')
  })
})

// ── buildInsertQuery ────────────────────────────────────────────────

describe('buildInsertQuery', () => {
  it('generates INSERT with valid columns', () => {
    const result = buildInsertQuery(users, { name: 'Alice', email: 'alice@test.com' })
    expect(result.text).toContain('INSERT INTO')
    expect(result.text).toContain('"name"')
    expect(result.text).toContain('"email"')
    expect(result.text).toContain('RETURNING *')
    expect(result.values).toEqual(['Alice', 'alice@test.com'])
  })

  it('ignores columns not in table schema', () => {
    const result = buildInsertQuery(users, { name: 'Alice', nonexistent: 'value' })
    expect(result.text).not.toContain('nonexistent')
    expect(result.values).toEqual(['Alice'])
  })

  it('throws when no valid columns provided', () => {
    expect(() =>
      buildInsertQuery(users, { nonexistent: 'value' })
    ).toThrow('No valid columns provided for insert')
  })

  it('includes all provided valid columns', () => {
    const result = buildInsertQuery(users, { id: 1, name: 'Alice', email: 'a@b.com', active: true })
    expect(result.text).toContain('"id"')
    expect(result.text).toContain('"name"')
    expect(result.text).toContain('"email"')
    expect(result.text).toContain('"active"')
    expect(result.values).toHaveLength(4)
  })

  it('auto-sets updated_at to NOW() when column exists and not provided', () => {
    const result = buildInsertQuery(softDeleteTable, { user_id: 1, title: 'Hello' })
    expect(result.text).toContain('"updated_at"')
    expect(result.text).toContain('NOW()')
    // NOW() is a literal, not a parameter — values should only have user_id and title
    expect(result.values).toEqual([1, 'Hello'])
  })

  it('does not auto-set updated_at when explicitly provided', () => {
    const ts = '2025-06-01T00:00:00Z'
    const result = buildInsertQuery(softDeleteTable, { user_id: 1, title: 'Hello', updated_at: ts })
    // Should use the provided value as a parameter, not NOW()
    expect(result.values).toContain(ts)
    // NOW() should not appear for updated_at since user provided it
    expect(result.text).not.toMatch(/NOW\(\)/)
  })

  it('does not add updated_at for tables without the column', () => {
    const result = buildInsertQuery(users, { name: 'Alice', email: 'a@b.com' })
    expect(result.text).not.toContain('updated_at')
    expect(result.text).not.toContain('NOW()')
  })
})

// ── buildBulkInsertQuery ────────────────────────────────────────────

describe('buildBulkInsertQuery', () => {
  it('generates bulk INSERT for rows with same columns', () => {
    const rows = [
      { name: 'Alice', email: 'alice@test.com' },
      { name: 'Bob', email: 'bob@test.com' },
    ]
    const result = buildBulkInsertQuery(users, rows)
    expect(result.text).toContain('INSERT INTO')
    expect(result.text).toContain('RETURNING *')
    expect(result.text).toMatch(/VALUES \(.+\), \(.+\)/)
    expect(result.values).toHaveLength(4)
  })

  it('uses union of columns across rows (missing → null)', () => {
    const rows = [
      { name: 'Alice' },
      { email: 'bob@test.com' },
    ]
    const result = buildBulkInsertQuery(users, rows)
    // Both name and email columns should appear
    expect(result.text).toContain('"name"')
    expect(result.text).toContain('"email"')
    // Missing values become null
    expect(result.values).toContain(null)
  })

  it('throws for empty array', () => {
    expect(() => buildBulkInsertQuery(users, [])).toThrow('No rows provided for bulk insert')
  })

  it('throws when exceeding maxBulkInsertRows', () => {
    const rows = Array.from({ length: 1001 }, () => ({ name: 'x' }))
    expect(() => buildBulkInsertQuery(users, rows)).toThrow('Bulk insert limited to')
  })

  it('throws when no valid columns in data', () => {
    expect(() => buildBulkInsertQuery(users, [{ nonexistent: 'v' }])).toThrow(
      'No valid columns in bulk insert data'
    )
  })

  it('auto-sets updated_at to NOW() in bulk insert when column exists', () => {
    const rows = [
      { user_id: 1, title: 'Post A' },
      { user_id: 2, title: 'Post B' },
    ]
    const result = buildBulkInsertQuery(softDeleteTable, rows)
    expect(result.text).toContain('"updated_at"')
    // Each row should have NOW() for updated_at
    const nowCount = (result.text.match(/NOW\(\)/g) || []).length
    expect(nowCount).toBe(2)
    // Parameters should only contain user_id and title for each row (no updated_at params)
    expect(result.values).toEqual([1, 'Post A', 2, 'Post B'])
  })

  it('does not auto-add updated_at when rows explicitly provide it', () => {
    const ts = '2025-06-01T00:00:00Z'
    const rows = [
      { user_id: 1, title: 'Post A', updated_at: ts },
    ]
    const result = buildBulkInsertQuery(softDeleteTable, rows)
    expect(result.text).toContain('"updated_at"')
    expect(result.text).not.toMatch(/NOW\(\)/)
    expect(result.values).toContain(ts)
  })

  it('does not add updated_at for tables without the column', () => {
    const rows = [{ name: 'Alice', email: 'a@b.com' }]
    const result = buildBulkInsertQuery(users, rows)
    expect(result.text).not.toContain('updated_at')
    expect(result.text).not.toContain('NOW()')
  })
})

// ── buildUpdateQuery ────────────────────────────────────────────────

describe('buildUpdateQuery', () => {
  it('generates UPDATE for non-PK columns', () => {
    const result = buildUpdateQuery(users, { id: '42' }, { name: 'Bob' })
    expect(result.text).toContain('UPDATE')
    expect(result.text).toContain('SET "name" = $1')
    expect(result.text).toContain('"id" = $2')
    expect(result.text).toContain('RETURNING *')
    expect(result.values).toEqual(['Bob', '42'])
  })

  it('skips PK columns from SET clause', () => {
    const result = buildUpdateQuery(users, { id: '42' }, { id: 99, name: 'Bob' })
    expect(result.text).not.toContain('SET "id"')
    expect(result.text).toContain('SET "name"')
  })

  it('throws when only PK columns provided (no valid update columns)', () => {
    expect(() =>
      buildUpdateQuery(users, { id: '42' }, { id: 99 })
    ).toThrow('No valid columns provided for update')
  })

  it('generates UPDATE for composite PK table', () => {
    const result = buildUpdateQuery(
      compositePk,
      { user_id: '42', role_id: '7' },
      { granted_at: '2024-01-01' }
    )
    expect(result.text).toContain('"granted_at" = $1')
    expect(result.text).toContain('"user_id" = $2')
    expect(result.text).toContain('"role_id" = $3')
    expect(result.values).toEqual(['2024-01-01', '42', '7'])
  })

  it('updates multiple columns', () => {
    const result = buildUpdateQuery(users, { id: '42' }, { name: 'Bob', email: 'bob@test.com', active: false })
    expect(result.text).toContain('"name" = $1')
    expect(result.text).toContain('"email" = $2')
    expect(result.text).toContain('"active" = $3')
    expect(result.values).toEqual(['Bob', 'bob@test.com', false, '42'])
  })

  it('auto-sets updated_at to NOW() when column exists and not provided', () => {
    const result = buildUpdateQuery(softDeleteTable, { id: '10' }, { title: 'New Title' })
    expect(result.text).toContain('"title" = $1')
    expect(result.text).toContain('"updated_at" = NOW()')
    expect(result.text).toContain('"id" = $2')
    expect(result.values).toEqual(['New Title', '10'])
  })

  it('does not auto-set updated_at when explicitly provided', () => {
    const ts = '2025-06-01T00:00:00Z'
    const result = buildUpdateQuery(softDeleteTable, { id: '10' }, { title: 'New Title', updated_at: ts })
    expect(result.text).toContain('"updated_at" = $2')
    expect(result.text).not.toMatch(/"updated_at" = NOW\(\)/)
    expect(result.values).toContain(ts)
  })

  it('does not add updated_at for tables without the column', () => {
    const result = buildUpdateQuery(users, { id: '42' }, { name: 'Bob' })
    expect(result.text).not.toContain('updated_at')
    expect(result.text).not.toContain('NOW()')
  })
})

// ── buildDeleteQuery ────────────────────────────────────────────────

describe('buildDeleteQuery', () => {
  it('generates DELETE for single PK', () => {
    const result = buildDeleteQuery(users, { id: '42' })
    expect(result.text).toContain('DELETE FROM')
    expect(result.text).toContain('"id" = $1')
    expect(result.text).toContain('RETURNING *')
    expect(result.values).toEqual(['42'])
  })

  it('generates DELETE for composite PK', () => {
    const result = buildDeleteQuery(compositePk, { user_id: '42', role_id: '7' })
    expect(result.text).toContain('"user_id" = $1')
    expect(result.text).toContain('"role_id" = $2')
    expect(result.values).toEqual(['42', '7'])
  })

  it('generates soft-delete UPDATE when table has deleted_at column', () => {
    const result = buildDeleteQuery(softDeleteTable, { id: '10' })
    expect(result.text).toContain('UPDATE')
    expect(result.text).toContain('SET "deleted_at" = NOW()')
    expect(result.text).toContain('"updated_at" = NOW()')
    expect(result.text).toContain('"id" = $1')
    expect(result.text).toContain('RETURNING *')
    expect(result.text).not.toContain('DELETE')
    expect(result.values).toEqual(['10'])
  })

  it('soft-deletes without updated_at when table has deleted_at but no updated_at', () => {
    const softOnlyTable: TableInfo = {
      schema: 'public',
      name: 'events',
      fqn: '"public"."events"',
      routePath: 'events',
      primaryKeys: ['id'],
      foreignKeys: [],
      columns: [
        makeColumn({ name: 'id', dataType: 'integer', udtName: 'int4', hasDefault: true, ordinalPosition: 1 }),
        makeColumn({ name: 'name', dataType: 'text', udtName: 'text', ordinalPosition: 2 }),
        makeColumn({ name: 'deleted_at', dataType: 'timestamp with time zone', udtName: 'timestamptz', isNullable: true, ordinalPosition: 3 }),
      ],
    }
    const result = buildDeleteQuery(softOnlyTable, { id: '1' })
    expect(result.text).toContain('SET "deleted_at" = NOW()')
    expect(result.text).not.toContain('updated_at')
  })

  it('generates hard DELETE when table has no deleted_at column', () => {
    const result = buildDeleteQuery(users, { id: '42' })
    expect(result.text).toContain('DELETE FROM')
    expect(result.text).not.toContain('UPDATE')
    expect(result.text).not.toContain('deleted_at')
  })
})

// ── hasSoftDelete ──────────────────────────────────────────────────

describe('hasSoftDelete', () => {
  it('returns true for tables with a deleted_at column', () => {
    expect(hasSoftDelete(softDeleteTable)).toBe(true)
  })

  it('returns false for tables without a deleted_at column', () => {
    expect(hasSoftDelete(users)).toBe(false)
  })
})

// ── hasUpdatedAt ───────────────────────────────────────────────────

describe('hasUpdatedAt', () => {
  it('returns true for tables with an updated_at column', () => {
    expect(hasUpdatedAt(softDeleteTable)).toBe(true)
  })

  it('returns false for tables without an updated_at column', () => {
    expect(hasUpdatedAt(users)).toBe(false)
  })
})
