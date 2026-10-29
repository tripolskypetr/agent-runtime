import path from "path";
import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ImageContent, TextContent, UserMessage } from "@earendil-works/pi-ai";

import { CONFIG } from "../config.js";
import type { Database } from "../db/database.js";
import { createImageSink, externalizeImages } from "../helpers/history.js";
import { decodeImage, extensionByMime, guessFileMime, sha256, stripDataUrl } from "../helpers/images.js";
import type { InferenceError, InferenceRequest, StoredRequest } from "../model/Inference.model.js";
import { createOllamaModel, createOllamaStreamFn, defaultOllamaOptions, OLLAMA_API, OLLAMA_PROVIDER } from "./ollama.js";
import { renderSystemPrompt, RETRY_MESSAGE } from "./systemPrompt.js";
import { createBashTool } from "./tools/bash.tool.js";
import { createProvideAnswerTool, PROVIDE_ANSWER_TOOL } from "./tools/provideAnswer.tool.js";
import { createViewImageTool } from "./tools/viewImage.tool.js";
import { Workspace } from "./workspace.js";

export interface RunContext {
  id: string;
  db: Database;
  workspace: Workspace;
  log: (message: string, data?: unknown) => void;
}

export interface InferenceOutcome {
  status: "success" | "error";
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
export const runInference = async (request: InferenceRequest, ctx: RunContext): Promise<InferenceOutcome> => {
  const { id, db, workspace, log } = ctx;
  const started = Date.now();
  const modelName = request.model?.trim() || CONFIG.OLLAMA_MODEL;
  const vision = CONFIG.OLLAMA_VISION;
  const ollamaOptions = defaultOllamaOptions();

  let attempts = 0;
  let turns = 0;
  const details: string[] = [];

  const sink = createImageSink((input) => db.addAttachment({ inferenceId: id, ...input }));
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
    return outcome;
  };
  const fail = (error: InferenceError): InferenceOutcome =>
    finish({ status: "error", error, model: modelName, attempts, turns, durationMs: Date.now() - started });

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
        imageIds.push(meta.id);
        imagePaths.push(relative);
        imageList.push({ path: relative, size: decoded.bytes.byteLength, messageIndex: index });
        imageParts.push({ type: "image", data: decoded.base64, mimeType: decoded.mime });
      }
      storedMessages.push({ role: message.role, content: message.content, ...(imageIds.length ? { images: imageIds } : {}) });

      if (message.role === "system") {
        if (message.content.trim()) extraInstructions.push(message.content.trim());
        continue;
      }
      const text = [message.content, ...imagePaths.map((p) => `[attached image: ${p}]`)].filter(Boolean).join("\n\n");
      if (message.role === "assistant") {
        agentMessages.push(syntheticAssistantMessage(text, modelName));
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
    }
    if (!agentMessages.length || agentMessages[agentMessages.length - 1].role !== "user") {
      agentMessages.push({ role: "user", content: "Proceed with the task.", timestamp: Date.now() });
    }

    db.updateRequest(id, {
      messages: storedMessages,
      files: storedFiles,
      format: request.format,
      model: modelName,
      ...(request.instructions ? { instructions: request.instructions } : {}),
    });

    // 2. Agent with the three tools.
    const systemPrompt = await renderSystemPrompt({
      workspace: workspace.root,
      files: fileList,
      images: imageList,
      schema: request.format,
      vision,
      instructions: extraInstructions.join("\n\n") || undefined,
    });
    const provide = createProvideAnswerTool(request.format);
    const model = createOllamaModel(modelName, vision, ollamaOptions);

    let maxTurnsHit = false;
    let timedOut = false;

    const agent = new Agent({
      initialState: {
        systemPrompt,
        model,
        thinkingLevel: "off",
        tools: [provide.tool, createBashTool(workspace.root), createViewImageTool(workspace, vision)],
      },
      streamFn: createOllamaStreamFn(ollamaOptions),
      toolExecution: "sequential",
      beforeToolCall: async () => {
        if (provide.hasAnswer) {
          return { block: true, reason: "The answer was already accepted.", terminate: true };
        }
        return undefined;
      },
      finishTurn: async () => {
        if (provide.hasAnswer) return { action: "end" };
        if (turns >= CONFIG.MAX_TURNS) {
          maxTurnsHit = true;
          return { action: "end" };
        }
        return undefined;
      },
    });

    agent.subscribe((event) => {
      if (event.type === "turn_start") {
        turns += 1;
      }
      if (event.type === "tool_execution_start") {
        log(`tool ${event.toolName}`, event.toolName === PROVIDE_ANSWER_TOOL ? undefined : event.args);
      }
      if (event.type === "turn_end") {
        transcript = snapshot(agent.state.messages);
        db.updateProgress(id, { messages: transcript, attempts, turns });
      }
    });

    const timer = setTimeout(() => {
      timedOut = true;
      agent.abort();
    }, CONFIG.INFERENCE_TIMEOUT_MS);

    // 3. Attempt loop: re-prompt on the same conversation until provide_answer is called.
    let nextPrompt: AgentMessage[] = agentMessages;
    let failuresSeen = 0;
    let fatal: InferenceError | null = null;
    try {
      while (attempts < CONFIG.MAX_ATTEMPTS) {
        attempts += 1;
        log(`attempt ${attempts}/${CONFIG.MAX_ATTEMPTS}`);
        await agent.prompt(nextPrompt);
        if (provide.hasAnswer) break;

        const last = lastAssistant(agent.state.messages);
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
          break;
        }
        if (maxTurnsHit || last?.stopReason === "aborted") {
          fatal = { code: "max_turns", message: `Agent exceeded ${CONFIG.MAX_TURNS} turns without a valid answer`, details };
          break;
        }

        const newFailures = provide.failures.slice(failuresSeen);
        failuresSeen = provide.failures.length;
        const reason = newFailures.length
          ? `${PROVIDE_ANSWER_TOOL} rejected: ${newFailures[newFailures.length - 1]}`
          : last && assistantText(last).trim()
            ? `model replied with text instead of calling ${PROVIDE_ANSWER_TOOL}: ${preview(assistantText(last))}`
            : `model did not call ${PROVIDE_ANSWER_TOOL}`;
        details.push(`attempt ${attempts}: ${reason}`);
        log(details[details.length - 1]);
        nextPrompt = [{ role: "user", content: RETRY_MESSAGE, timestamp: Date.now() }];
      }
    } finally {
      clearTimeout(timer);
    }

    // 4. Files produced by the agent.
    for (const output of await workspace.collectOutputs(inputs)) {
      db.addAttachment({
        inferenceId: id,
        kind: "output",
        name: output.path,
        mime: guessFileMime(output.path, output.bytes),
        sha256: output.sha256,
        data: output.bytes,
      });
    }
    transcript = snapshot(agent.state.messages);

    if (provide.hasAnswer) {
      return finish({
        status: "success",
        data: provide.answer,
        model: modelName,
        attempts,
        turns,
        durationMs: Date.now() - started,
      });
    }
    if (fatal) return fail(fatal);
    return fail({
      code: "schema_mismatch",
      message: `Model failed to call ${PROVIDE_ANSWER_TOOL} with a valid answer after ${attempts} attempts`,
      details,
    });
  } catch (error) {
    log("internal error", error);
    return fail({
      code: "internal_error",
      message: error instanceof Error ? error.message : String(error),
      details,
    });
  } finally {
    await workspace.reset().catch(() => undefined);
  }
};

const lastAssistant = (messages: readonly AgentMessage[]): AssistantMessage | undefined => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "assistant") return message as AssistantMessage;
  }
  return undefined;
};

const assistantText = (message: AssistantMessage): string =>
  message.content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("\n");

const preview = (text: string, max = 160) => (text.length > max ? `${text.slice(0, max)}…` : text).replace(/\s+/g, " ");

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
