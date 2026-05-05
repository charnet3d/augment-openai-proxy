import type { Context, MiddlewareHandler } from "hono";
import { LOG_LEVEL, LOG_FORMAT, type LogLevel, type LogFormat } from "../config";

/**
 * Structured per-request log record. Emitted as a single JSON line on stdout
 * so downstream collectors (Loki / Vector / jq) can parse without context.
 */
export interface LogRecord {
  ts: string;
  level: "info";
  method: string;
  path: string;
  status: number;
  durationMs: number;
  requestId?: string;
  model?: string;
  effectiveModel?: string;
  stream?: boolean;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
  request?: unknown;
  response?: unknown;
  error?: string;
}

interface LogState {
  start: number;
  level: LogLevel;
  data: Partial<LogRecord>;
  flushed: boolean;
}

const STATE_KEY = "__log_state";

export function getLogLevel(): LogLevel {
  return LOG_LEVEL;
}

export function getLogFormat(): LogFormat {
  return LOG_FORMAT;
}

/**
 * Render a record as a single human-readable line. The body-level payloads
 * (`request` / `response`) are appended on continuation lines, indented two
 * spaces, so a `tail -f` view stays scannable.
 */
function formatText(record: LogRecord): string {
  const parts: string[] = [
    `[${record.ts}]`,
    record.level.toUpperCase(),
    record.method,
    record.path,
    String(record.status),
    `${record.durationMs}ms`,
  ];
  if (record.model) parts.push(`model=${record.model}`);
  if (record.effectiveModel) parts.push(`effective=${record.effectiveModel}`);
  if (record.stream) parts.push("stream=true");
  if (record.requestId) parts.push(`req=${record.requestId}`);
  if (record.usage) {
    const u = record.usage;
    parts.push(`tokens=${u.input_tokens ?? "?"}/${u.output_tokens ?? "?"}/${u.total_tokens ?? "?"}`);
  }
  if (record.error) {
    const escaped = record.error.replaceAll('"', String.raw`\"`);
    parts.push(`error="${escaped}"`);
  }
  let line = parts.join(" ");
  if (record.request !== undefined) line += `\n  request: ${JSON.stringify(record.request)}`;
  if (record.response !== undefined) line += `\n  response: ${JSON.stringify(record.response)}`;
  return line;
}

/**
 * Emit a structured log record to stdout. Centralised so tests can spy on
 * console.log and so future sinks (file, syslog) can swap here. The output
 * shape is governed by `LOG_FORMAT`.
 */
export function emitLog(record: LogRecord): void {
  if (getLogFormat() === "text") {
    console.log(formatText(record));
  } else {
    console.log(JSON.stringify(record));
  }
}

/**
 * Merge fields into the per-request log payload. Handlers call this after
 * computing the model / usage / response body so the final flush has all
 * the data.
 */
export function attachLogData(c: Context, partial: Partial<LogRecord>): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const state = c.get(STATE_KEY) as LogState | undefined;
  if (!state) return;
  state.data = { ...state.data, ...partial };
}

/**
 * Emit the log record now and prevent the middleware from emitting again.
 * Used by streaming handlers from inside `controller.close()` so the line
 * carries the assembled response body / final usage.
 */
export function flushLog(c: Context, status: number): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const state = c.get(STATE_KEY) as LogState | undefined;
  if (!state || state.flushed) return;
  state.flushed = true;
  if (state.level === "none") return;
  const record: LogRecord = {
    ts: new Date().toISOString(),
    level: "info",
    method: state.data.method ?? "",
    path: state.data.path ?? "",
    status,
    durationMs: Date.now() - state.start,
    ...state.data,
  };
  if (state.level !== "body") {
    delete record.request;
    delete record.response;
  }
  emitLog(record);
}

/**
 * Hono middleware that captures request metadata and (optionally) a parsed
 * JSON body, then emits a structured log line after the handler returns.
 * Streaming handlers should call `flushLog` from their close path so the
 * line includes the final assembled response.
 */
export function loggingMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const level = getLogLevel();
    const url = new URL(c.req.url);
    const state: LogState = {
      start: Date.now(),
      level,
      data: { method: c.req.method, path: url.pathname },
      flushed: false,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    c.set(STATE_KEY as any, state);

    if (level === "body" && c.req.header("content-type")?.includes("application/json")) {
      try {
        // Hono caches the parsed body; subsequent c.req.json() calls in
        // handlers reuse this without re-reading the stream.
        state.data.request = await c.req.json();
      } catch {
        // Body is not valid JSON — leave request undefined; the handler
        // will surface the parse error in its own response.
      }
    }

    try {
      await next();
    } finally {
      // Streaming handlers consume the response stream lazily, after `next()`
      // returns. They take ownership of the flush by calling `flushLog` from
      // their close path (so the line carries the assembled response and
      // final usage). For everything else the middleware emits here.
      if (!state.flushed && state.data.stream !== true) {
        flushLog(c, c.res.status);
      }
    }
  };
}

/**
 * Truncate a string for safe inclusion in a log record. Long stream
 * payloads can balloon a single line into megabytes; this caps to a
 * reasonable size while preserving a marker.
 */
export function truncateForLog(value: string, max = 64_000): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…[truncated ${value.length - max} chars]`;
}
