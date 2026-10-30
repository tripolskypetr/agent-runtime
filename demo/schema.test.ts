/**
 * Validator and model-schema tests, no model involved:
 *   npm run test:schema
 * Uses the AGENT.md schemas from demo/fixtures (predicate $defs spliced into agent1).
 */
import { readFileSync } from "fs";
import path from "path";

import { compileFormat, formatErrors, InvalidFormatError, toModelSchema } from "../src/helpers/schema.js";
import { validateToolArguments, validateValue } from "../src/validation/validateToolArguments.js";
import type { FormatModel } from "../src/model/Format.model.js";
import { checkAgent1Answer } from "./agent1.check.js";

const fixtures = path.join(import.meta.dirname, "fixtures");
const load = (name: string) => JSON.parse(readFileSync(path.join(fixtures, name), "utf-8"));
const agent1 = load("agent1.schema.json") as FormatModel;
const agent2 = load("agent2.schema.json") as FormatModel;
const agent3 = load("agent3.schema.json") as FormatModel;
const fixtureA = load("agent1.fixture-a.json");
const fixtureB = load("agent1.fixture-b.json");
const fixtureC = load("agent1.fixture-c.json");
const articleC = readFileSync(path.join(fixtures, "agent1.synthetic-c.article.txt"), "utf-8");

const results: boolean[] = [];
const check = (name: string, ok: boolean, info?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (info !== undefined) console.log("      " + JSON.stringify(info).slice(0, 400));
  results.push(ok);
};
/** Both validators must agree on every value: the shared copy (SDK) and ajv (server's second gate). */
const parity: boolean[] = [];
const agree = (schema: FormatModel, value: unknown) => {
  const shared = validateToolArguments(value, schema).success;
  const ajv = compileFormat(schema as unknown as Record<string, unknown>).validate(value) === true;
  parity.push(shared === ajv);
  if (shared !== ajv) console.log(`      PARITY MISMATCH shared=${shared} ajv=${ajv} for ${JSON.stringify(value).slice(0, 120)}`);
  return shared === ajv;
};
const reject = (name: string, schema: FormatModel, value: unknown, expectPath: RegExp) => {
  const result = validateToolArguments(value, schema);
  check(name, !result.success && expectPath.test(result.error ?? "") && agree(schema, value), result.error);
};

/* ---- schemas compile as they are written in AGENT.md (with $defs spliced) ---- */
for (const [name, schema] of [["agent1", agent1], ["agent2", agent2], ["agent3", agent3]] as const) {
  let ok = true;
  let message = "";
  try {
    compileFormat(schema as unknown as Record<string, unknown>);
  } catch (error) {
    ok = false;
    message = (error as Error).message;
  }
  check(`${name} schema compiles`, ok, message || undefined);
}

/* ---- golden fixtures validate against agent1 ---- */
check("fixture A valid", validateToolArguments(fixtureA, agent1).success, validateToolArguments(fixtureA, agent1).error);
check("fixture B valid", validateToolArguments(fixtureB, agent1).success, validateToolArguments(fixtureB, agent1).error);
check("fixture C (synthetic, signal not null) valid", validateToolArguments(fixtureC, agent1).success, validateToolArguments(fixtureC, agent1).error);

/* ---- post-validation from AGENT.md sections 3 and 5 (what the schema cannot check) ---- */
check("fixture C passes post-validation (quotes, claim ids, numeric literals, predicate limits)", checkAgent1Answer(fixtureC, articleC).length === 0, checkAgent1Answer(fixtureC, articleC));
check("fixtures A and B pass post-validation with signal null", checkAgent1Answer(fixtureA, "") .filter((p) => !p.includes("substring")).length === 0 && checkAgent1Answer(fixtureB, "").filter((p) => !p.includes("substring")).length === 0);
const tampered = JSON.parse(JSON.stringify(fixtureC));
tampered.signal.based_on_claim_ids = ["c2"];
tampered.signal.entry = { all: [{ feature: "last_price", op: "gt", value: 85000 }, { any: [{ not: { all: [{ feature: "ret_60m_pct", op: "gt", value: 0 }] } }] }] };
tampered.claims[0].evidence_quote = "закрепление выше 84 900 откроет дорогу к 90 000";
const tamperedProblems = checkAgent1Answer(tampered, articleC);
check("post-validation catches: paraphrased quote, down-claim as basis, invented level, depth 4", validateToolArguments(tampered, agent1).success && tamperedProblems.length === 4, tamperedProblems);

/* ---- each advanced keyword is enforced, with a path ---- */
const withSignal = (signal: unknown, verdict = "forecast_expressible") => ({ ...fixtureB, verdict, signal });
const goodSignal = {
  direction: "long",
  asset: "BTC",
  based_on_claim_ids: ["c2"],
  entry: { feature: "last_price", op: "gt", value: 82500 },
  invalidation: { feature: "last_price", op: "lt", value: 80684 },
  hard_stop: { mode: "atr_multiple", value: 2 },
  max_holding_periods: 6,
  ttl_hours: 24,
  confidence: "medium",
  rationale: "Уровень $82 500 назван в статье ключевым для краткосрочных сценариев.",
};
check("valid signal accepted", validateToolArguments(withSignal(goodSignal), agent1).success && agree(agent1, withSignal(goodSignal)), validateToolArguments(withSignal(goodSignal), agent1).error);
reject("const: direction short", agent1, withSignal({ ...goodSignal, direction: "short" }), /^Invalid arguments: signal\.direction: must be exactly "long"$/);
reject("additionalProperties: extra key", agent1, { ...fixtureA, extra: 1 }, /answer: has unexpected property "extra"/);
reject("pattern: claim id", agent1, { ...fixtureA, claims: [{ ...fixtureA.claims[0], id: "claim-1" }] }, /claims\[0\]\.id: must match pattern/);
reject("minLength: short rationale", agent1, withSignal({ ...goodSignal, rationale: "short" }), /^Invalid arguments: signal\.rationale: must NOT have fewer than 20 characters$/);
reject("maxItems: too many based_on_claim_ids", agent1, withSignal({ ...goodSignal, based_on_claim_ids: ["c1", "c2", "c3", "c4", "c5"] }), /^Invalid arguments: signal\.based_on_claim_ids: must NOT have more than 4 items$/);
check("nullable: the string \"null\" is still a valid string (prompt rule 5 covers it, not the schema)", validateToolArguments({ ...fixtureA, article: { ...fixtureA.article, published_at: "null" } }, agent1).success);
check("nullable: published_at null ok", validateToolArguments({ ...fixtureA, article: { ...fixtureA.article, published_at: null } }, agent1).success);
reject("nullable: published_at number", agent1, { ...fixtureA, article: { ...fixtureA.article, published_at: 5 } }, /article\.published_at: must be string or null/);
reject("oneOf: signal is a string", agent1, withSignal("none"), /^Invalid arguments: signal: must be (null|object)/);
reject("if/then: summary_only with signal object", agent1, withSignal(goodSignal, "summary_only"), /^Invalid arguments: signal: must be null, got object$/);
reject("if/then: forecast_expressible with signal null", agent1, withSignal(null, "forecast_expressible"), /^Invalid arguments: signal: must be object, got null$/);
reject("enum: unknown feature (deepest branch error of the oneOf)", agent1, withSignal({ ...goodSignal, entry: { feature: "rsi_14", op: "gt", value: 1 } }), /^Invalid arguments: signal\.entry\.feature: must be one of \["last_price"/);
reject("exclusiveMinimum: hard_stop 0", agent1, withSignal({ ...goodSignal, hard_stop: { mode: "percent", value: 0 } }), /^Invalid arguments: signal\.hard_stop\.value: must be > 0$/);
reject("enum with null: veto_reason", agent2, { schema_version: "1.0.0", evaluated_at: "x", signal_id: "s", precondition_checks: { bars_available: 1, minutes_since_window_end: 0, no_open_position: true, signal_not_expired: true, features_sane: true }, entry_predicate_echo: { value: true, leaf_results: [] }, decision: { action: "hold_flat", veto_reason: "bored", notes: "" } }, /decision\.veto_reason: must be one of/);
reject("agent3 if/then: close with reason none", agent3, { schema_version: "1.0.0", evaluated_at: "x", position: { signal_id: "s", opened_at: "x", entry_price: 1, last_price: 1, unrealized_pct: 0, periods_held: 0, max_holding_periods: 1, exchange_stop_order_id: null }, exit_checks: { hard_stop_hit: true, time_stop_hit: false, invalidation_result: false, entry_condition_still_true: false, leaf_results: [] }, decision: { action: "close", reason: "none", notes: "" } }, /decision\.reason: must be one of/);

/* ---- recursive predicate through $ref ---- */
const deep = { all: [{ feature: "last_price", op: "gt", value: 82500 }, { any: [{ not: { feature: "ret_60m_pct", op: "lt", value: { feature: "atr_14_pct" } } }, { feature: "volume_ratio_60_180", op: "gte", value: 1.5 }] }] };
check("recursive predicate 3 levels accepted", validateToolArguments(withSignal({ ...goodSignal, entry: deep }), agent1).success && agree(agent1, withSignal({ ...goodSignal, entry: deep })), validateToolArguments(withSignal({ ...goodSignal, entry: deep }), agent1).error);
reject("recursive predicate: bad leaf at depth 3", agent1, withSignal({ ...goodSignal, entry: { all: [{ any: [{ not: { feature: "last_price", op: "equals", value: 1 } }] }] } }), /^Invalid arguments: signal\.entry\.all\[0\]\.any\[0\]\.not\.op: must be one of/);

/* ---- error message shape: the shared validator reports one problem; ajv's formatErrors caps at 5 lines ---- */
const broken = { ...fixtureA, verdict: "nope", claims: [{ ...fixtureA.claims[0], id: "bad", kind: "x" }], extra: 1, more: 2 };
const multi = validateToolArguments(broken, agent1);
check("shared validator: one problem per call", !multi.success && !(multi.error ?? "").includes("; ") && agree(agent1, broken), multi.error);
const ajvErrors = compileFormat(agent1 as unknown as Record<string, unknown>).validate(broken) ? "" : formatErrors(compileFormat(agent1 as unknown as Record<string, unknown>).validate.errors);
const lines = ajvErrors.split("; ");
check("ajv formatErrors capped at 5 lines + summary", lines.length <= 6 && (lines.length <= 5 || /more$/.test(lines[lines.length - 1] ?? "")), ajvErrors);

/* ---- shared validator: keywords beyond the AGENT.md schemas, each checked against ajv too ---- */
const kw = (schema: Record<string, unknown>) => ({ type: "object", required: ["v"], properties: { v: schema } }) as unknown as FormatModel;
const cases: [string, FormatModel, unknown, boolean][] = [
  ["anyOf number|string", kw({ anyOf: [{ type: "number" }, { type: "string" }] }), { v: "x" }, true],
  ["anyOf none match", kw({ anyOf: [{ type: "number" }, { type: "string" }] }), { v: true }, false],
  ["not", kw({ not: { const: "no" } }), { v: "no" }, false],
  ["if/else", kw({ type: "object", properties: { a: { type: "integer" } }, if: { properties: { a: { const: 1 } }, required: ["a"] }, then: { required: ["b"] }, else: { required: ["c"] } }), { v: { a: 2, c: 1 } }, true],
  ["if/else fails", kw({ type: "object", properties: { a: { type: "integer" } }, if: { properties: { a: { const: 1 } }, required: ["a"] }, then: { required: ["b"] }, else: { required: ["c"] } }), { v: { a: 2 } }, false],
  ["pattern unicode", kw({ type: "string", pattern: "^\\p{L}+$" }), { v: "Привет" }, true],
  ["minimum", kw({ type: "number", minimum: 1 }), { v: 0.5 }, false],
  ["multipleOf", kw({ type: "number", multipleOf: 0.5 }), { v: 2.5 }, true],
  ["multipleOf fails", kw({ type: "integer", multipleOf: 3 }), { v: 10 }, false],
  ["uniqueItems", kw({ type: "array", uniqueItems: true, items: { type: "object" } }), { v: [{ a: 1 }, { a: 1 }] }, false],
  ["prefixItems + items false", kw({ type: "array", prefixItems: [{ type: "string" }, { type: "number" }], items: false }), { v: ["a", 1, 2] }, false],
  ["prefixItems ok", kw({ type: "array", prefixItems: [{ type: "string" }, { type: "number" }], items: false }), { v: ["a", 1] }, true],
  ["contains minContains", kw({ type: "array", contains: { type: "number" }, minContains: 2 }), { v: [1, "a"] }, false],
  ["patternProperties allowed with additionalProperties false", kw({ type: "object", patternProperties: { "^x_": { type: "number" } }, additionalProperties: false }), { v: { x_1: 1 } }, true],
  ["patternProperties value type", kw({ type: "object", patternProperties: { "^x_": { type: "number" } }, additionalProperties: false }), { v: { x_1: "s" } }, false],
  ["additionalProperties schema", kw({ type: "object", additionalProperties: { type: "boolean" } }), { v: { any: 1 } }, false],
  ["propertyNames", kw({ type: "object", propertyNames: { pattern: "^[a-z]+$" } }), { v: { Bad: 1 } }, false],
  ["dependentRequired", kw({ type: "object", dependentRequired: { a: ["b"] } }), { v: { a: 1 } }, false],
  ["dependentSchemas", kw({ type: "object", dependentSchemas: { a: { required: ["b"] } } }), { v: { a: 1, b: 2 } }, true],
  ["minProperties", kw({ type: "object", minProperties: 2 }), { v: { a: 1 } }, false],
  ["type array with null", kw({ type: ["integer", "null"] }), { v: null }, true],
  ["integer rejects 1.5", kw({ type: ["integer", "null"] }), { v: 1.5 }, false],
  ["enum of objects", kw({ enum: [{ a: 1 }, [1, 2]] }), { v: [1, 2] }, true],
  ["const object", kw({ const: { a: [1, { b: null }] } }), { v: { a: [1, { b: null }] } }, true],
  ["const object differs", kw({ const: { a: [1, { b: null }] } }), { v: { a: [1, { b: 0 }] } }, false],
  ["$ref to properties pointer", { type: "object", required: ["v", "w"], properties: { v: { type: "string", enum: ["a"] }, w: { $ref: "#/properties/v" } } } as unknown as FormatModel, { v: "a", w: "b" }, false],
  ["$ref with sibling keywords", kw({ $ref: "#/properties/v/$defs/s", maxLength: 2, $defs: { s: { type: "string" } } }), { v: "abc" }, false],
  ["minLength counts code points", kw({ type: "string", minLength: 2 }), { v: "😀😀" }, true],
  ["format ignored by the copy, accepted by ajv-formats", kw({ type: "string", format: "date-time" }), { v: "2026-10-30T10:00:00Z" }, true],
];
for (const [name, schema, value, expected] of cases) {
  const result = validateToolArguments(value, schema);
  check(`kw: ${name}`, result.success === expected && agree(schema, value), result.error);
}
check("validateValue: unresolvable $ref is reported, not thrown", /unresolvable \$ref/.test(validateValue({ v: 1 }, { type: "object", properties: { v: { $ref: "#/$defs/nope" } } }, "answer") ?? ""));
check(`parity shared validator vs ajv on ${parity.length} values`, parity.every(Boolean));

/* ---- invalid schema → InvalidFormatError ---- */
let invalid: unknown = null;
try {
  compileFormat({ type: "object", required: ["x"], properties: { x: { $ref: "#/$defs/missing" } } });
} catch (error) {
  invalid = error;
}
check("missing $defs → InvalidFormatError", invalid instanceof InvalidFormatError && /can't resolve reference/.test((invalid as Error).message), (invalid as Error)?.message);
check("cache: same schema compiled once", compileFormat(agent1 as unknown as Record<string, unknown>) === compileFormat(JSON.parse(JSON.stringify(agent1))));

/* ---- model-facing schema ---- */
const model3 = toModelSchema(agent1 as unknown as Record<string, unknown>, 3);
const text3 = JSON.stringify(model3);
check("model schema: meta and $defs removed", !("$defs" in model3) && !("$id" in model3) && !("title" in model3) && !("$schema" in model3));
check("model schema: $ref inlined to depth 3", (text3.match(/"\$ref"/g) ?? []).length === 0 && text3.includes('"all"') && text3.includes("of the same shape"), { bytes: text3.length, original: JSON.stringify(agent1).length });
const entry = (model3 as any).properties.signal.oneOf[1].properties.entry;
check("model schema: inlined predicate keeps oneOf branches", Array.isArray(entry.oneOf) && entry.oneOf.length === 4 && entry.oneOf[0].properties.feature.enum.length === 18);
const model0 = toModelSchema(agent1 as unknown as Record<string, unknown>, 0);
check("model schema depth 0: $ref/$defs passed through, meta removed", "$defs" in model0 && JSON.stringify(model0).includes('"$ref"') && !("$id" in model0));
check("model schema: original schema untouched", "$defs" in agent1 && "$id" in agent1);
check("formatErrors(null) has a fallback", formatErrors(null) === "does not match the schema");

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
