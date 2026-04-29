import { jsonSchema } from "ai";
import type {
  ChatCompletionRequest,
  ChatCompletionMessage,
  ChatCompletionResponse,
  ErrorResponse,
} from "../types/openai";

// ---------------------------------------------------------------------------
// Inline types that mirror the shapes expected by generateText / streamText
// (avoids importing complex generic types from the ai package directly).
// ---------------------------------------------------------------------------

type AiTextPart = { type: "text"; text: string };
type AiToolCallPart = {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  // AI SDK v5 renamed `args` → `input`.
  input: unknown;
};
type AiToolResultPart = {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  // AI SDK v5: structured output instead of a raw string.
  output: { type: "text"; value: string } | { type: "json"; value: unknown };
};

export type CoreMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | Array<AiTextPart | AiToolCallPart> }
  | { role: "tool"; content: AiToolResultPart[] };

export type CoreTool = {
  description?: string;
  // AI SDK v5 uses `inputSchema` (not `parameters`) to hold the JSON schema.
  // The field must be wrapped with jsonSchema() so asSchema() can resolve it.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inputSchema: ReturnType<typeof jsonSchema<any>>;
};

export type CoreToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "tool"; toolName: string };

/**
 * Parse JSON safely, falling back to the original string on failure.
 */
export function safeJsonParse(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

/**
 * Transform OpenAI messages to AI SDK CoreMessage format.
 *
 * - tool role messages need the toolName resolved from preceding assistant
 *   messages (OpenAI omits it; the AI SDK requires it).
 */
export function transformMessages(messages: ChatCompletionMessage[]): CoreMessage[] {
  // Pre-scan: build tool_call_id → toolName lookup
  const toolCallIdToName = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role === "assistant" && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        toolCallIdToName.set(tc.id, tc.function.name);
      }
    }
  }

  return messages.flatMap((msg): CoreMessage[] => {
    switch (msg.role) {
      case "system":
        return [{ role: "system", content: msg.content ?? "" }];

      case "user":
        return [{ role: "user", content: msg.content ?? "" }];

      case "assistant": {
        if (!msg.tool_calls?.length) {
          return [{ role: "assistant", content: msg.content ?? "" }];
        }
        const parts: Array<AiTextPart | AiToolCallPart> = [];
        if (msg.content) {
          parts.push({ type: "text", text: msg.content });
        }
        for (const tc of msg.tool_calls) {
          parts.push({
            type: "tool-call",
            toolCallId: tc.id,
            toolName: tc.function.name,
            input:
              typeof tc.function.arguments === "string"
                ? safeJsonParse(tc.function.arguments)
                : tc.function.arguments,
          });
        }
        return [{ role: "assistant", content: parts }];
      }

      case "tool":
        return [
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: msg.tool_call_id ?? "",
                // Resolve toolName from the preceding assistant message
                toolName:
                  toolCallIdToName.get(msg.tool_call_id ?? "") ??
                  msg.name ??
                  "unknown",
                output: { type: "text", value: msg.content ?? "" },
              },
            ],
          },
        ];

      default:
        return [{ role: "user", content: msg.content ?? "" }];
    }
  });
}

/**
 * Transform OpenAI tools to a Record<name, CoreTool> for generateText / streamText.
 * Tools have no `execute` — we are a proxy, tool execution happens on the client.
 */
export function transformTools(
  tools?: ChatCompletionRequest["tools"]
): Record<string, CoreTool> | undefined {
  if (!tools?.length) return undefined;

  const result: Record<string, CoreTool> = {};
  for (const t of tools) {
    if (t.type === "function") {
      result[t.function.name] = {
        description: t.function.description,
        // AI SDK v5: use `inputSchema` (not `parameters`). Must be wrapped
        // with jsonSchema() so the SDK resolves it to the raw JSON Schema.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        inputSchema: jsonSchema(t.function.parameters as any),
      };
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Transform OpenAI tool_choice to AI SDK CoreToolChoice.
 */
export function transformToolChoice(
  toolChoice?: ChatCompletionRequest["tool_choice"]
): CoreToolChoice | undefined {
  if (!toolChoice) return undefined;
  if (toolChoice === "none") return "none";
  if (toolChoice === "auto") return "auto";
  if (toolChoice === "required") return "required";
  if (typeof toolChoice === "object" && toolChoice.type === "function") {
    return { type: "tool", toolName: toolChoice.function.name };
  }
  return undefined;
}

/**
 * Map AI SDK finish reason to OpenAI finish_reason.
 */
export function mapFinishReason(
  reason: string | undefined
): NonNullable<ChatCompletionResponse["choices"][number]["finish_reason"]> {
  switch (reason) {
    case "stop":
    case "length":
    case "tool_calls":
    case "content_filter":
      return reason;
    case "tool-calls":
      return "tool_calls";
    case "content-filter":
      return "content_filter";
    case "error":
    default:
      return "stop";
  }
}

/**
 * Build a standard non-streaming OpenAI response.
 */
export function buildResponse(
  id: string,
  model: string,
  message: ChatCompletionMessage,
  finishReason: string
): ChatCompletionResponse {
  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: mapFinishReason(finishReason),
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
    system_fingerprint: "augment_oai_proxy",
  };
}

/**
 * Build a standard OpenAI error response.
 */
export function buildError(
  message: string,
  type: string = "invalid_request_error",
  code: string | number = 400
): ErrorResponse {
  return {
    error: { message, type, code },
  };
}
