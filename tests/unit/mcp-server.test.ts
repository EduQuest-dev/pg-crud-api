import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/config.js", () => ({
  config: {
    defaultPageSize: 50,
    maxPageSize: 1000,
    maxBulkInsertRows: 1000,
    bodyLimit: 5 * 1024 * 1024,
    swaggerEnabled: false,
    apiKeysEnabled: false,
    apiSecret: null,
    corsOrigins: true,
    exposeDbErrors: false,
    databaseReadUrl: null,
  },
}));

import { Pool } from "pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer, McpServerOptions } from "../../src/mcp/server.js";
import {
  makeColumn,
  makeUsersTable,
  makeCompositePkTable,
  makeNoPkTable,
  makeNonPublicSchemaTable,
  makeTableWithForeignKeys,
  makeSoftDeleteTable,
  makeDatabaseSchema,
} from "../fixtures/tables.js";
import type { TableInfo } from "../../src/db/introspector.js";
import { config } from "../../src/config.js";
import type { SchemaPermissions } from "../../src/auth/api-key.js";

// ─── Helpers ─────────────────────────────────────────────────────────

function createMockPool() {
  const mockQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
  return {
    query: mockQuery,
    connect: vi.fn().mockResolvedValue({
      query: mockQuery,
      release: vi.fn(),
    }),
    end: vi.fn().mockResolvedValue(undefined),
  } as unknown as Pool;
}

async function setupMcpTest(opts?: {
  permissions?: SchemaPermissions | null;
  pool?: Pool;
  readPool?: Pool;
}) {
  const usersTable = makeUsersTable();
  const compositePkTable = makeCompositePkTable();
  const noPkTable = makeNoPkTable();
  const nonPublicTable = makeNonPublicSchemaTable();
  const ordersTable = makeTableWithForeignKeys();
  const softDeleteTable = makeSoftDeleteTable();
  const dbSchema = makeDatabaseSchema([usersTable, compositePkTable, noPkTable, nonPublicTable, ordersTable, softDeleteTable]);

  const pool = opts?.pool ?? createMockPool();
  const readPool = opts?.readPool ?? pool;

  const mcpServer = createMcpServer({
    pool,
    readPool,
    dbSchema,
    permissions: opts?.permissions ?? null,
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const client = new Client({ name: "test-client", version: "1.0.0" });

  await Promise.all([
    mcpServer.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  return { client, mcpServer, pool, readPool, dbSchema };
}

function getMockQuery(pool: Pool) {
  return (pool as unknown as { query: ReturnType<typeof vi.fn> }).query;
}

// ─── Tests ───────────────────────────────────────────────────────────

describe("MCP Server", () => {
  let client: Client;
  let pool: Pool;
  let cleanup: () => Promise<void>;

  afterEach(async () => {
    if (cleanup) await cleanup();
  });

  // ── Tool: list_tables ──────────────────────────────────────────────

  describe("list_tables", () => {
    it("lists all tables with full access", async () => {
      const ctx = await setupMcpTest();
      client = ctx.client;
      cleanup = () => Promise.all([ctx.client.close(), ctx.mcpServer.close()]).then(() => {});

      const result = await client.callTool({ name: "list_tables", arguments: {} });
      const parsed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text);

      expect(parsed.count).toBe(6);
      expect(parsed.tables).toHaveLength(6);
      expect(parsed.tables.map((t: { name: string }) => t.name).sort()).toEqual([
        "audit_logs", "metrics", "orders", "posts", "user_roles", "users",
      ]);

      // Check table structure
      const users = parsed.tables.find((t: { name: string }) => t.name === "users");
      expect(users.schema).toBe("public");
      expect(users.routePath).toBe("users");
      expect(users.primaryKeys).toEqual(["id"]);
      expect(users.columnCount).toBe(4);
      expect(users.hasPrimaryKey).toBe(true);

      // No-PK table
      const auditLogs = parsed.tables.find((t: { name: string }) => t.name === "audit_logs");
      expect(auditLogs.hasPrimaryKey).toBe(false);
    });

    it("filters tables by schema permissions", async () => {
      const ctx = await setupMcpTest({ permissions: { reporting: "r" } });
      client = ctx.client;
      cleanup = () => Promise.all([ctx.client.close(), ctx.mcpServer.close()]).then(() => {});

      const result = await client.callTool({ name: "list_tables", arguments: {} });
      const parsed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text);

      expect(parsed.count).toBe(1);
      expect(parsed.tables[0].name).toBe("metrics");
    });

    it("returns all tables with wildcard permission", async () => {
      const ctx = await setupMcpTest({ permissions: { "*": "rw" } });
      client = ctx.client;
      cleanup = () => Promise.all([ctx.client.close(), ctx.mcpServer.close()]).then(() => {});

      const result = await client.callTool({ name: "list_tables", arguments: {} });
      const parsed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text);

      expect(parsed.count).toBe(6);
    });
  });

  // ── Tool: describe_table ───────────────────────────────────────────

  describe("describe_table", () => {
    it("returns detailed schema for a table", async () => {
      const ctx = await setupMcpTest();
      client = ctx.client;
      cleanup = () => Promise.all([ctx.client.close(), ctx.mcpServer.close()]).then(() => {});

      const result = await client.callTool({
        name: "describe_table",
        arguments: { table: "users" },
      });
      const parsed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text);

      expect(parsed.name).toBe("users");
      expect(parsed.schema).toBe("public");
      expect(parsed.columns).toHaveLength(4);
      expect(parsed.primaryKeys).toEqual(["id"]);
      expect(parsed.operations).toContain("list");
      expect(parsed.operations).toContain("read");
      expect(parsed.operations).toContain("create");
      expect(parsed.operations).toContain("update");
      expect(parsed.operations).toContain("delete");
      expect(parsed.searchableColumns).toEqual(["name", "email"]);
    });

    it("returns error for non-existent table", async () => {
      const ctx = await setupMcpTest();
      client = ctx.client;
      cleanup = () => Promise.all([ctx.client.close(), ctx.mcpServer.close()]).then(() => {});

      const result = await client.callTool({
        name: "describe_table",
        arguments: { table: "nonexistent" },
      });
      expect(result.isError).toBe(true);
      expect((result.content as Array<{ type: string; text: string }>)[0].text).toContain("not found");
    });

    it("denies access when permissions restrict schema", async () => {
      const ctx = await setupMcpTest({ permissions: { public: "r" } });
      client = ctx.client;
      cleanup = () => Promise.all([ctx.client.close(), ctx.mcpServer.close()]).then(() => {});

      const result = await client.callTool({
        name: "describe_table",
        arguments: { table: "reporting__metrics" },
      });
      expect(result.isError).toBe(true);
      expect((result.content as Array<{ type: string; text: string }>)[0].text).toContain("Permission denied");
    });

    it("describes non-public schema table", async () => {
      const ctx = await setupMcpTest();
      client = ctx.client;
      cleanup = () => Promise.all([ctx.client.close(), ctx.mcpServer.close()]).then(() => {});

      const result = await client.callTool({
        name: "describe_table",
        arguments: { table: "reporting__metrics" },
      });
      const parsed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text);

      expect(parsed.name).toBe("metrics");
      expect(parsed.schema).toBe("reporting");
    });

    it("describes table with foreign keys", async () => {
      const ctx = await setupMcpTest();
      client = ctx.client;
      cleanup = () => Promise.all([ctx.client.close(), ctx.mcpServer.close()]).then(() => {});

      const result = await client.callTool({
        name: "describe_table",
        arguments: { table: "orders" },
      });
      const parsed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text);

      expect(parsed.foreignKeys).toHaveLength(1);
      expect(parsed.foreignKeys[0].column).toBe("user_id");
      expect(parsed.foreignKeys[0].references).toBe("users.id");
    });
  });

  // ── Tool: list_records ─────────────────────────────────────────────

  describe("list_records", () => {
    it("queries records with default pagination", async () => {
      const mockPool = createMockPool();
      const mockQuery = getMockQuery(mockPool);
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 1, name: "Alice" }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [{ total: "1" }], rowCount: 1 });

      const ctx = await setupMcpTest({ pool: mockPool, readPool: mockPool });
      client = ctx.client;
      cleanup = () => Promise.all([ctx.client.close(), ctx.mcpServer.close()]).then(() => {});

      const result = await client.callTool({
        name: "list_records",
        arguments: { table: "users" },
      });
      const parsed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text);

      expect(parsed.data).toEqual([{ id: 1, name: "Alice" }]);
      expect(parsed.pagination.page).toBe(1);
      expect(parsed.pagination.pageSize).toBe(50);
      expect(parsed.pagination.total).toBe(1);
      expect(parsed.pagination.totalPages).toBe(1);
      expect(mockQuery).toHaveBeenCalledTimes(2);
    });

    it("queries with custom pagination and sorting", async () => {
      const mockPool = createMockPool();
      const mockQuery = getMockQuery(mockPool);
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 2 }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [{ total: "10" }], rowCount: 1 });

      const ctx = await setupMcpTest({ pool: mockPool, readPool: mockPool });
      client = ctx.client;
      cleanup = () => Promise.all([ctx.client.close(), ctx.mcpServer.close()]).then(() => {});

      const result = await client.callTool({
        name: "list_records",
        arguments: {
          table: "users",
          page: 2,
          pageSize: 5,
          sortBy: "name",
          sortOrder: "desc",
        },
      });
      const parsed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text);

      expect(parsed.pagination.page).toBe(2);
      expect(parsed.pagination.pageSize).toBe(5);

      // Verify the query used the correct ORDER BY
      const selectCall = mockQuery.mock.calls[0];
      expect(selectCall[0].text).toContain("ORDER BY");
      expect(selectCall[0].text).toContain("DESC");
    });

    it("queries with filters", async () => {
      const mockPool = createMockPool();
      const mockQuery = getMockQuery(mockPool);
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 1, name: "Alice", active: true }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [{ total: "1" }], rowCount: 1 });

      const ctx = await setupMcpTest({ pool: mockPool, readPool: mockPool });
      client = ctx.client;
      cleanup = () => Promise.all([ctx.client.close(), ctx.mcpServer.close()]).then(() => {});

      const result = await client.callTool({
        name: "list_records",
        arguments: {
          table: "users",
          filters: { name: "eq:Alice" },
        },
      });

      expect(result.isError).toBeFalsy();
      const selectCall = mockQuery.mock.calls[0];
      expect(selectCall[0].text).toContain("WHERE");
      expect(selectCall[0].values).toContain("Alice");
    });

    it("queries with search", async () => {
      const mockPool = createMockPool();
      const mockQuery = getMockQuery(mockPool);
      mockQuery
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [{ total: "0" }], rowCount: 1 });

      const ctx = await setupMcpTest({ pool: mockPool, readPool: mockPool });
      client = ctx.client;
      cleanup = () => Promise.all([ctx.client.close(), ctx.mcpServer.close()]).then(() => {});

      const result = await client.callTool({
        name: "list_records",
        arguments: {
          table: "users",
          search: "john",
          searchColumns: ["name"],
        },
      });
      expect(result.isError).toBeFalsy();

      // Verify ILIKE search
      const selectCall = mockQuery.mock.calls[0];
      expect(selectCall[0].text).toContain("ILIKE");
    });

    it("queries with column selection", async () => {
      const mockPool = createMockPool();
      const mockQuery = getMockQuery(mockPool);
      mockQuery
        .mockResolvedValueOnce({ rows: [{ name: "Alice" }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [{ total: "1" }], rowCount: 1 });

      const ctx = await setupMcpTest({ pool: mockPool, readPool: mockPool });
      client = ctx.client;
      cleanup = () => Promise.all([ctx.client.close(), ctx.mcpServer.close()]).then(() => {});

      const result = await client.callTool({
        name: "list_records",
        arguments: { table: "users", select: ["name"] },
      });
      expect(result.isError).toBeFalsy();

      const selectCall = mockQuery.mock.calls[0];
      expect(selectCall[0].text).toContain('"name"');
      expect(selectCall[0].text).not.toContain("*");
    });

    it("returns error for non-existent table", async () => {
      const ctx = await setupMcpTest();
      client = ctx.client;
      cleanup = () => Promise.all([ctx.client.close(), ctx.mcpServer.close()]).then(() => {});

      const result = await client.callTool({
        name: "list_records",
        arguments: { table: "nonexistent" },
      });
      expect(result.isError).toBe(true);
      expect((result.content as Array<{ type: string; text: string }>)[0].text).toContain("not found");
    });

    it("denies read access when permission is write-only", async () => {
      const mockPool = createMockPool();
      const ctx = await setupMcpTest({
        pool: mockPool,
        readPool: mockPool,
        permissions: { public: "w" },
      });
      client = ctx.client;
      cleanup = () => Promise.all([ctx.client.close(), ctx.mcpServer.close()]).then(() => {});

      const result = await client.callTool({
        name: "list_records",
        arguments: { table: "users" },
      });
      expect(result.isError).toBe(true);
      expect((result.content as Array<{ type: string; text: string }>)[0].text).toContain("Permission denied");
    });

    it("returns error for invalid filter column", async () => {
      const mockPool = createMockPool();
      const mockQuery = getMockQuery(mockPool);
      mockQuery.mockRejectedValueOnce(new Error("Filter column 'invalid' does not exist"));

      const ctx = await setupMcpTest({ pool: mockPool, readPool: mockPool });
      client = ctx.client;
      cleanup = () => Promise.all([ctx.client.close(), ctx.mcpServer.close()]).then(() => {});

      const result = await client.callTool({
        name: "list_records",
        arguments: { table: "users", filters: { invalid: "eq:test" } },
      });
      expect(result.isError).toBe(true);
    });

    it("uses read pool for queries", async () => {
      const writePool = createMockPool();
      const readPool = createMockPool();
      const readQuery = getMockQuery(readPool);
      readQuery
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [{ total: "0" }], rowCount: 1 });

      const ctx = await setupMcpTest({ pool: writePool, readPool });
      client = ctx.client;
      cleanup = () => Promise.all([ctx.client.close(), ctx.mcpServer.close()]).then(() => {});

      await client.callTool({
        name: "list_records",
        arguments: { table: "users" },
      });

      expect(readQuery).toHaveBeenCalledTimes(2);
      expect(getMockQuery(writePool)).not.toHaveBeenCalled();
    });
  });

  // ── Tool: get_record ───────────────────────────────────────────────

  describe("get_record", () => {
    it("fetches a record by primary key", async () => {
      const mockPool = createMockPool();
      const mockQuery = getMockQuery(mockPool);
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 1, name: "Alice", email: "alice@example.com", active: true }],
        rowCount: 1,
      });

      const ctx = await setupMcpTest({ pool: mockPool, readPool: mockPool });
      client = ctx.client;
      cleanup = () => Promise.all([ctx.client.close(), ctx.mcpServer.close()]).then(() => {});

      const result = await client.callTool({
        name: "get_record",
        arguments: { table: "users", id: "1" },
      });
      const parsed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text);

      expect(parsed.id).toBe(1);
      expect(parsed.name).toBe("Alice");
    });

    it("handles composite primary keys", async () => {
      const mockPool = createMockPool();
      const mockQuery = getMockQuery(mockPool);
      mockQuery.mockResolvedValueOnce({
        rows: [{ user_id: 42, role_id: 7 }],
        rowCount: 1,
      });

      const ctx = await setupMcpTest({ pool: mockPool, readPool: mockPool });
      client = ctx.client;
      cleanup = () => Promise.all([ctx.client.close(), ctx.mcpServer.close()]).then(() => {});

      const result = await client.callTool({
        name: "get_record",
        arguments: { table: "user_roles", id: "42,7" },
      });
      expect(result.isError).toBeFalsy();

      // Verify both PK values were used
      const call = mockQuery.mock.calls[0];
      expect(call[0].values).toEqual(["42", "7"]);
    });

    it("returns error for record not found", async () => {
      const mockPool = createMockPool();
      const mockQuery = getMockQuery(mockPool);
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const ctx = await setupMcpTest({ pool: mockPool, readPool: mockPool });
      client = ctx.client;
      cleanup = () => Promise.all([ctx.client.close(), ctx.mcpServer.close()]).then(() => {});

      const result = await client.callTool({
        name: "get_record",
        arguments: { table: "users", id: "999" },
      });
      expect(result.isError).toBe(true);
      expect((result.content as Array<{ type: string; text: string }>)[0].text).toContain("not found");
    });

    it("returns error for table without primary key", async () => {
      const ctx = await setupMcpTest();
      client = ctx.client;
      cleanup = () => Promise.all([ctx.client.close(), ctx.mcpServer.close()]).then(() => {});

      const result = await client.callTool({
        name: "get_record",
        arguments: { table: "audit_logs", id: "1" },
      });
      expect(result.isError).toBe(true);
      expect((result.content as Array<{ type: string; text: string }>)[0].text).toContain("no primary key");
    });

    it("returns error for non-existent table", async () => {
      const ctx = await setupMcpTest();
      client = ctx.client;
      cleanup = () => Promise.all([ctx.client.close(), ctx.mcpServer.close()]).then(() => {});

      const result = await client.callTool({
        name: "get_record",
        arguments: { table: "nonexistent", id: "1" },
      });
      expect(result.isError).toBe(true);
    });

    it("denies access with insufficient permissions", async () => {
      const mockPool = createMockPool();
      const ctx = await setupMcpTest({ pool: mockPool, readPool: mockPool, permissions: { public: "w" } });
      client = ctx.client;
      cleanup = () => Promise.all([ctx.client.close(), ctx.mcpServer.close()]).then(() => {});

      const result = await client.callTool({
        name: "get_record",
        arguments: { table: "users", id: "1" },
      });
      expect(result.isError).toBe(true);
      expect((result.content as Array<{ type: string; text: string }>)[0].text).toContain("Permission denied");
    });

    it("supports column selection", async () => {
      const mockPool = createMockPool();
      const mockQuery = getMockQuery(mockPool);
      mockQuery.mockResolvedValueOnce({ rows: [{ name: "Alice" }], rowCount: 1 });

      const ctx = await setupMcpTest({ pool: mockPool, readPool: mockPool });
      client = ctx.client;
      cleanup = () => Promise.all([ctx.client.close(), ctx.mcpServer.close()]).then(() => {});

      const result = await client.callTool({
        name: "get_record",
        arguments: { table: "users", id: "1", select: ["name"] },
      });
      expect(result.isError).toBeFalsy();

      const call = mockQuery.mock.calls[0];
      expect(call[0].text).toContain('"name"');
    });

    it("handles invalid composite key format", async () => {
      const ctx = await setupMcpTest();
      client = ctx.client;
      cleanup = () => Promise.all([ctx.client.close(), ctx.mcpServer.close()]).then(() => {});

      const result = await client.callTool({
        name: "get_record",
        arguments: { table: "user_roles", id: "42" }, // Missing second PK value
      });
      expect(result.isError).toBe(true);
      expect((result.content as Array<{ type: string; text: string }>)[0].text).toContain("Composite primary key expects 2 values");
    });

    it("uses read pool for get_record", async () => {
      const writePool = createMockPool();
      const readPool = createMockPool();
      const readQuery = getMockQuery(readPool);
      readQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 });

      const ctx = await setupMcpTest({ pool: writePool, readPool });
      client = ctx.client;
      cleanup = () => Promise.all([ctx.client.close(), ctx.mcpServer.close()]).then(() => {});

      await client.callTool({
        name: "get_record",
        arguments: { table: "users", id: "1" },
      });

      expect(readQuery).toHaveBeenCalledTimes(1);
      expect(getMockQuery(writePool)).not.toHaveBeenCalled();
    });
  });

  // ── Tool: create_record ────────────────────────────────────────────

  describe("create_record", () => {
    it("creates a single record", async () => {
      const mockPool = createMockPool();
      const mockQuery = getMockQuery(mockPool);
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 1, name: "Alice", email: "alice@example.com" }],
        rowCount: 1,
      });

      const ctx = await setupMcpTest({ pool: mockPool, readPool: mockPool });
      client = ctx.client;
      cleanup = () => Promise.all([ctx.client.close(), ctx.mcpServer.close()]).then(() => {});

      const result = await client.callTool({
        name: "create_record",
        arguments: {
          table: "users",
          data: { name: "Alice", email: "alice@example.com" },
        },
      });
      const parsed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text);

      expect(parsed.id).toBe(1);
      expect(parsed.name).toBe("Alice");
      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(mockQuery.mock.calls[0][0].text).toContain("INSERT INTO");
    });

    it("creates multiple records (bulk insert)", async () => {
      const mockPool = createMockPool();
      const mockQuery = getMockQuery(mockPool);
      mockQuery.mockResolvedValueOnce({
        rows: [
          { id: 1, name: "Alice", email: "a@test.com" },
          { id: 2, name: "Bob", email: "b@test.com" },
        ],
        rowCount: 2,
      });

      const ctx = await setupMcpTest({ pool: mockPool, readPool: mockPool });
      client = ctx.client;
      cleanup = () => Promise.all([ctx.client.close(), ctx.mcpServer.close()]).then(() => {});

      const result = await client.callTool({
        name: "create_record",
        arguments: {
          table: "users",
          data: [
            { name: "Alice", email: "a@test.com" },
            { name: "Bob", email: "b@test.com" },
          ],
        },
      });
      const parsed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text);

      expect(parsed.data).toHaveLength(2);
      expect(parsed.count).toBe(2);
    });

    it("uses write pool for inserts", async () => {
      const writePool = createMockPool();
      const readPool = createMockPool();
      const writeQuery = getMockQuery(writePool);
      writeQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 });

      const ctx = await setupMcpTest({ pool: writePool, readPool });
      client = ctx.client;
      cleanup = () => Promise.all([ctx.client.close(), ctx.mcpServer.close()]).then(() => {});

      await client.callTool({
        name: "create_record",
        arguments: { table: "users", data: { name: "Alice", email: "a@test.com" } },
      });

      expect(writeQuery).toHaveBeenCalledTimes(1);
      expect(getMockQuery(readPool)).not.toHaveBeenCalled();
    });

    it("denies write access with read-only permissions", async () => {
      const mockPool = createMockPool();
      const ctx = await setupMcpTest({ pool: mockPool, readPool: mockPool, permissions: { public: "r" } });
      client = ctx.client;
      cleanup = () => Promise.all([ctx.client.close(), ctx.mcpServer.close()]).then(() => {});

      const result = await client.callTool({
        name: "create_record",
        arguments: { table: "users", data: { name: "Alice", email: "a@test.com" } },
      });
      expect(result.isError).toBe(true);
      expect((result.content as Array<{ type: string; text: string }>)[0].text).toContain("Permission denied");
    });

    it("returns error for non-existent table", async () => {
      const ctx = await setupMcpTest();
      client = ctx.client;
      cleanup = () => Promise.all([ctx.client.close(), ctx.mcpServer.close()]).then(() => {});

      const result = await client.callTool({
        name: "create_record",
        arguments: { table: "nonexistent", data: { foo: "bar" } },
      });
      expect(result.isError).toBe(true);
    });

    it("handles database errors (duplicate key)", async () => {
      const mockPool = createMockPool();
      const mockQuery = getMockQuery(mockPool);
      const pgError = new Error("duplicate key") as any;
      pgError.code = "23505";
      pgError.detail = "Key (email)=(dup@test.com) already exists.";
      mockQuery.mockRejectedValueOnce(pgError);

      const ctx = await setupMcpTest({ pool: mockPool, readPool: mockPool });
      client = ctx.client;
      cleanup = () => Promise.all([ctx.client.close(), ctx.mcpServer.close()]).then(() => {});

      const result = await client.callTool({
        name: "create_record",
        arguments: { table: "users", data: { name: "Alice", email: "dup@test.com" } },
      });
      expect(result.isError).toBe(true);
      expect((result.content as Array<{ type: string; text: string }>)[0].text).toContain("Duplicate key");
    });

    it("exposes db error details when configured", async () => {
      (config as any).exposeDbErrors = true;

      const mockPool = createMockPool();
      const mockQuery = getMockQuery(mockPool);
      const pgError = new Error("duplicate key") as any;
      pgError.code = "23505";
      pgError.detail = "Key (email)=(dup@test.com) already exists.";
      mockQuery.mockRejectedValueOnce(pgError);

      const ctx = await setupMcpTest({ pool: mockPool, readPool: mockPool });
      client = ctx.client;
      cleanup = () => Promise.all([ctx.client.close(), ctx.mcpServer.close()]).then(() => {});

      const result = await client.callTool({
        name: "create_record",
        arguments: { table: "users", data: { name: "Alice", email: "dup@test.com" } },
      });
      expect(result.isError).toBe(true);
      expect((result.content as Array<{ type: string; text: string }>)[0].text).toContain("Key (email)");

      (config as any).exposeDbErrors = false;
    });
  });

  // ── Tool: update_record ────────────────────────────────────────────

  describe("update_record", () => {
    it("updates a record by primary key", async () => {
      const mockPool = createMockPool();
      const mockQuery = getMockQuery(mockPool);
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 1, name: "Updated", email: "alice@example.com", active: true }],
        rowCount: 1,
      });

      const ctx = await setupMcpTest({ pool: mockPool, readPool: mockPool });
      client = ctx.client;
      cleanup = () => Promise.all([ctx.client.close(), ctx.mcpServer.close()]).then(() => {});

      const result = await client.callTool({
        name: "update_record",
        arguments: {
          table: "users",
          id: "1",
          data: { name: "Updated" },
        },
      });
      const parsed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text);

      expect(parsed.name).toBe("Updated");
      expect(mockQuery.mock.calls[0][0].text).toContain("UPDATE");
    });

    it("returns error for record not found", async () => {
      const mockPool = createMockPool();
      const mockQuery = getMockQuery(mockPool);
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const ctx = await setupMcpTest({ pool: mockPool, readPool: mockPool });
      client = ctx.client;
      cleanup = () => Promise.all([ctx.client.close(), ctx.mcpServer.close()]).then(() => {});

      const result = await client.callTool({
        name: "update_record",
        arguments: { table: "users", id: "999", data: { name: "Test" } },
      });
      expect(result.isError).toBe(true);
      expect((result.content as Array<{ type: string; text: string }>)[0].text).toContain("not found");
    });

    it("denies write access with read-only permissions", async () => {
      const mockPool = createMockPool();
      const ctx = await setupMcpTest({ pool: mockPool, readPool: mockPool, permissions: { public: "r" } });
      client = ctx.client;
      cleanup = () => Promise.all([ctx.client.close(), ctx.mcpServer.close()]).then(() => {});

      const result = await client.callTool({
        name: "update_record",
        arguments: { table: "users", id: "1", data: { name: "Test" } },
      });
      expect(result.isError).toBe(true);
      expect((result.content as Array<{ type: string; text: string }>)[0].text).toContain("Permission denied");
    });

    it("returns error for table without primary key", async () => {
      const ctx = await setupMcpTest();
      client = ctx.client;
      cleanup = () => Promise.all([ctx.client.close(), ctx.mcpServer.close()]).then(() => {});

      const result = await client.callTool({
        name: "update_record",
        arguments: { table: "audit_logs", id: "1", data: { event: "test" } },
      });
      expect(result.isError).toBe(true);
      expect((result.content as Array<{ type: string; text: string }>)[0].text).toContain("no primary key");
    });

    it("uses write pool for updates", async () => {
      const writePool = createMockPool();
      const readPool = createMockPool();
      const writeQuery = getMockQuery(writePool);
      writeQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 });

      const ctx = await setupMcpTest({ pool: writePool, readPool });
      client = ctx.client;
      cleanup = () => Promise.all([ctx.client.close(), ctx.mcpServer.close()]).then(() => {});

      await client.callTool({
        name: "update_record",
        arguments: { table: "users", id: "1", data: { name: "Test" } },
      });

      expect(writeQuery).toHaveBeenCalledTimes(1);
      expect(getMockQuery(readPool)).not.toHaveBeenCalled();
    });

    it("returns error for non-existent table", async () => {
      const ctx = await setupMcpTest();
      client = ctx.client;
      cleanup = () => Promise.all([ctx.client.close(), ctx.mcpServer.close()]).then(() => {});

      const result = await client.callTool({
        name: "update_record",
        arguments: { table: "nonexistent", id: "1", data: { foo: "bar" } },
      });
      expect(result.isError).toBe(true);
    });
  });

  // ── Tool: delete_record ────────────────────────────────────────────

  describe("delete_record", () => {
    it("deletes a record by primary key", async () => {
      const mockPool = createMockPool();
      const mockQuery = getMockQuery(mockPool);
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 1, name: "Alice" }],
        rowCount: 1,
      });

      const ctx = await setupMcpTest({ pool: mockPool, readPool: mockPool });
      client = ctx.client;
      cleanup = () => Promise.all([ctx.client.close(), ctx.mcpServer.close()]).then(() => {});

      const result = await client.callTool({
        name: "delete_record",
        arguments: { table: "users", id: "1" },
      });
      const parsed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text);

      expect(parsed.deleted).toBe(true);
      expect(parsed.record.id).toBe(1);
      expect(mockQuery.mock.calls[0][0].text).toContain("DELETE FROM");
    });

    it("returns error for record not found", async () => {
      const mockPool = createMockPool();
      const mockQuery = getMockQuery(mockPool);
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const ctx = await setupMcpTest({ pool: mockPool, readPool: mockPool });
      client = ctx.client;
      cleanup = () => Promise.all([ctx.client.close(), ctx.mcpServer.close()]).then(() => {});

      const result = await client.callTool({
        name: "delete_record",
        arguments: { table: "users", id: "999" },
      });
      expect(result.isError).toBe(true);
      expect((result.content as Array<{ type: string; text: string }>)[0].text).toContain("not found");
    });

    it("denies write access with read-only permissions", async () => {
      const mockPool = createMockPool();
      const ctx = await setupMcpTest({ pool: mockPool, readPool: mockPool, permissions: { public: "r" } });
      client = ctx.client;
      cleanup = () => Promise.all([ctx.client.close(), ctx.mcpServer.close()]).then(() => {});

      const result = await client.callTool({
        name: "delete_record",
        arguments: { table: "users", id: "1" },
      });
      expect(result.isError).toBe(true);
      expect((result.content as Array<{ type: string; text: string }>)[0].text).toContain("Permission denied");
    });

    it("returns error for table without primary key", async () => {
      const ctx = await setupMcpTest();
      client = ctx.client;
      cleanup = () => Promise.all([ctx.client.close(), ctx.mcpServer.close()]).then(() => {});

      const result = await client.callTool({
        name: "delete_record",
        arguments: { table: "audit_logs", id: "1" },
      });
      expect(result.isError).toBe(true);
      expect((result.content as Array<{ type: string; text: string }>)[0].text).toContain("no primary key");
    });

    it("uses write pool for deletes", async () => {
      const writePool = createMockPool();
      const readPool = createMockPool();
      const writeQuery = getMockQuery(writePool);
      writeQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 });

      const ctx = await setupMcpTest({ pool: writePool, readPool });
      client = ctx.client;
      cleanup = () => Promise.all([ctx.client.close(), ctx.mcpServer.close()]).then(() => {});

      await client.callTool({
        name: "delete_record",
        arguments: { table: "users", id: "1" },
      });

      expect(writeQuery).toHaveBeenCalledTimes(1);
      expect(getMockQuery(readPool)).not.toHaveBeenCalled();
    });

    it("returns error for non-existent table", async () => {
      const ctx = await setupMcpTest();
      client = ctx.client;
      cleanup = () => Promise.all([ctx.client.close(), ctx.mcpServer.close()]).then(() => {});

      const result = await client.callTool({
        name: "delete_record",
        arguments: { table: "nonexistent", id: "1" },
      });
      expect(result.isError).toBe(true);
    });

    it("handles database errors (FK violation)", async () => {
      const mockPool = createMockPool();
      const mockQuery = getMockQuery(mockPool);
      const pgError = new Error("FK violation") as any;
      pgError.code = "23503";
      mockQuery.mockRejectedValueOnce(pgError);

      const ctx = await setupMcpTest({ pool: mockPool, readPool: mockPool });
      client = ctx.client;
      cleanup = () => Promise.all([ctx.client.close(), ctx.mcpServer.close()]).then(() => {});

      const result = await client.callTool({
        name: "delete_record",
        arguments: { table: "users", id: "1" },
      });
      expect(result.isError).toBe(true);
      expect((result.content as Array<{ type: string; text: string }>)[0].text).toContain("Foreign key violation");
    });

    it("soft-deletes when table has deleted_at column", async () => {
      const mockPool = createMockPool();
      const mockQuery = getMockQuery(mockPool);
      const now = new Date().toISOString();
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 5, user_id: 1, title: "Hello", body: "World", created_at: "2025-01-01", deleted_at: now }],
        rowCount: 1,
      });

      const ctx = await setupMcpTest({ pool: mockPool, readPool: mockPool });
      client = ctx.client;
      cleanup = () => Promise.all([ctx.client.close(), ctx.mcpServer.close()]).then(() => {});

      const result = await client.callTool({
        name: "delete_record",
        arguments: { table: "posts", id: "5" },
      });
      const parsed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text);

      expect(parsed.deleted).toBe(true);
      expect(parsed.softDelete).toBe(true);
      expect(parsed.record.deleted_at).toBe(now);

      // Verify the SQL was an UPDATE, not DELETE
      const sql = mockQuery.mock.calls[0][0].text;
      expect(sql).toContain("UPDATE");
      expect(sql).toContain('SET "deleted_at" = NOW()');
      expect(sql).not.toContain("DELETE FROM");
    });

    it("hard-deletes when table has no deleted_at column", async () => {
      const mockPool = createMockPool();
      const mockQuery = getMockQuery(mockPool);
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 1, name: "Alice" }],
        rowCount: 1,
      });

      const ctx = await setupMcpTest({ pool: mockPool, readPool: mockPool });
      client = ctx.client;
      cleanup = () => Promise.all([ctx.client.close(), ctx.mcpServer.close()]).then(() => {});

      const result = await client.callTool({
        name: "delete_record",
        arguments: { table: "users", id: "1" },
      });
      const parsed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text);

      expect(parsed.deleted).toBe(true);
      expect(parsed.softDelete).toBe(false);
      expect(mockQuery.mock.calls[0][0].text).toContain("DELETE FROM");
    });
  });

  // ── Tool listing ───────────────────────────────────────────────────

  describe("tool listing", () => {
    it("lists all available tools", async () => {
      const ctx = await setupMcpTest();
      client = ctx.client;
      cleanup = () => Promise.all([ctx.client.close(), ctx.mcpServer.close()]).then(() => {});

      const result = await client.listTools();

      expect(result.tools).toHaveLength(7);
      const toolNames = result.tools.map((t) => t.name).sort();
      expect(toolNames).toEqual([
        "create_record",
        "delete_record",
        "describe_table",
        "get_record",
        "list_records",
        "list_tables",
        "update_record",
      ]);

      // Check tool has description
      const listTables = result.tools.find((t) => t.name === "list_tables");
      expect(listTables!.description).toBeDefined();
      expect(listTables!.description!.length).toBeGreaterThan(0);
    });
  });

  // ── Resources ──────────────────────────────────────────────────────

  describe("resources", () => {
    it("lists available resources", async () => {
      const ctx = await setupMcpTest();
      client = ctx.client;
      cleanup = () => Promise.all([ctx.client.close(), ctx.mcpServer.close()]).then(() => {});

      const result = await client.listResources();

      // Should have the static schema resource
      expect(result.resources.some((r) => r.uri === "db://schema")).toBe(true);
    });

    it("reads the full database schema resource", async () => {
      const ctx = await setupMcpTest();
      client = ctx.client;
      cleanup = () => Promise.all([ctx.client.close(), ctx.mcpServer.close()]).then(() => {});

      const result = await client.readResource({ uri: "db://schema" });
      const content = result.contents[0];
      expect(content.uri).toBe("db://schema");
      expect(content.mimeType).toBe("application/json");

      const parsed = JSON.parse(content.text as string);
      expect(parsed.api).toBeDefined();
      expect(parsed.api.pagination).toBeDefined();
      expect(parsed.api.filtering).toBeDefined();
      expect(parsed.tables).toHaveLength(6);
    });

    it("filters schema resource by permissions", async () => {
      const ctx = await setupMcpTest({ permissions: { reporting: "r" } });
      client = ctx.client;
      cleanup = () => Promise.all([ctx.client.close(), ctx.mcpServer.close()]).then(() => {});

      const result = await client.readResource({ uri: "db://schema" });
      const parsed = JSON.parse(result.contents[0].text as string);

      expect(parsed.tables).toHaveLength(1);
      expect(parsed.tables[0].name).toBe("metrics");
    });

    it("lists resource templates", async () => {
      const ctx = await setupMcpTest();
      client = ctx.client;
      cleanup = () => Promise.all([ctx.client.close(), ctx.mcpServer.close()]).then(() => {});

      const result = await client.listResourceTemplates();
      expect(result.resourceTemplates.some((t) => t.uriTemplate === "db://tables/{table}")).toBe(true);
    });

    it("reads a per-table resource", async () => {
      const ctx = await setupMcpTest();
      client = ctx.client;
      cleanup = () => Promise.all([ctx.client.close(), ctx.mcpServer.close()]).then(() => {});

      const result = await client.readResource({ uri: "db://tables/users" });
      const parsed = JSON.parse(result.contents[0].text as string);

      expect(parsed.name).toBe("users");
      expect(parsed.schema).toBe("public");
      expect(parsed.columns).toBeDefined();
      expect(parsed.primaryKeys).toEqual(["id"]);
    });

    it("returns error for non-existent table resource", async () => {
      const ctx = await setupMcpTest();
      client = ctx.client;
      cleanup = () => Promise.all([ctx.client.close(), ctx.mcpServer.close()]).then(() => {});

      const result = await client.readResource({ uri: "db://tables/nonexistent" });
      const parsed = JSON.parse(result.contents[0].text as string);
      expect(parsed.error).toBeDefined();
    });

    it("filters per-table resource by permissions", async () => {
      const ctx = await setupMcpTest({ permissions: { public: "r" } });
      client = ctx.client;
      cleanup = () => Promise.all([ctx.client.close(), ctx.mcpServer.close()]).then(() => {});

      const result = await client.readResource({ uri: "db://tables/reporting__metrics" });
      const parsed = JSON.parse(result.contents[0].text as string);
      expect(parsed.error).toBeDefined();
    });
  });

  // ── Prompts ────────────────────────────────────────────────────────

  describe("prompts", () => {
    it("lists available prompts", async () => {
      const ctx = await setupMcpTest();
      client = ctx.client;
      cleanup = () => Promise.all([ctx.client.close(), ctx.mcpServer.close()]).then(() => {});

      const result = await client.listPrompts();

      expect(result.prompts).toHaveLength(2);
      const promptNames = result.prompts.map((p) => p.name).sort();
      expect(promptNames).toEqual(["crud-guide", "explore-database"]);
    });

    it("returns explore-database prompt", async () => {
      const ctx = await setupMcpTest();
      client = ctx.client;
      cleanup = () => Promise.all([ctx.client.close(), ctx.mcpServer.close()]).then(() => {});

      const result = await client.getPrompt({ name: "explore-database" });

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].role).toBe("user");
      const text = (result.messages[0].content as { type: string; text: string }).text;
      expect(text).toContain("PostgreSQL database");
      expect(text).toContain("6 tables");
      expect(text).toContain("list_tables");
      expect(text).toContain("describe_table");
    });

    it("returns crud-guide prompt for a table", async () => {
      const ctx = await setupMcpTest();
      client = ctx.client;
      cleanup = () => Promise.all([ctx.client.close(), ctx.mcpServer.close()]).then(() => {});

      const result = await client.getPrompt({
        name: "crud-guide",
        arguments: { table: "users" },
      });

      expect(result.messages).toHaveLength(1);
      const text = (result.messages[0].content as { type: string; text: string }).text;
      expect(text).toContain("users");
      expect(text).toContain("Primary keys: id");
      expect(text).toContain("list_records");
      expect(text).toContain("get_record");
      expect(text).toContain("create_record");
      expect(text).toContain("update_record");
      expect(text).toContain("delete_record");
      expect(text).toContain("Filter examples");
    });

    it("returns crud-guide prompt for table without PK", async () => {
      const ctx = await setupMcpTest();
      client = ctx.client;
      cleanup = () => Promise.all([ctx.client.close(), ctx.mcpServer.close()]).then(() => {});

      const result = await client.getPrompt({
        name: "crud-guide",
        arguments: { table: "audit_logs" },
      });

      const text = (result.messages[0].content as { type: string; text: string }).text;
      expect(text).toContain("NONE");
      // Should not include get/update/delete since no PK
      expect(text).not.toContain("get_record");
      expect(text).not.toContain("update_record");
      expect(text).not.toContain("delete_record");
    });

    it("returns error message for non-existent table in crud-guide", async () => {
      const ctx = await setupMcpTest();
      client = ctx.client;
      cleanup = () => Promise.all([ctx.client.close(), ctx.mcpServer.close()]).then(() => {});

      const result = await client.getPrompt({
        name: "crud-guide",
        arguments: { table: "nonexistent" },
      });

      const text = (result.messages[0].content as { type: string; text: string }).text;
      expect(text).toContain("not found");
      expect(text).toContain("list_tables");
    });

    it("filters explore-database by permissions", async () => {
      const ctx = await setupMcpTest({ permissions: { reporting: "r" } });
      client = ctx.client;
      cleanup = () => Promise.all([ctx.client.close(), ctx.mcpServer.close()]).then(() => {});

      const result = await client.getPrompt({ name: "explore-database" });
      const text = (result.messages[0].content as { type: string; text: string }).text;

      expect(text).toContain("1 tables");
      expect(text).toContain("reporting.metrics");
      expect(text).not.toContain("users");
    });

    it("denies crud-guide when no permission to schema", async () => {
      const ctx = await setupMcpTest({ permissions: { reporting: "r" } });
      client = ctx.client;
      cleanup = () => Promise.all([ctx.client.close(), ctx.mcpServer.close()]).then(() => {});

      const result = await client.getPrompt({
        name: "crud-guide",
        arguments: { table: "users" },
      });
      const text = (result.messages[0].content as { type: string; text: string }).text;
      expect(text).toContain("not found");
    });

    it("shows FK info in crud-guide for table with foreign keys", async () => {
      const ctx = await setupMcpTest();
      client = ctx.client;
      cleanup = () => Promise.all([ctx.client.close(), ctx.mcpServer.close()]).then(() => {});

      const result = await client.getPrompt({
        name: "crud-guide",
        arguments: { table: "orders" },
      });
      const text = (result.messages[0].content as { type: string; text: string }).text;
      expect(text).toContain("Foreign keys");
      expect(text).toContain("user_id");
    });

    it("omits searchable columns section for table without text columns", async () => {
      const ctx = await setupMcpTest();
      client = ctx.client;
      cleanup = () => Promise.all([ctx.client.close(), ctx.mcpServer.close()]).then(() => {});

      // user_roles has only int4 and timestamptz columns — no searchable text columns
      const result = await client.getPrompt({
        name: "crud-guide",
        arguments: { table: "user_roles" },
      });
      const text = (result.messages[0].content as { type: string; text: string }).text;
      expect(text).not.toContain("Searchable columns");
      expect(text).toContain("user_roles");
    });

    it("shows 'none' for required insert cols when all have defaults or are nullable", async () => {
      // Create a custom table where all columns have defaults or are nullable
      const allDefaultsTable: TableInfo = {
        schema: "public",
        name: "settings",
        fqn: '"public"."settings"',
        routePath: "settings",
        primaryKeys: ["id"],
        foreignKeys: [],
        columns: [
          makeColumn({ name: "id", dataType: "integer", udtName: "int4", isNullable: false, hasDefault: true, defaultValue: "nextval('settings_id_seq'::regclass)", ordinalPosition: 1 }),
          makeColumn({ name: "value", dataType: "text", udtName: "text", isNullable: true, hasDefault: false, ordinalPosition: 2 }),
          makeColumn({ name: "updated_at", dataType: "timestamp with time zone", udtName: "timestamptz", isNullable: false, hasDefault: true, defaultValue: "now()", ordinalPosition: 3 }),
        ],
      };
      const dbSchema = makeDatabaseSchema([allDefaultsTable]);

      const mcpServer = createMcpServer({
        pool: createMockPool(),
        readPool: createMockPool(),
        dbSchema,
        permissions: null,
      });

      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const testClient = new Client({ name: "test-client", version: "1.0.0" });
      await Promise.all([mcpServer.connect(serverTransport), testClient.connect(clientTransport)]);

      cleanup = () => Promise.all([testClient.close(), mcpServer.close()]).then(() => {});
      client = testClient;

      const result = await testClient.getPrompt({
        name: "crud-guide",
        arguments: { table: "settings" },
      });
      const text = (result.messages[0].content as { type: string; text: string }).text;
      expect(text).toContain("none (all have defaults or are nullable)");
    });
  });

  // ── Error handling ─────────────────────────────────────────────────

  describe("error handling", () => {
    it("handles unknown database errors", async () => {
      const mockPool = createMockPool();
      const mockQuery = getMockQuery(mockPool);
      const pgError = new Error("unknown error") as any;
      pgError.code = "XX000"; // unmapped code
      mockQuery.mockRejectedValueOnce(pgError);

      const ctx = await setupMcpTest({ pool: mockPool, readPool: mockPool });
      client = ctx.client;
      cleanup = () => Promise.all([ctx.client.close(), ctx.mcpServer.close()]).then(() => {});

      const result = await client.callTool({
        name: "create_record",
        arguments: { table: "users", data: { name: "Test", email: "t@t.com" } },
      });
      expect(result.isError).toBe(true);
      // Should use the error's message
      expect((result.content as Array<{ type: string; text: string }>)[0].text).toContain("unknown error");
    });

    it("handles errors without code or message", async () => {
      const mockPool = createMockPool();
      const mockQuery = getMockQuery(mockPool);
      mockQuery.mockRejectedValueOnce({});

      const ctx = await setupMcpTest({ pool: mockPool, readPool: mockPool });
      client = ctx.client;
      cleanup = () => Promise.all([ctx.client.close(), ctx.mcpServer.close()]).then(() => {});

      const result = await client.callTool({
        name: "create_record",
        arguments: { table: "users", data: { name: "Test", email: "t@t.com" } },
      });
      expect(result.isError).toBe(true);
      expect((result.content as Array<{ type: string; text: string }>)[0].text).toContain("unexpected");
    });

    it("handles not null violation", async () => {
      const mockPool = createMockPool();
      const mockQuery = getMockQuery(mockPool);
      const pgError = new Error("not null") as any;
      pgError.code = "23502";
      mockQuery.mockRejectedValueOnce(pgError);

      const ctx = await setupMcpTest({ pool: mockPool, readPool: mockPool });
      client = ctx.client;
      cleanup = () => Promise.all([ctx.client.close(), ctx.mcpServer.close()]).then(() => {});

      const result = await client.callTool({
        name: "create_record",
        arguments: { table: "users", data: { active: true } },
      });
      expect(result.isError).toBe(true);
      expect((result.content as Array<{ type: string; text: string }>)[0].text).toContain("Not null violation");
    });

    it("handles invalid data type", async () => {
      const mockPool = createMockPool();
      const mockQuery = getMockQuery(mockPool);
      const pgError = new Error("invalid input") as any;
      pgError.code = "22P02";
      mockQuery.mockRejectedValueOnce(pgError);

      const ctx = await setupMcpTest({ pool: mockPool, readPool: mockPool });
      client = ctx.client;
      cleanup = () => Promise.all([ctx.client.close(), ctx.mcpServer.close()]).then(() => {});

      const result = await client.callTool({
        name: "create_record",
        arguments: { table: "users", data: { name: "Test", email: "t@t.com" } },
      });
      expect(result.isError).toBe(true);
      expect((result.content as Array<{ type: string; text: string }>)[0].text).toContain("Invalid data type");
    });
  });
});
