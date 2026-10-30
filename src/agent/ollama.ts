/**
 * Inference adapter: runs the pi agent loop on top of the `ollama` SDK.
 *
 * The request shape mirrors json-inference's OllamaProvider: native
 * `ollama.chat` with `tools` (function calling) and an optional `think`
 * flag, no structured-output `format`. The structured answer is enforced by
 * the `provide_answer` tool and the harness retry loop instead.
 */
import { Ollama, type Message as OllamaMessage, type Tool as OllamaTool, type ToolCall as OllamaToolCall } from "ollama";
import {
  createAssistantMessageEventStream,
  getCurrentTools,
  getSystemMessageText,
  renderSystemMessageUpdate,
  type Api,
  type AssistantMessage,
  type ImageContent,
  type Message,
  type Model,
  type SimpleStreamOptions,
  type TextContent,
  type ThinkingContent,
  type Tool,
  type ToolCall,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";

import { CONFIG } from "../config.js";
import { stripDataUrl } from "../helpers/images.js";
import { getLogger, preview, since, type ScopedLogger } from "../lib/logger.js";

const moduleLog = getLogger("ollama");

export const OLLAMA_API: Api = "ollama-chat";
export const OLLAMA_PROVIDER = "ollama";

export interface OllamaStreamOptions {
  host: string;
  apiKey?: string;
  think?: boolean | "low" | "medium" | "high";
  numCtx?: number;
  numPredict?: number;
  temperature?: number;
  /** Per-tool replacement of `parameters` in the request (the schema the model sees), keyed by tool name. */
  toolParameters?: Record<string, Record<string, unknown>>;
}

/** Builds the pi Model descriptor for an Ollama model name. */
export const createOllamaModel = (name: string, vision: boolean, options: OllamaStreamOptions): Model<Api> => ({
  id: name,
  name,
  api: OLLAMA_API,
  provider: OLLAMA_PROVIDER,
  baseUrl: options.host,
  reasoning: options.think !== undefined && options.think !== false,
  input: vision ? ["text", "image"] : ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: options.numCtx || 131072,
  maxTokens: 32768,
});

/** Same client construction as json-inference OllamaProvider. */
export const createOllamaClient = (options: OllamaStreamOptions): Ollama =>
  options.apiKey
    ? new Ollama({ host: options.host, headers: { Authorization: `Bearer ${options.apiKey}` } })
    : new Ollama({ host: options.host });

const toOllamaTool = (tool: Tool, overrides?: Record<string, Record<string, unknown>>): OllamaTool => ({
  type: "function",
  function: {
    name: tool.name,
    description: tool.description,
    parameters: (overrides?.[tool.name] ?? tool.parameters) as OllamaTool["function"]["parameters"],
  },
});

const textOf = (content: string | readonly (TextContent | ImageContent)[]): string =>
  typeof content === "string"
    ? content
    : content
        .filter((part): part is TextContent => part.type === "text")
        .map((part) => part.text)
        .join("\n");

const imagesOf = (content: string | readonly (TextContent | ImageContent)[]): string[] =>
  typeof content === "string"
    ? []
    : content.filter((part): part is ImageContent => part.type === "image").map((part) => stripDataUrl(part.data));

/**
 * Converts the pi transcript into Ollama chat messages.
 * Tool declarations live in pi system messages; they are extracted separately.
 */
export const toOllamaMessages = (messages: readonly Message[], vision: boolean): OllamaMessage[] => {
  const result: OllamaMessage[] = [];
  let systemSeen = false;
  for (const message of messages) {
    switch (message.role) {
      case "system": {
        const text = systemSeen ? renderSystemMessageUpdate(message) : getSystemMessageText(message);
        systemSeen = true;
        if (text.trim()) result.push({ role: "system", content: text });
        break;
      }
      case "user": {
        const images = vision ? imagesOf(message.content) : [];
        result.push({
          role: "user",
          content: textOf(message.content),
          ...(images.length ? { images } : {}),
        });
        break;
      }
      case "assistant": {
        const text = message.content
          .filter((part): part is TextContent => part.type === "text")
          .map((part) => part.text)
          .join("\n");
        const thinking = message.content
          .filter((part): part is ThinkingContent => part.type === "thinking")
          .map((part) => part.thinking)
          .join("\n");
        const toolCalls: OllamaToolCall[] = message.content
          .filter((part): part is ToolCall => part.type === "toolCall")
          .map((part) => ({ function: { name: part.name, arguments: part.arguments } }));
        result.push({
          role: "assistant",
          content: text,
          ...(thinking ? { thinking } : {}),
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        });
        break;
      }
      case "toolResult": {
        const text = textOf(message.content);
        const images = imagesOf(message.content);
        result.push({
          role: "tool",
          tool_name: message.toolName,
          content: text || (images.length ? "(see attached image)" : "(no tool output)"),
        });
        if (images.length && vision) {
          result.push({
            role: "user",
            content: `Attached image(s) from the ${message.toolName} tool result:`,
            images,
          });
        }
        break;
      }
    }
  }
  return result;
};

let toolCallCounter = 0;
const nextToolCallId = () => `call_${Date.now().toString(36)}_${(toolCallCounter++).toString(36)}`;

/** Creates a pi StreamFn backed by ollama.chat. */
export const createOllamaStreamFn = (options: OllamaStreamOptions, logger: ScopedLogger = moduleLog): StreamFn => {
  let requestCounter = 0;
  return (model: Model<Api>, context: TranscriptContext, streamOptions?: SimpleStreamOptions) => {
    const stream = createAssistantMessageEventStream();
    const started = Date.now();
    const vision = model.input.includes("image");
    const requestNo = ++requestCounter;
    const log = logger.child(`ollama#${requestNo}`);

    const base: AssistantMessage = {
      role: "assistant",
      content: [],
      api: OLLAMA_API,
      provider: OLLAMA_PROVIDER,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "pending",
      timestamp: started,
    };

    const fail = (reason: "error" | "aborted", errorMessage: string) => {
      const message: AssistantMessage = { ...base, stopReason: reason, errorMessage, durationMs: Date.now() - started };
      log.error(`chat ${reason}`, undefined, { errorMessage, durationMs: message.durationMs, model: model.id, host: options.host });
      stream.push({ type: "error", reason, error: message });
      stream.end(message);
    };

    const run = async () => {
      const signal = streamOptions?.signal;
      if (signal?.aborted) {
        fail("aborted", "Request aborted");
        return;
      }
      const client = createOllamaClient(options);
      const onAbort = () => client.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const tools = getCurrentTools(context.messages).map((tool) => toOllamaTool(tool, options.toolParameters));
        const messages = toOllamaMessages(context.messages, vision);
        log.debug("chat request", {
          model: model.id,
          host: options.host,
          apiKey: options.apiKey ? "set" : "none",
          think: options.think ?? "default",
          options: { num_ctx: options.numCtx, num_predict: options.numPredict, temperature: options.temperature },
          tools: tools.map((tool) => tool.function.name),
          messages: messages.map((m) => ({
            role: m.role,
            ...(m.tool_name ? { tool_name: m.tool_name } : {}),
            length: m.content.length,
            images: m.images?.length ?? 0,
            toolCalls: m.tool_calls?.map((call) => call.function.name),
            preview: preview(m.content, 80),
          })),
          lastMessage: messages.length ? { role: messages[messages.length - 1].role, content: messages[messages.length - 1].content } : null,
        });

        // Streaming keeps the HTTP response alive while the model generates:
        // Node's fetch drops a non-streaming request after 300 s without headers.
        const chunks = await client.chat({
          model: model.id,
          messages,
          tools: tools.length ? tools : undefined,
          stream: true,
          ...(options.think !== undefined ? { think: options.think } : {}),
          options: {
            ...(options.numCtx ? { num_ctx: options.numCtx } : {}),
            ...(options.numPredict ? { num_predict: options.numPredict } : {}),
            ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
          },
        });

        const partial: AssistantMessage = { ...base, content: [] };
        stream.push({ type: "start", partial: { ...partial } });
        log.debug("stream opened", { afterMs: since(started) });

        let chunkCount = 0;
        let thinkingIndex = -1;
        let textIndex = -1;
        const toolCalls: OllamaToolCall[] = [];
        let doneReason: string | undefined;
        let responseModel: string | undefined;
        let input = 0;
        let output = 0;

        const closeOpenBlocks = () => {
          if (thinkingIndex >= 0) {
            const block = partial.content[thinkingIndex] as ThinkingContent;
            stream.push({ type: "thinking_end", contentIndex: thinkingIndex, content: block.thinking, partial: { ...partial } });
            thinkingIndex = -1;
          }
          if (textIndex >= 0) {
            const block = partial.content[textIndex] as TextContent;
            stream.push({ type: "text_end", contentIndex: textIndex, content: block.text, partial: { ...partial } });
            textIndex = -1;
          }
        };

        for await (const chunk of chunks) {
          chunkCount += 1;
          const delta = chunk.message;
          if (delta?.thinking) {
            if (textIndex >= 0) closeOpenBlocks();
            if (thinkingIndex < 0) {
              thinkingIndex = partial.content.length;
              partial.content = [...partial.content, { type: "thinking", thinking: "" }];
              stream.push({ type: "thinking_start", contentIndex: thinkingIndex, partial: { ...partial } });
            }
            (partial.content[thinkingIndex] as ThinkingContent).thinking += delta.thinking;
            stream.push({ type: "thinking_delta", contentIndex: thinkingIndex, delta: delta.thinking, partial: { ...partial } });
          }
          if (delta?.content) {
            if (thinkingIndex >= 0 && textIndex < 0) closeOpenBlocks();
            if (textIndex < 0) {
              textIndex = partial.content.length;
              partial.content = [...partial.content, { type: "text", text: "" }];
              stream.push({ type: "text_start", contentIndex: textIndex, partial: { ...partial } });
            }
            (partial.content[textIndex] as TextContent).text += delta.content;
            stream.push({ type: "text_delta", contentIndex: textIndex, delta: delta.content, partial: { ...partial } });
          }
          if (delta?.tool_calls?.length) {
            toolCalls.push(...delta.tool_calls);
            log.debug("tool call chunk", { names: delta.tool_calls.map((call) => call.function.name), afterMs: since(started) });
          }
          if (chunk.done) {
            doneReason = chunk.done_reason;
            responseModel = chunk.model;
            input = chunk.prompt_eval_count ?? 0;
            output = chunk.eval_count ?? 0;
          }
        }
        closeOpenBlocks();

        for (const call of toolCalls) {
          const block: ToolCall = {
            type: "toolCall",
            id: nextToolCallId(),
            name: call.function.name,
            arguments: normalizeArguments(call.function.arguments),
          };
          const index = partial.content.length;
          partial.content = [...partial.content, { ...block, arguments: {} }];
          stream.push({ type: "toolcall_start", contentIndex: index, partial: { ...partial } });
          stream.push({ type: "toolcall_delta", contentIndex: index, delta: JSON.stringify(block.arguments), partial: { ...partial } });
          partial.content[index] = block;
          stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: { ...partial } });
        }

        const stopReason: AssistantMessage["stopReason"] = toolCalls.length
          ? "toolUse"
          : doneReason === "length"
            ? "length"
            : "stop";
        const message: AssistantMessage = {
          ...partial,
          stopReason,
          rawStopReason: doneReason,
          durationMs: Date.now() - started,
          responseModel,
          usage: { ...base.usage, input, output, totalTokens: input + output },
        };
        log.info("chat response", {
          model: response_model_or(responseModel, model.id),
          stopReason,
          doneReason,
          durationMs: message.durationMs,
          chunks: chunkCount,
          tokens: { input, output },
          thinkingLength: (partial.content.find((p) => p.type === "thinking") as ThinkingContent | undefined)?.thinking.length ?? 0,
          textLength: (partial.content.find((p) => p.type === "text") as TextContent | undefined)?.text.length ?? 0,
          text: preview((partial.content.find((p) => p.type === "text") as TextContent | undefined)?.text, 300),
          toolCalls: toolCalls.map((call) => ({ name: call.function.name, arguments: call.function.arguments })),
        });
        stream.push({ type: "done", reason: stopReason, message });
        stream.end(message);
      } catch (error) {
        if (signal?.aborted) {
          fail("aborted", "Request aborted");
        } else {
          fail("error", describeError(error));
        }
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
    };

    void run();
    return stream;
  };
};

const response_model_or = (responseModel: string | undefined, fallback: string) => responseModel ?? fallback;

/** Ollama returns parsed objects, but some models emit the arguments as a JSON string. */
const normalizeArguments = (value: unknown): ToolCall["arguments"] => {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
      moduleLog.warn("tool call arguments are not valid JSON", { raw: value, error: error instanceof Error ? error.message : String(error) });
      return {};
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as ToolCall["arguments"];
  }
  return {};
};

const describeError = (error: unknown): string => {
  if (error instanceof Error) {
    const status = (error as { status_code?: number }).status_code;
    return status ? `Ollama request failed (${status}): ${error.message}` : `Ollama request failed: ${error.message}`;
  }
  return `Ollama request failed: ${String(error)}`;
};

export const defaultOllamaOptions = (): OllamaStreamOptions => ({
  host: CONFIG.OLLAMA_HOST,
  apiKey: CONFIG.OLLAMA_API_KEY || undefined,
  think: CONFIG.OLLAMA_THINK,
  numCtx: CONFIG.OLLAMA_NUM_CTX || undefined,
  numPredict: CONFIG.OLLAMA_NUM_PREDICT || undefined,
  temperature: CONFIG.OLLAMA_TEMPERATURE === "" ? undefined : Number(CONFIG.OLLAMA_TEMPERATURE),
});
