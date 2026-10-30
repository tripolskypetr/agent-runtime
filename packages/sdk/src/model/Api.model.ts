import type { FormatModel } from "./Format.model.js";

/* ---------------------------------------------------------------- requests */

export type RequestRole = "user" | "assistant" | "system";

/** One message of the conversation; the shape of a wwwroot.jsonl record message. */
export interface RequestMessage {
  role: RequestRole;
  content: string;
  /** Base64 images (raw or data: URL). Shown to the model and saved under images/ in the workspace. */
  images?: string[];
}

/** A file written into the agent workspace before the run starts. */
export interface RequestFile {
  /** File name; sub directories are allowed, `..` segments are dropped. */
  name: string;
  /** Base64 content (raw or data: URL). */
  content: string;
}

interface BaseParams {
  messages: RequestMessage[];
  files?: RequestFile[];
  /** Ollama model name; defaults to the server's OLLAMA_MODEL. */
  model?: string;
  /** Extra instructions appended to the system prompt. */
  instructions?: string;
}

/** Body of POST /api/v1/inference. */
export interface InferenceParams<F extends FormatModel = FormatModel> extends BaseParams {
  /** JSON schema of the answer; becomes the parameters of the provide_answer tool. */
  format: F;
}

/** Body of POST /api/v1/text. */
export interface TextParams extends BaseParams {}

/* --------------------------------------------------------------- responses */

export type InferenceErrorCode =
  | "invalid_format"
  | "schema_mismatch"
  | "empty_answer"
  | "max_turns"
  | "timeout"
  | "provider_error"
  | "internal_error";

export interface InferenceError {
  code: InferenceErrorCode;
  message: string;
  /** One line per failed attempt or notable event, in order. */
  details: string[];
}

/** Fields shared by every inference response. */
export interface RunInfo {
  /** Inference id; use it with the admin API to inspect the transcript. */
  id: string;
  model: string;
  /** Prompts sent, including re-prompts demanding provide_answer. */
  attempts: number;
  /** Model calls made. */
  turns: number;
  durationMs: number;
}

export interface InferenceSuccess<T> extends RunInfo {
  status: "success";
  /** The provide_answer arguments, validated against `format`. */
  data: T;
}

export interface TextSuccess extends RunInfo {
  status: "success";
  /** The agent's final message. */
  text: string;
}

export interface InferenceFailure extends RunInfo {
  status: "error";
  error: InferenceError;
}

export type InferenceResponse<T> = InferenceSuccess<T> | InferenceFailure;
export type TextResponse = TextSuccess | InferenceFailure;

/* ------------------------------------------------------------------- admin */

export type InferenceStatus = "running" | "success" | "error";
export type InferenceMode = "object" | "text";
export type AttachmentKind = "file" | "image" | "tool_image" | "output";

export interface AttachmentMeta {
  id: string;
  inferenceId: string;
  kind: AttachmentKind;
  name: string;
  mime: string;
  size: number;
  sha256: string;
}

export interface InferenceSummary {
  id: string;
  mode: InferenceMode;
  status: InferenceStatus;
  model: string;
  createdAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  attempts: number;
  turns: number;
  errorCode: InferenceErrorCode | null;
  errorMessage: string | null;
  messageCount: number;
  fileCount: number;
}

/** Request as stored by the server: image and file payloads replaced by attachment ids. */
export interface StoredRequest {
  messages: { role: RequestRole; content: string; images?: string[] }[];
  files: { attachmentId: string; name: string; size: number }[];
  format?: FormatModel;
  model: string;
  instructions?: string;
}

export interface InferenceRecord extends InferenceSummary {
  request: StoredRequest;
  /** pi agent transcript (system, user, assistant, toolResult messages); image payloads replaced by attachment ids. */
  messages: unknown[];
  /** The answer object (`object` mode) or string (`text` mode). */
  result: unknown | null;
  error: InferenceError | null;
  attachments: AttachmentMeta[];
}

export interface ListInferencesQuery {
  limit?: number;
  offset?: number;
  status?: InferenceStatus;
  mode?: InferenceMode;
}

export interface ListInferencesResponse {
  total: number;
  items: InferenceSummary[];
}

export interface Attachment extends AttachmentMeta {
  data: Uint8Array;
}

export interface Health {
  status: string;
  model: string;
  host: string;
  vision: boolean;
  running: boolean;
  queued: number;
  uptimeSeconds: number;
}
