import { describe, it, expect, vi, beforeEach } from "vitest";

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
    it('should default to "localhost" when HOST is not set', async () => {
      const { HOST } = await import("../config");
      expect(HOST).toBe("localhost");
    });
  });

  describe("AVAILABLE_MODELS", () => {
    it("should contain expected model IDs", async () => {
      const { AVAILABLE_MODELS } = await import("../config");
      expect(AVAILABLE_MODELS).toContain("claude-sonnet-4-5");
      expect(AVAILABLE_MODELS).toContain("claude-haiku-4-5");
      expect(AVAILABLE_MODELS).toContain("claude-opus-4-1");
      expect(AVAILABLE_MODELS).toContain("claude-sonnet-4-20250514");
      expect(AVAILABLE_MODELS).toContain("claude-haiku-4-20250514");
      expect(AVAILABLE_MODELS).toContain("claude-opus-4-20250514");
    });

    it("should be a non-empty array", async () => {
      const { AVAILABLE_MODELS } = await import("../config");
      expect(AVAILABLE_MODELS.length).toBeGreaterThan(0);
    });

    it("should have exactly 6 models", async () => {
      const { AVAILABLE_MODELS } = await import("../config");
      expect(AVAILABLE_MODELS.length).toBe(6);
    });
  });
});
