# pg-crud-api

A dynamic, zero-config CRUD REST API generator for PostgreSQL. It introspects your entire database at startup and creates fully-featured RESTful endpoints for every table across all schemas — with Swagger UI, filtering, pagination, sorting, search, and API key authentication built in.

## Quick Start

```bash
# Install dependencies
npm install

# Configure your database and auth
cp .env.example .env
# Edit .env with your DATABASE_URL and API_SECRET

# Generate an API key
npm run generate-key -- <your-API_SECRET> admin

# Run in development (auth disabled by default in dev)
API_KEYS_ENABLED=false npm run dev

# Build & run for production
npm run build
npm start
```

Open **http://localhost:3000/docs** for the interactive Swagger UI.

---

## How It Works

On startup, the API:

1. Connects to your PostgreSQL database
2. Reads `information_schema` to discover all schemas, tables, columns, primary keys, and foreign keys
3. Generates RESTful CRUD endpoints for every table
4. Builds OpenAPI/Swagger documentation automatically

**No code generation, no ORM, no migrations.** Your database *is* the source of truth.

---

## Authentication

### Overview

Authentication is **stateless** and **database-free**. A single `API_SECRET` environment variable is the root of trust. API keys are derived from it using HMAC-SHA256 — there is no keys table, no token store, and no revocation list. Verification recomputes the HMAC and compares it in constant time (`timingSafeEqual`), so validating a key is a pure CPU operation with zero I/O.

Authentication is enabled by default (`API_KEYS_ENABLED=true`). The server **refuses to start** if auth is enabled but `API_SECRET` is not set.

### How Keys Work

Every key follows one of two formats:

| Format | Structure | Access level |
|--------|-----------|--------------|
| **Legacy** (full access) | `pgcrud_{label}.{hmac_hex}` | Unrestricted read/write on all schemas |
| **Permission-scoped** | `pgcrud_{label}:{base64url_json}.{hmac_hex}` | Restricted to schemas and operations encoded in the key |

The `label` is a human-chosen identifier (e.g., `admin`, `service-a`, `readonly-backend`). Different labels produce different keys, all verifiable with the same secret.

**How derivation works:**
1. For legacy keys, the HMAC input is just the label (e.g., `admin`).
2. For permission-scoped keys, the permissions object (e.g., `{"public":"rw","reporting":"r"}`) is JSON-serialized, base64url-encoded, and appended: `admin:eyJwdWJsaWMiOiJydyJ9`. The HMAC covers this entire string, making both label and permissions tamper-proof.
3. The HMAC is computed as `HMAC-SHA256(data, API_SECRET)` and hex-encoded.
4. The final key is `pgcrud_{data}.{hmac_hex}`.

**Verification** extracts the data and HMAC from the key, recomputes the expected HMAC from the data + `API_SECRET`, and compares using `timingSafeEqual`. Invalid or tampered keys are rejected with `401 Unauthorized`.

### Generating Keys

```bash
# Full-access key (legacy format)
npm run generate-key -- <API_SECRET> <label>

# Example:
npm run generate-key -- my-secret-value admin
# → pgcrud_admin.bccd91ad74b9c9f3310b044deb72712fc411d25eb7de78be42f5e0bf142ee7e7

# Permission-scoped key
npm run generate-key -- my-secret admin --schemas public:rw,reporting:r
```

### Schema-Scoped Permissions

Keys can be scoped to specific PostgreSQL schemas with per-schema read/write granularity:

```bash
# Read-write on public, read-only on reporting
npm run generate-key -- my-secret admin --schemas public:rw,reporting:r

# Read-only across all schemas (wildcard)
npm run generate-key -- my-secret readonly --schemas '*:r'

# Write-only on public
npm run generate-key -- my-secret writer --schemas public:w
```

**Permission values:**

| Value | Meaning | Allowed HTTP methods |
|-------|---------|---------------------|
| `r`   | Read-only | `GET` |
| `w`   | Write-only | `POST`, `PUT`, `PATCH`, `DELETE` |
| `rw`  | Full access | All methods |

Use `*` as the schema name for wildcard access across all schemas. When both a specific schema entry and `*` exist, the specific entry takes precedence.

Permissions are cryptographically embedded in the key — they **cannot be tampered with or escalated** without the `API_SECRET`. Any modification to the permissions portion invalidates the HMAC and the key is rejected.

### Permission Enforcement

| Request type | Required permission | Denied response |
|--------------|-------------------|-----------------|
| `GET` (list, get by PK) | `r` on the table's schema | `403 Forbidden` |
| `POST`, `PUT`, `PATCH`, `DELETE` | `w` on the table's schema | `403 Forbidden` |
| `GET /api/_meta/tables` | Filters results to accessible schemas only | — |
| `GET /api/_schema` | Filters results to accessible schemas only | — |

Legacy keys (generated without `--schemas`) bypass all permission checks and have full access.

### Sending Keys

Pass the key via either header:

```bash
# Authorization header (recommended)
curl http://localhost:3000/api/users \
  -H "Authorization: Bearer pgcrud_admin.bccd91..."

# X-API-Key header (alternative)
curl http://localhost:3000/api/users \
  -H "X-API-Key: pgcrud_admin.bccd91..."
```

Both headers are checked in order: `Authorization: Bearer` first, then `X-API-Key`. The first valid key found is used.

### Public Endpoints

These endpoints never require authentication:

- **`GET /api/_health`** — Health check (returns build info publicly; table/schema/database details only for authenticated callers — see [Health Check](#health-check))
- **`GET /docs/*`** — Swagger UI and OpenAPI spec

### Disabling Auth

Set `API_KEYS_ENABLED=false` in `.env` to disable authentication entirely. All endpoints become publicly accessible. **This is intended for development only** — the server logs a warning when auth is disabled.

---

## API Endpoints

For each table, the following endpoints are created:

| Method   | Path                          | Description              |
|----------|-------------------------------|--------------------------|
| `GET`    | `/api/{table}`                | List records (paginated) |
| `GET`    | `/api/{table}/:id`            | Get record by PK         |
| `POST`   | `/api/{table}`                | Create record(s)         |
| `PUT`    | `/api/{table}/:id`            | Full update by PK        |
| `PATCH`  | `/api/{table}/:id`            | Partial update by PK     |
| `DELETE` | `/api/{table}/:id`            | Delete by PK             |

### Meta & Schema Endpoints

| Method | Path                          | Description                              |
|--------|-------------------------------|------------------------------------------|
| `GET`  | `/api/_health`                | Health check ([details below](#health-check)) |
| `GET`  | `/api/_meta/tables`           | List all available tables                |
| `GET`  | `/api/_meta/tables/:table`    | Table schema details                     |
| `GET`  | `/api/_schema`                | Full API schema (for LLM agents / tools) |
| `GET`  | `/api/_schema/:table`         | Single table schema                      |

### Health Check

The health endpoint is always publicly accessible (no authentication required), but its response varies based on whether the caller provides a valid API key:

**Unauthenticated** (or auth disabled = full response):
```jsonc
// GET /api/_health
{
  "status": "healthy",
  "version": "1.2.0",
  "buildGitHash": "a1b2c3d",
  "buildTimestamp": "2025-06-15T12:00:00.000Z"
}
```

**Authenticated** (valid API key provided):
```jsonc
// GET /api/_health  (with Authorization: Bearer <key>)
{
  "status": "healthy",
  "version": "1.2.0",
  "buildGitHash": "a1b2c3d",
  "buildTimestamp": "2025-06-15T12:00:00.000Z",
  "databaseHash": "e3b0c44298fc1c149afbf4c8996fb924...",  // SHA-256 of full schema
  "tables": 12,
  "schemas": ["public", "reporting"]
}
```

When auth is **disabled** (`API_KEYS_ENABLED=false`), the full response (including `databaseHash`, `tables`, and `schemas`) is always returned.

The `databaseHash` is a deterministic SHA-256 hash of the entire introspected database structure (schemas, tables, columns, types, primary keys, foreign keys). It changes whenever the database schema changes, making it useful for:
- Detecting schema drift between environments
- Cache invalidation for schema-aware clients
- Verifying deployment consistency

### Schema Routing

- **`public` schema** tables: `/api/users`, `/api/orders`
- **Other schema** tables: `/api/billing__invoices`, `/api/auth__sessions` (double underscore separator)

---

## Querying

### Pagination

```
GET /api/users?page=2&pageSize=25
```

Response includes pagination metadata:
```json
{
  "data": [...],
  "pagination": {
    "page": 2,
    "pageSize": 25,
    "total": 150,
    "totalPages": 6
  }
}
```

### Sorting

```
GET /api/users?sortBy=created_at&sortOrder=desc
```

### Column Selection

```
GET /api/users?select=id,name,email
```

### Filtering

Use `filter.{column}={operator}:{value}` query params:

```
GET /api/users?filter.age=gte:18&filter.status=eq:active
GET /api/products?filter.price=lt:100&filter.category=in:electronics,books
GET /api/users?filter.deleted_at=is:null
```

**Available operators:**

| Operator | SQL        | Example                          |
|----------|------------|----------------------------------|
| `eq`     | `=`        | `filter.status=eq:active`        |
| `neq`    | `!=`       | `filter.role=neq:admin`          |
| `gt`     | `>`        | `filter.age=gt:21`               |
| `gte`    | `>=`       | `filter.price=gte:10`            |
| `lt`     | `<`        | `filter.stock=lt:5`              |
| `lte`    | `<=`       | `filter.rating=lte:3`            |
| `like`   | `LIKE`     | `filter.name=like:%john%`        |
| `ilike`  | `ILIKE`    | `filter.email=ilike:%@gmail.com` |
| `is`     | `IS`       | `filter.deleted_at=is:null`      |
| `in`     | `IN`       | `filter.status=in:active,pending`|

### Full-Text Search

```
GET /api/users?search=john
GET /api/users?search=john&searchColumns=name,email
```

By default, searches across all `text`/`varchar` columns in the table using `ILIKE`.

---

## Creating Records

### Single record

```bash
curl -X POST http://localhost:3000/api/users \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer pgcrud_admin.bccd91..." \
  -d '{"name": "Jane", "email": "jane@example.com"}'
```

### Bulk insert

```bash
curl -X POST http://localhost:3000/api/users \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer pgcrud_admin.bccd91..." \
  -d '[
    {"name": "Jane", "email": "jane@example.com"},
    {"name": "Bob", "email": "bob@example.com"}
  ]'
```

---

## Composite Primary Keys

Tables with composite PKs use comma-separated values in the URL:

```
# For a table with PK (user_id, role_id)
GET    /api/user_roles/42,7
PUT    /api/user_roles/42,7
DELETE /api/user_roles/42,7
```

---

## Configuration

All configuration via environment variables (`.env`):

| Variable             | Default                | Description                                         |
|----------------------|------------------------|-----------------------------------------------------|
| `DATABASE_URL`       | `postgresql://...`     | PostgreSQL connection string (`jdbc:` prefix auto-stripped) |
| `DATABASE_READ_URL`  | *(none)*               | Read replica connection string (optional, falls back to `DATABASE_URL`) |
| `PORT`               | `3000`                 | Server port                                         |
| `HOST`               | `0.0.0.0`              | Bind address                                        |
| `API_SECRET`         | *(none)*               | Secret for HMAC-SHA256 API key derivation           |
| `API_KEYS_ENABLED`   | `true`                 | Enable/disable API key authentication               |
| `SCHEMAS`            | *(all non-system)*     | Comma-separated schemas to expose                   |
| `EXCLUDE_SCHEMAS`    | *(none)*               | Comma-separated schemas to hide                     |
| `EXCLUDE_TABLES`     | *(none)*               | Tables to hide (`schema.table` format)              |
| `DEFAULT_PAGE_SIZE`  | `50`                   | Default pagination size                             |
| `MAX_PAGE_SIZE`      | `1000`                 | Maximum allowed page size                           |
| `MAX_BULK_INSERT_ROWS` | `1000`              | Maximum rows per bulk POST                          |
| `BODY_LIMIT`         | `5242880` (5 MB)       | Maximum request body size in bytes                  |
| `SWAGGER_ENABLED`    | `true`                 | Enable Swagger UI at `/docs`                        |
| `CORS_ORIGINS`       | `true` (dev) / `false` (prod) | CORS allowed origins (`true`/`false`/origin string) |
| `EXPOSE_DB_ERRORS`   | `false`                | Include PostgreSQL error details in responses       |

---

## Error Handling

The API returns structured error responses for common database errors:

| PG Code  | HTTP Status | Meaning                  |
|----------|-------------|--------------------------|
| `23505`  | `409`       | Unique constraint violation |
| `23503`  | `400`       | Foreign key violation       |
| `23502`  | `400`       | Not null violation          |
| `22P02`  | `400`       | Invalid input syntax        |

---

## Read Replica Support

For high-traffic deployments, you can route read queries to a PostgreSQL read replica by setting `DATABASE_READ_URL`:

```bash
DATABASE_URL=postgresql://user:pass@primary:5432/mydb
DATABASE_READ_URL=postgresql://user:pass@replica:5432/mydb
```

When configured:

| Operation | Pool used |
|-----------|-----------|
| `GET` (list, get by PK) | Read replica |
| `POST`, `PUT`, `PATCH`, `DELETE` | Primary |
| Schema introspection (startup) | Primary |
| Health check | Primary |

When `DATABASE_READ_URL` is **not set**, all queries use the primary `DATABASE_URL` — no behavior change.

> **Note:** Read replicas may have replication lag. A record created via POST may not appear immediately in a subsequent GET. Clients that need read-after-write consistency should account for this.

---

## Security Considerations

The API includes API key authentication out of the box. For production deployments, also consider:

- **Authorization** — Row-level security or middleware-based access control
- **Rate limiting** — `@fastify/rate-limit`
- **Input validation** — Stricter body schemas per table
- **Query depth limits** — Prevent expensive queries
- **HTTPS** — Via reverse proxy (nginx, Caddy) or `@fastify/https`

---

## LLM Agent Integration

The API includes machine-readable schema endpoints designed for LLM agents and AI tools:

- **`GET /api/_schema`** returns all tables, columns, types, operations, foreign keys, and API capabilities in a single call.
- **`GET /api/_schema/:table`** returns the schema for a single table.

Use these endpoints to dynamically discover the database structure and construct valid CRUD requests without hardcoded knowledge.

See [`docs/llm-agent-guide.md`](docs/llm-agent-guide.md) for the full integration guide.

---

## Architecture

```
src/
├── index.ts              # Entry point — server setup, auth, plugins, startup
├── config.ts             # Environment-based configuration
├── db/
│   ├── introspector.ts   # Database schema introspection via information_schema
│   └── query-builder.ts  # Dynamic parameterized SQL generation
├── routes/
│   ├── crud.ts           # CRUD route registration & handlers
│   └── schema.ts         # Agent-friendly schema endpoint (/api/_schema)
├── auth/
│   ├── api-key.ts        # HMAC-SHA256 API key generation & verification
│   └── generate-key.ts   # CLI utility for key generation
└── errors/
    └── pg-errors.ts      # PostgreSQL error code → HTTP status mapping
```

All SQL queries use parameterized placeholders (`$1`, `$2`, ...) to prevent SQL injection.
