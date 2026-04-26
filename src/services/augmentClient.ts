import {
  AugmentLanguageModel,
  resolveAugmentCredentials,
  type AugmentCredentials,
} from "@augmentcode/auggie-sdk";
import { AVAILABLE_MODELS } from "../config";

let cachedCredentials: AugmentCredentials | null = null;

async function getCachedCredentials(): Promise<AugmentCredentials> {
  if (cachedCredentials) return cachedCredentials;
  cachedCredentials = await resolveAugmentCredentials();
  return cachedCredentials;
}

export async function getAugmentModel(modelId: string): Promise<AugmentLanguageModel> {
  const normalizedModelId = resolveModelId(modelId);
  const creds = await getCachedCredentials();

  return new AugmentLanguageModel(normalizedModelId, {
    apiKey: creds.apiKey,
    apiUrl: creds.apiUrl,
    debug: process.env.DEBUG === "true",
    clientUserAgent: "augment-oai-proxy/1.0.0",
  });
}

export async function validateCredentials(): Promise<boolean> {
  try {
    await resolveAugmentCredentials();
    return true;
  } catch {
    return false;
  }
}

export function resolveModelId(modelId: string): string {
  const normalized = modelId.toLowerCase().trim();
  for (const knownModel of AVAILABLE_MODELS) {
    if (knownModel.toLowerCase() === normalized) {
      return knownModel;
    }
  }
  // If not in our known list, pass through — the SDK will reject invalid ones
  return modelId;
}
