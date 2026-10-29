import { readFile } from "fs/promises";
import Mustache from "mustache";

import { CONFIG } from "../config.js";
import type { FormatModel } from "../model/Format.model.js";

export interface SystemPromptInput {
  workspace: string;
  files: { path: string; size: number }[];
  images: { path: string; size: number; messageIndex: number }[];
  schema: FormatModel;
  vision: boolean;
  instructions?: string;
}

let templateCache: { path: string; mtimeMs: number; template: string } | null = null;

const loadTemplate = async (): Promise<string> => {
  const { stat } = await import("fs/promises");
  const info = await stat(CONFIG.SYSTEM_PROMPT_PATH);
  if (templateCache && templateCache.path === CONFIG.SYSTEM_PROMPT_PATH && templateCache.mtimeMs === info.mtimeMs) {
    return templateCache.template;
  }
  const template = await readFile(CONFIG.SYSTEM_PROMPT_PATH, "utf-8");
  templateCache = { path: CONFIG.SYSTEM_PROMPT_PATH, mtimeMs: info.mtimeMs, template };
  return template;
};

/** Renders assets/system.mustache; the template is re-read when the file changes. */
export const renderSystemPrompt = async (input: SystemPromptInput): Promise<string> => {
  const template = await loadTemplate();
  return Mustache.render(template, {
    ...input,
    schema: JSON.stringify(input.schema, null, 2),
    instructions: input.instructions?.trim() || null,
  }).trim();
};

/** Message appended when the model replied with text instead of calling provide_answer (json-inference behaviour). */
export const RETRY_MESSAGE =
  "Your reply was not accepted: you must answer by calling the `provide_answer` tool with arguments that match the JSON schema. " +
  "Do not answer with plain text. Call `provide_answer` now.";
