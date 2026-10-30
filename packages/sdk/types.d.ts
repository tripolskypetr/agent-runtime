/**
 * `format` of an inference request: a JSON Schema (draft 2020-12) whose top
 * level is an object. json-inference's FormatModel is a subset, so schemas
 * written for its generateObject() keep working unchanged.
 *
 * Everything is `readonly` so that a schema passed inline, through
 * `defineFormat()` or declared `as const` keeps its literal types (`enum`,
 * `const`, `required`, `type`), which is what gives IntelliSense on the answer.
 */
type JsonSchemaType = "string" | "number" | "integer" | "boolean" | "array" | "object" | "null";
interface JsonSchema {
    readonly $schema?: string;
    readonly $id?: string;
    readonly $ref?: string;
    readonly $defs?: {
        readonly [name: string]: JsonSchema;
    };
    readonly $comment?: string;
    readonly title?: string;
    readonly description?: string;
    readonly default?: unknown;
    readonly examples?: readonly unknown[];
    readonly deprecated?: boolean;
    readonly readOnly?: boolean;
    readonly writeOnly?: boolean;
    readonly type?: JsonSchemaType | readonly JsonSchemaType[];
    readonly enum?: readonly unknown[];
    readonly const?: unknown;
    readonly oneOf?: readonly JsonSchema[];
    readonly anyOf?: readonly JsonSchema[];
    readonly allOf?: readonly JsonSchema[];
    readonly not?: JsonSchema;
    readonly if?: JsonSchema;
    readonly then?: JsonSchema;
    readonly else?: JsonSchema;
    readonly properties?: {
        readonly [key: string]: JsonSchema;
    };
    readonly required?: readonly string[];
    readonly additionalProperties?: boolean | JsonSchema;
    readonly patternProperties?: {
        readonly [pattern: string]: JsonSchema;
    };
    readonly propertyNames?: JsonSchema;
    readonly unevaluatedProperties?: boolean | JsonSchema;
    readonly dependentRequired?: {
        readonly [key: string]: readonly string[];
    };
    readonly dependentSchemas?: {
        readonly [key: string]: JsonSchema;
    };
    readonly minProperties?: number;
    readonly maxProperties?: number;
    readonly items?: JsonSchema;
    readonly prefixItems?: readonly JsonSchema[];
    readonly contains?: JsonSchema;
    readonly minContains?: number;
    readonly maxContains?: number;
    readonly unevaluatedItems?: boolean | JsonSchema;
    readonly minItems?: number;
    readonly maxItems?: number;
    readonly uniqueItems?: boolean;
    readonly minLength?: number;
    readonly maxLength?: number;
    readonly pattern?: string;
    readonly format?: string;
    readonly contentEncoding?: string;
    readonly contentMediaType?: string;
    readonly minimum?: number;
    readonly maximum?: number;
    readonly exclusiveMinimum?: number;
    readonly exclusiveMaximum?: number;
    readonly multipleOf?: number;
}
/** Kept for code written against the json-inference subset; both are the full JsonSchema now. */
type FormatItems = JsonSchema;
type FormatProperty = JsonSchema;
/** Root schema: an object with `required` and `properties` (the provide_answer tool arguments). */
interface FormatModel extends JsonSchema {
    readonly type: "object";
    readonly required: readonly string[];
    readonly properties: {
        readonly [key: string]: JsonSchema;
    };
}
/** Flattens intersections so hover tooltips show one plain object type. */
type Simplify<T> = T extends object ? (T extends (...args: never[]) => unknown ? T : {
    [K in keyof T]: T[K];
} & {}) : T;
type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (k: infer I) => void ? I : never;
/** Depth counter for `$ref` recursion: `Prev[6]` is 5, `Prev[0]` is never. */
type Prev = [never, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
type Depth = Prev[number];
/** Default `$ref` depth: nested references deeper than this become `unknown`. */
type DefaultRefDepth = 6;
type ScalarOf<T extends JsonSchemaType> = T extends "string" ? string : T extends "number" | "integer" ? number : T extends "boolean" ? boolean : T extends "null" ? null : never;
/** Keys listed in `required`; a widened `string[]` keeps every key required, as json-inference does. */
type RequiredKeysOf<P, R> = R extends readonly (infer K)[] ? (K extends string ? K & keyof P : never) : never;
type InferObject<P, R, Root, D extends Depth> = Simplify<{
    -readonly [K in keyof P as K extends RequiredKeysOf<P, R> ? K : never]-?: InferProperty<P[K], Root, D>;
} & {
    -readonly [K in keyof P as K extends RequiredKeysOf<P, R> ? never : K]?: InferProperty<P[K], Root, D>;
}>;
type InferRef<Name, Root, D extends Depth> = [D] extends [never] ? unknown : Root extends {
    readonly $defs: infer Defs;
} ? Name extends keyof Defs ? InferProperty<Defs[Name], Root, Prev[D]> : unknown : unknown;
type InferBranches<B, Root, D extends Depth> = B extends readonly (infer S)[] ? InferProperty<S, Root, D> : unknown;
type InferAllOf<B, Root, D extends Depth> = B extends readonly (infer S)[] ? UnionToIntersection<InferProperty<S, Root, D>> : unknown;
/** Type of a schema without its combinators: the part keyed by `type`. */
type InferByType<T, Root, D extends Depth> = T extends {
    readonly type: readonly (infer U extends JsonSchemaType)[];
} ? U extends "object" | "array" ? InferByType<Omit<T, "type"> & {
    readonly type: U;
}, Root, D> : ScalarOf<U> : T extends {
    readonly type: "string" | "number" | "integer" | "boolean" | "null";
} ? ScalarOf<T["type"] & JsonSchemaType> : T extends {
    readonly type: "array";
    readonly items: infer I;
} ? InferProperty<I, Root, D>[] : T extends {
    readonly type: "array";
} ? unknown[] : T extends {
    readonly type: "object";
    readonly properties: infer P;
} ? InferObject<P, T extends {
    readonly required: infer R;
} ? R : never, Root, D> : T extends {
    readonly type: "object";
} ? Record<string, unknown> : T extends {
    readonly properties: infer P;
} ? InferObject<P, T extends {
    readonly required: infer R;
} ? R : never, Root, D> : T extends {
    readonly items: infer I;
} ? InferProperty<I, Root, D>[] : unknown;
/**
 * TypeScript type of the value described by a schema node. Precedence:
 * `$ref` → `const` → `enum` → `oneOf` / `anyOf` (union, intersected with the
 * node's own type) → `allOf` (intersection) → `type` (array of types gives a
 * union, `"null"` gives `null`) → object / array shape. `if`/`then`/`else`
 * do not change the type.
 */
type InferProperty<T, Root = T, D extends Depth = DefaultRefDepth> = T extends {
    readonly $ref: `#/$defs/${infer Name}`;
} ? InferRef<Name, Root, D> : T extends {
    readonly const: infer C;
} ? C : T extends {
    readonly enum: readonly (infer E)[];
} ? E : T extends {
    readonly oneOf: infer B;
} ? InferBranches<B, Root, D> & InferByType<Omit<T, "oneOf">, Root, D> : T extends {
    readonly anyOf: infer B;
} ? InferBranches<B, Root, D> & InferByType<Omit<T, "anyOf">, Root, D> : T extends {
    readonly allOf: infer B;
} ? Simplify<InferAllOf<B, Root, D> & InferByType<Omit<T, "allOf">, Root, D>> : InferByType<T, Root, D>;
/**
 * TypeScript type of the answer for a schema: required properties are mandatory,
 * the rest optional, enums and consts become literals, nullable types become
 * `T | null`, `oneOf` becomes a union, nested objects, arrays and `$ref`s recurse.
 *
 * Recursive `$ref`s are followed up to `D` levels (6 by default); a reference
 * deeper than that is typed as `unknown`. This is the one deliberate limit of
 * the inference: one `defineFormat()` call is the whole contract, there is no
 * second, hand-written type to keep in sync.
 */
type InferFormat<T extends FormatModel, D extends Depth = DefaultRefDepth> = InferProperty<T, T, D>;
/**
 * Identity helper that keeps the literal types of a schema (`enum`, `const`,
 * `required`, `type`) so `InferFormat<typeof format>` is as precise as possible:
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
type InferenceErrorCode = "invalid_format" | "schema_mismatch" | "empty_answer" | "max_turns" | "timeout" | "provider_error" | "internal_error";
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
    private readonly explicitCode;
    constructor(message: string, status: number, body: unknown, failure?: InferenceFailure | null, code?: InferenceErrorCode | null);
    /** InferenceErrorCode when the server returned a typed failure or rejected the schema (`invalid_format`), otherwise null. */
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

export { AgentRuntimeClient, AgentRuntimeError, type Attachment, type AttachmentKind, type AttachmentMeta, type ClientOptions, DEFAULT_BASE_URL, type DefaultRefDepth, type FetchLike, type FormatItems, type FormatModel, type FormatProperty, type FunctionConfig, type Health, type InferFormat, type InferProperty, type InferenceError, type InferenceErrorCode, type InferenceFailure, type InferenceMode, type InferenceParams, type InferenceRecord, type InferenceResponse, type InferenceStatus, type InferenceSuccess, type InferenceSummary, type JsonSchema, type JsonSchemaType, type ListInferencesQuery, type ListInferencesResponse, type RequestFile, type RequestMessage, type RequestOptions, type RequestRole, type RunInfo, type StoredRequest, type TextParams, type TextResponse, type TextSuccess, createClient, defineFormat, encodeFile, encodeImage, generateObject, generateText, inference, isInferenceFailure, text, userMessage };
