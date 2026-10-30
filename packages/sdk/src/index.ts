export { generateObject, inference } from "./functions/generateObject.js";
export { generateText, text } from "./functions/generateText.js";
export { DEFAULT_BASE_URL } from "./functions/config.js";
export type { FunctionConfig } from "./functions/config.js";

export { AgentRuntimeClient, createClient } from "./client/AgentRuntimeClient.js";
export type { ClientOptions, FetchLike, RequestOptions } from "./client/AgentRuntimeClient.js";
export { AgentRuntimeError, isInferenceFailure } from "./client/AgentRuntimeError.js";

export { defineFormat } from "./model/Format.model.js";
export type {
  DefaultRefDepth,
  FormatItems,
  FormatModel,
  FormatProperty,
  InferFormat,
  InferProperty,
  JsonSchema,
  JsonSchemaType,
} from "./model/Format.model.js";

export type {
  Attachment,
  AttachmentKind,
  AttachmentMeta,
  Health,
  InferenceError,
  InferenceErrorCode,
  InferenceFailure,
  InferenceMode,
  InferenceParams,
  InferenceRecord,
  InferenceResponse,
  InferenceStatus,
  InferenceSuccess,
  InferenceSummary,
  ListInferencesQuery,
  ListInferencesResponse,
  RequestFile,
  RequestMessage,
  RequestRole,
  RunInfo,
  StoredRequest,
  TextParams,
  TextResponse,
  TextSuccess,
} from "./model/Api.model.js";

export { encodeFile, encodeImage, userMessage } from "./helpers/encode.js";
