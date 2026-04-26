import { AVAILABLE_MODELS as MODELS } from "../config";
import type { ModelsListResponse, ModelObject } from "../types/openai";

export const AVAILABLE_MODELS = MODELS;

// Pre-compute the cached model list response to avoid regenerating timestamps
const CACHED_MODELS: ModelsListResponse = {
  object: "list",
  data: MODELS.map((id) => ({
    id,
    object: "model",
    created: Math.floor(Date.now() / 1000),
    owned_by: "augment",
  })),
};

export function listModels(): ModelsListResponse {
  return CACHED_MODELS;
}

export function isModelAvailable(modelId: string): boolean {
  return AVAILABLE_MODELS.includes(modelId as (typeof AVAILABLE_MODELS)[number]);
}
