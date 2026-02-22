import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock dotenv to prevent it from loading .env file values
vi.mock("dotenv", () => ({
  default: { config: vi.fn() },
  config: vi.fn(),
}));

// This test file does NOT mock config.js — it tests the actual config object
// initialization branches that are missed by other tests (which mock config).

describe("config object initialization", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    // Re-apply dotenv mock after resetModules
    vi.doMock("dotenv", () => ({
      default: { config: vi.fn() },
      config: vi.fn(),
    }));
    // Clear relevant env vars to test fallback branches
    delete process.env.DATABASE_URL;
    delete process.env.DATABASE_READ_URL;
    delete process.env.PORT;
    delete process.env.HOST;
    delete process.env.SCHEMAS;
    delete process.env.EXCLUDE_SCHEMAS;
    delete process.env.EXCLUDE_TABLES;
    delete process.env.DEFAULT_PAGE_SIZE;
    delete process.env.MAX_PAGE_SIZE;
    delete process.env.MAX_BULK_INSERT_ROWS;
    delete process.env.BODY_LIMIT;
    delete process.env.SWAGGER_ENABLED;
    delete process.env.API_SECRET;
    delete process.env.API_KEYS_ENABLED;
    delete process.env.CORS_ORIGINS;
    delete process.env.EXPOSE_DB_ERRORS;
    delete process.env.NODE_ENV;
  });

  afterEach(() => {
    // Restore original env
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  });

  it("uses default values when no env vars are set", async () => {
    const { config } = await import("../../src/config.js");
    expect(config.databaseUrl).toBe("postgresql://localhost:5432/mydb");
    expect(config.databaseReadUrl).toBeNull();
    expect(config.port).toBe(3000);
    expect(config.host).toBe("0.0.0.0");
    expect(config.schemas).toEqual([]);
    expect(config.excludeSchemas).toEqual([]);
    expect(config.excludeTables).toEqual([]);
    expect(config.defaultPageSize).toBe(50);
    expect(config.maxPageSize).toBe(1000);
    expect(config.maxBulkInsertRows).toBe(1000);
    expect(config.bodyLimit).toBe(5 * 1024 * 1024);
    expect(config.swaggerEnabled).toBe(true);
    expect(config.apiSecret).toBeNull();
    expect(config.apiKeysEnabled).toBe(true);
    expect(config.exposeDbErrors).toBe(false);
  });

  it("reads DATABASE_URL and strips jdbc: prefix", async () => {
    process.env.DATABASE_URL = "jdbc:postgresql://db:5432/test";
    const { config } = await import("../../src/config.js");
    expect(config.databaseUrl).toBe("postgresql://db:5432/test");
  });

  it("reads DATABASE_URL without jdbc: prefix", async () => {
    process.env.DATABASE_URL = "postgresql://db:5432/test";
    const { config } = await import("../../src/config.js");
    expect(config.databaseUrl).toBe("postgresql://db:5432/test");
  });

  it("reads DATABASE_READ_URL from env", async () => {
    process.env.DATABASE_READ_URL = "postgresql://replica:5432/mydb";
    const { config } = await import("../../src/config.js");
    expect(config.databaseReadUrl).toBe("postgresql://replica:5432/mydb");
  });

  it("strips jdbc: prefix from DATABASE_READ_URL", async () => {
    process.env.DATABASE_READ_URL = "jdbc:postgresql://replica:5432/mydb";
    const { config } = await import("../../src/config.js");
    expect(config.databaseReadUrl).toBe("postgresql://replica:5432/mydb");
  });

  it("returns null for empty DATABASE_READ_URL", async () => {
    process.env.DATABASE_READ_URL = "";
    const { config } = await import("../../src/config.js");
    expect(config.databaseReadUrl).toBeNull();
  });

  it("reads PORT from env", async () => {
    process.env.PORT = "8080";
    const { config } = await import("../../src/config.js");
    expect(config.port).toBe(8080);
  });

  it("reads HOST from env", async () => {
    process.env.HOST = "127.0.0.1";
    const { config } = await import("../../src/config.js");
    expect(config.host).toBe("127.0.0.1");
  });

  it("disables swagger when SWAGGER_ENABLED=false", async () => {
    process.env.SWAGGER_ENABLED = "false";
    const { config } = await import("../../src/config.js");
    expect(config.swaggerEnabled).toBe(false);
  });

  it("reads API_SECRET from env", async () => {
    process.env.API_SECRET = "my-secret";
    const { config } = await import("../../src/config.js");
    expect(config.apiSecret).toBe("my-secret");
  });

  it("disables API keys when API_KEYS_ENABLED=false", async () => {
    process.env.API_KEYS_ENABLED = "false";
    const { config } = await import("../../src/config.js");
    expect(config.apiKeysEnabled).toBe(false);
  });

  it("enables exposeDbErrors when EXPOSE_DB_ERRORS=true", async () => {
    process.env.EXPOSE_DB_ERRORS = "true";
    const { config } = await import("../../src/config.js");
    expect(config.exposeDbErrors).toBe(true);
  });

  it("parses comma-separated SCHEMAS", async () => {
    process.env.SCHEMAS = "public, reporting";
    const { config } = await import("../../src/config.js");
    expect(config.schemas).toEqual(["public", "reporting"]);
  });

  it("parses CORS_ORIGINS from env", async () => {
    process.env.CORS_ORIGINS = "https://example.com";
    const { config } = await import("../../src/config.js");
    expect(config.corsOrigins).toBe("https://example.com");
  });
});
