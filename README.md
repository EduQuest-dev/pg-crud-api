# pg-crud-api

A dynamic, zero-config CRUD REST API generator for PostgreSQL. It introspects your entire database at startup and creates fully-featured RESTful endpoints for every table across all schemas — with Swagger UI, filtering, pagination, sorting, search, API key authentication, soft delete, automatic timestamps, read replica support, and a built-in MCP server for LLM agents.

---

## Table of Contents

- [Quick Start](#quick-start)
- [How It Works](#how-it-works)
- [API Endpoints](#api-endpoints)
- [Querying](#querying)
  - [Pagination](#pagination)
  - [Sorting](#sorting)
  - [Column Selection](#column-selection)
  - [Filtering](#filtering)
  - [Full-Text Search](#full-text-search)
- [Creating Records](#creating-records)
- [Updating Records](#updating-records)
- [Deleting Records](#deleting-records)
  - [Soft Delete](#soft-delete)
- [Automatic Timestamps](#automatic-timestamps)
- [Composite Primary Keys](#composite-primary-keys)
- [Authentication](#authentication)
  - [How Keys Work](#how-keys-work)
  - [Generating Keys](#generating-keys)
  - [Schema-Scoped Permissions](#schema-scoped-permissions)
  - [Permission Enforcement](#permission-enforcement)
  - [Sending Keys](#sending-keys)
  - [Public Endpoints](#public-endpoints)
  - [Disabling Auth](#disabling-auth)
- [MCP Server (LLM Agent Integration)](#mcp-server-llm-agent-integration)
  - [Embedded HTTP Transport](#embedded-http-transport)
  - [Standalone Stdio Transport](#standalone-stdio-transport)
  - [MCP Tools](#mcp-tools)
  - [MCP Resources](#mcp-resources)
  - [MCP Prompts](#mcp-prompts)
- [Schema Discovery Endpoints](#schema-discovery-endpoints)
- [Health Check](#health-check)
- [Read Replica Support](#read-replica-support)
- [Error Handling](#error-handling)
- [Configuration](#configuration)
- [Architecture](#architecture)
- [Security Considerations](#security-considerations)

---

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

1. Connects to your PostgreSQL database (and optional read replica)
2. Reads `information_schema` to discover all schemas, tables, columns, primary keys, and foreign keys
3. Generates RESTful CRUD endpoints for every table
4. Registers an MCP server endpoint for LLM agent access
5. Builds OpenAPI/Swagger documentation automatically

**No code generation, no ORM, no migrations.** Your database *is* the source of truth.

---

## API Endpoints

For each discovered table, the following endpoints are created:

| Method   | Path                          | Description              |
|----------|-------------------------------|--------------------------|
| `GET`    | `/api/{table}`                | List records (paginated) |
| `GET`    | `/api/{table}/:id`            | Get record by PK         |
| `POST`   | `/api/{table}`                | Create record(s)         |
| `PUT`    | `/api/{table}/:id`            | Full update by PK        |
| `PATCH`  | `/api/{table}/:id`            | Partial update by PK     |
| `DELETE` | `/api/{table}/:id`            | Delete by PK             |

### Routing Conventions

- **`public` schema** tables: `/api/users`, `/api/orders`
- **Other schema** tables: `/api/billing__invoices`, `/api/auth__sessions` (double underscore separator)

### Meta & Schema Endpoints

| Method | Path                          | Description                              |
|--------|-------------------------------|------------------------------------------|
| `GET`  | `/api/_health`                | Health check ([details below](#health-check)) |
| `GET`  | `/api/_meta/tables`           | List all available tables                |
| `GET`  | `/api/_meta/tables/:table`    | Table schema details                     |
| `GET`  | `/api/_schema`                | Full API schema (for LLM agents / tools) |
| `GET`  | `/api/_schema/:table`         | Single table schema                      |
| `POST` | `/mcp`                        | MCP JSON-RPC endpoint (initialize + requests) |
| `GET`  | `/mcp`                        | MCP SSE stream (server-to-client notifications) |
| `DELETE`| `/mcp`                       | Close an MCP session                     |

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

- `page` defaults to `1`, minimum `1`
- `pageSize` defaults to `50` (configurable via `DEFAULT_PAGE_SIZE`), maximum `1000` (configurable via `MAX_PAGE_SIZE`)

### Sorting

```
GET /api/users?sortBy=created_at&sortOrder=desc
```

Defaults to the first primary key column in ascending order. Invalid column names are silently ignored (falls back to default).

### Column Selection

```
GET /api/users?select=id,name,email
GET /api/users/42?select=id,email
```

Returns only the specified columns. If none of the requested columns exist, returns a `400` error listing available columns.

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

If no operator prefix is given, `eq` is assumed: `filter.status=active` is equivalent to `filter.status=eq:active`.

Multiple filters are combined with AND. The `in` operator supports up to 100 values. Invalid column names produce a `400` error.

### Full-Text Search

```
GET /api/users?search=john
GET /api/users?search=john&searchColumns=name,email
```

By default, searches across all `text`/`varchar` columns in the table using `ILIKE` with wildcards on both sides. Special characters (`%`, `_`, `\`) are escaped automatically.

---

## Creating Records

### Single record

```bash
curl -X POST http://localhost:3000/api/users \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer pgcrud_admin.bccd91..." \
  -d '{"name": "Jane", "email": "jane@example.com"}'
```

Response (201): the created record with all columns (including database-generated values like `id`, `created_at`).

### Bulk insert

Send an array to insert multiple records in one request (max 1000 rows, configurable via `MAX_BULK_INSERT_ROWS`):

```bash
curl -X POST http://localhost:3000/api/users \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer pgcrud_admin.bccd91..." \
  -d '[
    {"name": "Jane", "email": "jane@example.com"},
    {"name": "Bob", "email": "bob@example.com"}
  ]'
```

Response (201):

```json
{
  "data": [...],
  "count": 2
}
```

**Rules:**
- Columns not in the table schema are silently ignored
- Columns with `hasDefault: true` (e.g., serial PKs, `now()` defaults) can be omitted
- Tables with an `updated_at` column will have it automatically set to `NOW()` (see [Automatic Timestamps](#automatic-timestamps))

---

## Updating Records

### Full update (PUT)

Replaces all non-PK fields. All non-PK, non-nullable columns without defaults are required.

```bash
curl -X PUT http://localhost:3000/api/users/42 \
  -H "Content-Type: application/json" \
  -d '{"name": "Alice Updated", "email": "alice-new@example.com"}'
```

### Partial update (PATCH)

Only provided fields are changed. Prefer PATCH over PUT when you only need to change a few fields.

```bash
curl -X PATCH http://localhost:3000/api/users/42 \
  -H "Content-Type: application/json" \
  -d '{"name": "Alice Renamed"}'
```

Both return the full updated record (200) or 404 if not found. PK columns cannot be updated.

Tables with an `updated_at` column will have it automatically set to `NOW()` on every update (see [Automatic Timestamps](#automatic-timestamps)).

---

## Deleting Records

```bash
curl -X DELETE http://localhost:3000/api/users/42 \
  -H "Authorization: Bearer pgcrud_admin.bccd91..."
```

Response (200):

```json
{
  "deleted": true,
  "softDelete": false,
  "record": { "id": 42, "name": "Alice", "email": "alice@example.com" }
}
```

The `softDelete` field indicates whether the row was actually removed from the database (`false`) or just marked as deleted (`true`).

### Soft Delete

If a table has a `deleted_at` column, DELETE operations automatically perform a **soft delete** instead of removing the row:

```sql
-- Instead of:
DELETE FROM "public"."posts" WHERE "id" = $1 RETURNING *

-- The API generates:
UPDATE "public"."posts" SET "deleted_at" = NOW(), "updated_at" = NOW() WHERE "id" = $1 RETURNING *
```

The response indicates soft delete was used:

```json
{
  "deleted": true,
  "softDelete": true,
  "record": { "id": 5, "title": "Hello", "deleted_at": "2025-06-15T12:00:00.000Z", "updated_at": "2025-06-15T12:00:00.000Z" }
}
```

**How it works:**
- The API checks each table's column list at startup for a column named `deleted_at`
- Tables **with** `deleted_at`: DELETE generates `UPDATE ... SET "deleted_at" = NOW()`
- Tables **without** `deleted_at`: DELETE generates a normal `DELETE FROM`
- If the table also has an `updated_at` column, it is set to `NOW()` alongside `deleted_at`
- This behavior is automatic and requires no configuration — just add a `deleted_at` column to your table
- The Swagger summary reflects which behavior is used (`"Soft-delete posts by primary key (sets deleted_at)"` vs. `"Delete users by primary key"`)

To query for non-deleted records, use a filter:

```
GET /api/posts?filter.deleted_at=is:null
```

---

## Automatic Timestamps

When a table has an `updated_at` column, the API automatically sets it to `NOW()` on write operations — no application code needed.

| Operation | Behavior |
|-----------|----------|
| **INSERT** (single or bulk) | `"updated_at"` set to `NOW()` |
| **UPDATE** (PUT/PATCH) | `"updated_at" = NOW()` added to SET clause |
| **Soft DELETE** | `"updated_at" = NOW()` set alongside `"deleted_at" = NOW()` |

**Important details:**
- This only applies to tables that have a column literally named `updated_at`
- If the caller explicitly provides `updated_at` in the request body, the provided value is used instead of `NOW()`
- Tables without an `updated_at` column are completely unaffected
- The `NOW()` is a SQL literal, not a parameter — it is evaluated by PostgreSQL at execution time

---

## Composite Primary Keys

Tables with composite PKs use comma-separated values in the URL, ordered to match the table's PK column order:

```
# For a table with PK (user_id, role_id)
GET    /api/user_roles/42,7
PUT    /api/user_roles/42,7
PATCH  /api/user_roles/42,7
DELETE /api/user_roles/42,7
```

If the wrong number of values is provided, a `400` error is returned explaining the expected format.

---

## Authentication

### Overview

Authentication is **stateless** and **database-free**. A single `API_SECRET` environment variable is the root of trust. API keys are derived using HMAC-SHA256 — there is no keys table, no token store, and no revocation list. Verification recomputes the HMAC and compares it in constant time (`timingSafeEqual`), so validating a key is a pure CPU operation with zero I/O.

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

Permissions are cryptographically embedded in the key — they **cannot be tampered with or escalated** without the `API_SECRET`. Any modification to the permissions portion invalidates the HMAC.

### Permission Enforcement

| Request type | Required permission | Denied response |
|--------------|-------------------|-----------------|
| `GET` (list, get by PK) | `r` on the table's schema | `403 Forbidden` |
| `POST`, `PUT`, `PATCH`, `DELETE` | `w` on the table's schema | `403 Forbidden` |
| `GET /api/_meta/tables` | Filters results to accessible schemas only | — |
| `GET /api/_schema` | Filters results to accessible schemas only | — |
| MCP tools (list/get/search) | `r` on the table's schema | Error response |
| MCP tools (create/update/delete) | `w` on the table's schema | Error response |

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

Both headers are checked in order: `Authorization: Bearer` first, then `X-API-Key`.

### Public Endpoints

These endpoints never require authentication:

- **`GET /api/_health`** — Health check
- **`GET /docs/*`** — Swagger UI and OpenAPI spec

### Disabling Auth

Set `API_KEYS_ENABLED=false` in `.env` to disable authentication entirely. All endpoints become publicly accessible. **This is intended for development only** — the server logs a warning when auth is disabled.

---

## MCP Server (LLM Agent Integration)

The API includes a full [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server, enabling LLM agents to discover, explore, and operate on the database through structured tool calls. The MCP server reuses the same query builder, auth, and schema introspection as the REST API.

### Embedded HTTP Transport

The MCP server runs alongside the REST API on the same Fastify server at `/mcp` using the Streamable HTTP transport:

| Method   | Path   | Purpose |
|----------|--------|---------|
| `POST`   | `/mcp` | JSON-RPC endpoint — send `initialize`, tool calls, and other requests |
| `GET`    | `/mcp` | SSE stream for server-to-client notifications (requires `mcp-session-id` header) |
| `DELETE` | `/mcp` | Close a session (requires `mcp-session-id` header) |

**Session lifecycle:**

1. **Initialize** — `POST /mcp` with a JSON-RPC `initialize` request. The response includes an `mcp-session-id` header.
2. **Use tools** — `POST /mcp` with the `mcp-session-id` header and JSON-RPC tool call requests.
3. **Close** — `DELETE /mcp` with the `mcp-session-id` header.

Authentication is enforced: the API key from the request headers is forwarded into the MCP session, and all tool calls respect the key's schema permissions.

### Standalone Stdio Transport

For use with MCP-compatible clients (e.g., Claude Desktop), a standalone stdio server is also available:

```bash
# Production
npm run build
MCP_API_KEY=pgcrud_admin.bccd91... npm run mcp

# Development
MCP_API_KEY=pgcrud_admin.bccd91... npm run mcp:dev
```

The stdio server reads JSON-RPC messages from stdin and writes responses to stdout. Console output is redirected to stderr to keep the protocol channel clean.

**Environment variables for stdio mode:**
- `DATABASE_URL` — PostgreSQL connection string (required)
- `DATABASE_READ_URL` — Read replica (optional)
- `API_KEYS_ENABLED` — Enable auth (`true` by default)
- `API_SECRET` — HMAC secret (required when auth enabled)
- `MCP_API_KEY` — The API key the MCP server authenticates as (required when auth enabled)

**Claude Desktop configuration example** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "pg-crud-api": {
      "command": "node",
      "args": ["dist/mcp/index.js"],
      "cwd": "/path/to/pg-crud-api",
      "env": {
        "DATABASE_URL": "postgresql://user:pass@localhost:5432/mydb",
        "API_KEYS_ENABLED": "false"
      }
    }
  }
}
```

### MCP Tools

The MCP server exposes 7 tools:

| Tool | Description | Read/Write |
|------|-------------|------------|
| `list_tables` | List all accessible tables with schema, PKs, and column counts | Read |
| `describe_table` | Get detailed schema for a table (columns, types, FKs, operations) | Read |
| `list_records` | Query records with filtering, pagination, sorting, and search | Read |
| `get_record` | Fetch a single record by primary key | Read |
| `create_record` | Insert one or more records (single object or array) | Write |
| `update_record` | Partial update by primary key | Write |
| `delete_record` | Delete by PK (soft-delete if `deleted_at` column exists) | Write |

Read tools use the read replica pool (when configured). Write tools always use the primary pool.

### MCP Resources

| URI | Description |
|-----|-------------|
| `db://schema` | Complete database schema — all tables, columns, types, relationships, and API usage information as JSON |
| `db://tables/{table}` | Schema for a specific table (uses `ResourceTemplate` — clients can list all available tables) |

### MCP Prompts

| Prompt | Description |
|--------|-------------|
| `explore-database` | Overview of the database with all table names and available tools — ideal as a starting prompt |
| `crud-guide` | Detailed CRUD operations guide for a specific table, including required columns, filters, and FK relationships |

---

## Schema Discovery Endpoints

### GET /api/_schema

Returns the full API schema: capabilities, configuration, and all tables in a single call. Designed for LLM agents and programmatic consumers.

```json
{
  "api": {
    "baseUrl": "/api",
    "auth": { "enabled": true, "methods": ["Bearer", "X-API-Key"] },
    "pagination": { "defaultPageSize": 50, "maxPageSize": 1000 },
    "filtering": {
      "paramPattern": "filter.{column}={operator}:{value}",
      "operators": ["eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike", "is", "in"]
    },
    "sorting": { "params": ["sortBy", "sortOrder"], "orders": ["asc", "desc"] },
    "search": { "params": ["search", "searchColumns"] },
    "columnSelection": { "param": "select" },
    "bulkInsert": { "maxRows": 1000 }
  },
  "tables": [
    {
      "name": "users",
      "schema": "public",
      "path": "/api/users",
      "operations": ["list", "create", "read", "update", "replace", "delete"],
      "primaryKeys": ["id"],
      "columns": [
        { "name": "id", "type": "integer", "nullable": false, "hasDefault": true, "pk": true },
        { "name": "email", "type": "string", "nullable": false, "hasDefault": false, "insertRequired": true }
      ],
      "foreignKeys": [
        { "column": "org_id", "references": "organizations.id", "refPath": "/api/organizations" }
      ],
      "searchableColumns": ["email", "name"]
    }
  ]
}
```

### GET /api/_schema/:table

Same as above but returns a single table. Example: `GET /api/_schema/users`.

### GET /api/_meta/tables

Lists all available tables with basic metadata:

```json
{
  "count": 3,
  "tables": [
    {
      "schema": "public",
      "table": "users",
      "path": "/api/users",
      "primaryKeys": ["id"],
      "columnCount": 5,
      "foreignKeys": [{ "column": "org_id", "references": "public.organizations.id" }]
    }
  ]
}
```

### GET /api/_meta/tables/:table

Detailed schema for a single table including columns, types, constraints, and foreign keys.

When auth is enabled, both `_meta` and `_schema` endpoints filter results to only show tables the caller's API key has access to.

See [`docs/llm-agent-guide.md`](docs/llm-agent-guide.md) for the full LLM integration guide.

---

## Health Check

`GET /api/_health` is always publicly accessible (no authentication required), but its response varies based on caller authentication:

**Unauthenticated** (or auth disabled = full response):

```json
{
  "status": "healthy",
  "version": "1.0.0",
  "buildGitHash": "a1b2c3d",
  "buildTimestamp": "2025-06-15T12:00:00.000Z"
}
```

**Authenticated** (valid API key provided):

```json
{
  "status": "healthy",
  "version": "1.0.0",
  "buildGitHash": "a1b2c3d",
  "buildTimestamp": "2025-06-15T12:00:00.000Z",
  "databaseHash": "e3b0c44298fc1c149afbf4c8996fb924...",
  "tables": 12,
  "schemas": ["public", "reporting"]
}
```

When auth is **disabled** (`API_KEYS_ENABLED=false`), the full response (including `databaseHash`, `tables`, and `schemas`) is always returned.

The `databaseHash` is a deterministic SHA-256 hash of the entire introspected database structure. It changes whenever the schema changes, useful for:
- Detecting schema drift between environments
- Cache invalidation for schema-aware clients
- Verifying deployment consistency

Returns `503 Service Unavailable` when the database is unreachable (5-second timeout).

---

## Read Replica Support

For high-traffic deployments, you can route read queries to a PostgreSQL read replica:

```bash
DATABASE_URL=postgresql://user:pass@primary:5432/mydb
DATABASE_READ_URL=postgresql://user:pass@replica:5432/mydb
```

When configured:

| Operation | Pool used |
|-----------|-----------|
| `GET` (list, get by PK) | Read replica |
| `POST`, `PUT`, `PATCH`, `DELETE` | Primary |
| MCP read tools (`list_records`, `get_record`, etc.) | Read replica |
| MCP write tools (`create_record`, `update_record`, `delete_record`) | Primary |
| Schema introspection (startup) | Primary |
| Health check | Primary |

When `DATABASE_READ_URL` is **not set**, all queries use the primary `DATABASE_URL` — no behavior change.

> **Note:** Read replicas may have replication lag. A record created via POST may not appear immediately in a subsequent GET. Clients that need read-after-write consistency should account for this.

---

## Error Handling

The API returns structured error responses:

```json
{
  "error": "Short error label",
  "message": "Human-readable description",
  "statusCode": 400
}
```

### HTTP Status Codes

| Code | Meaning | Common Causes |
|------|---------|---------------|
| `400` | Bad Request | Invalid filter column, invalid body, type mismatch, FK violation, NOT NULL violation |
| `401` | Unauthorized | Missing or invalid API key |
| `403` | Forbidden | API key lacks permission for this schema/operation |
| `404` | Not Found | Record or table does not exist |
| `409` | Conflict | Duplicate key (unique constraint violation) |
| `500` | Internal Error | Unexpected database error |
| `503` | Service Unavailable | Database unreachable (health check) |

### PostgreSQL Error Mapping

| PG Code  | HTTP Status | Meaning                  |
|----------|-------------|--------------------------|
| `23505`  | `409`       | Unique constraint violation |
| `23503`  | `400`       | Foreign key violation       |
| `23502`  | `400`       | Not null violation          |
| `22P02`  | `400`       | Invalid input syntax        |

### Validation Errors

Body validation failures include a `details` array:

```json
{
  "error": "Validation Error",
  "message": "1 validation error(s)",
  "details": [
    { "field": "/email", "message": "must have required property 'email'" }
  ]
}
```

### Database Error Details

When `EXPOSE_DB_ERRORS=true` is configured, database errors include extra fields:

```json
{
  "error": "Conflict",
  "message": "Duplicate key value violates unique constraint",
  "statusCode": 409,
  "detail": "Key (email)=(alice@example.com) already exists.",
  "constraint": "users_email_key"
}
```

---

## Configuration

All configuration via environment variables (`.env`):

| Variable             | Default                | Description                                         |
|----------------------|------------------------|-----------------------------------------------------|
| `DATABASE_URL`       | `postgresql://localhost:5432/mydb` | PostgreSQL connection string (`jdbc:` prefix auto-stripped) |
| `DATABASE_READ_URL`  | *(none)*               | Read replica connection string (optional, falls back to `DATABASE_URL`). `jdbc:` prefix auto-stripped |
| `PORT`               | `3000`                 | Server port                                         |
| `HOST`               | `0.0.0.0`              | Bind address                                        |
| `API_SECRET`         | *(none)*               | Secret for HMAC-SHA256 API key derivation (required when auth enabled) |
| `API_KEYS_ENABLED`   | `true`                 | Enable/disable API key authentication               |
| `SCHEMAS`            | *(all non-system)*     | Comma-separated schemas to expose                   |
| `EXCLUDE_SCHEMAS`    | *(none)*               | Comma-separated schemas to hide                     |
| `EXCLUDE_TABLES`     | *(none)*               | Tables to hide (`schema.table` format)              |
| `DEFAULT_PAGE_SIZE`  | `50`                   | Default pagination size                             |
| `MAX_PAGE_SIZE`      | `1000`                 | Maximum allowed page size                           |
| `MAX_BULK_INSERT_ROWS` | `1000`              | Maximum rows per bulk POST                          |
| `BODY_LIMIT`         | `5242880` (5 MB)       | Maximum request body size in bytes                  |
| `SWAGGER_ENABLED`    | `true`                 | Enable Swagger UI at `/docs`                        |
| `CORS_ORIGINS`       | `true` (dev) / `false` (prod) | CORS allowed origins (`true`/`false`/comma-separated origins) |
| `EXPOSE_DB_ERRORS`   | `false`                | Include PostgreSQL error details in responses       |

**MCP stdio mode only:**

| Variable       | Description |
|----------------|-------------|
| `MCP_API_KEY`  | API key to authenticate as (required when `API_KEYS_ENABLED=true`) |

---

## Architecture

```
src/
├── index.ts              # Entry point — server setup, auth, plugins, MCP, startup
├── config.ts             # Environment-based configuration (AppConfig)
├── db/
│   ├── introspector.ts   # PostgreSQL schema introspection via information_schema
│   └── query-builder.ts  # Dynamic parameterized SQL generation (soft delete, auto timestamps)
├── routes/
│   ├── crud.ts           # CRUD route registration & handlers
│   └── schema.ts         # Agent-friendly schema endpoint (/api/_schema)
├── mcp/
│   ├── server.ts         # MCP server factory (tools, resources, prompts)
│   ├── routes.ts         # Fastify plugin for embedded HTTP MCP at /mcp
│   └── index.ts          # Standalone stdio MCP entry point
├── auth/
│   ├── api-key.ts        # HMAC-SHA256 API key generation, verification, Fastify hook
│   └── generate-key.ts   # CLI utility for key generation
└── errors/
    └── pg-errors.ts      # PostgreSQL error code → HTTP status mapping
```

### Startup Flow

1. **Connect** to PostgreSQL (primary pool + optional read replica pool)
2. **Introspect** the database via `information_schema` — discovers schemas, tables, columns, primary keys, and foreign keys in parallel
3. **Register** Fastify plugins: CORS, auth hook, Swagger
4. **Register** CRUD routes for every discovered table
5. **Register** schema discovery routes (`/api/_schema`, `/api/_meta`)
6. **Register** MCP HTTP endpoint (`/mcp`)
7. **Start** the server with graceful shutdown handlers (SIGINT/SIGTERM)

### SQL Safety

All queries use parameterized placeholders (`$1`, `$2`, ...) to prevent SQL injection. Identifiers are quoted via a `quoteIdent()` function that escapes double-quotes. Column names are validated against the introspected table schema before use in queries.

### Key Conventions

- All local imports use `.js` extensions (Node16 module resolution)
- Fastify request augmentation uses `declare module "fastify"` for type-safe access to `request.apiKeyPermissions`
- System schemas (`pg_catalog`, `information_schema`, `pg_toast`) are always excluded from introspection

---

## Security Considerations

The API includes API key authentication and parameterized queries out of the box. For production deployments, also consider:

- **Network security** — Run behind a reverse proxy (nginx, Caddy) with HTTPS termination
- **CORS** — Set `CORS_ORIGINS` to your specific frontend domain(s), not `true`
- **Rate limiting** — Add `@fastify/rate-limit` to prevent abuse
- **Row-level security** — PostgreSQL RLS policies for fine-grained access control
- **Error exposure** — Keep `EXPOSE_DB_ERRORS=false` in production to avoid leaking schema details
- **Key rotation** — Changing `API_SECRET` invalidates all existing keys instantly
- **Input validation** — The API validates column names but accepts any value types the database accepts; add stricter body schemas per table if needed
