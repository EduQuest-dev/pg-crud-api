import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseList, parseIntOrDefault, parseCorsOrigins, parseDatabaseUrl } from "../../src/config.js";

describe("parseList", () => {
  it("returns empty array for undefined", () => {
    expect(parseList(undefined)).toEqual([]);
  });

  it("returns empty array for empty string", () => {
    expect(parseList("")).toEqual([]);
  });

  it("returns empty array for whitespace-only string", () => {
    expect(parseList("  ")).toEqual([]);
  });

  it("splits comma-separated values", () => {
    expect(parseList("a,b,c")).toEqual(["a", "b", "c"]);
  });

  it("trims whitespace from values", () => {
    expect(parseList(" a , b , c ")).toEqual(["a", "b", "c"]);
  });

  it("filters out empty segments", () => {
    expect(parseList("a,,b")).toEqual(["a", "b"]);
  });

  it("handles single value", () => {
    expect(parseList("public")).toEqual(["public"]);
  });
});

describe("parseIntOrDefault", () => {
  it("returns fallback for undefined", () => {
    expect(parseIntOrDefault(undefined, 42)).toBe(42);
  });

  it("parses valid integer string", () => {
    expect(parseIntOrDefault("100", 42)).toBe(100);
  });

  it("returns fallback for non-numeric string", () => {
    expect(parseIntOrDefault("abc", 42)).toBe(42);
  });

  it("truncates float strings (parseInt behavior)", () => {
    expect(parseIntOrDefault("3.14", 42)).toBe(3);
  });

  it("returns fallback for empty string", () => {
    expect(parseIntOrDefault("", 42)).toBe(42);
  });

  it("parses negative numbers", () => {
    expect(parseIntOrDefault("-5", 42)).toBe(-5);
  });

  it("parses zero", () => {
    expect(parseIntOrDefault("0", 42)).toBe(0);
  });
});

describe("parseCorsOrigins", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (originalNodeEnv !== undefined) {
      process.env.NODE_ENV = originalNodeEnv;
    } else {
      delete process.env.NODE_ENV;
    }
  });

  it("returns true for 'true'", () => {
    expect(parseCorsOrigins("true")).toBe(true);
  });

  it("returns false for 'false'", () => {
    expect(parseCorsOrigins("false")).toBe(false);
  });

  it("returns URL string as-is", () => {
    expect(parseCorsOrigins("https://example.com")).toBe("https://example.com");
  });

  it("returns false for undefined in production", () => {
    process.env.NODE_ENV = "production";
    expect(parseCorsOrigins(undefined)).toBe(false);
  });

  it("returns true for undefined in non-production", () => {
    process.env.NODE_ENV = "development";
    expect(parseCorsOrigins(undefined)).toBe(true);
  });

  it("returns comma-separated origins as-is", () => {
    expect(parseCorsOrigins("https://a.com,https://b.com")).toBe("https://a.com,https://b.com");
  });
});

describe("parseDatabaseUrl", () => {
  it("returns null for undefined", () => {
    expect(parseDatabaseUrl(undefined)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseDatabaseUrl("")).toBeNull();
  });

  it("returns null for whitespace-only string", () => {
    expect(parseDatabaseUrl("   ")).toBeNull();
  });

  it("returns URL as-is without jdbc: prefix", () => {
    expect(parseDatabaseUrl("postgresql://read:5432/mydb")).toBe("postgresql://read:5432/mydb");
  });

  it("strips jdbc: prefix", () => {
    expect(parseDatabaseUrl("jdbc:postgresql://read:5432/mydb")).toBe("postgresql://read:5432/mydb");
  });
});
