/**
 * JSON Schema (draft 2020-12) support for `format`: compilation with ajv,
 * readable error messages for the model, and the trimmed "model-facing" copy
 * of a schema that goes into the provide_answer tool and the system prompt.
 */
import { createHash } from "crypto";
import Ajv2020Module, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

// ajv and ajv-formats are CommonJS with `export default`; under Node ESM the default import is the
// class/function itself, while TypeScript (nodenext) types it as the module namespace. Normalize both.
type Ajv2020Class = typeof Ajv2020Module.default;
const Ajv2020: Ajv2020Class = (Ajv2020Module as unknown as { default?: Ajv2020Class }).default ?? (Ajv2020Module as unknown as Ajv2020Class);
type AddFormats = typeof addFormatsModule.default;
const addFormats: AddFormats = (addFormatsModule as unknown as { default?: AddFormats }).default ?? (addFormatsModule as unknown as AddFormats);

import { CONFIG } from "../config.js";
import { getLogger } from "../lib/logger.js";

const log = getLogger("schema");

/** Keywords that only matter to humans or to external tooling; never sent to the model. */
const META_KEYWORDS = ["$schema", "$id", "title", "examples", "$comment", "default", "deprecated", "readOnly", "writeOnly"];

/** Max lines of validation feedback returned to the model per rejected call. */
const MAX_ERROR_LINES = 5;

const ajv = new Ajv2020({
  strict: false,
  strictSchema: "log",
  allErrors: true,
  allowUnionTypes: true,
  logger: {
    log: (...args: unknown[]) => log.debug("ajv", { args }),
    warn: (...args: unknown[]) => log.warn("ajv warning (unknown keyword or strict-mode issue)", { args }),
    error: (...args: unknown[]) => log.error("ajv", undefined, { args }),
  },
});
addFormats(ajv);

export interface CompiledFormat {
  validate: ValidateFunction;
  sha256: string;
}

const cache = new Map<string, CompiledFormat>();

export class InvalidFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidFormatError";
  }
}

/**
 * Compiles a `format` schema once per process (keyed by its content hash).
 * `$id` and `$schema` are dropped before compilation: only local `#/$defs/...`
 * references are supported, so an absolute id would only make ajv try to
 * resolve remote documents. Throws InvalidFormatError on a broken schema
 * (unresolvable `$ref`, wrong keyword value, ...).
 */
export const compileFormat = (schema: Record<string, unknown>): CompiledFormat => {
  const sha256 = createHash("sha256").update(JSON.stringify(schema)).digest("hex");
  const cached = cache.get(sha256);
  if (cached) return cached;
  const { $id: _id, $schema: _schema, ...rest } = schema;
  let validate: ValidateFunction;
  try {
    validate = ajv.compile(rest);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn("format rejected", { sha256, message });
    throw new InvalidFormatError(`Invalid format schema: ${message}`);
  }
  const compiled = { validate, sha256 };
  cache.set(sha256, compiled);
  log.info("format compiled", { sha256, cached: cache.size, ...describeFormat(schema) });
  return compiled;
};

/** Summary of a schema for logs: which advanced keywords it uses. */
export const describeFormat = (schema: Record<string, unknown>) => {
  const text = JSON.stringify(schema);
  return {
    required: Array.isArray(schema.required) ? schema.required : [],
    properties: schema.properties && typeof schema.properties === "object" ? Object.keys(schema.properties as object) : [],
    defs: schema.$defs && typeof schema.$defs === "object" ? Object.keys(schema.$defs as object) : [],
    hasOneOf: text.includes('"oneOf"'),
    hasAnyOf: text.includes('"anyOf"'),
    hasAllOf: text.includes('"allOf"'),
    hasRef: text.includes('"$ref"'),
    hasIf: text.includes('"if"'),
    hasConst: text.includes('"const"'),
    bytes: text.length,
  };
};

const pathOf = (error: ErrorObject): string => {
  if (!error.instancePath) return "answer";
  return error.instancePath
    .split("/")
    .slice(1)
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce((acc, segment) => (/^\d+$/.test(segment) ? `${acc}[${segment}]` : acc ? `${acc}.${segment}` : segment), "");
};

const detailOf = (error: ErrorObject): string => {
  const p = error.params as Record<string, unknown>;
  switch (error.keyword) {
    case "enum":
      return `must be one of ${JSON.stringify(p.allowedValues)}`;
    case "const":
      return `must be exactly ${JSON.stringify(p.allowedValue)}`;
    case "additionalProperties":
      return `has unexpected property "${p.additionalProperty}"`;
    case "required":
      return `is missing required property "${p.missingProperty}"`;
    case "pattern":
      return `must match pattern ${p.pattern}`;
    case "type":
      return `must be ${Array.isArray(p.type) ? (p.type as string[]).join(" or ") : p.type}`;
    case "oneOf":
      return "must match exactly one of the allowed shapes";
    case "anyOf":
      return "must match at least one of the allowed shapes";
    case "if":
      return `does not satisfy the "${p.failingKeyword}" branch of a conditional rule`;
    default:
      return error.message ?? error.keyword;
  }
};

/**
 * Turns ajv errors into a few readable lines with dotted paths, e.g.
 * `signal.direction: must be exactly "long"`. Deeper paths come first: when a
 * `oneOf` fails, ajv also reports every other branch's complaints at the
 * branch root (missing `all`, unexpected `feature`, ...), while the real
 * mistake is usually the most specific one. The list is capped so a retry
 * does not bloat the prompt.
 */
export const formatErrors = (errors: ErrorObject[] | null | undefined): string => {
  if (!errors?.length) return "does not match the schema";
  const depth = (error: ErrorObject) => error.instancePath.split("/").length;
  const ordered = [...errors]
    .filter((error) => error.keyword !== "if") // the then/else errors are listed separately with their own paths
    .sort((a, b) => depth(b) - depth(a) || Number(isCombinator(a)) - Number(isCombinator(b)));
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const error of ordered) {
    const line = `${pathOf(error)}: ${detailOf(error)}`;
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  const shown = lines.slice(0, MAX_ERROR_LINES);
  if (lines.length > shown.length) shown.push(`…and ${lines.length - shown.length} more`);
  return shown.join("; ");
};

const isCombinator = (error: ErrorObject) => error.keyword === "oneOf" || error.keyword === "anyOf";

/* ------------------------------------------------------------------ model-facing schema */

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);

const resolveLocalRef = (root: Json, ref: string): { name: string; schema: Json } | null => {
  const match = /^#\/\$defs\/([^/]+)$/.exec(ref);
  if (!match) return null;
  const defs = root.$defs;
  const target = isObject(defs) ? defs[match[1]] : undefined;
  return isObject(target) ? { name: match[1], schema: target } : null;
};

/**
 * The copy of `format` that the model sees as tool parameters and in the
 * prompt. Meta keywords are removed; local `$ref`s into `$defs` are inlined
 * up to `depth` levels (MODEL_SCHEMA_REF_DEPTH), deeper ones are replaced by
 * a short description, and `$defs` itself is dropped. With depth 0 the schema
 * is passed through untouched (except the meta keywords), i.e. the model gets
 * `$ref` and `$defs` as written. Validation always uses the original schema.
 */
export const toModelSchema = (schema: Json, depth = CONFIG.MODEL_SCHEMA_REF_DEPTH): Json => {
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip);
    if (!isObject(value)) return value;
    const out: Json = {};
    for (const [key, item] of Object.entries(value)) {
      if (META_KEYWORDS.includes(key)) continue;
      out[key] = strip(item);
    }
    return out;
  };
  if (depth <= 0) return strip(schema) as Json;

  const inline = (value: unknown, remaining: number, stack: string[]): unknown => {
    if (Array.isArray(value)) return value.map((item) => inline(item, remaining, stack));
    if (!isObject(value)) return value;
    if (typeof value.$ref === "string") {
      const resolved = resolveLocalRef(schema, value.$ref);
      if (!resolved) return value; // unknown ref shape: leave as is, validation already compiled it
      const { $ref: _ref, ...siblings } = value;
      if (remaining <= 0 || stack.includes(resolved.name)) {
        const description = typeof resolved.schema.description === "string" ? resolved.schema.description : `nested "${resolved.name}" of the same shape as above`;
        return { ...siblings, description };
      }
      const merged = { ...resolved.schema, ...siblings };
      return inline(merged, remaining - 1, [...stack, resolved.name]);
    }
    const out: Json = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === "$defs" || META_KEYWORDS.includes(key)) continue;
      out[key] = inline(item, remaining, stack);
    }
    return out;
  };
  return inline(schema, depth, []) as Json;
};
