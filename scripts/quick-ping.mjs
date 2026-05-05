// Tiny baseline to confirm the proxy + upstream still serve trivial requests
// while a large request is hung. No tools, no system, no skills.
const startedAt = Date.now();
const elapsed = () => `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;

const res = await fetch("http://localhost:7888/v1/messages", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    model: "claude-haiku-4-5",
    max_tokens: 50,
    messages: [{ role: "user", content: "say hi in one word" }],
    stream: true,
  }),
});

console.error(`HTTP ${res.status} headers at ${elapsed()}`);
const reader = res.body.getReader();
const decoder = new TextDecoder();
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  const text = decoder.decode(value, { stream: true });
  for (const line of text.split(/\n+/)) {
    if (!line.trim()) continue;
    if (line.length > 160) console.log(`[${elapsed()}] ${line.slice(0, 160)}…`);
    else console.log(`[${elapsed()}] ${line}`);
  }
}
console.error(`done at ${elapsed()}`);
