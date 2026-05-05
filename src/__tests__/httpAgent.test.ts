import { describe, it, expect, afterAll } from "vitest";
import { getGlobalDispatcher, setGlobalDispatcher } from "undici";
import {
  parseTimeoutMs,
  readTimeoutsFromEnv,
  installHttpAgent,
} from "../services/httpAgent";

describe("parseTimeoutMs", () => {
  it("returns the fallback when the env var is missing", () => {
    expect(parseTimeoutMs(undefined, 1234)).toBe(1234);
  });

  it("returns the fallback for an empty or whitespace-only string", () => {
    expect(parseTimeoutMs("", 9999)).toBe(9999);
    expect(parseTimeoutMs("   ", 9999)).toBe(9999);
  });

  it("parses a valid non-negative integer", () => {
    expect(parseTimeoutMs("60000", 0)).toBe(60000);
    expect(parseTimeoutMs("  1800000  ", 0)).toBe(1800000);
  });

  it("preserves 0 (which disables the timeout in undici)", () => {
    expect(parseTimeoutMs("0", 1234)).toBe(0);
  });

  it("returns the fallback for negative, fractional, or non-numeric input", () => {
    expect(parseTimeoutMs("-1", 1234)).toBe(1234);
    expect(parseTimeoutMs("1.5", 1234)).toBe(1234);
    expect(parseTimeoutMs("abc", 1234)).toBe(1234);
    expect(parseTimeoutMs("NaN", 1234)).toBe(1234);
  });
});

describe("readTimeoutsFromEnv", () => {
  it("returns generous defaults when no env vars are set", () => {
    const t = readTimeoutsFromEnv({});
    // Defaults must comfortably exceed undici's default 5-minute headers
    // timeout, otherwise long thinking calls keep failing.
    expect(t.headersTimeout).toBeGreaterThan(5 * 60 * 1000);
    expect(t.bodyTimeout).toBeGreaterThan(5 * 60 * 1000);
    // Connect timeout stays modest — TCP failures should surface fast.
    expect(t.connectTimeout).toBeGreaterThan(0);
    expect(t.connectTimeout).toBeLessThanOrEqual(60_000);
  });

  it("honours per-axis env overrides", () => {
    const t = readTimeoutsFromEnv({
      AUGMENT_HEADERS_TIMEOUT_MS: "60000",
      AUGMENT_BODY_TIMEOUT_MS: "120000",
      AUGMENT_CONNECT_TIMEOUT_MS: "5000",
    });
    expect(t).toEqual({
      headersTimeout: 60_000,
      bodyTimeout: 120_000,
      connectTimeout: 5_000,
    });
  });

  it("allows individual timeouts to be disabled with 0", () => {
    const t = readTimeoutsFromEnv({
      AUGMENT_HEADERS_TIMEOUT_MS: "0",
      AUGMENT_BODY_TIMEOUT_MS: "0",
    });
    expect(t.headersTimeout).toBe(0);
    expect(t.bodyTimeout).toBe(0);
  });
});


describe("installHttpAgent", () => {
  // Snapshot whatever dispatcher is currently global so we restore it after
  // mutating the process-wide state. Other tests may rely on the default.
  const original = getGlobalDispatcher();
  afterAll(() => {
    setGlobalDispatcher(original);
  });

  it("installs a new global undici dispatcher", () => {
    installHttpAgent({ headersTimeout: 1000, bodyTimeout: 2000, connectTimeout: 3000 });
    const after = getGlobalDispatcher();
    expect(after).toBeDefined();
    // The replacement must not be the dispatcher we captured before installing.
    expect(after).not.toBe(original);
  });

  it("uses the env-derived defaults when called with no args", () => {
    expect(() => installHttpAgent()).not.toThrow();
    expect(getGlobalDispatcher()).toBeDefined();
  });
});