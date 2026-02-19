import { createHmac, timingSafeEqual } from "node:crypto";
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

declare module "fastify" {
  interface FastifyRequest {
    apiKeyLabel?: string;
  }
}

const KEY_PREFIX = "pgcrud_";
const LABEL_PATTERN = /^[a-zA-Z0-9_-]+$/;

const PUBLIC_PATHS = ["/api/_health", "/docs"];

function isPublicPath(url: string): boolean {
  // Strip query string for matching
  const path = url.split("?")[0];
  return PUBLIC_PATHS.some((p) => path === p || path.startsWith(p + "/"));
}

export function generateApiKey(label: string, secret: string): string {
  if (!LABEL_PATTERN.test(label)) {
    throw new Error("Label must contain only alphanumeric characters, hyphens, and underscores");
  }
  const hmac = createHmac("sha256", secret).update(label).digest("hex");
  return `${KEY_PREFIX}${label}.${hmac}`;
}

export function verifyApiKey(key: string, secret: string): { valid: boolean; label?: string } {
  if (!key.startsWith(KEY_PREFIX)) {
    return { valid: false };
  }

  const withoutPrefix = key.slice(KEY_PREFIX.length);
  const dotIndex = withoutPrefix.indexOf(".");
  if (dotIndex <= 0) {
    return { valid: false };
  }

  const label = withoutPrefix.slice(0, dotIndex);
  const providedHmac = withoutPrefix.slice(dotIndex + 1);

  if (!LABEL_PATTERN.test(label) || providedHmac.length === 0) {
    return { valid: false };
  }

  const expectedHmac = createHmac("sha256", secret).update(label).digest("hex");

  const providedBuffer = Buffer.from(providedHmac, "hex");
  const expectedBuffer = Buffer.from(expectedHmac, "hex");

  if (providedBuffer.length !== expectedBuffer.length) {
    return { valid: false };
  }

  if (!timingSafeEqual(providedBuffer, expectedBuffer)) {
    return { valid: false };
  }

  return { valid: true, label };
}

function extractApiKey(request: FastifyRequest): string | null {
  const authHeader = request.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7).trim();
  }

  const apiKeyHeader = request.headers["x-api-key"];
  if (typeof apiKeyHeader === "string" && apiKeyHeader.length > 0) {
    return apiKeyHeader.trim();
  }

  return null;
}

export function registerAuthHook(app: FastifyInstance, secret: string): void {
  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    if (isPublicPath(request.url)) {
      return;
    }

    const key = extractApiKey(request);
    if (!key) {
      reply.status(401).send({
        error: "Unauthorized",
        message: "API key required. Provide via Authorization: Bearer <key> or X-API-Key header.",
      });
      return;
    }

    const result = verifyApiKey(key, secret);
    if (!result.valid) {
      reply.status(401).send({
        error: "Unauthorized",
        message: "Invalid API key.",
      });
      return;
    }

    request.apiKeyLabel = result.label;
  });
}
