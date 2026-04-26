import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import modelsRouter from "../routes/models";

describe("models route", () => {
  let app: Hono;

  beforeEach(() => {
    app = new Hono();
    app.route("/v1/models", modelsRouter);
  });

  describe("GET /v1/models", () => {
    it("should return OpenAI-compatible models list", async () => {
      const req = new Request("http://localhost/v1/models");
      const response = await app.fetch(req);

      expect(response.status).toBe(200);

      const body: any = await response.json();
      expect(body.object).toBe("list");
      expect(Array.isArray(body.data)).toBe(true);
    });

    it("should include all available models", async () => {
      const req = new Request("http://localhost/v1/models");
      const response = await app.fetch(req);
      const body: any = await response.json();

      expect(body.data.length).toBeGreaterThan(0);

      // Check that all models have required fields
      for (const model of body.data) {
        expect(model.object).toBe("model");
        expect(typeof model.id).toBe("string");
        expect(typeof model.created).toBe("number");
        expect(model.owned_by).toBe("augment");
      }
    });

    it("should include claude-sonnet-4-5 model", async () => {
      const req = new Request("http://localhost/v1/models");
      const response = await app.fetch(req);
      const body: any = await response.json();

      const sonnet = body.data.find((m: { id: string }) => m.id === "claude-sonnet-4-5");
      expect(sonnet).toBeDefined();
      expect(sonnet.owned_by).toBe("augment");
    });

    it("should return JSON content type", async () => {
      const req = new Request("http://localhost/v1/models");
      const response = await app.fetch(req);

      expect(response.headers.get("Content-Type")).toContain("application/json");
    });

    it("should have consistent model count with AVAILABLE_MODELS", async () => {
      const { AVAILABLE_MODELS } = await import("../services/modelRegistry");
      const req = new Request("http://localhost/v1/models");
      const response = await app.fetch(req);
      const body: any = await response.json();

      expect(body.data.length).toBe(AVAILABLE_MODELS.length);
    });
  });
});
