// OpenAI Responses API types (POST /v1/responses).
// Mirrors the public shape documented at
// https://platform.openai.com/docs/api-reference/responses — only the fields
// the proxy actually consumes/produces are modelled here.

import type { ReasoningEffort, ReasoningSummary } from "./openai";

// ── Input content parts ───────────────────────────────────────────────────
export interface ResponseInputTextPart {
  type: "input_text";
  text: string;
}

export interface ResponseInputImagePart {
  type: "input_image";
  image_url?: string;
  file_id?: string;
  detail?: "auto" | "low" | "high";
}

export interface ResponseInputFilePart {
  type: "input_file";
  file_url?: string;
  file_id?: string;
  filename?: string;
  file_data?: string;
}

export interface ResponseOutputTextPart {
  type: "output_text";
  text: string;
  annotations?: unknown[];
  logprobs?: unknown[];
}

export type ResponseInputContentPart =
  | ResponseInputTextPart
  | ResponseInputImagePart
  | ResponseInputFilePart
  | ResponseOutputTextPart;

// ── Input items ───────────────────────────────────────────────────────────
export interface ResponseInputMessage {
  type?: "message";
  role: "user" | "assistant" | "system" | "developer";
  content: string | ResponseInputContentPart[];
  status?: string;
}

export interface ResponseInputFunctionCall {
  type: "function_call";
  id?: string;
  call_id: string;
  name: string;
  arguments: string;
  status?: string;
}

export interface ResponseInputFunctionCallOutput {
  type: "function_call_output";
  call_id: string;
  output: string;
  status?: string;
}

export interface ResponseInputReasoning {
  type: "reasoning";
  id?: string;
  summary?: Array<{ type: "summary_text"; text: string }>;
  encrypted_content?: string | null;
  status?: string;
}

export type ResponseInputItem =
  | ResponseInputMessage
  | ResponseInputFunctionCall
  | ResponseInputFunctionCallOutput
  | ResponseInputReasoning;

// ── Tools (Responses API uses a flat function shape) ──────────────────────
export interface ResponseFunctionTool {
  type: "function";
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
  strict?: boolean | null;
}

// Built-in tools (web_search_preview, file_search, etc.) are passed through
// to providerOptions but the proxy itself does not execute them.
export type ResponseTool = ResponseFunctionTool | { type: string; [k: string]: unknown };

export type ResponseToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; name: string }
  | { type: string; [k: string]: unknown };

// ── Request body ──────────────────────────────────────────────────────────
export interface ResponseRequest {
  model: string;
  input: string | ResponseInputItem[];
  instructions?: string | null;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  tools?: ResponseTool[];
  tool_choice?: ResponseToolChoice;
  parallel_tool_calls?: boolean;
  reasoning?: { effort?: ReasoningEffort; summary?: ReasoningSummary };
  text?: { format?: { type: string; [k: string]: unknown } };
  previous_response_id?: string | null;
  store?: boolean;
  metadata?: Record<string, unknown> | null;
  user?: string;
  truncation?: "auto" | "disabled";
}

// ── Response output items ─────────────────────────────────────────────────
export interface ResponseOutputMessage {
  type: "message";
  id: string;
  status: "in_progress" | "completed" | "incomplete";
  role: "assistant";
  content: ResponseOutputTextPart[];
}

export interface ResponseOutputFunctionCall {
  type: "function_call";
  id: string;
  call_id: string;
  name: string;
  arguments: string;
  status: "in_progress" | "completed" | "incomplete";
}

export interface ResponseOutputReasoning {
  type: "reasoning";
  id: string;
  summary: Array<{ type: "summary_text"; text: string }>;
  encrypted_content?: string | null;
  status?: "in_progress" | "completed" | "incomplete";
}

export type ResponseOutputItem =
  | ResponseOutputMessage
  | ResponseOutputFunctionCall
  | ResponseOutputReasoning;

// ── Usage ─────────────────────────────────────────────────────────────────
export interface ResponseUsage {
  input_tokens: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens: number;
  output_tokens_details?: { reasoning_tokens?: number };
  total_tokens: number;
}

// ── Response object ───────────────────────────────────────────────────────
export type ResponseStatus =
  | "completed"
  | "in_progress"
  | "failed"
  | "incomplete"
  | "cancelled";

export interface ResponseObject {
  id: string;
  object: "response";
  created_at: number;
  status: ResponseStatus;
  error: { code: string; message: string } | null;
  incomplete_details: { reason: string } | null;
  instructions: string | null;
  max_output_tokens: number | null;
  model: string;
  output: ResponseOutputItem[];
  parallel_tool_calls: boolean;
  previous_response_id: string | null;
  reasoning: { effort: ReasoningEffort | null; summary: ReasoningSummary | null };
  store: boolean;
  temperature: number | null;
  text: { format: { type: string } };
  tool_choice: ResponseToolChoice;
  tools: ResponseTool[];
  top_p: number | null;
  truncation: "auto" | "disabled";
  usage?: ResponseUsage;
  user: string | null;
  metadata: Record<string, unknown>;
}

// ── Streaming events ──────────────────────────────────────────────────────
// Each event matches one SSE record on the wire. Only the fields the proxy
// emits are modelled; the OpenAI spec includes additional optional fields.
export type ResponseStreamEvent =
  | { type: "response.created"; response: ResponseObject; sequence_number: number }
  | { type: "response.in_progress"; response: ResponseObject; sequence_number: number }
  | {
      type: "response.output_item.added";
      output_index: number;
      item: ResponseOutputItem;
      sequence_number: number;
    }
  | {
      type: "response.content_part.added";
      item_id: string;
      output_index: number;
      content_index: number;
      part: ResponseOutputTextPart;
      sequence_number: number;
    }
  | {
      type: "response.output_text.delta";
      item_id: string;
      output_index: number;
      content_index: number;
      delta: string;
      sequence_number: number;
    }
  | {
      type: "response.output_text.done";
      item_id: string;
      output_index: number;
      content_index: number;
      text: string;
      sequence_number: number;
    }
  | {
      type: "response.content_part.done";
      item_id: string;
      output_index: number;
      content_index: number;
      part: ResponseOutputTextPart;
      sequence_number: number;
    }
  | {
      type: "response.function_call_arguments.delta";
      item_id: string;
      output_index: number;
      delta: string;
      sequence_number: number;
    }
  | {
      type: "response.function_call_arguments.done";
      item_id: string;
      output_index: number;
      arguments: string;
      sequence_number: number;
    }
  | {
      type: "response.reasoning_summary_part.added";
      item_id: string;
      output_index: number;
      summary_index: number;
      part: { type: "summary_text"; text: string };
      sequence_number: number;
    }
  | {
      type: "response.reasoning_summary_text.delta";
      item_id: string;
      output_index: number;
      summary_index: number;
      delta: string;
      sequence_number: number;
    }
  | {
      type: "response.reasoning_summary_text.done";
      item_id: string;
      output_index: number;
      summary_index: number;
      text: string;
      sequence_number: number;
    }
  | {
      type: "response.reasoning_summary_part.done";
      item_id: string;
      output_index: number;
      summary_index: number;
      part: { type: "summary_text"; text: string };
      sequence_number: number;
    }
  | {
      type: "response.output_item.done";
      output_index: number;
      item: ResponseOutputItem;
      sequence_number: number;
    }
  | { type: "response.completed"; response: ResponseObject; sequence_number: number }
  | { type: "response.failed"; response: ResponseObject; sequence_number: number }
  | {
      type: "error";
      message: string;
      code?: string | null;
      param?: string | null;
      sequence_number?: number;
    };

