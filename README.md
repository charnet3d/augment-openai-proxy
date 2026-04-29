# augment-oai-proxy

OpenAI-compatible HTTP proxy that routes requests through the Augment SDK. Use any OpenAI-compatible client (Claude Code, Cursor, Continue, etc.) with Augment LLMs.

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

For example, with Claude Code:
```bash
OPENAI_BASE_URL=http://localhost:7888/v1 claude
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

### Reasoning effort

Augment encodes reasoning depth in the model ID itself: a base model like
`claude-opus-4-7` exposes suffixed variants (`-low`, `-medium`, `-high`,
`-max`, `-xhigh`) when the upstream advertises them. The proxy supports
both forms:

1. **Suffixed model ID directly.** Every advertised variant appears as its
   own entry in `GET /v1/models`. Pass it as `model` and you get that
   reasoning depth — e.g. `"model": "claude-opus-4-7-high"`.
2. **OpenAI `reasoning_effort` on the base ID.** Send the base model with a
   standard OpenAI `reasoning_effort` (`minimal` | `low` | `medium` | `high`)
   and the proxy rewrites the request to the suffixed backend ID before
   forwarding. The response echoes the original (base) `model` ID.

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

**Mapping rules.** Exact (case-insensitive) matches win. `minimal` is treated
as `low` (Augment has no minimal tier). Otherwise the requested level snaps
to the closest advertised level by index in `["low","medium","high","max",
"xhigh"]` — so requesting `high` on a model that only advertises
`["low","medium","max"]` resolves to `max`.

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

## Known Limitations

- **Token counting** — Augment does not expose exact token counts.
- **Image input is experimental** — see above; relies on a runtime SDK patch and may break on upstream changes.
- **No audio input** — audio content parts are not supported.
- **Rate limits** — subject to your Augment account tier.

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
