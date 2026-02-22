import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildTestApp, createMockPool } from "./setup.js";
import { makeUsersTable, makeDatabaseSchema } from "../fixtures/tables.js";

describe("Health Check - GET /api/_health", () => {
  let app: FastifyInstance;
  let mockPool: ReturnType<typeof createMockPool>;

  beforeAll(async () => {
    mockPool = createMockPool();
    app = await buildTestApp({
      dbSchema: makeDatabaseSchema([makeUsersTable()]),
      pool: mockPool as any,
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns 200 healthy when DB query succeeds", async () => {
    (mockPool.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [{ "?column?": 1 }], rowCount: 1 });

    const res = await app.inject({ method: "GET", url: "/api/_health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("healthy");
    expect(body.version).toBe("0.0.0-test");
    expect(body.buildGitHash).toBe("abc1234");
    expect(body.buildTimestamp).toBe("2025-01-01T00:00:00.000Z");
    expect(body.tables).toBe(1);
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
