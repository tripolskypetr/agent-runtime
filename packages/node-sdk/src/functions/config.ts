import type { ClientOptions, RequestOptions } from "../client/AgentRuntimeClient.js";
import { AgentRuntimeClient } from "../client/AgentRuntimeClient.js";

/** Default server address; `AGENT_RUNTIME_URL` overrides it, otherwise the Docker image's port is used. */
export const DEFAULT_BASE_URL = "http://localhost:10050";

/**
 * Optional last argument of the standalone functions. Everything has a default,
 * so `generateObject(params)` works against a local agent-runtime without config.
 */
export interface FunctionConfig extends ClientOptions, RequestOptions {}

export const resolveBaseUrl = (baseUrl?: string): string =>
  baseUrl ?? (typeof process !== "undefined" ? process.env?.AGENT_RUNTIME_URL : undefined) ?? DEFAULT_BASE_URL;

/** Builds a client and the per-request options from one flat config object. */
export const resolveConfig = (config: FunctionConfig = {}): { client: AgentRuntimeClient; options: RequestOptions } => {
  const { baseUrl, fetch, headers, dispatcher, signal, validateAnswer, maxAttempts } = config;
  const client = new AgentRuntimeClient({ baseUrl: resolveBaseUrl(baseUrl), fetch, headers, dispatcher, validateAnswer, maxAttempts });
  return { client, options: signal ? { signal } : {} };
};
