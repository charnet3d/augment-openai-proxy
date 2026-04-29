import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock node:child_process so tests never call the real auggie binary
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

// Short names as the CLI returns them; the registry must expand these before
// serving them to clients.
const SAMPLE_CLI_OUTPUT = JSON.stringify({
  registryAvailable: true,
  models: [
    { shortName: "haiku4.5", displayName: "Haiku 4.5" },
    { shortName: "sonnet4.6", displayName: "Sonnet 4.6" },
    { shortName: "opus4.7", displayName: "Opus 4.7" },
    { shortName: "gpt5.1", displayName: "GPT-5.1" },
    { shortName: "gemini-3.1-pro-preview", displayName: "Gemini 3.1 Pro Preview" },
    { shortName: "code-review", displayName: "Code Review" },
  ],
});

describe("modelRegistry", () => {
  let execFileMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    // Reset module cache so cachedModelIds is cleared between tests
    vi.resetModules();
    const cp = await import("node:child_process");
    execFileMock = cp.execFile as ReturnType<typeof vi.fn>;
    execFileMock.mockReset();
  });

  /** Makes execFile call its callback with stdout */
  function succeedWith(output: string) {
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: object, cb: Function) => cb(null, output)
    );
  }

  /** Makes execFile call its callback with an error */
  function failWith(err: Error) {
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: object, cb: Function) => cb(err, "")
    );
  }

  describe("listModels — CLI success", () => {
    it("should return expanded canonical IDs from CLI shortName fields", async () => {
      succeedWith(SAMPLE_CLI_OUTPUT);
      const { listModels } = await import("../services/modelRegistry");
      const result = await listModels();
      // Short names from CLI must be expanded to canonical backend names.
      expect(result.data.map((m) => m.id)).toEqual([
        "claude-haiku-4-5",
        "claude-sonnet-4-6",
        "claude-opus-4-7",
        "gpt-5-1",
        "gemini-3-1-pro-preview",
        "code-review",
      ]);
    });

    it("should return OpenAI list format with required fields", async () => {
      succeedWith(SAMPLE_CLI_OUTPUT);
      const { listModels } = await import("../services/modelRegistry");
      const result = await listModels();
      expect(result.object).toBe("list");
      for (const model of result.data) {
        expect(model.object).toBe("model");
        expect(typeof model.id).toBe("string");
        expect(typeof model.created).toBe("number");
        expect(model.owned_by).toBe("augment");
      }
    });

    it("should set created timestamp close to now", async () => {
      succeedWith(SAMPLE_CLI_OUTPUT);
      const { listModels } = await import("../services/modelRegistry");
      const before = Math.floor(Date.now() / 1000) - 1;
      const result = await listModels();
      const after = Math.floor(Date.now() / 1000) + 1;
      for (const model of result.data) {
        expect(model.created).toBeGreaterThanOrEqual(before);
        expect(model.created).toBeLessThanOrEqual(after);
      }
    });
  });

  describe("listModels — fallback", () => {
    it("should fall back to FALLBACK_MODEL_IDS when CLI fails", async () => {
      failWith(new Error("auggie: command not found"));
      const { listModels, FALLBACK_MODEL_IDS } = await import("../services/modelRegistry");
      const result = await listModels();
      expect(result.data.map((m) => m.id)).toEqual([...FALLBACK_MODEL_IDS]);
    });

    it("should fall back when CLI output is invalid JSON", async () => {
      succeedWith("not valid json at all");
      const { listModels, FALLBACK_MODEL_IDS } = await import("../services/modelRegistry");
      const result = await listModels();
      expect(result.data.map((m) => m.id)).toEqual([...FALLBACK_MODEL_IDS]);
    });

    it("should fall back when models array is empty", async () => {
      succeedWith(JSON.stringify({ registryAvailable: true, models: [] }));
      const { listModels, FALLBACK_MODEL_IDS } = await import("../services/modelRegistry");
      const result = await listModels();
      expect(result.data.map((m) => m.id)).toEqual([...FALLBACK_MODEL_IDS]);
    });

    it("should fall back when models field is missing", async () => {
      succeedWith(JSON.stringify({ registryAvailable: false }));
      const { listModels, FALLBACK_MODEL_IDS } = await import("../services/modelRegistry");
      const result = await listModels();
      expect(result.data.map((m) => m.id)).toEqual([...FALLBACK_MODEL_IDS]);
    });
  });

  describe("isModelAvailable", () => {
    it("should return true for expanded canonical names from CLI output", async () => {
      succeedWith(SAMPLE_CLI_OUTPUT);
      const { isModelAvailable } = await import("../services/modelRegistry");
      // These are the expanded names, not the raw short names
      expect(await isModelAvailable("claude-haiku-4-5")).toBe(true);
      expect(await isModelAvailable("claude-sonnet-4-6")).toBe(true);
      expect(await isModelAvailable("gpt-5-1")).toBe(true);
      expect(await isModelAvailable("gemini-3-1-pro-preview")).toBe(true);
      expect(await isModelAvailable("code-review")).toBe(true);
    });

    it("should return false for the raw CLI short names (they are not stored)", async () => {
      succeedWith(SAMPLE_CLI_OUTPUT);
      const { isModelAvailable } = await import("../services/modelRegistry");
      expect(await isModelAvailable("haiku4.5")).toBe(false);
      expect(await isModelAvailable("sonnet4.6")).toBe(false);
      expect(await isModelAvailable("gpt5.1")).toBe(false);
    });

    it("should return false for a model not in CLI output", async () => {
      succeedWith(SAMPLE_CLI_OUTPUT);
      const { isModelAvailable } = await import("../services/modelRegistry");
      expect(await isModelAvailable("gpt-4")).toBe(false);
      expect(await isModelAvailable("claude-sonnet-4-5")).toBe(false);
    });

    it("should return false for empty string", async () => {
      succeedWith(SAMPLE_CLI_OUTPUT);
      const { isModelAvailable } = await import("../services/modelRegistry");
      expect(await isModelAvailable("")).toBe(false);
    });

    it("should be case-sensitive", async () => {
      succeedWith(SAMPLE_CLI_OUTPUT);
      const { isModelAvailable } = await import("../services/modelRegistry");
      expect(await isModelAvailable("Claude-Haiku-4-5")).toBe(false);
      expect(await isModelAvailable("CLAUDE-HAIKU-4-5")).toBe(false);
    });

    it("should return true for canonical fallback model when CLI fails", async () => {
      failWith(new Error("not found"));
      const { isModelAvailable } = await import("../services/modelRegistry");
      expect(await isModelAvailable("claude-haiku-4-5")).toBe(true);
    });
  });

  describe("caching", () => {
    it("should call CLI only once and cache the result", async () => {
      succeedWith(SAMPLE_CLI_OUTPUT);
      const { getModelIds } = await import("../services/modelRegistry");
      await getModelIds();
      await getModelIds();
      await getModelIds();
      expect(execFileMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("FALLBACK_MODEL_IDS", () => {
    it("should be a non-empty array", async () => {
      const { FALLBACK_MODEL_IDS } = await import("../services/modelRegistry");
      expect(Array.isArray(FALLBACK_MODEL_IDS)).toBe(true);
      expect(FALLBACK_MODEL_IDS.length).toBeGreaterThan(0);
    });

    it("should contain only canonical (expanded) model names — no dots, no bare short names", async () => {
      const { FALLBACK_MODEL_IDS } = await import("../services/modelRegistry");
      expect(FALLBACK_MODEL_IDS).toContain("claude-haiku-4-5");
      expect(FALLBACK_MODEL_IDS).toContain("claude-sonnet-4-6");
      expect(FALLBACK_MODEL_IDS).toContain("claude-opus-4-7");
      // Must not contain raw short names with dots
      for (const id of FALLBACK_MODEL_IDS) {
        expect(id).not.toMatch(/\./);
      }
    });
  });
});

// ── expandShortName unit tests (pure function, no mocking needed) ──────────
import { expandShortName } from "../services/modelRegistry";

describe("expandShortName", () => {
  it.each([
    // Claude models
    ["haiku4.5",  "claude-haiku-4-5"],
    ["sonnet4",   "claude-sonnet-4"],
    ["sonnet4.5", "claude-sonnet-4-5"],
    ["sonnet4.6", "claude-sonnet-4-6"],
    ["opus4.5",   "claude-opus-4-5"],
    ["opus4.6",   "claude-opus-4-6"],
    ["opus4.7",   "claude-opus-4-7"],
    // GPT models
    ["gpt5",      "gpt-5"],
    ["gpt5.1",    "gpt-5-1"],
    ["gpt5.2",    "gpt-5-2"],
    ["gpt5.4",    "gpt-5-4"],
    // Gemini — dots become dashes, prefix unchanged
    ["gemini-3.1-pro-preview", "gemini-3-1-pro-preview"],
    // Pass-through (already canonical, no dots)
    ["code-review",           "code-review"],
    ["claude-haiku-4-5",      "claude-haiku-4-5"],
  ])("expandShortName(%s) === %s", (input, expected) => {
    expect(expandShortName(input)).toBe(expected);
  });
});
