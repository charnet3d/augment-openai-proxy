import { Hono } from "hono";
import type {
  ChatCompletionRequest,
  ChatCompletionChunk,
  ChatCompletionMessage,
} from "../types/openai";
import { getAugmentModel } from "../services/augmentClient";
import { isModelAvailable, AVAILABLE_MODELS } from "../services/modelRegistry";
import {
  transformMessages,
  transformTools,
  transformToolChoice,
  mapFinishReason,
  buildResponse,
  buildError,
} from "../utils/transformers";
import { randomUUID } from "crypto";

const router = new Hono();

// Request body size limit: 10MB
const MAX_BODY_SIZE = 10_000_000;
router.use("/completions", async (c, next) => {
  const contentLength = parseInt(c.req.header("content-length") || "0", 10);
  if (contentLength > MAX_BODY_SIZE) {
    return c.json(
      {
        error: {
          message: "Request body too large",
          type: "invalid_request_error",
          code: "request_too_large",
        },
      },
      413
    );
  }
  return next();
});

function generateId(): string {
  return `chatcmpl-${randomUUID()}`;
}

// POST /completions
router.post("/completions", async (c) => {
  try {
    const body = (await c.req.json()) as ChatCompletionRequest;

    // Validate model
    const modelId = body.model;
    if (!modelId) {
      return c.json(buildError("Missing required field: model"), 400);
    }

    const MODEL_PATTERN = /^claude-[a-z0-9\-]+$/;
    if (!isModelAvailable(modelId) && !MODEL_PATTERN.test(modelId)) {
      return c.json(
        buildError(
          `Model '${modelId}' is not available. Available: ${AVAILABLE_MODELS.join(", ")}`,
          "invalid_request_error",
          404
        ),
        404
      );
    }

    const requestId = generateId();
    const timestamp = Math.floor(Date.now() / 1000);

    // Transform request
    const prompt = transformMessages(body.messages || []);
    const tools = transformTools(body.tools);
    const toolChoice = transformToolChoice(body.tool_choice);

    const isStreaming = body.stream === true;

    if (isStreaming) {
      // --- STREAMING HANDLER ---
      try {
        const modelInstance = await getAugmentModel(modelId);
        const streamResult = await (modelInstance as any).doStream({
          prompt,
          maxOutputTokens: body.max_tokens,
          temperature: body.temperature,
          topP: body.top_p,
          stopSequences: Array.isArray(body.stop)
            ? body.stop
            : body.stop
              ? [body.stop]
              : undefined,
          tools,
          toolChoice,
        });

        const aiStream = streamResult.stream;
        const reader = aiStream.getReader();
        const textEncoder = new TextEncoder();

        // Track tool call IDs → index mapping for proper SSE indexing
        const toolCallIndexMap = new Map<string, number>();
        let nextToolCallIndex = 0;

        const streamResponse = new ReadableStream({
          start(controller: any) {
            // Initial chunk with role
            const initialChunk: ChatCompletionChunk = {
              id: requestId,
              object: "chat.completion.chunk",
              created: timestamp,
              model: modelId,
              choices: [
                {
                  index: 0,
                  delta: { role: "assistant" },
                  finish_reason: null,
                },
              ],
            };
            controller.enqueue(
              textEncoder.encode(`data: ${JSON.stringify(initialChunk)}\n\n`)
            );
          },
          async pull(controller: any) {
            try {
              const { done, value } = await reader.read();
              if (done) {
                // Send [DONE] terminator
                controller.enqueue(textEncoder.encode("data: [DONE]\n\n"));
                controller.close();
                return;
              }

              const part = value as any;

              if (part.type === "text-delta" && part.delta) {
                const chunk: ChatCompletionChunk = {
                  id: requestId,
                  object: "chat.completion.chunk",
                  created: timestamp,
                  model: modelId,
                  choices: [
                    {
                      index: 0,
                      delta: { content: part.delta },
                      finish_reason: null,
                    },
                  ],
                };
                controller.enqueue(
                  textEncoder.encode(`data: ${JSON.stringify(chunk)}\n\n`)
                );
              }

              if (part.type === "tool-input-delta" && part.delta) {
                // Track tool call index by ID
                let toolIdx = toolCallIndexMap.get(part.id);
                if (toolIdx === undefined) {
                  toolIdx = nextToolCallIndex++;
                  toolCallIndexMap.set(part.id, toolIdx);
                }
                const chunk: ChatCompletionChunk = {
                  id: requestId,
                  object: "chat.completion.chunk",
                  created: timestamp,
                  model: modelId,
                  choices: [
                    {
                      index: 0,
                      delta: {
                        tool_calls: [
                          {
                            index: toolIdx,
                            id: part.id,
                            type: "function",
                            function: {
                              arguments: part.delta,
                            },
                          },
                        ],
                      },
                      finish_reason: null,
                    },
                  ],
                };
                controller.enqueue(
                  textEncoder.encode(`data: ${JSON.stringify(chunk)}\n\n`)
                );
              }
            } catch (err) {
              const errorMessage =
                err instanceof Error ? err.message : "Stream error";
              const errorChunk = {
                error: { message: errorMessage, type: "stream_error" },
              };
              controller.enqueue(
                textEncoder.encode(`data: ${JSON.stringify(errorChunk)}\n\n`)
              );
              controller.close();
            }
          },
          async cancel() {
            reader.releaseLock();
          },
        });

        return c.body(streamResponse, {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          },
        });
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : "Failed to start stream";
        return c.json(
          buildError(errorMessage, "server_error", 500),
          500
        );
      }
    }

    // --- NON-STREAMING HANDLER ---
    try {
      const modelInstance = await getAugmentModel(modelId);
      const result = await (modelInstance as any).doGenerate({
        prompt,
        maxOutputTokens: body.max_tokens,
        temperature: body.temperature,
        topP: body.top_p,
        stopSequences: Array.isArray(body.stop)
          ? body.stop
          : body.stop
            ? [body.stop]
            : undefined,
        tools,
        toolChoice,
      });

      const contentParts = (result.content ?? []) as any[];
      let textContent = "";
      const toolCalls: any[] = [];

      for (const part of contentParts) {
        if (part.type === "text") {
          textContent += part.text;
        } else if (part.type === "tool-call") {
          toolCalls.push({
            id: part.toolCallId,
            type: "function",
            function: {
              name: part.toolName,
              arguments: JSON.stringify(part.input),
            },
          });
        }
      }

      const assistantMessage: ChatCompletionMessage = {
        role: "assistant",
        content: textContent || null,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      };

      const finishReason =
        toolCalls.length > 0 ? "tool_calls" : result.finishReason ?? "stop";

      const response = buildResponse(
        requestId,
        modelId,
        assistantMessage,
        finishReason
      );

      // Update usage if available
      if (result.usage) {
        response.usage = {
          prompt_tokens: result.usage.inputTokens ?? 0,
          completion_tokens: result.usage.outputTokens ?? 0,
          total_tokens:
            (result.usage.inputTokens ?? 0) + (result.usage.outputTokens ?? 0),
        };
      }

      return c.json(response);
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : "Generation failed";
      return c.json(
        buildError(errorMessage, "server_error", 500),
        500
      );
    }
  } catch (err) {
    const errorMessage =
      err instanceof Error ? err.message : "Internal server error";
    return c.json(buildError(errorMessage), 500);
  }
});

export default router;
