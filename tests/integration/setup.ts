import { vi } from "vitest";

vi.mock("../../src/config.js", () => ({
  config: {
    defaultPageSize: 50,
    maxPageSize: 1000,
    maxBulkInsertRows: 1000,
    bodyLimit: 5 * 1024 * 1024,
    swaggerEnabled: false,
    apiKeysEnabled: false,
    apiSecret: null,
    corsOrigins: true,
    exposeDbErrors: false,
    databaseReadUrl: null,
  },
}));

vi.mock("../../src/build-info.js", () => ({
  BUILD_VERSION: "0.0.0-test",
  BUILD_GIT_HASH: "abc1234",
  BUILD_TIMESTAMP: "2025-01-01T00:00:00.000Z",
}));

import Fastify, { FastifyInstance, FastifyError } from "fastify";
import { Pool } from "pg";
import { config } from "../../src/config.js";
import { BUILD_VERSION, BUILD_GIT_HASH, BUILD_TIMESTAMP } from "../../src/build-info.js";
import { registerCrudRoutes } from "../../src/routes/crud.js";
import { registerSchemaRoutes } from "../../src/routes/schema.js";
import { registerAuthHook, extractApiKey, verifyApiKey } from "../../src/auth/api-key.js";
import type { DatabaseSchema } from "../../src/db/introspector.js";

export function createMockPool() {
  const mockQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
  return {
    query: mockQuery,
    connect: vi.fn().mockResolvedValue({
      query: mockQuery,
      release: vi.fn(),
    }),
    end: vi.fn().mockResolvedValue(undefined),
  } as unknown as Pool;
}

interface BuildTestAppOptions {
  dbSchema: DatabaseSchema;
  pool?: Pool;
  readPool?: Pool;
  authEnabled?: boolean;
  authSecret?: string;
}

const DEFAULT_OPTIONS: BuildTestAppOptions = { dbSchema: { tables: new Map(), schemas: [] } };

export async function buildTestApp(options: BuildTestAppOptions = DEFAULT_OPTIONS): Promise<FastifyInstance> {
  const pool = options.pool ?? createMockPool();

  const app = Fastify({ logger: false });

  // Error handler matching index.ts
  app.setErrorHandler((error: FastifyError, _request, reply) => {
    if (error.validation) {
      const details = error.validation.map((v: any) => ({
        field: v.instancePath || v.params?.missingProperty || "unknown",
        message: v.message || "Invalid value",
        ...(v.params ? { constraint: v.params } : {}),
      }));
      return reply.status(400).send({
        error: "Validation Error",
        message: `${details.length} validation error(s)`,
        details,
      });
    }
    reply.status(error.statusCode || 500).send({
      error: error.name || "Error",
      message: error.message,
    });
  });

  if (options.authEnabled && options.authSecret) {
    registerAuthHook(app, options.authSecret);
  }

  // Health check (mirrors index.ts)
  app.get("/api/_health", async (request, reply) => {
    try {
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Health check timeout")), 5000)
      );
      await Promise.race([pool.query("SELECT 1"), timeout]);

      const base = {
        status: "healthy" as const,
        version: BUILD_VERSION,
        buildGitHash: BUILD_GIT_HASH,
        buildTimestamp: BUILD_TIMESTAMP,
      };

      const authenticated = !options.authEnabled
        || (options.authSecret && (() => {
          const key = extractApiKey(request);
          return key ? verifyApiKey(key, options.authSecret!).valid : false;
        })());

      if (authenticated) {
        return { ...base, tables: options.dbSchema.tables.size, schemas: options.dbSchema.schemas };
      }
      return base;
    } catch (err) {
      request.log.error(err, "Health check failed");
      return reply.status(503).send({ status: "unhealthy" });
    }
  });

  // Suppress console.log from route registration
  const consoleLog = console.log;
  console.log = () => {};
  await registerCrudRoutes(app, pool, options.dbSchema, options.readPool ?? pool);
  console.log = consoleLog;

  await registerSchemaRoutes(app, options.dbSchema);
  await app.ready();

  return app;
}
