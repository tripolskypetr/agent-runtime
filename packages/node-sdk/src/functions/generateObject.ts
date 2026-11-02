import type { FormatModel, InferFormat } from "../model/Format.model.js";
import type { InferenceParams, InferenceResponse } from "../model/Api.model.js";
import { resolveConfig, type FunctionConfig } from "./config.js";

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
export const generateObject = async <const F extends FormatModel>(
  params: InferenceParams<F>,
  config: FunctionConfig = {},
): Promise<InferFormat<F>> => {
  const { client, options } = resolveConfig(config);
  return client.generateObject(params, options);
};

/** Same request, but resolves to the full typed response (`status: "success" | "error"`) instead of throwing. */
export const inference = async <const F extends FormatModel>(
  params: InferenceParams<F>,
  config: FunctionConfig = {},
): Promise<InferenceResponse<InferFormat<F>>> => {
  const { client, options } = resolveConfig(config);
  return client.inference(params, options);
};

export default generateObject;
