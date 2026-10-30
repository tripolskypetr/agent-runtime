import path from "path";
import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ImageContent, TextContent, ToolCall, UserMessage } from "@earendil-works/pi-ai";

import { CONFIG } from "../config.js";
import type { Database } from "../db/database.js";
import { createImageSink, externalizeImages } from "../helpers/history.js";
import { decodeImage, extensionByMime, guessFileMime, sha256, stripDataUrl } from "../helpers/images.js";
import { describeFormat } from "../helpers/schema.js";
import { getLogger, preview, since, type ScopedLogger } from "../lib/logger.js";
import type { InferenceError, InferenceMode, InferenceRequest, StoredRequest, TextRequest } from "../model/Inference.model.js";
import { createOllamaModel, createOllamaStreamFn, defaultOllamaOptions, OLLAMA_API, OLLAMA_PROVIDER } from "./ollama.js";
import { renderSystemPrompt, RETRY_MESSAGE, TEXT_RETRY_MESSAGE } from "./systemPrompt.js";
import { createBashTool } from "./tools/bash.tool.js";
import { createProvideAnswerTool, PROVIDE_ANSWER_TOOL } from "./tools/provideAnswer.tool.js";
import { createViewImageTool } from "./tools/viewImage.tool.js";
import { Workspace } from "./workspace.js";

export interface RunContext {
  id: string;
  /** `object`: answer through provide_answer validated against `format`; `text`: the last assistant text (generateText). */
  mode: InferenceMode;
  db: Database;
  workspace: Workspace;
  /** Logger scoped to this inference; defaults to `inference:<id>`. */
  logger?: ScopedLogger;
}

export interface InferenceOutcome {
  status: "success" | "error";
  /** The validated object in `object` mode, the answer string in `text` mode. */
  data?: unknown;
  error?: InferenceError;
  model: string;
  attempts: number;
  turns: number;
  durationMs: number;
}

/**
 * Runs one inference end to end:
 * reset workspace → materialize files/images → pi agent loop over Ollama →
 * retry with an explicit JSON demand while provide_answer was not called →
 * snapshot produced files → persist transcript → clear workspace.
 */
export const runInference = async (request: InferenceRequest | TextRequest, ctx: RunContext): Promise<InferenceOutcome> => {
  const { id, mode, db, workspace } = ctx;
  const log = ctx.logger ?? getLogger("inference").child(id);
  const format = mode === "object" && "format" in request ? request.format : undefined;
  const started = Date.now();
  const modelName = request.model?.trim() || CONFIG.OLLAMA_MODEL;
  const vision = CONFIG.OLLAMA_VISION;
  const ollamaOptions = defaultOllamaOptions();

  let attempts = 0;
  let turns = 0;
  const details: string[] = [];

  log.info("run start", {
    mode,
    model: modelName,
    vision,
    think: ollamaOptions.think ?? "default",
    numCtx: ollamaOptions.numCtx ?? "default",
    numPredict: ollamaOptions.numPredict ?? "default",
    messages: request.messages.length,
    images: request.messages.reduce((sum, m) => sum + (m.images?.length ?? 0), 0),
    files: (request.files ?? []).map((f) => ({ name: f.name, base64Length: f.content.length })),
    format: format ? describeFormat(format as unknown as Record<string, unknown>) : null,
    modelSchemaRefDepth: CONFIG.MODEL_SCHEMA_REF_DEPTH,
    instructions: preview(request.instructions),
    limits: { maxAttempts: CONFIG.MAX_ATTEMPTS, maxTurns: CONFIG.MAX_TURNS, timeoutMs: CONFIG.INFERENCE_TIMEOUT_MS },
  });

  const sink = createImageSink((input) => {
    const meta = db.addAttachment({ inferenceId: id, ...input });
    log.debug("attachment stored", { kind: meta.kind, name: meta.name, mime: meta.mime, size: meta.size, attachmentId: meta.id });
    return meta;
  });
  const snapshot = (messages: readonly AgentMessage[]) => externalizeImages(messages as unknown[], sink);

  let transcript: unknown[] = [];
  const finish = (outcome: InferenceOutcome): InferenceOutcome => {
    db.finishInference(id, {
      status: outcome.status,
      messages: transcript,
      attempts: outcome.attempts,
      turns: outcome.turns,
      durationMs: outcome.durationMs,
      result: outcome.status === "success" ? outcome.data : null,
      error: outcome.status === "error" ? outcome.error ?? null : null,
    });
    if (outcome.status === "success") {
      log.info("run success", {
        attempts: outcome.attempts,
        turns: outcome.turns,
        durationMs: outcome.durationMs,
        transcriptMessages: transcript.length,
        data: outcome.data,
      });
    } else {
      log.warn("run failed", {
        code: outcome.error?.code,
        message: outcome.error?.message,
        details: outcome.error?.details,
        attempts: outcome.attempts,
        turns: outcome.turns,
        durationMs: outcome.durationMs,
        transcriptMessages: transcript.length,
      });
    }
    return outcome;
  };
  const fail = (error: InferenceError): InferenceOutcome =>
    finish({ status: "error", error, model: modelName, attempts, turns, durationMs: since(started) });

  try {
    // 1. Fresh workspace with the request files and images.
    await workspace.reset();
    const inputs = new Map<string, string>();
    const storedFiles: StoredRequest["files"] = [];
    const fileList: { path: string; size: number }[] = [];
    for (const [index, file] of (request.files ?? []).entries()) {
      const name = Workspace.safeName(file.name, `file_${index}`);
      const bytes = Buffer.from(stripDataUrl(file.content).replace(/\s+/g, ""), "base64");
      const relative = await workspace.write(name, bytes);
      const hash = sha256(bytes);
      inputs.set(relative, hash);
      const meta = db.addAttachment({
        inferenceId: id,
        kind: "file",
        name: relative,
        mime: guessFileMime(relative, bytes),
        sha256: hash,
        data: bytes,
      });
      log.debug("request file written", { requested: file.name, path: relative, size: bytes.byteLength, mime: meta.mime, sha256: hash, attachmentId: meta.id });
      storedFiles.push({ attachmentId: meta.id, name: relative, size: bytes.byteLength });
      fileList.push({ path: relative, size: bytes.byteLength });
    }

    const imageList: { path: string; size: number; messageIndex: number }[] = [];
    const storedMessages: StoredRequest["messages"] = [];
    const agentMessages: AgentMessage[] = [];
    const extraInstructions: string[] = request.instructions?.trim() ? [request.instructions.trim()] : [];

    for (const [index, message] of request.messages.entries()) {
      const imageParts: ImageContent[] = [];
      const imagePaths: string[] = [];
      const imageIds: string[] = [];
      for (const [imageIndex, raw] of (message.images ?? []).entries()) {
        const decoded = decodeImage(raw);
        const relative = await workspace.write(
          path.posix.join("images", `message_${index}_${imageIndex}.${extensionByMime(decoded.mime)}`),
          decoded.bytes,
        );
        inputs.set(relative, sha256(decoded.bytes));
        const meta = sink.store({ base64: decoded.base64, mime: decoded.mime, kind: "image", name: relative });
        log.debug("message image written", { messageIndex: index, imageIndex, path: relative, mime: decoded.mime, size: decoded.bytes.byteLength, attachmentId: meta.id });
        imageIds.push(meta.id);
        imagePaths.push(relative);
        imageList.push({ path: relative, size: decoded.bytes.byteLength, messageIndex: index });
        imageParts.push({ type: "image", data: decoded.base64, mimeType: decoded.mime });
      }
      storedMessages.push({ role: message.role, content: message.content, ...(imageIds.length ? { images: imageIds } : {}) });

      if (message.role === "system") {
        if (message.content.trim()) extraInstructions.push(message.content.trim());
        log.debug("request message folded into instructions", { messageIndex: index, length: message.content.length });
        continue;
      }
      const text = [message.content, ...imagePaths.map((p) => `[attached image: ${p}]`)].filter(Boolean).join("\n\n");
      if (message.role === "assistant") {
        agentMessages.push(syntheticAssistantMessage(text, modelName));
        log.debug("request message added", { messageIndex: index, role: "assistant", length: text.length });
        continue;
      }
      const parts: (TextContent | ImageContent)[] = [
        ...(text ? [{ type: "text", text } as TextContent] : []),
        ...(vision ? imageParts : []),
      ];
      const user: UserMessage = {
        role: "user",
        content: parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts.length ? parts : "",
        timestamp: Date.now(),
      };
      agentMessages.push(user);
      log.debug("request message added", { messageIndex: index, role: "user", length: text.length, images: vision ? imageParts.length : 0, preview: preview(text, 120) });
    }
    if (!agentMessages.length || agentMessages[agentMessages.length - 1].role !== "user") {
      agentMessages.push({ role: "user", content: "Proceed with the task.", timestamp: Date.now() });
      log.debug("trailing user message appended (last request message was not from user)");
    }

    db.updateRequest(id, {
      messages: storedMessages,
      files: storedFiles,
      ...(format ? { format } : {}),
      model: modelName,
      ...(request.instructions ? { instructions: request.instructions } : {}),
    });
    log.debug("workspace ready", { files: fileList, images: imageList, workspace: workspace.root });

    // 2. Agent with the three tools.
    const provide = format ? createProvideAnswerTool(format, log) : null;
    const systemPrompt = await renderSystemPrompt({
      mode,
      workspace: workspace.root,
      files: fileList,
      images: imageList,
      schema: provide?.modelSchema,
      vision,
      instructions: extraInstructions.join("\n\n") || undefined,
    });
    log.debug("system prompt rendered", { length: systemPrompt.length, prompt: systemPrompt });
    const model = createOllamaModel(modelName, vision, ollamaOptions);
    const tools = [
      ...(provide ? [provide.tool] : []),
      createBashTool(workspace.root, log),
      createViewImageTool(workspace, vision, log),
    ];
    log.debug("agent created", { tools: tools.map((tool) => tool.name), model: model.id, host: model.baseUrl, input: model.input });

    let maxTurnsHit = false;
    let timedOut = false;

    const agent = new Agent({
      initialState: {
        systemPrompt,
        model,
        thinkingLevel: "off",
        tools,
      },
      streamFn: createOllamaStreamFn(
        { ...ollamaOptions, ...(provide ? { toolParameters: { [PROVIDE_ANSWER_TOOL]: provide.modelSchema } } : {}) },
        log,
      ),
      toolExecution: "sequential",
      beforeToolCall: async ({ toolCall }) => {
        if (provide?.hasAnswer) {
          log.debug("tool call blocked: answer already accepted", { tool: toolCall.name, toolCallId: toolCall.id });
          return { block: true, reason: "The answer was already accepted.", terminate: true };
        }
        return undefined;
      },
      finishTurn: async ({ message, toolResults }) => {
        const assistant = message as AssistantMessage;
        log.debug("turn finished", {
          turn: turns,
          stopReason: assistant.stopReason,
          toolCalls: assistant.content.filter((part): part is ToolCall => part.type === "toolCall").map((part) => part.name),
          toolResults: toolResults.map((result) => ({ tool: result.toolName, isError: result.isError })),
          text: preview(assistantText(assistant)),
          usage: assistant.usage ? { input: assistant.usage.input, output: assistant.usage.output } : undefined,
          durationMs: assistant.durationMs,
          ...(assistant.errorMessage ? { errorMessage: assistant.errorMessage } : {}),
        });
        if (provide?.hasAnswer) {
          log.debug("ending run: answer accepted");
          return { action: "end" };
        }
        if (turns >= CONFIG.MAX_TURNS) {
          maxTurnsHit = true;
          log.warn("ending run: MAX_TURNS reached", { turns, maxTurns: CONFIG.MAX_TURNS });
          return { action: "end" };
        }
        return undefined;
      },
    });

    agent.subscribe((event) => {
      if (event.type === "turn_start") {
        turns += 1;
        log.debug("turn start", { turn: turns, attempt: attempts, transcriptMessages: agent.state.messages.length });
      }
      if (event.type === "tool_execution_start") {
        log.info("tool call", { tool: event.toolName, toolCallId: event.toolCallId, args: event.args, turn: turns });
      }
      if (event.type === "tool_execution_end") {
        const result = event.result as { content?: { type: string; text?: string }[]; details?: unknown } | undefined;
        const text = result?.content?.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n") ?? "";
        const images = result?.content?.filter((part) => part.type === "image").length ?? 0;
        log.info("tool result", {
          tool: event.toolName,
          toolCallId: event.toolCallId,
          isError: event.isError,
          durationMs: event.durationMs,
          textLength: text.length,
          images,
          preview: preview(text, 300),
          details: result?.details,
        });
      }
      if (event.type === "turn_end") {
        transcript = snapshot(agent.state.messages);
        db.updateProgress(id, { messages: transcript, attempts, turns });
        log.debug("progress saved", { turn: turns, transcriptMessages: transcript.length });
      }
    });

    const timer = setTimeout(() => {
      timedOut = true;
      log.warn("inference timeout, aborting agent", { timeoutMs: CONFIG.INFERENCE_TIMEOUT_MS, attempts, turns });
      agent.abort();
    }, CONFIG.INFERENCE_TIMEOUT_MS);

    // 3. Attempt loop: re-prompt on the same conversation until provide_answer is called.
    let nextPrompt: AgentMessage[] = agentMessages;
    let failuresSeen = 0;
    let fatal: InferenceError | null = null;
    try {
      while (attempts < CONFIG.MAX_ATTEMPTS) {
        attempts += 1;
        const attemptStarted = Date.now();
        log.info("attempt start", { attempt: attempts, maxAttempts: CONFIG.MAX_ATTEMPTS, promptMessages: nextPrompt.length, turnsSoFar: turns });
        await agent.prompt(nextPrompt);
        const last = lastAssistant(agent.state.messages);
        log.debug("attempt end", {
          attempt: attempts,
          durationMs: since(attemptStarted),
          turns,
          hasAnswer: provide ? provide.hasAnswer : hasTextAnswer(last),
          lastStopReason: last?.stopReason,
          agentError: agent.state.errorMessage,
        });
        if (provide ? provide.hasAnswer : hasTextAnswer(last)) break;

        if (timedOut) {
          fatal = { code: "timeout", message: `Inference exceeded ${CONFIG.INFERENCE_TIMEOUT_MS} ms`, details };
          break;
        }
        if (last?.stopReason === "error" || agent.state.errorMessage) {
          fatal = {
            code: "provider_error",
            message: last?.errorMessage ?? agent.state.errorMessage ?? "Model request failed",
            details,
          };
          log.error("provider error", undefined, { message: fatal.message, attempt: attempts, turn: turns });
          break;
        }
        if (maxTurnsHit || last?.stopReason === "aborted") {
          fatal = { code: "max_turns", message: `Agent exceeded ${CONFIG.MAX_TURNS} turns without a valid answer`, details };
          break;
        }

        if (!provide) {
          details.push(`attempt ${attempts}: model finished without a text answer`);
          log.warn("retry: empty text answer", { attempt: attempts, lastStopReason: last?.stopReason });
          nextPrompt = [{ role: "user", content: TEXT_RETRY_MESSAGE, timestamp: Date.now() }];
          continue;
        }
        const newFailures = provide.failures.slice(failuresSeen);
        failuresSeen = provide.failures.length;
        const reason = newFailures.length
          ? `${PROVIDE_ANSWER_TOOL} rejected: ${newFailures[newFailures.length - 1]}`
          : last && assistantText(last).trim()
            ? `model replied with text instead of calling ${PROVIDE_ANSWER_TOOL}: ${preview(assistantText(last), 160)}`
            : `model did not call ${PROVIDE_ANSWER_TOOL}`;
        details.push(`attempt ${attempts}: ${reason}`);
        log.warn("retry: provide_answer not accepted", { attempt: attempts, reason, validationFailures: newFailures });
        nextPrompt = [{ role: "user", content: RETRY_MESSAGE, timestamp: Date.now() }];
      }
    } finally {
      clearTimeout(timer);
    }

    // 4. Files produced by the agent.
    const outputs = await workspace.collectOutputs(inputs);
    for (const output of outputs) {
      const meta = db.addAttachment({
        inferenceId: id,
        kind: "output",
        name: output.path,
        mime: guessFileMime(output.path, output.bytes),
        sha256: output.sha256,
        data: output.bytes,
      });
      log.debug("output file stored", { path: output.path, size: output.bytes.byteLength, mime: meta.mime, attachmentId: meta.id });
    }
    log.debug("outputs collected", { count: outputs.length });
    transcript = snapshot(agent.state.messages);

    const finalAssistant = lastAssistant(agent.state.messages);
    if (provide ? provide.hasAnswer : hasTextAnswer(finalAssistant)) {
      return finish({
        status: "success",
        data: provide ? provide.answer : assistantText(finalAssistant!).trim(),
        model: modelName,
        attempts,
        turns,
        durationMs: since(started),
      });
    }
    if (fatal) return fail(fatal);
    return fail(
      provide
        ? {
            code: "schema_mismatch",
            message: `Model failed to call ${PROVIDE_ANSWER_TOOL} with a valid answer after ${attempts} attempts`,
            details,
          }
        : {
            code: "empty_answer",
            message: `Model produced no text answer after ${attempts} attempts`,
            details,
          },
    );
  } catch (error) {
    log.error("internal error", error, { attempts, turns, durationMs: since(started) });
    return fail({
      code: "internal_error",
      message: error instanceof Error ? error.message : String(error),
      details,
    });
  } finally {
    await workspace.reset().catch((error) => log.error("workspace cleanup failed", error));
    log.debug("workspace cleared", { durationMs: since(started) });
  }
};

const lastAssistant = (messages: readonly AgentMessage[]): AssistantMessage | undefined => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "assistant") return message as AssistantMessage;
  }
  return undefined;
};

/** Text mode succeeds when the last assistant message ended normally with non-empty text. */
const hasTextAnswer = (message: AssistantMessage | undefined): boolean =>
  !!message && message.stopReason === "stop" && assistantText(message).trim().length > 0;

const assistantText = (message: AssistantMessage): string =>
  message.content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("\n");

const syntheticAssistantMessage = (text: string, modelName: string): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: OLLAMA_API,
  provider: OLLAMA_PROVIDER,
  model: modelName,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "stop",
  timestamp: Date.now(),
});
