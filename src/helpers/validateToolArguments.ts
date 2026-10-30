/**
 * Validates provide_answer arguments against the request `format`.
 *
 * Same signature as json-inference's validateToolArguments, but the check is
 * done by ajv (JSON Schema draft 2020-12), so oneOf/anyOf/allOf, const,
 * if/then, $ref into $defs, additionalProperties, pattern, min/max* and
 * nullable types (`type: ["string", "null"]`) are all enforced. Errors are
 * rendered as short dotted-path lines the model can act on.
 */
import type { FormatModel } from "../model/Format.model.js";
import { compileFormat, formatErrors } from "./schema.js";

export interface ValidationResult<T = any> {
  success: boolean;
  data?: T;
  error?: string;
}

export const typeOf = (value: unknown): string => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
};

export const validateToolArguments = <T = any>(parsedArguments: unknown, schema: FormatModel): ValidationResult<T> => {
  if (parsedArguments == null) {
    if (schema?.required?.length) {
      return { success: false, error: "Tool call has empty arguments" };
    }
    return { success: true, data: {} as T };
  }
  if (typeof parsedArguments !== "object" || Array.isArray(parsedArguments)) {
    return { success: false, error: `Invalid arguments: expected object, got ${typeOf(parsedArguments)}` };
  }
  const { validate } = compileFormat(schema as unknown as Record<string, unknown>);
  if (!validate(parsedArguments)) {
    return { success: false, error: `Invalid arguments: ${formatErrors(validate.errors)}` };
  }
  return { success: true, data: parsedArguments as T };
};

export default validateToolArguments;
