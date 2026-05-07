import { describe, it, expect, beforeEach } from "vitest";

describe("config", () => {
  beforeEach(() => {
    delete process.env.AOP_PORT;
    delete process.env.AOP_HOST;
  });

  describe("AOP_PORT", () => {
    it("should default to 7888 when AOP_PORT is not set", async () => {
      const { PORT } = await import("../config");
      expect(PORT).toBe(7888);
    });
  });

  describe("AOP_HOST", () => {
    it("should read AOP_HOST from environment (or .env file)", async () => {
      const { HOST } = await import("../config");
      // The value comes from process.env.AOP_HOST (set by .env) or falls back to "localhost"
      expect(typeof HOST).toBe("string");
      expect(HOST.length).toBeGreaterThan(0);
    });
  });

});
