import type { ColumnInfo, TableInfo, DatabaseSchema, ForeignKey } from "../../src/db/introspector.js";

export function makeColumn(overrides: Partial<ColumnInfo> = {}): ColumnInfo {
  return {
    name: "col",
    dataType: "character varying",
    udtName: "varchar",
    isNullable: false,
    hasDefault: false,
    defaultValue: null,
    maxLength: null,
    ordinalPosition: 1,
    ...overrides,
  };
}

export function makeUsersTable(): TableInfo {
  return {
    schema: "public",
    name: "users",
    fqn: '"public"."users"',
    routePath: "users",
    primaryKeys: ["id"],
    foreignKeys: [],
    columns: [
      makeColumn({ name: "id", dataType: "integer", udtName: "int4", isNullable: false, hasDefault: true, defaultValue: "nextval('users_id_seq'::regclass)", ordinalPosition: 1 }),
      makeColumn({ name: "name", dataType: "character varying", udtName: "varchar", isNullable: false, hasDefault: false, maxLength: 255, ordinalPosition: 2 }),
      makeColumn({ name: "email", dataType: "character varying", udtName: "varchar", isNullable: false, hasDefault: false, maxLength: 255, ordinalPosition: 3 }),
      makeColumn({ name: "active", dataType: "boolean", udtName: "bool", isNullable: true, hasDefault: true, defaultValue: "true", ordinalPosition: 4 }),
    ],
  };
}

export function makeCompositePkTable(): TableInfo {
  return {
    schema: "public",
    name: "user_roles",
    fqn: '"public"."user_roles"',
    routePath: "user_roles",
    primaryKeys: ["user_id", "role_id"],
    foreignKeys: [
      {
        constraintName: "user_roles_user_id_fkey",
        column: "user_id",
        refSchema: "public",
        refTable: "users",
        refColumn: "id",
      },
    ],
    columns: [
      makeColumn({ name: "user_id", dataType: "integer", udtName: "int4", isNullable: false, hasDefault: false, ordinalPosition: 1 }),
      makeColumn({ name: "role_id", dataType: "integer", udtName: "int4", isNullable: false, hasDefault: false, ordinalPosition: 2 }),
      makeColumn({ name: "granted_at", dataType: "timestamp with time zone", udtName: "timestamptz", isNullable: false, hasDefault: true, defaultValue: "now()", ordinalPosition: 3 }),
    ],
  };
}

export function makeNoPkTable(): TableInfo {
  return {
    schema: "public",
    name: "audit_logs",
    fqn: '"public"."audit_logs"',
    routePath: "audit_logs",
    primaryKeys: [],
    foreignKeys: [],
    columns: [
      makeColumn({ name: "event", dataType: "text", udtName: "text", isNullable: false, hasDefault: false, ordinalPosition: 1 }),
      makeColumn({ name: "payload", dataType: "jsonb", udtName: "jsonb", isNullable: true, hasDefault: false, ordinalPosition: 2 }),
      makeColumn({ name: "created_at", dataType: "timestamp with time zone", udtName: "timestamptz", isNullable: false, hasDefault: true, defaultValue: "now()", ordinalPosition: 3 }),
    ],
  };
}

export function makeNonPublicSchemaTable(): TableInfo {
  return {
    schema: "reporting",
    name: "metrics",
    fqn: '"reporting"."metrics"',
    routePath: "reporting__metrics",
    primaryKeys: ["id"],
    foreignKeys: [],
    columns: [
      makeColumn({ name: "id", dataType: "integer", udtName: "int4", isNullable: false, hasDefault: true, defaultValue: "nextval('reporting.metrics_id_seq'::regclass)", ordinalPosition: 1 }),
      makeColumn({ name: "metric_name", dataType: "character varying", udtName: "varchar", isNullable: false, hasDefault: false, maxLength: 100, ordinalPosition: 2 }),
      makeColumn({ name: "value", dataType: "numeric", udtName: "numeric", isNullable: false, hasDefault: false, ordinalPosition: 3 }),
    ],
  };
}

export function makeTableWithForeignKeys(): TableInfo {
  return {
    schema: "public",
    name: "orders",
    fqn: '"public"."orders"',
    routePath: "orders",
    primaryKeys: ["id"],
    foreignKeys: [
      {
        constraintName: "orders_user_id_fkey",
        column: "user_id",
        refSchema: "public",
        refTable: "users",
        refColumn: "id",
      },
    ],
    columns: [
      makeColumn({ name: "id", dataType: "integer", udtName: "int4", isNullable: false, hasDefault: true, defaultValue: "nextval('orders_id_seq'::regclass)", ordinalPosition: 1 }),
      makeColumn({ name: "user_id", dataType: "integer", udtName: "int4", isNullable: false, hasDefault: false, ordinalPosition: 2 }),
      makeColumn({ name: "total", dataType: "numeric", udtName: "numeric", isNullable: false, hasDefault: false, ordinalPosition: 3 }),
      makeColumn({ name: "status", dataType: "character varying", udtName: "varchar", isNullable: false, hasDefault: true, defaultValue: "'pending'::character varying", maxLength: 50, ordinalPosition: 4 }),
    ],
  };
}

export function makeTableWithNonPublicFk(): TableInfo {
  return {
    schema: "public",
    name: "reports",
    fqn: '"public"."reports"',
    routePath: "reports",
    primaryKeys: ["id"],
    foreignKeys: [
      {
        constraintName: "reports_metric_id_fkey",
        column: "metric_id",
        refSchema: "reporting",
        refTable: "metrics",
        refColumn: "id",
      },
    ],
    columns: [
      makeColumn({ name: "id", dataType: "integer", udtName: "int4", isNullable: false, hasDefault: true, defaultValue: "nextval('reports_id_seq'::regclass)", ordinalPosition: 1 }),
      makeColumn({ name: "metric_id", dataType: "integer", udtName: "int4", isNullable: false, hasDefault: false, ordinalPosition: 2 }),
      makeColumn({ name: "note", dataType: "text", udtName: "text", isNullable: true, hasDefault: false, ordinalPosition: 3 }),
    ],
  };
}

export function makeDatabaseSchema(tables: TableInfo[]): DatabaseSchema {
  const map = new Map<string, TableInfo>();
  const schemas = new Set<string>();
  for (const t of tables) {
    map.set(t.fqn, t);
    schemas.add(t.schema);
  }
  return { tables: map, schemas: Array.from(schemas) };
}
