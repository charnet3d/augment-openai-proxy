import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import modelsRouter from "../routes/models";

// vi.hoisted ensures the variable is initialised before vi.mock's factory runs
const mockListModels = vi.hoisted(() => vi.fn());

vi.mock("../services/modelRegistry", () => ({
  listModels: mockListModels,
}));

const SAMPLE_RESPONSE = {
  object: "list" as const,
  data: [
    { id: "haiku4.5", object: "model" as const, created: 1_700_000_000, owned_by: "augment" },
    { id: "sonnet4.6", object: "model" as const, created: 1_700_000_000, owned_by: "augment" },
    { id: "opus4.7", object: "model" as const, created: 1_700_000_000, owned_by: "augment" },
  ],
};

describe("models route", () => {
  let app: Hono;

  beforeEach(() => {
    mockListModels.mockReset();
    mockListModels.mockResolvedValue(SAMPLE_RESPONSE);
    app = new Hono();
    app.route("/v1/models", modelsRouter);
  });

  describe("GET /v1/models", () => {
    it("should return OpenAI-compatible models list", async () => {
      const response = await app.fetch(new Request("http://localhost/v1/models"));
      expect(response.status).toBe(200);
      const body: any = await response.json();
      expect(body.object).toBe("list");
      expect(Array.isArray(body.data)).toBe(true);
    });

    it("should include all models with required OpenAI fields", async () => {
      const response = await app.fetch(new Request("http://localhost/v1/models"));
      const body: any = await response.json();
      expect(body.data.length).toBeGreaterThan(0);
      for (const model of body.data) {
        expect(model.object).toBe("model");
        expect(typeof model.id).toBe("string");
        expect(typeof model.created).toBe("number");
        expect(model.owned_by).toBe("augment");
      }
    });

    it("should include haiku4.5 from the registry", async () => {
      const response = await app.fetch(new Request("http://localhost/v1/models"));
      const body: any = await response.json();
      const model = body.data.find((m: { id: string }) => m.id === "haiku4.5");
      expect(model).toBeDefined();
      expect(model.owned_by).toBe("augment");
    });

    it("should return JSON content type", async () => {
      const response = await app.fetch(new Request("http://localhost/v1/models"));
      expect(response.headers.get("Content-Type")).toContain("application/json");
    });

    it("should reflect whatever the registry returns", async () => {
      const response = await app.fetch(new Request("http://localhost/v1/models"));
      const body: any = await response.json();
      expect(body.data.length).toBe(SAMPLE_RESPONSE.data.length);
    });
  });
});
