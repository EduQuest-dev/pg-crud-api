import { describe, it, expect } from "vitest";
import { generateApiKey, verifyApiKey } from "../../src/auth/api-key.js";

const SECRET = "test-secret-value";

describe("generateApiKey", () => {
  it("produces key with pgcrud_ prefix", () => {
    const key = generateApiKey("admin", SECRET);
    expect(key).toMatch(/^pgcrud_/);
  });

  it("produces key in format pgcrud_{label}.{64-hex}", () => {
    const key = generateApiKey("admin", SECRET);
    expect(key).toMatch(/^pgcrud_admin\.[0-9a-f]{64}$/);
  });

  it("is deterministic (same label + secret = same key)", () => {
    const key1 = generateApiKey("admin", SECRET);
    const key2 = generateApiKey("admin", SECRET);
    expect(key1).toBe(key2);
  });

  it("produces different keys for different labels", () => {
    const key1 = generateApiKey("admin", SECRET);
    const key2 = generateApiKey("service", SECRET);
    expect(key1).not.toBe(key2);
  });

  it("produces different keys for different secrets", () => {
    const key1 = generateApiKey("admin", "secret-a");
    const key2 = generateApiKey("admin", "secret-b");
    expect(key1).not.toBe(key2);
  });

  it("accepts labels with alphanumeric, hyphens, underscores", () => {
    expect(() => generateApiKey("my-service_v2", SECRET)).not.toThrow();
  });

  it("rejects label with spaces", () => {
    expect(() => generateApiKey("has spaces", SECRET)).toThrow();
  });

  it("rejects label with dots", () => {
    expect(() => generateApiKey("has.dot", SECRET)).toThrow();
  });

  it("rejects label with special characters", () => {
    expect(() => generateApiKey("user@org", SECRET)).toThrow();
  });

  it("rejects empty label", () => {
    expect(() => generateApiKey("", SECRET)).toThrow();
  });
});

describe("verifyApiKey", () => {
  it("validates a correctly generated key", () => {
    const key = generateApiKey("myservice", SECRET);
    const result = verifyApiKey(key, SECRET);
    expect(result).toEqual({ valid: true, label: "myservice" });
  });

  it("roundtrips with various labels", () => {
    for (const label of ["admin", "service-a", "worker_1", "A"]) {
      const key = generateApiKey(label, SECRET);
      expect(verifyApiKey(key, SECRET)).toEqual({ valid: true, label });
    }
  });

  it("rejects key with wrong secret", () => {
    const key = generateApiKey("admin", SECRET);
    expect(verifyApiKey(key, "wrong-secret")).toEqual({ valid: false });
  });

  it("rejects tampered HMAC", () => {
    const key = generateApiKey("admin", SECRET);
    const tampered = key.slice(0, -4) + "0000";
    expect(verifyApiKey(tampered, SECRET)).toEqual({ valid: false });
  });

  it("rejects key without pgcrud_ prefix", () => {
    expect(verifyApiKey("admin.abc123def456", SECRET)).toEqual({ valid: false });
  });

  it("rejects empty string", () => {
    expect(verifyApiKey("", SECRET)).toEqual({ valid: false });
  });

  it("rejects key with no dot separator", () => {
    expect(verifyApiKey("pgcrud_adminnodot", SECRET)).toEqual({ valid: false });
  });

  it("rejects key with dot at start (empty label)", () => {
    expect(verifyApiKey("pgcrud_.abcdef1234567890", SECRET)).toEqual({ valid: false });
  });

  it("rejects key with invalid label characters", () => {
    expect(verifyApiKey("pgcrud_bad label.abcdef", SECRET)).toEqual({ valid: false });
  });

  it("rejects key with truncated HMAC (wrong buffer length)", () => {
    const key = generateApiKey("admin", SECRET);
    const truncated = key.slice(0, key.indexOf(".") + 5); // only 4 hex chars
    expect(verifyApiKey(truncated, SECRET)).toEqual({ valid: false });
  });
});
