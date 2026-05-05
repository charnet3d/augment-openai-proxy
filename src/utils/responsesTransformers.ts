import { jsonSchema } from "ai";
import type {
  ResponseInputItem,
  ResponseInputContentPart,
  ResponseFunctionTool,
  ResponseTool,
  ResponseToolChoice,
} from "../types/responses";
import type { CoreMessage, CoreTool, CoreToolChoice } from "./transformers";
import { safeJsonParse } from "./transformers";

type AiTextPart = { type: "text"; text: string };
type AiImagePart = {
  type: "image";
  image: string | URL | Uint8Array | ArrayBuffer | Buffer;
  mediaType?: string;
};
type AiToolCallPart = {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  input: unknown;
};

/**
 * Convert a possibly-multimodal image_url (data URL or remote URL) into an
 * AI SDK ImagePart-compatible payload.
 */
function transformImageUrl(url: string): { image: string | URL; mediaType?: string } {
  if (url.startsWith("data:")) {
    const m = /^data:([^;,]+)?(?:;base64)?,(.+)$/.exec(url);
    if (m) return { image: m[2], mediaType: m[1] || undefined };
  }
  try {
    return { image: new URL(url) };
  } catch {
    return { image: url };
  }
}

/**
 * Flatten Responses-API content parts to a plain text string. Used for roles
 * that the AI SDK requires to be string-typed (system / developer) and for
 * function_call_output payloads.
 */
function partsToText(content: string | ResponseInputContentPart[] | undefined): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content
    .map((p) => {
      if (p.type === "input_text" || p.type === "output_text") return p.text;
      return "";
    })
    .join("");
}

/**
 * Convert Responses-API user content (string or part array) into the AI SDK
 * user-message content shape. Supports input_text and input_image parts.
 * input_file is collapsed to a placeholder text reference (the Augment
 * backend does not accept arbitrary file uploads through this surface).
 */
function transformUserContent(
  content: string | ResponseInputContentPart[]
): string | Array<AiTextPart | AiImagePart> {
  if (typeof content === "string") return content;
  const parts: Array<AiTextPart | AiImagePart> = [];
  for (const p of content) {
    if (p.type === "input_text") {
      parts.push({ type: "text", text: p.text });
    } else if (p.type === "output_text") {
      parts.push({ type: "text", text: p.text });
    } else if (p.type === "input_image") {
      const url = p.image_url;
      if (!url) continue;
      const { image, mediaType } = transformImageUrl(url);
      parts.push({ type: "image", image, ...(mediaType && { mediaType }) });
    } else if (p.type === "input_file") {
      const ref = p.filename ?? p.file_url ?? p.file_id;
      if (ref) parts.push({ type: "text", text: `[file: ${ref}]` });
    }
  }
  return parts;
}

/**
 * Transform a Responses-API request `input` (string or item array) plus the
 * top-level `instructions` field into the AI SDK CoreMessage[] shape.
 *
 * The Responses API mixes message items, function_call items, function_call_
 * output items, and reasoning items in a single flat list. This function:
 *   - prefixes the conversation with `instructions` as a system message,
 *   - collapses runs of contiguous function_call items into a single
 *     assistant message with a tool_calls array (matching how the AI SDK
 *     models a tool-using assistant turn),
 *   - resolves the toolName for function_call_output items by looking up
 *     the matching function_call by call_id (the Responses API omits the
 *     name on the output, but the AI SDK requires it),
 *   - drops `reasoning` items — they carry the model's prior thought
 *     summaries, which the upstream backend does not consume on input.
 */
function buildToolCallPart(item: {
  call_id: string;
  name: string;
  arguments: unknown;
}): AiToolCallPart {
  return {
    type: "tool-call",
    toolCallId: item.call_id,
    toolName: item.name,
    input:
      typeof item.arguments === "string"
        ? safeJsonParse(item.arguments)
        : (item.arguments ?? {}),
  };
}

function buildToolResultMessage(item: {
  call_id: string;
  output: string;
}, toolName: string): CoreMessage {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: item.call_id,
        toolName,
        output: { type: "text", value: item.output ?? "" },
      },
    ],
  };
}

function messageItemToCoreMessage(msg: {
  role: string;
  content: string | ResponseInputContentPart[];
}): CoreMessage {
  switch (msg.role) {
    case "system":
    case "developer":
      return { role: "system", content: partsToText(msg.content) };
    case "assistant":
      return { role: "assistant", content: partsToText(msg.content) };
    case "user":
    default:
      return { role: "user", content: transformUserContent(msg.content) };
  }
}

export function transformResponseInput(
  input: string | ResponseInputItem[] | undefined,
  instructions?: string | null
): CoreMessage[] {
  const messages: CoreMessage[] = [];
  if (instructions && instructions.length > 0) {
    messages.push({ role: "system", content: instructions });
  }

  if (input == null) return messages;
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
    return messages;
  }

  // Pre-scan: build call_id → toolName map from function_call items so
  // function_call_output items can resolve the (otherwise-missing) name.
  const callIdToName = new Map<string, string>();
  for (const item of input) {
    if (item.type === "function_call") callIdToName.set(item.call_id, item.name);
  }

  // Buffer for collapsing consecutive function_call items into a single
  // assistant message with multiple tool_calls.
  let pendingToolCalls: AiToolCallPart[] = [];
  const flushToolCalls = () => {
    if (pendingToolCalls.length === 0) return;
    messages.push({ role: "assistant", content: pendingToolCalls });
    pendingToolCalls = [];
  };

  for (const item of input) {
    if (item.type === "function_call") {
      pendingToolCalls.push(buildToolCallPart(item));
      continue;
    }
    flushToolCalls();

    if (item.type === "function_call_output") {
      const toolName = callIdToName.get(item.call_id) ?? "unknown";
      messages.push(buildToolResultMessage(item, toolName));
      continue;
    }
    if (item.type === "reasoning") continue;

    // Default branch: message item (type may be omitted in the request body).
    const itemType = (item as { type?: string }).type;
    if (itemType === undefined || item.type === "message") {
      messages.push(messageItemToCoreMessage(item));
    }
  }
  flushToolCalls();
  return messages;
}

/**
 * Transform Responses-API tools to a Record<name, CoreTool> for generateText
 * / streamText. The Responses API uses a flat function shape (`type: "function"`,
 * `name`, `description`, `parameters` at the top level) — different from
 * Chat Completions which nests them under `function`. Built-in tools
 * (web_search_preview, file_search, etc.) are dropped: the Augment backend
 * doesn't expose them and emitting them would confuse the AI SDK.
 */
export function transformResponseTools(
  tools?: ResponseTool[]
): Record<string, CoreTool> | undefined {
  if (!tools?.length) return undefined;
  const result: Record<string, CoreTool> = {};
  for (const t of tools) {
    if (t.type !== "function") continue;
    const fn = t as ResponseFunctionTool;
    if (!fn.name) continue;
    result[fn.name] = {
      description: fn.description,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      inputSchema: jsonSchema(fn.parameters as any),
    };
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Transform Responses-API tool_choice to AI SDK CoreToolChoice. The
 * Responses API puts the function name at the top level of the choice
 * object, unlike Chat Completions which nests it under `function`.
 */
export function transformResponseToolChoice(
  toolChoice?: ResponseToolChoice
): CoreToolChoice | undefined {
  if (!toolChoice) return undefined;
  if (toolChoice === "none") return "none";
  if (toolChoice === "auto") return "auto";
  if (toolChoice === "required") return "required";
  if (typeof toolChoice === "object" && toolChoice.type === "function") {
    const name = (toolChoice as { name?: string }).name;
    if (name) return { type: "tool", toolName: name };
  }
  return undefined;
}
