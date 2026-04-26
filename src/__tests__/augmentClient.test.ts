import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock the SDK at the module level ──────────────────────────
const mockResolveCredentials = vi.fn();

// Track constructor calls for AugmentLanguageModel
const constructorCalls: Array<[string, object]> = [];

// Use a class-based mock so it works with `new AugmentLanguageModel(...)`
class MockAugmentLanguageModel {
  constructor(modelId: string, options: object) {
    constructorCalls.push([modelId, options]);
  }
  doGenerate = vi.fn();
  doStream = vi.fn();
}

vi.mock("@augmentcode/auggie-sdk", () => ({
  resolveAugmentCredentials: () => mockResolveCredentials(),
  AugmentLanguageModel: MockAugmentLanguageModel,
}));

describe("augmentClient", () => {
  let resolveModelId: (id: string) => string;
  let validateCredentials: () => Promise<boolean>;
  let getAugmentModel: (id: string) => Promise<any>;

  beforeEach(async () => {
    vi.clearAllMocks();
    constructorCalls.length = 0;

    // Clear module cache to get fresh imports with fresh cachedCredentials
    vi.resetModules();

    // Reset the mock before each test
    mockResolveCredentials.mockReset();

    // Re-import after clearing modules
    const augmentClient = await import("../services/augmentClient");
    resolveModelId = augmentClient.resolveModelId;
    validateCredentials = augmentClient.validateCredentials;
    getAugmentModel = augmentClient.getAugmentModel;
  });

  describe("resolveModelId", () => {
    it("should normalize model ID to lowercase and trim whitespace", () => {
      expect(resolveModelId("  CLAUDE-SONNET-4-5  ")).toBe("claude-sonnet-4-5");
    });

    it("should return exact known model ID when matched case-insensitively", () => {
      expect(resolveModelId("Claude-Sonnet-4-5")).toBe("claude-sonnet-4-5");
    });

    it("should return original model ID for unknown models (passthrough)", () => {
      expect(resolveModelId("unknown-model")).toBe("unknown-model");
    });

    it("should handle empty string", () => {
      expect(resolveModelId("")).toBe("");
    });

    it("should preserve original casing for passthrough models", () => {
      expect(resolveModelId("My-Custom-Model")).toBe("My-Custom-Model");
    });
  });

  describe("validateCredentials", () => {
    it("should return true when credentials resolve successfully", async () => {
      mockResolveCredentials.mockResolvedValue({
        apiKey: "test-key",
        apiUrl: "https://api.test.com",
      });

      const result = await validateCredentials();

      expect(result).toBe(true);
      expect(mockResolveCredentials).toHaveBeenCalledTimes(1);
    });

    it("should return false when credentials resolution fails", async () => {
      mockResolveCredentials.mockRejectedValue(
        new Error("No credentials found")
      );

      const result = await validateCredentials();

      expect(result).toBe(false);
    });

    it("should handle any error type gracefully", async () => {
      mockResolveCredentials.mockRejectedValue("string error");

      const result = await validateCredentials();

      expect(result).toBe(false);
    });
  });

  describe("getAugmentModel", () => {
    it("should create a model with resolved credentials", async () => {
      mockResolveCredentials.mockResolvedValue({
        apiKey: "test-key",
        apiUrl: "https://api.test.com",
      });

      await getAugmentModel("claude-sonnet-4-5");

      expect(constructorCalls.length).toBe(1);
      expect(constructorCalls[0][0]).toBe("claude-sonnet-4-5");
      expect(constructorCalls[0][1]).toMatchObject({
        apiKey: "test-key",
        apiUrl: "https://api.test.com",
        clientUserAgent: "augment-oai-proxy/1.0.0",
      });
    });

    it("should normalize model ID before creating model", async () => {
      mockResolveCredentials.mockResolvedValue({
        apiKey: "test-key",
        apiUrl: "https://api.test.com",
      });

      await getAugmentModel("  CLAUDE-SONNET-4-5  ");

      expect(constructorCalls[0][0]).toBe("claude-sonnet-4-5");
    });

    it("should cache credentials and not re-resolve on subsequent calls", async () => {
      mockResolveCredentials.mockResolvedValue({
        apiKey: "test-key",
        apiUrl: "https://api.test.com",
      });

      await getAugmentModel("claude-sonnet-4-5");
      await getAugmentModel("claude-haiku-4-5");

      // Should only be called once (cached)
      expect(mockResolveCredentials).toHaveBeenCalledTimes(1);
    });

    it("should throw when credentials resolution fails", async () => {
      mockResolveCredentials.mockRejectedValue(
        new Error("Credentials not found")
      );

      await expect(getAugmentModel("claude-sonnet-4-5")).rejects.toThrow(
        "Credentials not found"
      );
    });

    it("should set debug to false by default", async () => {
      mockResolveCredentials.mockResolvedValue({
        apiKey: "test-key",
        apiUrl: "https://api.test.com",
      });

      await getAugmentModel("claude-sonnet-4-5");

      expect(constructorCalls[0][1]).toMatchObject({ debug: false });
    });

    it("should set debug to true when DEBUG env is 'true'", async () => {
      process.env.DEBUG = "true";
      mockResolveCredentials.mockResolvedValue({
        apiKey: "test-key",
        apiUrl: "https://api.test.com",
      });

      // Need fresh import to pick up env change
      vi.resetModules();
      constructorCalls.length = 0;
      const { getAugmentModel: getAugmentModelFresh } = await import("../services/augmentClient");
      await getAugmentModelFresh("claude-sonnet-4-5");

      expect(constructorCalls[0][1]).toMatchObject({ debug: true });

      delete process.env.DEBUG;
    });
  });
});
