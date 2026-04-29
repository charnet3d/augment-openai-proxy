import { execFile } from "node:child_process";
import type { ModelsListResponse, ReasoningEffort } from "../types/openai";

/**
 * Augment effort levels in ascending order. The CLI advertises a model-specific
 * subset (e.g. opus4.7 → ["Medium","High","xHigh"], opus4.6 → ["Low","Medium",
 * "High","Max"]). The backend selects the depth via a model ID suffix
 * (`<base>-<level>`, lowercased), confirmed by probing the live API.
 */
const ORDERED_EFFORT_LEVELS = ["low", "medium", "high", "max", "xhigh"] as const;

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

/**
 * Per-base-model entry: canonical base ID plus the lowercase effort suffixes
 * advertised by the CLI for that model. Suffixes are kept in CLI order so the
 * generated variant list is stable.
 */
export interface ModelEntry {
  baseId: string;
  effortLevels: string[];
}

let cachedEntries: ModelEntry[] | null = null;
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

/**
 * Expand a single CLI entry into the flat list of canonical IDs the registry
 * exposes: the base ID, followed by one suffixed variant per advertised effort
 * level (lowercased, CLI order preserved).
 */
export function expandModelEntry(entry: ModelEntry): string[] {
  const ids = [entry.baseId];
  for (const level of entry.effortLevels) {
    ids.push(`${entry.baseId}-${level}`);
  }
  return ids;
}

/**
 * Parse `AUGMENT_DISABLE_EFFORT_MODELS` into a Set of canonical base IDs whose
 * advertised effort levels should be ignored. Use this for models the CLI
 * advertises levels for but the backend currently rejects suffixed IDs on
 * (observed for `claude-opus-4-6`, likely an entitlement/rollout gap).
 *
 * Accepts either short names (`opus4.6`) or canonical IDs
 * (`claude-opus-4-6`); both are normalised through `expandShortName`. Comma-
 * or whitespace-separated, case-sensitive after normalisation.
 */
export function getEffortDisabledBaseIds(): Set<string> {
  const raw = process.env.AUGMENT_DISABLE_EFFORT_MODELS;
  if (!raw) return new Set();
  return new Set(
    raw
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map(expandShortName)
  );
}

async function fetchModelEntries(): Promise<ModelEntry[]> {
  const disabled = getEffortDisabledBaseIds();
  try {
    const stdout = await runAuggieModelsList();
    const data = JSON.parse(stdout.trim()) as {
      registryAvailable?: boolean;
      models?: Array<{ shortName?: string; effortLevels?: unknown }>;
    };
    if (Array.isArray(data.models)) {
      const entries: ModelEntry[] = [];
      for (const m of data.models) {
        if (typeof m.shortName !== "string" || m.shortName.length === 0) continue;
        const baseId = expandShortName(m.shortName);
        const advertised = Array.isArray(m.effortLevels)
          ? m.effortLevels
              .filter((l): l is string => typeof l === "string" && l.length > 0)
              .map((l) => l.toLowerCase())
          : [];
        const effortLevels = disabled.has(baseId) ? [] : advertised;
        if (disabled.has(baseId) && advertised.length > 0) {
          console.debug(
            `[modelRegistry] effort levels disabled for ${baseId} via AUGMENT_DISABLE_EFFORT_MODELS (advertised: ${advertised.join(", ")})`
          );
        }
        entries.push({ baseId, effortLevels });
      }
      if (entries.length > 0) return entries;
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[modelRegistry] auggie models list failed (${reason}); using fallback model list`);
  }
  console.debug(`[modelRegistry] fallback model IDs: ${FALLBACK_MODEL_IDS.join(", ")}`);
  return FALLBACK_MODEL_IDS.map((baseId) => ({ baseId, effortLevels: [] }));
}

async function getModelEntries(): Promise<ModelEntry[]> {
  if (!cachedEntries) {
    cachedEntries = await fetchModelEntries();
  }
  return cachedEntries;
}

export async function getModelIds(): Promise<string[]> {
  if (!cachedModelIds) {
    const entries = await getModelEntries();
    cachedModelIds = entries.flatMap(expandModelEntry);
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

/**
 * Map an OpenAI `reasoning_effort` value to the closest Augment effort level
 * the model actually advertises, then return the suffixed model ID. Returns
 * `undefined` when no rewrite should happen, i.e. when:
 *   - the model is not a known base in the registry, or
 *   - the model has no advertised effort levels, or
 *   - no reasonable level mapping exists.
 *
 * Mapping rules:
 *   - "minimal" is treated as the lowest level (Augment has no minimal tier).
 *   - Exact (case-insensitive) match wins.
 *   - Otherwise snap to the closest level by index in ORDERED_EFFORT_LEVELS.
 */
export async function resolveEffortModelId(
  modelId: string,
  effort: ReasoningEffort
): Promise<string | undefined> {
  const entries = await getModelEntries();
  const entry = entries.find((e) => e.baseId === modelId);
  if (!entry || entry.effortLevels.length === 0) return undefined;

  const requested = effort === "minimal" ? "low" : effort;
  if (entry.effortLevels.includes(requested)) {
    return `${entry.baseId}-${requested}`;
  }

  const targetIdx = ORDERED_EFFORT_LEVELS.indexOf(
    requested as (typeof ORDERED_EFFORT_LEVELS)[number]
  );
  if (targetIdx === -1) return undefined;

  let best: string | undefined;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const level of entry.effortLevels) {
    const idx = ORDERED_EFFORT_LEVELS.indexOf(
      level as (typeof ORDERED_EFFORT_LEVELS)[number]
    );
    if (idx === -1) continue;
    const dist = Math.abs(idx - targetIdx);
    if (dist < bestDist) {
      bestDist = dist;
      best = level;
    }
  }
  return best ? `${entry.baseId}-${best}` : undefined;
}
