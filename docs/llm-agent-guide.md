# pg-crud-api -- LLM Agent Integration Guide

You are consuming a **pg-crud-api** instance -- a zero-config CRUD REST API backed by PostgreSQL. The API auto-generates endpoints for every database table. This document tells you everything you need to interact with it.

## Quick Start

1. **Discover the schema** -- call `GET /api/_schema` to get all tables, columns, types, operations, and API capabilities in a single request.
2. **Authenticate** -- include `Authorization: Bearer <key>` or `X-API-Key: <key>` in every request (unless auth is disabled).
3. **Perform CRUD** -- use the endpoints below.

---

## Authentication

### When Enabled

Every request (except public paths) requires an API key in one of these headers:

```
Authorization: Bearer pgcrud_<label>.<hmac_hex>
X-API-Key: pgcrud_<label>.<hmac_hex>
```

### Public Paths (No Auth Required)

- `GET /api/_health`
- `GET /docs` (Swagger UI)

### When Disabled

If the server runs with `API_KEYS_ENABLED=false`, no authentication is needed. You can check this via `GET /api/_schema` -- the response includes `api.auth.enabled`.

---

## Schema Discovery

Before making CRUD calls, fetch the schema to understand available tables, columns, and operations.

### GET /api/_schema

Returns the full API schema: capabilities, configuration, and all tables.

**Response structure:**

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
        { "name": "email", "type": "string", "nullable": false, "hasDefault": false, "insertRequired": true, "maxLength": 255 },
        { "name": "name", "type": "string", "nullable": true, "hasDefault": false }
      ],
      "foreignKeys": [
        { "column": "org_id", "references": "organizations.id", "refPath": "/api/organizations" }
      ],
      "searchableColumns": ["email", "name"]
    }
  ]
}
```

**Key fields per column:**
- `pk: true` -- this column is part of the primary key
- `insertRequired: true` -- this column must be provided on insert (not nullable, no default)
- `hasDefault: true` -- the database generates a value if omitted (e.g., auto-increment, `now()`)
- `nullable: true` -- accepts `null`

### GET /api/_schema/:table

Same as above but returns a single table. Example: `GET /api/_schema/users`.

---

## URL Conventions

| Schema | Table | Endpoint |
|--------|-------|----------|
| `public` | `users` | `/api/users` |
| `public` | `order_items` | `/api/order_items` |
| `payments` | `transactions` | `/api/payments__transactions` |

Non-public schemas use double underscore (`__`) as separator.

---

## CRUD Operations

### LIST -- GET /api/{table}

Retrieve paginated records with optional filtering, sorting, searching, and column selection.

**Query parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `page` | integer | `1` | Page number (1-indexed) |
| `pageSize` | integer | `50` | Records per page (max: 1000) |
| `sortBy` | string | first PK | Column to sort by |
| `sortOrder` | `asc` \| `desc` | `asc` | Sort direction |
| `select` | string | all columns | Comma-separated column names to return |
| `search` | string | -- | Full-text search term (case-insensitive) |
| `searchColumns` | string | text columns | Comma-separated columns to search |
| `filter.{column}` | string | -- | Filter expression (see Filtering below) |

**Response:**

```json
{
  "data": [ { "id": 1, "email": "alice@example.com", "name": "Alice" } ],
  "pagination": { "page": 1, "pageSize": 50, "total": 142, "totalPages": 3 }
}
```

### READ -- GET /api/{table}/{id}

Retrieve a single record by primary key.

- **Single PK:** `/api/users/42`
- **Composite PK:** `/api/user_roles/42,7` (comma-separated, order matches `primaryKeys` array from schema)

**Query parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `select` | string | Comma-separated column names to return |

**Response:** The record object directly (not wrapped).

```json
{ "id": 42, "email": "alice@example.com", "name": "Alice" }
```

**404** if not found:
```json
{ "error": "Record not found" }
```

### CREATE -- POST /api/{table}

Insert one or many records.

**Single record:**

```json
POST /api/users
Content-Type: application/json

{ "email": "bob@example.com", "name": "Bob" }
```

Response (201):
```json
{ "id": 2, "email": "bob@example.com", "name": "Bob" }
```

**Bulk insert** (send an array, max 1000 rows):

```json
POST /api/users
Content-Type: application/json

[
  { "email": "bob@example.com", "name": "Bob" },
  { "email": "carol@example.com", "name": "Carol" }
]
```

Response (201):
```json
{ "data": [ { "id": 2, "email": "bob@example.com", "name": "Bob" }, { "id": 3, "email": "carol@example.com", "name": "Carol" } ], "count": 2 }
```

**Rules:**
- Columns with `insertRequired: true` must be provided.
- Columns with `hasDefault: true` can be omitted (the database fills them in).
- PK columns with defaults (e.g., serial/autoincrement) can be omitted.
- Unknown columns are silently ignored.

### REPLACE -- PUT /api/{table}/{id}

Full replacement of a record. **All non-PK columns are required.**

```json
PUT /api/users/42
Content-Type: application/json

{ "email": "alice-new@example.com", "name": "Alice Updated" }
```

Response (200): the updated record. **404** if not found.

### UPDATE -- PATCH /api/{table}/{id}

Partial update. Only provided fields are changed.

```json
PATCH /api/users/42
Content-Type: application/json

{ "name": "Alice Renamed" }
```

Response (200): the updated record. **404** if not found.

### DELETE -- DELETE /api/{table}/{id}

Delete a record by primary key.

```json
DELETE /api/users/42
```

Response (200):
```json
{ "deleted": true, "softDelete": false, "record": { "id": 42, "email": "alice@example.com", "name": "Alice" } }
```

**404** if not found.

**Soft delete:** Tables with a `deleted_at` column are soft-deleted instead of removed. The API sets `deleted_at = NOW()` (and `updated_at = NOW()` if that column exists) via an UPDATE instead of DELETE. The response will have `"softDelete": true`. To find non-deleted records, filter with `?filter.deleted_at=is:null`.

**Automatic timestamps:** Tables with an `updated_at` column will have it automatically set to `NOW()` on INSERT, UPDATE (PUT/PATCH), and soft DELETE. If you explicitly provide `updated_at` in the request body, your value is used instead.

---

## Filtering

Apply filters using query parameters with the pattern `filter.{column}={operator}:{value}`.

### Operators

| Operator | SQL | Example |
|----------|-----|---------|
| `eq` | `=` | `?filter.status=eq:active` |
| `neq` | `!=` | `?filter.status=neq:deleted` |
| `gt` | `>` | `?filter.age=gt:18` |
| `gte` | `>=` | `?filter.age=gte:21` |
| `lt` | `<` | `?filter.price=lt:100` |
| `lte` | `<=` | `?filter.price=lte:99.99` |
| `like` | `LIKE` | `?filter.name=like:%smith%` |
| `ilike` | `ILIKE` | `?filter.name=ilike:%smith%` |
| `is` | `IS NULL` / `IS NOT NULL` | `?filter.deleted_at=is:null` or `?filter.deleted_at=is:notnull` |
| `in` | `IN (...)` | `?filter.status=in:active,pending,review` (max 100 values) |

If no operator is specified, `eq` is assumed: `?filter.status=active` is the same as `?filter.status=eq:active`.

### Combining Filters

Multiple filters are combined with AND:

```
GET /api/users?filter.age=gte:21&filter.status=eq:active&filter.country=in:US,CA
```

This produces: `WHERE age >= 21 AND status = 'active' AND country IN ('US', 'CA')`

---

## Searching

Use `search` for case-insensitive text search across multiple columns.

```
GET /api/users?search=alice
```

By default, searches all text/varchar columns. Restrict with `searchColumns`:

```
GET /api/users?search=alice&searchColumns=name,email
```

Search uses PostgreSQL `ILIKE` with wildcards on both sides. Special characters (`%`, `_`, `\`) are escaped automatically.

---

## Column Selection

Return only specific columns to reduce payload size:

```
GET /api/users?select=id,name
GET /api/users/42?select=id,email
```

If none of the requested columns exist, you get a 400 error listing available columns.

---

## Pagination

Every list response includes pagination metadata:

```json
{
  "data": [...],
  "pagination": {
    "page": 2,
    "pageSize": 50,
    "total": 342,
    "totalPages": 7
  }
}
```

To iterate all records:
1. Start with `?page=1&pageSize=100`
2. Continue incrementing `page` while `page <= totalPages`

---

## Error Handling

All errors follow this structure:

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
| 400 | Bad Request | Invalid filter column, invalid body, type mismatch, FK violation, NOT NULL violation |
| 401 | Unauthorized | Missing or invalid API key |
| 404 | Not Found | Record or table does not exist |
| 409 | Conflict | Duplicate key (unique constraint violation) |
| 500 | Internal Error | Unexpected database error |

### Validation Errors

Body validation failures include a `details` array:

```json
{
  "error": "Bad request",
  "message": "body must have required property 'email'",
  "statusCode": 400,
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

## Meta Endpoints

### GET /api/_health

Public health check. Returns 200 when healthy, 503 when not.

```json
{ "status": "healthy", "tables": 12, "schemas": ["public"] }
```

### GET /api/_meta/tables

Lists all available tables with basic info.

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

Detailed schema for a single table. The `:table` parameter is the route path segment (e.g., `users` or `payments__transactions`).

```json
{
  "schema": "public",
  "table": "users",
  "fqn": "\"public\".\"users\"",
  "columns": [
    { "name": "id", "type": "integer", "nullable": false, "hasDefault": true, "maxLength": null, "isPrimaryKey": true }
  ],
  "primaryKeys": ["id"],
  "foreignKeys": []
}
```

---

## Recommended Agent Workflow

1. **Bootstrap:** `GET /api/_schema` -- cache the response. It contains everything you need: table names, column types, which fields are required, foreign key relationships, and API configuration.

2. **Validate before calling:** Use the schema to construct valid requests. Check `insertRequired` fields before POST, verify column names before filtering, and respect `maxPageSize` limits.

3. **Handle relationships:** Use `foreignKeys` from the schema to understand table relationships. The `refPath` field gives you the direct API path to the referenced table.

4. **Use column selection:** When you only need specific fields, use `?select=col1,col2` to reduce response size and improve performance.

5. **Paginate large datasets:** Never assume all records fit in one page. Always check `pagination.totalPages` and iterate if needed.

6. **Use PATCH over PUT:** Unless you intend to replace all fields, prefer PATCH for updates -- it only requires the fields you want to change.

7. **Handle errors gracefully:** A 409 means a unique constraint was violated (duplicate). A 400 with a constraint message usually means a FK reference is invalid. Retry logic is only appropriate for 500 errors.

---

## Type Reference

The `type` field in schema columns maps to JSON types:

| Column Type | JSON Type | Format | Notes |
|-------------|-----------|--------|-------|
| `integer` | `integer` | -- | int2, int4, serial, int8, bigserial |
| `number` | `number` | -- | float4, float8, numeric, decimal, money |
| `boolean` | `boolean` | -- | |
| `string` | `string` | -- | Default for unknown PG types |
| `string` | `string` | `uuid` | UUID columns |
| `string` | `string` | `date` | Date without time |
| `string` | `string` | `date-time` | Timestamp with/without timezone |
| `string` | `string` | `time` | Time with/without timezone |
| `string` | `string` | `byte` | Binary data (bytea) |
| `object` | `object` | -- | JSON/JSONB (any valid JSON) |
| `array` | `array` | -- | PostgreSQL array types (items typed accordingly) |

---

## OpenAPI / Swagger

When enabled, interactive API documentation is available at `/docs`. The OpenAPI 3.0 spec is auto-generated from the database schema and includes request/response schemas for every endpoint.
