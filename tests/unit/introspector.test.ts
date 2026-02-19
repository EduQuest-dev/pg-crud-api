import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/config.js", () => ({
  config: {
    schemas: [] as string[],
    excludeSchemas: [] as string[],
    excludeTables: [] as string[],
  },
  SYSTEM_SCHEMAS: ["pg_catalog", "information_schema", "pg_toast"],
}));

import { introspectDatabase } from "../../src/db/introspector.js";
import { config } from "../../src/config.js";

// ─── Mock Pool Helpers ──────────────────────────────────────────────

function makeMockPool(responses: {
  schemas?: { schema_name: string }[];
  columns?: Record<string, unknown>[];
  primaryKeys?: Record<string, unknown>[];
  foreignKeys?: Record<string, unknown>[];
}) {
  const schemasRows = responses.schemas ?? [{ schema_name: "public" }];
  const columnsRows = responses.columns ?? [];
  const pkRows = responses.primaryKeys ?? [];
  const fkRows = responses.foreignKeys ?? [];

  const query = vi.fn()
    // 1st call: SCHEMAS_QUERY
    .mockResolvedValueOnce({ rows: schemasRows, rowCount: schemasRows.length })
    // 2nd–4th calls: COLUMNS, PKs, FKs (via Promise.all)
    .mockResolvedValueOnce({ rows: columnsRows, rowCount: columnsRows.length })
    .mockResolvedValueOnce({ rows: pkRows, rowCount: pkRows.length })
    .mockResolvedValueOnce({ rows: fkRows, rowCount: fkRows.length });

  return { query } as any;
}

function colRow(schema: string, table: string, column: string, overrides: Record<string, unknown> = {}) {
  return {
    table_schema: schema,
    table_name: table,
    column_name: column,
    data_type: "character varying",
    udt_name: "varchar",
    is_nullable: "NO",
    column_default: null,
    character_maximum_length: null,
    ordinal_position: 1,
    ...overrides,
  };
}

function pkRow(schema: string, table: string, column: string) {
  return {
    table_schema: schema,
    table_name: table,
    column_name: column,
    ordinal_position: 1,
  };
}

function fkRow(schema: string, table: string, column: string, ref: { schema: string; table: string; column: string; constraint?: string }) {
  return {
    table_schema: schema,
    table_name: table,
    column_name: column,
    constraint_name: ref.constraint ?? `${table}_${column}_fkey`,
    ref_schema: ref.schema,
    ref_table: ref.table,
    ref_column: ref.column,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("introspectDatabase", () => {
  beforeEach(() => {
    (config as any).schemas = [];
    (config as any).excludeSchemas = [];
    (config as any).excludeTables = [];
    vi.restoreAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  // ── Basic table discovery ──

  it("discovers a single table with columns", async () => {
    const pool = makeMockPool({
      columns: [
        colRow("public", "users", "id", { data_type: "integer", udt_name: "int4", column_default: "nextval('users_id_seq')", ordinal_position: 1 }),
        colRow("public", "users", "name", { ordinal_position: 2 }),
      ],
      primaryKeys: [pkRow("public", "users", "id")],
    });

    const result = await introspectDatabase(pool);
    expect(result.tables.size).toBe(1);
    expect(result.schemas).toEqual(["public"]);

    const users = result.tables.get('"public"."users"')!;
    expect(users.name).toBe("users");
    expect(users.schema).toBe("public");
    expect(users.fqn).toBe('"public"."users"');
    expect(users.routePath).toBe("users");
    expect(users.columns).toHaveLength(2);
    expect(users.primaryKeys).toEqual(["id"]);
  });

  it("parses column metadata correctly", async () => {
    const pool = makeMockPool({
      columns: [
        colRow("public", "users", "email", {
          data_type: "character varying",
          udt_name: "varchar",
          is_nullable: "YES",
          column_default: "'test@example.com'",
          character_maximum_length: 255,
          ordinal_position: 3,
        }),
      ],
    });

    const result = await introspectDatabase(pool);
    const users = result.tables.get('"public"."users"')!;
    const emailCol = users.columns[0];

    expect(emailCol.name).toBe("email");
    expect(emailCol.dataType).toBe("character varying");
    expect(emailCol.udtName).toBe("varchar");
    expect(emailCol.isNullable).toBe(true);
    expect(emailCol.hasDefault).toBe(true);
    expect(emailCol.defaultValue).toBe("'test@example.com'");
    expect(emailCol.maxLength).toBe(255);
    expect(emailCol.ordinalPosition).toBe(3);
  });

  it("sets isNullable to false when is_nullable is NO", async () => {
    const pool = makeMockPool({
      columns: [colRow("public", "t", "c", { is_nullable: "NO" })],
    });
    const result = await introspectDatabase(pool);
    expect(result.tables.get('"public"."t"')!.columns[0].isNullable).toBe(false);
  });

  it("sets hasDefault to false when column_default is null", async () => {
    const pool = makeMockPool({
      columns: [colRow("public", "t", "c", { column_default: null })],
    });
    const result = await introspectDatabase(pool);
    expect(result.tables.get('"public"."t"')!.columns[0].hasDefault).toBe(false);
  });

  // ── Multiple tables ──

  it("discovers multiple tables", async () => {
    const pool = makeMockPool({
      columns: [
        colRow("public", "users", "id"),
        colRow("public", "orders", "id"),
      ],
      primaryKeys: [
        pkRow("public", "users", "id"),
        pkRow("public", "orders", "id"),
      ],
    });

    const result = await introspectDatabase(pool);
    expect(result.tables.size).toBe(2);
    expect(result.tables.has('"public"."users"')).toBe(true);
    expect(result.tables.has('"public"."orders"')).toBe(true);
  });

  // ── Composite PK ──

  it("discovers composite primary keys", async () => {
    const pool = makeMockPool({
      columns: [
        colRow("public", "user_roles", "user_id"),
        colRow("public", "user_roles", "role_id"),
      ],
      primaryKeys: [
        pkRow("public", "user_roles", "user_id"),
        pkRow("public", "user_roles", "role_id"),
      ],
    });

    const result = await introspectDatabase(pool);
    const table = result.tables.get('"public"."user_roles"')!;
    expect(table.primaryKeys).toEqual(["user_id", "role_id"]);
  });

  // ── Foreign keys ──

  it("discovers foreign keys", async () => {
    const pool = makeMockPool({
      columns: [
        colRow("public", "orders", "id"),
        colRow("public", "orders", "user_id"),
      ],
      foreignKeys: [
        fkRow("public", "orders", "user_id", { schema: "public", table: "users", column: "id" }),
      ],
    });

    const result = await introspectDatabase(pool);
    const orders = result.tables.get('"public"."orders"')!;
    expect(orders.foreignKeys).toHaveLength(1);
    expect(orders.foreignKeys[0]).toEqual({
      constraintName: "orders_user_id_fkey",
      column: "user_id",
      refSchema: "public",
      refTable: "users",
      refColumn: "id",
    });
  });

  // ── Non-public schema ──

  it("uses schema__table routePath for non-public schemas", async () => {
    const pool = makeMockPool({
      schemas: [{ schema_name: "reporting" }],
      columns: [colRow("reporting", "metrics", "id")],
    });

    const result = await introspectDatabase(pool);
    const table = result.tables.get('"reporting"."metrics"')!;
    expect(table.routePath).toBe("reporting__metrics");
    expect(table.schema).toBe("reporting");
  });

  it("uses plain table name as routePath for public schema", async () => {
    const pool = makeMockPool({
      columns: [colRow("public", "users", "id")],
    });

    const result = await introspectDatabase(pool);
    expect(result.tables.get('"public"."users"')!.routePath).toBe("users");
  });

  // ── Schema filtering via config.schemas ──

  it("filters to only config.schemas when set", async () => {
    (config as any).schemas = ["reporting"];

    const pool = makeMockPool({
      schemas: [{ schema_name: "public" }, { schema_name: "reporting" }],
      columns: [colRow("reporting", "metrics", "id")],
    });

    const result = await introspectDatabase(pool);
    expect(result.schemas).toEqual(["reporting"]);
  });

  // ── Excluded schemas ──

  it("excludes schemas in config.excludeSchemas", async () => {
    (config as any).excludeSchemas = ["internal"];

    const pool = makeMockPool({
      schemas: [{ schema_name: "public" }, { schema_name: "internal" }],
      columns: [colRow("public", "users", "id")],
    });

    const result = await introspectDatabase(pool);
    expect(result.schemas).toEqual(["public"]);
  });

  it("excludes system schemas (pg_catalog, information_schema, pg_toast)", async () => {
    const pool = makeMockPool({
      schemas: [
        { schema_name: "public" },
        { schema_name: "pg_catalog" },
        { schema_name: "information_schema" },
        { schema_name: "pg_toast" },
      ],
      columns: [colRow("public", "users", "id")],
    });

    const result = await introspectDatabase(pool);
    expect(result.schemas).toEqual(["public"]);
  });

  it("excludes pg_temp and pg_toast_temp prefixed schemas", async () => {
    const pool = makeMockPool({
      schemas: [
        { schema_name: "public" },
        { schema_name: "pg_temp_3" },
        { schema_name: "pg_toast_temp_3" },
      ],
      columns: [colRow("public", "users", "id")],
    });

    const result = await introspectDatabase(pool);
    expect(result.schemas).toEqual(["public"]);
  });

  // ── Excluded tables ──

  it("excludes tables in config.excludeTables", async () => {
    (config as any).excludeTables = ["public.secrets"];

    const pool = makeMockPool({
      columns: [
        colRow("public", "users", "id"),
        colRow("public", "secrets", "key"),
      ],
    });

    const result = await introspectDatabase(pool);
    expect(result.tables.size).toBe(1);
    expect(result.tables.has('"public"."users"')).toBe(true);
    expect(result.tables.has('"public"."secrets"')).toBe(false);
  });

  // ── No schemas found ──

  it("throws when no schemas found after filtering", async () => {
    (config as any).schemas = ["nonexistent"];

    const pool = makeMockPool({
      schemas: [{ schema_name: "public" }],
    });

    await expect(introspectDatabase(pool)).rejects.toThrow("No schemas found to introspect");
  });

  it("throws when all schemas are excluded", async () => {
    (config as any).excludeSchemas = ["public"];

    const pool = makeMockPool({
      schemas: [{ schema_name: "public" }],
    });

    await expect(introspectDatabase(pool)).rejects.toThrow("No schemas found to introspect");
  });

  // ── Warnings ──

  it("warns about tables without primary keys", async () => {
    const warnSpy = vi.spyOn(console, "warn");
    const pool = makeMockPool({
      columns: [colRow("public", "logs", "message")],
      primaryKeys: [], // no PK
    });

    await introspectDatabase(pool);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("no primary key")
    );
  });

  it("warns about dangling FK references", async () => {
    const warnSpy = vi.spyOn(console, "warn");
    const pool = makeMockPool({
      columns: [colRow("public", "orders", "user_id")],
      foreignKeys: [
        fkRow("public", "orders", "user_id", { schema: "public", table: "users", column: "id" }),
      ],
    });

    // "users" table does NOT exist in introspected tables → dangling FK
    await introspectDatabase(pool);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("outside the introspection scope")
    );
  });

  it("does not warn when FK reference is within scope", async () => {
    const warnSpy = vi.spyOn(console, "warn");
    const pool = makeMockPool({
      columns: [
        colRow("public", "users", "id"),
        colRow("public", "orders", "user_id"),
      ],
      primaryKeys: [pkRow("public", "users", "id")],
      foreignKeys: [
        fkRow("public", "orders", "user_id", { schema: "public", table: "users", column: "id" }),
      ],
    });

    await introspectDatabase(pool);
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("outside the introspection scope")
    );
  });

  // ── PK/FK rows referencing excluded tables are ignored ──

  it("ignores PK rows for tables not in the map", async () => {
    (config as any).excludeTables = ["public.secrets"];

    const pool = makeMockPool({
      columns: [colRow("public", "users", "id")],
      primaryKeys: [
        pkRow("public", "users", "id"),
        pkRow("public", "secrets", "id"), // table excluded
      ],
    });

    const result = await introspectDatabase(pool);
    expect(result.tables.size).toBe(1);
    // Should not throw or crash
  });

  it("ignores FK rows for tables not in the map", async () => {
    (config as any).excludeTables = ["public.secrets"];

    const pool = makeMockPool({
      columns: [colRow("public", "users", "id")],
      foreignKeys: [
        fkRow("public", "secrets", "user_id", { schema: "public", table: "users", column: "id" }),
      ],
    });

    const result = await introspectDatabase(pool);
    expect(result.tables.size).toBe(1);
    // Should not throw or crash
  });

  // ── Query arguments ──

  it("passes target schemas to column/PK/FK queries", async () => {
    const pool = makeMockPool({
      schemas: [{ schema_name: "public" }, { schema_name: "reporting" }],
      columns: [],
    });

    // Need to re-mock to capture calls with resolved value for the parallel queries
    pool.query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ schema_name: "public" }, { schema_name: "reporting" }], rowCount: 2 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await introspectDatabase(pool);

    // Calls 2–4 should receive the target schemas array
    const call2 = pool.query.mock.calls[1];
    const call3 = pool.query.mock.calls[2];
    const call4 = pool.query.mock.calls[3];
    expect(call2[1]).toEqual([["public", "reporting"]]);
    expect(call3[1]).toEqual([["public", "reporting"]]);
    expect(call4[1]).toEqual([["public", "reporting"]]);
  });

  // ── Logging ──

  it("logs introspection summary", async () => {
    const logSpy = vi.spyOn(console, "log");
    const pool = makeMockPool({
      columns: [colRow("public", "users", "id")],
    });

    await introspectDatabase(pool);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Introspecting schemas"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Found 1 tables"));
  });
});
