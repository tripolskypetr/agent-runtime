import type { FormatModel } from "./Format.model.js";

export type RequestRole = "user" | "assistant" | "system";

/** One message of the request, the same shape as a record of wwwroot.jsonl. */
export interface RequestMessage {
  role: RequestRole;
  content: string;
  /** Base64 images (raw or data: URL). */
  images?: string[];
}

/** One file of the request; it is written into the data workspace before the agent starts. */
export interface RequestFile {
  name: string;
  /** Base64 content (raw or data: URL). */
  content: string;
}

export type InferenceMode = "object" | "text";

/** Request of POST /api/v1/inference (structured answer via provide_answer). */
export interface InferenceRequest {
  messages: RequestMessage[];
  files?: RequestFile[];
  format: FormatModel;
  model?: string;
  instructions?: string;
}

/** Request of POST /api/v1/text (plain text answer, as generateText in json-inference). */
export interface TextRequest {
  messages: RequestMessage[];
  files?: RequestFile[];
  model?: string;
  instructions?: string;
}

export type InferenceStatus = "running" | "success" | "error";

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

/** Request as stored: image and file payloads are replaced by attachment ids. */
export interface StoredRequest {
  messages: { role: RequestRole; content: string; images?: string[] }[];
  files: { attachmentId: string; name: string; size: number }[];
  /** Present in `object` mode only. */
  format?: FormatModel;
  model: string;
  instructions?: string;
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
  errorCode: string | null;
  errorMessage: string | null;
  messageCount: number;
  fileCount: number;
}

export interface InferenceRecord extends InferenceSummary {
  request: StoredRequest;
  /** Agent transcript with image payloads replaced by attachment ids. */
  messages: unknown[];
  result: unknown | null;
  error: InferenceError | null;
  attachments: AttachmentMeta[];
}
