// Replays the request body from a `request:` continuation line in log.txt
// against a locally-running proxy and prints raw SSE events as they arrive.
// Usage:
//   node scripts/replay-failing-request.mjs <log-line-number> [endpoint]
// where <endpoint> is "messages" (default) or "chat".

import { readFileSync } from "node:fs";

const lineArg = process.argv[2];
const endpoint = process.argv[3] ?? "messages";
if (!lineArg) {
  console.error("usage: node scripts/replay-failing-request.mjs <line-number> [messages|chat]");
  process.exit(1);
}
const lineNumber = Number.parseInt(lineArg, 10);

const lines = readFileSync("log.txt", "utf8").split(/\r?\n/);
const target = lines[lineNumber - 1];
if (!target) {
  console.error(`line ${lineNumber} not found in log.txt`);
  process.exit(1);
}
const match = target.match(/^\s*request:\s*(\{[\s\S]*\})\s*$/);
if (!match) {
  console.error(`line ${lineNumber} does not look like a 'request:' continuation line`);
  console.error(`got: ${target.slice(0, 120)}…`);
  process.exit(1);
}
const body = match[1];
const parsed = JSON.parse(body);

const url =
  endpoint === "chat"
    ? "http://localhost:7888/v1/chat/completions"
    : "http://localhost:7888/v1/messages";

console.error(`POST ${url}`);
console.error(`model: ${parsed.model}  stream: ${parsed.stream === true}  bytes: ${body.length}`);
console.error("---");

const startedAt = Date.now();
let firstByteMs = null;
let totalBytes = 0;
let chunks = 0;

const res = await fetch(url, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body,
});

const elapsed = () => `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
console.error(`HTTP ${res.status} headers received at ${elapsed()}`);
console.error(`content-type: ${res.headers.get("content-type")}`);

if (!res.body) {
  const text = await res.text();
  console.error(`(no body) — ${text}`);
  process.exit(0);
}

const reader = res.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  if (firstByteMs === null) {
    firstByteMs = Date.now() - startedAt;
    console.error(`first bytes after ${(firstByteMs / 1000).toFixed(1)}s`);
  }
  totalBytes += value.byteLength;
  chunks++;
  buffer += decoder.decode(value, { stream: true });
  // Emit per-event so we see the stream live.
  let idx;
  while ((idx = buffer.indexOf("\n\n")) !== -1) {
    const event = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 2);
    const summary = event.length > 200 ? `${event.slice(0, 200)}…` : event;
    console.log(`[${elapsed()}] ${summary.replace(/\n/g, " | ")}`);
  }
}
if (buffer.trim()) {
  console.log(`[${elapsed()}] (tail) ${buffer.slice(0, 200)}`);
}
console.error("---");
console.error(`done at ${elapsed()}: ${chunks} chunks, ${totalBytes} bytes`);
