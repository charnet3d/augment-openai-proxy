import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";

// ── Mock the SDK at the top level ─────────────────────────────
const mockResolveCredentials = vi.fn();
const mockDoGenerate = vi.fn();
const mockDoStream = vi.fn();
// Captures `new AugmentLanguageModel(modelId, options)` calls so tests can
// assert which model ID was actually instantiated (e.g. after effort-suffix
// rewriting).
const constructorCalls: Array<{ modelId: string; options: object }> = [];

// Use a class-based mock so it works with `new AugmentLanguageModel(...)`
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

describe("chat route", () => {
  let app: Hono;

  beforeEach(async () => {
    // Use mockClear() instead of mockReset() to preserve the implementation
    // mockReset() would clear mockResolvedValue, causing doGenerate to return undefined
    mockResolveCredentials.mockClear();
    mockDoGenerate.mockClear();
    mockDoStream.mockClear();
    constructorCalls.length = 0;

    // Reset credentials mock for each test
    mockResolveCredentials.mockResolvedValue({
      apiKey: "test-key",
      apiUrl: "https://api.test.com",
    });

    // Build a fresh app for each test
    const { default: chatRouter } = await import("../routes/chat");
    app = new Hono();
    app.route("/v1/chat", chatRouter);
  });

  describe("request validation", () => {
    it("should reject request with missing model field", async () => {
      const req = new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
      });

      const response = await app.fetch(req);
      const body: any = await response.json();

      expect(response.status).toBe(400);
      expect(body.error.message).toContain("model");
      expect(body.error.type).toBe("invalid_request_error");
    });

    it("should reject request with unknown non-claude model", async () => {
      const req = new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "llama-2",
          messages: [{ role: "user", content: "hello" }],
        }),
      });

      const response = await app.fetch(req);
      const body: any = await response.json();

      expect(response.status).toBe(404);
      expect(body.error.message).toContain("llama-2");
      expect(body.error.type).toBe("invalid_request_error");
    });

    it("should accept claude- prefixed models even if not in registry", async () => {
      mockDoGenerate.mockResolvedValueOnce({
        content: [{ type: "text", text: "Hello!" }],
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 5 },
      });

      const req = new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          messages: [{ role: "user", content: "hello" }],
        }),
      });

      const response = await app.fetch(req);
      expect(response.status).toBe(200);
    });

    it("should handle malformed JSON body gracefully", async () => {
      const req = new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{ invalid json }",
      });

      const response = await app.fetch(req);
      expect(response.status).toBe(500);
    });
  });

  describe("non-streaming response", () => {
    it("should return OpenAI-compatible response format", async () => {
      mockDoGenerate.mockResolvedValueOnce({
        content: [{ type: "text", text: "Hello from Claude!" }],
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 20 },
      });

      const req = new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          messages: [{ role: "user", content: "Hello" }],
        }),
      });

      const response = await app.fetch(req);
      const body: any = await response.json();

      expect(response.status).toBe(200);
      expect(body.object).toBe("chat.completion");
      expect(body.id).toMatch(/^chatcmpl-/);
      expect(body.model).toBe("claude-sonnet-4-5");
      expect(body.created).toBeGreaterThan(0);
      expect(body.system_fingerprint).toBe("augment_oai_proxy");
    });

    it("should include correct choice structure", async () => {
      mockDoGenerate.mockResolvedValueOnce({
        content: [{ type: "text", text: "Hello from Claude!" }],
        finishReason: "stop",
        usage: { inputTokens: 5, outputTokens: 3 },
      });

      const req = new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          messages: [{ role: "user", content: "Hello" }],
        }),
      });

      const response = await app.fetch(req);
      const body: any = await response.json();

      expect(body.choices).toHaveLength(1);
      expect(body.choices[0].index).toBe(0);
      expect(body.choices[0].message.role).toBe("assistant");
      expect(body.choices[0].message.content).toBe("Hello from Claude!");
      expect(body.choices[0].finish_reason).toBe("stop");
    });

    it("should include usage when available", async () => {
      mockDoGenerate.mockResolvedValueOnce({
        content: [{ type: "text", text: "Hello!" }],
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 20 },
      });

      const req = new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          messages: [{ role: "user", content: "Hello" }],
        }),
      });

      const response = await app.fetch(req);
      const body: any = await response.json();

      expect(body.usage).toBeDefined();
      expect(body.usage.prompt_tokens).toBe(10);
      expect(body.usage.completion_tokens).toBe(20);
      expect(body.usage.total_tokens).toBe(30);
    });

    it("should handle tool calls in response", async () => {
      mockDoGenerate.mockResolvedValueOnce({
        content: [
          { type: "tool-call", toolCallId: "call_123", toolName: "getWeather", input: { city: "NYC" } },
        ],
        finishReason: "tool-calls",
        usage: { inputTokens: 7, outputTokens: 4 },
      });

      const req = new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          messages: [{ role: "user", content: "What's the weather?" }],
        }),
      });

      const response = await app.fetch(req);
      const body: any = await response.json();

      expect(body.choices[0].message.tool_calls).toHaveLength(1);
      expect(body.choices[0].message.tool_calls[0].id).toBe("call_123");
      expect(body.choices[0].message.tool_calls[0].function.name).toBe("getWeather");
      expect(body.choices[0].finish_reason).toBe("tool_calls");
    });

    it("should concatenate multiple text parts", async () => {
      mockDoGenerate.mockResolvedValueOnce({
        content: [
          { type: "text", text: "Hello" },
          { type: "text", text: " " },
          { type: "text", text: "world!" },
        ],
        finishReason: "stop",
        usage: { inputTokens: 4, outputTokens: 3 },
      });

      const req = new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          messages: [{ role: "user", content: "Say hello" }],
        }),
      });

      const response = await app.fetch(req);
      const body: any = await response.json();

      expect(body.choices[0].message.content).toBe("Hello world!");
    });

    it("should return error response in OpenAI format on server error", async () => {
      mockDoGenerate.mockRejectedValueOnce(new Error("API timeout"));

      const req = new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          messages: [{ role: "user", content: "Hello" }],
        }),
      });

      const response = await app.fetch(req);
      const body: any = await response.json();

      expect(response.status).toBe(500);
      expect(body.error.message).toBe("API timeout");
      expect(body.error.type).toBe("server_error");
      expect(body.error.code).toBe(500);
    });

    it("should handle null content (tool-call only responses)", async () => {
      mockDoGenerate.mockResolvedValueOnce({
        content: [
          {
            type: "tool-call",
            toolCallId: "call_abc",
            toolName: "search",
            input: { query: "test" },
          },
        ],
        finishReason: "tool-calls",
        usage: { inputTokens: 6, outputTokens: 4 },
      });

      const req = new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          messages: [{ role: "user", content: "search for test" }],
        }),
      });

      const response = await app.fetch(req);
      const body: any = await response.json();

      expect(body.choices[0].message.content).toBeNull();
      expect(body.choices[0].message.tool_calls).toHaveLength(1);
      expect(body.choices[0].finish_reason).toBe("tool_calls");
    });
  });

  describe("streaming response", () => {
    it("should return SSE stream with correct headers", async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } });
          controller.close();
        },
      });
      mockDoStream.mockResolvedValueOnce({ stream });

      const req = new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          messages: [{ role: "user", content: "Hello" }],
          stream: true,
        }),
      });

      const response = await app.fetch(req);

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/event-stream");
      expect(response.headers.get("Cache-Control")).toBe("no-cache");
      expect(response.headers.get("Connection")).toBe("keep-alive");
    });

    it("should stream text-delta chunks in SSE format", async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "text-start", id: "t1" });
          controller.enqueue({ type: "text-delta", id: "t1", delta: "Hello" });
          controller.enqueue({ type: "text-delta", id: "t1", delta: " world" });
          controller.enqueue({ type: "text-end", id: "t1" });
          controller.enqueue({ type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 2 } });
          controller.close();
        },
      });
      mockDoStream.mockResolvedValueOnce({ stream });

      const req = new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }),
      });

      const response = await app.fetch(req);
      const reader = response.body?.getReader();
      const chunks: string[] = [];

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(new TextDecoder().decode(value));
        }
      }

      const fullContent = chunks.join("");
      expect(fullContent).toContain("data: [DONE]");
      expect(fullContent).toContain('"role":"assistant"');
      expect(fullContent).toContain('"content":"Hello"');
    });

    it("should handle streaming errors gracefully", async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.error(new Error("Stream interrupted"));
        },
      });
      mockDoStream.mockResolvedValueOnce({ stream });

      const req = new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }),
      });

      const response = await app.fetch(req);
      expect(response.status).toBe(200); // Stream starts OK, error comes in the stream

      const reader = response.body?.getReader();
      const chunks: string[] = [];
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(new TextDecoder().decode(value));
        }
      }

      const fullContent = chunks.join("");
      expect(fullContent).toContain("stream_error");
    });

    it("should handle stream startup failure", async () => {
      mockDoStream.mockRejectedValueOnce(new Error("Failed to connect"));

      const req = new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }),
      });

      const response = await app.fetch(req);
      // AI SDK v5 surfaces doStream rejections through the stream, so the
      // response is still 200 SSE with the error reported in-band.
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/event-stream");

      const reader = response.body?.getReader();
      const chunks: string[] = [];
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(new TextDecoder().decode(value));
        }
      }
      const fullContent = chunks.join("");
      expect(fullContent).toContain("stream_error");
      expect(fullContent).toContain("Failed to connect");
      expect(fullContent).toContain("[DONE]");
    });
  });

  describe("finish reason mapping", () => {
    it("should map stop finish reason", async () => {
      mockDoGenerate.mockResolvedValueOnce({
        content: [{ type: "text", text: "Done" }],
        finishReason: "stop",
        usage: { inputTokens: 3, outputTokens: 1 },
      });

      const req = new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          messages: [{ role: "user", content: "hi" }],
        }),
      });

      const response = await app.fetch(req);
      const body: any = await response.json();
      expect(body.choices[0].finish_reason).toBe("stop");
    });

    it("should map length finish reason", async () => {
      mockDoGenerate.mockResolvedValueOnce({
        content: [{ type: "text", text: "Truncated" }],
        finishReason: "length",
        usage: { inputTokens: 3, outputTokens: 100 },
      });

      const req = new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          messages: [{ role: "user", content: "hi" }],
        }),
      });

      const response = await app.fetch(req);
      const body: any = await response.json();
      expect(body.choices[0].finish_reason).toBe("length");
    });

    it("should map content-filter to content_filter", async () => {
      mockDoGenerate.mockResolvedValueOnce({
        content: [{ type: "text", text: "Filtered" }],
        finishReason: "content-filter",
        usage: { inputTokens: 3, outputTokens: 1 },
      });

      const req = new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          messages: [{ role: "user", content: "hi" }],
        }),
      });

      const response = await app.fetch(req);
      const body: any = await response.json();
      expect(body.choices[0].finish_reason).toBe("content_filter");
    });
  });

  describe("tool_choice transformation", () => {
    it("should pass through object tool_choice with function name", async () => {
      mockDoGenerate.mockResolvedValueOnce({
        content: [{ type: "text", text: "OK" }],
        finishReason: "stop",
        usage: { inputTokens: 4, outputTokens: 1 },
      });

      const req = new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          messages: [{ role: "user", content: "Get weather" }],
          tools: [
            {
              type: "function",
              function: {
                name: "getWeather",
                parameters: { type: "object", properties: { city: { type: "string" } } },
              },
            },
          ],
          tool_choice: { type: "function", function: { name: "getWeather" } },
        }),
      });

      const response = await app.fetch(req);
      expect(response.status).toBe(200);

      const callArgs = mockDoGenerate.mock.calls[0][0];
      expect(callArgs.toolChoice).toEqual({ type: "tool", toolName: "getWeather" });
    });
  });

  describe("streaming tool calls", () => {
    it("should stream tool-input-delta chunks", async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "tool-input-start", id: "call_1", toolName: "getWeather" });
          controller.enqueue({ type: "tool-input-delta", id: "call_1", delta: '{"city":"' });
          controller.enqueue({ type: "tool-input-delta", id: "call_1", delta: 'NYC"}' });
          controller.enqueue({ type: "tool-input-end", id: "call_1" });
          controller.enqueue({ type: "finish", finishReason: "tool-calls", usage: { inputTokens: 5, outputTokens: 3 } });
          controller.close();
        },
      });
      mockDoStream.mockResolvedValueOnce({ stream });

      const req = new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          messages: [{ role: "user", content: "weather?" }],
          stream: true,
        }),
      });

      const response = await app.fetch(req);
      const reader = response.body?.getReader();
      const chunks: string[] = [];
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(new TextDecoder().decode(value));
        }
      }

      const fullContent = chunks.join("");
      expect(fullContent).toContain("tool_calls");
      expect(fullContent).toContain("call_1");
    });
  });

  describe("reasoning support", () => {
    it("plumbs top-level reasoning_effort via providerOptions.augment", async () => {
      mockDoGenerate.mockResolvedValueOnce({
        content: [{ type: "text", text: "ok" }],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      });

      const req = new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          messages: [{ role: "user", content: "hi" }],
          reasoning_effort: "high",
        }),
      });

      const response = await app.fetch(req);
      expect(response.status).toBe(200);

      const callArgs = mockDoGenerate.mock.calls[0][0];
      expect(callArgs.providerOptions).toEqual({
        augment: { reasoningEffort: "high" },
      });
    });

    it("plumbs Responses-API style reasoning {effort, summary} via providerOptions.augment", async () => {
      mockDoGenerate.mockResolvedValueOnce({
        content: [{ type: "text", text: "ok" }],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      });

      const req = new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          messages: [{ role: "user", content: "hi" }],
          reasoning: { effort: "medium", summary: "concise" },
        }),
      });

      const response = await app.fetch(req);
      expect(response.status).toBe(200);

      const callArgs = mockDoGenerate.mock.calls[0][0];
      expect(callArgs.providerOptions).toEqual({
        augment: { reasoningEffort: "medium", reasoningSummary: "concise" },
      });
    });

    it("prefers nested reasoning.effort over top-level reasoning_effort", async () => {
      mockDoGenerate.mockResolvedValueOnce({
        content: [{ type: "text", text: "ok" }],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      });

      const req = new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          messages: [{ role: "user", content: "hi" }],
          reasoning_effort: "low",
          reasoning: { effort: "high" },
        }),
      });

      await app.fetch(req);

      const callArgs = mockDoGenerate.mock.calls[0][0];
      expect(callArgs.providerOptions.augment.reasoningEffort).toBe("high");
    });

    it("omits providerOptions when no reasoning fields are present", async () => {
      mockDoGenerate.mockResolvedValueOnce({
        content: [{ type: "text", text: "ok" }],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      });

      const req = new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          messages: [{ role: "user", content: "hi" }],
        }),
      });

      await app.fetch(req);

      const callArgs = mockDoGenerate.mock.calls[0][0];
      expect(callArgs.providerOptions).toBeUndefined();
    });

    it("surfaces reasoning content in non-streaming message.reasoning_content", async () => {
      mockDoGenerate.mockResolvedValueOnce({
        content: [
          { type: "reasoning", text: "Let me think step by step." },
          { type: "reasoning", text: " The answer is 42." },
          { type: "text", text: "42" },
        ],
        finishReason: "stop",
        usage: { inputTokens: 5, outputTokens: 3 },
      });

      const req = new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          messages: [{ role: "user", content: "what is 6*7?" }],
        }),
      });

      const response = await app.fetch(req);
      const body: any = await response.json();

      expect(response.status).toBe(200);
      expect(body.choices[0].message.content).toBe("42");
      expect(body.choices[0].message.reasoning_content).toBe(
        "Let me think step by step. The answer is 42."
      );
    });

    it("omits message.reasoning_content when the model produces none", async () => {
      mockDoGenerate.mockResolvedValueOnce({
        content: [{ type: "text", text: "hello" }],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      });

      const req = new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          messages: [{ role: "user", content: "hi" }],
        }),
      });

      const response = await app.fetch(req);
      const body: any = await response.json();
      expect(body.choices[0].message.reasoning_content).toBeUndefined();
    });

    it("emits delta.reasoning_content chunks for streaming reasoning-delta parts", async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "reasoning-start", id: "r1" });
          controller.enqueue({ type: "reasoning-delta", id: "r1", delta: "First " });
          controller.enqueue({ type: "reasoning-delta", id: "r1", delta: "thought." });
          controller.enqueue({ type: "reasoning-end", id: "r1" });
          controller.enqueue({ type: "text-start", id: "t1" });
          controller.enqueue({ type: "text-delta", id: "t1", delta: "answer" });
          controller.enqueue({ type: "text-end", id: "t1" });
          controller.enqueue({ type: "finish", finishReason: "stop", usage: { inputTokens: 2, outputTokens: 3 } });
          controller.close();
        },
      });
      mockDoStream.mockResolvedValueOnce({ stream });

      const req = new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
          reasoning_effort: "high",
        }),
      });

      const response = await app.fetch(req);
      const reader = response.body?.getReader();
      const chunks: string[] = [];
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(new TextDecoder().decode(value));
        }
      }
      const fullContent = chunks.join("");

      // Parse SSE data: lines into chunk objects
      const sseChunks = fullContent
        .split("\n\n")
        .map((s) => s.replace(/^data: /, "").trim())
        .filter((s) => s && s !== "[DONE]")
        .map((s) => {
          try { return JSON.parse(s); } catch { return null; }
        })
        .filter((x): x is any => x !== null);

      const reasoningChunks = sseChunks.filter(
        (c) => typeof c.choices?.[0]?.delta?.reasoning_content === "string"
      );
      expect(reasoningChunks.length).toBe(2);
      expect(reasoningChunks[0].choices[0].delta.reasoning_content).toBe("First ");
      expect(reasoningChunks[1].choices[0].delta.reasoning_content).toBe("thought.");

      // Streaming providerOptions should also have been plumbed.
      const streamCallArgs = mockDoStream.mock.calls[0][0];
      expect(streamCallArgs.providerOptions).toEqual({
        augment: { reasoningEffort: "high" },
      });
    });
  });

  describe("reasoning_effort model-ID rewrite", () => {
    // These tests stub out modelRegistry.resolveEffortModelId so they don't
    // depend on whether the host has the auggie CLI installed, and so they
    // can assert the chat route honours whatever the registry returns.
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
      const { default: chatRouter } = await import("../routes/chat");
      app = new Hono();
      app.route("/v1/chat", chatRouter);
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

      const req = new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-opus-4-7",
          messages: [{ role: "user", content: "hi" }],
          reasoning_effort: "high",
        }),
      });

      const response = await app.fetch(req);
      expect(response.status).toBe(200);
      expect(mockResolveEffort).toHaveBeenCalledWith("claude-opus-4-7", "high");
      expect(constructorCalls.at(-1)?.modelId).toBe("claude-opus-4-7-high");
    });

    it("keeps the original model ID when the registry returns undefined (no swap)", async () => {
      mockResolveEffort.mockResolvedValueOnce(undefined);
      mockDoGenerate.mockResolvedValueOnce({
        content: [{ type: "text", text: "ok" }],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      });

      const req = new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-haiku-4-5",
          messages: [{ role: "user", content: "hi" }],
          reasoning_effort: "high",
        }),
      });

      const response = await app.fetch(req);
      expect(response.status).toBe(200);
      expect(constructorCalls.at(-1)?.modelId).toBe("claude-haiku-4-5");
    });

    it("does not consult the registry when no reasoning_effort is set", async () => {
      mockDoGenerate.mockResolvedValueOnce({
        content: [{ type: "text", text: "ok" }],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      });

      const req = new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-opus-4-7",
          messages: [{ role: "user", content: "hi" }],
        }),
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

      const req = new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-opus-4-7",
          messages: [{ role: "user", content: "hi" }],
          reasoning_effort: "high",
        }),
      });

      const body: any = await (await app.fetch(req)).json();
      expect(body.model).toBe("claude-opus-4-7");
    });
  });
});
