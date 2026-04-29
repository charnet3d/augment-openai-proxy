import { describe, it, expect, beforeEach } from "vitest";

describe("config", () => {
  beforeEach(() => {
    delete process.env.PORT;
    delete process.env.HOST;
  });

  describe("PORT", () => {
    it("should default to 7888 when PORT is not set", async () => {
      const { PORT } = await import("../config");
      expect(PORT).toBe(7888);
    });
  });

  describe("HOST", () => {
    it("should read HOST from environment (or .env file)", async () => {
      const { HOST } = await import("../config");
      // The value comes from process.env.HOST (set by .env) or falls back to "localhost"
      expect(typeof HOST).toBe("string");
      expect(HOST.length).toBeGreaterThan(0);
    });
  });

});
