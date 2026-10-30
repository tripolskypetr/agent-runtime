import type { InferenceError, InferenceErrorCode, InferenceFailure } from "../model/Api.model.js";

/**
 * Thrown by the client for any HTTP failure. When the server answered with an
 * InferenceFailure body (HTTP 500 from /inference or /text) the typed failure
 * is available in `failure` and `code` is the InferenceErrorCode.
 */
export class AgentRuntimeError extends Error {
  public readonly status: number;
  public readonly body: unknown;
  public readonly failure: InferenceFailure | null;
  private readonly explicitCode: InferenceErrorCode | null;

  constructor(message: string, status: number, body: unknown, failure: InferenceFailure | null = null, code: InferenceErrorCode | null = null) {
    super(message);
    this.name = "AgentRuntimeError";
    this.status = status;
    this.body = body;
    this.failure = failure;
    this.explicitCode = code;
  }

  /** InferenceErrorCode when the server returned a typed failure or rejected the schema (`invalid_format`), otherwise null. */
  public get code(): InferenceError["code"] | null {
    return this.explicitCode ?? this.failure?.error.code ?? null;
  }

  /** Per-attempt details when the server returned a typed failure. */
  public get details(): string[] {
    return this.failure?.error.details ?? [];
  }

  /** Inference id (present for typed failures) for looking the run up in the admin UI. */
  public get inferenceId(): string | null {
    return this.failure?.id ?? null;
  }
}

export const isInferenceFailure = (value: unknown): value is InferenceFailure =>
  typeof value === "object" &&
  value !== null &&
  (value as { status?: unknown }).status === "error" &&
  typeof (value as { error?: { code?: unknown } }).error?.code === "string";

/** Body of a 400 returned when `format` is not a valid JSON Schema. */
export const isInvalidFormat = (value: unknown): value is { status: "error"; error: InferenceError } =>
  typeof value === "object" &&
  value !== null &&
  (value as { status?: unknown }).status === "error" &&
  (value as { error?: { code?: unknown } }).error?.code === "invalid_format";
