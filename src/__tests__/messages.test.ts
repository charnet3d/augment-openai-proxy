import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";

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

vi.mock("node:child_process", () => ({
  execFile: vi.fn((_cmd: string, _args: string[], _opts: object, cb: Function) =>
    cb(new Error("auggie not available in test environment"), "")
  ),
}));

// Helper: parse Anthropic SSE wire format into the JSON payloads.
function parseSse(raw: string): any[] {
  return raw
    .split("\n\n")
    .filter((s) => s.trim().length > 0)
    .map((block) => {
      const dataLine = block
        .split("\n")
        .find((l) => l.startsWith("data: "));
      if (!dataLine) return null;
      try {
        return JSON.parse(dataLine.slice(6));
      } catch {
        return null;
      }
    })
    .filter((x): x is any => x !== null);
}

describe("messages route (Anthropic API)", () => {
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

    const { default: messagesRouter } = await import("../routes/messages");
    app = new Hono();
    app.route("/v1/messages", messagesRouter);
  });

  describe("validation", () => {
    it("rejects request with missing model", async () => {
      const req = new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], max_tokens: 10 }),
      });
      const res = await app.fetch(req);
      const body: any = await res.json();
      expect(res.status).toBe(400);
      expect(body.error.message).toContain("model");
    });

    it("rejects unknown non-claude/gpt/gemini model", async () => {
      const req = new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "llama-2",
          max_tokens: 10,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      const res = await app.fetch(req);
      expect(res.status).toBe(404);
    });

    it("accepts canonical claude IDs even when registry is empty", async () => {
      mockDoGenerate.mockResolvedValueOnce({
        content: [{ type: "text", text: "hi" }],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      });
      const req = new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 100,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      const res = await app.fetch(req);
      expect(res.status).toBe(200);
    });

    it("strips Anthropic dated snapshot suffix before instantiating the model", async () => {
      // Claude Code sends dated IDs like `claude-haiku-4-5-20251001`. The
      // backend only knows the undated form, so the proxy must normalise.
      mockDoGenerate.mockResolvedValueOnce({
        content: [{ type: "text", text: "hi" }],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      });
      const req = new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 100,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      const res = await app.fetch(req);
      expect(res.status).toBe(200);
      // The SDK receives the canonical ID, not the dated one.
      expect(constructorCalls.at(-1)?.modelId).toBe("claude-haiku-4-5");
    });

    it("echoes the dated ID in the response body", async () => {
      mockDoGenerate.mockResolvedValueOnce({
        content: [{ type: "text", text: "hi" }],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      });
      const req = new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 100,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      const body: any = await (await app.fetch(req)).json();
      expect(body.model).toBe("claude-haiku-4-5-20251001");
    });

    it("rejects request whose last message is an assistant message", async () => {
      // The Augment SDK serialises a trailing-assistant conversation to an
      // empty current message, which the upstream backend rejects with
      // `400 Bad Request - {"error":"Unidentified internal error"}`. The
      // proxy must short-circuit before issuing the upstream call. This also
      // disallows Anthropic-style assistant prefill, which the backend has
      // no equivalent affordance for.
      const req = new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          max_tokens: 100,
          messages: [
            { role: "user", content: "Say hi" },
            { role: "assistant", content: "Hi" },
          ],
        }),
      });

      const res = await app.fetch(req);
      const body: any = await res.json();

      expect(res.status).toBe(400);
      expect(body.error.type).toBe("invalid_request_error");
      expect(body.error.message).toContain("assistant");
      expect(mockDoGenerate).not.toHaveBeenCalled();
      expect(mockDoStream).not.toHaveBeenCalled();
    });

    it("rejects trailing-assistant even when stream=true", async () => {
      const req = new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          max_tokens: 100,
          stream: true,
          messages: [
            { role: "user", content: "hi" },
            { role: "assistant", content: "hello" },
          ],
        }),
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(400);
      expect(mockDoStream).not.toHaveBeenCalled();
    });
  });

  describe("non-streaming response", () => {
    it("returns Anthropic-shaped message envelope", async () => {
      mockDoGenerate.mockResolvedValueOnce({
        content: [{ type: "text", text: "Hello!" }],
        text: "Hello!",
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 5 },
      });

      const req = new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          max_tokens: 100,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      const res = await app.fetch(req);
      const body: any = await res.json();

      expect(res.status).toBe(200);
      expect(body.type).toBe("message");
      expect(body.role).toBe("assistant");
      expect(body.id).toMatch(/^msg_/);
      expect(body.model).toBe("claude-sonnet-4-5");
      expect(body.content).toEqual([{ type: "text", text: "Hello!" }]);
      expect(body.stop_reason).toBe("end_turn");
      expect(body.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
    });

    it("emits tool_use blocks and stop_reason=tool_use", async () => {
      mockDoGenerate.mockResolvedValueOnce({
        content: [
          { type: "tool-call", toolCallId: "call_1", toolName: "getWeather", input: { city: "NYC" } },
        ],
        finishReason: "tool-calls",
        usage: { inputTokens: 7, outputTokens: 4 },
      });

      const req = new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          max_tokens: 100,
          messages: [{ role: "user", content: "weather?" }],
          tools: [
            {
              name: "getWeather",
              description: "Get weather",
              input_schema: { type: "object", properties: { city: { type: "string" } } },
            },
          ],
        }),
      });
      const res = await app.fetch(req);
      const body: any = await res.json();

      expect(res.status).toBe(200);
      expect(body.stop_reason).toBe("tool_use");
      const toolBlock = body.content.find((b: any) => b.type === "tool_use");
      expect(toolBlock).toEqual({
        type: "tool_use",
        id: "call_1",
        name: "getWeather",
        input: { city: "NYC" },
      });
    });

    it("emits thinking blocks before text from reasoning parts", async () => {
      mockDoGenerate.mockResolvedValueOnce({
        content: [
          { type: "reasoning", text: "Thinking..." },
          { type: "text", text: "42" },
        ],
        finishReason: "stop",
        usage: { inputTokens: 5, outputTokens: 3 },
      });

      const req = new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          max_tokens: 100,
          messages: [{ role: "user", content: "what is 6*7?" }],
        }),
      });
      const res = await app.fetch(req);
      const body: any = await res.json();

      expect(body.content[0]).toEqual({ type: "thinking", thinking: "Thinking..." });
      expect(body.content[1]).toEqual({ type: "text", text: "42" });
    });

    it("maps length finish reason to max_tokens", async () => {
      mockDoGenerate.mockResolvedValueOnce({
        content: [{ type: "text", text: "..." }],
        finishReason: "length",
        usage: { inputTokens: 1, outputTokens: 100 },
      });

      const req = new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          max_tokens: 100,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      const res = await app.fetch(req);
      const body: any = await res.json();
      expect(body.stop_reason).toBe("max_tokens");
    });

    it("recovers from a tool_use input that is a non-JSON string", async () => {
      mockDoGenerate.mockResolvedValueOnce({
        content: [
          { type: "tool-call", toolCallId: "c1", toolName: "fn", input: "not-json" },
        ],
        finishReason: "tool-calls",
        usage: { inputTokens: 1, outputTokens: 1 },
      });
      const req = new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          max_tokens: 100,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      const body: any = await (await app.fetch(req)).json();
      const tu = body.content.find((b: any) => b.type === "tool_use");
      // safeParse keeps the original string when JSON.parse throws.
      expect(tu.input).toBe("not-json");
    });

    it("returns server_error envelope on generation failure", async () => {
      mockDoGenerate.mockRejectedValueOnce(new Error("boom"));
      const req = new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          max_tokens: 100,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      const res = await app.fetch(req);
      const body: any = await res.json();
      expect(res.status).toBe(500);
      expect(body.error.type).toBe("server_error");
    });
  });

  describe("system prompt", () => {
    it("forwards string system prompt as system message", async () => {
      mockDoGenerate.mockResolvedValueOnce({
        content: [{ type: "text", text: "ok" }],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      });
      const req = new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          max_tokens: 100,
          system: "You are helpful.",
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      await app.fetch(req);
      const callArgs = mockDoGenerate.mock.calls[0][0];
      const sysMsg = callArgs.prompt.find((m: any) => m.role === "system");
      expect(sysMsg).toBeDefined();
      expect(sysMsg.content).toContain("You are helpful.");
    });

    it("flattens array system prompt to text", async () => {
      mockDoGenerate.mockResolvedValueOnce({
        content: [{ type: "text", text: "ok" }],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      });
      const req = new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          max_tokens: 100,
          system: [
            { type: "text", text: "Part A. " },
            { type: "text", text: "Part B." },
          ],
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      await app.fetch(req);
      const callArgs = mockDoGenerate.mock.calls[0][0];
      const sysMsg = callArgs.prompt.find((m: any) => m.role === "system");
      expect(sysMsg.content).toBe("Part A. Part B.");
    });
  });

  describe("streaming response", () => {
    it("emits the Anthropic SSE event sequence", async () => {
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

      const req = new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          max_tokens: 100,
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }),
      });
      const res = await app.fetch(req);

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("text/event-stream");

      const reader = res.body?.getReader();
      const chunks: string[] = [];
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(new TextDecoder().decode(value));
        }
      }
      const events = parseSse(chunks.join(""));
      const types = events.map((e) => e.type);

      expect(types[0]).toBe("message_start");
      expect(types).toContain("content_block_start");
      expect(types).toContain("content_block_delta");
      expect(types).toContain("content_block_stop");
      expect(types).toContain("message_delta");
      expect(types[types.length - 1]).toBe("message_stop");

      const deltas = events.filter((e) => e.type === "content_block_delta");
      const textDeltas = deltas
        .filter((e) => e.delta?.type === "text_delta")
        .map((e) => e.delta.text)
        .join("");
      expect(textDeltas).toBe("Hello world");

      const messageDelta = events.find((e) => e.type === "message_delta");
      expect(messageDelta.delta.stop_reason).toBe("end_turn");
      expect(messageDelta.usage.output_tokens).toBe(2);
    });

    it("emits tool_use stream events with input_json_delta", async () => {
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

      const req = new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          max_tokens: 100,
          messages: [{ role: "user", content: "weather?" }],
          stream: true,
        }),
      });
      const res = await app.fetch(req);
      const reader = res.body?.getReader();
      const chunks: string[] = [];
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(new TextDecoder().decode(value));
        }
      }
      const events = parseSse(chunks.join(""));

      const start = events.find((e) => e.type === "content_block_start");
      expect(start.content_block.type).toBe("tool_use");
      expect(start.content_block.name).toBe("getWeather");
      expect(start.content_block.id).toBe("call_1");

      const jsonDeltas = events
        .filter((e) => e.type === "content_block_delta" && e.delta?.type === "input_json_delta")
        .map((e) => e.delta.partial_json)
        .join("");
      expect(jsonDeltas).toBe('{"city":"NYC"}');

      const messageDelta = events.find((e) => e.type === "message_delta");
      expect(messageDelta.delta.stop_reason).toBe("tool_use");
    });

    it("emits a stream_error when upstream closes with no parts", async () => {
      // Reproduces the empty-response failure mode observed in production: the
      // upstream SSE connection closes cleanly without yielding text, tool, or
      // finish events. Without the guard the proxy used to emit a clean
      // stop_reason=end_turn with zero tokens, which clients read as a valid
      // empty completion.
      const stream = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });
      mockDoStream.mockResolvedValueOnce({ stream });

      const req = new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          max_tokens: 100,
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }),
      });
      const res = await app.fetch(req);
      const reader = res.body?.getReader();
      const chunks: string[] = [];
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(new TextDecoder().decode(value));
        }
      }
      const events = parseSse(chunks.join(""));
      const errorEvent = events.find((e) => e.type === "error");
      expect(errorEvent).toBeDefined();
      expect(errorEvent.error.type).toBe("stream_error");
      expect(errorEvent.error.message).toMatch(/no.*content|empty|without producing/i);
      // The stream still terminates cleanly so SSE consumers exit.
      expect(events[events.length - 1].type).toBe("message_stop");
    });

    it("closes the open text block when a reasoning-delta arrives mid-stream", async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "text-start", id: "t1" });
          controller.enqueue({ type: "text-delta", id: "t1", delta: "Hello" });
          controller.enqueue({ type: "reasoning-start", id: "r1" });
          controller.enqueue({ type: "reasoning-delta", id: "r1", delta: "wait" });
          controller.enqueue({ type: "reasoning-end", id: "r1" });
          controller.enqueue({ type: "text-start", id: "t2" });
          controller.enqueue({ type: "text-delta", id: "t2", delta: " world" });
          controller.enqueue({ type: "text-end", id: "t2" });
          controller.enqueue({ type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 2 } });
          controller.close();
        },
      });
      mockDoStream.mockResolvedValueOnce({ stream });

      const req = new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          max_tokens: 100,
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }),
      });
      const res = await app.fetch(req);
      const reader = res.body!.getReader();
      const chunks: string[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(new TextDecoder().decode(value));
      }
      const events = parseSse(chunks.join(""));
      // Sequence per index: text(0) start → delta → stop, thinking(1) start →
      // delta → stop, text(2) start → delta → stop.
      const startIndices = events.filter((e) => e.type === "content_block_start").map((e) => e.index);
      expect(startIndices).toEqual([0, 1, 2]);
      const stopIndices = events.filter((e) => e.type === "content_block_stop").map((e) => e.index);
      expect(stopIndices).toContain(0);
      expect(stopIndices).toContain(1);
    });

    it("closes both text and thinking blocks when a tool-input-start arrives", async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "text-start", id: "t1" });
          controller.enqueue({ type: "text-delta", id: "t1", delta: "before" });
          controller.enqueue({ type: "reasoning-start", id: "r1" });
          controller.enqueue({ type: "reasoning-delta", id: "r1", delta: "ponder" });
          controller.enqueue({ type: "tool-input-start", id: "call_1", toolName: "fn" });
          controller.enqueue({ type: "tool-input-delta", id: "call_1", delta: "{}" });
          controller.enqueue({ type: "tool-input-end", id: "call_1" });
          controller.enqueue({ type: "finish", finishReason: "tool-calls", usage: { inputTokens: 1, outputTokens: 1 } });
          controller.close();
        },
      });
      mockDoStream.mockResolvedValueOnce({ stream });

      const req = new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          max_tokens: 100,
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }),
      });
      const res = await app.fetch(req);
      const reader = res.body!.getReader();
      const chunks: string[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(new TextDecoder().decode(value));
      }
      const events = parseSse(chunks.join(""));
      // The text block (idx 0) and thinking block (idx 1) must both be closed
      // before the tool_use block opens (idx 2).
      const stops = events
        .filter((e) => e.type === "content_block_stop")
        .map((e) => e.index);
      expect(stops).toEqual(expect.arrayContaining([0, 1, 2]));
      const last = events.find((e) => e.type === "message_delta");
      expect(last.delta.stop_reason).toBe("tool_use");
    });

    it("ignores tool-input-delta events whose id has no open block", async () => {
      const stream = new ReadableStream({
        start(controller) {
          // No tool-input-start, so the orphan delta has nowhere to go.
          controller.enqueue({ type: "tool-input-delta", id: "ghost", delta: "{}" });
          controller.enqueue({ type: "text-start", id: "t1" });
          controller.enqueue({ type: "text-delta", id: "t1", delta: "ok" });
          controller.enqueue({ type: "text-end", id: "t1" });
          controller.enqueue({ type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } });
          controller.close();
        },
      });
      mockDoStream.mockResolvedValueOnce({ stream });

      const req = new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          max_tokens: 100,
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }),
      });
      const res = await app.fetch(req);
      const reader = res.body!.getReader();
      const chunks: string[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(new TextDecoder().decode(value));
      }
      const events = parseSse(chunks.join(""));
      // The orphan delta produces no input_json_delta, only the text path emits.
      const inputDeltas = events.filter(
        (e) => e.type === "content_block_delta" && e.delta?.type === "input_json_delta",
      );
      expect(inputDeltas).toHaveLength(0);
    });

    it("catches a thrown error during stream iteration and emits stream_error", async () => {
      // The stream rejects mid-iteration — exercises the try/catch around the
      // for-await loop in handleStreaming.
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "text-start", id: "t1" });
          controller.enqueue({ type: "text-delta", id: "t1", delta: "ok" });
          controller.enqueue({ type: "text-end", id: "t1" });
          controller.error(new Error("upstream socket reset"));
        },
      });
      mockDoStream.mockResolvedValueOnce({ stream });

      const req = new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          max_tokens: 100,
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }),
      });
      const res = await app.fetch(req);
      const reader = res.body!.getReader();
      const chunks: string[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(new TextDecoder().decode(value));
      }
      const events = parseSse(chunks.join(""));
      const err = events.find((e) => e.type === "error");
      expect(err).toBeDefined();
      expect(err.error.type).toBe("stream_error");
    });

    it("propagates an upstream error part as an SSE error event", async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "text-start", id: "t1" });
          controller.enqueue({ type: "text-delta", id: "t1", delta: "partial" });
          controller.enqueue({ type: "text-end", id: "t1" });
          controller.enqueue({ type: "error", error: new Error("upstream rejected") });
          // Still emit a finish so the empty-stream guard does not fire.
          controller.enqueue({ type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } });
          controller.close();
        },
      });
      mockDoStream.mockResolvedValueOnce({ stream });

      const req = new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          max_tokens: 100,
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }),
      });
      const res = await app.fetch(req);
      const reader = res.body!.getReader();
      const chunks: string[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(new TextDecoder().decode(value));
      }
      const events = parseSse(chunks.join(""));
      const err = events.find((e) => e.type === "error");
      expect(err).toBeDefined();
      expect(err.error.type).toBe("stream_error");
      expect(err.error.message).toBe("upstream rejected");
    });

    it("emits thinking_delta events for reasoning-delta parts", async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "reasoning-start", id: "r1" });
          controller.enqueue({ type: "reasoning-delta", id: "r1", delta: "Step 1." });
          controller.enqueue({ type: "reasoning-end", id: "r1" });
          controller.enqueue({ type: "text-start", id: "t1" });
          controller.enqueue({ type: "text-delta", id: "t1", delta: "answer" });
          controller.enqueue({ type: "text-end", id: "t1" });
          controller.enqueue({ type: "finish", finishReason: "stop", usage: { inputTokens: 2, outputTokens: 3 } });
          controller.close();
        },
      });
      mockDoStream.mockResolvedValueOnce({ stream });

      const req = new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          max_tokens: 100,
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }),
      });
      const res = await app.fetch(req);
      const reader = res.body?.getReader();
      const chunks: string[] = [];
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(new TextDecoder().decode(value));
        }
      }
      const events = parseSse(chunks.join(""));
      const thinkingDelta = events.find(
        (e) => e.type === "content_block_delta" && e.delta?.type === "thinking_delta"
      );
      expect(thinkingDelta.delta.thinking).toBe("Step 1.");
    });
  });

  describe("top-level error handling", () => {
    it("returns a 500 envelope when the request body is not valid JSON", async () => {
      const req = new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      });
      const res = await app.fetch(req);
      const body: any = await res.json();
      expect(res.status).toBe(500);
      expect(body.error).toBeDefined();
    });
  });

  describe("count_tokens", () => {
    it("returns a 500 envelope when the request body is not valid JSON", async () => {
      const req = new Request("http://localhost/v1/messages/count_tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{nope",
      });
      const res = await app.fetch(req);
      expect(res.status).toBe(500);
    });

    it("returns an estimated input_tokens value", async () => {
      const req = new Request("http://localhost/v1/messages/count_tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          messages: [{ role: "user", content: "hello world" }],
        }),
      });
      const res = await app.fetch(req);
      const body: any = await res.json();
      expect(res.status).toBe(200);
      expect(typeof body.input_tokens).toBe("number");
      expect(body.input_tokens).toBeGreaterThan(0);
    });
  });

  describe("thinking → reasoning_effort model swap", () => {
    let mockResolveEffort: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      mockResolveEffort = vi.fn();
      vi.doMock("../services/modelRegistry", async () => {
        const actual = await vi.importActual<typeof import("../services/modelRegistry")>(
          "../services/modelRegistry"
        );
        return { ...actual, resolveEffortModelId: mockResolveEffort };
      });
      vi.resetModules();
      const { default: messagesRouter } = await import("../routes/messages");
      app = new Hono();
      app.route("/v1/messages", messagesRouter);
    });

    afterEach(() => {
      vi.doUnmock("../services/modelRegistry");
    });

    it("instantiates the suffixed model when thinking is enabled", async () => {
      mockResolveEffort.mockResolvedValueOnce("claude-opus-4-7-high");
      mockDoGenerate.mockResolvedValueOnce({
        content: [{ type: "text", text: "ok" }],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      });

      const req = new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-opus-4-7",
          max_tokens: 100,
          messages: [{ role: "user", content: "hi" }],
          thinking: { type: "enabled", budget_tokens: 32000 },
        }),
      });

      const res = await app.fetch(req);
      expect(res.status).toBe(200);
      expect(mockResolveEffort).toHaveBeenCalledWith("claude-opus-4-7", "high");
      expect(constructorCalls.at(-1)?.modelId).toBe("claude-opus-4-7-high");
    });

    it("preserves the original model in the response body", async () => {
      mockResolveEffort.mockResolvedValueOnce("claude-opus-4-7-high");
      mockDoGenerate.mockResolvedValueOnce({
        content: [{ type: "text", text: "ok" }],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      });

      const req = new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-opus-4-7",
          max_tokens: 100,
          messages: [{ role: "user", content: "hi" }],
          thinking: { type: "enabled", budget_tokens: 32000 },
        }),
      });

      const body: any = await (await app.fetch(req)).json();
      expect(body.model).toBe("claude-opus-4-7");
    });
  });
});
