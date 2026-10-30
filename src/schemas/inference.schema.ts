/** JSON schemas used by Fastify for validation and by Swagger for documentation. */

export const formatSchema = {
  $id: "FormatModel",
  type: "object",
  description:
    "JSON Schema (draft 2020-12) of the expected answer; the top level must be an object with `required` and `properties`. " +
    "Becomes the parameters of the provide_answer tool and is enforced by ajv on every call: oneOf/anyOf/allOf/not, const, enum, " +
    "if/then/else, local `$ref` into `$defs`, additionalProperties, pattern, minLength/maxLength, minimum/maximum, nullable types " +
    "(`type: [\"string\", \"null\"]`). json-inference FormatModel schemas are a subset and work unchanged. `$id`/`$schema` are ignored, " +
    "external references are not resolved. The model sees a trimmed copy: meta keywords removed, `$ref`s inlined to MODEL_SCHEMA_REF_DEPTH.",
  required: ["type", "required", "properties"],
  properties: {
    type: { type: "string", enum: ["object"] },
    required: { type: "array", items: { type: "string" } },
    properties: { type: "object", additionalProperties: true },
  },
  additionalProperties: true,
} as const;

export const requestMessageSchema = {
  $id: "RequestMessage",
  type: "object",
  required: ["role", "content"],
  properties: {
    role: { type: "string", enum: ["user", "assistant", "system"] },
    content: { type: "string" },
    images: {
      type: "array",
      description: "Base64 images (raw or data: URL). They are shown to the model and saved under images/ in the workspace.",
      items: { type: "string" },
    },
  },
  additionalProperties: false,
} as const;

export const requestFileSchema = {
  $id: "RequestFile",
  type: "object",
  required: ["name", "content"],
  properties: {
    name: { type: "string", description: "File name (sub directories allowed, `..` is dropped)" },
    content: { type: "string", description: "Base64 content (raw or data: URL)" },
  },
  additionalProperties: false,
} as const;

export const inferenceRequestSchema = {
  $id: "InferenceRequest",
  type: "object",
  required: ["messages", "format"],
  properties: {
    messages: { type: "array", minItems: 1, items: { $ref: "RequestMessage#" } },
    files: { type: "array", items: { $ref: "RequestFile#" } },
    format: { $ref: "FormatModel#" },
    model: { type: "string", description: "Ollama model name; defaults to OLLAMA_MODEL" },
    instructions: { type: "string", description: "Extra instructions appended to the system prompt" },
  },
  additionalProperties: false,
  example: {
    messages: [
      { role: "user", content: "Обзор рынка криптовалют 07.09.2023. Найди упомянутые активы и общее настроение." },
      { role: "user", content: "", images: ["/9j/4AAQSkZJRgABAQAAAQABAAD/2wBD...<base64 jpeg>"] },
    ],
    files: [{ name: "sales.csv", content: "Y2l0eSxhbW91bnQKQmVybGluLDEyMC41ClBhcmlzLDM0MC4yNQ==" }],
    format: {
      type: "object",
      required: ["summary", "sentiment", "assets"],
      properties: {
        summary: { type: "string", description: "Краткое содержание, 2-3 предложения" },
        sentiment: { type: "string", enum: ["bullish", "bearish", "neutral"], description: "Общее настроение" },
        assets: { type: "array", items: { type: "string" }, description: "Упомянутые тикеры" },
      },
    },
    model: "gemma4:31b-cloud",
    instructions: "Отвечай на русском языке.",
  },
} as const;

export const textRequestSchema = {
  $id: "TextRequest",
  type: "object",
  required: ["messages"],
  properties: {
    messages: { type: "array", minItems: 1, items: { $ref: "RequestMessage#" } },
    files: { type: "array", items: { $ref: "RequestFile#" } },
    model: { type: "string", description: "Ollama model name; defaults to OLLAMA_MODEL" },
    instructions: { type: "string", description: "Extra instructions appended to the system prompt" },
  },
  additionalProperties: false,
  example: {
    messages: [{ role: "user", content: "notes.txt лежит в рабочей папке. Прочитай его через bash и ответь одним предложением: когда встреча и кто обязан прийти?" }],
    files: [{ name: "notes.txt", content: "VGVhbSBzeW5jIG1vdmVkIHRvIFRodXJzZGF5LCAxNCBOb3ZlbWJlciwgMTA6MDAu" }],
  },
} as const;

export const inferenceErrorSchema = {
  $id: "InferenceError",
  type: "object",
  required: ["code", "message", "details"],
  properties: {
    code: { type: "string", enum: ["invalid_format", "schema_mismatch", "empty_answer", "max_turns", "timeout", "provider_error", "internal_error"] },
    message: { type: "string" },
    details: { type: "array", items: { type: "string" } },
  },
  example: {
    code: "schema_mismatch",
    message: "Model failed to call provide_answer with a valid answer after 3 attempts",
    details: [
      "attempt 1: model replied with text instead of calling provide_answer: Настроение рынка нейтральное…",
      "attempt 2: provide_answer rejected: Invalid arguments: sentiment: expected one of [bullish, bearish, neutral], got \"positive\"",
      "attempt 3: model did not call provide_answer",
    ],
  },
} as const;

export const inferenceSuccessSchema = {
  $id: "InferenceSuccess",
  type: "object",
  required: ["id", "status", "data", "model", "attempts", "turns", "durationMs"],
  properties: {
    id: { type: "string" },
    status: { type: "string", enum: ["success"] },
    data: { description: "The answer, matching `format`" },
    model: { type: "string" },
    attempts: { type: "integer" },
    turns: { type: "integer" },
    durationMs: { type: "integer" },
  },
  example: {
    id: "6d21baed-6f7e-4c1a-9d2b-3a0c1f5e8b21",
    status: "success",
    data: { summary: "Обзор описывает расширение Ripple в Азии и обсуждение правил G20.", sentiment: "neutral", assets: ["BTC", "XRP", "ETH"] },
    model: "gemma4:31b-cloud",
    attempts: 1,
    turns: 3,
    durationMs: 4350,
  },
} as const;

export const textSuccessSchema = {
  $id: "TextSuccess",
  type: "object",
  required: ["id", "status", "text", "model", "attempts", "turns", "durationMs"],
  properties: {
    id: { type: "string" },
    status: { type: "string", enum: ["success"] },
    text: { type: "string", description: "The agent's final message" },
    model: { type: "string" },
    attempts: { type: "integer" },
    turns: { type: "integer" },
    durationMs: { type: "integer" },
  },
  example: {
    id: "9c0f2a4e-2b7d-4e51-8f3a-1d2e3f4a5b6c",
    status: "success",
    text: "Встреча перенесена на четверг, 14 ноября, 10:00; обязаны прийти backend-лиды Иван и Ольга.",
    model: "gemma4:31b-cloud",
    attempts: 1,
    turns: 2,
    durationMs: 2140,
  },
} as const;

export const invalidFormatSchema = {
  $id: "InvalidFormat",
  type: "object",
  description: "Returned with HTTP 400 when `format` is not a valid JSON Schema; no inference is created.",
  required: ["status", "error"],
  properties: {
    status: { type: "string", enum: ["error"] },
    error: { $ref: "InferenceError#" },
  },
  example: {
    status: "error",
    error: { code: "invalid_format", message: "Invalid format schema: can't resolve reference #/$defs/predicate from id #", details: [] },
  },
} as const;

export const inferenceFailureSchema = {
  $id: "InferenceFailure",
  type: "object",
  required: ["id", "status", "error", "model", "attempts", "turns", "durationMs"],
  properties: {
    id: { type: "string" },
    status: { type: "string", enum: ["error"] },
    error: { $ref: "InferenceError#" },
    model: { type: "string" },
    attempts: { type: "integer" },
    turns: { type: "integer" },
    durationMs: { type: "integer" },
  },
  example: {
    id: "3379627a-2817-4185-a8bf-9fd6654c177a",
    status: "error",
    error: {
      code: "provider_error",
      message: "Ollama request failed (404): model 'model-that-does-not-exist:latest' not found",
      details: [],
    },
    model: "model-that-does-not-exist:latest",
    attempts: 1,
    turns: 1,
    durationMs: 311,
  },
} as const;

export const attachmentMetaSchema = {
  $id: "AttachmentMeta",
  type: "object",
  properties: {
    id: { type: "string" },
    inferenceId: { type: "string" },
    kind: { type: "string", enum: ["file", "image", "tool_image", "output"] },
    name: { type: "string" },
    mime: { type: "string" },
    size: { type: "integer" },
    sha256: { type: "string" },
  },
} as const;

export const inferenceSummarySchema = {
  $id: "InferenceSummary",
  type: "object",
  properties: {
    id: { type: "string" },
    mode: { type: "string", enum: ["object", "text"] },
    status: { type: "string", enum: ["running", "success", "error"] },
    model: { type: "string" },
    createdAt: { type: "string" },
    finishedAt: { type: "string", nullable: true },
    durationMs: { type: "integer", nullable: true },
    attempts: { type: "integer" },
    turns: { type: "integer" },
    errorCode: { type: "string", nullable: true },
    errorMessage: { type: "string", nullable: true },
    messageCount: { type: "integer" },
    fileCount: { type: "integer" },
  },
} as const;

export const inferenceRecordSchema = {
  $id: "InferenceRecord",
  type: "object",
  properties: {
    ...inferenceSummarySchema.properties,
    request: { type: "object", additionalProperties: true },
    messages: { type: "array", items: { type: "object", additionalProperties: true } },
    result: { nullable: true },
    error: { $ref: "InferenceError#", nullable: true },
    attachments: { type: "array", items: { $ref: "AttachmentMeta#" } },
  },
} as const;

export const healthSchema = {
  $id: "Health",
  type: "object",
  properties: {
    status: { type: "string" },
    model: { type: "string" },
    host: { type: "string" },
    vision: { type: "boolean" },
    running: { type: "boolean" },
    queued: { type: "integer" },
    uptimeSeconds: { type: "integer" },
  },
} as const;

export const sharedSchemas = [
  formatSchema,
  requestMessageSchema,
  requestFileSchema,
  inferenceRequestSchema,
  textRequestSchema,
  inferenceErrorSchema,
  inferenceSuccessSchema,
  textSuccessSchema,
  invalidFormatSchema,
  inferenceFailureSchema,
  attachmentMetaSchema,
  inferenceSummarySchema,
  inferenceRecordSchema,
  healthSchema,
];
