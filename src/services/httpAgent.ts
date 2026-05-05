import { Agent, setGlobalDispatcher } from "undici";

/**
 * Node's global `fetch` (undici) defaults to a 5-minute `headersTimeout` and
 * 5-minute `bodyTimeout`. The Augment SDK uses the global fetch with no
 * dispatcher override, so any LLM call that takes longer than 5 minutes to
 * start streaming (e.g. opus with high reasoning effort) fails with
 * `UND_ERR_HEADERS_TIMEOUT`. Install a dispatcher with timeouts that
 * comfortably accommodate slow thinking calls.
 *
 * All values are in milliseconds. `0` disables the corresponding timeout.
 *
 * Env vars:
 *   AUGMENT_HEADERS_TIMEOUT_MS — first response byte (default: 1_800_000 = 30 min)
 *   AUGMENT_BODY_TIMEOUT_MS    — between body chunks  (default: 1_800_000 = 30 min)
 *   AUGMENT_CONNECT_TIMEOUT_MS — TCP connect          (default: 30_000  = 30 s)
 */
export interface HttpAgentTimeouts {
  headersTimeout: number;
  bodyTimeout: number;
  connectTimeout: number;
}

const DEFAULT_HEADERS_TIMEOUT_MS = 1_800_000; // 30 minutes
const DEFAULT_BODY_TIMEOUT_MS = 1_800_000; // 30 minutes
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000; // 30 seconds

/**
 * Parse a non-negative integer milliseconds value from an env var. Returns
 * `fallback` for missing, empty, or invalid input. `0` is preserved (it
 * disables the timeout in undici).
 */
export function parseTimeoutMs(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (trimmed === "") return fallback;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return fallback;
  return n;
}

/**
 * Build the timeout config from `process.env`. Exposed for testing.
 */
export function readTimeoutsFromEnv(env: NodeJS.ProcessEnv = process.env): HttpAgentTimeouts {
  return {
    headersTimeout: parseTimeoutMs(env.AUGMENT_HEADERS_TIMEOUT_MS, DEFAULT_HEADERS_TIMEOUT_MS),
    bodyTimeout: parseTimeoutMs(env.AUGMENT_BODY_TIMEOUT_MS, DEFAULT_BODY_TIMEOUT_MS),
    connectTimeout: parseTimeoutMs(env.AUGMENT_CONNECT_TIMEOUT_MS, DEFAULT_CONNECT_TIMEOUT_MS),
  };
}

/**
 * Install a global undici dispatcher with the given timeouts. Affects every
 * subsequent call to Node's global `fetch`, including the ones the Augment
 * SDK makes internally. Idempotent — safe to call once at process startup.
 */
export function installHttpAgent(timeouts: HttpAgentTimeouts = readTimeoutsFromEnv()): void {
  const agent = new Agent({
    headersTimeout: timeouts.headersTimeout,
    bodyTimeout: timeouts.bodyTimeout,
    connect: { timeout: timeouts.connectTimeout },
  });
  setGlobalDispatcher(agent);
}
