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

API key authentication is enabled by default. Keys are derived from a single `API_SECRET` using HMAC-SHA256 — no database storage required.

### Generating Keys

```bash
npm run generate-key -- <API_SECRET> <label>

# Example:
npm run generate-key -- my-secret-value admin
# Output: pgcrud_admin.bccd91ad74b9c9f3310b044deb72712fc411d25eb7de78be42f5e0bf142ee7e7
```

The `label` is a human-readable identifier (e.g., `admin`, `service-a`, `readonly-backend`). Different labels produce different keys, all verifiable with the same secret.

### Using Keys

Pass the key via either header:

```bash
# Authorization header
curl http://localhost:3000/api/users \
  -H "Authorization: Bearer pgcrud_admin.bccd91..."

# X-API-Key header
curl http://localhost:3000/api/users \
  -H "X-API-Key: pgcrud_admin.bccd91..."
```

### Public Endpoints

These endpoints do not require authentication:

- `GET /api/_health` — Health check
- `GET /docs/*` — Swagger UI and OpenAPI spec

### Disabling Auth

Set `API_KEYS_ENABLED=false` in `.env` to disable authentication entirely (useful for development).

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
| `GET`  | `/api/_health`                | Health check                             |
| `GET`  | `/api/_meta/tables`           | List all available tables                |
| `GET`  | `/api/_meta/tables/:table`    | Table schema details                     |
| `GET`  | `/api/_schema`                | Full API schema (for LLM agents / tools) |
| `GET`  | `/api/_schema/:table`         | Single table schema                      |

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
