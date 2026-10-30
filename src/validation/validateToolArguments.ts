/**
 * Answer validator shared by agent-runtime-sdk and the agent-runtime server.
 *
 * THIS FILE IS COPIED VERBATIM between packages/sdk/src/validation/ and src/validation/
 * (npm run test:schema fails when the copies diverge). It descends from
 * json-inference/src/helpers/validateToolArguments.ts and keeps its exports and
 * result shape, extended to the JSON Schema draft 2020-12 keywords the server
 * accepts: type as string or array (incl. "null"), enum/const of any JSON value,
 * oneOf/anyOf/allOf/not, if/then/else, local $ref (JSON pointer into the root,
 * e.g. #/$defs/predicate), additionalProperties, patternProperties, propertyNames,
 * dependentRequired/dependentSchemas, min/maxProperties, items/prefixItems/
 * contains/uniqueItems, min/maxItems, min/maxLength, pattern, minimum/maximum/
 * exclusiveMinimum/exclusiveMaximum/multipleOf. Unknown keywords and `format` are
 * ignored, so it is never stricter than the server's ajv check. No dependencies.
 *
 * One error is reported, as a dotted path from the root `answer`:
 *   signal.direction: must be exactly "long"
 *   claims[0].id: must match pattern ^c[0-9]{1,2}$
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

type SchemaNode = Record<string, any>;
type Schema = SchemaNode | boolean;

const ROOT_PATH = "answer";

const join = (path: string, key: string): string => (path === ROOT_PATH ? key : `${path}.${key}`);
const at = (path: string, i: number): string => `${path}[${i}]`;
const show = (value: unknown): string => JSON.stringify(value);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const codePoints = (text: string): number => Array.from(text).length;

/** Path depth of an error line, to pick the most specific branch error of a oneOf/anyOf. */
const depthOf = (error: string): number => (error.slice(0, error.indexOf(":")).match(/[.[]/g) ?? []).length;

const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => key in right && deepEqual(left[key], right[key]));
};

const matchesType = (value: unknown, type: string): boolean => {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return isObject(value);
    default:
      return true; // unknown type name: do not reject, the server decides
  }
};

const regexCache = new Map<string, RegExp | null>();
const toRegExp = (pattern: string): RegExp | null => {
  const cached = regexCache.get(pattern);
  if (cached !== undefined) return cached;
  let compiled: RegExp | null = null;
  try {
    compiled = new RegExp(pattern, "u");
  } catch {
    try {
      compiled = new RegExp(pattern);
    } catch {
      compiled = null;
    }
  }
  regexCache.set(pattern, compiled);
  return compiled;
};

/** Resolves a local JSON pointer reference (`#/$defs/name`, `#/properties/x`) against the root schema. */
export const resolveRef = (root: unknown, ref: string): Schema | undefined => {
  if (!ref.startsWith("#")) return undefined;
  const segments = ref
    .slice(1)
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => decodeURIComponent(segment).replace(/~1/g, "/").replace(/~0/g, "~"));
  let node: unknown = root;
  for (const segment of segments) {
    if (!node || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node === undefined ? undefined : (node as Schema);
};

/**
 * Validates `value` against `schema`; returns the first problem as `path: message`
 * or null. `root` is the schema that `$ref`s are resolved against (defaults to `schema`).
 */
export const validateValue = (value: unknown, schema: any, path: string, root: any = schema): string | null => {
  if (schema === true || schema === undefined || schema === null) return null;
  if (schema === false) return `${path}: is not allowed`;
  if (typeof schema !== "object") return null;
  const node = schema as SchemaNode;

  if (typeof node.$ref === "string") {
    const target = resolveRef(root, node.$ref);
    if (target === undefined) return `${path}: schema error, unresolvable $ref ${node.$ref}`;
    const error = validateValue(value, target, path, root);
    if (error) return error;
  }

  if (node.type !== undefined) {
    const types: string[] = Array.isArray(node.type) ? node.type : [node.type];
    if (!types.some((type) => matchesType(value, type))) {
      return `${path}: must be ${types.join(" or ")}, got ${typeOf(value)}`;
    }
  }
  if ("const" in node && !deepEqual(value, node.const)) return `${path}: must be exactly ${show(node.const)}`;
  if (Array.isArray(node.enum) && !node.enum.some((item: unknown) => deepEqual(value, item))) return `${path}: must be one of ${show(node.enum)}`;

  if (typeof value === "string") {
    if (typeof node.minLength === "number" && codePoints(value) < node.minLength) return `${path}: must NOT have fewer than ${node.minLength} characters`;
    if (typeof node.maxLength === "number" && codePoints(value) > node.maxLength) return `${path}: must NOT have more than ${node.maxLength} characters`;
    if (typeof node.pattern === "string") {
      const regex = toRegExp(node.pattern);
      if (regex && !regex.test(value)) return `${path}: must match pattern ${node.pattern}`;
    }
  }

  if (typeof value === "number") {
    if (typeof node.minimum === "number" && value < node.minimum) return `${path}: must be >= ${node.minimum}`;
    if (typeof node.maximum === "number" && value > node.maximum) return `${path}: must be <= ${node.maximum}`;
    if (typeof node.exclusiveMinimum === "number" && value <= node.exclusiveMinimum) return `${path}: must be > ${node.exclusiveMinimum}`;
    if (typeof node.exclusiveMaximum === "number" && value >= node.exclusiveMaximum) return `${path}: must be < ${node.exclusiveMaximum}`;
    if (typeof node.multipleOf === "number" && node.multipleOf > 0) {
      const ratio = value / node.multipleOf;
      if (!Number.isFinite(ratio) || ratio !== Math.trunc(ratio)) return `${path}: must be multiple of ${node.multipleOf}`;
    }
  }

  if (Array.isArray(value)) {
    if (typeof node.minItems === "number" && value.length < node.minItems) return `${path}: must NOT have fewer than ${node.minItems} items`;
    if (typeof node.maxItems === "number" && value.length > node.maxItems) return `${path}: must NOT have more than ${node.maxItems} items`;
    if (node.uniqueItems === true) {
      for (let i = 0; i < value.length; i++) {
        for (let j = i + 1; j < value.length; j++) {
          if (deepEqual(value[i], value[j])) return `${path}: must NOT have duplicate items (items ${i} and ${j} are identical)`;
        }
      }
    }
    const prefix: Schema[] = Array.isArray(node.prefixItems) ? node.prefixItems : [];
    for (let i = 0; i < Math.min(prefix.length, value.length); i++) {
      const error = validateValue(value[i], prefix[i], at(path, i), root);
      if (error) return error;
    }
    if (node.items !== undefined) {
      for (let i = prefix.length; i < value.length; i++) {
        const error = validateValue(value[i], node.items, at(path, i), root);
        if (error) return error;
      }
    }
    if (node.contains !== undefined) {
      const matches = value.filter((item) => validateValue(item, node.contains, path, root) === null).length;
      const min = typeof node.minContains === "number" ? node.minContains : 1;
      if (matches < min) return `${path}: must contain at least ${min} valid item(s)`;
      if (typeof node.maxContains === "number" && matches > node.maxContains) return `${path}: must contain at most ${node.maxContains} valid item(s)`;
    }
  }

  if (isObject(value)) {
    if (Array.isArray(node.required)) {
      const missing = node.required.filter((key: string) => !(key in value));
      if (missing.length === 1) return `${path}: is missing required property ${show(missing[0])}`;
      if (missing.length > 1) return `${path}: is missing required properties ${missing.map(show).join(", ")}`;
    }
    if (typeof node.minProperties === "number" && Object.keys(value).length < node.minProperties) return `${path}: must NOT have fewer than ${node.minProperties} properties`;
    if (typeof node.maxProperties === "number" && Object.keys(value).length > node.maxProperties) return `${path}: must NOT have more than ${node.maxProperties} properties`;
    const properties: Record<string, Schema> = isObject(node.properties) ? (node.properties as Record<string, Schema>) : {};
    const patterns: [RegExp, Schema][] = isObject(node.patternProperties)
      ? Object.entries(node.patternProperties as Record<string, Schema>).flatMap(([pattern, sub]) => {
          const regex = toRegExp(pattern);
          return regex ? [[regex, sub] as [RegExp, Schema]] : [];
        })
      : [];
    for (const [key, item] of Object.entries(value)) {
      let covered = false;
      if (key in properties) {
        covered = true;
        const error = validateValue(item, properties[key], join(path, key), root);
        if (error) return error;
      }
      for (const [regex, sub] of patterns) {
        if (!regex.test(key)) continue;
        covered = true;
        const error = validateValue(item, sub, join(path, key), root);
        if (error) return error;
      }
      if (!covered && node.additionalProperties !== undefined) {
        if (node.additionalProperties === false) return `${path}: has unexpected property ${show(key)}`;
        const error = validateValue(item, node.additionalProperties, join(path, key), root);
        if (error) return error;
      }
      if (node.propertyNames !== undefined) {
        const error = validateValue(key, node.propertyNames, join(path, key), root);
        if (error) return `${path}: property name ${show(key)} is not allowed (${error.slice(error.indexOf(":") + 2)})`;
      }
    }
    if (isObject(node.dependentRequired)) {
      for (const [key, deps] of Object.entries(node.dependentRequired as Record<string, string[]>)) {
        if (!(key in value)) continue;
        const missing = (deps ?? []).filter((dep) => !(dep in value));
        if (missing.length) return `${path}: must have ${missing.map(show).join(", ")} when ${show(key)} is present`;
      }
    }
    if (isObject(node.dependentSchemas)) {
      for (const [key, sub] of Object.entries(node.dependentSchemas as Record<string, Schema>)) {
        if (!(key in value)) continue;
        const error = validateValue(value, sub, path, root);
        if (error) return error;
      }
    }
  }

  if (Array.isArray(node.allOf)) {
    for (const sub of node.allOf as Schema[]) {
      const error = validateValue(value, sub, path, root);
      if (error) return error;
    }
  }
  if (Array.isArray(node.anyOf)) {
    const errors = (node.anyOf as Schema[]).map((sub) => validateValue(value, sub, path, root));
    if (!errors.some((error) => error === null)) return deepest(errors as string[]);
  }
  if (Array.isArray(node.oneOf)) {
    const errors = (node.oneOf as Schema[]).map((sub) => validateValue(value, sub, path, root));
    const passed = errors.filter((error) => error === null).length;
    if (passed === 0) return deepest(errors as string[]);
    if (passed > 1) return `${path}: must match exactly one of the allowed shapes, matched ${passed}`;
  }
  if (node.not !== undefined && validateValue(value, node.not, path, root) === null) return `${path}: must NOT match the forbidden shape`;
  if (node.if !== undefined) {
    const holds = validateValue(value, node.if, path, root) === null;
    const branch = holds ? node.then : node.else;
    if (branch !== undefined) {
      const error = validateValue(value, branch, path, root);
      // a then/else violation only makes sense together with its condition: "signal: must be null" alone reads as
      // an absolute rule, while the fix may be on the other side of the condition (e.g. a different verdict)
      if (error) return `${error} (rule: ${holds ? "when" : "unless"} ${describeCondition(node.if, path)})`;
    }
  }
  return null;
};

/** Human-readable form of an `if` schema: `verdict is "summary_only"`, `a.b is one of [...]`, `(x is true or y is true)`. */
const describeCondition = (schema: any, path: string): string => {
  if (schema === true) return "always";
  if (schema === false) return "never";
  if (!isObject(schema)) return "the condition holds";
  const parts: string[] = [];
  if ("const" in schema) parts.push(`${path} is ${show(schema.const)}`);
  if (Array.isArray(schema.enum)) parts.push(`${path} is one of ${show(schema.enum)}`);
  if (schema.type !== undefined && !("const" in schema) && !Array.isArray(schema.enum)) parts.push(`${path} is ${Array.isArray(schema.type) ? schema.type.join(" or ") : schema.type}`);
  if (isObject(schema.properties)) {
    for (const [key, sub] of Object.entries(schema.properties as Record<string, unknown>)) parts.push(describeCondition(sub, join(path, key)));
  }
  if (Array.isArray(schema.allOf)) parts.push(...(schema.allOf as unknown[]).map((sub) => describeCondition(sub, path)));
  if (Array.isArray(schema.anyOf)) parts.push(`(${(schema.anyOf as unknown[]).map((sub) => describeCondition(sub, path)).join(" or ")})`);
  if (Array.isArray(schema.oneOf)) parts.push(`(exactly one of: ${(schema.oneOf as unknown[]).map((sub) => describeCondition(sub, path)).join(", ")})`);
  if (schema.not !== undefined) parts.push(`not (${describeCondition(schema.not, path)})`);
  if (typeof schema.$ref === "string") parts.push(`${path} matches ${schema.$ref}`);
  return parts.length ? parts.join(" and ") : `${path} matches ${show(schema).slice(0, 120)}`;
};

/** The most specific of several branch errors: the one with the deepest path (first on ties). */
const deepest = (errors: string[]): string =>
  errors.reduce((best, error) => (depthOf(error) > depthOf(best) ? error : best), errors[0] ?? "does not match the schema");

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
  const error = validateValue(parsedArguments, schema, ROOT_PATH, schema);
  if (error) {
    return { success: false, error: `Invalid arguments: ${error}` };
  }
  return { success: true, data: parsedArguments as T };
};

export default validateToolArguments;
