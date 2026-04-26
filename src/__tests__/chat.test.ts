import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

// ── Mock the SDK at the top level ─────────────────────────────
const mockResolveCredentials = vi.fn();
const mockDoGenerate = vi.fn();
const mockDoStream = vi.fn();

// Use a class-based mock so it works with `new AugmentLanguageModel(...)`
class MockAugmentLanguageModel {
  constructor(_modelId: string, _options: object) {
    // Track constructor calls if needed
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
          model: "gpt-4",
          messages: [{ role: "user", content: "hello" }],
        }),
      });

      const response = await app.fetch(req);
      const body: any = await response.json();

      expect(response.status).toBe(404);
      expect(body.error.message).toContain("gpt-4");
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
      const mockReader = {
        read: vi.fn().mockResolvedValue({ done: true, value: undefined }),
        releaseLock: vi.fn(),
      };

      mockDoStream.mockResolvedValueOnce({
        stream: { getReader: () => mockReader },
      });

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
      const mockReader = {
        read: vi.fn()
          .mockResolvedValueOnce({ done: false, value: { type: "text-delta", delta: "Hello" } })
          .mockResolvedValueOnce({ done: false, value: { type: "text-delta", delta: " world" } })
          .mockResolvedValueOnce({ done: true, value: undefined }),
        releaseLock: vi.fn(),
      };

      mockDoStream.mockResolvedValueOnce({
        stream: { getReader: () => mockReader },
      });

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
      const mockReader = {
        read: vi.fn().mockRejectedValue(new Error("Stream interrupted")),
        releaseLock: vi.fn(),
      };

      mockDoStream.mockResolvedValueOnce({
        stream: { getReader: () => mockReader },
      });

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
      const body: any = await response.json();

      expect(response.status).toBe(500);
      expect(body.error.message).toBe("Failed to connect");
    });
  });

  describe("finish reason mapping", () => {
    it("should map stop finish reason", async () => {
      mockDoGenerate.mockResolvedValueOnce({
        content: [{ type: "text", text: "Done" }],
        finishReason: "stop",
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
      const mockReader = {
        read: vi.fn()
          .mockResolvedValueOnce({
            done: false,
            value: { type: "tool-input-delta", delta: '{"city":"', id: "call_1" },
          })
          .mockResolvedValueOnce({ done: true, value: undefined }),
        releaseLock: vi.fn(),
      };

      mockDoStream.mockResolvedValueOnce({
        stream: { getReader: () => mockReader },
      });

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
});
