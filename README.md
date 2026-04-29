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

## Known Limitations

- **Token counting** — Augment does not expose exact token counts.
- **No multimodal** — image and audio inputs are not supported.
- **Rate limits** — subject to your Augment account tier.

## Troubleshooting

| Problem | Fix |
|---|---|
| `401 Unauthorized` or auth errors | Run `auggie login` and re-authenticate, or set `AUGMENT_API_TOKEN` and `AUGMENT_API_URL` in `.env`. |
| `model not found` | Check the model name — use `claude-sonnet-4-5`, `claude-haiku-4-5`, `claude-opus-4-1`, etc. See your Augment dashboard for available models. |
| Proxy won't start | Verify `PORT` is not already in use: `netstat -ano \| findstr :7888` |
| Streaming hangs | Ensure `stream: true` is set in the request body and the client supports SSE. |
| SDK connection errors | Check your network connection and that `~/.augment/session.json` exists and is not expired. Run `auggie login` to refresh. |

## Project Structure

```
src/
  index.ts          # Entry point — starts the Hono server
  routes/           # OpenAI-compatible route handlers
  services/         # Augment SDK client and completion logic
  types/            # Shared TypeScript types
```
