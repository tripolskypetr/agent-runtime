/**
 * Compile-time assertions for the inferred answer types. Compiled against the
 * published `types.d.ts`, i.e. exactly what a consumer of the package sees.
 */
import { createClient, defineFormat, generateObject, generateText, inference, type FormatModel, type InferFormat, type InferProperty } from "agent-runtime-sdk";
import { Agent1Format } from "./agent1.format.js";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

const client = createClient({ baseUrl: "http://localhost:10050" });

/* 1. Inline literal schema: enums become unions, `required` splits mandatory and optional keys. */
async function inline() {
  const answer = await client.generateObject({
    messages: [{ role: "user", content: "…" }],
    format: {
      type: "object",
      required: ["position", "targets", "entryRange"],
      properties: {
        position: { type: "string", enum: ["long", "short", "wait"], description: "Тип позиции" },
        targets: { type: "array", items: { type: "number" }, description: "Цели" },
        entryRange: {
          type: "object",
          description: "Диапазон входа",
          required: ["from"],
          properties: { from: { type: "number", description: "ОТ" }, to: { type: "number", description: "ДО" } },
        },
        stoploss: { type: "number", description: "Стоп" },
        note: { type: "string", description: "Комментарий" },
      },
    },
  });
  type Answer = typeof answer;
  type _1 = Expect<Equal<Answer["position"], "long" | "short" | "wait">>;
  type _2 = Expect<Equal<Answer["targets"], number[]>>;
  type _3 = Expect<Equal<Answer["entryRange"], { from: number; to?: number }>>;
  type _4 = Expect<Equal<Answer["stoploss"], number | undefined>>;
  type _5 = Expect<Equal<Answer["note"], string | undefined>>;
  // @ts-expect-error unknown property
  answer.missing;
  if (answer.position === "long") answer.targets.map((t) => t.toFixed(2));
}

/* 2. defineFormat keeps literals for a schema declared separately. */
const SentimentFormat = defineFormat({
  type: "object",
  required: ["sentiment", "assets"],
  properties: {
    sentiment: { type: "string", enum: ["bullish", "bearish", "neutral"], description: "Настроение" },
    assets: { type: "array", items: { type: "string" }, description: "Тикеры" },
    confidence: { type: "integer", description: "0-100" },
  },
});
type Sentiment = InferFormat<typeof SentimentFormat>;
type _6 = Expect<Equal<Sentiment, { sentiment: "bullish" | "bearish" | "neutral"; assets: string[]; confidence?: number }>>;

/* 3. A json-inference style schema (`satisfies`, no const): compatible, enums widen to string, all keys required. */
const LegacyFormat = {
  type: "object",
  required: ["id", "position"],
  properties: {
    id: { type: "number", description: "ID" },
    position: { type: "string", enum: ["long", "short"], description: "Позиция" },
    reasoning: { type: "string", description: "Почему" },
  },
} satisfies FormatModel;
type Legacy = InferFormat<typeof LegacyFormat>;
type _7 = Expect<Equal<Legacy, { id: number; position: string; reasoning: string }>>;

/* 4. Full response union is discriminated by `status`. */
async function union() {
  const response = await client.inference({ messages: [{ role: "user", content: "…" }], format: SentimentFormat });
  if (response.status === "success") {
    type _8 = Expect<Equal<typeof response.data, Sentiment>>;
  } else {
    type _9 = Expect<Equal<typeof response.error.code, "invalid_format" | "schema_mismatch" | "empty_answer" | "max_turns" | "timeout" | "provider_error" | "internal_error">>;
  }
  const text = await client.generateText({ messages: [{ role: "user", content: "…" }] });
  type _10 = Expect<Equal<typeof text, string>>;
}

/* 5. Invalid schemas are rejected at compile time. */
void client.generateObject({
  messages: [],
  // @ts-expect-error `required` is mandatory on the root schema
  format: { type: "object", properties: {} },
});
void client.generateObject({
  messages: [],
  format: {
    type: "object",
    required: [],
    // @ts-expect-error unknown property type
    properties: { x: { type: "date", description: "…" } },
  },
});

/* 6. Standalone functions: same inference, config optional. */
async function standalone() {
  const a = await generateObject({ messages: [], format: SentimentFormat });
  type _11 = Expect<Equal<typeof a, Sentiment>>;
  const b = await generateObject(
    { messages: [], format: { type: "object", required: ["ok"], properties: { ok: { type: "boolean", description: "…" } } } },
    { baseUrl: "http://agent:10050", headers: { "x-token": "t" }, signal: AbortSignal.timeout(1000) },
  );
  type _12 = Expect<Equal<typeof b, { ok: boolean }>>;
  const c = await generateText({ messages: [] });
  type _13 = Expect<Equal<typeof c, string>>;
  const d = await inference({ messages: [], format: SentimentFormat });
  type _14 = Expect<Equal<typeof d, import("agent-runtime-sdk").InferenceResponse<Sentiment>>>;
  // @ts-expect-error unknown config key
  await generateText({ messages: [] }, { timeout: 5 });
}

/* 7. Full JSON Schema keywords, one key per case. */
const KeywordsFormat = defineFormat({
  type: "object",
  required: ["version", "verdict", "note", "signal", "flags", "mixed", "echo", "veto"],
  properties: {
    version: { const: "1.0.0" },
    verdict: { enum: ["summary_only", "forecast_expressible"] },
    note: { type: ["string", "null"], maxLength: 300 },
    nothing: { type: "null" },
    signal: { oneOf: [{ type: "null" }, { type: "object", required: ["direction"], properties: { direction: { const: "long" }, size: { type: "number" } } }] },
    flags: { type: "array", maxItems: 8, items: { enum: ["a", "b"] } },
    mixed: { anyOf: [{ type: "number" }, { type: "object", required: ["feature"], properties: { feature: { type: "string" } }, additionalProperties: false }] },
    echo: { allOf: [{ type: "object", required: ["value"], properties: { value: { type: "boolean" } } }, { type: "object", properties: { note: { type: "string" } } }] },
    veto: { type: ["string", "null"], enum: ["stale", "expired", null] },
    conditional: { type: "object", required: ["a"], properties: { a: { type: "integer" } }, allOf: [{ if: { properties: { a: { const: 1 } } }, then: { properties: { b: { const: true } } } }] },
  },
});
type Keywords = InferFormat<typeof KeywordsFormat>;
type _k1 = Expect<Equal<Keywords["version"], "1.0.0">>;
type _k2 = Expect<Equal<Keywords["verdict"], "summary_only" | "forecast_expressible">>;
type _k3 = Expect<Equal<Keywords["note"], string | null>>;
type _k4 = Expect<Equal<Keywords["nothing"], null | undefined>>;
type _k5 = Expect<Equal<Keywords["signal"], null | { direction: "long"; size?: number }>>;
type _k6 = Expect<Equal<Keywords["flags"], ("a" | "b")[]>>;
type _k7 = Expect<Equal<Keywords["mixed"], number | { feature: string }>>;
type _k8 = Expect<Equal<Keywords["echo"], { value: boolean; note?: string }>>;
type _k9 = Expect<Equal<Keywords["veto"], "stale" | "expired" | null>>;
type _k10 = Expect<Equal<Keywords["conditional"], { a: number } | undefined>>; // if/then does not change the type
const wrongConst: Keywords = { version: "1.0.0", verdict: "summary_only", note: null, signal: null, flags: [], mixed: 1, echo: { value: true }, veto: null };
void wrongConst;
// @ts-expect-error const literal mismatch
const badConst: Keywords["version"] = "2.0.0";
void badConst;
// @ts-expect-error oneOf branch: direction must be "long"
const badBranch: Keywords["signal"] = { direction: "short" };
void badBranch;

/* 8. The AGENT.md agent-1 schema as ONE defineFormat(): $ref into $defs, recursive predicate, if/then, nullable. */
type Agent1 = InferFormat<typeof Agent1Format>;
type _a1 = Expect<Equal<Agent1["schema_version"], "1.0.0">>;
type _a2 = Expect<Equal<Agent1["verdict"], "summary_only" | "forecast_not_expressible" | "forecast_expressible">>;
type _a3 = Expect<Equal<Agent1["article"]["published_at"], string | null>>;
type _a4 = Expect<Equal<Agent1["article"]["data_asof_note"], string | null | undefined>>;
type _a5 = Expect<Equal<Agent1["claims"][number]["kind"], "forward_directional" | "forward_hedged" | "state_description" | "advice_generic" | "dated_event">>;
type _a6 = Expect<Equal<Agent1["data_quality_flags"][number], "no_publication_time" | "no_data_snapshot_time" | "internal_numeric_inconsistency" | "number_reused_across_contexts" | "logical_incoherence" | "source_dates_precede_publication">>;
type Signal = Exclude<Agent1["signal"], null>;
type _a7 = Expect<Equal<Agent1["signal"] extends null | object ? true : false, true>>;
type _a8 = Expect<Equal<Signal["direction"], "long">>;
type _a9 = Expect<Equal<Signal["asset"], "BTC">>;
type _a10 = Expect<Equal<Signal["hard_stop"]["mode"], "atr_multiple" | "percent" | "price">>;
type _a11 = Expect<Equal<Signal["confidence"], "low" | "medium">>;
type _a12 = Expect<Equal<Signal["based_on_claim_ids"], string[]>>;

// The recursive predicate, hand-written to depth 3, must be mutually assignable with the inferred one.
type FeatureName = InferProperty<(typeof Agent1Format)["$defs"]["featureName"]>;
type _a13 = Expect<Equal<FeatureName, "last_price" | "window_open" | "window_high" | "window_low" | "range_pct" | "ret_window_pct" | "ret_15m_pct" | "ret_60m_pct" | "realized_vol_pct" | "atr_14_pct" | "vwap_window" | "dist_from_vwap_pct" | "volume_window" | "volume_ratio_60_180" | "up_bar_fraction" | "max_drawdown_window_pct" | "bars_available" | "minutes_since_window_end">>;
interface Leaf { feature: FeatureName; op: "lt" | "lte" | "gt" | "gte" | "crosses_above" | "crosses_below"; value: number | { feature: FeatureName } }
type Predicate3 = Leaf | { all: Predicate2[] } | { any: Predicate2[] } | { not: Predicate2 };
type Predicate2 = Leaf | { all: Predicate1[] } | { any: Predicate1[] } | { not: Predicate1 };
type Predicate1 = Leaf | { all: Leaf[] } | { any: Leaf[] } | { not: Leaf };
const depth3: Predicate3 = { all: [{ feature: "last_price", op: "gt", value: 82500 }, { any: [{ not: { feature: "ret_60m_pct", op: "lt", value: { feature: "atr_14_pct" } } }] }] };
const entryFromDepth3: Signal["entry"] = depth3;            // hand-written → inferred
const depth3FromEntry: Predicate3 = entryFromDepth3 as Predicate3; // inferred is at least as wide (deeper levels are typed too)
void depth3FromEntry;
// Leaf-level precision survives the recursion: a wrong feature name at depth 3 is a compile error.
const badLeaf: Signal["entry"] = { all: [{ any: [{ not: {
  // @ts-expect-error unknown feature name at depth 3
  feature: "rsi_14", op: "gt", value: 1 } }] }] };
void badLeaf;
// Nested objects also narrow: `value` as a feature reference.
const refLeaf: Signal["entry"] = { feature: "last_price", op: "crosses_above", value: { feature: "vwap_window" } };
void refLeaf;

/* 9. The same schema through the public functions. */
async function agent1() {
  const answer = await generateObject({ messages: [{ role: "user", content: "…" }], format: Agent1Format });
  type _a14 = Expect<Equal<typeof answer, Agent1>>;
  if (answer.signal) {
    answer.signal.direction satisfies "long";
    answer.signal.entry; // Predicate
  }
  const r = await inference({ messages: [], format: Agent1Format });
  if (r.status === "success") {
    type _a15 = Expect<Equal<typeof r.data, Agent1>>;
  }
}

void inline;
void union;
void standalone;
void agent1;
