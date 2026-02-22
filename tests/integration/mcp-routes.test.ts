import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { buildTestApp, createMockPool } from "./setup.js";
import {
  makeUsersTable,
  makeNoPkTable,
  makeDatabaseSchema,
} from "../fixtures/tables.js";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { generateApiKey } from "../../src/auth/api-key.js";

// ─── Helpers ─────────────────────────────────────────────────────────

function jsonRpcRequest(method: string, params?: unknown, id: number = 1) {
  return { jsonrpc: "2.0", method, params: params ?? {}, id };
}

function getMockQuery(pool: Pool) {
  return (pool as unknown as { query: ReturnType<typeof vi.fn> }).query;
}

/** Extract the JSON-RPC response from a hijacked inject response body. */
function parseRpcResponse(body: string) {
  return JSON.parse(body);
}

async function initMcpSession(
  app: FastifyInstance,
  headers?: Record<string, string>,
): Promise<string> {
  const initRes = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    payload: jsonRpcRequest("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0" },
    }),
  });

  const sessionId = initRes.headers["mcp-session-id"] as string;

  // Send initialized notification
  await app.inject({
    method: "POST",
    url: "/mcp",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
      ...headers,
    },
    payload: { jsonrpc: "2.0", method: "notifications/initialized" },
  });

  return sessionId;
}

async function mcpToolCall(
  app: FastifyInstance,
  sessionId: string,
  toolName: string,
  args: Record<string, unknown>,
  headers?: Record<string, string>,
  id: number = 2,
) {
  const res = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
      ...headers,
    },
    payload: jsonRpcRequest("tools/call", {
      name: toolName,
      arguments: args,
    }, id),
  });

  return parseRpcResponse(res.body);
}

// ─── Tests ───────────────────────────────────────────────────────────

describe("MCP HTTP Routes", () => {
  describe("without auth", () => {
    let app: FastifyInstance;
    let pool: Pool;

    beforeAll(async () => {
      pool = createMockPool();
      const dbSchema = makeDatabaseSchema([makeUsersTable(), makeNoPkTable()]);
      app = await buildTestApp({ dbSchema, pool });
    });

    afterAll(async () => {
      await app.close();
    });

    it("initializes an MCP session via POST /mcp", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        payload: jsonRpcRequest("initialize", {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0" },
        }),
      });

      expect(res.statusCode).toBeLessThan(500);
      expect(res.headers["mcp-session-id"]).toBeDefined();

      const body = parseRpcResponse(res.body);
      expect(body.result).toBeDefined();
      expect(body.result.serverInfo.name).toBe("pg-crud-api");
    });

    it("returns 400 for GET /mcp without session ID", async () => {
      const res = await app.inject({ method: "GET", url: "/mcp" });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain("session");
    });

    it("returns 400 for GET /mcp with invalid session ID", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/mcp",
        headers: { "mcp-session-id": "nonexistent-session" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 400 for DELETE /mcp without session ID", async () => {
      const res = await app.inject({ method: "DELETE", url: "/mcp" });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain("session");
    });

    it("returns 400 for DELETE /mcp with invalid session ID", async () => {
      const res = await app.inject({
        method: "DELETE",
        url: "/mcp",
        headers: { "mcp-session-id": "nonexistent-session" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("handles full session lifecycle: init → tool call → close", async () => {
      const sessionId = await initMcpSession(app);
      expect(sessionId).toBeDefined();

      // Call list_tables tool
      const rpcResponse = await mcpToolCall(app, sessionId, "list_tables", {});

      expect(rpcResponse.result).toBeDefined();
      expect(rpcResponse.result.content[0].type).toBe("text");

      const tableData = JSON.parse(rpcResponse.result.content[0].text);
      expect(tableData.count).toBe(2);
      expect(tableData.tables).toHaveLength(2);

      // Close session
      const deleteRes = await app.inject({
        method: "DELETE",
        url: "/mcp",
        headers: { "mcp-session-id": sessionId },
      });
      expect(deleteRes.statusCode).toBe(200);
      expect(deleteRes.json().closed).toBe(true);

      // Verify session is gone
      const afterDeleteRes = await app.inject({
        method: "DELETE",
        url: "/mcp",
        headers: { "mcp-session-id": sessionId },
      });
      expect(afterDeleteRes.statusCode).toBe(400);
    });

    it("reuses existing session on subsequent POST", async () => {
      const sessionId = await initMcpSession(app);

      // Call tools/list with same session — should reuse
      const listRes = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-session-id": sessionId,
        },
        payload: jsonRpcRequest("tools/list", {}, 3),
      });

      const rpcResponse = parseRpcResponse(listRes.body);
      expect(rpcResponse.result.tools).toBeDefined();
      expect(rpcResponse.result.tools.length).toBe(7);

      // Cleanup
      await app.inject({
        method: "DELETE",
        url: "/mcp",
        headers: { "mcp-session-id": sessionId },
      });
    });

    it("accepts GET /mcp with valid session for SSE stream", async () => {
      const sessionId = await initMcpSession(app);

      const res = await app.inject({
        method: "GET",
        url: "/mcp",
        headers: { "mcp-session-id": sessionId },
      });

      // Transport handles the SSE request — status should not be 400
      expect(res.statusCode).not.toBe(400);

      // Cleanup
      await app.inject({
        method: "DELETE",
        url: "/mcp",
        headers: { "mcp-session-id": sessionId },
      });
    });

    it("does not persist session when POST has no initialize request", async () => {
      // Send a non-initialize request without a session — transport won't set sessionId
      const res = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        payload: jsonRpcRequest("tools/list", {}),
      });

      // Transport should reject non-init requests on a fresh connection
      expect(res.statusCode).toBeLessThan(500);
    });

    it("executes CRUD tools through HTTP transport", async () => {
      const mockQuery = getMockQuery(pool);
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 1, name: "Alice", email: "a@test.com", active: true }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [{ total: "1" }], rowCount: 1 });

      const sessionId = await initMcpSession(app);

      const rpcResponse = await mcpToolCall(app, sessionId, "list_records", { table: "users" });
      const records = JSON.parse(rpcResponse.result.content[0].text);

      expect(records.data).toHaveLength(1);
      expect(records.data[0].name).toBe("Alice");

      // Cleanup
      await app.inject({
        method: "DELETE",
        url: "/mcp",
        headers: { "mcp-session-id": sessionId },
      });
    });
  });

  describe("with auth", () => {
    const secret = "test-mcp-secret";
    let authApp: FastifyInstance;
    let authPool: Pool;

    beforeAll(async () => {
      authPool = createMockPool();
      const dbSchema = makeDatabaseSchema([makeUsersTable()]);
      authApp = await buildTestApp({
        dbSchema,
        pool: authPool,
        authEnabled: true,
        authSecret: secret,
      });
    });

    afterAll(async () => {
      await authApp.close();
    });

    it("requires authentication for MCP endpoint", async () => {
      const res = await authApp.inject({
        method: "POST",
        url: "/mcp",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        payload: jsonRpcRequest("initialize", {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0" },
        }),
      });

      expect(res.statusCode).toBe(401);
    });

    it("allows authenticated MCP sessions", async () => {
      const apiKey = generateApiKey("test", secret);
      const authHeaders = { authorization: `Bearer ${apiKey}` };

      const sessionId = await initMcpSession(authApp, authHeaders);
      expect(sessionId).toBeDefined();

      // Cleanup
      await authApp.inject({
        method: "DELETE",
        url: "/mcp",
        headers: { "mcp-session-id": sessionId, ...authHeaders },
      });
    });

    it("enforces schema permissions through MCP tools", async () => {
      const readOnlyKey = generateApiKey("readonly", secret, { public: "r" });
      const authHeaders = { authorization: `Bearer ${readOnlyKey}` };

      const sessionId = await initMcpSession(authApp, authHeaders);

      // Try create_record — should be denied (write not allowed)
      const rpcResponse = await mcpToolCall(
        authApp,
        sessionId,
        "create_record",
        { table: "users", data: { name: "Alice", email: "a@test.com" } },
        authHeaders,
      );

      expect(rpcResponse.result.isError).toBe(true);
      expect(rpcResponse.result.content[0].text).toContain("Permission denied");

      // Cleanup
      await authApp.inject({
        method: "DELETE",
        url: "/mcp",
        headers: { "mcp-session-id": sessionId, ...authHeaders },
      });
    });
  });
});
