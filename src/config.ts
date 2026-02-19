import dotenv from "dotenv";
dotenv.config();

export interface AppConfig {
  databaseUrl: string;
  port: number;
  host: string;
  schemas: string[];
  excludeSchemas: string[];
  excludeTables: string[];
  defaultPageSize: number;
  maxPageSize: number;
  maxBulkInsertRows: number;
  bodyLimit: number;
  swaggerEnabled: boolean;
  apiSecret: string | null;
  apiKeysEnabled: boolean;
  corsOrigins: string | boolean;
  exposeDbErrors: boolean;
}

export function parseList(value: string | undefined): string[] {
  if (!value || value.trim() === "") return [];
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

export function parseIntOrDefault(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

export function parseCorsOrigins(value: string | undefined): string | boolean {
  if (!value) return process.env.NODE_ENV === "production" ? false : true;
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}

export const config: AppConfig = {
  databaseUrl: (process.env.DATABASE_URL || "postgresql://localhost:5432/mydb").replace(/^jdbc:/, ""),
  port: parseIntOrDefault(process.env.PORT, 3000),
  host: process.env.HOST || "0.0.0.0",
  schemas: parseList(process.env.SCHEMAS),
  excludeSchemas: parseList(process.env.EXCLUDE_SCHEMAS),
  excludeTables: parseList(process.env.EXCLUDE_TABLES),
  defaultPageSize: parseIntOrDefault(process.env.DEFAULT_PAGE_SIZE, 50),
  maxPageSize: parseIntOrDefault(process.env.MAX_PAGE_SIZE, 1000),
  maxBulkInsertRows: parseIntOrDefault(process.env.MAX_BULK_INSERT_ROWS, 1000),
  bodyLimit: parseIntOrDefault(process.env.BODY_LIMIT, 5 * 1024 * 1024),
  swaggerEnabled: process.env.SWAGGER_ENABLED !== "false",
  apiSecret: process.env.API_SECRET || null,
  apiKeysEnabled: process.env.API_KEYS_ENABLED !== "false",
  corsOrigins: parseCorsOrigins(process.env.CORS_ORIGINS),
  exposeDbErrors: process.env.EXPOSE_DB_ERRORS === "true",
};

// System schemas that are never exposed (pg_temp_* and pg_toast_temp_* are
// handled by prefix check in introspector, not listed here individually)
export const SYSTEM_SCHEMAS = [
  "pg_catalog",
  "information_schema",
  "pg_toast",
];
