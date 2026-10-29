/**
 * JSON-schema subset accepted as the `format` of an inference request.
 * Mirrors FormatModel from json-inference so schemas written for
 * generateObject() can be passed through unchanged.
 */
export type FormatItems =
  | { type: "string"; description?: string; enum?: string[] }
  | { type: "number"; description?: string }
  | { type: "integer"; description?: string }
  | { type: "boolean"; description?: string }
  | { type: "array"; description?: string; items?: FormatItems; minItems?: number; maxItems?: number }
  | { type: "object"; description?: string; required?: string[]; properties?: { [key: string]: FormatProperty } };

export type FormatProperty =
  | { type: "string"; description: string; enum?: string[] }
  | { type: "number"; description: string }
  | { type: "integer"; description: string }
  | { type: "boolean"; description: string }
  | { type: "array"; description: string; items?: FormatItems; minItems?: number; maxItems?: number }
  | { type: "object"; description: string; required?: string[]; properties?: { [key: string]: FormatProperty } };

export interface FormatModel {
  type: string;
  required: string[];
  properties: {
    [key: string]: FormatProperty;
  };
}

export default FormatModel;
