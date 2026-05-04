/**
 * End-to-end tests against the real Augment API.
 *
 * These tests load credentials from .env and make actual calls to the
 * Augment backend — no mocks anywhere in this file.
 *
 * They are skipped automatically when no credentials are detected so that
 * CI environments without secrets stay green.
 *
 * Run locally after `auggie login` or with a populated .env file:
 *   AUGMENT_API_KEY=… AUGMENT_API_URL=… npm test
 *   — or —
 *   npm test  (picks up .env automatically)
 */

// Load .env before any module-level credential check.
// config.ts calls dotenv internally, but that happens after static imports
// are resolved. Importing it first guarantees .env is parsed before we
// inspect process.env below.
import "../config";

import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { expandShortName, expandModelEntry, getEffortDisabledBaseIds } from "../services/modelRegistry";

const execFileAsync = promisify(execFile);

// ── Credential detection ──────────────────────────────────────────────────────
// Accept either an API key pair (env) or a session written by `auggie login`.
const hasEnvCredentials =
  !!(process.env.AUGMENT_API_KEY && process.env.AUGMENT_API_URL);
const hasSessionFile = existsSync(
  join(homedir(), ".augment", "session.json")
);
const credentialsAvailable = hasEnvCredentials || hasSessionFile;

// ── CLI availability ──────────────────────────────────────────────────────────
// Use shell:true so the OS can find .cmd wrappers installed by npm on Windows.
// spawnSync is synchronous, which lets us decide at module load time whether
// to skip CLI-dependent tests — no async ceremony required.
const cliProbe = spawnSync("auggie", ["--help"], {
  timeout: 5_000,
  shell: true,
  stdio: "ignore",
});
const cliAvailable = !cliProbe.error && cliProbe.status === 0;

// ── CLI helper ────────────────────────────────────────────────────────────────
interface CliResult {
  ok: boolean;
  stdout: string;
  error?: string;
}

async function runAuggieCli(): Promise<CliResult> {
  try {
    const { stdout } = await execFileAsync(
      "auggie",
      ["models", "list", "--json"],
      // shell:true is required on Windows for npm-installed .cmd binaries.
      { timeout: 15_000, shell: true }
    );
    return { ok: true, stdout };
  } catch (err) {
    return { ok: false, stdout: "", error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Suite ─────────────────────────────────────────────────────────────────────
// The whole suite is skipped when credentials are absent.
const describeE2E = credentialsAvailable ? describe : describe.skip;

describeE2E("e2e — real Augment API", () => {
  let app: Hono;
  // Populated in beforeAll with the first model the registry actually returns.
  // This avoids hardcoding a model ID that may not exist on the user's account.
  let testModelId = "claude-sonnet-4-5";

  beforeAll(async () => {
    // Import the real routes — no vi.mock in this file, so the real SDK is used.
    const { default: chatRouter } = await import("../routes/chat");
    const { default: modelsRouter } = await import("../routes/models");

    app = new Hono();
    app.route("/v1/chat", chatRouter);
    app.route("/v1/models", modelsRouter);

    // Discover a real model to use for the chat tests below.
    const res = await app.fetch(new Request("http://localhost/v1/models"));
    if (res.ok) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body: any = await res.json();
      const first = body.data?.[0];
      if (first?.id) testModelId = first.id as string;
    }
  }, 20_000);

  // ── auggie CLI smoke-test ─────────────────────────────────────────────────
  // Skipped automatically when `auggie` is not resolvable in the system PATH.
  describe.skipIf(!cliAvailable)("auggie models list --json", () => {
    it("exits successfully and returns a non-empty model array", async () => {
      const result = await runAuggieCli();

      expect(result.ok, `auggie CLI failed: ${result.error}`).toBe(true);

      const data = JSON.parse(result.stdout.trim()) as {
        registryAvailable?: boolean;
        models?: Array<{ shortName?: string }>;
      };

      const models = data.models ?? [];
      expect(Array.isArray(data.models), "response has no models array").toBe(true);
      expect(models.length, "model list is empty").toBeGreaterThan(0);

      for (const m of models) {
        expect(typeof m.shortName).toBe("string");
        expect((m.shortName ?? "").length).toBeGreaterThan(0);
      }
    }, 20_000);
  });

  // ── GET /v1/models ────────────────────────────────────────────────────────
  describe("GET /v1/models", () => {
    // Requires auggie CLI so we can compare the API output against the ground truth.
    it.skipIf(!cliAvailable)("returns the real CLI model list — not the hardcoded fallback", async () => {
      // 1. Run auggie independently to capture the ground truth.
      const cliResult = await runAuggieCli();
      expect(cliResult.ok, `auggie CLI failed: ${cliResult.error}`).toBe(true);

      const cliData = JSON.parse(cliResult.stdout.trim()) as {
        models?: Array<{ shortName?: string; effortLevels?: unknown }>;
      };
      // Mirror the registry's fetchModelEntries logic exactly: expand short
      // names, parse effortLevels, honour AUGMENT_DISABLE_EFFORT_MODELS, then
      // flatten base + suffixed variants so both sides are comparable.
      const disabled = getEffortDisabledBaseIds();
      const cliIds = (cliData.models ?? [])
        .filter((m): m is { shortName: string; effortLevels?: unknown } =>
          typeof m.shortName === "string" && m.shortName.length > 0
        )
        .flatMap((m) => {
          const baseId = expandShortName(m.shortName);
          const advertised = Array.isArray(m.effortLevels)
            ? m.effortLevels
                .filter((l): l is string => typeof l === "string" && l.length > 0)
                .map((l) => l.toLowerCase())
            : [];
          const effortLevels = disabled.has(baseId) ? [] : advertised;
          return expandModelEntry({ baseId, effortLevels });
        })
        .sort((a, b) => a.localeCompare(b));

      // 2. Fetch via the proxy.
      const response = await app.fetch(new Request("http://localhost/v1/models"));
      expect(response.status).toBe(200);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body: any = await response.json();
      const apiIds: string[] = (body.data as { id: string }[])
        .map((m) => m.id)
        .sort((a, b) => a.localeCompare(b));

      // 3. The proxy must serve exactly what the CLI reported.
      //    A mismatch here means the registry fell back to the hardcoded list.
      expect(apiIds).toEqual(cliIds);
    }, 20_000);

    it("formats every entry as an OpenAI model object", async () => {
      const response = await app.fetch(new Request("http://localhost/v1/models"));
      expect(response.status).toBe(200);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body: any = await response.json();
      expect(body.object).toBe("list");
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.length).toBeGreaterThan(0);

      for (const model of body.data) {
        expect(typeof model.id).toBe("string");
        expect(model.id.length).toBeGreaterThan(0);
        expect(model.object).toBe("model");
        expect(typeof model.created).toBe("number");
        expect(model.created).toBeGreaterThan(0);
        expect(model.owned_by).toBe("augment");
      }
    }, 20_000);
  });

  // ── POST /v1/chat/completions (non-streaming) ─────────────────────────────
  describe("POST /v1/chat/completions (non-streaming)", () => {
    it("returns a real assistant reply with a correct OpenAI response shape", async () => {
      const response = await app.fetch(
        new Request("http://localhost/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: testModelId,
            messages: [
              {
                role: "user",
                content: 'Reply with exactly the word "pong" and nothing else.',
              },
            ],
          }),
        })
      );

      expect(response.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body: any = await response.json();

      // Envelope
      expect(body.id).toMatch(/^chatcmpl-/);
      expect(body.object).toBe("chat.completion");
      expect(body.model).toBe(testModelId);
      expect(typeof body.created).toBe("number");
      expect(body.system_fingerprint).toBe("augment_open_proxy");

      // Assistant message
      expect(body.choices).toHaveLength(1);
      const choice = body.choices[0];
      expect(choice.index).toBe(0);
      expect(choice.message.role).toBe("assistant");
      expect(typeof choice.message.content).toBe("string");
      expect((choice.message.content as string).toLowerCase()).toContain("pong");
      expect(choice.finish_reason).toBe("stop");

      // Token usage — must be real non-zero numbers
      expect(body.usage.prompt_tokens).toBeGreaterThan(0);
      expect(body.usage.completion_tokens).toBeGreaterThan(0);
      expect(body.usage.total_tokens).toBe(
        body.usage.prompt_tokens + body.usage.completion_tokens
      );
    }, 30_000);
  });

  // ── Shared tool definition used by the tool-calling tests ───────────────────
  // tool_choice:"required" guarantees the model will call the tool, making the
  // test deterministic regardless of model version.
  const weatherTool = {
    type: "function" as const,
    function: {
      name: "get_current_weather",
      description: "Get the current weather for a city.",
      parameters: {
        type: "object",
        properties: {
          city: { type: "string", description: "The city name, e.g. Paris" },
        },
        required: ["city"],
      },
    },
  };

  // ── POST /v1/chat/completions (tool calling, non-streaming) ──────────────
  describe("POST /v1/chat/completions (tool calling, non-streaming)", () => {
    it("returns a tool_calls response with the correct OpenAI shape", async () => {
      const response = await app.fetch(
        new Request("http://localhost/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: testModelId,
            messages: [{ role: "user", content: "What is the weather in Paris?" }],
            tools: [weatherTool],
            tool_choice: "required",
          }),
        })
      );

      expect(response.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body: any = await response.json();

      // Standard envelope
      expect(body.id).toMatch(/^chatcmpl-/);
      expect(body.object).toBe("chat.completion");
      expect(body.model).toBe(testModelId);
      expect(typeof body.created).toBe("number");

      // The model was forced to call a tool
      expect(body.choices).toHaveLength(1);
      const choice = body.choices[0];
      expect(choice.finish_reason).toBe("tool_calls");
      expect(Array.isArray(choice.message.tool_calls)).toBe(true);
      expect(choice.message.tool_calls.length).toBeGreaterThan(0);

      // Tool call shape
      const tc = choice.message.tool_calls[0];
      expect(typeof tc.id).toBe("string");
      expect(tc.id.length).toBeGreaterThan(0);
      expect(tc.type).toBe("function");
      expect(tc.function.name).toBe("get_current_weather");

      // Arguments must be a valid JSON object with the city field
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const args: any = JSON.parse(tc.function.arguments);
      expect(typeof args.city).toBe("string");
      expect(args.city.length).toBeGreaterThan(0);
    }, 30_000);
  });

  // ── POST /v1/chat/completions (streaming) ─────────────────────────────────
  describe("POST /v1/chat/completions (streaming)", () => {
    it("delivers a real SSE stream whose deltas reconstruct a valid reply", async () => {
      const response = await app.fetch(
        new Request("http://localhost/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: testModelId,
            messages: [
              {
                role: "user",
                content: 'Reply with exactly the word "pong" and nothing else.',
              },
            ],
            stream: true,
          }),
        })
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/event-stream");

      // Drain the full SSE stream.
      const bodyStream = response.body;
      if (!bodyStream) throw new Error("Response body is null");
      const reader = bodyStream.getReader();
      const decoder = new TextDecoder();
      let rawSse = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        rawSse += decoder.decode(value, { stream: true });
      }

      // Parse events (split on SSE double-newline, strip blanks).
      const events = rawSse
        .split("\n\n")
        .map((e) => e.trim())
        .filter(Boolean);

      // Stream must terminate with [DONE].
      expect(events.at(-1)).toBe("data: [DONE]");

      // Parse every data event except [DONE].
      const chunks = events.slice(0, -1).map((e) => {
        expect(e.startsWith("data: ")).toBe(true);
        return JSON.parse(e.slice("data: ".length));
      });

      // Every chunk carries the standard streaming envelope.
      for (const chunk of chunks) {
        expect(chunk.id).toMatch(/^chatcmpl-/);
        expect(chunk.object).toBe("chat.completion.chunk");
        expect(chunk.model).toBe(testModelId);
        expect(Array.isArray(chunk.choices)).toBe(true);
      }

      // First chunk establishes the assistant role.
      expect(chunks[0].choices[0].delta).toMatchObject({ role: "assistant" });

      // Reconstruct the full reply from content deltas (skip the role chunk).
      const reconstructed = chunks
        .slice(1)
        .map((c: any) => c.choices[0].delta.content ?? "")
        .join("");

      expect(reconstructed.length).toBeGreaterThan(0);
      expect(reconstructed.toLowerCase()).toContain("pong");
    }, 30_000);
  });

  // ── POST /v1/chat/completions (multi-turn) ───────────────────────────────
  describe("POST /v1/chat/completions (multi-turn)", () => {
    it("retains context across two sequential requests", async () => {
      // Turn 1: establish a fact.
      const res1 = await app.fetch(
        new Request("http://localhost/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: testModelId,
            messages: [{ role: "user", content: "What is 2+2? Reply with the number only." }],
          }),
        })
      );
      expect(res1.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body1: any = await res1.json();
      const assistantReply: string = body1.choices[0].message.content;
      expect(assistantReply.trim()).toContain("4");

      // Turn 2: follow up — the model must know the prior answer.
      const res2 = await app.fetch(
        new Request("http://localhost/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: testModelId,
            messages: [
              { role: "user", content: "What is 2+2? Reply with the number only." },
              { role: "assistant", content: assistantReply },
              { role: "user", content: "Multiply that by 3. Reply with the number only." },
            ],
          }),
        })
      );
      expect(res2.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body2: any = await res2.json();
      const followUp: string = body2.choices[0].message.content;
      // 4 × 3 = 12
      expect(followUp).toContain("12");

      // Standard response shape checks.
      expect(body2.id).toMatch(/^chatcmpl-/);
      expect(body2.object).toBe("chat.completion");
      expect(body2.choices[0].finish_reason).toBe("stop");
      expect(body2.usage.prompt_tokens).toBeGreaterThan(0);
    }, 60_000);
  });

  // ── POST /v1/chat/completions (tool calling, streaming) ──────────────────
  describe("POST /v1/chat/completions (tool calling, streaming)", () => {
    it("streams tool call chunks with the correct OpenAI SSE shape", async () => {
      const response = await app.fetch(
        new Request("http://localhost/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: testModelId,
            messages: [{ role: "user", content: "What is the weather in Paris?" }],
            tools: [weatherTool],
            tool_choice: "required",
            stream: true,
          }),
        })
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/event-stream");

      // Drain the SSE stream.
      const bodyStream = response.body;
      if (!bodyStream) throw new Error("Response body is null");
      const reader = bodyStream.getReader();
      const decoder = new TextDecoder();
      let rawSse = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        rawSse += decoder.decode(value, { stream: true });
      }

      // Parse events (split on SSE double-newline, strip blanks).
      const events = rawSse
        .split("\n\n")
        .map((e) => e.trim())
        .filter(Boolean);

      // Stream must terminate with [DONE].
      expect(events.at(-1)).toBe("data: [DONE]");

      // Parse all data events except [DONE].
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chunks: any[] = events.slice(0, -1).map((e) => {
        expect(e.startsWith("data: ")).toBe(true);
        return JSON.parse(e.slice("data: ".length));
      });

      // All chunks carry the standard streaming envelope.
      for (const chunk of chunks) {
        expect(chunk.id).toMatch(/^chatcmpl-/);
        expect(chunk.object).toBe("chat.completion.chunk");
        expect(chunk.model).toBe(testModelId);
        expect(Array.isArray(chunk.choices)).toBe(true);
      }

      // First chunk establishes the assistant role.
      expect(chunks[0].choices[0].delta).toMatchObject({ role: "assistant" });

      // Collect chunks that carry tool_calls deltas (skip the role chunk).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const toolChunks = chunks.slice(1).filter((c: any) => c.choices[0].delta.tool_calls?.length > 0);
      expect(toolChunks.length).toBeGreaterThan(0);

      // The first tool_calls chunk must introduce the tool call: id, type, name.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const firstTc = toolChunks[0].choices[0].delta.tool_calls[0];
      expect(typeof firstTc.id).toBe("string");
      expect(firstTc.id.length).toBeGreaterThan(0);
      expect(firstTc.type).toBe("function");
      expect(firstTc.function.name).toBe("get_current_weather");

      // Reconstruct the full arguments string by concatenating all argument deltas.
      const allArgs = toolChunks
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .flatMap((c: any) => c.choices[0].delta.tool_calls as any[])
        .map((tc) => tc.function?.arguments ?? "")
        .join("");

      // Must be valid JSON containing a city field.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const args: any = JSON.parse(allArgs);
      expect(typeof args.city).toBe("string");
      expect(args.city.length).toBeGreaterThan(0);

      // The final chunk (before [DONE]) must signal tool_calls completion.
      expect(chunks.at(-1).choices[0].finish_reason).toBe("tool_calls");
    }, 30_000);
  });

  // ── POST /v1/chat/completions (image input — experimental) ──────────────
  // Mirrors the OpenWebUI request shape that originally surfaced the image
  // drop-through bug: a user message with mixed text + image_url parts where
  // the URL is a base64 data URL. Exercises the runtime SDK patch end-to-end.
  describe("POST /v1/chat/completions (image input)", () => {
    let visionModelId = "";

    beforeAll(async () => {
      const res = await app.fetch(new Request("http://localhost/v1/models"));
      if (res.ok) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const body: any = await res.json();
        const ids: string[] = (body.data ?? []).map((m: { id: string }) => m.id);
        // Prefer Claude — universally vision-capable on Augment — then fall
        // back to GPT/Gemini, then to whatever the discovery picked.
        visionModelId =
          ids.find((id) => id.startsWith("claude-sonnet")) ??
          ids.find((id) => id.startsWith("claude-haiku")) ??
          ids.find((id) => id.startsWith("claude")) ??
          ids.find((id) => id.startsWith("gpt-")) ??
          ids.find((id) => id.startsWith("gemini")) ??
          testModelId;
      } else {
        visionModelId = testModelId;
      }
    }, 20_000);

    // Tiny 66×75 PNG captured from a real OpenWebUI request body.
    const PNG_DATA_URL =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEIAAABLCAYAAADEW1EgAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAHMSURBVHhe7ZphasMwDEZ7jcLon+wE7f1PNEaP0GFwIDzs2HHMYlnfA/2SZKxndWx0t5sQQgghhBiXn8fy+v36/pQi1LF3GmolTC+EQ9bGVDK4DbnhWFfTY4qjA+WEsM4UHIr5HOyrlTgkHKZlkClkcAjma6DM1nMuhQO0vihltJxxGbz82RftccYl8OJnX5NiW8/5dyigx+V5HvNDwkv3kMGtYH5IKIDRKsScCL5eKthTw9n+y8gJcbMRWyiB+SP0OucSuBWt2xAwLSLArWiVYV4Et6JVhnkRgZQM1pQ40zsUlPF+LM9UPrct04gIUMZ28NKgpbw53vflSRkM9gRKeZOkNqM0aClvmj0h/FkxtYjAnoxc8IxpOCqD/VPBYXPBj8x0uHnxEhIRkYiIREQkIiIREYmIuBRR+k2S9dNREuBCRK2EqUWkJPBvBoqo6TFF7UAUwZ5S//BwCOZXWJMSyDAjhMPsXXytTdXwHEaqZyh4YeaPsieEtUOxvXjPV6OQnmcPwd7Hww18ZeZdQAluRVCCy48Gt8GlhAC3gXkX8AvhsA0uNyQ1MDfEhYx1I7b/NMKNcCMjR0qIZEhGWgZr3LCV4XYjhBBCiHH5Azu2MNsH4SA7AAAAAElFTkSuQmCC";

    it("accepts an OpenAI-style image_url part and returns a response that acknowledges the image", async () => {
      const response = await app.fetch(
        new Request("http://localhost/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: visionModelId,
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: "what can you see ?" },
                  { type: "image_url", image_url: { url: PNG_DATA_URL } },
                ],
              },
            ],
          }),
        })
      );

      expect(response.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body: any = await response.json();

      // Standard OpenAI envelope.
      expect(body.id).toMatch(/^chatcmpl-/);
      expect(body.object).toBe("chat.completion");
      expect(body.model).toBe(visionModelId);
      expect(body.choices).toHaveLength(1);

      const choice = body.choices[0];
      expect(choice.message.role).toBe("assistant");
      expect(typeof choice.message.content).toBe("string");
      expect((choice.message.content as string).length).toBeGreaterThan(0);
      expect(choice.finish_reason).toBe("stop");

      // The original bug: the SDK silently dropped the image and the model
      // replied with "no image was attached". Assert the reply does *not*
      // claim the image is missing — that's the regression guard.
      const reply = (choice.message.content as string).toLowerCase();
      const droppedImagePhrases = [
        "no image",
        "wasn't attached",
        "wasn't provided",
        "was not attached",
        "was not provided",
        "didn't receive",
        "did not receive",
        "no attachment",
        "i can't see",
        "i cannot see",
        "i don't see",
        "i do not see",
        "unable to see",
      ];
      for (const phrase of droppedImagePhrases) {
        expect(
          reply,
          `model replied as if no image was attached: ${reply}`,
        ).not.toContain(phrase);
      }

      // Usage shape stays consistent.
      expect(body.usage).toBeDefined();
      expect(typeof body.usage.prompt_tokens).toBe("number");
      expect(typeof body.usage.completion_tokens).toBe("number");
      expect(body.usage.total_tokens).toBe(
        body.usage.prompt_tokens + body.usage.completion_tokens
      );
    }, 60_000);
  });

  // ── POST /v1/chat/completions (reasoning) ────────────────────────────────
  // The Augment SDK does not currently forward `reasoningEffort` upstream,
  // so the test does not assert that reasoning content *must* be returned.
  // It does assert that:
  //   1. Supplying reasoning params (top-level + nested) does not break the
  //      request — response shape stays OpenAI-compatible.
  //   2. When the upstream *does* emit reasoning (THINKING nodes), the
  //      proxy surfaces it as `reasoning_content` (DeepSeek/OpenRouter
  //      convention; what Open WebUI / aider / cline / litellm consume).
  // Prefer a reasoning-capable model when one is in the registry (gpt-5*).
  describe("POST /v1/chat/completions (reasoning)", () => {
    let reasoningModelId = "";

    beforeAll(async () => {
      const res = await app.fetch(new Request("http://localhost/v1/models"));
      if (res.ok) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const body: any = await res.json();
        const ids: string[] = (body.data ?? []).map((m: { id: string }) => m.id);
        reasoningModelId =
          ids.find((id) => id.startsWith("gpt-5")) ??
          ids.find((id) => /thinking|reasoning/.test(id)) ??
          testModelId;
      } else {
        reasoningModelId = testModelId;
      }
    }, 20_000);

    it("accepts reasoning_effort and returns a valid OpenAI response (non-streaming)", async () => {
      const response = await app.fetch(
        new Request("http://localhost/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: reasoningModelId,
            messages: [
              {
                role: "user",
                content:
                  "Think step by step. How many distinct prime factors does 30 have? Reply with only the digit.",
              },
            ],
            reasoning_effort: "high",
          }),
        })
      );

      expect(response.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body: any = await response.json();

      // Envelope stays valid even with reasoning_effort present.
      expect(body.id).toMatch(/^chatcmpl-/);
      expect(body.object).toBe("chat.completion");
      expect(body.model).toBe(reasoningModelId);
      expect(body.choices).toHaveLength(1);
      expect(body.choices[0].message.role).toBe("assistant");
      expect(typeof body.choices[0].message.content).toBe("string");
      expect((body.choices[0].message.content as string).length).toBeGreaterThan(0);
      expect(body.choices[0].finish_reason).toBe("stop");
      // Usage shape must stay consistent. Some reasoning-capable backends do
      // not report per-call token counts, so we only assert internal
      // consistency rather than a positive prompt_tokens value.
      expect(body.usage).toBeDefined();
      expect(typeof body.usage.prompt_tokens).toBe("number");
      expect(typeof body.usage.completion_tokens).toBe("number");
      expect(body.usage.total_tokens).toBe(
        body.usage.prompt_tokens + body.usage.completion_tokens
      );

      // If the upstream surfaced reasoning, it must be a non-empty string
      // under `reasoning_content` (DeepSeek/OpenRouter convention).
      const reasoning = body.choices[0].message.reasoning_content;
      if (reasoning !== undefined) {
        expect(typeof reasoning).toBe("string");
        expect(reasoning.length).toBeGreaterThan(0);
      }
    }, 60_000);

    it("accepts reasoning {effort, summary} and emits valid streaming chunks", async () => {
      const response = await app.fetch(
        new Request("http://localhost/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: reasoningModelId,
            messages: [
              {
                role: "user",
                content:
                  "Think step by step. What is 7 + 5? Reply with only the digits.",
              },
            ],
            stream: true,
            reasoning: { effort: "medium", summary: "concise" },
          }),
        })
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/event-stream");

      const bodyStream = response.body;
      if (!bodyStream) throw new Error("Response body is null");
      const reader = bodyStream.getReader();
      const decoder = new TextDecoder();
      let rawSse = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        rawSse += decoder.decode(value, { stream: true });
      }

      const events = rawSse.split("\n\n").map((e) => e.trim()).filter(Boolean);
      expect(events.at(-1)).toBe("data: [DONE]");

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chunks: any[] = events.slice(0, -1).map((e) => {
        expect(e.startsWith("data: ")).toBe(true);
        return JSON.parse(e.slice("data: ".length));
      });

      for (const chunk of chunks) {
        expect(chunk.id).toMatch(/^chatcmpl-/);
        expect(chunk.object).toBe("chat.completion.chunk");
        expect(chunk.model).toBe(reasoningModelId);
        expect(Array.isArray(chunk.choices)).toBe(true);
      }
      expect(chunks[0].choices[0].delta).toMatchObject({ role: "assistant" });

      // Reply must still be reconstructible from content deltas.
      const reconstructed = chunks
        .slice(1)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((c: any) => c.choices[0].delta.content ?? "")
        .join("");
      expect(reconstructed.length).toBeGreaterThan(0);

      // Any delta.reasoning_content chunks emitted must be plain strings
      // (DeepSeek/OpenRouter convention consumed by Open WebUI et al.).
      const reasoningChunks = chunks
        .slice(1)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .filter((c: any) => typeof c.choices[0].delta.reasoning_content === "string");
      for (const rc of reasoningChunks) {
        const r = rc.choices[0].delta.reasoning_content;
        expect(typeof r).toBe("string");
      }

      // Final chunk must report a normal stop (not an error).
      expect(chunks.at(-1).choices[0].finish_reason).toBe("stop");
    }, 60_000);
  });

  // ── POST /v1/chat/completions (reasoning effort → model suffix) ──────────
  // Augment encodes reasoning depth in the model ID itself
  // (e.g. `claude-opus-4-7-high`). The proxy exposes both forms:
  //   1. The suffixed ID directly in /v1/models, so clients can target it.
  //   2. The base ID + `reasoning_effort` body field, which the proxy rewrites
  //      to the suffixed ID before calling the backend.
  // This suite verifies BOTH paths return 200 against the live API for a
  // model that actually advertises effort levels (and is not muted via
  // AUGMENT_DISABLE_EFFORT_MODELS), proving the suffixing isn't 404'd.
  describe("POST /v1/chat/completions (reasoning effort suffixing)", () => {
    // Resolved in beforeAll: a base model ID, one of its advertised effort
    // suffixes, and the corresponding suffixed ID.
    let effortBaseId = "";
    let effortLevel = "";
    let effortSuffixedId = "";

    const EFFORT_SUFFIX_RE = /-(low|medium|high|max|xhigh)$/;

    beforeAll(async () => {
      const res = await app.fetch(new Request("http://localhost/v1/models"));
      if (!res.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body: any = await res.json();
      const ids: string[] = (body.data ?? []).map((m: { id: string }) => m.id);
      const idSet = new Set(ids);
      // Find any suffixed ID whose base also exists in the registry.
      for (const id of ids) {
        const m = EFFORT_SUFFIX_RE.exec(id);
        if (!m) continue;
        const base = id.slice(0, -m[0].length);
        if (idSet.has(base)) {
          effortBaseId = base;
          effortLevel = m[1];
          effortSuffixedId = id;
          break;
        }
      }
    }, 20_000);

    it("accepts a suffixed model ID directly and echoes it back", async () => {
      if (!effortSuffixedId) return; // no effort-capable model on this account
      const response = await app.fetch(
        new Request("http://localhost/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: effortSuffixedId,
            messages: [
              {
                role: "user",
                content: 'Reply with exactly the word "pong" and nothing else.',
              },
            ],
          }),
        })
      );

      expect(
        response.status,
        `suffixed model ${effortSuffixedId} returned ${response.status}`
      ).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body: any = await response.json();
      expect(body.model).toBe(effortSuffixedId);
      expect(body.choices[0].message.role).toBe("assistant");
      expect((body.choices[0].message.content as string).toLowerCase()).toContain("pong");
      expect(body.choices[0].finish_reason).toBe("stop");
    }, 60_000);

    it("rewrites base model + reasoning_effort to the suffixed backend ID and preserves the base ID in the response", async () => {
      if (!effortBaseId) return;
      // Map the discovered Augment level back to an OpenAI effort value.
      // OpenAI accepts: minimal | low | medium | high. "max"/"xhigh" snap
      // down to "high" in resolveEffortModelId; "low"/"medium"/"high" pass
      // through; "minimal" is an alias for the lowest level.
      const openaiEffort =
        effortLevel === "low" || effortLevel === "medium" || effortLevel === "high"
          ? effortLevel
          : "high";

      const response = await app.fetch(
        new Request("http://localhost/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: effortBaseId,
            messages: [
              {
                role: "user",
                content: 'Reply with exactly the word "pong" and nothing else.',
              },
            ],
            reasoning_effort: openaiEffort,
          }),
        })
      );

      expect(
        response.status,
        `base ${effortBaseId} + reasoning_effort=${openaiEffort} returned ${response.status}`
      ).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body: any = await response.json();
      // Response must echo the original (base) model ID — not the rewritten one.
      expect(body.model).toBe(effortBaseId);
      expect(body.choices[0].message.role).toBe("assistant");
      expect((body.choices[0].message.content as string).toLowerCase()).toContain("pong");
      expect(body.choices[0].finish_reason).toBe("stop");
    }, 60_000);
  });
});
