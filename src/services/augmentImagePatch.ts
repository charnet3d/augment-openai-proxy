/**
 * Experimental image-input support for the Augment SDK.
 *
 * The upstream `@augmentcode/auggie-sdk` declares `supportsImageUrls = false`
 * and its internal `userMessageToNodes` only emits TEXT nodes — any AI SDK v5
 * `file` parts are silently dropped before the request leaves the proxy. This
 * module monkey-patches `AugmentLanguageModel.buildPayload` to emit Augment
 * IMAGE nodes (`type: 2`, `image_node: { image_data, format }`) for image
 * file parts found in user messages.
 *
 * Wire format reverse-engineered from AnkRoot/Augment-BYOK-Proxy
 * (src/protocol.rs, src/convert.rs). Falls back to the original buildPayload
 * when the prompt contains no images, preserving SDK default behavior for the
 * common non-multimodal path.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

const TEXT = 0;
const TOOL_RESULT = 1;
const IMAGE = 2;
const RAW_RESPONSE = 0;
const TOOL_USE = 5;
const THINKING = 8;

type Part = { type: string; [k: string]: unknown };
type Msg = { role: string; content: string | Part[] };

export function mediaTypeToFormat(mediaType: string | undefined): number {
  if (!mediaType) return 1;
  const m = mediaType.toLowerCase().split(";")[0].trim();
  if (m === "image/jpeg" || m === "image/jpg") return 2;
  if (m === "image/gif") return 3;
  if (m === "image/webp") return 4;
  return 1; // png + fallback
}

export function dataToBase64(data: unknown): string | null {
  if (data == null) return null;
  if (typeof data === "string") return data;
  if (data instanceof Uint8Array) return Buffer.from(data).toString("base64");
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data)).toString("base64");
  return null; // URL or unsupported — caller drops the part
}

function isImageFilePart(part: Part): boolean {
  if (part.type !== "file") return false;
  const mt = (part as any).mediaType;
  return typeof mt === "string" && mt.toLowerCase().startsWith("image/");
}

export function hasAnyImage(prompt: Msg[] | undefined): boolean {
  if (!Array.isArray(prompt)) return false;
  return prompt.some(
    (m) => m.role === "user" && Array.isArray(m.content) && m.content.some(isImageFilePart),
  );
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p): p is Part => typeof p === "object" && p !== null && p.type === "text")
      .map((p) => (p as any).text)
      .join("");
  }
  return "";
}

function userMessageToNodes(msg: Msg, startId: number): { nodes: any[]; text: string } {
  const nodes: any[] = [];
  let text = "";
  let id = startId;
  if (msg.role !== "user") return { nodes, text };
  const parts: Part[] = typeof msg.content === "string"
    ? (msg.content ? [{ type: "text", text: msg.content }] : [])
    : msg.content;
  for (const part of parts) {
    if (part.type === "text") {
      const t = (part as any).text ?? "";
      nodes.push({ id: id++, type: TEXT, text_node: { content: t } });
      text += t;
    } else if (isImageFilePart(part)) {
      const data = dataToBase64((part as any).data);
      if (!data) continue;
      nodes.push({
        id: id++,
        type: IMAGE,
        image_node: { image_data: data, format: mediaTypeToFormat((part as any).mediaType) },
      });
    }
  }
  return { nodes, text };
}

function toolMessageToNodes(msg: Msg, startId: number): any[] {
  const nodes: any[] = [];
  let id = startId;
  if (msg.role !== "tool" || !Array.isArray(msg.content)) return nodes;
  for (const part of msg.content) {
    if (part.type !== "tool-result") continue;
    const output = (part as any).output;
    let content = "";
    let isError = false;
    if (output?.type === "text") content = output.value;
    else if (output?.type === "json") content = JSON.stringify(output.value);
    else if (output?.type === "error-text") { content = output.value; isError = true; }
    else if (output?.type === "error-json") { content = JSON.stringify(output.value); isError = true; }
    else if (output?.type === "content") {
      content = (output.value as any[]).filter((v) => v.type === "text").map((v: any) => v.text).join("\n");
    }
    nodes.push({
      id: id++,
      type: TOOL_RESULT,
      tool_result_node: { tool_use_id: (part as any).toolCallId, content, is_error: isError },
    });
  }
  return nodes;
}

function assistantMessageToResponseNodes(msg: Msg): { nodes: any[]; text: string } {
  const nodes: any[] = [];
  let text = "";
  let id = 0;
  if (msg.role !== "assistant") return { nodes, text };
  if (typeof msg.content === "string") return { nodes, text: msg.content };
  for (const part of msg.content) {
    if (part.type === "text") {
      const t = (part as any).text ?? "";
      text += t;
      nodes.push({ id: id++, type: RAW_RESPONSE, content: t });
    } else if (part.type === "tool-call") {
      const input = (part as any).input;
      nodes.push({
        id: id++,
        type: TOOL_USE,
        tool_use: {
          tool_use_id: (part as any).toolCallId,
          tool_name: (part as any).toolName,
          input_json: typeof input === "string" ? input : JSON.stringify(input),
        },
      });
    } else if (part.type === "reasoning") {
      nodes.push({ id: id++, type: THINKING, thinking: { content: (part as any).text } });
    }
  }
  return { nodes, text };
}

function toolsToDefinitions(tools: unknown): any[] {
  if (!Array.isArray(tools)) return [];
  return tools
    .filter((t: any) => t.type === "function")
    .map((t: any) => ({
      name: t.name,
      description: t.description ?? "",
      input_schema_json: JSON.stringify(t.inputSchema),
    }));
}

export function buildChatRequestWithImages(
  prompt: Msg[],
  tools: unknown,
): { message: string; nodes: any[]; chatHistory: any[]; toolDefinitions: any[] } {
  const chatHistory: any[] = [];
  let pendingRequestNodes: any[] = [];
  let pendingRequestText = "";
  let nodeId = 0;
  for (const msg of prompt) {
    if (msg.role === "system") {
      const systemText = extractText(msg.content);
      if (systemText) {
        pendingRequestNodes.push({
          id: nodeId++,
          type: TEXT,
          text_node: { content: `System: ${systemText}` },
        });
        pendingRequestText += `System: ${systemText}\n\n`;
      }
    } else if (msg.role === "user") {
      const { nodes, text } = userMessageToNodes(msg, nodeId);
      pendingRequestNodes.push(...nodes);
      nodeId += nodes.length;
      if (pendingRequestText && text) pendingRequestText += "\n" + text;
      else pendingRequestText += text;
    } else if (msg.role === "tool") {
      const nodes = toolMessageToNodes(msg, nodeId);
      pendingRequestNodes.push(...nodes);
      nodeId += nodes.length;
    } else if (msg.role === "assistant") {
      const { nodes: responseNodes, text: responseText } = assistantMessageToResponseNodes(msg);
      chatHistory.push({
        request_message: pendingRequestText,
        request_nodes: pendingRequestNodes,
        response_text: responseText,
        response_nodes: responseNodes,
      });
      pendingRequestNodes = [];
      pendingRequestText = "";
      nodeId = 0;
    }
  }
  pendingRequestNodes.forEach((node, i) => { node.id = i; });
  return {
    message: pendingRequestText,
    nodes: pendingRequestNodes,
    chatHistory,
    toolDefinitions: toolsToDefinitions(tools),
  };
}

/**
 * Wraps the model's `buildPayload` so that image-bearing prompts produce a
 * payload with Augment IMAGE nodes. Non-image prompts fall through to the
 * SDK's original implementation untouched. Also flips `supportsImageUrls`
 * to `true` so the AI SDK doesn't pre-strip image parts.
 */
export function patchModelForImages(model: any): void {
  if (!model || typeof model.buildPayload !== "function") return;
  const original = model.buildPayload.bind(model);
  model.buildPayload = (options: any) => {
    if (!hasAnyImage(options?.prompt)) return original(options);
    const { message, nodes, chatHistory, toolDefinitions } = buildChatRequestWithImages(
      options.prompt,
      options.tools,
    );
    return {
      mode: "CLI_AGENT",
      model: model.modelId,
      message,
      nodes,
      chat_history: chatHistory,
      conversation_id: model.sessionId,
      tool_definitions: toolDefinitions.length > 0 ? toolDefinitions : undefined,
    };
  };
  model.supportsImageUrls = true;
}

