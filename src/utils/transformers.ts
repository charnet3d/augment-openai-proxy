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
type AiImagePart = {
  type: "image";
  // AI SDK v5: base64 string, Uint8Array, ArrayBuffer, Buffer, or URL.
  image: string | URL | Uint8Array | ArrayBuffer | Buffer;
  mediaType?: string;
};
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
  | { role: "user"; content: string | Array<AiTextPart | AiImagePart> }
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
 * Convert a possibly-multimodal `image_url.url` (data URL or remote URL) into
 * an AI SDK `ImagePart`-compatible `{ image, mediaType? }` payload.
 *
 * - `data:<mime>;base64,<b64>` is split into the raw base64 string and its
 *   media type so providers (Anthropic, etc.) get them as separate fields.
 * - Other strings are wrapped as a `URL` instance when parseable, and passed
 *   through as-is otherwise (some providers accept opaque URI strings).
 */
function transformImageUrl(url: string): { image: string | URL; mediaType?: string } {
  if (url.startsWith("data:")) {
    const m = /^data:([^;,]+)?(?:;base64)?,(.+)$/.exec(url);
    if (m) {
      return { image: m[2], mediaType: m[1] || undefined };
    }
  }
  try {
    return { image: new URL(url) };
  } catch {
    return { image: url };
  }
}

/**
 * Flatten OpenAI multimodal `content` to a plain string (text parts only).
 * Used for roles that the AI SDK requires to be string-typed (e.g. system).
 */
function contentToText(content: ChatCompletionMessage["content"]): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
}

/**
 * Convert OpenAI user `content` (string or multimodal array) into the AI SDK
 * user-message content shape.
 */
function transformUserContent(
  content: ChatCompletionMessage["content"]
): string | Array<AiTextPart | AiImagePart> {
  if (content == null) return "";
  if (typeof content === "string") return content;

  const parts: Array<AiTextPart | AiImagePart> = [];
  for (const p of content) {
    if (p.type === "text") {
      parts.push({ type: "text", text: p.text });
    } else if (p.type === "image_url") {
      const url = typeof p.image_url === "string" ? p.image_url : p.image_url?.url;
      if (!url) continue;
      const { image, mediaType } = transformImageUrl(url);
      parts.push({ type: "image", image, ...(mediaType && { mediaType }) });
    }
  }
  return parts;
}

/**
 * Transform OpenAI messages to AI SDK CoreMessage format.
 *
 * - tool role messages need the toolName resolved from preceding assistant
 *   messages (OpenAI omits it; the AI SDK requires it).
 * - user messages may carry OpenAI multimodal `content` arrays (text +
 *   image_url parts), which are mapped to AI SDK TextPart / ImagePart.
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
      case "developer":
        // `developer` is the o-series rename of `system`; OpenAI treats them
        // as equivalent on non-reasoning models. The AI SDK only has `system`.
        return [{ role: "system", content: contentToText(msg.content) }];

      case "user":
        return [{ role: "user", content: transformUserContent(msg.content) }];

      case "assistant": {
        const text = contentToText(msg.content);
        if (!msg.tool_calls?.length) {
          return [{ role: "assistant", content: text }];
        }
        const parts: Array<AiTextPart | AiToolCallPart> = [];
        if (text) {
          parts.push({ type: "text", text });
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
                output: { type: "text", value: contentToText(msg.content) },
              },
            ],
          },
        ];

      default:
        return [{ role: "user", content: transformUserContent(msg.content) }];
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
    system_fingerprint: "augment_open_proxy",
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
