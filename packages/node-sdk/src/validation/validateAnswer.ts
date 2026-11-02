import type { FormatModel, InferFormat } from "../model/Format.model.js";
import { validateToolArguments, type ValidationResult } from "./validateToolArguments.js";

/**
 * Typed wrapper of the shared validator: checks an answer (from the server, a
 * cache on disk, anywhere) against its schema and narrows it to `InferFormat<F>`.
 *
 * ```ts
 * const cached = JSON.parse(await fs.readFile("answer.json", "utf-8"));
 * const result = validateAnswer(cached, Agent1Format);
 * if (result.success) result.data.verdict; // typed
 * else console.log(result.error);         // "Invalid arguments: signal.direction: must be exactly \"long\""
 * ```
 */
export const validateAnswer = <const F extends FormatModel>(value: unknown, format: F): ValidationResult<InferFormat<F>> =>
  validateToolArguments<InferFormat<F>>(value, format);

/** Throws when the answer does not match the schema; returns it typed otherwise. */
export const assertAnswer = <const F extends FormatModel>(value: unknown, format: F): InferFormat<F> => {
  const result = validateAnswer(value, format);
  if (!result.success) throw new Error(result.error ?? "Invalid answer");
  return result.data as InferFormat<F>;
};
