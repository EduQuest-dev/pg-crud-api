import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/config.js", () => ({
  config: {
    defaultPageSize: 50,
    maxPageSize: 1000,
    maxBulkInsertRows: 1000,
    exposeDbErrors: false,
  },
}));

import { buildPkParams, buildJsonSchemaForTable, findTable } from "../../src/routes/crud.js";
import { makeUsersTable, makeCompositePkTable, makeNoPkTable, makeDatabaseSchema, makeNonPublicSchemaTable } from "../fixtures/tables.js";

const users = makeUsersTable();
const compositePk = makeCompositePkTable();

// ── buildPkParams ───────────────────────────────────────────────────

describe("buildPkParams", () => {
  it("parses single PK", () => {
    const result = buildPkParams(users, { id: "42" });
    expect(result).toEqual({ id: "42" });
  });

  it("parses composite PK", () => {
    const result = buildPkParams(compositePk, { id: "42,7" });
    expect(result).toEqual({ user_id: "42", role_id: "7" });
  });

  it("returns null when composite PK has wrong number of parts", () => {
    const result = buildPkParams(compositePk, { id: "42" });
    expect(result).toBeNull();
  });

  it("returns null when composite PK has empty segment", () => {
    const result = buildPkParams(compositePk, { id: "42," });
    expect(result).toBeNull();
  });

  it("returns null when composite PK has too many parts", () => {
    const result = buildPkParams(compositePk, { id: "42,7,99" });
    expect(result).toBeNull();
  });
});

// ── buildJsonSchemaForTable ─────────────────────────────────────────

describe("buildJsonSchemaForTable", () => {
  it("row mode includes all columns", () => {
    const schema = buildJsonSchemaForTable(users, "row") as any;
    expect(schema.type).toBe("object");
    expect(Object.keys(schema.properties)).toEqual(["id", "name", "email", "active"]);
    // row mode should not have additionalProperties
    expect(schema.additionalProperties).toBeUndefined();
  });

  it("insert mode skips PK columns with defaults", () => {
    const schema = buildJsonSchemaForTable(users, "insert") as any;
    // id has default (serial) and is PK, so it should be skipped
    expect(schema.properties.id).toBeUndefined();
    expect(schema.properties.name).toBeDefined();
    expect(schema.properties.email).toBeDefined();
  });

  it("insert mode marks non-nullable no-default columns as required", () => {
    const schema = buildJsonSchemaForTable(users, "insert") as any;
    // name and email are not nullable and have no default
    expect(schema.required).toContain("name");
    expect(schema.required).toContain("email");
    // active has a default, so not required
    expect(schema.required).not.toContain("active");
  });

  it("insert mode sets additionalProperties to false", () => {
    const schema = buildJsonSchemaForTable(users, "insert") as any;
    expect(schema.additionalProperties).toBe(false);
  });

  it("update mode skips PK columns", () => {
    const schema = buildJsonSchemaForTable(users, "update") as any;
    expect(schema.properties.id).toBeUndefined();
    expect(schema.properties.name).toBeDefined();
  });

  it("update mode has no required array", () => {
    const schema = buildJsonSchemaForTable(users, "update") as any;
    expect(schema.required).toBeUndefined();
  });

  it("update mode sets additionalProperties to false", () => {
    const schema = buildJsonSchemaForTable(users, "update") as any;
    expect(schema.additionalProperties).toBe(false);
  });

  it("put mode skips PK columns", () => {
    const schema = buildJsonSchemaForTable(users, "put") as any;
    expect(schema.properties.id).toBeUndefined();
  });

  it("put mode requires all non-PK columns", () => {
    const schema = buildJsonSchemaForTable(users, "put") as any;
    expect(schema.required).toContain("name");
    expect(schema.required).toContain("email");
    expect(schema.required).toContain("active");
  });

  it("put mode sets additionalProperties to false", () => {
    const schema = buildJsonSchemaForTable(users, "put") as any;
    expect(schema.additionalProperties).toBe(false);
  });
});

// ── findTable ───────────────────────────────────────────────────────

describe("findTable", () => {
  const dbSchema = makeDatabaseSchema([users, makeNonPublicSchemaTable()]);

  it("finds table by routePath", () => {
    const result = findTable(dbSchema, "users");
    expect(result).toBeDefined();
    expect(result!.name).toBe("users");
  });

  it("finds non-public schema table by routePath", () => {
    const result = findTable(dbSchema, "reporting__metrics");
    expect(result).toBeDefined();
    expect(result!.name).toBe("metrics");
  });

  it("returns undefined for non-existent routePath", () => {
    const result = findTable(dbSchema, "nonexistent");
    expect(result).toBeUndefined();
  });
});
