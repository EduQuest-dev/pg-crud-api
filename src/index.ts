import Fastify from "fastify";
import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import addFormats from "ajv-formats";
import type { FastifyError } from "fastify";
import { Pool } from "pg";
import { config } from "./config.js";
import { introspectDatabase } from "./db/introspector.js";
import { registerCrudRoutes } from "./routes/crud.js";
import { registerSchemaRoutes } from "./routes/schema.js";
import { registerAuthHook, verifyApiKey } from "./auth/api-key.js";

async function main() {
  // ── Database connection ──
  const pool = new Pool({
    connectionString: config.databaseUrl,
    statement_timeout: 30_000,
  });

  try {

  {
    let client;
    try {
      client = await pool.connect();
      const versionResult = await client.query("SELECT version()");
      console.log(`🐘 Connected to PostgreSQL`);
      console.log(`   ${versionResult.rows[0].version.split(",")[0]}`);
    } catch (err) {
      console.error("❌ Failed to connect to database:", (err as Error).message);
      await pool.end().catch(() => {});
      process.exit(1);
    } finally {
      client?.release();
    }
  }

  // ── Introspect database ──
  console.log("\n🔍 Introspecting database...");
  const dbSchema = await introspectDatabase(pool);

  // ── Create Fastify server ──
  const isDev = process.env.NODE_ENV !== "production";
  const loggerConfig = isDev
    ? {
        level: "info" as const,
        transport: {
          target: "pino-pretty",
          options: { translateTime: "HH:mm:ss", ignore: "pid,hostname" },
        },
      }
    : { level: "info" as const };

  const app = Fastify({
    logger: loggerConfig,
    bodyLimit: config.bodyLimit,
    ajv: {
      plugins: [addFormats] as never,
    },
  });

  // ── Validation error handler ──
  app.setErrorHandler((error: FastifyError, _request, reply) => {
    if (error.validation) {
      const details = error.validation.map((v: { instancePath?: string; params?: Record<string, unknown>; message?: string }) => ({
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
    // Re-throw non-validation errors
    reply.status(error.statusCode || 500).send({
      error: error.name || "Error",
      message: error.message,
    });
  });

  // ── CORS ──
  await app.register(cors, {
    origin: typeof config.corsOrigins === "string"
      ? config.corsOrigins.split(",").map((s) => s.trim())
      : config.corsOrigins,
  });

  // ── Authentication ──
  if (config.apiKeysEnabled) {
    if (!config.apiSecret) {
      console.error("❌ API_KEYS_ENABLED is true but API_SECRET is not set.");
      console.error("   Set API_SECRET in .env or disable auth with API_KEYS_ENABLED=false");
      process.exit(1);
    }
    registerAuthHook(app, config.apiSecret);
    console.log("🔐 API key authentication enabled");
  } else {
    console.warn("⚠️  API key authentication is DISABLED");
  }

  // ── Swagger ──
  if (config.swaggerEnabled) {
    await app.register(swagger, {
      openapi: {
        openapi: "3.0.0",
        info: {
          title: "Auto-Generated CRUD API",
          description: `Dynamically generated REST API for PostgreSQL database.\n\nSchemas: ${dbSchema.schemas.join(", ")}\nTables: ${dbSchema.tables.size}`,
          version: "1.0.0",
        },
        tags: Array.from(dbSchema.tables.values()).map((t) => ({
          name: t.schema === "public" ? t.name : `${t.schema}.${t.name}`,
          description: `CRUD operations for ${t.fqn}`,
        })),
        ...(config.apiKeysEnabled
          ? {
              components: {
                securitySchemes: {
                  bearerAuth: {
                    type: "http",
                    scheme: "bearer",
                    description: "API key in format: pgcrud_{label}.{hmac}",
                  },
                  apiKeyHeader: {
                    type: "apiKey",
                    in: "header",
                    name: "X-API-Key",
                    description: "API key in format: pgcrud_{label}.{hmac}",
                  },
                },
              },
              security: [{ bearerAuth: [] }, { apiKeyHeader: [] }],
            }
          : {}),
      },
    });

    await app.register(swaggerUi, {
      routePrefix: "/docs",
      uiConfig: {
        docExpansion: "list",
        deepLinking: true,
        persistAuthorization: true,
        // NOTE: new Function() is used here because @fastify/swagger-ui serializes these
        // callbacks to inject them as inline scripts in the Swagger UI HTML page. They run
        // client-side in the browser, not on the server. No user input is interpolated.
        // This requires 'unsafe-eval' CSP if a Content-Security-Policy header is set.

        // Inject stored API key into ALL requests including the initial spec fetch.
        requestInterceptor: new Function("req", `
          try {
            var stored = JSON.parse(localStorage.getItem("authorized") || "{}");
            var bearer = stored && stored.bearerAuth && stored.bearerAuth.schema
              && stored.bearerAuth.schema.scheme === "bearer" && stored.bearerAuth.value;
            var apiKey = stored && stored.apiKeyHeader && stored.apiKeyHeader.value;
            if (bearer) req.headers["Authorization"] = "Bearer " + bearer;
            else if (apiKey) req.headers["X-API-Key"] = apiKey;
          } catch(e) {}
          return req;
        `) as never, // Function type not assignable to swagger-ui's expected type
        // After user clicks Authorize, automatically reload the spec so endpoints appear.
        onComplete: new Function(`
          var checkInterval = setInterval(function() {
            var btn = document.querySelector('.btn.authorize');
            if (btn && !btn._patched) {
              btn._patched = true;
              btn.addEventListener('click', function() {
                var authBefore = localStorage.getItem('authorized');
                var dialogSeen = false;
                var poll = setInterval(function() {
                  var dialog = document.querySelector('.dialog-ux');
                  if (dialog) dialogSeen = true;
                  if (dialogSeen && !dialog) {
                    clearInterval(poll);
                    if (localStorage.getItem('authorized') !== authBefore) {
                      window.location.reload();
                    }
                  }
                }, 200);
              });
              clearInterval(checkInterval);
            }
          }, 500);
        `) as never, // Function type not assignable to swagger-ui's expected type
      },
      ...(config.apiKeysEnabled && config.apiSecret
        ? {
            transformSpecification: (swaggerObject: Record<string, unknown>, request: { headers: Record<string, string | string[] | undefined> }) => {
              const authHeader = request.headers.authorization;
              const apiKeyHeader = request.headers["x-api-key"];
              const key = (typeof authHeader === "string" && authHeader.startsWith("Bearer ")
                ? authHeader.slice(7).trim()
                : typeof apiKeyHeader === "string"
                  ? apiKeyHeader.trim()
                  : null);
              if (key && verifyApiKey(key, config.apiSecret!).valid) {
                return swaggerObject;
              }
              return {
                openapi: "3.0.0",
                info: {
                  title: "Auto-Generated CRUD API",
                  description: "Authenticate using the **Authorize** button above to view API endpoints.",
                  version: "1.0.0",
                },
                paths: {},
                components: swaggerObject.components || {},
                security: swaggerObject.security || [],
              };
            },
          }
        : {}),
    });
  }

  // ── Health check ──
  app.get("/api/_health", async (request, reply) => {
    try {
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Health check timeout")), 5000)
      );
      await Promise.race([pool.query("SELECT 1"), timeout]);
      return { status: "healthy", tables: dbSchema.tables.size, schemas: dbSchema.schemas };
    } catch (err) {
      request.log.error(err, "Health check failed");
      return reply.status(503).send({ status: "unhealthy" });
    }
  });

  // ── Register all CRUD routes ──
  console.log("\n🛤️  Registering routes...");
  await registerCrudRoutes(app, pool, dbSchema);
  await registerSchemaRoutes(app, dbSchema);

  // ── Start server ──
  try {
    await app.listen({ port: config.port, host: config.host });
    console.log(`\n🚀 Server running at http://${config.host}:${config.port}`);
    if (config.swaggerEnabled) {
      console.log(`📚 Swagger UI: http://localhost:${config.port}/docs`);
    }
    console.log(`❤️  Health: http://localhost:${config.port}/api/_health`);
    console.log(`📋 Tables: http://localhost:${config.port}/api/_meta/tables`);
    console.log(`🤖 Agent schema: http://localhost:${config.port}/api/_schema\n`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  // ── Graceful shutdown ──
  const shutdown = async () => {
    console.log("\n🛑 Shutting down...");
    await app.close();
    await pool.end();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  } catch (err) {
    console.error("Fatal error during startup:", err);
    await pool.end().catch(() => {});
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
