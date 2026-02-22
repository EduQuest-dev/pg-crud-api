import { createHash } from "node:crypto";
import { Pool } from "pg";
import { config, SYSTEM_SCHEMAS } from "../config.js";

// ─── Types ───────────────────────────────────────────────────────────

export interface ColumnInfo {
  name: string;
  dataType: string;
  udtName: string;
  isNullable: boolean;
  hasDefault: boolean;
  defaultValue: string | null;
  maxLength: number | null;
  ordinalPosition: number;
}

export interface ForeignKey {
  constraintName: string;
  column: string;
  refSchema: string;
  refTable: string;
  refColumn: string;
}

export interface TableInfo {
  schema: string;
  name: string;
  columns: ColumnInfo[];
  primaryKeys: string[];
  foreignKeys: ForeignKey[];
  /** Fully qualified name: "schema"."table" */
  fqn: string;
  /** URL-safe path segment: schema__table (or just table for public) */
  routePath: string;
}

export interface DatabaseSchema {
  tables: Map<string, TableInfo>; // keyed by fqn
  schemas: string[];
}

// ─── Introspection Queries ───────────────────────────────────────────

const COLUMNS_QUERY = `
  SELECT
    c.table_schema,
    c.table_name,
    c.column_name,
    c.data_type,
    c.udt_name,
    c.is_nullable,
    c.column_default,
    c.character_maximum_length,
    c.ordinal_position
  FROM information_schema.columns c
  JOIN information_schema.tables t
    ON c.table_schema = t.table_schema AND c.table_name = t.table_name
  WHERE t.table_type = 'BASE TABLE'
    AND c.table_schema = ANY($1)
  ORDER BY c.table_schema, c.table_name, c.ordinal_position;
`;

const PRIMARY_KEYS_QUERY = `
  SELECT
    kcu.table_schema,
    kcu.table_name,
    kcu.column_name,
    kcu.ordinal_position
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name
    AND tc.table_schema = kcu.table_schema
  WHERE tc.constraint_type = 'PRIMARY KEY'
    AND tc.table_schema = ANY($1)
  ORDER BY kcu.table_schema, kcu.table_name, kcu.ordinal_position;
`;

const FOREIGN_KEYS_QUERY = `
  SELECT DISTINCT ON (tc.table_schema, tc.table_name, kcu.column_name, tc.constraint_name)
    tc.table_schema,
    tc.table_name,
    kcu.column_name,
    tc.constraint_name,
    ccu.table_schema AS ref_schema,
    ccu.table_name AS ref_table,
    ccu.column_name AS ref_column
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name
    AND tc.table_schema = kcu.table_schema
  JOIN information_schema.constraint_column_usage ccu
    ON tc.constraint_name = ccu.constraint_name
    AND tc.table_schema = ccu.table_schema
  WHERE tc.constraint_type = 'FOREIGN KEY'
    AND tc.table_schema = ANY($1)
  ORDER BY tc.table_schema, tc.table_name, kcu.column_name, tc.constraint_name;
`;

const SCHEMAS_QUERY = `
  SELECT schema_name
  FROM information_schema.schemata
  WHERE schema_name NOT LIKE 'pg_%'
    AND schema_name != 'information_schema'
  ORDER BY schema_name;
`;

// ─── Helper Functions ────────────────────────────────────────────────

function makeFqn(schema: string, table: string): string {
  return `"${schema}"."${table}"`;
}

function resolveTargetSchemas(allSchemaNames: string[]): string[] {
  let targetSchemas = allSchemaNames;

  if (config.schemas.length > 0) {
    targetSchemas = targetSchemas.filter((s) => config.schemas.includes(s));
  }

  const excluded = new Set([...SYSTEM_SCHEMAS, ...config.excludeSchemas]);
  targetSchemas = targetSchemas.filter(
    (s) => !excluded.has(s) && !s.startsWith("pg_temp") && !s.startsWith("pg_toast_temp")
  );

  if (targetSchemas.length === 0) {
    throw new Error("No schemas found to introspect. Check your SCHEMAS and EXCLUDE_SCHEMAS config.");
  }

  return targetSchemas;
}

function buildTableMap(colRows: any[]): Map<string, TableInfo> {
  const tables = new Map<string, TableInfo>();
  const excludedTables = new Set(config.excludeTables);

  for (const row of colRows) {
    const fqn = makeFqn(row.table_schema, row.table_name);
    const tableKey = `${row.table_schema}.${row.table_name}`;

    if (excludedTables.has(tableKey)) continue;

    if (!tables.has(fqn)) {
      const routePath =
        row.table_schema === "public"
          ? row.table_name
          : `${row.table_schema}__${row.table_name}`;

      tables.set(fqn, {
        schema: row.table_schema,
        name: row.table_name,
        columns: [],
        primaryKeys: [],
        foreignKeys: [],
        fqn,
        routePath,
      });
    }

    tables.get(fqn)!.columns.push({
      name: row.column_name,
      dataType: row.data_type,
      udtName: row.udt_name,
      isNullable: row.is_nullable === "YES",
      hasDefault: row.column_default !== null,
      defaultValue: row.column_default,
      maxLength: row.character_maximum_length,
      ordinalPosition: row.ordinal_position,
    });
  }

  return tables;
}

function attachPrimaryKeys(tables: Map<string, TableInfo>, pkRows: any[]): void {
  for (const row of pkRows) {
    const table = tables.get(makeFqn(row.table_schema, row.table_name));
    table?.primaryKeys.push(row.column_name);
  }
}

function attachForeignKeys(tables: Map<string, TableInfo>, fkRows: any[]): void {
  for (const row of fkRows) {
    const table = tables.get(makeFqn(row.table_schema, row.table_name));
    table?.foreignKeys.push({
      constraintName: row.constraint_name,
      column: row.column_name,
      refSchema: row.ref_schema,
      refTable: row.ref_table,
      refColumn: row.ref_column,
    });
  }
}

function warnTableIssues(tables: Map<string, TableInfo>): void {
  for (const [fqn, table] of tables) {
    if (table.primaryKeys.length === 0) {
      console.warn(`⚠️  Table ${fqn} has no primary key — update/delete by PK disabled`);
    }
    for (const fk of table.foreignKeys) {
      const refFqn = makeFqn(fk.refSchema, fk.refTable);
      if (!tables.has(refFqn)) {
        console.warn(`⚠️  ${fqn}.${fk.column} references ${refFqn} which is outside the introspection scope`);
      }
    }
  }
}

// ─── Database Hash ───────────────────────────────────────────────────

/**
 * Compute a deterministic SHA-256 hash of the full database schema.
 * Useful for detecting schema changes between deployments / restarts.
 * The hash covers schemas, tables, columns (name, type, nullability,
 * defaults, max length, ordinal position), primary keys, and foreign keys.
 */
export function computeDatabaseHash(schema: DatabaseSchema): string {
  const canonical: unknown[] = [];

  // Sort schemas for determinism
  const sortedSchemas = [...schema.schemas].sort((a, b) => a.localeCompare(b));
  canonical.push(sortedSchemas);

  // Sort tables by fqn and serialize each table's structure
  const sortedTables = Array.from(schema.tables.values()).sort((a, b) =>
    a.fqn.localeCompare(b.fqn)
  );

  for (const table of sortedTables) {
    canonical.push({
      schema: table.schema,
      name: table.name,
      fqn: table.fqn,
      columns: table.columns
        .slice()
        .sort((a, b) => a.ordinalPosition - b.ordinalPosition)
        .map((c) => ({
          name: c.name,
          dataType: c.dataType,
          udtName: c.udtName,
          isNullable: c.isNullable,
          hasDefault: c.hasDefault,
          defaultValue: c.defaultValue,
          maxLength: c.maxLength,
          ordinalPosition: c.ordinalPosition,
        })),
      primaryKeys: [...table.primaryKeys].sort((a, b) => a.localeCompare(b)),
      foreignKeys: table.foreignKeys
        .slice()
        .sort((a, b) => a.constraintName.localeCompare(b.constraintName))
        .map((fk) => ({
          constraintName: fk.constraintName,
          column: fk.column,
          refSchema: fk.refSchema,
          refTable: fk.refTable,
          refColumn: fk.refColumn,
        })),
    });
  }

  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

// ─── Introspect ──────────────────────────────────────────────────────

export async function introspectDatabase(pool: Pool): Promise<DatabaseSchema> {
  const allSchemas = await pool.query(SCHEMAS_QUERY);
  const targetSchemas = resolveTargetSchemas(allSchemas.rows.map((r) => r.schema_name));

  console.log(`📦 Introspecting schemas: ${targetSchemas.join(", ")}`);

  const [colResult, pkResult, fkResult] = await Promise.all([
    pool.query(COLUMNS_QUERY, [targetSchemas]),
    pool.query(PRIMARY_KEYS_QUERY, [targetSchemas]),
    pool.query(FOREIGN_KEYS_QUERY, [targetSchemas]),
  ]);

  const tables = buildTableMap(colResult.rows);
  attachPrimaryKeys(tables, pkResult.rows);
  attachForeignKeys(tables, fkResult.rows);
  warnTableIssues(tables);

  console.log(`✅ Found ${tables.size} tables across ${targetSchemas.length} schemas`);
  return { tables, schemas: targetSchemas };
}
