import { Pool } from 'pg'
import { z } from 'zod'
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
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
  ListOptions,
} from '../db/query-builder.js'
import { SchemaPermissions, hasPermission, hasAnyPermission } from '../auth/api-key.js'
import { config } from '../config.js'
import { buildAgentTable, buildApiInfo } from '../routes/schema.js'

// ─── Types ───────────────────────────────────────────────────────────

export interface McpServerOptions {
  pool: Pool;
  readPool: Pool;
  dbSchema: DatabaseSchema;
  permissions: SchemaPermissions | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────

const SEARCHABLE_TYPES = new Set(['varchar', 'text', 'char', 'name'])

function findTableByRoutePath (
  dbSchema: DatabaseSchema,
  routePath: string
): TableInfo | undefined {
  for (const [, table] of dbSchema.tables) {
    if (table.routePath === routePath) return table
  }
  return undefined
}

function getAccessibleTables (
  dbSchema: DatabaseSchema,
  permissions: SchemaPermissions | null
): TableInfo[] {
  return Array.from(dbSchema.tables.values()).filter((t) =>
    hasAnyPermission(permissions, t.schema)
  )
}

function checkPermission (
  permissions: SchemaPermissions | null,
  schema: string,
  access: 'r' | 'w'
): void {
  if (!hasPermission(permissions, schema, access)) {
    throw new Error(
      `Permission denied: API key does not have ${access === 'r' ? 'read' : 'write'} access on schema "${schema}"`
    )
  }
}

function textResult (data: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  }
}

function errorResult (message: string): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  }
}

function parsePkValues (table: TableInfo, id: string): Record<string, unknown> {
  const pkValues: Record<string, unknown> = {}

  if (table.primaryKeys.length === 1) {
    pkValues[table.primaryKeys[0]] = id
    return pkValues
  }

  const parts = id.split(',')
  if (parts.length !== table.primaryKeys.length || parts.some((p) => p.trim() === '')) {
    throw new Error(
      `Composite primary key expects ${table.primaryKeys.length} values (${table.primaryKeys.join(',')}), got ${parts.length}`
    )
  }
  table.primaryKeys.forEach((pk, i) => {
    pkValues[pk] = parts[i]
  })

  return pkValues
}

function formatPgError (error: unknown): string {
  const err = error as { code?: string; detail?: string; message?: string; constraint?: string }
  const pgErrorMap: Record<string, string> = {
    23505: 'Duplicate key / unique constraint violation',
    23503: 'Foreign key violation — referenced record does not exist',
    23502: 'Not null violation — required field is missing',
    '22P02': 'Invalid data type provided',
  }

  if (err.code && pgErrorMap[err.code]) {
    let msg = pgErrorMap[err.code]
    if (config.exposeDbErrors && err.detail) msg += `: ${err.detail}`
    return msg
  }

  if (err.message) return err.message
  return 'An unexpected database error occurred'
}

// ─── Server Factory ──────────────────────────────────────────────────

export function createMcpServer (opts: McpServerOptions): McpServer {
  const { pool, readPool, dbSchema, permissions } = opts

  const server = new McpServer({
    name: 'pg-crud-api',
    version: '1.0.0',
  })

  // ── Tools ──────────────────────────────────────────────────────────

  registerTools(server, pool, readPool, dbSchema, permissions)

  // ── Resources ──────────────────────────────────────────────────────

  registerResources(server, dbSchema, permissions)

  // ── Prompts ────────────────────────────────────────────────────────

  registerPrompts(server, dbSchema, permissions)

  return server
}

// ─── Tool Registration ───────────────────────────────────────────────

function registerTools (
  server: McpServer,
  pool: Pool,
  readPool: Pool,
  dbSchema: DatabaseSchema,
  permissions: SchemaPermissions | null
): void {
  // ── list_tables ──
  server.registerTool(
    'list_tables',
    {
      title: 'List Tables',
      description:
        'List all accessible database tables with their schemas, primary keys, and column counts. ' +
        'Use this first to discover what tables are available.',
      annotations: { readOnlyHint: true },
    },
    async () => {
      const tables = getAccessibleTables(dbSchema, permissions).map((t) => ({
        name: t.name,
        schema: t.schema,
        routePath: t.routePath,
        primaryKeys: t.primaryKeys,
        columnCount: t.columns.length,
        hasPrimaryKey: t.primaryKeys.length > 0,
      }))

      return textResult({ count: tables.length, tables })
    }
  )

  // ── describe_table ──
  server.registerTool(
    'describe_table',
    {
      title: 'Describe Table',
      description:
        'Get detailed schema information for a specific table, including columns (with types, nullability, defaults), ' +
        'primary keys, foreign key relationships, and available operations. ' +
        "Use the 'table' parameter with the routePath from list_tables (e.g., 'users' or 'reporting__metrics').",
      inputSchema: {
        table: z.string().describe("Table route path (e.g., 'users' or 'schema__table')"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ table: routePath }) => {
      const table = findTableByRoutePath(dbSchema, routePath)
      if (!table) return errorResult(`Table '${routePath}' not found`)

      if (!hasAnyPermission(permissions, table.schema)) {
        return errorResult(`Permission denied: no access to schema "${table.schema}"`)
      }

      const agentTable = buildAgentTable(table, dbSchema.tables)
      return textResult(agentTable)
    }
  )

  // ── list_records ──
  server.registerTool(
    'list_records',
    {
      title: 'List Records',
      description:
        'Query records from a table with optional filtering, pagination, sorting, and full-text search.\n\n' +
        'Filters use the format: { "column": "operator:value" }\n' +
        'Operators: eq, neq, gt, gte, lt, lte, like, ilike, is, in\n' +
        'Examples: { "status": "eq:active" }, { "age": "gte:18" }, { "name": "ilike:john" }, { "id": "in:1,2,3" }, { "deleted_at": "is:null" }',
      inputSchema: {
        table: z.string().describe("Table route path (e.g., 'users')"),
        page: z.number().int().min(1).optional().describe('Page number (default: 1)'),
        pageSize: z.number().int().min(1).max(config.maxPageSize).optional()
          .describe(`Records per page (default: ${config.defaultPageSize}, max: ${config.maxPageSize})`),
        sortBy: z.string().optional().describe('Column name to sort by'),
        sortOrder: z.enum(['asc', 'desc']).optional().describe('Sort direction (default: asc)'),
        filters: z.record(z.string(), z.string()).optional()
          .describe('Filter conditions as { "column": "operator:value" }'),
        search: z.string().optional().describe('Full-text search term (ILIKE across text columns)'),
        searchColumns: z.array(z.string()).optional()
          .describe('Columns to search in (defaults to all text/varchar columns)'),
        select: z.array(z.string()).optional().describe('Columns to return (defaults to all)'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ table: routePath, page, pageSize, sortBy, sortOrder, filters, search, searchColumns, select }) => {
      const table = findTableByRoutePath(dbSchema, routePath)
      if (!table) return errorResult(`Table '${routePath}' not found`)

      try {
        checkPermission(permissions, table.schema, 'r')

        const defaultSearchColumns = table.columns
          .filter((c) => SEARCHABLE_TYPES.has(c.udtName))
          .map((c) => c.name)

        const opts: ListOptions = {
          page: page ?? 1,
          pageSize: pageSize ?? config.defaultPageSize,
          sortBy,
          sortOrder,
          filters: filters && Object.keys(filters).length > 0 ? filters : undefined,
          search,
          searchColumns: searchColumns ?? defaultSearchColumns,
          select,
        }

        const [dataResult, countResult] = await Promise.all([
          readPool.query(buildSelectQuery(table, opts)),
          readPool.query(buildCountQuery(table, opts)),
        ])

        const total = Number.parseInt(countResult.rows[0].total, 10)

        return textResult({
          data: dataResult.rows,
          pagination: {
            page: opts.page!,
            pageSize: opts.pageSize!,
            total,
            totalPages: Math.ceil(total / opts.pageSize!),
          },
        })
      } catch (error) {
        return errorResult(formatPgError(error))
      }
    }
  )

  // ── get_record ──
  server.registerTool(
    'get_record',
    {
      title: 'Get Record',
      description:
        "Fetch a single record by its primary key. For composite primary keys, provide values comma-separated (e.g., '42,7').",
      inputSchema: {
        table: z.string().describe("Table route path (e.g., 'users')"),
        id: z.string().describe('Primary key value (comma-separated for composite keys)'),
        select: z.array(z.string()).optional().describe('Columns to return (defaults to all)'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ table: routePath, id, select }) => {
      const table = findTableByRoutePath(dbSchema, routePath)
      if (!table) return errorResult(`Table '${routePath}' not found`)

      if (table.primaryKeys.length === 0) {
        return errorResult(`Table '${routePath}' has no primary key — cannot get by PK`)
      }

      try {
        checkPermission(permissions, table.schema, 'r')
        const pkValues = parsePkValues(table, id)
        const result = await readPool.query(buildSelectByPkQuery(table, pkValues, select))

        if (result.rows.length === 0) {
          return errorResult('Record not found')
        }

        return textResult(result.rows[0])
      } catch (error) {
        return errorResult(formatPgError(error))
      }
    }
  )

  // ── create_record ──
  server.registerTool(
    'create_record',
    {
      title: 'Create Record',
      description:
        'Insert one or more records into a table. Provide a single object for one record, ' +
        'or an array of objects for bulk insert. Returns the created record(s) with all columns.',
      inputSchema: {
        table: z.string().describe("Table route path (e.g., 'users')"),
        data: z.union([
          z.record(z.string(), z.unknown()),
          z.array(z.record(z.string(), z.unknown())).min(1).max(config.maxBulkInsertRows),
        ]).describe('Record data (object or array of objects for bulk insert)'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ table: routePath, data }) => {
      const table = findTableByRoutePath(dbSchema, routePath)
      if (!table) return errorResult(`Table '${routePath}' not found`)

      try {
        checkPermission(permissions, table.schema, 'w')

        if (Array.isArray(data)) {
          const result = await pool.query(buildBulkInsertQuery(table, data))
          return textResult({ data: result.rows, count: result.rows.length })
        }
        const result = await pool.query(buildInsertQuery(table, data))
        return textResult(result.rows[0])
      } catch (error) {
        return errorResult(formatPgError(error))
      }
    }
  )

  // ── update_record ──
  server.registerTool(
    'update_record',
    {
      title: 'Update Record',
      description:
        'Update an existing record by primary key. Only provide the fields you want to change (partial update). ' +
        'Primary key columns cannot be updated. Returns the full updated record.',
      inputSchema: {
        table: z.string().describe("Table route path (e.g., 'users')"),
        id: z.string().describe('Primary key value (comma-separated for composite keys)'),
        data: z.record(z.string(), z.unknown()).describe('Fields to update (partial — only include changed fields)'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ table: routePath, id, data }) => {
      const table = findTableByRoutePath(dbSchema, routePath)
      if (!table) return errorResult(`Table '${routePath}' not found`)

      if (table.primaryKeys.length === 0) {
        return errorResult(`Table '${routePath}' has no primary key — cannot update by PK`)
      }

      try {
        checkPermission(permissions, table.schema, 'w')
        const pkValues = parsePkValues(table, id)
        const result = await pool.query(buildUpdateQuery(table, pkValues, data))

        if (result.rows.length === 0) {
          return errorResult('Record not found')
        }

        return textResult(result.rows[0])
      } catch (error) {
        return errorResult(formatPgError(error))
      }
    }
  )

  // ── delete_record ──
  server.registerTool(
    'delete_record',
    {
      title: 'Delete Record',
      description:
        "Delete a record by primary key. Tables with a 'deleted_at' column are soft-deleted " +
        '(the column is set to the current timestamp instead of removing the row). ' +
        'Returns the affected record.',
      inputSchema: {
        table: z.string().describe("Table route path (e.g., 'users')"),
        id: z.string().describe('Primary key value (comma-separated for composite keys)'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ table: routePath, id }) => {
      const table = findTableByRoutePath(dbSchema, routePath)
      if (!table) return errorResult(`Table '${routePath}' not found`)

      if (table.primaryKeys.length === 0) {
        return errorResult(`Table '${routePath}' has no primary key — cannot delete by PK`)
      }

      try {
        checkPermission(permissions, table.schema, 'w')
        const pkValues = parsePkValues(table, id)
        const result = await pool.query(buildDeleteQuery(table, pkValues))

        if (result.rows.length === 0) {
          return errorResult('Record not found')
        }

        return textResult({ deleted: true, softDelete: hasSoftDelete(table), record: result.rows[0] })
      } catch (error) {
        return errorResult(formatPgError(error))
      }
    }
  )
}

// ─── Resource Registration ───────────────────────────────────────────

function registerResources (
  server: McpServer,
  dbSchema: DatabaseSchema,
  permissions: SchemaPermissions | null
): void {
  // ── Full database schema ──
  server.registerResource(
    'database-schema',
    'db://schema',
    {
      title: 'Database Schema',
      description: 'Complete database schema including all accessible tables, columns, types, relationships, and API usage information.',
      mimeType: 'application/json',
    },
    async () => {
      const api = buildApiInfo()
      const tables = getAccessibleTables(dbSchema, permissions).map((t) =>
        buildAgentTable(t, dbSchema.tables)
      )

      return {
        contents: [{
          uri: 'db://schema',
          mimeType: 'application/json',
          text: JSON.stringify({ api, tables }, null, 2),
        }],
      }
    }
  )

  // ── Per-table schema ──
  const tableList = getAccessibleTables(dbSchema, permissions)

  server.registerResource(
    'table-schema',
    new ResourceTemplate('db://tables/{table}', {
      list: async () => ({
        resources: tableList.map((t) => ({
          uri: `db://tables/${t.routePath}`,
          name: t.name,
          description: `Schema for ${t.fqn}`,
          mimeType: 'application/json',
        })),
      }),
    }),
    {
      title: 'Table Schema',
      description: 'Detailed schema for a specific table including columns, types, constraints, and relationships.',
      mimeType: 'application/json',
    },
    async (uri, { table: routePath }) => {
      const table = findTableByRoutePath(dbSchema, routePath as string)
      if (!table || !hasAnyPermission(permissions, table.schema)) {
        return {
          contents: [{
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify({ error: `Table '${routePath}' not found` }),
          }],
        }
      }

      const agentTable = buildAgentTable(table, dbSchema.tables)

      return {
        contents: [{
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(agentTable, null, 2),
        }],
      }
    }
  )
}

// ─── Prompt Registration ─────────────────────────────────────────────

function registerPrompts (
  server: McpServer,
  dbSchema: DatabaseSchema,
  permissions: SchemaPermissions | null
): void {
  // ── explore-database ──
  server.registerPrompt(
    'explore-database',
    {
      title: 'Explore Database',
      description: 'Get an overview of the database and guidance on how to explore it using the available tools.',
    },
    async () => {
      const tables = getAccessibleTables(dbSchema, permissions)
      const tableNames = tables.map((t) =>
        t.schema === 'public' ? t.name : `${t.schema}.${t.name}`
      )

      return {
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text:
              `I have access to a PostgreSQL database with ${tables.length} tables: ${tableNames.join(', ')}.\n\n` +
              'Available tools:\n' +
              '- list_tables: Discover all tables with basic metadata\n' +
              '- describe_table: Get detailed column/type/FK info for a table\n' +
              '- list_records: Query records with filtering, pagination, sorting, and search\n' +
              '- get_record: Fetch a single record by primary key\n' +
              '- create_record: Insert new records\n' +
              '- update_record: Update existing records by primary key\n' +
              '- delete_record: Remove records by primary key\n\n' +
              'Please start by understanding the database structure, then help me work with the data.',
          },
        }],
      }
    }
  )

  // ── crud-guide ──
  server.registerPrompt(
    'crud-guide',
    {
      title: 'CRUD Operations Guide',
      description: 'Get a detailed guide for performing CRUD operations on a specific table.',
      argsSchema: {
        table: z.string().describe("Table route path (e.g., 'users' or 'reporting__metrics')"),
      },
    },
    async ({ table: routePath }) => {
      const table = findTableByRoutePath(dbSchema, routePath)
      if (!table || !hasAnyPermission(permissions, table.schema)) {
        return {
          messages: [{
            role: 'user',
            content: {
              type: 'text',
              text: `Table '${routePath}' not found. Use list_tables to discover available tables.`,
            },
          }],
        }
      }

      const hasPk = table.primaryKeys.length > 0
      const searchableCols = table.columns
        .filter((c) => SEARCHABLE_TYPES.has(c.udtName))
        .map((c) => c.name)
      const requiredInsertCols = table.columns
        .filter((c) => !c.isNullable && !c.hasDefault)
        .map((c) => `${c.name} (${c.dataType})`)

      const operations = [`- LIST: list_records with table="${routePath}"`]
      if (hasPk) {
        operations.push(`- GET: get_record with table="${routePath}" and id="<pk_value>"`)
      }
      operations.push(`- CREATE: create_record with table="${routePath}" and data={...}`)
      if (hasPk) {
        operations.push(`- UPDATE: update_record with table="${routePath}", id="<pk_value>", data={...}`)
        operations.push(`- DELETE: delete_record with table="${routePath}" and id="<pk_value>"`)
      }

      const fkInfo = table.foreignKeys.length > 0
        ? `\nForeign keys:\n${table.foreignKeys.map((fk) => `  - ${fk.column} → ${fk.refSchema}.${fk.refTable}.${fk.refColumn}`).join('\n')}`
        : ''

      const searchInfo = searchableCols.length > 0
        ? `\nSearchable columns: ${searchableCols.join(', ')}\nUse the 'search' parameter in list_records for full-text search.`
        : ''

      return {
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text:
              `Guide for table "${table.schema}"."${table.name}" (route: ${routePath}):\n\n` +
              `Primary keys: ${hasPk ? table.primaryKeys.join(', ') : 'NONE (read/list only)'}\n` +
              `Columns: ${table.columns.length}\n` +
              `Required for insert: ${requiredInsertCols.length > 0 ? requiredInsertCols.join(', ') : 'none (all have defaults or are nullable)'}` +
              fkInfo + searchInfo +
              `\n\nAvailable operations:\n${operations.join('\n')}\n\n` +
              'Filter examples for list_records:\n' +
              '  filters: { "status": "eq:active" }     — exact match\n' +
              '  filters: { "age": "gte:18" }            — greater than or equal\n' +
              '  filters: { "name": "ilike:%john%" }     — case-insensitive pattern match\n' +
              '  filters: { "id": "in:1,2,3" }           — match any value in list\n' +
              '  filters: { "deleted_at": "is:null" }    — null check',
          },
        }],
      }
    }
  )
}
