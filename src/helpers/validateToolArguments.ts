/**
 * Schema validator for provide_answer arguments.
 * Copied from json-inference/src/helpers/validateToolArguments.ts so the
 * harness accepts exactly the same FormatModel schemas as generateObject().
 */
import type { FormatModel } from "../model/Format.model.js";

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

export const validateValue = (value: unknown, schema: any, path: string): string | null => {
  if (!schema || typeof schema !== "object" || !schema.type) {
    return null;
  }
  switch (schema.type) {
    case "string": {
      if (typeof value !== "string") {
        return `${path}: expected string, got ${typeOf(value)}`;
      }
      if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
        return `${path}: expected one of [${schema.enum.join(", ")}], got "${value}"`;
      }
      return null;
    }
    case "number": {
      if (typeof value !== "number" || Number.isNaN(value)) {
        return `${path}: expected number, got ${typeOf(value)}`;
      }
      return null;
    }
    case "integer": {
      if (typeof value !== "number" || !Number.isInteger(value)) {
        return `${path}: expected integer, got ${typeOf(value)}`;
      }
      return null;
    }
    case "boolean": {
      if (typeof value !== "boolean") {
        return `${path}: expected boolean, got ${typeOf(value)}`;
      }
      return null;
    }
    case "array": {
      if (!Array.isArray(value)) {
        return `${path}: expected array, got ${typeOf(value)}`;
      }
      if (typeof schema.minItems === "number" && value.length < schema.minItems) {
        return `${path}: expected at least ${schema.minItems} items, got ${value.length}`;
      }
      if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
        return `${path}: expected at most ${schema.maxItems} items, got ${value.length}`;
      }
      if (schema.items) {
        for (let i = 0; i !== value.length; i++) {
          const error = validateValue(value[i], schema.items, `${path}[${i}]`);
          if (error) {
            return error;
          }
        }
      }
      return null;
    }
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return `${path}: expected object, got ${typeOf(value)}`;
      }
      const valueObj = value as Record<string, unknown>;
      if (Array.isArray(schema.required)) {
        const missingFields = schema.required.filter((field: string) => !(field in valueObj));
        if (missingFields.length > 0) {
          return `${path}: missing required fields: ${missingFields.join(", ")}`;
        }
      }
      if (schema.properties && typeof schema.properties === "object") {
        for (const [key, propertySchema] of Object.entries(schema.properties)) {
          if (!(key in valueObj)) {
            continue;
          }
          const error = validateValue(valueObj[key], propertySchema, `${path}.${key}`);
          if (error) {
            return error;
          }
        }
      }
      return null;
    }
    default:
      return null;
  }
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
  if (schema?.required?.length) {
    const argumentsObj = parsedArguments as Record<string, any>;
    const missingFields = schema.required.filter((field: string) => !(field in argumentsObj));
    if (missingFields.length > 0) {
      return { success: false, error: `Missing required fields: ${missingFields.join(", ")}` };
    }
  }
  if (schema?.properties) {
    const argumentsObj = parsedArguments as Record<string, unknown>;
    for (const [key, propertySchema] of Object.entries(schema.properties)) {
      if (!(key in argumentsObj)) {
        continue;
      }
      const error = validateValue(argumentsObj[key], propertySchema, key);
      if (error) {
        return { success: false, error: `Invalid arguments: ${error}` };
      }
    }
  }
  return { success: true, data: parsedArguments as T };
};

export default validateToolArguments;
