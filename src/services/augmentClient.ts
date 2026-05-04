import {
  AugmentLanguageModel,
  resolveAugmentCredentials,
  type AugmentCredentials,
} from "@augmentcode/auggie-sdk";
import { patchModelForImages } from "./augmentImagePatch";

// Cache resolved credentials for the process lifetime to avoid repeated
// session-file reads. The SDK's resolveAugmentCredentials() reads
// AUGMENT_API_TOKEN/AUGMENT_API_URL from env automatically.
let cachedCredentials: AugmentCredentials | null = null;

async function getCachedCredentials(): Promise<AugmentCredentials> {
  if (cachedCredentials) return cachedCredentials;
  cachedCredentials = await resolveAugmentCredentials();
  return cachedCredentials;
}

export async function getAugmentModel(modelId: string): Promise<AugmentLanguageModel> {
  const creds = await getCachedCredentials();

  // Model IDs arriving here are already in canonical form (e.g. "claude-haiku-4-5",
  // "gpt-5-4", "gemini-3-1-pro-preview") because expandShortName() is applied at
  // registry load time. The SDK uses CLI_AGENT mode by default, which the backend
  // accepts for canonical names with both session and API-key auth.
  const model = new AugmentLanguageModel(modelId, {
    apiKey: creds.apiKey,
    apiUrl: creds.apiUrl,
    debug: process.env.DEBUG === "true",
    clientUserAgent: "augment-open-proxy/1.0.0",
  });

  // CHAT mode is required for two independent reasons:
  //  1. API-key auth: the backend rejects CLI_AGENT mode with direct API keys.
  //  2. Short model IDs: the registry exposes short names (e.g. "haiku4.5") that
  //     the backend only accepts in CHAT mode; long names (e.g. "claude-haiku-4-5")
  //     work with either mode.
  // CHAT mode is accepted for all auth types and model ID formats, so we always
  // use it. generateText/streamText call buildPayload internally, so the patch
  // applies regardless of which high-level AI SDK function is used.
  // const originalBuildPayload = (model as any).buildPayload.bind(model);
  // (model as any).buildPayload = (options: unknown) => {
  //   const payload = originalBuildPayload(options);
  //   return { ...payload, mode: "CHAT" };
  // };

  // Experimental: enable image input by injecting Augment IMAGE nodes for
  // AI SDK v5 file parts. The SDK drops images by default. Falls back to the
  // SDK's original buildPayload for prompts without images.
  patchModelForImages(model);

  return model;
}

export async function validateCredentials(): Promise<boolean> {
  try {
    await getCachedCredentials();
    return true;
  } catch {
    return false;
  }
}