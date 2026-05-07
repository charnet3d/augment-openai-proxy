// Ad-hoc probe: ask the Augment backend to generate one token with each
// candidate model ID variant and report whether the model is recognised.
// Run with:  node scripts/probe-effort-models.mjs
//
// What we're testing: whether suffixed model IDs like
// `claude-opus-4-7-low` / `-medium` / `-high` / `-max` / `-xhigh` are
// accepted as distinct models by the backend. The CLI's `effortLevels`
// metadata lists these levels but never sends them in any request, so the
// only place they could be encoded is in the model name itself.
//
// "Accepted" here means: no "model not found" / "unknown model" error.
// We don't care about the actual completion — only whether the backend
// rejects the model ID.

import { generateText } from "ai";
import { AugmentLanguageModel, resolveAugmentCredentials } from "@augmentcode/auggie-sdk";

// Round 3: all models that advertise effortLevels in the registry.
// Union of declared levels across all models:
//   Low, Medium, High, xHigh, Max
// (xHigh is Opus 4.7 only; Low/Max absent from Opus 4.7)
// Probing all casings/separators in case undocumented variants exist.
const BASES = [
  // "claude-opus-4-6",        // effortLevels: Low, Medium, High, Max
  // "claude-opus-4-6-500k",   // effortLevels: Low, Medium, High, Max
  "claude-opus-4-7",        // effortLevels: Medium, High, xHigh
  // "claude-opus-4-7-500k",   // effortLevels: High
  // "claude-sonnet-4-6-500k", // effortLevels: Low, Medium, High, Max\
];
const SUFFIXES = [
  "",
  "-Low", "-Medium", "-High", "-xHigh", "-Max",       // CLI casing as-is
];

const creds = await resolveAugmentCredentials();
console.log(`apiUrl: ${creds.apiUrl}`);
console.log(`auth: ${creds.apiKey ? "apiKey present" : "no apiKey"}\n`);

const results = [];

for (const base of BASES) {
  for (const suffix of SUFFIXES) {
    const modelId = base + suffix;
    process.stdout.write(`  ${modelId.padEnd(32)} → `);
    const model = new AugmentLanguageModel(modelId, {
      apiKey: creds.apiKey,
      apiUrl: creds.apiUrl,
      clientUserAgent: "augment-open-proxy-probe/1.0.0",
    });
    try {
      const r = await generateText({
        model,
        messages: [{ role: "user", content: "hi" }],
        maxOutputTokens: 1,
      });
      const txt = (r.text ?? "").slice(0, 30).replace(/\s+/g, " ");
      console.log(`OK  (text=${JSON.stringify(txt)})`);
      results.push({ modelId, ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const oneLine = msg.split("\n")[0].slice(0, 200);
      console.log(`ERR (${oneLine})`);
      results.push({ modelId, ok: false, error: oneLine });
    }
  }
  console.log();
}

console.log("\n── Summary ──");
const accepted = results.filter((r) => r.ok).map((r) => r.modelId);
const rejected = results.filter((r) => !r.ok);
console.log(`Accepted (${accepted.length}):`);
for (const id of accepted) console.log(`  ${id}`);
console.log(`\nRejected (${rejected.length}):`);
const byMsg = new Map();
for (const r of rejected) {
  const key = r.error ?? "unknown";
  if (!byMsg.has(key)) byMsg.set(key, []);
  byMsg.get(key).push(r.modelId);
}
for (const [msg, ids] of byMsg) {
  console.log(`  [${msg}]`);
  for (const id of ids) console.log(`    ${id}`);
}
