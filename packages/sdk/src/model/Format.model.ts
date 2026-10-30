/**
 * `format` of an inference request: a JSON Schema (draft 2020-12) whose top
 * level is an object. json-inference's FormatModel is a subset, so schemas
 * written for its generateObject() keep working unchanged.
 *
 * Everything is `readonly` so that a schema passed inline, through
 * `defineFormat()` or declared `as const` keeps its literal types (`enum`,
 * `const`, `required`, `type`), which is what gives IntelliSense on the answer.
 */
export type JsonSchemaType = "string" | "number" | "integer" | "boolean" | "array" | "object" | "null";

export interface JsonSchema {
  readonly $schema?: string;
  readonly $id?: string;
  readonly $ref?: string;
  readonly $defs?: { readonly [name: string]: JsonSchema };
  readonly $comment?: string;
  readonly title?: string;
  readonly description?: string;
  readonly default?: unknown;
  readonly examples?: readonly unknown[];
  readonly deprecated?: boolean;
  readonly readOnly?: boolean;
  readonly writeOnly?: boolean;

  readonly type?: JsonSchemaType | readonly JsonSchemaType[];
  readonly enum?: readonly unknown[];
  readonly const?: unknown;

  readonly oneOf?: readonly JsonSchema[];
  readonly anyOf?: readonly JsonSchema[];
  readonly allOf?: readonly JsonSchema[];
  readonly not?: JsonSchema;
  readonly if?: JsonSchema;
  readonly then?: JsonSchema;
  readonly else?: JsonSchema;

  readonly properties?: { readonly [key: string]: JsonSchema };
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | JsonSchema;
  readonly patternProperties?: { readonly [pattern: string]: JsonSchema };
  readonly propertyNames?: JsonSchema;
  readonly unevaluatedProperties?: boolean | JsonSchema;
  readonly dependentRequired?: { readonly [key: string]: readonly string[] };
  readonly dependentSchemas?: { readonly [key: string]: JsonSchema };
  readonly minProperties?: number;
  readonly maxProperties?: number;

  readonly items?: JsonSchema;
  readonly prefixItems?: readonly JsonSchema[];
  readonly contains?: JsonSchema;
  readonly minContains?: number;
  readonly maxContains?: number;
  readonly unevaluatedItems?: boolean | JsonSchema;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly uniqueItems?: boolean;

  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly format?: string;
  readonly contentEncoding?: string;
  readonly contentMediaType?: string;

  readonly minimum?: number;
  readonly maximum?: number;
  readonly exclusiveMinimum?: number;
  readonly exclusiveMaximum?: number;
  readonly multipleOf?: number;
}

/** Kept for code written against the json-inference subset; both are the full JsonSchema now. */
export type FormatItems = JsonSchema;
export type FormatProperty = JsonSchema;

/** Root schema: an object with `required` and `properties` (the provide_answer tool arguments). */
export interface FormatModel extends JsonSchema {
  readonly type: "object";
  readonly required: readonly string[];
  readonly properties: { readonly [key: string]: JsonSchema };
}

/* ------------------------------------------------------------------ type inference */

/** Flattens intersections so hover tooltips show one plain object type. */
type Simplify<T> = T extends object ? (T extends (...args: never[]) => unknown ? T : { [K in keyof T]: T[K] } & {}) : T;

type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (k: infer I) => void ? I : never;

/** Depth counter for `$ref` recursion: `Prev[6]` is 5, `Prev[0]` is never. */
type Prev = [never, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
type Depth = Prev[number];

/** Default `$ref` depth: nested references deeper than this become `unknown`. */
export type DefaultRefDepth = 6;

type ScalarOf<T extends JsonSchemaType> = T extends "string"
  ? string
  : T extends "number" | "integer"
    ? number
    : T extends "boolean"
      ? boolean
      : T extends "null"
        ? null
        : never;

/** Keys listed in `required`; a widened `string[]` keeps every key required, as json-inference does. */
type RequiredKeysOf<P, R> = R extends readonly (infer K)[] ? (K extends string ? K & keyof P : never) : never;

type InferObject<P, R, Root, D extends Depth> = Simplify<
  { -readonly [K in keyof P as K extends RequiredKeysOf<P, R> ? K : never]-?: InferProperty<P[K], Root, D> } & {
    -readonly [K in keyof P as K extends RequiredKeysOf<P, R> ? never : K]?: InferProperty<P[K], Root, D>;
  }
>;

type InferRef<Name, Root, D extends Depth> = [D] extends [never]
  ? unknown
  : Root extends { readonly $defs: infer Defs }
    ? Name extends keyof Defs
      ? InferProperty<Defs[Name], Root, Prev[D]>
      : unknown
    : unknown;

type InferBranches<B, Root, D extends Depth> = B extends readonly (infer S)[] ? InferProperty<S, Root, D> : unknown;

type InferAllOf<B, Root, D extends Depth> = B extends readonly (infer S)[] ? UnionToIntersection<InferProperty<S, Root, D>> : unknown;

/** Type of a schema without its combinators: the part keyed by `type`. */
type InferByType<T, Root, D extends Depth> = T extends { readonly type: readonly (infer U extends JsonSchemaType)[] }
  ? U extends "object" | "array"
    ? InferByType<Omit<T, "type"> & { readonly type: U }, Root, D>
    : ScalarOf<U>
  : T extends { readonly type: "string" | "number" | "integer" | "boolean" | "null" }
    ? ScalarOf<T["type"] & JsonSchemaType>
    : T extends { readonly type: "array"; readonly items: infer I }
      ? InferProperty<I, Root, D>[]
      : T extends { readonly type: "array" }
        ? unknown[]
        : T extends { readonly type: "object"; readonly properties: infer P }
          ? InferObject<P, T extends { readonly required: infer R } ? R : never, Root, D>
          : T extends { readonly type: "object" }
            ? Record<string, unknown>
            : T extends { readonly properties: infer P }
              ? InferObject<P, T extends { readonly required: infer R } ? R : never, Root, D>
              : T extends { readonly items: infer I }
                ? InferProperty<I, Root, D>[]
                : unknown;

/**
 * TypeScript type of the value described by a schema node. Precedence:
 * `$ref` → `const` → `enum` → `oneOf` / `anyOf` (union, intersected with the
 * node's own type) → `allOf` (intersection) → `type` (array of types gives a
 * union, `"null"` gives `null`) → object / array shape. `if`/`then`/`else`
 * do not change the type.
 */
export type InferProperty<T, Root = T, D extends Depth = DefaultRefDepth> = T extends { readonly $ref: `#/$defs/${infer Name}` }
  ? InferRef<Name, Root, D>
  : T extends { readonly const: infer C }
    ? C
    : T extends { readonly enum: readonly (infer E)[] }
      ? E
      : T extends { readonly oneOf: infer B }
        ? InferBranches<B, Root, D> & InferByType<Omit<T, "oneOf">, Root, D>
        : T extends { readonly anyOf: infer B }
          ? InferBranches<B, Root, D> & InferByType<Omit<T, "anyOf">, Root, D>
          : T extends { readonly allOf: infer B }
            ? Simplify<InferAllOf<B, Root, D> & InferByType<Omit<T, "allOf">, Root, D>>
            : InferByType<T, Root, D>;

/**
 * TypeScript type of the answer for a schema: required properties are mandatory,
 * the rest optional, enums and consts become literals, nullable types become
 * `T | null`, `oneOf` becomes a union, nested objects, arrays and `$ref`s recurse.
 *
 * Recursive `$ref`s are followed up to `D` levels (6 by default); a reference
 * deeper than that is typed as `unknown`. This is the one deliberate limit of
 * the inference: one `defineFormat()` call is the whole contract, there is no
 * second, hand-written type to keep in sync.
 */
export type InferFormat<T extends FormatModel, D extends Depth = DefaultRefDepth> = InferProperty<T, T, D>;

/**
 * Identity helper that keeps the literal types of a schema (`enum`, `const`,
 * `required`, `type`) so `InferFormat<typeof format>` is as precise as possible:
 *
 * ```ts
 * const format = defineFormat({
 *   type: "object",
 *   required: ["position"],
 *   properties: { position: { type: "string", enum: ["long", "short", "wait"], description: "…" } },
 * });
 * type Answer = InferFormat<typeof format>; // { position: "long" | "short" | "wait" }
 * ```
 */
export const defineFormat = <const F extends FormatModel>(format: F): F => format;
