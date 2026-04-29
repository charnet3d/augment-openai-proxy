import { execFile } from "node:child_process";
import type { ModelsListResponse } from "../types/openai";

/**
 * Convert an Augment CLI short name to the canonical backend model ID.
 *
 * Rules (confirmed by probing the backend without CHAT-mode override):
 *   Claude  haiku/sonnet/opus + version   →  claude-{family}-{version, dots→dashes}
 *   GPT     gpt{version}                  →  gpt-{version, dots→dashes}
 *   Gemini  gemini-{X.Y}-{rest}           →  gemini-{X-Y}-{rest}  (dots→dashes)
 *   Others  (e.g. code-review)            →  pass through, dots→dashes
 */
export function expandShortName(shortName: string): string {
  // Claude: haiku/sonnet/opus + numeric version
  const claudeMatch = shortName.match(/^(haiku|sonnet|opus)(\d[\d.]*)$/i);
  if (claudeMatch) {
    const family = claudeMatch[1].toLowerCase();
    const version = claudeMatch[2].replace(/\./g, "-");
    return `claude-${family}-${version}`;
  }

  // GPT: gpt{version} → gpt-{version}
  const gptMatch = shortName.match(/^gpt(\d[\d.]*)$/i);
  if (gptMatch) {
    return `gpt-${gptMatch[1].replace(/\./g, "-")}`;
  }

  // All others (gemini-X.Y-..., code-review, …): replace dots with dashes
  return shortName.replace(/\./g, "-");
}

/**
 * Fallback model list — used when `auggie models list --json` fails or returns
 * bad output. These are already in canonical (expanded) form.
 */
export const FALLBACK_MODEL_IDS: readonly string[] = [
  "claude-haiku-4-5",
  "claude-sonnet-4",
  "claude-sonnet-4-5",
  "claude-sonnet-4-6",
  "claude-opus-4-5",
  "claude-opus-4-6",
  "claude-opus-4-7",
  "gemini-3-1-pro-preview",
  "gpt-5",
  "gpt-5-1",
  "gpt-5-2",
  "gpt-5-4",
  "code-review",
];

let cachedModelIds: string[] | null = null;

function runAuggieModelsList(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "auggie",
      ["models", "list", "--json"],
      // shell:true is required on Windows so npm-installed .cmd wrappers are found.
      { timeout: 10_000, shell: true },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      }
    );
  });
}

async function fetchModelIds(): Promise<string[]> {
  try {
    const stdout = await runAuggieModelsList();
    const data = JSON.parse(stdout.trim()) as {
      registryAvailable?: boolean;
      models?: Array<{ shortName?: string }>;
    };
    if (Array.isArray(data.models)) {
      const ids = data.models
        .map((m) => m.shortName)
        .filter((s): s is string => typeof s === "string" && s.length > 0)
        .map(expandShortName);
      if (ids.length > 0) return ids;
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[modelRegistry] auggie models list failed (${reason}); using fallback model list`);
  }
  console.debug(`[modelRegistry] fallback model IDs: ${FALLBACK_MODEL_IDS.join(", ")}`);
  return [...FALLBACK_MODEL_IDS];
}

export async function getModelIds(): Promise<string[]> {
  if (!cachedModelIds) {
    cachedModelIds = await fetchModelIds();
  }
  return cachedModelIds;
}

export async function listModels(): Promise<ModelsListResponse> {
  const ids = await getModelIds();
  const created = Math.floor(Date.now() / 1000);
  return {
    object: "list",
    data: ids.map((id) => ({
      id,
      object: "model" as const,
      created,
      owned_by: "augment",
    })),
  };
}

export async function isModelAvailable(modelId: string): Promise<boolean> {
  const ids = await getModelIds();
  return ids.includes(modelId);
}
