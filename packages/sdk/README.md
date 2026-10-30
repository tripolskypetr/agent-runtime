# agent-runtime-sdk

> Strictly typed Node.js client for [agent-runtime](https://github.com/tripolskypetr/agent-runtime) over the fetch API. `generateObject()` returns a value typed from your JSON schema, so the answer has IntelliSense.

[![npm](https://img.shields.io/npm/v/agent-runtime-sdk.svg?style=flat-square)](https://npmjs.org/package/agent-runtime-sdk)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue)]()

agent-runtime is a REST harness for a [pi](https://github.com/earendil-works/pi)-based agent on Ollama: it runs the agent with `bash`, `view_image` and `provide_answer` tools in an isolated workspace and returns an answer that matches a JSON schema. This package wraps its HTTP API with the same `generateObject()` / `generateText()` pair as [json-inference](https://github.com/tripolskypetr/json-inference), plus the admin API.

## Features

- `generateObject()`: the return type is derived from the `format` schema via `InferFormat<F>`: `enum` and `const` become literals, `type: ["string", "null"]` becomes `string | null`, `oneOf` a union, `$ref` into `$defs` recurses, `required` decides which keys are optional
- `generateText()`: plain text answers from the same agent
- `inference()` / `text()`: the full typed response (`status: "success" | "error"`) without throwing
- `AgentRuntimeError` with the server's error code, per-attempt details and inference id
- Admin API: list inferences, read transcripts, download attachments, delete runs
- Zero runtime dependencies, Node 18+ (global `fetch`), ESM and CommonJS builds, bundled `types.d.ts`
- `format` is a full JSON Schema (draft 2020-12), enforced server-side by ajv; json-inference `FormatModel` schemas are a subset and work unchanged

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

`format` is a full JSON Schema (draft 2020-12) with an object at the top level; the server validates every answer against it with ajv. `InferFormat<F>` maps the schema to the answer type:

| Schema | Type |
|--------|------|
| `{ const: "1.0.0" }` | `"1.0.0"` |
| `{ enum: ["a", "b"] }`, `{ enum: ["a", null] }` | `"a" \| "b"`, `"a" \| null` (literal schema) or `string` (widened schema) |
| `{ type: "string" }` | `string` |
| `{ type: ["string", "null"] }` | `string \| null` |
| `{ type: "null" }` | `null` |
| `{ type: "number" }`, `{ type: "integer" }` | `number` |
| `{ type: "boolean" }` | `boolean` |
| `{ oneOf: [A, B] }`, `{ anyOf: [A, B] }` | `InferProperty<A> \| InferProperty<B>` |
| `{ allOf: [A, B] }` | `InferProperty<A> & InferProperty<B>` |
| `{ if, then, else }` | ignored: the type comes from the rest of the node |
| `{ type: "array", items: X }` | `InferProperty<X>[]` |
| `{ type: "object", properties, required }` | object with `required` keys mandatory, the rest optional |
| `{ $ref: "#/$defs/name" }` | the type of `$defs.name`, recursively |

Recursive `$ref`s (a predicate tree of `all` / `any` / `not`, for example) are followed six levels deep; a reference below that is typed `unknown`. That depth limit is the one deliberate restriction of the inference: the whole contract is a single `defineFormat()` call, there is no second, hand-written answer type to keep in sync with the schema. Six levels cover the practical nesting of such trees (the server has no depth limit, it validates the real schema).

To declare a schema separately and keep the literals, wrap it in `defineFormat()`:

```typescript
import { defineFormat, generateObject, type InferFormat } from "agent-runtime-sdk";

export const Agent1Format = defineFormat({
  type: "object",
  additionalProperties: false,
  required: ["schema_version", "verdict", "signal"],
  $defs: {
    featureName: { enum: ["last_price", "ret_60m_pct", "atr_14_pct"] },
    leaf: {
      type: "object",
      additionalProperties: false,
      required: ["feature", "op", "value"],
      properties: {
        feature: { $ref: "#/$defs/featureName" },
        op: { enum: ["lt", "gt"] },
        value: { oneOf: [{ type: "number" }, { type: "object", required: ["feature"], properties: { feature: { $ref: "#/$defs/featureName" } } }] },
      },
    },
    predicate: {
      oneOf: [
        { $ref: "#/$defs/leaf" },
        { type: "object", required: ["all"], properties: { all: { type: "array", minItems: 1, items: { $ref: "#/$defs/predicate" } } } },
        { type: "object", required: ["not"], properties: { not: { $ref: "#/$defs/predicate" } } },
      ],
    },
  },
  properties: {
    schema_version: { const: "1.0.0" },
    verdict: { enum: ["summary_only", "forecast_expressible"] },
    signal: {
      oneOf: [
        { type: "null" },
        { type: "object", required: ["direction", "entry"], properties: { direction: { const: "long" }, entry: { $ref: "#/$defs/predicate" } } },
      ],
    },
  },
  allOf: [{ if: { properties: { verdict: { const: "summary_only" } } }, then: { properties: { signal: { type: "null" } } } }],
});

export type Agent1Response = InferFormat<typeof Agent1Format>;
// { schema_version: "1.0.0"; verdict: "summary_only" | "forecast_expressible"; signal: null | { direction: "long"; entry: Predicate } }

const answer = await generateObject({ messages, format: Agent1Format });
if (answer.signal) answer.signal.entry; // Leaf | { all: Predicate[] } | { not: Predicate }
```

A schema written for json-inference (`satisfies FormatModel`, no `defineFormat`) still works: enums widen to `string` and every property is required, exactly as json-inference infers it.

The server rejects a schema that does not compile (a `$ref` to a missing `$defs` entry) with HTTP 400 and `error.code = "invalid_format"`; `generateObject` throws `AgentRuntimeError` with that code and no inference is recorded.

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
                          // ("invalid_format" only ever arrives as a thrown AgentRuntimeError with status 400)
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
    error.code;        // InferenceErrorCode ("invalid_format" for a rejected schema) or null for other HTTP errors
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
| `defineFormat(schema)` | the schema with literal types preserved (the only way to declare a format: no separate answer type) |
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
