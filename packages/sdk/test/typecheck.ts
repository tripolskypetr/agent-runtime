/**
 * Compile-time assertions for the inferred answer types. Compiled against the
 * published `types.d.ts`, i.e. exactly what a consumer of the package sees.
 */
import { createClient, defineFormat, generateObject, generateText, inference, type FormatModel, type InferFormat } from "agent-runtime-sdk";

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
    type _9 = Expect<Equal<typeof response.error.code, "schema_mismatch" | "empty_answer" | "max_turns" | "timeout" | "provider_error" | "internal_error">>;
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

void inline;
void union;
void standalone;
