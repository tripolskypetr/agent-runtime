/**
 * JSON-schema subset accepted as the `format` of an inference request.
 * Compatible with json-inference's FormatModel: schemas written for
 * generateObject() there can be passed to agent-runtime unchanged.
 *
 * Arrays are `readonly` so that `as const` schemas and `const` type
 * parameters keep literal types for `enum` and `required`, which is what
 * gives IntelliSense on the inferred answer type.
 */
type FormatItems = {
    readonly type: "string";
    readonly description?: string;
    readonly enum?: readonly string[];
} | {
    readonly type: "number";
    readonly description?: string;
} | {
    readonly type: "integer";
    readonly description?: string;
} | {
    readonly type: "boolean";
    readonly description?: string;
} | {
    readonly type: "array";
    readonly description?: string;
    readonly items?: FormatItems;
    readonly minItems?: number;
    readonly maxItems?: number;
} | {
    readonly type: "object";
    readonly description?: string;
    readonly required?: readonly string[];
    readonly properties?: {
        readonly [key: string]: FormatProperty;
    };
};
type FormatProperty = {
    readonly type: "string";
    readonly description: string;
    readonly enum?: readonly string[];
} | {
    readonly type: "number";
    readonly description: string;
} | {
    readonly type: "integer";
    readonly description: string;
} | {
    readonly type: "boolean";
    readonly description: string;
} | {
    readonly type: "array";
    readonly description: string;
    readonly items?: FormatItems;
    readonly minItems?: number;
    readonly maxItems?: number;
} | {
    readonly type: "object";
    readonly description: string;
    readonly required?: readonly string[];
    readonly properties?: {
        readonly [key: string]: FormatProperty;
    };
};
interface FormatModel {
    readonly type: string;
    readonly required: readonly string[];
    readonly properties: {
        readonly [key: string]: FormatProperty;
    };
}
/** Flattens intersections so hover tooltips show one plain object type. */
type Simplify<T> = {
    [K in keyof T]: T[K];
} & {};
/** `enum: ["a", "b"]` declared with `as const` / `defineFormat` becomes `"a" | "b"`, otherwise `string`. */
type EnumOf<T> = T extends {
    readonly enum: readonly (infer E)[];
} ? (E extends string ? E : string) : string;
/** Keys listed in `required`; a widened `string[]` keeps every key required, as json-inference does. */
type RequiredKeysOf<P, R> = R extends readonly (infer K)[] ? (K extends string ? K & keyof P : never) : never;
type InferObject<P, R> = Simplify<{
    -readonly [K in keyof P as K extends RequiredKeysOf<P, R> ? K : never]-?: InferProperty<P[K]>;
} & {
    -readonly [K in keyof P as K extends RequiredKeysOf<P, R> ? never : K]?: InferProperty<P[K]>;
}>;
type InferProperty<T> = T extends {
    readonly type: "string";
} ? EnumOf<T> : T extends {
    readonly type: "number";
} ? number : T extends {
    readonly type: "integer";
} ? number : T extends {
    readonly type: "boolean";
} ? boolean : T extends {
    readonly type: "array";
    readonly items: infer I;
} ? InferProperty<I>[] : T extends {
    readonly type: "array";
} ? unknown[] : T extends {
    readonly type: "object";
    readonly properties: infer P;
} ? InferObject<P, T extends {
    readonly required: infer R;
} ? R : never> : T extends {
    readonly type: "object";
} ? Record<string, unknown> : unknown;
/**
 * TypeScript type of the answer for a schema: required properties are mandatory,
 * the rest optional, string enums become unions, nested objects and arrays recurse.
 */
type InferFormat<T extends FormatModel> = InferObject<T["properties"], T["required"]>;
/**
 * Identity helper that keeps the literal types of a schema (`enum`, `required`)
 * so `InferFormat<typeof format>` is as precise as possible:
 *
 * ```ts
 * const format = defineFormat({
 *   type: "object",
 *   required: ["position"],
 *   properties: { position: { type: "string", enum: ["long", "short", "wait"], description: "…" } },
 * });
 * type Answer = InferFormat<typeof format>; // { position: "long" | "short" | "wait" }
 * ```
 */
declare const defineFormat: <const F extends FormatModel>(format: F) => F;

type RequestRole = "user" | "assistant" | "system";
/** One message of the conversation; the shape of a wwwroot.jsonl record message. */
interface RequestMessage {
    role: RequestRole;
    content: string;
    /** Base64 images (raw or data: URL). Shown to the model and saved under images/ in the workspace. */
    images?: string[];
}
/** A file written into the agent workspace before the run starts. */
interface RequestFile {
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
interface InferenceParams<F extends FormatModel = FormatModel> extends BaseParams {
    /** JSON schema of the answer; becomes the parameters of the provide_answer tool. */
    format: F;
}
/** Body of POST /api/v1/text. */
interface TextParams extends BaseParams {
}
type InferenceErrorCode = "schema_mismatch" | "empty_answer" | "max_turns" | "timeout" | "provider_error" | "internal_error";
interface InferenceError {
    code: InferenceErrorCode;
    message: string;
    /** One line per failed attempt or notable event, in order. */
    details: string[];
}
/** Fields shared by every inference response. */
interface RunInfo {
    /** Inference id; use it with the admin API to inspect the transcript. */
    id: string;
    model: string;
    /** Prompts sent, including re-prompts demanding provide_answer. */
    attempts: number;
    /** Model calls made. */
    turns: number;
    durationMs: number;
}
interface InferenceSuccess<T> extends RunInfo {
    status: "success";
    /** The provide_answer arguments, validated against `format`. */
    data: T;
}
interface TextSuccess extends RunInfo {
    status: "success";
    /** The agent's final message. */
    text: string;
}
interface InferenceFailure extends RunInfo {
    status: "error";
    error: InferenceError;
}
type InferenceResponse<T> = InferenceSuccess<T> | InferenceFailure;
type TextResponse = TextSuccess | InferenceFailure;
type InferenceStatus = "running" | "success" | "error";
type InferenceMode = "object" | "text";
type AttachmentKind = "file" | "image" | "tool_image" | "output";
interface AttachmentMeta {
    id: string;
    inferenceId: string;
    kind: AttachmentKind;
    name: string;
    mime: string;
    size: number;
    sha256: string;
}
interface InferenceSummary {
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
interface StoredRequest {
    messages: {
        role: RequestRole;
        content: string;
        images?: string[];
    }[];
    files: {
        attachmentId: string;
        name: string;
        size: number;
    }[];
    format?: FormatModel;
    model: string;
    instructions?: string;
}
interface InferenceRecord extends InferenceSummary {
    request: StoredRequest;
    /** pi agent transcript (system, user, assistant, toolResult messages); image payloads replaced by attachment ids. */
    messages: unknown[];
    /** The answer object (`object` mode) or string (`text` mode). */
    result: unknown | null;
    error: InferenceError | null;
    attachments: AttachmentMeta[];
}
interface ListInferencesQuery {
    limit?: number;
    offset?: number;
    status?: InferenceStatus;
    mode?: InferenceMode;
}
interface ListInferencesResponse {
    total: number;
    items: InferenceSummary[];
}
interface Attachment extends AttachmentMeta {
    data: Uint8Array;
}
interface Health {
    status: string;
    model: string;
    host: string;
    vision: boolean;
    running: boolean;
    queued: number;
    uptimeSeconds: number;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
interface ClientOptions {
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
interface RequestOptions {
    signal?: AbortSignal;
    headers?: Record<string, string>;
}
/**
 * Typed client for agent-runtime. All methods throw {@link AgentRuntimeError}
 * on transport or HTTP errors; `inference()` and `text()` return the typed
 * failure instead of throwing when the agent itself failed (HTTP 500 with an
 * InferenceFailure body), `generateObject()` and `generateText()` throw for it.
 */
declare class AgentRuntimeClient {
    private readonly baseUrl;
    private readonly fetchFn;
    private readonly headers;
    private readonly dispatcher;
    constructor(options?: ClientOptions);
    /**
     * POST /api/v1/inference. Resolves to the full typed response, success or
     * failure; the `status` field discriminates.
     */
    inference<const F extends FormatModel>(params: InferenceParams<F>, options?: RequestOptions): Promise<InferenceResponse<InferFormat<F>>>;
    /**
     * The json-inference `generateObject` equivalent: resolves to the answer
     * typed from `format`, throws {@link AgentRuntimeError} when the agent failed.
     */
    generateObject<const F extends FormatModel>(params: InferenceParams<F>, options?: RequestOptions): Promise<InferFormat<F>>;
    /** POST /api/v1/text. Resolves to the full typed response, success or failure. */
    text(params: TextParams, options?: RequestOptions): Promise<TextResponse>;
    /** The json-inference `generateText` equivalent: resolves to the final message, throws when the agent failed. */
    generateText(params: TextParams, options?: RequestOptions): Promise<string>;
    health(options?: RequestOptions): Promise<Health>;
    listInferences(query?: ListInferencesQuery, options?: RequestOptions): Promise<ListInferencesResponse>;
    getInference(id: string, options?: RequestOptions): Promise<InferenceRecord>;
    deleteInference(id: string, options?: RequestOptions): Promise<{
        ok: boolean;
    }>;
    /** Downloads an attachment (request file, image, tool image or produced file) with its metadata. */
    getAttachment(inferenceId: string, attachmentId: string, options?: RequestOptions): Promise<Attachment>;
    private runAgent;
    private json;
    private request;
}
declare const createClient: (options?: ClientOptions) => AgentRuntimeClient;

/** Default server address; `AGENT_RUNTIME_URL` overrides it, otherwise the Docker image's port is used. */
declare const DEFAULT_BASE_URL = "http://localhost:10050";
/**
 * Optional last argument of the standalone functions. Everything has a default,
 * so `generateObject(params)` works against a local agent-runtime without config.
 */
interface FunctionConfig extends ClientOptions, RequestOptions {
}

/**
 * json-inference style `generateObject()`: runs the agent on agent-runtime and
 * resolves to the answer typed from `format`. Creates the client internally;
 * the optional `config` sets `baseUrl` (default `AGENT_RUNTIME_URL` or
 * http://localhost:10050), `headers`, `fetch`, `dispatcher` and `signal`.
 * Throws AgentRuntimeError when the agent failed.
 *
 * ```ts
 * const entry = await generateObject({
 *   messages: [{ role: "user", content: "…" }],
 *   format: { type: "object", required: ["position"], properties: { position: { type: "string", enum: ["long", "short"], description: "…" } } },
 * });
 * entry.position; // "long" | "short"
 * ```
 */
declare const generateObject: <const F extends FormatModel>(params: InferenceParams<F>, config?: FunctionConfig) => Promise<InferFormat<F>>;
/** Same request, but resolves to the full typed response (`status: "success" | "error"`) instead of throwing. */
declare const inference: <const F extends FormatModel>(params: InferenceParams<F>, config?: FunctionConfig) => Promise<InferenceResponse<InferFormat<F>>>;

/**
 * json-inference style `generateText()`: runs the agent on agent-runtime and
 * resolves to its final message. Creates the client internally; the optional
 * `config` sets `baseUrl` (default `AGENT_RUNTIME_URL` or http://localhost:10050),
 * `headers`, `fetch`, `dispatcher` and `signal`. Throws AgentRuntimeError when
 * the agent failed.
 *
 * ```ts
 * const summary = await generateText({ messages: [{ role: "user", content: "Summarise notes.txt" }], files: [encodeFile("notes.txt", notes)] });
 * ```
 */
declare const generateText: (params: TextParams, config?: FunctionConfig) => Promise<string>;
/** Same request, but resolves to the full typed response (`status: "success" | "error"`) instead of throwing. */
declare const text: (params: TextParams, config?: FunctionConfig) => Promise<TextResponse>;

/**
 * Thrown by the client for any HTTP failure. When the server answered with an
 * InferenceFailure body (HTTP 500 from /inference or /text) the typed failure
 * is available in `failure` and `code` is the InferenceErrorCode.
 */
declare class AgentRuntimeError extends Error {
    readonly status: number;
    readonly body: unknown;
    readonly failure: InferenceFailure | null;
    constructor(message: string, status: number, body: unknown, failure?: InferenceFailure | null);
    /** InferenceErrorCode when the server returned a typed failure, otherwise null. */
    get code(): InferenceError["code"] | null;
    /** Per-attempt details when the server returned a typed failure. */
    get details(): string[];
    /** Inference id (present for typed failures) for looking the run up in the admin UI. */
    get inferenceId(): string | null;
}
declare const isInferenceFailure: (value: unknown) => value is InferenceFailure;

/** Builds a request file from raw bytes or a UTF-8 string. */
declare const encodeFile: (name: string, data: Uint8Array | string) => RequestFile;
/** Encodes image bytes (jpeg, png, gif, webp) as the base64 string expected in `messages[].images`. */
declare const encodeImage: (data: Uint8Array) => string;
/** Shorthand for a user message with optional image attachments. */
declare const userMessage: (content: string, images?: Uint8Array[]) => RequestMessage;

export { AgentRuntimeClient, AgentRuntimeError, type Attachment, type AttachmentKind, type AttachmentMeta, type ClientOptions, DEFAULT_BASE_URL, type FetchLike, type FormatItems, type FormatModel, type FormatProperty, type FunctionConfig, type Health, type InferFormat, type InferProperty, type InferenceError, type InferenceErrorCode, type InferenceFailure, type InferenceMode, type InferenceParams, type InferenceRecord, type InferenceResponse, type InferenceStatus, type InferenceSuccess, type InferenceSummary, type ListInferencesQuery, type ListInferencesResponse, type RequestFile, type RequestMessage, type RequestOptions, type RequestRole, type RunInfo, type StoredRequest, type TextParams, type TextResponse, type TextSuccess, createClient, defineFormat, encodeFile, encodeImage, generateObject, generateText, inference, isInferenceFailure, text, userMessage };
