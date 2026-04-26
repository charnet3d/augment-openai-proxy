import type {
  ChatCompletionRequest,
  ChatCompletionMessage,
  ChatCompletionResponse,
  ErrorResponse,
} from "../types/openai";
import type {
  LanguageModelV2FunctionTool,
  LanguageModelV2ToolChoice,
  LanguageModelV2Message,
} from "@ai-sdk/provider";

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
 * Transform OpenAI messages to AI SDK LanguageModelV2Message format.
 */
export function transformMessages(
  messages: ChatCompletionMessage[]
): LanguageModelV2Message[] {
  return messages.map((msg) => {
    const content: Array<{ type: "text"; text: string }> = msg.content
      ? [{ type: "text" as const, text: msg.content }]
      : [];

    switch (msg.role) {
      case "system":
        return { role: "system" as const, content: msg.content || "" };

      case "user":
        return { role: "user" as const, content };

      case "assistant": {
        const parts: Array<
          | { type: "text"; text: string }
          | {
              type: "tool-call";
              toolCallId: string;
              toolName: string;
              input: unknown;
            }
        > = [];

        if (msg.content) {
          parts.push({ type: "text" as const, text: msg.content });
        }

        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            parts.push({
              type: "tool-call" as const,
              toolCallId: tc.id,
              toolName: tc.function.name,
              input:
                typeof tc.function.arguments === "string"
                  ? safeJsonParse(tc.function.arguments)
                  : tc.function.arguments,
            });
          }
        }

        return { role: "assistant" as const, content: parts };
      }

      case "tool":
        return {
          role: "assistant" as const,
          content: [
            {
              type: "tool-result" as const,
              toolCallId: msg.tool_call_id ?? "",
              toolName: msg.name ?? "",
              output: { type: "text" as const, value: msg.content ?? "" },
            },
          ],
        };

      default:
        return { role: "user" as const, content };
    }
  });
}

/**
 * Transform OpenAI tools to AI SDK LanguageModelV2FunctionTool format.
 */
export function transformTools(
  tools?: ChatCompletionRequest["tools"]
): LanguageModelV2FunctionTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;

  return tools
    .filter(
      (t): t is Extract<ChatCompletionRequest["tools"], any[]>[number] & {
        type: "function";
      } => t.type === "function"
    )
    .map((t) => ({
      type: "function" as const,
      name: t.function.name,
      description: t.function.description,
      inputSchema: t.function.parameters as any,
    }));
}

/**
 * Transform OpenAI tool_choice to AI SDK LanguageModelV2ToolChoice.
 */
export function transformToolChoice(
  toolChoice?: ChatCompletionRequest["tool_choice"]
): LanguageModelV2ToolChoice | undefined {
  if (!toolChoice) return undefined;

  if (toolChoice === "none") return { type: "none" as const };
  if (toolChoice === "auto") return { type: "auto" as const };
  if (toolChoice === "required") return { type: "required" as const };
  if (typeof toolChoice === "object" && toolChoice.type === "function") {
    return { type: "tool" as const, toolName: toolChoice.function.name };
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
