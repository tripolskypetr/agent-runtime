/**
 * JSON-schema subset accepted as the `format` of an inference request.
 * Compatible with json-inference's FormatModel: schemas written for
 * generateObject() there can be passed to agent-runtime unchanged.
 *
 * Arrays are `readonly` so that `as const` schemas and `const` type
 * parameters keep literal types for `enum` and `required`, which is what
 * gives IntelliSense on the inferred answer type.
 */
export type FormatItems =
  | { readonly type: "string"; readonly description?: string; readonly enum?: readonly string[] }
  | { readonly type: "number"; readonly description?: string }
  | { readonly type: "integer"; readonly description?: string }
  | { readonly type: "boolean"; readonly description?: string }
  | {
      readonly type: "array";
      readonly description?: string;
      readonly items?: FormatItems;
      readonly minItems?: number;
      readonly maxItems?: number;
    }
  | {
      readonly type: "object";
      readonly description?: string;
      readonly required?: readonly string[];
      readonly properties?: { readonly [key: string]: FormatProperty };
    };

export type FormatProperty =
  | { readonly type: "string"; readonly description: string; readonly enum?: readonly string[] }
  | { readonly type: "number"; readonly description: string }
  | { readonly type: "integer"; readonly description: string }
  | { readonly type: "boolean"; readonly description: string }
  | {
      readonly type: "array";
      readonly description: string;
      readonly items?: FormatItems;
      readonly minItems?: number;
      readonly maxItems?: number;
    }
  | {
      readonly type: "object";
      readonly description: string;
      readonly required?: readonly string[];
      readonly properties?: { readonly [key: string]: FormatProperty };
    };

export interface FormatModel {
  readonly type: string;
  readonly required: readonly string[];
  readonly properties: { readonly [key: string]: FormatProperty };
}

/** Flattens intersections so hover tooltips show one plain object type. */
type Simplify<T> = { [K in keyof T]: T[K] } & {};

/** `enum: ["a", "b"]` declared with `as const` / `defineFormat` becomes `"a" | "b"`, otherwise `string`. */
type EnumOf<T> = T extends { readonly enum: readonly (infer E)[] } ? (E extends string ? E : string) : string;

/** Keys listed in `required`; a widened `string[]` keeps every key required, as json-inference does. */
type RequiredKeysOf<P, R> = R extends readonly (infer K)[] ? (K extends string ? K & keyof P : never) : never;

type InferObject<P, R> = Simplify<
  { -readonly [K in keyof P as K extends RequiredKeysOf<P, R> ? K : never]-?: InferProperty<P[K]> } & {
    -readonly [K in keyof P as K extends RequiredKeysOf<P, R> ? never : K]?: InferProperty<P[K]>;
  }
>;

export type InferProperty<T> = T extends { readonly type: "string" }
  ? EnumOf<T>
  : T extends { readonly type: "number" }
    ? number
    : T extends { readonly type: "integer" }
      ? number
      : T extends { readonly type: "boolean" }
        ? boolean
        : T extends { readonly type: "array"; readonly items: infer I }
          ? InferProperty<I>[]
          : T extends { readonly type: "array" }
            ? unknown[]
            : T extends { readonly type: "object"; readonly properties: infer P }
              ? InferObject<P, T extends { readonly required: infer R } ? R : never>
              : T extends { readonly type: "object" }
                ? Record<string, unknown>
                : unknown;

/**
 * TypeScript type of the answer for a schema: required properties are mandatory,
 * the rest optional, string enums become unions, nested objects and arrays recurse.
 */
export type InferFormat<T extends FormatModel> = InferObject<T["properties"], T["required"]>;

/**
 * Identity helper that keeps the literal types of a schema (`enum`, `required`)
 * so `InferFormat<typeof format>` is as precise as possible:
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
