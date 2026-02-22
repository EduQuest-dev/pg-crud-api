import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { Pool } from 'pg'
import { DatabaseSchema, TableInfo } from '../db/introspector.js'
import {
  buildSelectQuery,
  buildCountQuery,
  buildSelectByPkQuery,
  buildInsertQuery,
  buildBulkInsertQuery,
  buildUpdateQuery,
  buildDeleteQuery,
  hasSoftDelete,
  pgTypeToJsonSchema,
  ListOptions,
} from '../db/query-builder.js'
import { config } from '../config.js'
import { handleDbError } from '../errors/pg-errors.js'
import { hasPermission, hasAnyPermission } from '../auth/api-key.js'

// ─── Helpers ─────────────────────────────────────────────────────────

export function parseCommaSeparated (value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean)
  return String(value).split(',').map((s) => s.trim()).filter(Boolean)
}

export function buildPkParams (table: TableInfo, params: Record<string, string>): Record<string, unknown> | null {
  const pkValues: Record<string, unknown> = {}

  if (table.primaryKeys.length === 1) {
    pkValues[table.primaryKeys[0]] = params.id
    return pkValues
  }

  // Composite PK: id format is "val1,val2,..."
  const parts = params.id.split(',')
  if (parts.length !== table.primaryKeys.length || parts.some((p) => p.trim() === '')) {
    return null
  }
  table.primaryKeys.forEach((pk, i) => {
    pkValues[pk] = parts[i]
  })

  return pkValues
}

export function buildJsonSchemaForTable (table: TableInfo, mode: 'row' | 'insert' | 'update' | 'put') {
  const properties: Record<string, unknown> = {}
  const required: string[] = []

  for (const col of table.columns) {
    const isPk = table.primaryKeys.includes(col.name)

    if (mode === 'insert' && isPk && col.hasDefault) continue
    if ((mode === 'update' || mode === 'put') && isPk) continue

    properties[col.name] = pgTypeToJsonSchema(col)

    if (mode === 'insert' && !col.isNullable && !col.hasDefault) {
      required.push(col.name)
    }
    // PUT requires all non-PK fields
    if (mode === 'put') {
      required.push(col.name)
    }
  }

  const schema: Record<string, unknown> = { type: 'object', properties }
  if (required.length > 0) schema.required = required
  if (mode === 'insert' || mode === 'update' || mode === 'put') schema.additionalProperties = false
  return schema
}

function errorSchema (description: string) {
  return {
    description,
    type: 'object',
    properties: {
      error: { type: 'string' },
      message: { type: 'string' },
      statusCode: { type: 'integer' },
      detail: { type: 'string' },
      constraint: { type: 'string' },
      details: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            field: { type: 'string' },
            message: { type: 'string' },
            constraint: {},
          },
        },
      },
    },
  }
}

export function handleRouteError (error: unknown, reply: FastifyReply) {
  // Non-PG errors (e.g., from query-builder validation) are client errors
  if (error instanceof Error && !('code' in error)) {
    return reply.status(400).send({ error: 'Bad request', message: error.message })
  }
  return handleDbError(error, reply)
}

function denyPermission (reply: FastifyReply, schema: string, access: string) {
  return reply.status(403).send({
    error: 'Forbidden',
    message: `API key does not have ${access} permission on schema "${schema}".`,
  })
}

/**
 * Parse PK from request params, or send a 400 response and return null.
 */
function parsePkOrReply (
  table: TableInfo,
  request: FastifyRequest,
  reply: FastifyReply
): Record<string, unknown> | null {
  const params = request.params as { id: string }
  const pkValues = buildPkParams(table, params)
  if (!pkValues) {
    reply.status(400).send({
      error: 'Bad request',
      message: `Composite primary key expects ${table.primaryKeys.length} values (${table.primaryKeys.join(',')})`,
    })
  }
  return pkValues
}

// ─── Common response schemas ─────────────────────────────────────────

const ERROR_401 = errorSchema('Unauthorized')
const ERROR_403 = errorSchema('Forbidden')
const ERROR_404 = errorSchema('Record not found')
const ERROR_400 = errorSchema('Bad request')
const ERROR_409 = errorSchema('Conflict — duplicate key')

// ─── Route Registration ──────────────────────────────────────────────

export async function registerCrudRoutes (
  app: FastifyInstance,
  pool: Pool,
  dbSchema: DatabaseSchema,
  readPool: Pool = pool
) {
  // ── Meta endpoint: list all available tables ──
  app.get('/api/_meta/tables', async (request) => {
    const tables = Array.from(dbSchema.tables.values())
      .filter((t) => hasAnyPermission(request.apiKeyPermissions, t.schema))
      .map((t) => ({
        schema: t.schema,
        table: t.name,
        path: `/api/${t.routePath}`,
        primaryKeys: t.primaryKeys,
        columnCount: t.columns.length,
        foreignKeys: t.foreignKeys.map((fk) => ({
          column: fk.column,
          references: `${fk.refSchema}.${fk.refTable}.${fk.refColumn}`,
        })),
      }))
    return { count: tables.length, tables }
  })

  // ── Meta endpoint: table schema details ──
  app.get('/api/_meta/tables/:table', async (request, reply) => {
    const { table: routePath } = request.params as { table: string }
    const tableInfo = findTable(dbSchema, routePath)

    if (!tableInfo || !hasAnyPermission(request.apiKeyPermissions, tableInfo.schema)) {
      return reply.status(404).send({ error: `Table '${routePath}' not found` })
    }

    return {
      schema: tableInfo.schema,
      table: tableInfo.name,
      fqn: tableInfo.fqn,
      columns: tableInfo.columns.map((c) => ({
        name: c.name,
        type: c.dataType,
        nullable: c.isNullable,
        hasDefault: c.hasDefault,
        maxLength: c.maxLength,
        isPrimaryKey: tableInfo.primaryKeys.includes(c.name),
      })),
      primaryKeys: tableInfo.primaryKeys,
      foreignKeys: tableInfo.foreignKeys,
    }
  })

  // ── Register CRUD for each table ──
  for (const [, table] of dbSchema.tables) {
    const basePath = `/api/${table.routePath}`
    const tag = table.schema === 'public' ? table.name : `${table.schema}.${table.name}`

    console.log(`  📝 ${basePath} → ${table.fqn}`)

    const rowSchema = buildJsonSchemaForTable(table, 'row')
    const insertSchema = buildJsonSchemaForTable(table, 'insert')
    const putSchema = buildJsonSchemaForTable(table, 'put')
    const patchSchema = buildJsonSchemaForTable(table, 'update')

    // ── LIST (GET /) ──
    app.get(basePath, {
      schema: {
        tags: [tag],
        summary: `List ${table.name} records`,
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'integer', minimum: 1, default: 1 },
            pageSize: { type: 'integer', minimum: 1, maximum: config.maxPageSize, default: config.defaultPageSize },
            sortBy: { type: 'string', enum: table.columns.map((c) => c.name) },
            sortOrder: { type: 'string', enum: ['asc', 'desc'] },
            select: { type: 'string', description: 'Comma-separated column names' },
            search: { type: 'string', minLength: 1, maxLength: 500 },
            searchColumns: { type: 'string', description: 'Comma-separated columns to search' },
          },
          additionalProperties: true,
        },
        response: {
          200: {
            description: 'Paginated list of records',
            type: 'object',
            properties: {
              data: { type: 'array', items: rowSchema },
              pagination: {
                type: 'object',
                properties: {
                  page: { type: 'integer' },
                  pageSize: { type: 'integer' },
                  total: { type: 'integer' },
                  totalPages: { type: 'integer' },
                },
              },
            },
          },
          400: ERROR_400,
          401: ERROR_401,
          403: ERROR_403,
        },
      },
      handler: async (request: FastifyRequest, reply: FastifyReply) => {
        if (!hasPermission(request.apiKeyPermissions, table.schema, 'r')) {
          return denyPermission(reply, table.schema, 'read')
        }
        try {
          const query = request.query as Record<string, unknown>

          // Extract filter.* params
          const filters: Record<string, unknown> = {}
          for (const [key, value] of Object.entries(query)) {
            if (key.startsWith('filter.')) {
              filters[key.slice(7)] = value
            }
          }

          const opts: ListOptions = {
            /* c8 ignore next */
            page: Number(query.page) || 1,
            /* c8 ignore next */
            pageSize: Number(query.pageSize) || config.defaultPageSize,
            sortBy: query.sortBy as string,
            sortOrder: query.sortOrder as 'asc' | 'desc',
            select: query.select ? parseCommaSeparated(query.select) : undefined,
            search: query.search as string,
            searchColumns: query.searchColumns
              ? parseCommaSeparated(query.searchColumns)
              : table.columns.filter((c) => ['varchar', 'text', 'char', 'name'].includes(c.udtName)).map((c) => c.name),
            filters: Object.keys(filters).length > 0 ? filters : undefined,
          }

          const [dataResult, countResult] = await Promise.all([
            readPool.query(buildSelectQuery(table, opts)),
            readPool.query(buildCountQuery(table, opts)),
          ])

          const total = Number.parseInt(countResult.rows[0].total, 10)

          return {
            data: dataResult.rows,
            pagination: {
              page: opts.page!,
              pageSize: opts.pageSize!,
              total,
              totalPages: Math.ceil(total / opts.pageSize!),
            },
          }
        } catch (error) {
          return handleRouteError(error, reply)
        }
      },
    })

    // Shared params schema for PK-based routes
    const pkDescription = (() => {
      if (table.primaryKeys.length > 1) return `Composite PK: ${table.primaryKeys.join(',')}`
      if (table.primaryKeys.length === 1) return `Primary key (${table.primaryKeys[0]})`
      return undefined
    })()

    const paramsSchema = pkDescription
      ? {
          type: 'object' as const,
          properties: {
            id: { type: 'string' as const, description: pkDescription },
          },
          required: ['id' as const],
        }
      : undefined

    // ── GET BY PK (GET /:id) ──
    if (table.primaryKeys.length > 0) {
      app.get(`${basePath}/:id`, {
        schema: {
          tags: [tag],
          summary: `Get ${table.name} by primary key`,
          params: paramsSchema,
          querystring: {
            type: 'object',
            properties: {
              select: { type: 'string', description: 'Comma-separated column names' },
            },
          },
          response: {
            200: { description: 'Record found', ...rowSchema },
            401: ERROR_401,
            403: ERROR_403,
            404: ERROR_404,
          },
        },
        handler: async (request: FastifyRequest, reply: FastifyReply) => {
          if (!hasPermission(request.apiKeyPermissions, table.schema, 'r')) {
            return denyPermission(reply, table.schema, 'read')
          }
          try {
            const query = request.query as Record<string, string>
            const select = query.select ? query.select.split(',').map((s) => s.trim()).filter(Boolean) : undefined
            const pkValues = parsePkOrReply(table, request, reply)
            if (!pkValues) return

            const result = await readPool.query(buildSelectByPkQuery(table, pkValues, select))

            if (result.rows.length === 0) {
              return reply.status(404).send({ error: 'Record not found' })
            }

            return result.rows[0]
          } catch (error) {
            return handleRouteError(error, reply)
          }
        },
      })
    }

    // ── CREATE (POST /) ──
    app.post(basePath, {
      schema: {
        tags: [tag],
        summary: `Create ${table.name} record(s)`,
        body: {
          oneOf: [
            insertSchema,
            { type: 'array', items: insertSchema, minItems: 1, maxItems: config.maxBulkInsertRows },
          ],
        },
        response: {
          201: {
            description: 'Record(s) created',
            oneOf: [
              rowSchema,
              {
                type: 'object',
                properties: {
                  data: { type: 'array', items: rowSchema },
                  count: { type: 'integer' },
                },
              },
            ],
          },
          400: ERROR_400,
          401: ERROR_401,
          403: ERROR_403,
          409: ERROR_409,
        },
      },
      handler: async (request: FastifyRequest, reply: FastifyReply) => {
        if (!hasPermission(request.apiKeyPermissions, table.schema, 'w')) {
          return denyPermission(reply, table.schema, 'write')
        }
        try {
          const body = request.body

          if (Array.isArray(body)) {
            const result = await pool.query(buildBulkInsertQuery(table, body))
            return reply.status(201).send({ data: result.rows, count: result.rows.length })
          }
          const result = await pool.query(buildInsertQuery(table, body as Record<string, unknown>))
          return reply.status(201).send(result.rows[0])
        } catch (error) {
          return handleRouteError(error, reply)
        }
      },
    })

    // ── Shared update handler for PUT and PATCH ──
    const updateHandler = async (request: FastifyRequest, reply: FastifyReply) => {
      if (!hasPermission(request.apiKeyPermissions, table.schema, 'w')) {
        return denyPermission(reply, table.schema, 'write')
      }
      try {
        const pkValues = parsePkOrReply(table, request, reply)
        if (!pkValues) return
        const body = request.body as Record<string, unknown>

        const result = await pool.query(buildUpdateQuery(table, pkValues, body))

        if (result.rows.length === 0) {
          return reply.status(404).send({ error: 'Record not found' })
        }

        return result.rows[0]
      } catch (error) {
        return handleRouteError(error, reply)
      }
    }

    const updateResponseSchema = {
      200: { description: 'Record updated', ...rowSchema },
      400: ERROR_400,
      401: ERROR_401,
      403: ERROR_403,
      404: ERROR_404,
      409: ERROR_409,
    }

    if (table.primaryKeys.length > 0) {
      // ── UPDATE (PUT /:id) — full replacement ──
      app.put(`${basePath}/:id`, {
        schema: {
          tags: [tag],
          summary: `Replace ${table.name} by primary key`,
          params: paramsSchema,
          body: putSchema,
          response: updateResponseSchema,
        },
        handler: updateHandler,
      })

      // ── PATCH (partial update) ──
      app.patch(`${basePath}/:id`, {
        schema: {
          tags: [tag],
          summary: `Partially update ${table.name} by primary key`,
          params: paramsSchema,
          body: patchSchema,
          response: updateResponseSchema,
        },
        handler: updateHandler,
      })

      // ── DELETE (DELETE /:id) ──
      const isSoftDelete = hasSoftDelete(table)
      app.delete(`${basePath}/:id`, {
        schema: {
          tags: [tag],
          summary: isSoftDelete
            ? `Soft-delete ${table.name} by primary key (sets deleted_at)`
            : `Delete ${table.name} by primary key`,
          params: paramsSchema,
          response: {
            200: {
              description: isSoftDelete ? 'Record soft-deleted' : 'Record deleted',
              type: 'object',
              properties: {
                deleted: { type: 'boolean' },
                softDelete: { type: 'boolean' },
                record: rowSchema,
              },
            },
            401: ERROR_401,
            403: ERROR_403,
            404: ERROR_404,
          },
        },
        handler: async (request: FastifyRequest, reply: FastifyReply) => {
          if (!hasPermission(request.apiKeyPermissions, table.schema, 'w')) {
            return denyPermission(reply, table.schema, 'write')
          }
          try {
            const pkValues = parsePkOrReply(table, request, reply)
            if (!pkValues) return

            const result = await pool.query(buildDeleteQuery(table, pkValues))

            if (result.rows.length === 0) {
              return reply.status(404).send({ error: 'Record not found' })
            }

            return { deleted: true, softDelete: isSoftDelete, record: result.rows[0] }
          } catch (error) {
            return handleRouteError(error, reply)
          }
        },
      })
    }
  }
}

// ─── Find table by route path ────────────────────────────────────────

export function findTable (dbSchema: DatabaseSchema, routePath: string): TableInfo | undefined {
  for (const [, table] of dbSchema.tables) {
    if (table.routePath === routePath) return table
  }
  return undefined
}
