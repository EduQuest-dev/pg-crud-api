import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildTestApp, createMockPool } from "./setup.js";
import { makeUsersTable, makeDatabaseSchema } from "../fixtures/tables.js";
import { generateApiKey } from "../../src/auth/api-key.js";

const SECRET = "test-auth-secret";

describe("Auth Hook Integration", () => {
  let app: FastifyInstance;
  let mockPool: ReturnType<typeof createMockPool>;

  beforeAll(async () => {
    mockPool = createMockPool();
    app = await buildTestApp({
      dbSchema: makeDatabaseSchema([makeUsersTable()]),
      pool: mockPool as any,
      authEnabled: true,
      authSecret: SECRET,
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it("rejects unauthenticated requests with 401", async () => {
    const res = await app.inject({ method: "GET", url: "/api/users" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("Unauthorized");
  });

  it("allows requests with valid Bearer token", async () => {
    const key = generateApiKey("test", SECRET);
    (mockPool.query as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ total: "0" }], rowCount: 1 });

    const res = await app.inject({
      method: "GET",
      url: "/api/users",
      headers: { authorization: `Bearer ${key}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it("allows requests with valid X-API-Key header", async () => {
    const key = generateApiKey("test", SECRET);
    (mockPool.query as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ total: "0" }], rowCount: 1 });

    const res = await app.inject({
      method: "GET",
      url: "/api/users",
      headers: { "x-api-key": key },
    });
    expect(res.statusCode).toBe(200);
  });

  it("rejects requests with invalid key", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/users",
      headers: { authorization: "Bearer pgcrud_fake.invalidhmac" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().message).toContain("Invalid API key");
  });

  it("allows health check without auth", async () => {
    (mockPool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [{ "?column?": 1 }], rowCount: 1 });

    const res = await app.inject({ method: "GET", url: "/api/_health" });
    expect(res.statusCode).not.toBe(401);
  });

  it("allows /docs path without auth", async () => {
    const res = await app.inject({ method: "GET", url: "/docs" });
    // Will be 404 since swagger isn't registered, but NOT 401
    expect(res.statusCode).not.toBe(401);
  });

  it("allows /docs/json path without auth", async () => {
    const res = await app.inject({ method: "GET", url: "/docs/json" });
    expect(res.statusCode).not.toBe(401);
  });

  it("rejects request with missing key (only header, no value)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/users",
      headers: { authorization: "Bearer " },
    });
    expect(res.statusCode).toBe(401);
  });
});
