import type { TextParams, TextResponse } from "../model/Api.model.js";
import { resolveConfig, type FunctionConfig } from "./config.js";

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
export const generateText = async (params: TextParams, config: FunctionConfig = {}): Promise<string> => {
  const { client, options } = resolveConfig(config);
  return client.generateText(params, options);
};

/** Same request, but resolves to the full typed response (`status: "success" | "error"`) instead of throwing. */
export const text = async (params: TextParams, config: FunctionConfig = {}): Promise<TextResponse> => {
  const { client, options } = resolveConfig(config);
  return client.text(params, options);
};

export default generateText;
