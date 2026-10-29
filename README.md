<p align="center">
  <strong>agent-runtime</strong><br>
  REST API harness for a <a href="https://github.com/earendil-works/pi">pi</a>-based AI agent on Ollama.<br>
  Structured JSON answers · bash and image tools in an isolated workspace · SQLite history · admin UI · Swagger.
</p>

## What it does

`POST /api/v1/inference` takes a conversation (text and photos), a set of files and a JSON schema, runs an agent and returns an object that matches the schema.

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
5. A failed inference returns HTTP 500 with a JSON error (`schema_mismatch`, `max_turns`, `timeout`, `provider_error`, `internal_error`).

## Quick start (Docker)

```bash
mkdir agent-runtime && cd agent-runtime
curl -O https://raw.githubusercontent.com/tripolskypetr/agent-runtime/master/config/docker-compose.yaml
curl -o .env https://raw.githubusercontent.com/tripolskypetr/agent-runtime/master/config/.env.example
# set OLLAMA_API_KEY in .env (https://ollama.com/settings/keys)
docker compose up -d
```

- Swagger UI: http://localhost:8080/docs
- Admin UI (no password): http://localhost:8080/admin
- Health: http://localhost:8080/api/v1/health

The SQLite database lives in `./storage` next to the compose file.

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

**Long requests.** The response is sent only when the agent finishes, which can take minutes (several model turns, bash commands, retries). Use an HTTP client without a response timeout: Node's `fetch` gives up after 300 s by default, so call it with an `undici` `Agent({ headersTimeout: 0, bodyTimeout: 0 })` or use `node:http` as [scripts/smoke.ts](scripts/smoke.ts) does. The server itself has no request timeout; `INFERENCE_TIMEOUT_MS` bounds the agent. Model calls go to Ollama as streaming requests, so slow models do not hit the same 300 s limit inside the harness.

### Admin API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/inferences?limit&offset&status` | List inferences, newest first |
| `GET` | `/api/v1/inferences/:id` | Request, transcript, result or error, attachments |
| `GET` | `/api/v1/inferences/:id/attachments/:attachmentId` | Raw bytes of a file or image (`?download=true` to download) |
| `DELETE` | `/api/v1/inferences/:id` | Delete an inference |
| `GET` | `/api/v1/health` | Model, host, queue state |

## Configuration

All settings are environment variables (see [config/.env.example](config/.env.example)).

| Variable | Default | Meaning |
|----------|---------|---------|
| `OLLAMA_HOST` | `https://ollama.com` | Ollama endpoint. Local: `http://host.docker.internal:11434` |
| `OLLAMA_API_KEY` | | Bearer token for ollama.com |
| `OLLAMA_MODEL` | `gemma4:31b-cloud` | Default model; a request may override it |
| `OLLAMA_VISION` | `1` | Attach images to messages and enable `view_image` |
| `OLLAMA_THINK` | | `true`/`false` or `low`/`medium`/`high`; empty = model default |
| `MAX_ATTEMPTS` | `3` | Re-prompts when `provide_answer` was not called |
| `MAX_TURNS` | `40` | Model calls per inference |
| `INFERENCE_TIMEOUT_MS` | `900000` | Hard limit per inference |
| `BASH_TIMEOUT_SEC` | `120` | Default bash command timeout |
| `BODY_LIMIT_MB` | `256` | Request body limit |
| `DATA_DIR` | `./data` | Agent workspace |
| `DB_PATH` | `./storage/agent-runtime.sqlite` | SQLite file |
| `SYSTEM_PROMPT_PATH` | `./assets/system.mustache` | System prompt template (re-read when changed) |

The system prompt is a Mustache template in [assets/system.mustache](assets/system.mustache); it receives the workspace path, file and image lists, the schema and the extra instructions.

## Development

Node 26+ (`node:sqlite` is built in, no native modules).

```bash
npm install
cp config/.env.example .env     # fill OLLAMA_API_KEY
npm run dev                     # tsx watch
npm run smoke                   # end-to-end test against BASE_URL (default http://localhost:8080)
SMOKE_JSONL=../backtest-news-claims/assets/wwwroot.jsonl npm run smoke   # also runs a real record with photos
```

## Build and publish the image

As in the other `tripolskypetr/*` images the TypeScript is compiled on the host and the image only installs production dependencies:

```bash
npm run publish:x      # linux/macOS: npm run build && scripts/linux/publish.sh
npm run publish:win    # windows:     npm run build && scripts\win\publish.bat
```

Both build `tripolskypetr/agent-runtime` for `linux/amd64` and push `:latest`. The image is `node:26-alpine` plus `bash`, `curl`, `jq`, `file`, `python3` (with Pillow) and ImageMagick for the agent's shell.

## Project layout

```
src/
  index.ts, server.ts, config.ts       Fastify app, Swagger, static admin UI
  routes/                              inference, admin, health
  agent/runInference.ts                workspace → agent loop → retries → persistence
  agent/ollama.ts                      pi StreamFn over ollama.chat (tools + think)
  agent/tools/                         provide_answer, bash, view_image
  agent/workspace.ts                   data dir lifecycle and output snapshot
  db/database.ts                       node:sqlite schema and queries
  helpers/validateToolArguments.ts     copied from json-inference
assets/system.mustache                 system prompt
public/                                admin UI (vanilla JS)
config/                                docker-compose.yaml and .env.example for deployment
scripts/                               publish.sh / publish.bat, smoke.ts
```

## License

MIT
