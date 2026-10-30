/**
 * Validator and model-schema tests, no model involved:
 *   npm run test:schema
 * Uses the AGENT.md schemas from demo/fixtures (predicate $defs spliced into agent1).
 */
import { readFileSync } from "fs";
import path from "path";

import { compileFormat, formatErrors, InvalidFormatError, toModelSchema } from "../src/helpers/schema.js";
import { validateToolArguments } from "../src/helpers/validateToolArguments.js";
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
const reject = (name: string, schema: FormatModel, value: unknown, expectPath: RegExp) => {
  const result = validateToolArguments(value, schema);
  check(name, !result.success && expectPath.test(result.error ?? ""), result.error);
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
check("valid signal accepted", validateToolArguments(withSignal(goodSignal), agent1).success, validateToolArguments(withSignal(goodSignal), agent1).error);
reject("const: direction short", agent1, withSignal({ ...goodSignal, direction: "short" }), /^Invalid arguments: signal\.direction: must be exactly "long"/);
reject("additionalProperties: extra key", agent1, { ...fixtureA, extra: 1 }, /answer: has unexpected property "extra"/);
reject("pattern: claim id", agent1, { ...fixtureA, claims: [{ ...fixtureA.claims[0], id: "claim-1" }] }, /claims\[0\]\.id: must match pattern/);
reject("minLength: short rationale", agent1, withSignal({ ...goodSignal, rationale: "short" }), /signal.*rationale.*minLength|signal.*rationale.*fewer/);
reject("maxItems: too many based_on_claim_ids", agent1, withSignal({ ...goodSignal, based_on_claim_ids: ["c1", "c2", "c3", "c4", "c5"] }), /based_on_claim_ids/);
check("nullable: the string \"null\" is still a valid string (prompt rule 5 covers it, not the schema)", validateToolArguments({ ...fixtureA, article: { ...fixtureA.article, published_at: "null" } }, agent1).success);
check("nullable: published_at null ok", validateToolArguments({ ...fixtureA, article: { ...fixtureA.article, published_at: null } }, agent1).success);
reject("nullable: published_at number", agent1, { ...fixtureA, article: { ...fixtureA.article, published_at: 5 } }, /article\.published_at: must be string or null/);
reject("oneOf: signal is a string", agent1, withSignal("none"), /signal: must match exactly one/);
reject("if/then: summary_only with signal object", agent1, withSignal(goodSignal, "summary_only"), /signal: must be null/);
reject("if/then: forecast_expressible with signal null", agent1, withSignal(null, "forecast_expressible"), /signal: must be object/);
reject("enum: unknown feature (deepest error first despite oneOf noise)", agent1, withSignal({ ...goodSignal, entry: { feature: "rsi_14", op: "gt", value: 1 } }), /^Invalid arguments: signal\.entry\.feature: must be one of/);
reject("exclusiveMinimum: hard_stop 0", agent1, withSignal({ ...goodSignal, hard_stop: { mode: "percent", value: 0 } }), /hard_stop\.value/);
reject("enum with null: veto_reason", agent2, { schema_version: "1.0.0", evaluated_at: "x", signal_id: "s", precondition_checks: { bars_available: 1, minutes_since_window_end: 0, no_open_position: true, signal_not_expired: true, features_sane: true }, entry_predicate_echo: { value: true, leaf_results: [] }, decision: { action: "hold_flat", veto_reason: "bored", notes: "" } }, /decision\.veto_reason: must be one of/);
reject("agent3 if/then: close with reason none", agent3, { schema_version: "1.0.0", evaluated_at: "x", position: { signal_id: "s", opened_at: "x", entry_price: 1, last_price: 1, unrealized_pct: 0, periods_held: 0, max_holding_periods: 1, exchange_stop_order_id: null }, exit_checks: { hard_stop_hit: true, time_stop_hit: false, invalidation_result: false, entry_condition_still_true: false, leaf_results: [] }, decision: { action: "close", reason: "none", notes: "" } }, /decision\.reason: must be one of/);

/* ---- recursive predicate through $ref ---- */
const deep = { all: [{ feature: "last_price", op: "gt", value: 82500 }, { any: [{ not: { feature: "ret_60m_pct", op: "lt", value: { feature: "atr_14_pct" } } }, { feature: "volume_ratio_60_180", op: "gte", value: 1.5 }] }] };
check("recursive predicate 3 levels accepted", validateToolArguments(withSignal({ ...goodSignal, entry: deep }), agent1).success, validateToolArguments(withSignal({ ...goodSignal, entry: deep }), agent1).error);
reject("recursive predicate: bad leaf at depth 3", agent1, withSignal({ ...goodSignal, entry: { all: [{ any: [{ not: { feature: "last_price", op: "equals", value: 1 } }] }] } }), /signal\.entry/);

/* ---- error message shape ---- */
const multi = validateToolArguments({ ...fixtureA, verdict: "nope", claims: [{ ...fixtureA.claims[0], id: "bad", kind: "x" }], extra: 1, more: 2 }, agent1);
const lines = (multi.error ?? "").split("; ");
check("errors capped at 5 lines + summary", !multi.success && lines.length <= 6 && /more$/.test(lines[lines.length - 1] ?? "") || lines.length <= 5, multi.error);

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
