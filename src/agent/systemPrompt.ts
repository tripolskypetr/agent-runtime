import { readFile, stat } from "fs/promises";
import Mustache from "mustache";

import { CONFIG } from "../config.js";
import { getLogger } from "../lib/logger.js";

const log = getLogger("systemPrompt");
import type { InferenceMode } from "../model/Inference.model.js";

export interface SystemPromptInput {
  mode: InferenceMode;
  workspace: string;
  files: { path: string; size: number }[];
  images: { path: string; size: number; messageIndex: number }[];
  /** Model-facing schema (see toModelSchema), already trimmed. */
  schema?: Record<string, unknown>;
  vision: boolean;
  instructions?: string;
}

const templateCache = new Map<string, { mtimeMs: number; template: string }>();

const loadTemplate = async (filePath: string): Promise<string> => {
  const info = await stat(filePath);
  const cached = templateCache.get(filePath);
  if (cached && cached.mtimeMs === info.mtimeMs) {
    return cached.template;
  }
  const template = await readFile(filePath, "utf-8");
  templateCache.set(filePath, { mtimeMs: info.mtimeMs, template });
  log.info(cached ? "template reloaded (file changed)" : "template loaded", { path: filePath, length: template.length, mtime: new Date(info.mtimeMs).toISOString() });
  return template;
};

/** Renders assets/system.mustache (object mode) or assets/system-text.mustache (text mode); templates are re-read when the files change. */
export const renderSystemPrompt = async (input: SystemPromptInput): Promise<string> => {
  const template = await loadTemplate(input.mode === "text" ? CONFIG.SYSTEM_PROMPT_TEXT_PATH : CONFIG.SYSTEM_PROMPT_PATH);
  return Mustache.render(template, {
    ...input,
    schema: input.schema ? JSON.stringify(input.schema, null, 2) : null,
    instructions: input.instructions?.trim() || null,
  }).trim();
};

/** Message appended when the model replied with text instead of calling provide_answer (json-inference behaviour). */
export const RETRY_MESSAGE =
  "Your reply was not accepted: you must answer by calling the `provide_answer` tool with arguments that match the JSON schema. " +
  "Do not answer with plain text. Call `provide_answer` now.";

/** Message appended in text mode when the model finished without any text. */
export const TEXT_RETRY_MESSAGE =
  "Your reply was empty. Write the final answer now as a plain text message.";
