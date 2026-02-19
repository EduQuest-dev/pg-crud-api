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

// ─── Introspect ──────────────────────────────────────────────────────

export async function introspectDatabase(pool: Pool): Promise<DatabaseSchema> {
  // 1. Determine which schemas to scan
  const allSchemas = await pool.query(SCHEMAS_QUERY);
  let targetSchemas: string[] = allSchemas.rows.map((r) => r.schema_name);

  // Filter to only requested schemas if configured
  if (config.schemas.length > 0) {
    targetSchemas = targetSchemas.filter((s) => config.schemas.includes(s));
  }

  // Remove system schemas, temp schemas, and excluded schemas
  const excluded = new Set([...SYSTEM_SCHEMAS, ...config.excludeSchemas]);
  targetSchemas = targetSchemas.filter(
    (s) => !excluded.has(s) && !s.startsWith("pg_temp") && !s.startsWith("pg_toast_temp")
  );

  if (targetSchemas.length === 0) {
    throw new Error("No schemas found to introspect. Check your SCHEMAS and EXCLUDE_SCHEMAS config.");
  }

  console.log(`📦 Introspecting schemas: ${targetSchemas.join(", ")}`);

  // 2. Fetch columns, PKs, FKs in parallel
  const [colResult, pkResult, fkResult] = await Promise.all([
    pool.query(COLUMNS_QUERY, [targetSchemas]),
    pool.query(PRIMARY_KEYS_QUERY, [targetSchemas]),
    pool.query(FOREIGN_KEYS_QUERY, [targetSchemas]),
  ]);

  // 3. Build table map
  const tables = new Map<string, TableInfo>();
  const excludedTables = new Set(config.excludeTables);

  for (const row of colResult.rows) {
    const fqn = `"${row.table_schema}"."${row.table_name}"`;
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

  // 4. Attach primary keys
  for (const row of pkResult.rows) {
    const fqn = `"${row.table_schema}"."${row.table_name}"`;
    const table = tables.get(fqn);
    if (table) {
      table.primaryKeys.push(row.column_name);
    }
  }

  // 5. Attach foreign keys
  for (const row of fkResult.rows) {
    const fqn = `"${row.table_schema}"."${row.table_name}"`;
    const table = tables.get(fqn);
    if (table) {
      table.foreignKeys.push({
        constraintName: row.constraint_name,
        column: row.column_name,
        refSchema: row.ref_schema,
        refTable: row.ref_table,
        refColumn: row.ref_column,
      });
    }
  }

  // 6. Warn about tables without primary keys and dangling FK references
  for (const [fqn, table] of tables) {
    if (table.primaryKeys.length === 0) {
      console.warn(`⚠️  Table ${fqn} has no primary key — update/delete by PK disabled`);
    }
    for (const fk of table.foreignKeys) {
      const refFqn = `"${fk.refSchema}"."${fk.refTable}"`;
      if (!tables.has(refFqn)) {
        console.warn(`⚠️  ${fqn}.${fk.column} references ${refFqn} which is outside the introspection scope`);
      }
    }
  }

  console.log(`✅ Found ${tables.size} tables across ${targetSchemas.length} schemas`);
  return { tables, schemas: targetSchemas };
}
