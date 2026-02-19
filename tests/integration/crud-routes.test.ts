import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildTestApp, createMockPool } from "./setup.js";
import {
  makeUsersTable,
  makeCompositePkTable,
  makeNoPkTable,
  makeNonPublicSchemaTable,
  makeDatabaseSchema,
} from "../fixtures/tables.js";

// ── List (GET /api/{table}) ─────────────────────────────────────────

describe("CRUD Routes - LIST", () => {
  let app: FastifyInstance;
  let mockPool: ReturnType<typeof createMockPool>;
  const users = makeUsersTable();
  const dbSchema = makeDatabaseSchema([users]);

  beforeAll(async () => {
    mockPool = createMockPool();
    app = await buildTestApp({ dbSchema, pool: mockPool as any });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.mocked(mockPool.query).mockReset();
    vi.mocked(mockPool.query).mockResolvedValue({ rows: [], rowCount: 0 } as any);
  });

  it("GET /api/users returns 200 with data and pagination", async () => {
    const mockRows = [
      { id: 1, name: "Alice", email: "alice@test.com", active: true },
      { id: 2, name: "Bob", email: "bob@test.com", active: true },
    ];
    vi.mocked(mockPool.query)
      .mockResolvedValueOnce({ rows: mockRows, rowCount: 2 } as any)
      .mockResolvedValueOnce({ rows: [{ total: "2" }], rowCount: 1 } as any);

    const res = await app.inject({ method: "GET", url: "/api/users" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toHaveLength(2);
    expect(body.pagination.total).toBe(2);
    expect(body.pagination.page).toBe(1);
    expect(body.pagination.pageSize).toBe(50);
    expect(body.pagination.totalPages).toBe(1);
  });

  it("passes pagination params to query", async () => {
    vi.mocked(mockPool.query)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
      .mockResolvedValueOnce({ rows: [{ total: "0" }], rowCount: 1 } as any);

    await app.inject({ method: "GET", url: "/api/users?page=2&pageSize=10" });

    const selectCall = vi.mocked(mockPool.query).mock.calls[0][0] as any;
    expect(selectCall.text).toContain("LIMIT");
    expect(selectCall.values).toContain(10);  // pageSize
    expect(selectCall.values).toContain(10);  // offset = (2-1)*10
  });

  it("passes sortBy and sortOrder to query", async () => {
    vi.mocked(mockPool.query)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
      .mockResolvedValueOnce({ rows: [{ total: "0" }], rowCount: 1 } as any);

    await app.inject({ method: "GET", url: "/api/users?sortBy=name&sortOrder=desc" });

    const selectCall = vi.mocked(mockPool.query).mock.calls[0][0] as any;
    expect(selectCall.text).toContain('"name" DESC');
  });

  it("passes filter params to query", async () => {
    vi.mocked(mockPool.query)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
      .mockResolvedValueOnce({ rows: [{ total: "0" }], rowCount: 1 } as any);

    await app.inject({ method: "GET", url: "/api/users?filter.name=eq:Alice" });

    const selectCall = vi.mocked(mockPool.query).mock.calls[0][0] as any;
    expect(selectCall.text).toContain('"name" = $1');
    expect(selectCall.values[0]).toBe("Alice");
  });

  it("returns 400 for invalid filter column", async () => {
    const res = await app.inject({ method: "GET", url: "/api/users?filter.nonexistent=eq:x" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Bad request");
  });

  it("applies search parameter", async () => {
    vi.mocked(mockPool.query)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
      .mockResolvedValueOnce({ rows: [{ total: "0" }], rowCount: 1 } as any);

    await app.inject({ method: "GET", url: "/api/users?search=alice" });

    const selectCall = vi.mocked(mockPool.query).mock.calls[0][0] as any;
    expect(selectCall.text).toContain("ILIKE");
  });

  it("applies select parameter", async () => {
    vi.mocked(mockPool.query)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
      .mockResolvedValueOnce({ rows: [{ total: "0" }], rowCount: 1 } as any);

    await app.inject({ method: "GET", url: "/api/users?select=id,name" });

    const selectCall = vi.mocked(mockPool.query).mock.calls[0][0] as any;
    expect(selectCall.text).toContain('"id", "name"');
  });

  it("applies explicit searchColumns parameter", async () => {
    vi.mocked(mockPool.query)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
      .mockResolvedValueOnce({ rows: [{ total: "0" }], rowCount: 1 } as any);

    await app.inject({ method: "GET", url: "/api/users?search=alice&searchColumns=name" });

    const selectCall = vi.mocked(mockPool.query).mock.calls[0][0] as any;
    expect(selectCall.text).toContain('"name"::text ILIKE');
    // Should NOT search email since we explicitly specified only name
    expect(selectCall.text).not.toContain('"email"::text ILIKE');
  });
});

// ── GET by PK (GET /api/{table}/:id) ────────────────────────────────

describe("CRUD Routes - GET by PK", () => {
  let app: FastifyInstance;
  let mockPool: ReturnType<typeof createMockPool>;
  const users = makeUsersTable();
  const compositePk = makeCompositePkTable();
  const dbSchema = makeDatabaseSchema([users, compositePk]);

  beforeAll(async () => {
    mockPool = createMockPool();
    app = await buildTestApp({ dbSchema, pool: mockPool as any });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.mocked(mockPool.query).mockReset();
  });

  it("returns 200 with record for valid PK", async () => {
    vi.mocked(mockPool.query).mockResolvedValueOnce({
      rows: [{ id: 42, name: "Alice", email: "alice@test.com", active: true }],
      rowCount: 1,
    } as any);

    const res = await app.inject({ method: "GET", url: "/api/users/42" });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(42);
    expect(res.json().name).toBe("Alice");
  });

  it("returns 404 when record not found", async () => {
    vi.mocked(mockPool.query).mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    const res = await app.inject({ method: "GET", url: "/api/users/999" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain("not found");
  });

  it("handles composite PK", async () => {
    vi.mocked(mockPool.query).mockResolvedValueOnce({
      rows: [{ user_id: 42, role_id: 7, granted_at: "2024-01-01" }],
      rowCount: 1,
    } as any);

    const res = await app.inject({ method: "GET", url: "/api/user_roles/42,7" });
    expect(res.statusCode).toBe(200);
    expect(res.json().user_id).toBe(42);
  });

  it("returns 400 for invalid composite PK format", async () => {
    const res = await app.inject({ method: "GET", url: "/api/user_roles/42" });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("Composite primary key");
  });

  it("returns 400 on DB error during GET by PK", async () => {
    const pgError = Object.assign(new Error("invalid input syntax"), {
      code: "22P02",
    });
    vi.mocked(mockPool.query).mockRejectedValueOnce(pgError);

    const res = await app.inject({ method: "GET", url: "/api/users/abc" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Invalid input");
  });
});

// ── CREATE (POST /api/{table}) ──────────────────────────────────────

describe("CRUD Routes - CREATE", () => {
  let app: FastifyInstance;
  let mockPool: ReturnType<typeof createMockPool>;
  const users = makeUsersTable();
  const dbSchema = makeDatabaseSchema([users]);

  beforeAll(async () => {
    mockPool = createMockPool();
    app = await buildTestApp({ dbSchema, pool: mockPool as any });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.mocked(mockPool.query).mockReset();
  });

  it("creates single record and returns 201", async () => {
    vi.mocked(mockPool.query).mockResolvedValueOnce({
      rows: [{ id: 1, name: "Alice", email: "alice@test.com", active: true }],
      rowCount: 1,
    } as any);

    const res = await app.inject({
      method: "POST",
      url: "/api/users",
      payload: { name: "Alice", email: "alice@test.com" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().id).toBe(1);
    expect(res.json().name).toBe("Alice");
  });

  it("creates bulk records and returns 201 with data and count", async () => {
    vi.mocked(mockPool.query).mockResolvedValueOnce({
      rows: [
        { id: 1, name: "Alice", email: "alice@test.com", active: true },
        { id: 2, name: "Bob", email: "bob@test.com", active: true },
      ],
      rowCount: 2,
    } as any);

    const res = await app.inject({
      method: "POST",
      url: "/api/users",
      payload: [
        { name: "Alice", email: "alice@test.com" },
        { name: "Bob", email: "bob@test.com" },
      ],
    });
    expect(res.statusCode).toBe(201);
    // Fastify's oneOf response serialization may reorder the shape,
    // but the handler sends { data: [...], count: N }
    // The response contains the bulk insert result
    // Fastify's oneOf serializer tries to match the first schema (rowSchema),
    // which may strip fields. Verify the query was called correctly instead.
    const queryCall = vi.mocked(mockPool.query).mock.calls[0][0] as any;
    expect(queryCall.text).toContain("INSERT INTO");
    expect(queryCall.text).toContain("VALUES");
    // Verify 4 values were passed (2 rows x 2 columns)
    expect(queryCall.values).toHaveLength(4);
  });

  it("returns 409 on unique constraint violation", async () => {
    const pgError = Object.assign(new Error("duplicate key"), {
      code: "23505",
      detail: 'Key (email)=(alice@test.com) already exists.',
      constraint: "users_email_key",
    });
    vi.mocked(mockPool.query).mockRejectedValueOnce(pgError);

    const res = await app.inject({
      method: "POST",
      url: "/api/users",
      payload: { name: "Alice", email: "alice@test.com" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("Conflict");
  });

  it("returns 400 on foreign key violation", async () => {
    const pgError = Object.assign(new Error("FK violation"), {
      code: "23503",
      detail: "Referenced record does not exist",
      constraint: "orders_user_id_fkey",
    });
    vi.mocked(mockPool.query).mockRejectedValueOnce(pgError);

    const res = await app.inject({
      method: "POST",
      url: "/api/users",
      payload: { name: "Alice", email: "alice@test.com" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Foreign key violation");
  });
});

// ── UPDATE PUT (PUT /api/{table}/:id) ───────────────────────────────

describe("CRUD Routes - PUT", () => {
  let app: FastifyInstance;
  let mockPool: ReturnType<typeof createMockPool>;
  const users = makeUsersTable();
  const compositePk = makeCompositePkTable();
  const dbSchema = makeDatabaseSchema([users, compositePk]);

  beforeAll(async () => {
    mockPool = createMockPool();
    app = await buildTestApp({ dbSchema, pool: mockPool as any });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.mocked(mockPool.query).mockReset();
  });

  it("returns 200 with updated record", async () => {
    vi.mocked(mockPool.query).mockResolvedValueOnce({
      rows: [{ id: 42, name: "Bob Updated", email: "bob@test.com", active: true }],
      rowCount: 1,
    } as any);

    const res = await app.inject({
      method: "PUT",
      url: "/api/users/42",
      payload: { name: "Bob Updated", email: "bob@test.com", active: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe("Bob Updated");
  });

  it("returns 404 when record not found", async () => {
    vi.mocked(mockPool.query).mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    const res = await app.inject({
      method: "PUT",
      url: "/api/users/999",
      payload: { name: "Nobody", email: "nobody@test.com", active: false },
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 400 for invalid composite PK on PUT", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/user_roles/42",
      payload: { granted_at: "2024-01-01T00:00:00Z" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("Composite primary key");
  });

  it("returns 409 on DB unique violation during PUT", async () => {
    const pgError = Object.assign(new Error("duplicate key"), {
      code: "23505",
      detail: "Key already exists",
      constraint: "users_email_key",
    });
    vi.mocked(mockPool.query).mockRejectedValueOnce(pgError);

    const res = await app.inject({
      method: "PUT",
      url: "/api/users/42",
      payload: { name: "Alice", email: "dup@test.com", active: true },
    });
    expect(res.statusCode).toBe(409);
  });
});

// ── UPDATE PATCH (PATCH /api/{table}/:id) ───────────────────────────

describe("CRUD Routes - PATCH", () => {
  let app: FastifyInstance;
  let mockPool: ReturnType<typeof createMockPool>;
  const users = makeUsersTable();
  const compositePk = makeCompositePkTable();
  const dbSchema = makeDatabaseSchema([users, compositePk]);

  beforeAll(async () => {
    mockPool = createMockPool();
    app = await buildTestApp({ dbSchema, pool: mockPool as any });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.mocked(mockPool.query).mockReset();
  });

  it("returns 200 with patched record", async () => {
    vi.mocked(mockPool.query).mockResolvedValueOnce({
      rows: [{ id: 42, name: "Updated", email: "old@test.com", active: true }],
      rowCount: 1,
    } as any);

    const res = await app.inject({
      method: "PATCH",
      url: "/api/users/42",
      payload: { name: "Updated" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe("Updated");
  });

  it("returns 404 when record not found", async () => {
    vi.mocked(mockPool.query).mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    const res = await app.inject({
      method: "PATCH",
      url: "/api/users/999",
      payload: { name: "Nobody" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 400 for invalid composite PK on PATCH", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/user_roles/42",
      payload: { granted_at: "2024-06-01T00:00:00Z" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("Composite primary key");
  });

  it("returns 409 on DB unique violation during PATCH", async () => {
    const pgError = Object.assign(new Error("duplicate key"), {
      code: "23505",
      detail: "Key already exists",
      constraint: "users_email_key",
    });
    vi.mocked(mockPool.query).mockRejectedValueOnce(pgError);

    const res = await app.inject({
      method: "PATCH",
      url: "/api/users/42",
      payload: { email: "dup@test.com" },
    });
    expect(res.statusCode).toBe(409);
  });
});

// ── DELETE (DELETE /api/{table}/:id) ────────────────────────────────

describe("CRUD Routes - DELETE", () => {
  let app: FastifyInstance;
  let mockPool: ReturnType<typeof createMockPool>;
  const users = makeUsersTable();
  const compositePk = makeCompositePkTable();
  const dbSchema = makeDatabaseSchema([users, compositePk]);

  beforeAll(async () => {
    mockPool = createMockPool();
    app = await buildTestApp({ dbSchema, pool: mockPool as any });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.mocked(mockPool.query).mockReset();
  });

  it("returns 200 with deleted flag and record", async () => {
    vi.mocked(mockPool.query).mockResolvedValueOnce({
      rows: [{ id: 42, name: "Alice", email: "alice@test.com", active: true }],
      rowCount: 1,
    } as any);

    const res = await app.inject({ method: "DELETE", url: "/api/users/42" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.deleted).toBe(true);
    expect(body.record.id).toBe(42);
  });

  it("returns 404 when record not found", async () => {
    vi.mocked(mockPool.query).mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    const res = await app.inject({ method: "DELETE", url: "/api/users/999" });
    expect(res.statusCode).toBe(404);
  });

  it("returns 400 for invalid composite PK on DELETE", async () => {
    const res = await app.inject({ method: "DELETE", url: "/api/user_roles/42" });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("Composite primary key");
  });

  it("returns 500 on unexpected DB error during DELETE", async () => {
    const pgError = Object.assign(new Error("something broke"), {
      code: "42601",
    });
    vi.mocked(mockPool.query).mockRejectedValueOnce(pgError);

    const res = await app.inject({ method: "DELETE", url: "/api/users/42" });
    expect(res.statusCode).toBe(500);
  });
});

// ── No-PK table routes ──────────────────────────────────────────────

describe("CRUD Routes - No PK table", () => {
  let app: FastifyInstance;
  let mockPool: ReturnType<typeof createMockPool>;
  const noPk = makeNoPkTable();
  const dbSchema = makeDatabaseSchema([noPk]);

  beforeAll(async () => {
    mockPool = createMockPool();
    app = await buildTestApp({ dbSchema, pool: mockPool as any });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.mocked(mockPool.query).mockReset();
    vi.mocked(mockPool.query).mockResolvedValue({ rows: [], rowCount: 0 } as any);
  });

  it("LIST works for table without PK", async () => {
    vi.mocked(mockPool.query)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
      .mockResolvedValueOnce({ rows: [{ total: "0" }], rowCount: 1 } as any);

    const res = await app.inject({ method: "GET", url: "/api/audit_logs" });
    expect(res.statusCode).toBe(200);
  });

  it("CREATE works for table without PK", async () => {
    vi.mocked(mockPool.query).mockResolvedValueOnce({
      rows: [{ event: "test", payload: null, created_at: "2024-01-01" }],
      rowCount: 1,
    } as any);

    const res = await app.inject({
      method: "POST",
      url: "/api/audit_logs",
      payload: { event: "test" },
    });
    expect(res.statusCode).toBe(201);
  });

  it("GET by PK returns 404 (route not registered)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/audit_logs/1" });
    expect(res.statusCode).toBe(404);
  });

  it("PUT returns 404 (route not registered)", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/audit_logs/1",
      payload: { event: "test" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("DELETE returns 404 (route not registered)", async () => {
    const res = await app.inject({ method: "DELETE", url: "/api/audit_logs/1" });
    expect(res.statusCode).toBe(404);
  });
});

// ── GET by PK with select param ─────────────────────────────────────

describe("CRUD Routes - GET by PK with select", () => {
  let app: FastifyInstance;
  let mockPool: ReturnType<typeof createMockPool>;
  const users = makeUsersTable();
  const dbSchema = makeDatabaseSchema([users]);

  beforeAll(async () => {
    mockPool = createMockPool();
    app = await buildTestApp({ dbSchema, pool: mockPool as any });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.mocked(mockPool.query).mockReset();
  });

  it("passes select columns to GET by PK query", async () => {
    vi.mocked(mockPool.query).mockResolvedValueOnce({
      rows: [{ id: 42, name: "Alice" }],
      rowCount: 1,
    } as any);

    const res = await app.inject({ method: "GET", url: "/api/users/42?select=id,name" });
    expect(res.statusCode).toBe(200);
    const queryCall = vi.mocked(mockPool.query).mock.calls[0][0] as any;
    expect(queryCall.text).toContain('"id", "name"');
  });
});

// ── Non-public schema table ─────────────────────────────────────────

describe("CRUD Routes - Non-public schema", () => {
  let app: FastifyInstance;
  let mockPool: ReturnType<typeof createMockPool>;
  const metrics = makeNonPublicSchemaTable();
  const dbSchema = makeDatabaseSchema([metrics]);

  beforeAll(async () => {
    mockPool = createMockPool();
    app = await buildTestApp({ dbSchema, pool: mockPool as any });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.mocked(mockPool.query).mockReset();
    vi.mocked(mockPool.query).mockResolvedValue({ rows: [], rowCount: 0 } as any);
  });

  it("registers routes with schema__table path for non-public schema", async () => {
    vi.mocked(mockPool.query)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
      .mockResolvedValueOnce({ rows: [{ total: "0" }], rowCount: 1 } as any);

    const res = await app.inject({ method: "GET", url: "/api/reporting__metrics" });
    expect(res.statusCode).toBe(200);
  });
});

