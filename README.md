<p align="center">
  <img src="https://raw.githubusercontent.com/tripolskypetr/agent-runtime/master/public/logo.png" height="115px" alt="agent-runtime" />
</p>

<p align="center">
  <strong>agent-runtime</strong><br>
  REST API harness for a <a href="https://github.com/earendil-works/pi">pi</a>-based AI agent on Ollama.<br>
  Structured JSON answers · SQLite history · admin UI · Swagger · <br>bash and image tools in an isolated workspace
</p>

## What it does

`POST /api/v1/inference` takes a conversation (text and photos), a set of files and a JSON schema, runs an agent and returns an object that matches the schema. `POST /api/v1/text` does the same without a schema and returns the agent's final message as plain text (the `generateObject` / `generateText` pair of json-inference).

![screenshot](https://raw.githubusercontent.com/tripolskypetr/agent-runtime/master/screenshots/screenshot1.png)

The agent loop is [`@earendil-works/pi-agent-core`](https://github.com/earendil-works/pi/tree/main/packages/agent); inference goes through the [`ollama`](https://www.npmjs.com/package/ollama) SDK with native tool calling, exactly like `OllamaProvider` in [json-inference](https://github.com/tripolskypetr/json-inference). Every run has three tools:

| Tool | Purpose |
|------|---------|
| `provide_answer` | The only way to finish. Its parameters are the request `format`; arguments are validated with the json-inference validator. |
| `bash` | Shell in the data workspace, modelled after pi's bash tool: combined stdout/stderr, timeout, process-group kill, truncated output. |
| `view_image` | Shows an image from the workspace to a vision model. |

Harness rules:

1. The workspace (`DATA_DIR`, `/app/data` in Docker) is wiped before and after every inference. Request files are written there; images from messages go to `images/message_<i>_<j>.<ext>` and are also attached to the message when `OLLAMA_VISION=1`.
2. If the model answers with text instead of calling `provide_answer`, a user message demanding the tool call is appended and the model is prompted again on the same conversation, up to `MAX_ATTEMPTS` times.
3. Inferences run one at a time (shared workspace); callers queue.
4. Every inference, successful or failed, is stored in SQLite with the full transcript, request files, images, images viewed by tools and files the agent produced.
5. A failed inference returns HTTP 500 with a JSON error (`schema_mismatch`, `empty_answer`, `max_turns`, `timeout`, `provider_error`, `internal_error`).

## Quick start (Docker)

```bash
mkdir agent-runtime && cd agent-runtime
curl -O https://raw.githubusercontent.com/tripolskypetr/agent-runtime/master/config/docker-compose.yaml
curl -o .env https://raw.githubusercontent.com/tripolskypetr/agent-runtime/master/config/.env.example
# set OLLAMA_API_KEY in .env (https://ollama.com/settings/keys)
docker compose up -d
```

- Swagger UI: http://localhost:10050/docs
- Admin UI (no password): http://localhost:10050/admin
- Health: http://localhost:10050/api/v1/health

The SQLite database lives in `./storage` and the debug log in `./logs/debug.log` next to the compose file.

## API

### `POST /api/v1/inference`

```json
{
  "messages": [
    { "role": "user", "content": "Обзор рынка 07.09.2023 ..." },
    { "role": "user", "content": "", "images": ["<base64 jpeg>"] }
  ],
  "files": [
    { "name": "sales.csv", "content": "<base64>" }
  ],
  "format": {
    "type": "object",
    "required": ["summary", "sentiment"],
    "properties": {
      "summary":   { "type": "string", "description": "Краткое содержание" },
      "sentiment": { "type": "string", "enum": ["bullish", "bearish", "neutral"], "description": "Настроение" }
    }
  },
  "model": "gemma4:31b-cloud",
  "instructions": "optional extra system prompt"
}
```

`messages` is the same shape as a record of `wwwroot.jsonl` (`role`, `content`, optional `images` as base64). `format` is a json-inference `FormatModel`, so schemas written for `generateObject()` work unchanged. `model` and `instructions` are optional.

Success (200):

```json
{ "id": "…", "status": "success", "data": { "summary": "…", "sentiment": "bullish" }, "model": "gemma4:31b-cloud", "attempts": 1, "turns": 3, "durationMs": 8421 }
```

Failure (500):

```json
{ "id": "…", "status": "error", "error": { "code": "schema_mismatch", "message": "Model failed to call provide_answer with a valid answer after 3 attempts", "details": ["attempt 1: model replied with text instead of calling provide_answer: …", "attempt 2: provide_answer rejected: Invalid arguments: sentiment: expected one of [bullish, bearish, neutral], got \"positive\"", "…"] }, "model": "…", "attempts": 3, "turns": 7, "durationMs": 30211 }
```

Malformed requests are rejected with 400 before an inference is created.

### `POST /api/v1/text`

The `generateText` counterpart: the same `messages`, `files`, `model` and `instructions`, no `format`. The agent still has `bash` and `view_image`; the text of its final message is returned as is.

```json
{ "messages": [{ "role": "user", "content": "Summarise report.pdf in three sentences" }], "files": [{ "name": "report.pdf", "content": "<base64>" }] }
```

```json
{ "id": "…", "status": "success", "text": "The report …", "model": "gemma4:31b-cloud", "attempts": 1, "turns": 3, "durationMs": 5120 }
```

If the model finishes without text it is asked again up to `MAX_ATTEMPTS` times, then a 500 with code `empty_answer` is returned. Text runs are stored like the others and marked `mode: "text"` in the admin UI and in `GET /api/v1/inferences?mode=text`.

**Long requests.** The response is sent only when the agent finishes, which can take minutes (several model turns, bash commands, retries). Use an HTTP client without a response timeout: Node's `fetch` gives up after 300 s by default, so call it with an `undici` `Agent({ headersTimeout: 0, bodyTimeout: 0 })` or use `node:http` as [scripts/smoke.ts](scripts/smoke.ts) does. The server itself has no request timeout; `INFERENCE_TIMEOUT_MS` bounds the agent. Model calls go to Ollama as streaming requests, so slow models do not hit the same 300 s limit inside the harness.

### Admin API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/inferences?limit&offset&status&mode` | List inferences, newest first |
| `GET` | `/api/v1/inferences/:id` | Request, transcript, result or error, attachments |
| `GET` | `/api/v1/inferences/:id/attachments/:attachmentId` | Raw bytes of a file or image (`?download=true` to download) |
| `DELETE` | `/api/v1/inferences/:id` | Delete an inference |
| `GET` | `/api/v1/health` | Model, host, queue state |

## SDK

[packages/sdk](packages/sdk) ships `agent-runtime-sdk`, a typed Node.js client over `fetch` with the json-inference `generateObject()` / `generateText()` pair. The answer type is inferred from the schema, so it has IntelliSense:

```typescript
import { generateObject } from "agent-runtime-sdk";

const entry = await generateObject(
  {
    messages: [{ role: "user", content: "…" }],
    format: { type: "object", required: ["position"], properties: { position: { type: "string", enum: ["long", "short", "wait"], description: "…" } } },
  },
  { baseUrl: "http://localhost:10050" }, // optional; defaults to AGENT_RUNTIME_URL or http://localhost:10050
);
entry.position; // "long" | "short" | "wait"
```

See the [SDK README](packages/sdk/README.md) for the full API, error handling and long-request setup.

## Configuration

All settings are environment variables (see [config/.env.example](config/.env.example)).

| Variable | Default | Meaning |
|----------|---------|---------|
| `OLLAMA_HOST` | `https://ollama.com` | Ollama endpoint. Local: `http://host.docker.internal:11434` |
| `OLLAMA_API_KEY` | | Bearer token for ollama.com |
| `OLLAMA_MODEL` | `gemma4:31b-cloud` | Default model; a request may override it |
| `OLLAMA_VISION` | `1` | Attach images to messages and enable `view_image` |
| `OLLAMA_THINK` | | `true`/`false` or `low`/`medium`/`high`; empty = model default. The `.env.example` sets `false` so thinking is off unless you enable it |
| `MAX_ATTEMPTS` | `3` | Re-prompts when `provide_answer` was not called |
| `MAX_TURNS` | `40` | Model calls per inference |
| `INFERENCE_TIMEOUT_MS` | `900000` | Hard limit per inference |
| `BASH_TIMEOUT_SEC` | `120` | Default bash command timeout |
| `BODY_LIMIT_MB` | `256` | Request body limit |
| `DATA_DIR` | `./data` | Agent workspace |
| `DB_PATH` | `./storage/agent-runtime.sqlite` | SQLite file |
| `SYSTEM_PROMPT_PATH` | `./assets/system.mustache` | System prompt template for `/inference` (re-read when changed) |
| `SYSTEM_PROMPT_TEXT_PATH` | `./assets/system-text.mustache` | System prompt template for `/text` |
| `LOGS_DIR` / `LOG_FILE` | `./logs` / `debug.log` | Debug log location (see [Logging](#logging)) |
| `LOG_CONSOLE` | `warn` | Echo of the debug log to stdout: `all`, `warn`, `off` |

The system prompts are Mustache templates in [assets/system.mustache](assets/system.mustache) and [assets/system-text.mustache](assets/system-text.mustache); they receive the workspace path, file and image lists, the schema (object mode) and the extra instructions.

## Logging

Everything the service does is written to `./logs/debug.log` (`/app/logs/debug.log` in Docker, mounted as `./logs` by the compose file) through [pinolog](https://www.npmjs.com/package/pinolog): pino with rotation at 100 MB. One JSON line per event, `args` holds `[scope, message, data]`:

```json
{"level":30,"time":1793300000000,"logLevel":"info","createdAt":"…","createdBy":"debug.log","args":["inference:6d21baed-…","tool call",{"tool":"bash","toolCallId":"call_…","args":{"command":"head sales.csv"},"turn":2}]}
```

What is logged, by scope:

| Scope | Events |
|-------|--------|
| `main`, `server` | startup with the effective config (secrets masked), listening, shutdown, unhandled errors |
| `http` | every request and response with id, status and duration; 4xx as warn, 5xx as error |
| `inference:<id>` | request summary, files and images written, rendered system prompt, every attempt, turn (stop reason, tool calls, tokens), tool call with arguments, tool result preview, retries with the reason, final result or failure |
| `inference:<id>:ollama#n` | each model call: messages (roles, sizes, previews), tools, options, response text, tool calls, tokens, duration, provider errors |
| `inference:<id>:bash` / `view_image` / `provide_answer` | command, exit code, duration, output preview, timeouts and kills; image path and size; validation failures and the accepted answer |
| `workspace`, `queue`, `db`, `systemPrompt`, `admin` | workspace resets and writes, queue waits, every database write, template reloads, admin API calls |

Secrets (`apiKey`, `authorization`, …) are masked, strings longer than 2000 characters (base64 images, prompts) are truncated, errors are stored with name, message and stack. Related settings: `LOGS_ENABLED`, `LOGS_DIR`, `LOG_FILE`, `LOG_CONSOLE` (`all` echoes everything to stdout, `warn` only warnings and errors, `off` nothing), `LOG_LEVEL` (Fastify's own request log on stdout).

To follow one inference: `grep '<inference id>' logs/debug.log | jq -c '.args'`.

## Development

Node 26+ (`node:sqlite` is built in, no native modules).

```bash
npm install
cp config/.env.example .env     # fill OLLAMA_API_KEY
npm run dev                     # tsx watch
npm run smoke                   # end-to-end test against BASE_URL (default http://localhost:10050)
SMOKE_JSONL=../backtest-news-claims/assets/wwwroot.jsonl npm run smoke   # also runs a real record with photos
```

## Build and publish the image

As in the other `tripolskypetr/*` images the TypeScript is compiled on the host and the image only installs production dependencies:

```bash
npm run publish:x      # linux/macOS: npm run build && scripts/linux/publish.sh
npm run publish:win    # windows:     npm run build && scripts\win\publish.bat
```

Both build `tripolskypetr/agent-runtime` for `linux/amd64` and push `:latest`. The image is `node:26-alpine` plus `bash`, `curl`, `jq`, `file`, `python3` (with Pillow) and ImageMagick for the agent's shell.

## License

MIT
