import type { InferenceError, InferenceFailure } from "../model/Api.model.js";

/**
 * Thrown by the client for any HTTP failure. When the server answered with an
 * InferenceFailure body (HTTP 500 from /inference or /text) the typed failure
 * is available in `failure` and `code` is the InferenceErrorCode.
 */
export class AgentRuntimeError extends Error {
  public readonly status: number;
  public readonly body: unknown;
  public readonly failure: InferenceFailure | null;

  constructor(message: string, status: number, body: unknown, failure: InferenceFailure | null = null) {
    super(message);
    this.name = "AgentRuntimeError";
    this.status = status;
    this.body = body;
    this.failure = failure;
  }

  /** InferenceErrorCode when the server returned a typed failure, otherwise null. */
  public get code(): InferenceError["code"] | null {
    return this.failure?.error.code ?? null;
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
