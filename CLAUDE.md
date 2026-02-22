# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**pg-crud-api** — A zero-config CRUD REST API generator for PostgreSQL. It introspects the database schema at startup via `information_schema` and dynamically generates Fastify routes for every discovered table. No ORM, no code generation, no migrations.

## Commands

```bash
npm run dev              # Development with hot reload (tsx watch)
npm run build            # Compile TypeScript (tsc → dist/)
npm start                # Run production build (node dist/index.js)
npm test                 # Run tests (vitest)
npm run test:watch       # Run tests in watch mode
npm run test:coverage    # Run tests with coverage report
npm run generate-key -- <API_SECRET> <label>  # Generate an API key (full access)
npm run generate-key -- <API_SECRET> <label> --schemas public:rw,reporting:r  # Generate key with schema permissions
```

Requires a PostgreSQL database. Copy `.env.example` to `.env` and set `DATABASE_URL` and `API_SECRET`. Swagger UI available at `http://localhost:3000/docs` when running.

Tests use **vitest** with 100% coverage thresholds (statements, branches, functions, lines).

## Development Gotchas

- `dotenv` loads `.env`, NOT `.env.example` — must `cp .env.example .env` first
- `DATABASE_URL` accepts `jdbc:postgresql://` prefix (auto-stripped in config.ts)
- All local imports must use `.js` extension (Node16 module resolution)
- Fastify request decoration uses `declare module "fastify"` augmentation (see `auth/api-key.ts`), not `as any`
- `buildSelectQuery` and `buildCountQuery` WHERE clauses must stay in sync (filters + search)
- Query-builder functions throw plain `Error` for validation failures (invalid columns, IN limit exceeded) — route handlers convert these to 400 via `handleRouteError`
- Invalid filter/select columns are rejected with errors, not silently ignored
- CORS is restricted in production by default (`CORS_ORIGINS` env var); PG error details are hidden by default (`EXPOSE_DB_ERRORS`)

## Architecture

```
src/
  index.ts              # Entry point — server setup, plugins, auth, startup
  config.ts             # Environment config (AppConfig)
  db/
    introspector.ts     # PostgreSQL schema introspection via information_schema
    query-builder.ts    # Dynamic parameterized SQL generation
  routes/
    crud.ts             # CRUD route registration & handlers
    schema.ts           # Agent-friendly schema endpoint (/api/_schema)
  auth/
    api-key.ts          # HMAC-SHA256 API key generation, verification, Fastify hook
    generate-key.ts     # CLI utility for generating API keys
  errors/
    pg-errors.ts        # PostgreSQL error code → HTTP status mapping
```

The startup flow is linear:

1. **index.ts** — Connects to PostgreSQL via `pg.Pool`, introspects database, registers Fastify plugins (CORS, auth hook, Swagger), registers CRUD routes, starts server with graceful shutdown.
2. **config.ts** — Reads `.env` into a typed `AppConfig` object. Defines `SYSTEM_SCHEMAS` always excluded from introspection.
3. **db/introspector.ts** — Queries `information_schema` (columns, PKs, FKs) in parallel. Builds `Map<string, TableInfo>` keyed by fully-qualified name (`"schema"."table"`).
4. **db/query-builder.ts** — Pure functions generating parameterized SQL (`$1`, `$2`, ...) for CRUD operations. Handles pagination, filtering (`filter.col=op:value`), full-text search (ILIKE), column selection, sorting. Maps PG types to JSON Schema via `pgTypeToJsonSchema`.
5. **routes/crud.ts** — Registers Fastify CRUD endpoints per table. Generates OpenAPI schemas from `TableInfo`.
6. **errors/pg-errors.ts** — Maps PG error codes to HTTP status codes (23505→409, 23503→400, 23502→400, 22P02→400).
7. **auth/api-key.ts** — Stateless HMAC-SHA256 API key auth with optional schema-level permissions. Legacy keys have format `pgcrud_{label}.{hmac_hex}`; permission-scoped keys have format `pgcrud_{label}:{base64url_permissions}.{hmac_hex}`. Derived from a single `API_SECRET`. Registers a Fastify `onRequest` hook that skips public paths (`/api/_health`, `/docs*`).
8. **routes/schema.ts** — Agent-friendly schema endpoint (`/api/_schema`). Requires authentication when API keys are enabled. Filters tables by key permissions.

### Authentication

Keys are derived using `HMAC-SHA256(data, API_SECRET)` — no database storage needed. The label is a user-chosen identifier (e.g., `admin`, `service-a`). Verification recomputes the HMAC and uses `timingSafeEqual` for comparison.

**Key formats:**
- Legacy (full access): `pgcrud_{label}.{hmac}` — HMAC covers the label
- With permissions: `pgcrud_{label}:{base64url_json}.{hmac}` — HMAC covers `{label}:{base64url_json}`, making permissions tamper-proof

**Schema permissions** are encoded as JSON in the key: `{"public":"rw","reporting":"r"}`. Permission values: `"r"` (read), `"w"` (write), `"rw"` (both). Use `"*"` as schema name for wildcard access. Legacy keys without permissions get full access.

Permission enforcement: read operations (GET) require `"r"`, write operations (POST/PUT/PATCH/DELETE) require `"w"`. Denied requests receive 403. Meta/schema endpoints filter tables to only show accessible schemas.

Accepted headers: `Authorization: Bearer <key>` or `X-API-Key: <key>`.

Public endpoints (no auth): `/api/_health`, `/docs/*`.

Set `API_KEYS_ENABLED=false` to disable auth entirely (development mode). Server refuses to start if auth is enabled but `API_SECRET` is missing.

### Key data types

- **`DatabaseSchema`** (`db/introspector.ts`) — `{ tables: Map<string, TableInfo>, schemas: string[] }`
- **`TableInfo`** (`db/introspector.ts`) — Schema, name, columns, PKs, FKs, `fqn` (quoted SQL identifier), `routePath` (URL segment)
- **`ColumnInfo`** (`db/introspector.ts`) — Column metadata including `udtName` (used for type mapping and search detection)

### Routing conventions

- Public schema tables: `/api/{table}` (e.g., `/api/users`)
- Other schemas: `/api/{schema}__{table}` (double underscore separator)
- Composite PKs: comma-separated in URL (e.g., `/api/user_roles/42,7`)
- Meta endpoints: `/api/_meta/tables`, `/api/_meta/tables/:table`, `/api/_health`
- Agent schema: `/api/_schema` (all tables), `/api/_schema/:table` (single table)

### SQL safety

All queries use parameterized placeholders. Identifiers are quoted via `quoteIdent()` which escapes double-quotes. Column names are validated against `TableInfo.columns` before use in queries.

## Stack

- **Runtime:** Node.js + TypeScript (ES2022, strict mode)
- **HTTP:** Fastify v5 with `@fastify/cors`, `@fastify/swagger`, `@fastify/swagger-ui`
- **Database:** PostgreSQL via `pg` (raw driver, no ORM)
- **Auth:** HMAC-SHA256 via `node:crypto` (no external dependencies)
- **Testing:** vitest (100% coverage thresholds)
- **Dev tooling:** tsx (watch mode), tsc (build)

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | `postgresql://localhost:5432/mydb` | PostgreSQL connection string (`jdbc:` prefix auto-stripped) |
| `PORT` | `3000` | Server port |
| `HOST` | `0.0.0.0` | Listen address |
| `SCHEMAS` | _(all)_ | Comma-separated whitelist of schemas to expose |
| `EXCLUDE_SCHEMAS` | _(none)_ | Comma-separated schemas to exclude |
| `EXCLUDE_TABLES` | _(none)_ | Comma-separated tables to exclude (`schema.table` format) |
| `DEFAULT_PAGE_SIZE` | `50` | Default pagination size |
| `MAX_PAGE_SIZE` | `1000` | Maximum allowed `pageSize` parameter |
| `MAX_BULK_INSERT_ROWS` | `1000` | Maximum rows per bulk POST |
| `BODY_LIMIT` | `5242880` (5 MB) | Maximum request body size in bytes |
| `SWAGGER_ENABLED` | `true` | Enable Swagger UI at `/docs` |
| `API_SECRET` | _(none)_ | HMAC key for API key generation (required if auth enabled) |
| `API_KEYS_ENABLED` | `true` | Enable API key authentication |
| `CORS_ORIGINS` | `true` (dev) / `false` (prod) | CORS allowed origins (`true`/`false`/origin string) |
| `EXPOSE_DB_ERRORS` | `false` | Include PostgreSQL error details in responses |
