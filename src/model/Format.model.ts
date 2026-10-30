/**
 * The `format` of an inference request: a JSON Schema (draft 2020-12) whose
 * top level is an object. json-inference's FormatModel is a subset, so schemas
 * written for generateObject() keep working. Validation is done by ajv, so any
 * keyword ajv understands is enforced: oneOf/anyOf/allOf/not, const, enum,
 * if/then/else, local $ref into $defs, additionalProperties, pattern,
 * minLength/maxLength, minimum/maximum, nullable types, ...
 */
export type JsonSchemaType = "string" | "number" | "integer" | "boolean" | "array" | "object" | "null";

export interface JsonSchema {
  type?: JsonSchemaType | JsonSchemaType[];
  description?: string;
  title?: string;
  enum?: unknown[];
  const?: unknown;
  properties?: { [key: string]: JsonSchema };
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  allOf?: JsonSchema[];
  not?: JsonSchema;
  if?: JsonSchema;
  then?: JsonSchema;
  else?: JsonSchema;
  $ref?: string;
  $defs?: { [key: string]: JsonSchema };
  [keyword: string]: unknown;
}

/** Kept for compatibility with code written against the json-inference subset. */
export type FormatItems = JsonSchema;
export type FormatProperty = JsonSchema;

export interface FormatModel extends JsonSchema {
  type: "object";
  required: string[];
  properties: { [key: string]: JsonSchema };
}

export default FormatModel;
