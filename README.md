# augment-open-proxy

OpenAI- and Anthropic-compatible HTTP proxy that routes requests through the Augment SDK. Use any OpenAI- or Anthropic-compatible client (Claude Code, Cursor, Continue, etc.) with Augment LLMs.

## Prerequisites

- **Node.js** 20 or later
- **Augment account** — authenticate via CLI:
  ```bash
  auggie login
  ```
  This stores your OAuth session in `~/.augment/session.json`, which the SDK picks up automatically.

## Installation

```bash
npm install
```

## Configuration

Copy `.env.example` to `.env` and set your values:

```env
PORT=7888
HOST=localhost
AUGMENT_API_TOKEN=
AUGMENT_API_URL=
```

| Variable | Required | Description |
|---|---|---|
| `PORT` | No | Server port (default: `7888`) |
| `HOST` | No | Bind address (default: `localhost`) |
| `AUGMENT_API_TOKEN` | No | API token for authentication. Falls back to `auggie login` session if omitted. |
| `AUGMENT_API_URL` | No | Tenant-specific API URL. Required when `AUGMENT_API_TOKEN` is set. |
| `AUGMENT_DISABLE_EFFORT_MODELS` | No | Comma- or whitespace-separated list of base model IDs (or CLI short names) whose effort variants should be hidden from `/v1/models` and not used for `reasoning_effort` rewriting. See [Reasoning effort](#reasoning-effort). |
| `LOGGING` | No | Per-request logging verbosity. `none` (silent), `info` (one line per request: method, path, status, durationMs, model, requestId, usage — default), or `body` (`info` plus full request and assembled response payloads). See [Structured logging](#structured-logging). |
| `LOG_FORMAT` | No | Output shape for log records: `text` (human-readable single line, default) or `json` (single-line JSON per record). See [Structured logging](#structured-logging). |

## Usage

### Start the proxy

```bash
npm run start
# or
npx tsx src/index.ts
```

The server starts on `http://localhost:7888` by default.

### curl examples

List available models:
```bash
curl http://localhost:7888/v1/models
```

Send a chat completion:
```bash
curl http://localhost:7888/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-5",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

### Use with coding agents

Point your agent's OpenAI base URL to the proxy:

```bash
OPENAI_BASE_URL=http://localhost:7888/v1
```

For Anthropic-native clients (Claude Code, Anthropic SDK), point them at the
Anthropic-compatible endpoint instead:

```bash
ANTHROPIC_BASE_URL=http://localhost:7888 claude
```

## API Endpoints

### `GET /v1/models`

Returns a list of available Augment models in the OpenAI models format.

**Response:**
```json
{
  "object": "list",
  "data": [
    { "id": "claude-sonnet-4-5", "object": "model", "owned_by": "augment" }
  ]
}
```

### `POST /v1/chat/completions`

Creates a chat completion. Accepts the standard OpenAI request body.

**Request body:**
```json
{
  "model": "claude-sonnet-4-5",
  "messages": [
    { "role": "user", "content": "Explain TypeScript generics." }
  ],
  "stream": true
}
```

**Response (streaming):** SSE stream of `chat.completion.chunk` events.

**Response (non-streaming):** Standard OpenAI `CreateChatCompletionResponse`.

### `POST /v1/chat/completions` with tool calling

Tool calling (function calling) is supported via the Augment SDK:

```json
{
  "model": "claude-sonnet-4-5",
  "messages": [
    { "role": "user", "content": "What's the weather in SF?" }
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Get the current weather",
        "parameters": {
          "type": "object",
          "properties": {
            "location": { "type": "string" }
          },
          "required": ["location"]
        }
      }
    }
  ]
}
```

### `POST /v1/messages`

Anthropic-compatible Messages API endpoint, suitable for Claude Code and the
official `@anthropic-ai/sdk` client. Accepts the standard Anthropic request
body (`model`, `messages`, `system`, `tools`, `tool_choice`, `max_tokens`,
`temperature`, `top_p`, `top_k`, `stop_sequences`, `thinking`, `stream`).

**Request body:**
```json
{
  "model": "claude-sonnet-4-5",
  "max_tokens": 1024,
  "messages": [
    { "role": "user", "content": "Explain TypeScript generics." }
  ],
  "stream": true
}
```

**Response (non-streaming):** Standard Anthropic `Message` envelope with
`content` blocks (`text`, `tool_use`, `thinking`), `stop_reason`, and `usage`.

**Response (streaming):** Anthropic SSE event sequence — `message_start` →
`content_block_start` / `content_block_delta` (`text_delta`,
`input_json_delta`, `thinking_delta`) / `content_block_stop` →
`message_delta` → `message_stop`.

**Extended thinking.** Pass `"thinking": { "type": "enabled",
"budget_tokens": N }` to map onto Augment's effort tiers (≤4096 → low,
≤16384 → medium, >16384 → high). When the registry advertises the
corresponding effort level for the requested base model, the request is
forwarded to the suffixed model ID (e.g. `claude-opus-4-7-high`) and the
response echoes the original base model.

### `POST /v1/messages/count_tokens`

Returns an estimated `input_tokens` count for a given message payload. The
Augment backend does not expose an exact counter, so this uses a 4-chars-
per-token heuristic — sufficient for budgeting / progress UIs but not for
billing-grade accuracy.

### Reasoning effort

Augment encodes reasoning depth in the model ID itself: a base model like
`claude-opus-4-7` exposes suffixed variants (`-low`, `-medium`, `-high`,
`-max`, `-xhigh`) when the upstream advertises them. The proxy supports
both forms:

1. **Suffixed model ID directly.** Every advertised variant appears as its
   own entry in `GET /v1/models`. Pass it as `model` and you get that
   reasoning depth — e.g. `"model": "claude-opus-4-7-high"`.
2. **OpenAI `reasoning_effort` on the base ID.** Send the base model with a
   standard OpenAI `reasoning_effort` (`none` | `minimal` | `low` | `medium`
   | `high` | `xhigh`) and the proxy rewrites the request to the suffixed
   backend ID before forwarding. The response echoes the original (base)
   `model` ID.

```json
{
  "model": "claude-opus-4-7",
  "messages": [{ "role": "user", "content": "Plan a refactor of foo()." }],
  "reasoning_effort": "high"
}
```

The Responses-API nested form is also accepted:
`"reasoning": { "effort": "medium", "summary": "concise" }`. When both forms
are set, the nested one wins.

**Mapping rules.** Exact (case-insensitive) matches win. `none` is forwarded
to the base model with no depth suffix (use it to opt out of reasoning).
`minimal` is treated as `low` (Augment has no minimal tier). `xhigh` matches
Augment's `xhigh` tier directly. Otherwise the requested level snaps to the
closest advertised level by index in `["low","medium","high","max","xhigh"]`
— so requesting `high` on a model that only advertises `["low","medium",
"max"]` resolves to `max`, and `xhigh` on a model without it snaps to `max`.

If a model has no advertised effort levels, `reasoning_effort` is forwarded
to the SDK as a `providerOptions.augment.reasoningEffort` hint and the
model ID is left untouched.

#### Disabling effort variants per model

Some models advertise effort levels in the CLI but currently 404 on the
backend when the suffixed ID is sent (observed for `claude-opus-4-6` —
likely an entitlement/rollout gap). Suppress them with
`AUGMENT_DISABLE_EFFORT_MODELS`:

```env
AUGMENT_DISABLE_EFFORT_MODELS=claude-opus-4-6
# or, equivalently, using CLI short names:
AUGMENT_DISABLE_EFFORT_MODELS=opus4.6,sonnet4.6
```

Listed models still appear in `/v1/models` under their base ID, but their
suffixed variants are hidden and `reasoning_effort` against them is a
no-op (the request is sent as-is to the base model).

### Image input (experimental)

Image input is supported via the standard OpenAI `image_url` content part:

```json
{
  "model": "claude-sonnet-4-5",
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "What's in this image?" },
        { "type": "image_url", "image_url": { "url": "data:image/png;base64,..." } }
      ]
    }
  ]
}
```

Both data URLs (`data:image/<png|jpeg|gif|webp>;base64,...`) and remote URLs are accepted; remote URLs are downloaded by the AI SDK before being forwarded. Audio is not supported.

This feature relies on a runtime patch of `@augmentcode/auggie-sdk` because the upstream SDK does not yet expose its image wire format. The wire shape may change without notice on the Augment side.

### Structured logging

Per-request logs are emitted to stdout, one record per request, controlled
by two environment variables: `LOGGING` (verbosity) and `LOG_FORMAT` (shape).

**Levels** (`LOGGING`):

| Level | What is logged |
|---|---|
| `none` | Nothing — silent. |
| `info` *(default)* | `ts`, `method`, `path`, `status`, `durationMs`, `requestId`, `model`, `effectiveModel` (when the effort suffix swap rewrote the ID), `stream`, and `usage` (`input_tokens` / `output_tokens` / `total_tokens`). |
| `body` | Everything in `info` plus the parsed `request` body and the assembled `response` body. For streaming responses the assembled response is the concatenated text / thinking / tool-call arguments — not the raw SSE frames. |

**Formats** (`LOG_FORMAT`):

| Format | When to use |
|---|---|
| `text` *(default)* | Human-readable single line. Best for local development and tailing. `body` mode appends the request and response on indented continuation lines. |
| `json` | Single-line JSON per record. Best for `jq`, Loki, Vector, or any structured log collector. |

Example `info` line, `text` format:

```
[2026-05-04T12:34:56.789Z] INFO POST /v1/chat/completions 200 842ms model=claude-sonnet-4-5 req=chatcmpl-… tokens=42/128/170
```

Same record, `json` format:

```json
{"ts":"2026-05-04T12:34:56.789Z","level":"info","method":"POST","path":"/v1/chat/completions","status":200,"durationMs":842,"requestId":"chatcmpl-…","model":"claude-sonnet-4-5","stream":false,"usage":{"input_tokens":42,"output_tokens":128,"total_tokens":170}}
```

`body` mode also captures errors (`error` field) for failed generations.

## Known Limitations

- **Token counting** — Augment does not expose exact token counts.
- **Image input is experimental** — see above; relies on a runtime SDK patch and may break on upstream changes.
- **No audio input** — audio content parts are not supported.
- **Rate limits** — subject to your Augment account tier.

## Note about some prompts

Certain user prompts cause `claude-sonnet-4-6` to hang at the Augment
backend: the upstream `chat-stream` endpoint accepts the connection,
returns `200 OK` headers, then writes zero body bytes. Other prompts on
the same proxy, credentials, and model continue to succeed, so this is a
prompt-content issue at the upstream — not the proxy, the account, or the
request size.

Reproducer: Originally [`scripts/prompt-causing-issue.md`](scripts/prompt-causing-issue.md)
 a 21-line "3d Rubik's in an HTML file" request. But the issue
was reproduced even with a one sentence prompt: "build a 3d rubiks cube in an html file". It fails
identically through:

- Claude Code (full system prompt + 50+ tools, ~125 KB body)
- pi-agent (minimal system prompt, no tools, ~1 KB body)
- OpenWebUI (no agent wrapper at all)
- raw `curl` against `/v1/messages` and `/v1/chat/completions`
- **More importantly**: The official Augment VS Code extension, not using this proxy.

How it surfaces:

- After roughly 5–6 minutes the **backend** ends the stream early —
  it sends a terminal frame with no content and `input_tokens = 0`
  (no usage at all). This is not a client- or proxy-side timeout.

Workarounds:

- Reword the prompt; some simpler variations worked but no general pattern
  emerged.
- Switch to `claude-sonnet-4-5` or `claude-sonnet-4` for the same
  prompt — both return normally.

If you can reproduce against your own tenant, share the failing `req=` id
from the proxy log with Augment support — they have the upstream traces
that the proxy does not.

## Troubleshooting

| Problem | Fix |
|---|---|
| `401 Unauthorized` or auth errors | Run `auggie login` and re-authenticate, or set `AUGMENT_API_TOKEN` and `AUGMENT_API_URL` in `.env`. |
| `model not found` | Check the model name — use `claude-sonnet-4-5`, `claude-haiku-4-5`, `claude-opus-4-1`, etc. See your Augment dashboard for available models. |
| Proxy won't start | Verify `PORT` is not already in use: `netstat -ano \| findstr :7888` |
| Streaming hangs | Ensure `stream: true` is set in the request body and the client supports SSE. |
| SDK connection errors | Check your network connection and that `~/.augment/session.json` exists and is not expired. Run `auggie login` to refresh. |

## Development

### Tests

| Command | Scope |
|---|---|
| `npm test` | Unit + integration tests. No network. Safe to run in CI without secrets. |
| `npm run test:watch` | Unit + integration tests in watch mode. |
| `npm run test:coverage` | Unit + integration tests with v8 coverage report. |
| `npm run test:e2e` | End-to-end tests against the real Augment API. Requires `auggie login` or `AUGMENT_API_TOKEN` + `AUGMENT_API_URL` in `.env`; the suite self-skips when no credentials are detected. |

The e2e suite is excluded from the default run via `vitest.config.ts` and lives under its own config (`vitest.e2e.config.ts`) so unit-test runs stay hermetic and fast.

## Project Structure

```
src/
  index.ts          # Entry point — starts the Hono server
  routes/           # OpenAI-compatible route handlers
  services/         # Augment SDK client + experimental image patch
  types/            # Shared TypeScript types
  utils/            # Request/response transformers
  __tests__/        # Vitest unit, integration, and e2e suites
```
