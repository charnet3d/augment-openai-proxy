/**
 * Tests for the transformation helpers in src/utils/transformers.ts.
 * 
 * These test the pure transformation logic directly without HTTP overhead.
 */
import { describe, it, expect } from "vitest";
import {
  transformMessages,
  transformTools,
  transformToolChoice,
  mapFinishReason,
  safeJsonParse,
} from "../utils/transformers";
import type { ChatCompletionMessage } from "../types/openai";

// ── Tests ─────────────────────────────────────────────────────

describe("safeJsonParse", () => {
  it("should parse valid JSON", () => {
    expect(safeJsonParse('{"key": "value"}')).toEqual({ key: "value" });
  });

  it("should return original string on parse failure", () => {
    expect(safeJsonParse("not valid json")).toBe("not valid json");
  });

  it("should parse numbers", () => {
    expect(safeJsonParse("42")).toBe(42);
  });

  it("should parse arrays", () => {
    expect(safeJsonParse('[1, 2, 3]')).toEqual([1, 2, 3]);
  });
});

describe("transformMessages", () => {
  it("should transform user message with text content", () => {
    const result = transformMessages([
      { role: "user", content: "Hello" },
    ]);

    expect(result).toEqual([
      { role: "user", content: "Hello" },
    ]);
  });

  it("should transform user message with null content", () => {
    const result = transformMessages([
      { role: "user", content: null },
    ]);

    expect(result).toEqual([{ role: "user", content: "" }]);
  });

  it("should transform system message as plain string content", () => {
    const result = transformMessages([
      { role: "system", content: "You are helpful." },
    ]);

    expect(result).toEqual([
      { role: "system", content: "You are helpful." },
    ]);
  });

  it("should transform system message with null content to empty string", () => {
    const result = transformMessages([
      { role: "system", content: null },
    ]);

    expect(result).toEqual([{ role: "system", content: "" }]);
  });

  it("should transform assistant message with text content", () => {
    const result = transformMessages([
      { role: "assistant", content: "I can help with that." },
    ]);

    expect(result).toEqual([
      {
        role: "assistant",
        content: "I can help with that.",
      },
    ]);
  });

  it("should transform assistant message with tool calls", () => {
    const result = transformMessages([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_123",
            type: "function",
            function: {
              name: "getWeather",
              arguments: '{"city":"NYC"}',
            },
          },
        ],
      },
    ]);

    expect(result).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call_123",
            toolName: "getWeather",
            input: { city: "NYC" },
          },
        ],
      },
    ]);
  });

  it("should handle malformed JSON in tool call arguments gracefully", () => {
    const result = transformMessages([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_123",
            type: "function",
            function: {
              name: "getWeather",
              arguments: "not valid json",
            },
          },
        ],
      },
    ]);

    expect((result[0].content as any[])[0].input).toBe("not valid json");
  });

  it("should transform assistant message with both text and tool calls", () => {
    const result = transformMessages([
      {
        role: "assistant",
        content: "Let me check the weather.",
        tool_calls: [
          {
            id: "call_123",
            type: "function",
            function: {
              name: "getWeather",
              arguments: '{"city":"NYC"}',
            },
          },
        ],
      },
    ]);

    expect(result).toEqual([
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check the weather." },
          {
            type: "tool-call",
            toolCallId: "call_123",
            toolName: "getWeather",
            input: { city: "NYC" },
          },
        ],
      },
    ]);
  });

  it("should transform tool result message with tool-result part", () => {
    const result = transformMessages([
      {
        role: "tool",
        content: '{"temp": 72}',
        tool_call_id: "call_123",
        name: "getWeather",
      },
    ]);

    expect(result).toEqual([
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_123",
            toolName: "getWeather",
            output: { type: "text", value: '{"temp": 72}' },
          },
        ],
      },
    ]);
  });

  it("should handle tool message with missing tool_call_id", () => {
    const result = transformMessages([
      {
        role: "tool",
        content: "result",
        name: "someTool",
      },
    ]);

    expect(result).toEqual([
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "",
            toolName: "someTool",
            output: { type: "text", value: "result" },
          },
        ],
      },
    ]);
  });

  it("should handle a full conversation with multiple message types", () => {
    const result = transformMessages([
      { role: "system", content: "You are an assistant." },
      { role: "user", content: "What's the weather in NYC?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "getWeather", arguments: '{"city":"NYC"}' },
          },
        ],
      },
      {
        role: "tool",
        content: '{"temp": 72, "unit": "F"}',
        tool_call_id: "call_1",
        name: "getWeather",
      },
      { role: "assistant", content: "It's 72°F in NYC." },
    ]);

    expect(result).toHaveLength(5);
    expect(result[0]).toEqual({ role: "system", content: "You are an assistant." });
    expect(result[1]).toEqual({ role: "user", content: "What's the weather in NYC?" });
    expect((result[2] as any).content[0].type).toBe("tool-call");
    expect((result[3] as any).role).toBe("tool");
    expect((result[3] as any).content[0].type).toBe("tool-result");
    expect((result[4] as any).content).toBe("It's 72°F in NYC.");
  });
});

describe("transformTools", () => {
  it("should return undefined for empty tools array", () => {
    expect(transformTools([])).toBeUndefined();
  });

  it("should return undefined for undefined tools", () => {
    expect(transformTools(undefined)).toBeUndefined();
  });

  it("should transform a single function tool into a Record by name", () => {
    const result = transformTools([
      {
        type: "function",
        function: {
          name: "getWeather",
          description: "Get the weather",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
          },
        },
      },
    ]) as Record<string, any>;

    expect(result).toBeDefined();
    expect(result["getWeather"]).toBeDefined();
    expect(result["getWeather"].description).toBe("Get the weather");
    // inputSchema is wrapped by jsonSchema() — check the inner JSON schema
    expect(result["getWeather"].inputSchema.jsonSchema).toEqual({
      type: "object",
      properties: { city: { type: "string" } },
    });
  });

  it("should handle tool without description", () => {
    const result = transformTools([
      {
        type: "function",
        function: {
          name: "simple",
          parameters: {},
        },
      },
    ]) as Record<string, any>;

    expect(result).toBeDefined();
    expect(result["simple"]).toBeDefined();
    expect(result["simple"].description).toBeUndefined();
    expect(result["simple"].inputSchema.jsonSchema).toEqual({});
  });

  it("should handle multiple tools", () => {
    const result = transformTools([
      {
        type: "function",
        function: { name: "tool1", parameters: {} },
      },
      {
        type: "function",
        function: { name: "tool2", parameters: {} },
      },
    ]) as Record<string, any>;

    expect(result).toBeDefined();
    expect(result["tool1"]).toBeDefined();
    expect(result["tool2"]).toBeDefined();
    expect(Object.keys(result)).toHaveLength(2);
  });
});

describe("transformToolChoice", () => {
  it("should return undefined for undefined input", () => {
    expect(transformToolChoice(undefined)).toBeUndefined();
  });

  it("should pass through 'none' as a string", () => {
    expect(transformToolChoice("none")).toBe("none");
  });

  it("should pass through 'auto' as a string", () => {
    expect(transformToolChoice("auto")).toBe("auto");
  });

  it("should pass through 'required' as a string", () => {
    expect(transformToolChoice("required")).toBe("required");
  });

  it("should transform object tool_choice with function name", () => {
    expect(transformToolChoice({ type: "function", function: { name: "getWeather" } })).toEqual({
      type: "tool",
      toolName: "getWeather",
    });
  });
});

describe("mapFinishReason", () => {
  it("should pass through 'stop'", () => {
    expect(mapFinishReason("stop")).toBe("stop");
  });

  it("should pass through 'length'", () => {
    expect(mapFinishReason("length")).toBe("length");
  });

  it("should pass through 'tool_calls'", () => {
    expect(mapFinishReason("tool_calls")).toBe("tool_calls");
  });

  it("should pass through 'content_filter'", () => {
    expect(mapFinishReason("content_filter")).toBe("content_filter");
  });

  it("should map 'tool-calls' to 'tool_calls'", () => {
    expect(mapFinishReason("tool-calls")).toBe("tool_calls");
  });

  it("should map 'content-filter' to 'content_filter'", () => {
    expect(mapFinishReason("content-filter")).toBe("content_filter");
  });

  it("should default 'error' to 'stop'", () => {
    expect(mapFinishReason("error")).toBe("stop");
  });

  it("should default undefined to 'stop'", () => {
    expect(mapFinishReason(undefined)).toBe("stop");
  });

  it("should default unknown values to 'stop'", () => {
    expect(mapFinishReason("unknown-reason")).toBe("stop");
  });
});
