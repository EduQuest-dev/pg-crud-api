import dotenv from "dotenv";
dotenv.config();

import { Pool } from "pg";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { config } from "../config.js";
import { introspectDatabase } from "../db/introspector.js";
import { verifyApiKey, SchemaPermissions } from "../auth/api-key.js";
import { createMcpServer } from "./server.js";

// Redirect console output to stderr so stdout stays clean for MCP JSON-RPC
const originalLog = console.log;
const originalWarn = console.warn;
console.log = (...args: unknown[]) => originalLog.call(console, ...args);
console.warn = (...args: unknown[]) => originalWarn.call(console, ...args);
// Pipe console.log/warn to stderr since stdout is reserved for MCP protocol
console.log = (...args: unknown[]) => process.stderr.write(args.join(" ") + "\n");
console.warn = (...args: unknown[]) => process.stderr.write(args.join(" ") + "\n");

async function main(): Promise<void> {
  // ── Database connection ──
  const pool = new Pool({
    connectionString: config.databaseUrl,
    statement_timeout: 30_000,
  });

  const readPool = config.databaseReadUrl
    ? new Pool({ connectionString: config.databaseReadUrl, statement_timeout: 30_000 })
    : pool;

  try {
    // Test connection
    const client = await pool.connect();
    const versionResult = await client.query("SELECT version()");
    console.log(`Connected to PostgreSQL: ${versionResult.rows[0].version.split(",")[0]}`);
    client.release();

    if (config.databaseReadUrl && readPool !== pool) {
      const readClient = await readPool.connect();
      await readClient.query("SELECT 1");
      readClient.release();
      console.log("Read replica connected");
    }

    // ── Introspect database ──
    console.log("Introspecting database...");
    const dbSchema = await introspectDatabase(pool);

    // ── Resolve API key permissions ──
    let permissions: SchemaPermissions | null = null;

    if (config.apiKeysEnabled) {
      const mcpApiKey = process.env.MCP_API_KEY;
      if (!mcpApiKey) {
        console.error(
          "Error: API_KEYS_ENABLED is true but MCP_API_KEY is not set.\n" +
          "Set MCP_API_KEY to a valid API key, or disable auth with API_KEYS_ENABLED=false",
        );
        process.exit(1);
      }

      if (!config.apiSecret) {
        console.error("Error: API_KEYS_ENABLED is true but API_SECRET is not set.");
        process.exit(1);
      }

      const result = verifyApiKey(mcpApiKey, config.apiSecret);
      if (!result.valid) {
        console.error("Error: MCP_API_KEY is invalid.");
        process.exit(1);
      }

      permissions = result.permissions ?? null;
      console.log(`Authenticated as "${result.label}" (${permissions ? "scoped permissions" : "full access"})`);
    } else {
      console.log("API key authentication is disabled — full access granted");
    }

    // ── Create and start MCP server ──
    const server = createMcpServer({ pool, readPool, dbSchema, permissions });

    const transport = new StdioServerTransport();
    await server.connect(transport);

    console.log(`MCP server running (stdio transport, ${dbSchema.tables.size} tables)`);

    // ── Graceful shutdown ──
    const shutdown = async () => {
      console.log("Shutting down MCP server...");
      await server.close();
      await pool.end();
      if (readPool !== pool) await readPool.end();
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } catch (err) {
    console.error("Fatal error:", (err as Error).message);
    await pool.end().catch(() => {});
    if (readPool !== pool) await readPool.end().catch(() => {});
    process.exit(1);
  }
}

await main();
