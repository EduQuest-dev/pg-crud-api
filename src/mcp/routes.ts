import { randomUUID } from 'node:crypto'
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { Pool } from 'pg'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { DatabaseSchema } from '../db/introspector.js'
import { createMcpServer } from './server.js'

// ─── Types ───────────────────────────────────────────────────────────

export interface McpRouteOptions {
  pool: Pool;
  readPool: Pool;
  dbSchema: DatabaseSchema;
}

interface McpSession {
  transport: StreamableHTTPServerTransport;
  server: ReturnType<typeof createMcpServer>;
}

// ─── Route Registration ──────────────────────────────────────────────

export async function registerMcpRoutes (
  app: FastifyInstance,
  opts: McpRouteOptions
): Promise<void> {
  const sessions = new Map<string, McpSession>()
  const mcpPath = '/mcp'

  // POST /mcp — Main JSON-RPC endpoint (initialization + requests)
  app.post(mcpPath, {
    schema: { hide: true },
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const permissions = request.apiKeyPermissions ?? null
      const sessionId = request.headers['mcp-session-id'] as string | undefined

      // Existing session — forward the request
      if (sessionId && sessions.has(sessionId)) {
        const session = sessions.get(sessionId)!
        await session.transport.handleRequest(request.raw, reply.raw, request.body)
        reply.hijack()
        return
      }

      // New session — create transport, connect server, handle the init request
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
      })

      const server = createMcpServer({
        pool: opts.pool,
        readPool: opts.readPool,
        dbSchema: opts.dbSchema,
        permissions,
      })

      await server.connect(transport)
      await transport.handleRequest(request.raw, reply.raw, request.body)

      // Store session *after* handleRequest so transport.sessionId is set
      const newSessionId = transport.sessionId
      if (newSessionId) {
        sessions.set(newSessionId, { transport, server })
        transport.onclose = () => {
          sessions.delete(newSessionId)
        }
      }

      reply.hijack()
    },
  })

  // GET /mcp — SSE stream for server-to-client notifications
  app.get(mcpPath, {
    schema: { hide: true },
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const sessionId = request.headers['mcp-session-id'] as string | undefined

      if (!sessionId || !sessions.has(sessionId)) {
        return reply.status(400).send({ error: 'Invalid or missing session ID' })
      }

      const session = sessions.get(sessionId)!

      await session.transport.handleRequest(request.raw, reply.raw)
      reply.hijack()
    },
  })

  // DELETE /mcp — Close a session
  app.delete(mcpPath, {
    schema: { hide: true },
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const sessionId = request.headers['mcp-session-id'] as string | undefined

      if (!sessionId || !sessions.has(sessionId)) {
        return reply.status(400).send({ error: 'Invalid or missing session ID' })
      }

      const session = sessions.get(sessionId)!
      await session.transport.close()
      sessions.delete(sessionId)

      reply.status(200).send({ closed: true })
    },
  })
}
