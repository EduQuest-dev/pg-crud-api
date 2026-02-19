import { TableInfo, ColumnInfo } from "./introspector.js";
import { config } from "../config.js";

// ─── Types ───────────────────────────────────────────────────────────

export interface QueryResult {
  text: string;
  values: unknown[];
}

export interface ListOptions {
  page?: number;
  pageSize?: number;
  sortBy?: string;
  sortOrder?: "asc" | "desc";
  filters?: Record<string, unknown>;
  search?: string;
  searchColumns?: string[];
  select?: string[];
}

// ─── Helpers ─────────────────────────────────────────────────────────

const FILTER_OPERATORS: Record<string, string> = {
  eq: "=",
  neq: "!=",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
  like: "LIKE",
  ilike: "ILIKE",
  is: "IS",
  in: "IN",
};

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function escapeLike(value: string): string {
  return value.replaceAll(/[%_\\]/g, String.raw`\$&`);
}

function isValidColumn(table: TableInfo, col: string): boolean {
  return table.columns.some((c) => c.name === col);
}

function getColumnNames(table: TableInfo, select?: string[]): string {
  if (select && select.length > 0) {
    const valid = select.filter((c) => isValidColumn(table, c));
    if (valid.length > 0) {
      return valid.map(quoteIdent).join(", ");
    }
    throw new Error(
      `None of the requested columns exist: ${select.join(", ")}. ` +
      `Available: ${table.columns.map((c) => c.name).join(", ")}`
    );
  }
  return "*";
}

// ─── Filter Parsing ─────────────────────────────────────────────────

interface ParsedFilter {
  column: string;
  operator: string;
  value: unknown;
}

// ─── Shared WHERE Clause Builder ────────────────────────────────────

interface WhereResult {
  clause: string;
  values: unknown[];
  nextParamIdx: number;
}

function buildWhereClauses(
  table: TableInfo,
  opts: ListOptions,
  startParamIdx: number = 1
): WhereResult {
  const values: unknown[] = [];
  let paramIdx = startParamIdx;
  const whereClauses: string[] = [];

  // Filters
  const filters = opts.filters ? parseFiltersFromObject(opts.filters, table) : [];
  for (const f of filters) {
    const sqlOp = /* c8 ignore next */ FILTER_OPERATORS[f.operator] || "=";

    if (f.operator === "is") {
      whereClauses.push(`${quoteIdent(f.column)} IS ${f.value === null ? "NULL" : "NOT NULL"}`);
    } else if (f.operator === "in" && Array.isArray(f.value)) {
      const placeholders = f.value.map(() => `$${paramIdx++}`);
      whereClauses.push(`${quoteIdent(f.column)} IN (${placeholders.join(", ")})`);
      values.push(...f.value);
    } else {
      whereClauses.push(`${quoteIdent(f.column)} ${sqlOp} $${paramIdx++}`);
      values.push(f.value);
    }
  }

  // Full-text search (ILIKE with escaped wildcards)
  if (opts.search && opts.searchColumns && opts.searchColumns.length > 0) {
    const searchClauses = opts.searchColumns
      .filter((c) => isValidColumn(table, c))
      .map((c) => `${quoteIdent(c)}::text ILIKE $${paramIdx}`);
    if (searchClauses.length > 0) {
      whereClauses.push(`(${searchClauses.join(" OR ")})`);
      values.push(`%${escapeLike(opts.search)}%`);
      paramIdx++;
    }
  }

  const clause = whereClauses.length > 0
    ? ` WHERE ${whereClauses.join(" AND ")}`
    : "";

  return { clause, values, nextParamIdx: paramIdx };
}

// ─── SELECT (List) ───────────────────────────────────────────────────

export function buildSelectQuery(table: TableInfo, opts: ListOptions): QueryResult {
  const page = Math.max(1, opts.page || 1);
  const pageSize = Math.min(config.maxPageSize, Math.max(1, opts.pageSize || config.defaultPageSize));
  const offset = (page - 1) * pageSize;

  const columns = getColumnNames(table, opts.select);
  const where = buildWhereClauses(table, opts);
  const values = [...where.values];
  let paramIdx = where.nextParamIdx;

  let sql = `SELECT ${columns} FROM ${table.fqn}${where.clause}`;

  // Sorting
  const sortCol = opts.sortBy && isValidColumn(table, opts.sortBy) ? opts.sortBy : (table.primaryKeys[0] ?? table.columns[0]?.name);
  if (sortCol) {
    const order = opts.sortOrder === "desc" ? "DESC" : "ASC";
    sql += ` ORDER BY ${quoteIdent(sortCol)} ${order}`;
  }

  sql += ` LIMIT $${paramIdx++} OFFSET $${paramIdx++}`;
  values.push(pageSize, offset);

  return { text: sql, values };
}

export function buildCountQuery(table: TableInfo, opts: ListOptions): QueryResult {
  const where = buildWhereClauses(table, opts);
  const sql = `SELECT COUNT(*) AS total FROM ${table.fqn}${where.clause}`;
  return { text: sql, values: where.values };
}

function validateFilterColumn(column: string, table: TableInfo): void {
  if (!isValidColumn(table, column)) {
    throw new Error(
      `Filter column '${column}' does not exist. ` +
      `Available: ${table.columns.map((c) => c.name).join(", ")}`
    );
  }
}

function parseOperatorAndValue(strValue: string): { op: string; value: string } {
  const colonIdx = strValue.indexOf(":");
  if (colonIdx <= 0) return { op: "eq", value: strValue };

  const maybeOp = strValue.slice(0, colonIdx);
  if (!FILTER_OPERATORS[maybeOp]) return { op: "eq", value: strValue };

  return { op: maybeOp, value: strValue.slice(colonIdx + 1) };
}

function coerceFilterValue(op: string, rawValue: string): unknown {
  if (op === "is") {
    return rawValue.toLowerCase() === "null" ? null : rawValue;
  }
  if (op === "in") {
    const parts = rawValue.split(",");
    if (parts.length > 100) {
      throw new Error(`IN filter limited to 100 values, got ${parts.length}`);
    }
    return parts;
  }
  return rawValue;
}

function parseFiltersFromObject(filters: Record<string, unknown>, table: TableInfo): ParsedFilter[] {
  const result: ParsedFilter[] = [];
  for (const [column, rawValue] of Object.entries(filters)) {
    validateFilterColumn(column, table);
    const { op, value: rawParsed } = parseOperatorAndValue(String(rawValue));
    const value = coerceFilterValue(op, rawParsed);
    result.push({ column, operator: op, value });
  }
  return result;
}

// ─── SELECT (Single by PK) ──────────────────────────────────────────

export function buildSelectByPkQuery(
  table: TableInfo,
  pkValues: Record<string, unknown>,
  select?: string[]
): QueryResult {
  const columns = getColumnNames(table, select);
  const values: unknown[] = [];
  const whereClauses: string[] = [];
  let paramIdx = 1;

  for (const pk of table.primaryKeys) {
    whereClauses.push(`${quoteIdent(pk)} = $${paramIdx++}`);
    values.push(pkValues[pk]);
  }

  const sql = `SELECT ${columns} FROM ${table.fqn} WHERE ${whereClauses.join(" AND ")} LIMIT 1`;
  return { text: sql, values };
}

// ─── INSERT ──────────────────────────────────────────────────────────

export function buildInsertQuery(
  table: TableInfo,
  data: Record<string, unknown>
): QueryResult {
  const validColumns = table.columns.filter((c) => data[c.name] !== undefined);
  if (validColumns.length === 0) {
    throw new Error("No valid columns provided for insert");
  }

  const colNames = validColumns.map((c) => quoteIdent(c.name)).join(", ");
  const placeholders = validColumns.map((_, i) => `$${i + 1}`).join(", ");
  const values = validColumns.map((c) => data[c.name]);

  const sql = `INSERT INTO ${table.fqn} (${colNames}) VALUES (${placeholders}) RETURNING *`;
  return { text: sql, values };
}

// ─── BULK INSERT ─────────────────────────────────────────────────────

export function buildBulkInsertQuery(
  table: TableInfo,
  rows: Record<string, unknown>[]
): QueryResult {
  if (rows.length === 0) throw new Error("No rows provided for bulk insert");
  if (rows.length > config.maxBulkInsertRows) {
    throw new Error(`Bulk insert limited to ${config.maxBulkInsertRows} rows, got ${rows.length}`);
  }

  // Use union of all columns present across rows
  const columnSet = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (table.columns.some((c) => c.name === key)) {
        columnSet.add(key);
      }
    }
  }

  const columns = Array.from(columnSet);
  if (columns.length === 0) throw new Error("No valid columns in bulk insert data");

  const colNames = columns.map(quoteIdent).join(", ");
  const values: unknown[] = [];
  const rowPlaceholders: string[] = [];
  let paramIdx = 1;

  for (const row of rows) {
    const placeholders = columns.map((col) => {
      values.push(row[col] ?? null);
      return `$${paramIdx++}`;
    });
    rowPlaceholders.push(`(${placeholders.join(", ")})`);
  }

  const sql = `INSERT INTO ${table.fqn} (${colNames}) VALUES ${rowPlaceholders.join(", ")} RETURNING *`;
  return { text: sql, values };
}

// ─── UPDATE ──────────────────────────────────────────────────────────

export function buildUpdateQuery(
  table: TableInfo,
  pkValues: Record<string, unknown>,
  data: Record<string, unknown>
): QueryResult {
  // Don't allow updating PK columns
  const updateColumns = table.columns.filter(
    (c) => data[c.name] !== undefined && !table.primaryKeys.includes(c.name)
  );

  if (updateColumns.length === 0) {
    throw new Error("No valid columns provided for update");
  }

  const values: unknown[] = [];
  let paramIdx = 1;

  const setClauses = updateColumns.map((c) => {
    values.push(data[c.name]);
    return `${quoteIdent(c.name)} = $${paramIdx++}`;
  });

  const whereClauses = table.primaryKeys.map((pk) => {
    values.push(pkValues[pk]);
    return `${quoteIdent(pk)} = $${paramIdx++}`;
  });

  const sql = `UPDATE ${table.fqn} SET ${setClauses.join(", ")} WHERE ${whereClauses.join(" AND ")} RETURNING *`;
  return { text: sql, values };
}

// ─── DELETE ──────────────────────────────────────────────────────────

export function buildDeleteQuery(
  table: TableInfo,
  pkValues: Record<string, unknown>
): QueryResult {
  const values: unknown[] = [];
  let paramIdx = 1;

  const whereClauses = table.primaryKeys.map((pk) => {
    values.push(pkValues[pk]);
    return `${quoteIdent(pk)} = $${paramIdx++}`;
  });

  const sql = `DELETE FROM ${table.fqn} WHERE ${whereClauses.join(" AND ")} RETURNING *`;
  return { text: sql, values };
}

// ─── Schema Info Helpers ─────────────────────────────────────────────

export function pgTypeToJsonSchema(col: ColumnInfo): Record<string, unknown> {
  const base: Record<string, unknown> = {};

  switch (col.udtName) {
    // ── Integers ──
    case "int2":
      base.type = "integer";
      base.minimum = -32768;
      base.maximum = 32767;
      break;
    case "int4":
    case "serial":
      base.type = "integer";
      base.minimum = -2147483648;
      base.maximum = 2147483647;
      break;
    case "int8":
    case "bigserial":
    case "oid":
      base.type = "integer";
      break;

    // ── Floats ──
    case "float4":
    case "float8":
    case "numeric":
    case "decimal":
    case "money":
      base.type = "number";
      break;

    // ── Boolean ──
    case "bool":
      base.type = "boolean";
      break;

    // ── JSON (any type — could be object, array, or scalar) ──
    case "json":
    case "jsonb":
      break;

    // ── Strings with format ──
    case "uuid":
      base.type = "string";
      base.format = "uuid";
      break;
    case "date":
      base.type = "string";
      base.format = "date";
      break;
    case "timestamp":
    case "timestamptz":
      base.type = "string";
      base.format = "date-time";
      break;
    case "time":
    case "timetz":
      base.type = "string";
      base.format = "time";
      break;
    case "bytea":
      base.type = "string";
      base.format = "byte";
      break;
    case "inet":
    case "cidr":
      base.type = "string";
      break;

    // ── Integer arrays ──
    case "_int2":
    case "_int4":
    case "_int8":
      base.type = "array";
      base.items = { type: "integer" };
      break;

    // ── Float arrays ──
    case "_float4":
    case "_float8":
    case "_numeric":
      base.type = "array";
      base.items = { type: "number" };
      break;

    // ── Boolean arrays ──
    case "_bool":
      base.type = "array";
      base.items = { type: "boolean" };
      break;

    // ── String arrays ──
    case "_text":
    case "_varchar":
    case "_char":
    case "_name":
      base.type = "array";
      base.items = { type: "string" };
      break;

    // ── UUID arrays ──
    case "_uuid":
      base.type = "array";
      base.items = { type: "string", format: "uuid" };
      break;

    // ── JSON arrays ──
    case "_json":
    case "_jsonb":
      base.type = "array";
      base.items = {};
      break;

    // ── Plain strings (interval, geometry, xml, tsvector, bit, macaddr, etc.) ──
    default:
      base.type = "string";
  }

  if (col.maxLength) {
    base.maxLength = col.maxLength;
  }

  // Nullable (OpenAPI 3.0 style — requires "type" to be present)
  if (col.isNullable && base.type) {
    base.nullable = true;
  }

  return base;
}
