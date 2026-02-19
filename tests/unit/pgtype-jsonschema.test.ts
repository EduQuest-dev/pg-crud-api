import { describe, it, expect } from "vitest";

vi.mock("../../src/config.js", () => ({
  config: {
    defaultPageSize: 50,
    maxPageSize: 1000,
    maxBulkInsertRows: 1000,
  },
}));

import { vi } from "vitest";
import { pgTypeToJsonSchema } from "../../src/db/query-builder.js";
import { makeColumn } from "../fixtures/tables.js";

describe("pgTypeToJsonSchema", () => {
  // ── Integer types ──
  it.each([
    ["int2", { type: "integer", minimum: -32768, maximum: 32767 }],
    ["int4", { type: "integer", minimum: -2147483648, maximum: 2147483647 }],
    ["serial", { type: "integer", minimum: -2147483648, maximum: 2147483647 }],
    ["int8", { type: "integer" }],
    ["bigserial", { type: "integer" }],
    ["oid", { type: "integer" }],
  ])("maps %s to integer", (udtName, expected) => {
    const col = makeColumn({ udtName, isNullable: false });
    expect(pgTypeToJsonSchema(col)).toEqual(expected);
  });

  // ── Float types ──
  it.each([
    "float4", "float8", "numeric", "decimal", "money",
  ])("maps %s to number", (udtName) => {
    const col = makeColumn({ udtName, isNullable: false });
    expect(pgTypeToJsonSchema(col)).toEqual({ type: "number" });
  });

  // ── Boolean ──
  it("maps bool to boolean", () => {
    const col = makeColumn({ udtName: "bool", isNullable: false });
    expect(pgTypeToJsonSchema(col)).toEqual({ type: "boolean" });
  });

  // ── JSON (no type) ──
  it.each(["json", "jsonb"])("maps %s to empty object (any type)", (udtName) => {
    const col = makeColumn({ udtName, isNullable: false });
    expect(pgTypeToJsonSchema(col)).toEqual({});
  });

  // ── Strings with format ──
  it("maps uuid to string with uuid format", () => {
    const col = makeColumn({ udtName: "uuid", isNullable: false });
    expect(pgTypeToJsonSchema(col)).toEqual({ type: "string", format: "uuid" });
  });

  it("maps date to string with date format", () => {
    const col = makeColumn({ udtName: "date", isNullable: false });
    expect(pgTypeToJsonSchema(col)).toEqual({ type: "string", format: "date" });
  });

  it.each(["timestamp", "timestamptz"])("maps %s to string with date-time format", (udtName) => {
    const col = makeColumn({ udtName, isNullable: false });
    expect(pgTypeToJsonSchema(col)).toEqual({ type: "string", format: "date-time" });
  });

  it.each(["time", "timetz"])("maps %s to string with time format", (udtName) => {
    const col = makeColumn({ udtName, isNullable: false });
    expect(pgTypeToJsonSchema(col)).toEqual({ type: "string", format: "time" });
  });

  it("maps bytea to string with byte format", () => {
    const col = makeColumn({ udtName: "bytea", isNullable: false });
    expect(pgTypeToJsonSchema(col)).toEqual({ type: "string", format: "byte" });
  });

  it.each(["inet", "cidr"])("maps %s to plain string", (udtName) => {
    const col = makeColumn({ udtName, isNullable: false });
    expect(pgTypeToJsonSchema(col)).toEqual({ type: "string" });
  });

  // ── Integer arrays ──
  it.each(["_int2", "_int4", "_int8"])("maps %s to integer array", (udtName) => {
    const col = makeColumn({ udtName, isNullable: false });
    expect(pgTypeToJsonSchema(col)).toEqual({ type: "array", items: { type: "integer" } });
  });

  // ── Float arrays ──
  it.each(["_float4", "_float8", "_numeric"])("maps %s to number array", (udtName) => {
    const col = makeColumn({ udtName, isNullable: false });
    expect(pgTypeToJsonSchema(col)).toEqual({ type: "array", items: { type: "number" } });
  });

  // ── Boolean arrays ──
  it("maps _bool to boolean array", () => {
    const col = makeColumn({ udtName: "_bool", isNullable: false });
    expect(pgTypeToJsonSchema(col)).toEqual({ type: "array", items: { type: "boolean" } });
  });

  // ── String arrays ──
  it.each(["_text", "_varchar", "_char", "_name"])("maps %s to string array", (udtName) => {
    const col = makeColumn({ udtName, isNullable: false });
    expect(pgTypeToJsonSchema(col)).toEqual({ type: "array", items: { type: "string" } });
  });

  // ── UUID arrays ──
  it("maps _uuid to uuid string array", () => {
    const col = makeColumn({ udtName: "_uuid", isNullable: false });
    expect(pgTypeToJsonSchema(col)).toEqual({ type: "array", items: { type: "string", format: "uuid" } });
  });

  // ── JSON arrays ──
  it.each(["_json", "_jsonb"])("maps %s to array of any", (udtName) => {
    const col = makeColumn({ udtName, isNullable: false });
    expect(pgTypeToJsonSchema(col)).toEqual({ type: "array", items: {} });
  });

  // ── Default ──
  it("maps unknown types to string", () => {
    const col = makeColumn({ udtName: "xml", isNullable: false });
    expect(pgTypeToJsonSchema(col)).toEqual({ type: "string" });
  });

  // ── Nullable behavior ──
  it("adds nullable when column is nullable and has a type", () => {
    const col = makeColumn({ udtName: "int4", isNullable: true });
    const result = pgTypeToJsonSchema(col);
    expect(result.nullable).toBe(true);
  });

  it("does not add nullable to json/jsonb (no type property)", () => {
    const col = makeColumn({ udtName: "jsonb", isNullable: true });
    const result = pgTypeToJsonSchema(col);
    expect(result.nullable).toBeUndefined();
  });

  it("does not add nullable when column is not nullable", () => {
    const col = makeColumn({ udtName: "int4", isNullable: false });
    const result = pgTypeToJsonSchema(col);
    expect(result.nullable).toBeUndefined();
  });

  // ── maxLength ──
  it("includes maxLength when present", () => {
    const col = makeColumn({ udtName: "varchar", maxLength: 255, isNullable: false });
    const result = pgTypeToJsonSchema(col);
    expect(result.maxLength).toBe(255);
  });

  it("does not include maxLength when null", () => {
    const col = makeColumn({ udtName: "varchar", maxLength: null, isNullable: false });
    const result = pgTypeToJsonSchema(col);
    expect(result.maxLength).toBeUndefined();
  });
});
