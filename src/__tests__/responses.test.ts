import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";

// ── Mock the SDK at the top level (mirrors chat.test.ts) ──────────────────
const mockResolveCredentials = vi.fn();
const mockDoGenerate = vi.fn();
const mockDoStream = vi.fn();
const constructorCalls: Array<{ modelId: string; options: object }> = [];

class MockAugmentLanguageModel {
  specificationVersion = "v2" as const;
  provider = "test-provider";
  modelId: string;
  constructor(modelId: string, options: object) {
    this.modelId = modelId;
    constructorCalls.push({ modelId, options });
  }
  doGenerate = mockDoGenerate;
  doStream = mockDoStream;
}

vi.mock("@augmentcode/auggie-sdk", () => ({
  resolveAugmentCredentials: () => mockResolveCredentials(),
  AugmentLanguageModel: MockAugmentLanguageModel,
}));

// Prevent tests from spawning the real auggie binary.
vi.mock("node:child_process", () => ({
  execFile: vi.fn((_cmd: string, _args: string[], _opts: object, cb: Function) =>
    cb(new Error("auggie not available in test environment"), "")
  ),
}));

// ── Helpers ────────────────────────────────────────────────────────────────
async function drainSse(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  const chunks: string[] = [];
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(new TextDecoder().decode(value));
    }
  }
  return chunks.join("");
}

interface ParsedSseEvent {
  event: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
}
function parseSseStream(raw: string): ParsedSseEvent[] {
  return raw
    .split("\n\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((blob) => {
      const lines = blob.split("\n");
      const eventLine = lines.find((l) => l.startsWith("event: "));
      const dataLine = lines.find((l) => l.startsWith("data: "));
      const event = eventLine ? eventLine.slice("event: ".length) : "";
      const dataRaw = dataLine ? dataLine.slice("data: ".length) : "";
      let data: unknown = null;
      try { data = JSON.parse(dataRaw); } catch { data = dataRaw; }
      return { event, data };
    });
}

describe("responses route", () => {
  let app: Hono;

  beforeEach(async () => {
    mockResolveCredentials.mockClear();
    mockDoGenerate.mockClear();
    mockDoStream.mockClear();
    constructorCalls.length = 0;
    mockResolveCredentials.mockResolvedValue({
      apiKey: "test-key",
      apiUrl: "https://api.test.com",
    });

    const { default: responsesRouter } = await import("../routes/responses");
    app = new Hono();
    app.route("/v1/responses", responsesRouter);
  });

  describe("request validation", () => {
    it("rejects request with missing model field", async () => {
      const req = new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: "hello" }),
      });
      const response = await app.fetch(req);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body: any = await response.json();
      expect(response.status).toBe(400);
      expect(body.error.message).toContain("model");
    });

    it("rejects request with missing input field", async () => {
      const req = new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-4-5" }),
      });
      const response = await app.fetch(req);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body: any = await response.json();
      expect(response.status).toBe(400);
      expect(body.error.message).toContain("input");
    });

    it("rejects unknown non-claude model", async () => {
      const req = new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "llama-2", input: "hi" }),
      });
      const response = await app.fetch(req);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body: any = await response.json();
      expect(response.status).toBe(404);
      expect(body.error.message).toContain("llama-2");
    });

    it("rejects trailing assistant message", async () => {
      const req = new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          input: [
            { role: "user", content: "hi" },
            { role: "assistant", content: "hello" },
          ],
        }),
      });
      const response = await app.fetch(req);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body: any = await response.json();
      expect(response.status).toBe(400);
      expect(body.error.message).toContain("assistant");
      expect(mockDoGenerate).not.toHaveBeenCalled();
    });

    it("rejects trailing function_call (assistant tool call without result)", async () => {
      const req = new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          input: [
            { role: "user", content: "hi" },
            {
              type: "function_call",
              call_id: "call_1",
              name: "do_x",
              arguments: "{}",
            },
          ],
        }),
      });
      const response = await app.fetch(req);
      expect(response.status).toBe(400);
      expect(mockDoGenerate).not.toHaveBeenCalled();
    });

    it("accepts trailing function_call_output (tool result)", async () => {
      mockDoGenerate.mockResolvedValueOnce({
        content: [{ type: "text", text: "done" }],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      });
      const req = new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          input: [
            { role: "user", content: "hi" },
            { type: "function_call", call_id: "c1", name: "f", arguments: "{}" },
            { type: "function_call_output", call_id: "c1", output: "ok" },
          ],
        }),
      });
      const response = await app.fetch(req);
      expect(response.status).toBe(200);
    });

    it("handles malformed JSON body gracefully", async () => {
      const req = new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{ invalid json }",
      });
      const response = await app.fetch(req);
      expect(response.status).toBe(500);
    });
  });

  describe("non-streaming response", () => {
    it("returns a Responses-API envelope with correct fields", async () => {
      mockDoGenerate.mockResolvedValueOnce({
        content: [{ type: "text", text: "Hello!" }],
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 20 },
      });
      const req = new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          input: "hello",
        }),
      });
      const response = await app.fetch(req);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body: any = await response.json();

      expect(response.status).toBe(200);
      expect(body.object).toBe("response");
      expect(body.id).toMatch(/^resp_/);
      expect(body.model).toBe("claude-sonnet-4-5");
      expect(body.status).toBe("completed");
      expect(body.created_at).toBeGreaterThan(0);
      expect(body.error).toBeNull();
    });

    it("emits an assistant output_text message for plain text responses", async () => {
      mockDoGenerate.mockResolvedValueOnce({
        content: [{ type: "text", text: "Hello world" }],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 2 },
      });
      const req = new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-4-5", input: "hi" }),
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body: any = await (await app.fetch(req)).json();

      expect(body.output).toHaveLength(1);
      const msg = body.output[0];
      expect(msg.type).toBe("message");
      expect(msg.role).toBe("assistant");
      expect(msg.status).toBe("completed");
      expect(msg.content[0].type).toBe("output_text");
      expect(msg.content[0].text).toBe("Hello world");
    });

    it("includes usage with input/output/total tokens", async () => {
      mockDoGenerate.mockResolvedValueOnce({
        content: [{ type: "text", text: "ok" }],
        finishReason: "stop",
        usage: { inputTokens: 7, outputTokens: 4 },
      });
      const req = new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-4-5", input: "hi" }),
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body: any = await (await app.fetch(req)).json();
      expect(body.usage.input_tokens).toBe(7);
      expect(body.usage.output_tokens).toBe(4);
      expect(body.usage.total_tokens).toBe(11);
    });

    it("returns 500 with server_error envelope when generation throws", async () => {
      mockDoGenerate.mockRejectedValueOnce(new Error("API timeout"));
      const req = new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-4-5", input: "hi" }),
      });
      const response = await app.fetch(req);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body: any = await response.json();
      expect(response.status).toBe(500);
      expect(body.error.message).toBe("API timeout");
      expect(body.error.type).toBe("server_error");
    });

    it("emits a reasoning summary item before the message when reasoning text is present", async () => {
      mockDoGenerate.mockResolvedValueOnce({
        content: [
          { type: "reasoning", text: "Think " },
          { type: "reasoning", text: "step." },
          { type: "text", text: "answer" },
        ],
        finishReason: "stop",
        usage: { inputTokens: 5, outputTokens: 3 },
      });
      const req = new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-4-5", input: "hi" }),
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body: any = await (await app.fetch(req)).json();
      expect(body.output).toHaveLength(2);
      expect(body.output[0].type).toBe("reasoning");
      expect(body.output[0].id).toMatch(/^rs_/);
      expect(body.output[0].summary[0]).toEqual({
        type: "summary_text",
        text: "Think step.",
      });
      expect(body.output[1].type).toBe("message");
    });
  });

  describe("tool calls (non-streaming)", () => {
    it("emits function_call output items for assistant tool calls", async () => {
      mockDoGenerate.mockResolvedValueOnce({
        content: [
          {
            type: "tool-call",
            toolCallId: "call_abc",
            toolName: "search",
            input: { query: "weather" },
          },
        ],
        finishReason: "tool-calls",
        usage: { inputTokens: 6, outputTokens: 4 },
      });
      const req = new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          input: "search the weather",
          tools: [
            {
              type: "function",
              name: "search",
              description: "search the web",
              parameters: { type: "object", properties: { query: { type: "string" } } },
            },
          ],
        }),
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body: any = await (await app.fetch(req)).json();
      expect(body.output).toHaveLength(1);
      const fc = body.output[0];
      expect(fc.type).toBe("function_call");
      expect(fc.call_id).toBe("call_abc");
      expect(fc.name).toBe("search");
      expect(fc.id).toMatch(/^fc_/);
      expect(JSON.parse(fc.arguments)).toEqual({ query: "weather" });
      expect(fc.status).toBe("completed");
    });

    it("forwards tools to the AI SDK in flat-function shape", async () => {
      mockDoGenerate.mockResolvedValueOnce({
        content: [{ type: "text", text: "ok" }],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      });
      const req = new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          input: "hi",
          tools: [
            {
              type: "function",
              name: "calc",
              description: "do math",
              parameters: { type: "object" },
            },
          ],
        }),
      });
      await app.fetch(req);
      const callArgs = mockDoGenerate.mock.calls[0][0];
      // AI SDK v5 normalises tools into a tools array on the call site.
      expect(callArgs.tools).toBeDefined();
      const toolNames = (callArgs.tools as Array<{ name: string }>).map((t) => t.name);
      expect(toolNames).toContain("calc");
    });
  });

  describe("reasoning config", () => {
    it("plumbs reasoning {effort, summary} via providerOptions.augment", async () => {
      mockDoGenerate.mockResolvedValueOnce({
        content: [{ type: "text", text: "ok" }],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      });
      const req = new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          input: "hi",
          reasoning: { effort: "medium", summary: "concise" },
        }),
      });
      await app.fetch(req);
      const callArgs = mockDoGenerate.mock.calls[0][0];
      expect(callArgs.providerOptions).toEqual({
        augment: { reasoningEffort: "medium", reasoningSummary: "concise" },
      });
    });

    it("omits providerOptions when no reasoning fields are present", async () => {
      mockDoGenerate.mockResolvedValueOnce({
        content: [{ type: "text", text: "ok" }],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      });
      const req = new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-4-5", input: "hi" }),
      });
      await app.fetch(req);
      const callArgs = mockDoGenerate.mock.calls[0][0];
      expect(callArgs.providerOptions).toBeUndefined();
    });

    it("echoes the original reasoning {effort, summary} on the response envelope", async () => {
      mockDoGenerate.mockResolvedValueOnce({
        content: [{ type: "text", text: "ok" }],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      });
      const req = new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          input: "hi",
          reasoning: { effort: "high", summary: "auto" },
        }),
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body: any = await (await app.fetch(req)).json();
      expect(body.reasoning).toEqual({ effort: "high", summary: "auto" });
    });
  });

  describe("reasoning_effort model-ID rewrite", () => {
    let mockResolveEffort: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      mockResolveEffort = vi.fn();
      vi.doMock("../services/modelRegistry", async () => {
        const actual = await vi.importActual<typeof import("../services/modelRegistry")>(
          "../services/modelRegistry"
        );
        return {
          ...actual,
          resolveEffortModelId: mockResolveEffort,
        };
      });
      vi.resetModules();
      const { default: responsesRouter } = await import("../routes/responses");
      app = new Hono();
      app.route("/v1/responses", responsesRouter);
    });

    afterEach(() => {
      vi.doUnmock("../services/modelRegistry");
    });

    it("instantiates AugmentLanguageModel with the suffixed ID returned by the registry", async () => {
      mockResolveEffort.mockResolvedValueOnce("claude-opus-4-7-high");
      mockDoGenerate.mockResolvedValueOnce({
        content: [{ type: "text", text: "ok" }],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      });
      const req = new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-opus-4-7",
          input: "hi",
          reasoning: { effort: "high" },
        }),
      });
      const response = await app.fetch(req);
      expect(response.status).toBe(200);
      expect(mockResolveEffort).toHaveBeenCalledWith("claude-opus-4-7", "high");
      expect(constructorCalls.at(-1)?.modelId).toBe("claude-opus-4-7-high");
    });

    it("does not consult the registry when no reasoning.effort is set", async () => {
      mockDoGenerate.mockResolvedValueOnce({
        content: [{ type: "text", text: "ok" }],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      });
      const req = new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-opus-4-7", input: "hi" }),
      });
      await app.fetch(req);
      expect(mockResolveEffort).not.toHaveBeenCalled();
      expect(constructorCalls.at(-1)?.modelId).toBe("claude-opus-4-7");
    });

    it("preserves the originally-requested model in the response body", async () => {
      mockResolveEffort.mockResolvedValueOnce("claude-opus-4-7-high");
      mockDoGenerate.mockResolvedValueOnce({
        content: [{ type: "text", text: "ok" }],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      });
      const req = new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-opus-4-7",
          input: "hi",
          reasoning: { effort: "high" },
        }),
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body: any = await (await app.fetch(req)).json();
      expect(body.model).toBe("claude-opus-4-7");
    });
  });

  describe("streaming response", () => {
    it("returns SSE stream with correct headers and lifecycle events", async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "text-start", id: "t1" });
          controller.enqueue({ type: "text-delta", id: "t1", delta: "Hello" });
          controller.enqueue({ type: "text-delta", id: "t1", delta: " world" });
          controller.enqueue({ type: "text-end", id: "t1" });
          controller.enqueue({
            type: "finish",
            finishReason: "stop",
            usage: { inputTokens: 1, outputTokens: 2 },
          });
          controller.close();
        },
      });
      mockDoStream.mockResolvedValueOnce({ stream });

      const req = new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          input: "hi",
          stream: true,
        }),
      });
      const response = await app.fetch(req);
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/event-stream");
      expect(response.headers.get("Cache-Control")).toBe("no-cache");

      const raw = await drainSse(response);
      const events = parseSseStream(raw);
      const types = events.map((e) => e.event);

      // Lifecycle: response.created → response.in_progress → output_item.added →
      // output_text.delta… → output_text.done → content_part.done →
      // output_item.done → response.completed
      expect(types[0]).toBe("response.created");
      expect(types).toContain("response.in_progress");
      expect(types).toContain("response.output_item.added");
      expect(types).toContain("response.output_text.delta");
      expect(types).toContain("response.output_text.done");
      expect(types).toContain("response.content_part.done");
      expect(types).toContain("response.output_item.done");
      expect(types.at(-1)).toBe("response.completed");

      // Concatenated deltas should equal "Hello world".
      const deltas = events
        .filter((e) => e.event === "response.output_text.delta")
        .map((e) => e.data.delta as string)
        .join("");
      expect(deltas).toBe("Hello world");

      // Sequence numbers strictly monotonic from 0.
      events.forEach((e, i) => expect(e.data.sequence_number).toBe(i));

      // Final completed event carries usage and assistant message.
      const completed = events.at(-1);
      expect(completed?.data.response.status).toBe("completed");
      expect(completed?.data.response.usage.input_tokens).toBe(1);
      expect(completed?.data.response.usage.output_tokens).toBe(2);
      expect(completed?.data.response.output[0].content[0].text).toBe("Hello world");
    });

    it("emits reasoning_summary_text deltas for streaming reasoning parts", async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "reasoning-start", id: "r1" });
          controller.enqueue({ type: "reasoning-delta", id: "r1", delta: "First " });
          controller.enqueue({ type: "reasoning-delta", id: "r1", delta: "thought." });
          controller.enqueue({ type: "reasoning-end", id: "r1" });
          controller.enqueue({ type: "text-start", id: "t1" });
          controller.enqueue({ type: "text-delta", id: "t1", delta: "answer" });
          controller.enqueue({ type: "text-end", id: "t1" });
          controller.enqueue({
            type: "finish",
            finishReason: "stop",
            usage: { inputTokens: 2, outputTokens: 3 },
          });
          controller.close();
        },
      });
      mockDoStream.mockResolvedValueOnce({ stream });

      const req = new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          input: "hi",
          stream: true,
          reasoning: { effort: "high" },
        }),
      });
      const events = parseSseStream(await drainSse(await app.fetch(req)));

      const reasoningDeltas = events
        .filter((e) => e.event === "response.reasoning_summary_text.delta")
        .map((e) => e.data.delta as string);
      expect(reasoningDeltas).toEqual(["First ", "thought."]);

      // Reasoning item should be closed before the text item.
      const reasoningDoneIdx = events.findIndex(
        (e) => e.event === "response.reasoning_summary_text.done"
      );
      const textStartIdx = events.findIndex(
        (e) => e.event === "response.output_text.delta"
      );
      expect(reasoningDoneIdx).toBeLessThan(textStartIdx);

      // providerOptions should be plumbed through to streamText.
      const streamCallArgs = mockDoStream.mock.calls[0][0];
      expect(streamCallArgs.providerOptions).toEqual({
        augment: { reasoningEffort: "high" },
      });
    });

    it("streams function_call_arguments deltas and emits a completed function_call item", async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({
            type: "tool-input-start",
            id: "call_abc",
            toolName: "search",
          });
          controller.enqueue({
            type: "tool-input-delta",
            id: "call_abc",
            delta: "{\"query\":",
          });
          controller.enqueue({
            type: "tool-input-delta",
            id: "call_abc",
            delta: "\"weather\"}",
          });
          controller.enqueue({
            type: "tool-input-end",
            id: "call_abc",
          });
          controller.enqueue({
            type: "finish",
            finishReason: "tool-calls",
            usage: { inputTokens: 5, outputTokens: 8 },
          });
          controller.close();
        },
      });
      mockDoStream.mockResolvedValueOnce({ stream });

      const req = new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          input: "search the weather",
          stream: true,
          tools: [
            {
              type: "function",
              name: "search",
              parameters: { type: "object" },
            },
          ],
        }),
      });
      const events = parseSseStream(await drainSse(await app.fetch(req)));

      const argDeltas = events
        .filter((e) => e.event === "response.function_call_arguments.delta")
        .map((e) => e.data.delta as string);
      expect(argDeltas.join("")).toBe('{"query":"weather"}');

      const argsDone = events.find(
        (e) => e.event === "response.function_call_arguments.done"
      );
      expect(argsDone?.data.arguments).toBe('{"query":"weather"}');

      const completed = events.at(-1);
      expect(completed?.event).toBe("response.completed");
      const fc = completed?.data.response.output[0];
      expect(fc.type).toBe("function_call");
      expect(fc.call_id).toBe("call_abc");
      expect(fc.name).toBe("search");
      expect(fc.arguments).toBe('{"query":"weather"}');
      expect(fc.status).toBe("completed");
    });

    it("emits a stream_error and response.failed when upstream closes with no parts", async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });
      mockDoStream.mockResolvedValueOnce({ stream });

      const req = new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          input: "hi",
          stream: true,
        }),
      });
      const events = parseSseStream(await drainSse(await app.fetch(req)));
      const types = events.map((e) => e.event);
      expect(types).toContain("error");
      expect(types.at(-1)).toBe("response.failed");
      const errorEvent = events.find((e) => e.event === "error");
      expect(errorEvent?.data.message).toMatch(/no.*content|without producing/i);
    });

    it("surfaces stream startup failures in-band as response.failed", async () => {
      mockDoStream.mockRejectedValueOnce(new Error("Failed to connect"));

      const req = new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          input: "hi",
          stream: true,
        }),
      });
      const response = await app.fetch(req);
      // AI SDK surfaces doStream rejections through the stream; the HTTP
      // response is still 200 SSE with the error reported in-band.
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/event-stream");

      const events = parseSseStream(await drainSse(response));
      const errorEvent = events.find((e) => e.event === "error");
      expect(errorEvent?.data.message).toContain("Failed to connect");
      expect(events.at(-1)?.event).toBe("response.failed");
    });

    it("closes an open reasoning item when the stream ends without a reasoning-end part", async () => {
      // Emit reasoning deltas with no matching reasoning-end, followed by a
      // text run so the upstream-empty guard does not trip. The cleanup pass
      // in closeAllOpenItems must close the dangling reasoning item.
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "reasoning-start", id: "r1" });
          controller.enqueue({ type: "reasoning-delta", id: "r1", delta: "Half a thought" });
          controller.enqueue({
            type: "finish",
            finishReason: "stop",
            usage: { inputTokens: 1, outputTokens: 1 },
          });
          controller.close();
        },
      });
      mockDoStream.mockResolvedValueOnce({ stream });

      const req = new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          input: "hi",
          stream: true,
        }),
      });
      const events = parseSseStream(await drainSse(await app.fetch(req)));
      const types = events.map((e) => e.event);

      // The reasoning lifecycle must complete despite no reasoning-end part.
      expect(types).toContain("response.reasoning_summary_text.done");
      expect(types).toContain("response.reasoning_summary_part.done");
      expect(types).toContain("response.output_item.done");
      expect(types.at(-1)).toBe("response.completed");

      // The completed envelope must carry the reasoning item with the buffered text.
      const completed = events.at(-1);
      const reasoningItem = completed?.data.response.output.find(
        (o: { type: string }) => o.type === "reasoning"
      );
      expect(reasoningItem).toBeDefined();
      expect(reasoningItem.summary[0].text).toBe("Half a thought");
    });

    it("closes an open text item when a reasoning-delta arrives mid-stream", async () => {
      // Sequence: text-delta opens a message item, then reasoning-delta
      // arrives — the text item must be closed before the reasoning
      // lifecycle opens (same item never carries both kinds of content).
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "text-start", id: "t1" });
          controller.enqueue({ type: "text-delta", id: "t1", delta: "Quick note." });
          controller.enqueue({ type: "reasoning-start", id: "r1" });
          controller.enqueue({ type: "reasoning-delta", id: "r1", delta: "On reflection." });
          controller.enqueue({ type: "reasoning-end", id: "r1" });
          controller.enqueue({
            type: "finish",
            finishReason: "stop",
            usage: { inputTokens: 1, outputTokens: 1 },
          });
          controller.close();
        },
      });
      mockDoStream.mockResolvedValueOnce({ stream });

      const req = new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          input: "hi",
          stream: true,
          reasoning: { effort: "medium" },
        }),
      });
      const events = parseSseStream(await drainSse(await app.fetch(req)));
      const types = events.map((e) => e.event);

      const textDoneIdx = types.indexOf("response.output_text.done");
      const reasoningDeltaIdx = types.indexOf("response.reasoning_summary_text.delta");
      expect(textDoneIdx).toBeGreaterThan(-1);
      expect(reasoningDeltaIdx).toBeGreaterThan(textDoneIdx);
    });

    it("closes an open text item when a tool-input-start arrives mid-stream", async () => {
      // Sequence: text-delta opens a message item, then tool-input-start
      // arrives — the in-flight text item must be closed before the tool
      // call's output_item.added is emitted.
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "text-start", id: "t1" });
          controller.enqueue({ type: "text-delta", id: "t1", delta: "Let me check." });
          controller.enqueue({
            type: "tool-input-start",
            id: "call_x",
            toolName: "search",
          });
          controller.enqueue({ type: "tool-input-delta", id: "call_x", delta: "{}" });
          controller.enqueue({ type: "tool-input-end", id: "call_x" });
          controller.enqueue({
            type: "finish",
            finishReason: "tool-calls",
            usage: { inputTokens: 1, outputTokens: 1 },
          });
          controller.close();
        },
      });
      mockDoStream.mockResolvedValueOnce({ stream });

      const req = new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          input: "search",
          stream: true,
          tools: [{ type: "function", name: "search", parameters: { type: "object" } }],
        }),
      });
      const events = parseSseStream(await drainSse(await app.fetch(req)));
      const types = events.map((e) => e.event);

      // Both lifecycles must complete; the message lifecycle must close
      // before the function_call lifecycle opens. The first output_item.added
      // belongs to the message; the second belongs to the function_call.
      const textDoneIdx = types.indexOf("response.output_text.done");
      const addedIndices = types
        .map((t, i) => (t === "response.output_item.added" ? i : -1))
        .filter((i) => i >= 0);
      expect(textDoneIdx).toBeGreaterThan(-1);
      expect(addedIndices.length).toBeGreaterThanOrEqual(2);
      expect(addedIndices[1]).toBeGreaterThan(textDoneIdx);

      // The completed envelope carries both the message and the function_call.
      const completed = events.at(-1)?.data.response;
      const kinds = completed.output.map((o: { type: string }) => o.type);
      expect(kinds).toEqual(["message", "function_call"]);
    });

    it("closes an open reasoning item when a tool-input-start arrives mid-stream", async () => {
      // Sequence: reasoning-delta opens a reasoning item, then
      // tool-input-start arrives — the reasoning lifecycle must close
      // before the tool call's output_item.added is emitted.
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "reasoning-start", id: "r1" });
          controller.enqueue({ type: "reasoning-delta", id: "r1", delta: "Plan: search." });
          controller.enqueue({
            type: "tool-input-start",
            id: "call_y",
            toolName: "search",
          });
          controller.enqueue({ type: "tool-input-delta", id: "call_y", delta: "{}" });
          controller.enqueue({ type: "tool-input-end", id: "call_y" });
          controller.enqueue({
            type: "finish",
            finishReason: "tool-calls",
            usage: { inputTokens: 1, outputTokens: 1 },
          });
          controller.close();
        },
      });
      mockDoStream.mockResolvedValueOnce({ stream });

      const req = new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          input: "search",
          stream: true,
          tools: [{ type: "function", name: "search", parameters: { type: "object" } }],
          reasoning: { effort: "high" },
        }),
      });
      const events = parseSseStream(await drainSse(await app.fetch(req)));
      const types = events.map((e) => e.event);

      const reasoningDoneIdx = types.indexOf("response.reasoning_summary_text.done");
      const toolArgsDoneIdx = types.indexOf("response.function_call_arguments.done");
      expect(reasoningDoneIdx).toBeGreaterThan(-1);
      expect(toolArgsDoneIdx).toBeGreaterThan(reasoningDoneIdx);

      const completed = events.at(-1)?.data.response;
      const kinds = completed.output.map((o: { type: string }) => o.type);
      expect(kinds).toEqual(["reasoning", "function_call"]);
    });

    it("catches mid-iteration stream errors and reports them as response.failed", async () => {
      // controller.error() makes the underlying ReadableStream reject during
      // iteration — the for-await in handleStreaming must catch it and emit
      // an in-band error event before finalising.
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "text-delta", id: "t1", delta: "partial" });
          controller.error(new Error("upstream blew up mid-stream"));
        },
      });
      mockDoStream.mockResolvedValueOnce({ stream });

      const req = new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          input: "hi",
          stream: true,
        }),
      });
      const events = parseSseStream(await drainSse(await app.fetch(req)));
      const errorEvent = events.find((e) => e.event === "error");
      expect(errorEvent).toBeDefined();
      expect(errorEvent?.data.message).toMatch(/upstream blew up|blew up mid-stream/);
      expect(events.at(-1)?.event).toBe("response.failed");
    });
  });

  describe("input transformation (tool result round-trip)", () => {
    it("collapses function_call + function_call_output into assistant + tool messages", async () => {
      mockDoGenerate.mockResolvedValueOnce({
        content: [{ type: "text", text: "result acknowledged" }],
        finishReason: "stop",
        usage: { inputTokens: 5, outputTokens: 3 },
      });
      const req = new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          input: [
            { role: "user", content: "search weather" },
            {
              type: "function_call",
              call_id: "c1",
              name: "search",
              arguments: '{"q":"weather"}',
            },
            {
              type: "function_call_output",
              call_id: "c1",
              output: "sunny",
            },
          ],
        }),
      });
      const response = await app.fetch(req);
      expect(response.status).toBe(200);

      // The AI SDK normalises messages → prompt before invoking doGenerate.
      const callArgs = mockDoGenerate.mock.calls[0][0];
      const prompt = callArgs.prompt as Array<{ role: string; content: unknown }>;
      expect(prompt.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
      // The assistant turn must contain the tool-call part with the same call_id.
      const assistantContent = prompt[1].content as Array<{ type: string; toolCallId?: string }>;
      expect(assistantContent.some((p) => p.type === "tool-call" && p.toolCallId === "c1"))
        .toBe(true);
      // The tool turn must carry the tool-result with the matching call_id.
      const toolContent = prompt[2].content as Array<{ type: string; toolCallId?: string }>;
      expect(toolContent.some((p) => p.type === "tool-result" && p.toolCallId === "c1"))
        .toBe(true);
    });

    it("prepends instructions as a system message", async () => {
      mockDoGenerate.mockResolvedValueOnce({
        content: [{ type: "text", text: "ok" }],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      });
      const req = new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          instructions: "You are concise.",
          input: "hi",
        }),
      });
      await app.fetch(req);
      const callArgs = mockDoGenerate.mock.calls[0][0];
      const prompt = callArgs.prompt as Array<{ role: string; content: unknown }>;
      expect(prompt[0].role).toBe("system");
      // System content is normalised to a string by the AI SDK.
      expect(prompt[0].content).toContain("You are concise.");
      expect(prompt[1].role).toBe("user");
    });
  });
});
