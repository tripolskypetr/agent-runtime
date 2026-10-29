/** JSON schemas used by Fastify for validation and by Swagger for documentation. */

export const formatSchema = {
  $id: "FormatModel",
  type: "object",
  description: "JSON schema of the expected answer (json-inference FormatModel). Becomes the parameters of the provide_answer tool.",
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
} as const;

export const inferenceErrorSchema = {
  $id: "InferenceError",
  type: "object",
  required: ["code", "message", "details"],
  properties: {
    code: { type: "string", enum: ["schema_mismatch", "max_turns", "timeout", "provider_error", "internal_error"] },
    message: { type: "string" },
    details: { type: "array", items: { type: "string" } },
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
  inferenceErrorSchema,
  inferenceSuccessSchema,
  inferenceFailureSchema,
  attachmentMetaSchema,
  inferenceSummarySchema,
  inferenceRecordSchema,
  healthSchema,
];
