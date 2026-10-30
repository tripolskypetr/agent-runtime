import type { FormatModel, InferFormat } from "../model/Format.model.js";
import type {
  Attachment,
  Health,
  InferenceParams,
  InferenceRecord,
  InferenceResponse,
  ListInferencesQuery,
  ListInferencesResponse,
  TextParams,
  TextResponse,
} from "../model/Api.model.js";
import { AgentRuntimeError, isInferenceFailure, isInvalidFormat } from "./AgentRuntimeError.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ClientOptions {
  /** Base URL of agent-runtime, e.g. `http://localhost:10050`. */
  baseUrl?: string;
  /** Custom fetch (defaults to `globalThis.fetch`). */
  fetch?: FetchLike;
  /** Headers added to every request, e.g. a reverse-proxy token. */
  headers?: Record<string, string>;
  /**
   * undici Dispatcher forwarded to fetch. Node's fetch aborts a request without
   * response headers after 300 s, while an inference can run longer; pass
   * `new Agent({ headersTimeout: 0, bodyTimeout: 0 })` from `undici` to lift the limit.
   */
  dispatcher?: unknown;
}

export interface RequestOptions {
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

/**
 * Typed client for agent-runtime. All methods throw {@link AgentRuntimeError}
 * on transport or HTTP errors; `inference()` and `text()` return the typed
 * failure instead of throwing when the agent itself failed (HTTP 500 with an
 * InferenceFailure body), `generateObject()` and `generateText()` throw for it.
 */
export class AgentRuntimeClient {
  private readonly baseUrl: string;
  private readonly fetchFn: FetchLike;
  private readonly headers: Record<string, string>;
  private readonly dispatcher: unknown;

  constructor(options: ClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "http://localhost:10050").replace(/\/+$/, "");
    this.fetchFn = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.headers = options.headers ?? {};
    this.dispatcher = options.dispatcher;
  }

  /* ----------------------------------------------------------- inference */

  /**
   * POST /api/v1/inference. Resolves to the full typed response, success or
   * failure; the `status` field discriminates.
   */
  public async inference<const F extends FormatModel>(
    params: InferenceParams<F>,
    options: RequestOptions = {},
  ): Promise<InferenceResponse<InferFormat<F>>> {
    return this.runAgent<InferenceResponse<InferFormat<F>>>("/api/v1/inference", params, options);
  }

  /**
   * The json-inference `generateObject` equivalent: resolves to the answer
   * typed from `format`, throws {@link AgentRuntimeError} when the agent failed.
   */
  public async generateObject<const F extends FormatModel>(
    params: InferenceParams<F>,
    options: RequestOptions = {},
  ): Promise<InferFormat<F>> {
    const response = await this.inference(params, options);
    if (response.status === "error") {
      throw new AgentRuntimeError(`${response.error.code}: ${response.error.message}`, 500, response, response);
    }
    return response.data;
  }

  /** POST /api/v1/text. Resolves to the full typed response, success or failure. */
  public async text(params: TextParams, options: RequestOptions = {}): Promise<TextResponse> {
    return this.runAgent<TextResponse>("/api/v1/text", params, options);
  }

  /** The json-inference `generateText` equivalent: resolves to the final message, throws when the agent failed. */
  public async generateText(params: TextParams, options: RequestOptions = {}): Promise<string> {
    const response = await this.text(params, options);
    if (response.status === "error") {
      throw new AgentRuntimeError(`${response.error.code}: ${response.error.message}`, 500, response, response);
    }
    return response.text;
  }

  /* --------------------------------------------------------------- admin */

  public async health(options: RequestOptions = {}): Promise<Health> {
    return this.json<Health>("GET", "/api/v1/health", undefined, options);
  }

  public async listInferences(query: ListInferencesQuery = {}, options: RequestOptions = {}): Promise<ListInferencesResponse> {
    const search = new URLSearchParams();
    if (query.limit !== undefined) search.set("limit", String(query.limit));
    if (query.offset !== undefined) search.set("offset", String(query.offset));
    if (query.status) search.set("status", query.status);
    if (query.mode) search.set("mode", query.mode);
    const suffix = search.size ? `?${search}` : "";
    return this.json<ListInferencesResponse>("GET", `/api/v1/inferences${suffix}`, undefined, options);
  }

  public async getInference(id: string, options: RequestOptions = {}): Promise<InferenceRecord> {
    return this.json<InferenceRecord>("GET", `/api/v1/inferences/${encodeURIComponent(id)}`, undefined, options);
  }

  public async deleteInference(id: string, options: RequestOptions = {}): Promise<{ ok: boolean }> {
    return this.json<{ ok: boolean }>("DELETE", `/api/v1/inferences/${encodeURIComponent(id)}`, undefined, options);
  }

  /** Downloads an attachment (request file, image, tool image or produced file) with its metadata. */
  public async getAttachment(inferenceId: string, attachmentId: string, options: RequestOptions = {}): Promise<Attachment> {
    const record = await this.getInference(inferenceId, options);
    const meta = record.attachments.find((item) => item.id === attachmentId);
    if (!meta) {
      throw new AgentRuntimeError(`Attachment ${attachmentId} not found in inference ${inferenceId}`, 404, null);
    }
    const response = await this.request(
      "GET",
      `/api/v1/inferences/${encodeURIComponent(inferenceId)}/attachments/${encodeURIComponent(attachmentId)}`,
      undefined,
      options,
    );
    if (!response.ok) {
      throw new AgentRuntimeError(`HTTP ${response.status} while downloading attachment`, response.status, await response.text());
    }
    return { ...meta, data: new Uint8Array(await response.arrayBuffer()) };
  }

  /* ------------------------------------------------------------ internals */

  private async runAgent<T>(path: string, body: unknown, options: RequestOptions): Promise<T> {
    const response = await this.request("POST", path, body, options);
    const payload = await parseBody(response);
    if (response.ok) return payload as T;
    if (response.status === 500 && isInferenceFailure(payload)) return payload as T;
    // 400 invalid_format: the schema itself was rejected before any inference ran
    if (isInvalidFormat(payload)) {
      throw new AgentRuntimeError(`${payload.error.code}: ${payload.error.message}`, response.status, payload, null, payload.error.code);
    }
    throw new AgentRuntimeError(describe(response.status, payload), response.status, payload);
  }

  private async json<T>(method: string, path: string, body: unknown, options: RequestOptions): Promise<T> {
    const response = await this.request(method, path, body, options);
    const payload = await parseBody(response);
    if (!response.ok) {
      throw new AgentRuntimeError(describe(response.status, payload), response.status, payload);
    }
    return payload as T;
  }

  private async request(method: string, path: string, body: unknown, options: RequestOptions): Promise<Response> {
    const init: RequestInit & { dispatcher?: unknown } = {
      method,
      headers: {
        accept: "application/json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...this.headers,
        ...options.headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
    };
    try {
      return await this.fetchFn(`${this.baseUrl}${path}`, init);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new AgentRuntimeError(`Request to ${this.baseUrl}${path} failed: ${message}`, 0, null);
    }
  }
}

const parseBody = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const describe = (status: number, payload: unknown): string => {
  if (payload && typeof payload === "object" && typeof (payload as { message?: unknown }).message === "string") {
    return `HTTP ${status}: ${(payload as { message: string }).message}`;
  }
  return `HTTP ${status}`;
};

export const createClient = (options: ClientOptions = {}): AgentRuntimeClient => new AgentRuntimeClient(options);
