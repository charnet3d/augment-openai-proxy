import { describe, it, expect } from "vitest";
import { listModels, isModelAvailable, AVAILABLE_MODELS } from "../services/modelRegistry";
import type { ModelsListResponse } from "../types/openai";

describe("modelRegistry", () => {
  describe("listModels", () => {
    it("should return OpenAI-compatible models list format", () => {
      const result = listModels();

      expect(result.object).toBe("list");
      expect(Array.isArray(result.data)).toBe(true);
    });

    it("should include all available models", () => {
      const result = listModels();

      expect(result.data.length).toBe(AVAILABLE_MODELS.length);
      for (const modelId of AVAILABLE_MODELS) {
        expect(result.data).toContainEqual(
          expect.objectContaining({ id: modelId })
        );
      }
    });

    it("should include required fields for each model", () => {
      const result = listModels();

      for (const model of result.data) {
        expect(model.object).toBe("model");
        expect(typeof model.id).toBe("string");
        expect(typeof model.created).toBe("number");
        expect(model.owned_by).toBe("augment");
      }
    });

    it("should set created timestamp to current time (within 2 seconds)", () => {
      const before = Math.floor(Date.now() / 1000) - 1;
      const result = listModels();
      const after = Math.floor(Date.now() / 1000) + 1;

      for (const model of result.data) {
        expect(model.created).toBeGreaterThanOrEqual(before);
        expect(model.created).toBeLessThanOrEqual(after);
      }
    });
  });

  describe("isModelAvailable", () => {
    it("should return true for known model IDs", () => {
      expect(isModelAvailable("claude-sonnet-4-5")).toBe(true);
      expect(isModelAvailable("claude-haiku-4-5")).toBe(true);
      expect(isModelAvailable("claude-opus-4-1")).toBe(true);
      expect(isModelAvailable("claude-sonnet-4-20250514")).toBe(true);
      expect(isModelAvailable("claude-haiku-4-20250514")).toBe(true);
      expect(isModelAvailable("claude-opus-4-20250514")).toBe(true);
    });

    it("should return false for unknown model IDs", () => {
      expect(isModelAvailable("gpt-4")).toBe(false);
      expect(isModelAvailable("unknown-model")).toBe(false);
      expect(isModelAvailable("claude-sonnet-4-6")).toBe(false);
    });

    it("should return false for empty string", () => {
      expect(isModelAvailable("")).toBe(false);
    });

    it("should be case-sensitive (exact match required)", () => {
      expect(isModelAvailable("Claude-Sonnet-4-5")).toBe(false);
      expect(isModelAvailable("CLAUDE-SONNET-4-5")).toBe(false);
    });
  });

  describe("AVAILABLE_MODELS export", () => {
    it("should re-export the config models array", () => {
      expect(Array.isArray(AVAILABLE_MODELS)).toBe(true);
      expect(AVAILABLE_MODELS.length).toBeGreaterThan(0);
      expect(AVAILABLE_MODELS[0]).toBe("claude-sonnet-4-5");
    });
  });
});
