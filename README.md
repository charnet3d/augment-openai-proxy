# augment-open-proxy

OpenAI- and Anthropic-compatible HTTP proxy that routes requests through the Augment SDK. Use any OpenAI- or Anthropic-compatible client (Claude Code, Cursor, Continue, etc.) with Augment LLMs.

## Prerequisites

- **Node.js** 22 or later
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
AOP_PORT=7888
AOP_HOST=localhost
AUGMENT_API_TOKEN=
AUGMENT_API_URL=
```

| Variable | Required | Description |
|---|---|---|
| `AOP_PORT` | No | Server port (default: `7888`) |
| `AOP_HOST` | No | Bind address (default: `localhost`) |
| `AUGMENT_API_TOKEN` | No | API token for authentication. Falls back to `auggie login` session if omitted. |
| `AUGMENT_API_URL` | No | Tenant-specific API URL. Required when `AUGMENT_API_TOKEN` is set. |
| `AOP_DISABLE_EFFORT_MODELS` | No | Comma- or whitespace-separated list of base model IDs (or CLI short names) whose effort variants should be hidden from `/v1/models` and not used for `reasoning_effort` rewriting. See [Reasoning effort](API.md#reasoning-effort). |
| `AOP_LOGGING` | No | Per-request logging verbosity. `none` (silent), `info` (one line per request: method, path, status, durationMs, model, requestId, usage — default), or `body` (`info` plus full request and assembled response payloads). See [Structured logging](API.md#structured-logging). |
| `AOP_LOG_FORMAT` | No | Output shape for log records: `text` (human-readable single line, default) or `json` (single-line JSON per record). See [Structured logging](API.md#structured-logging). |
| `AOP_HEADERS_TIMEOUT_MS` | No | Milliseconds to wait for the first response byte from the upstream (default: `1800000` = 30 min). Node's default 5-minute limit trips long thinking calls; this raises it. Set to `0` to disable. |
| `AOP_BODY_TIMEOUT_MS` | No | Milliseconds allowed between consecutive body chunks from the upstream (default: `1800000` = 30 min). Set to `0` to disable. |
| `AOP_CONNECT_TIMEOUT_MS` | No | Milliseconds for the TCP connect handshake to the upstream (default: `30000` = 30 s). Set to `0` to disable. |

## Usage

### Start the proxy

```bash
npm run start
# or
npx tsx src/index.ts
```

The server starts on `http://localhost:7888` by default.

### Run with Docker Compose

A `docker-compose.yml` is included. It runs the proxy inside a Node 22 Alpine
container with your local source mounted, so no separate build step is needed.

**Session-based auth** (recommended — uses `auggie login`):

```bash
# 1. Authenticate on the host once
auggie login

# 2. Start the proxy (your ~/.augment session is mounted read-only)
docker compose up
```

**Token-based auth** (CI / headless environments):

```bash
AUGMENT_API_TOKEN=<token> AUGMENT_API_URL=<url> docker compose up
```

The proxy is available at `http://localhost:7888` once the health-check passes.
Override the port with `AOP_PORT=<n> docker compose up`.

To run in the background:
```bash
docker compose up -d
docker compose logs -f   # tail logs
docker compose down      # stop
```

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

See **[API.md](API.md)** for the full endpoint reference, including:

- `GET /v1/models` — list available models
- `POST /v1/chat/completions` — OpenAI Chat Completions (streaming + tool calling)
- `POST /v1/responses` — OpenAI Responses API (streaming + tool calling + reasoning)
- `POST /v1/messages` — Anthropic Messages API (Claude Code, `@anthropic-ai/sdk`)
- `POST /v1/messages/count_tokens` — token-count estimation
- [Reasoning effort](API.md#reasoning-effort) — suffixed model IDs and `reasoning_effort` rewriting
- [Image input](API.md#image-input-experimental) — `image_url` content parts (experimental)
- [Structured logging](API.md#structured-logging) — `AOP_LOGGING` / `AOP_LOG_FORMAT`

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
| Proxy won't start | Verify `AOP_PORT` is not already in use: `netstat -ano \| findstr :7888` |
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
