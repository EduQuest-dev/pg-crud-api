import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildTestApp, createMockPool } from "./setup.js";
import { makeUsersTable, makeDatabaseSchema } from "../fixtures/tables.js";
import { generateApiKey } from "../../src/auth/api-key.js";
import { computeDatabaseHash } from "../../src/db/introspector.js";

describe("Health Check - GET /api/_health", () => {
  let app: FastifyInstance;
  let mockPool: ReturnType<typeof createMockPool>;
  const dbSchema = makeDatabaseSchema([makeUsersTable()]);

  beforeAll(async () => {
    mockPool = createMockPool();
    app = await buildTestApp({
      dbSchema,
      pool: mockPool as any,
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns 200 healthy with tables/schemas/databaseHash when auth is disabled", async () => {
    (mockPool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [{ "?column?": 1 }], rowCount: 1 });

    const res = await app.inject({ method: "GET", url: "/api/_health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("healthy");
    expect(body.version).toBe("0.0.0-test");
    expect(body.buildGitHash).toBe("abc1234");
    expect(body.buildTimestamp).toBe("2025-01-01T00:00:00.000Z");
    expect(body.tables).toBe(1);
    expect(body.schemas).toEqual(["public"]);
    expect(body.databaseHash).toBe(computeDatabaseHash(dbSchema));
    expect(body.databaseHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("returns 503 unhealthy when DB query fails", async () => {
    (mockPool.query as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("connection refused"));

    const res = await app.inject({ method: "GET", url: "/api/_health" });
    expect(res.statusCode).toBe(503);
    expect(res.json().status).toBe("unhealthy");
  });

  it("returns 503 when DB query times out", async () => {
    (mockPool.query as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(resolve, 10000))
    );

    const res = await app.inject({ method: "GET", url: "/api/_health" });
    expect(res.statusCode).toBe(503);
  });
});

const AUTH_SECRET = "test-health-secret";

describe("Health Check - authenticated details", () => {
  let app: FastifyInstance;
  let mockPool: ReturnType<typeof createMockPool>;
  const dbSchema = makeDatabaseSchema([makeUsersTable()]);

  beforeAll(async () => {
    mockPool = createMockPool();
    app = await buildTestApp({
      dbSchema,
      pool: mockPool as any,
      authEnabled: true,
      authSecret: AUTH_SECRET,
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it("omits tables/schemas/databaseHash for unauthenticated requests", async () => {
    (mockPool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [{ "?column?": 1 }], rowCount: 1 });

    const res = await app.inject({ method: "GET", url: "/api/_health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("healthy");
    expect(body.version).toBe("0.0.0-test");
    expect(body).not.toHaveProperty("tables");
    expect(body).not.toHaveProperty("schemas");
    expect(body).not.toHaveProperty("databaseHash");
  });

  it("includes tables/schemas/databaseHash for authenticated requests", async () => {
    const key = generateApiKey("admin", AUTH_SECRET);
    (mockPool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [{ "?column?": 1 }], rowCount: 1 });

    const res = await app.inject({
      method: "GET",
      url: "/api/_health",
      headers: { authorization: `Bearer ${key}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("healthy");
    expect(body.version).toBe("0.0.0-test");
    expect(body.tables).toBe(1);
    expect(body.schemas).toEqual(["public"]);
    expect(body.databaseHash).toBe(computeDatabaseHash(dbSchema));
    expect(body.databaseHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("omits tables/schemas/databaseHash when API key is invalid", async () => {
    (mockPool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [{ "?column?": 1 }], rowCount: 1 });

    const res = await app.inject({
      method: "GET",
      url: "/api/_health",
      headers: { authorization: "Bearer pgcrud_fake.invalidhmac" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("healthy");
    expect(body).not.toHaveProperty("tables");
    expect(body).not.toHaveProperty("schemas");
    expect(body).not.toHaveProperty("databaseHash");
  });
});
