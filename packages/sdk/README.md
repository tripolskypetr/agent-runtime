# agent-runtime-sdk

> Strictly typed Node.js client for [agent-runtime](https://github.com/tripolskypetr/agent-runtime) over the fetch API. `generateObject()` returns a value typed from your JSON schema, so the answer has IntelliSense.

[![npm](https://img.shields.io/npm/v/agent-runtime-sdk.svg?style=flat-square)](https://npmjs.org/package/agent-runtime-sdk)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue)]()

agent-runtime is a REST harness for a [pi](https://github.com/earendil-works/pi)-based agent on Ollama: it runs the agent with `bash`, `view_image` and `provide_answer` tools in an isolated workspace and returns an answer that matches a JSON schema. This package wraps its HTTP API with the same `generateObject()` / `generateText()` pair as [json-inference](https://github.com/tripolskypetr/json-inference), plus the admin API.

## Features

- `generateObject()`: the return type is derived from the `format` schema via `InferFormat<F>`; string enums become unions, `required` decides which keys are optional, nested objects and arrays recurse
- `generateText()`: plain text answers from the same agent
- `inference()` / `text()`: the full typed response (`status: "success" | "error"`) without throwing
- `AgentRuntimeError` with the server's error code, per-attempt details and inference id
- Admin API: list inferences, read transcripts, download attachments, delete runs
- Zero runtime dependencies, Node 18+ (global `fetch`), ESM and CommonJS builds, bundled `types.d.ts`
- Schemas are compatible with json-inference's `FormatModel`

## Installation

```bash
npm install agent-runtime-sdk
```

Run the server first (see the [agent-runtime README](https://github.com/tripolskypetr/agent-runtime#quick-start-docker)):

```bash
docker run -p 10050:10050 -e OLLAMA_API_KEY=... tripolskypetr/agent-runtime
```

## Quick Start

```typescript
import { generateObject, encodeFile } from "agent-runtime-sdk";

const report = await generateObject({
  messages: [{ role: "user", content: "sales.csv is in your working directory. Total the amount column and name the top city." }],
  files: [encodeFile("sales.csv", "city,amount\nBerlin,120.5\nParis,340.25")],
  format: {
    type: "object",
    required: ["total", "topCity"],
    properties: {
      total: { type: "number", description: "Sum of the amount column" },
      topCity: { type: "string", enum: ["Berlin", "Paris"], description: "City with the largest amount" },
      note: { type: "string", description: "Optional remark" },
    },
  },
});

report.total;   // number
report.topCity; // "Berlin" | "Paris"
report.note;    // string | undefined
```

The schema is passed inline, so TypeScript keeps the literal types of `enum` and `required` (the function uses a `const` type parameter). No `as const` is needed.

`generateObject()` and `generateText()` create the client themselves. The optional last argument configures it; without it they talk to `AGENT_RUNTIME_URL` or `http://localhost:10050`:

```typescript
const summary = await generateText(
  { messages: [{ role: "user", content: "Summarise notes.txt" }], files: [encodeFile("notes.txt", notes)] },
  { baseUrl: "http://agent-runtime:10050", headers: { "x-token": "…" }, signal: AbortSignal.timeout(600_000) },
);
```

Config fields: `baseUrl`, `headers`, `fetch`, `dispatcher` (see [Long inferences](#long-inferences)) and `signal`. `inference()` and `text()` are the same calls returning the full typed response instead of throwing.

For many calls against one server, or for the admin API, use the client:

```typescript
import { createClient } from "agent-runtime-sdk";

const client = createClient({ baseUrl: "http://localhost:10050" });
const report = await client.generateObject({ messages, format });
```

## Type inference

`InferFormat<F>` maps a schema to the answer type:

| Schema | Type |
|--------|------|
| `{ type: "string" }` | `string` |
| `{ type: "string", enum: ["a", "b"] }` | `"a" \| "b"` (literal schema) or `string` (widened schema) |
| `{ type: "number" }`, `{ type: "integer" }` | `number` |
| `{ type: "boolean" }` | `boolean` |
| `{ type: "array", items: X }` | `InferProperty<X>[]` |
| `{ type: "object", properties, required }` | object with `required` keys mandatory, the rest optional |

To declare a schema separately and keep the literals, wrap it in `defineFormat()`:

```typescript
import { defineFormat, generateObject, type InferFormat } from "agent-runtime-sdk";

export const TradingPositionFormat = defineFormat({
  type: "object",
  required: ["id", "symbol", "position", "targets", "stoploss"],
  properties: {
    id: { type: "number", description: "ID сообщения, -1 если сигнала нет" },
    symbol: { type: "string", description: "Тикер в формате BTCUSDT" },
    position: { type: "string", enum: ["long", "short", "wait"], description: "Тип позиции" },
    targets: { type: "array", items: { type: "number" }, description: "Цели" },
    stoploss: { type: "number", description: "Стоп-лосс" },
    reasoning: { type: "string", description: "Обоснование" },
  },
});

export type TradingPosition = InferFormat<typeof TradingPositionFormat>;
// { id: number; symbol: string; position: "long" | "short" | "wait"; targets: number[]; stoploss: number; reasoning?: string }

const entry = await generateObject({ messages, format: TradingPositionFormat });
if (entry.position !== "wait") { /* entry.position is "long" | "short" here */ }
```

A schema written for json-inference (`satisfies FormatModel`, no `defineFormat`) still works: enums widen to `string` and every property is required, exactly as json-inference infers it.

## Text answers

```typescript
import { generateText, encodeFile } from "agent-runtime-sdk";

const summary = await generateText({
  messages: [{ role: "user", content: "Summarise report.pdf in three sentences" }],
  files: [encodeFile("report.pdf", await fs.readFile("report.pdf"))],
});
```

## Images

Images go into `messages[].images` as base64; the server shows them to the model and also saves them under `images/` in the workspace so the agent can process them with bash.

```typescript
import { generateObject, userMessage } from "agent-runtime-sdk";

const answer = await generateObject({
  messages: [userMessage("Describe the chart", [await fs.readFile("chart.png")])],
  format: { type: "object", required: ["trend"], properties: { trend: { type: "string", enum: ["up", "down", "flat"], description: "Trend" } } },
});
```

Records of a `wwwroot.jsonl` file (`{ role, content, images }`) can be passed as `messages` directly.

## Responses and errors

`generateObject()` and `generateText()` throw `AgentRuntimeError` when the agent fails. `inference()` and `text()` return the typed response instead:

```typescript
import { inference } from "agent-runtime-sdk";

const response = await inference({ messages, format });
if (response.status === "success") {
  response.data;        // typed answer
  response.turns;       // model calls
} else {
  response.error.code;    // "schema_mismatch" | "empty_answer" | "max_turns" | "timeout" | "provider_error" | "internal_error"
  response.error.details; // one line per failed attempt
  response.id;            // look the transcript up in the admin UI
}
```

```typescript
import { AgentRuntimeError, generateObject } from "agent-runtime-sdk";

try {
  await generateObject({ messages, format });
} catch (error) {
  if (error instanceof AgentRuntimeError) {
    error.status;      // HTTP status, 0 for network failures
    error.code;        // InferenceErrorCode or null for non-agent errors (400, 404, …)
    error.details;     // per-attempt details
    error.inferenceId; // id of the stored run
  }
}
```

## Admin API

```typescript
const { total, items } = await client.listInferences({ status: "error", mode: "object", limit: 20 });
const record = await client.getInference(items[0].id); // request, transcript, result/error, attachments
const file = await client.getAttachment(record.id, record.attachments[0].id); // { ...meta, data: Uint8Array }
await client.deleteInference(record.id);
await client.health();
```

## Long inferences

An inference can run for minutes. Node's built-in `fetch` aborts a request that has not received response headers within 300 s, so for long runs pass an `undici` dispatcher without that limit (`undici` is an optional peer dependency):

```typescript
import { Agent } from "undici";

const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
await generateObject(params, { dispatcher });            // standalone function
const client = createClient({ dispatcher });              // or once per client
```

Per-call cancellation works through `signal`: `generateObject(params, { signal: AbortSignal.timeout(600_000) })`.

## API

Standalone functions (create the client internally; `config` is optional):

| Function | Returns |
|----------|---------|
| `generateObject(params, config?)` | `Promise<InferFormat<F>>` |
| `generateText(params, config?)` | `Promise<string>` |
| `inference(params, config?)` | `Promise<InferenceResponse<InferFormat<F>>>` |
| `text(params, config?)` | `Promise<TextResponse>` |

`config`: `baseUrl` (default `AGENT_RUNTIME_URL` env or `http://localhost:10050`), `headers`, `fetch`, `dispatcher`, `signal`.

Client:

| Method | Returns |
|--------|---------|
| `createClient(options)` / `new AgentRuntimeClient(options)` | client; options: `baseUrl`, `fetch`, `headers`, `dispatcher` |
| `generateObject(params, options?)` | `Promise<InferFormat<F>>` |
| `generateText(params, options?)` | `Promise<string>` |
| `inference(params, options?)` | `Promise<InferenceResponse<InferFormat<F>>>` |
| `text(params, options?)` | `Promise<TextResponse>` |
| `health()` | `Promise<Health>` |
| `listInferences(query?)` | `Promise<{ total, items: InferenceSummary[] }>` |
| `getInference(id)` | `Promise<InferenceRecord>` |
| `getAttachment(id, attachmentId)` | `Promise<Attachment>` |
| `deleteInference(id)` | `Promise<{ ok: boolean }>` |
| `defineFormat(schema)` | the schema with literal types preserved |
| `encodeFile(name, bytes \| string)`, `encodeImage(bytes)`, `userMessage(text, images?)` | request helpers |

`params`: `messages` (`{ role, content, images? }[]`), `files?` (`{ name, content }[]`), `format` (object mode), `model?`, `instructions?`. `options`: `signal?`, `headers?`.

## Build

```bash
npm install
npm run build   # rollup → build/index.mjs, build/index.cjs, types.d.ts
npm test        # build, compile-time assertions on the published types, runtime test against BASE_URL
```

## License

MIT
