import { FastifyInstance } from "fastify";
import { DatabaseSchema, TableInfo, ColumnInfo } from "../db/introspector.js";
import { config } from "../config.js";
import { hasAnyPermission } from "../auth/api-key.js";

// ─── Type Mapping ────────────────────────────────────────────────────

interface AgentColumnType {
  type: string;
  format?: string;
  items?: { type: string; format?: string };
}

export function mapPgType(col: ColumnInfo): AgentColumnType {
  switch (col.udtName) {
    // Integers
    case "int2":
    case "int4":
    case "serial":
    case "int8":
    case "bigserial":
    case "oid":
      return { type: "integer" };

    // Floats
    case "float4":
    case "float8":
    case "numeric":
    case "decimal":
    case "money":
      return { type: "number" };

    // Boolean
    case "bool":
      return { type: "boolean" };

    // JSON
    case "json":
    case "jsonb":
      return { type: "object" };

    // Strings with format
    case "uuid":
      return { type: "string", format: "uuid" };
    case "date":
      return { type: "string", format: "date" };
    case "timestamp":
    case "timestamptz":
      return { type: "string", format: "date-time" };
    case "time":
    case "timetz":
      return { type: "string", format: "time" };
    case "bytea":
      return { type: "string", format: "byte" };

    // Integer arrays
    case "_int2":
    case "_int4":
    case "_int8":
      return { type: "array", items: { type: "integer" } };

    // Float arrays
    case "_float4":
    case "_float8":
    case "_numeric":
      return { type: "array", items: { type: "number" } };

    // Boolean arrays
    case "_bool":
      return { type: "array", items: { type: "boolean" } };

    // String arrays
    case "_text":
    case "_varchar":
    case "_char":
    case "_name":
      return { type: "array", items: { type: "string" } };

    // UUID arrays
    case "_uuid":
      return { type: "array", items: { type: "string", format: "uuid" } };

    // JSON arrays
    case "_json":
    case "_jsonb":
      return { type: "array", items: { type: "object" } };

    // Everything else → string
    default:
      return { type: "string" };
  }
}

// ─── Schema Builders ─────────────────────────────────────────────────

const SEARCHABLE_TYPES = new Set(["varchar", "text", "char", "name"]);

export function buildAgentColumn(col: ColumnInfo, table: TableInfo) {
  const mapped = mapPgType(col);
  const isPk = table.primaryKeys.includes(col.name);

  const result: Record<string, unknown> = {
    name: col.name,
    type: mapped.type,
    nullable: col.isNullable,
    hasDefault: col.hasDefault,
  };

  if (mapped.format) result.format = mapped.format;
  if (mapped.items) result.items = mapped.items;
  if (isPk) result.pk = true;
  if (!col.isNullable && !col.hasDefault) result.insertRequired = true;
  if (col.maxLength) result.maxLength = col.maxLength;

  return result;
}

export function buildAgentTable(table: TableInfo, allTables: Map<string, TableInfo>) {
  const hasPk = table.primaryKeys.length > 0;
  const operations = ["list", "create"];
  if (hasPk) operations.push("read", "update", "replace", "delete");

  return {
    name: table.name,
    schema: table.schema,
    path: `/api/${table.routePath}`,
    operations,
    primaryKeys: table.primaryKeys,
    columns: table.columns.map((col) => buildAgentColumn(col, table)),
    foreignKeys: table.foreignKeys.map((fk) => {
      const refRoutePath = fk.refSchema === "public"
        ? fk.refTable
        : `${fk.refSchema}__${fk.refTable}`;
      return {
        column: fk.column,
        references: `${fk.refTable}.${fk.refColumn}`,
        refPath: `/api/${refRoutePath}`,
      };
    }),
    searchableColumns: table.columns
      .filter((c) => SEARCHABLE_TYPES.has(c.udtName))
      .map((c) => c.name),
  };
}

export function buildApiInfo() {
  return {
    baseUrl: "/api",
    auth: {
      enabled: config.apiKeysEnabled,
      methods: config.apiKeysEnabled ? ["Bearer", "X-API-Key"] : [],
      keyFormat: "pgcrud_{label}.{hmac}",
      publicPaths: ["/api/_health", "/docs"],
    },
    pagination: {
      defaultPageSize: config.defaultPageSize,
      maxPageSize: config.maxPageSize,
    },
    filtering: {
      paramPattern: "filter.{column}={operator}:{value}",
      operators: ["eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike", "is", "in"],
    },
    sorting: {
      params: ["sortBy", "sortOrder"],
      orders: ["asc", "desc"],
    },
    search: {
      params: ["search", "searchColumns"],
      description: "ILIKE full-text search on text columns. searchColumns is optional comma-separated list; defaults to all text/varchar columns.",
    },
    columnSelection: {
      param: "select",
      description: "Comma-separated column names to return",
    },
    bulkInsert: {
      maxRows: config.maxBulkInsertRows,
      description: "POST an array of objects to insert multiple rows",
    },
  };
}

// ─── Route Registration ──────────────────────────────────────────────

export async function registerSchemaRoutes(
  app: FastifyInstance,
  dbSchema: DatabaseSchema,
): Promise<void> {
  // Build and cache the full response once
  const api = buildApiInfo();
  const tables = Array.from(dbSchema.tables.values()).map((t) =>
    buildAgentTable(t, dbSchema.tables),
  );

  // Build lookup map for per-table endpoint
  const tableMap = new Map<string, ReturnType<typeof buildAgentTable>>();
  for (const t of tables) {
    // routePath is the last segment of the path
    const routePath = t.path.replace("/api/", "");
    tableMap.set(routePath, t);
  }

  app.get("/api/_schema", {
    schema: { hide: true },
    handler: async (request) => {
      const filtered = tables.filter((t) => hasAnyPermission(request.apiKeyPermissions, t.schema));
      return { api, tables: filtered };
    },
  });

  app.get("/api/_schema/:table", {
    schema: { hide: true },
    handler: async (request, reply) => {
      const { table: routePath } = request.params as { table: string };
      const tableSchema = tableMap.get(routePath);
      if (!tableSchema || !hasAnyPermission(request.apiKeyPermissions, tableSchema.schema)) {
        return reply.status(404).send({ error: `Table '${routePath}' not found` });
      }
      return { api, table: tableSchema };
    },
  });
}
