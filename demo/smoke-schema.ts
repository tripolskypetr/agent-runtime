/**
 * JSON Schema keywords end to end on the configured model (TODO part 1.5):
 *   BASE_URL=http://localhost:10050 npm run smoke:schema
 * Optional: SMOKE_ARTICLE=<path to a wwwroot.jsonl> runs the AGENT.md agent-1
 * schema on the first N articles (SMOKE_ARTICLE_COUNT, default 2) with the
 * agent-1 system prompt as `instructions`, text and images; SMOKE_ARTICLE_ONLY=1
 * skips the keyword cases, SMOKE_ARTICLE_TEXT_ONLY=1 drops the images.
 */
import { createReadStream, readFileSync } from "fs";
import http from "http";
import https from "https";
import path from "path";
import readline from "readline";

import { checkAgent1Answer } from "./agent1.check.js";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:10050";
const fixtures = path.join(import.meta.dirname, "fixtures");
const load = (name: string) => JSON.parse(readFileSync(path.join(fixtures, name), "utf-8"));

const post = (route: string, body: unknown) =>
  new Promise<{ status: number; json: any; ms: number }>((resolve, reject) => {
    const started = Date.now();
    const url = new URL(route, BASE_URL);
    const payload = JSON.stringify(body);
    const request = (url.protocol === "https:" ? https : http).request(
      url,
      { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }, timeout: 0 },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf-8");
          let json: any;
          try { json = JSON.parse(text); } catch { json = { raw: text }; }
          resolve({ status: response.statusCode ?? 0, json, ms: Date.now() - started });
        });
      },
    );
    request.on("error", reject);
    request.end(payload);
  });

const results: { name: string; ok: boolean; info: unknown }[] = [];
const report = (name: string, ok: boolean, info: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  console.log("      " + JSON.stringify(info).slice(0, 700));
  results.push({ name, ok, info });
  return ok;
};
const user = (content: string) => [{ role: "user", content }];
const details = (json: any) => json.details ?? json.error?.details ?? [];

/* ---- 1. type: ["string", "null"], the model must return JSON null ---- */
if (!process.env.SMOKE_ARTICLE_ONLY) {
  const r = await post("/api/v1/inference", {
    messages: user("The article below has no publication time. Report it.\n\n---\nBitcoin held above $81,000 on Thursday while altcoins drifted lower."),
    format: {
      type: "object",
      required: ["published_at", "headline"],
      properties: {
        published_at: { type: ["string", "null"], description: "ISO-8601 publication time, or null when the text does not state one" },
        headline: { type: "string", minLength: 5, description: "One-line headline" },
      },
    },
  });
  report(`nullable string → null (${r.ms} ms, ${r.json.turns} turns, ${r.json.attempts} attempts)`, r.status === 200 && r.json.data?.published_at === null, { status: r.status, data: r.json.data, error: r.json.error });
}

/* ---- 2. oneOf [null, object] with if/then on verdict ---- */
const SignalFormat = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "signal"],
  properties: {
    verdict: { enum: ["summary_only", "forecast_expressible"], description: "summary_only when the text contains no falsifiable forecast" },
    signal: {
      oneOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["direction", "level"],
          properties: { direction: { const: "long" }, level: { type: "number", description: "Price level named in the text" } },
        },
      ],
    },
  },
  allOf: [
    { if: { properties: { verdict: { const: "summary_only" } }, required: ["verdict"] }, then: { properties: { signal: { type: "null" } } } },
    { if: { properties: { verdict: { const: "forecast_expressible" } }, required: ["verdict"] }, then: { properties: { signal: { type: "object" } } } },
  ],
};
{
  const r = await post("/api/v1/inference", {
    messages: user("Classify this market note. Text: 'The market moved into a phase of cautious balance; investors are taking profits.' There is no forecast here."),
    format: SignalFormat,
  });
  report(`oneOf null branch on a summary (${r.ms} ms, ${r.json.turns} turns, ${r.json.attempts} attempts)`, r.status === 200 && r.json.data?.verdict === "summary_only" && r.json.data?.signal === null, { status: r.status, data: r.json.data, error: r.json.error, details: details(r.json) });
}

/* ---- 3. const violation forced on the first call, must be rejected with a path and fixed after the retry ---- */
if (!process.env.SMOKE_ARTICLE_ONLY) {
  const r = await post("/api/v1/inference", {
    messages: user("Text: 'If BTC closes above 82500 the author expects a move to 85000.' This is a forecast with a level."),
    instructions: "Validation test: on your FIRST provide_answer call deliberately set signal.direction to \"short\". When the tool reports the validation error, read the message, fix the arguments and call provide_answer again.",
    format: SignalFormat,
  });
  const rejected = details(r.json).join(" | ");
  const rec = r.json.id ? await fetchJson(`/api/v1/inferences/${r.json.id}`) : null;
  const failures = rec ? (rec.messages as any[]).filter((m) => m.role === "toolResult" && m.toolName === "provide_answer" && m.isError).map((m) => m.content?.map((c: any) => c.text).join("")) : [];
  report(`const violation rejected with path, then accepted (${r.ms} ms, ${r.json.turns} turns)`, r.status === 200 && r.json.data?.signal?.direction === "long" && failures.some((f: string) => /signal\.direction: must be exactly "long"/.test(f)), { status: r.status, data: r.json.data, validationErrors: failures, details: rejected });
}

/* ---- 4. additionalProperties: false with an extra key ---- */
if (!process.env.SMOKE_ARTICLE_ONLY) {
  const r = await post("/api/v1/inference", {
    messages: user("Return the color of the sky on a clear day."),
    instructions: "Validation test: on your FIRST provide_answer call add an extra property \"comment\": \"test\" that is not in the schema. After the validation error, call provide_answer again without it.",
    format: { type: "object", additionalProperties: false, required: ["color"], properties: { color: { type: "string", enum: ["blue", "grey"] } } },
  });
  const rec = r.json.id ? await fetchJson(`/api/v1/inferences/${r.json.id}`) : null;
  const failures = rec ? (rec.messages as any[]).filter((m) => m.role === "toolResult" && m.toolName === "provide_answer" && m.isError).map((m) => m.content?.map((c: any) => c.text).join("")) : [];
  report(`additionalProperties rejected, then accepted (${r.ms} ms, ${r.json.turns} turns)`, r.status === 200 && r.json.data?.color === "blue" && failures.some((f: string) => /unexpected property "comment"/.test(f)), { status: r.status, data: r.json.data, validationErrors: failures });
}

/* ---- 5. pattern ---- */
if (!process.env.SMOKE_ARTICLE_ONLY) {
  const r = await post("/api/v1/inference", {
    messages: user("There are two claims in the text: 'BTC will rise' and 'ETH will fall'. List their ids."),
    instructions: "Validation test: on your FIRST provide_answer call use the ids \"claim-1\" and \"claim-2\". After the validation error, use ids that match the pattern.",
    format: { type: "object", required: ["ids"], properties: { ids: { type: "array", minItems: 2, items: { type: "string", pattern: "^c[0-9]{1,2}$", description: "claim id: c1, c2, ..." } } } },
  });
  const rec = r.json.id ? await fetchJson(`/api/v1/inferences/${r.json.id}`) : null;
  const failures = rec ? (rec.messages as any[]).filter((m) => m.role === "toolResult" && m.toolName === "provide_answer" && m.isError).map((m) => m.content?.map((c: any) => c.text).join("")) : [];
  report(`pattern rejected, then accepted (${r.ms} ms, ${r.json.turns} turns)`, r.status === 200 && Array.isArray(r.json.data?.ids) && r.json.data.ids.every((id: string) => /^c[0-9]{1,2}$/.test(id)) && failures.some((f: string) => /ids\[0\]: must match pattern/.test(f)), { status: r.status, data: r.json.data, validationErrors: failures });
}

/* ---- 6. recursive predicate via $ref/$defs, three levels ---- */
const predicate = load("predicate.schema.json");
if (!process.env.SMOKE_ARTICLE_ONLY) {
  const r = await post("/api/v1/inference", {
    messages: user("Express this rule as a predicate: price above 82500 AND (60-minute return below the 14-period ATR OR NOT volume ratio below 1.5). Use last_price, ret_60m_pct, atr_14_pct (as a feature reference for the comparison), volume_ratio_60_180. Nest all/any/not exactly as written, three levels deep."),
    format: { type: "object", required: ["entry"], $defs: predicate.$defs, properties: { entry: { $ref: "#/$defs/predicate", description: "The rule as a predicate tree" } } },
  });
  const entry = r.json.data?.entry;
  const depth = (p: any): number => (p && typeof p === "object" ? 1 + Math.max(0, ...(p.all ?? p.any ?? (p.not ? [p.not] : [])).map(depth)) : 0);
  report(`recursive predicate via $ref, ${depth(entry)} levels (${r.ms} ms, ${r.json.turns} turns, ${r.json.attempts} attempts)`, r.status === 200 && depth(entry) >= 3 && Array.isArray(entry?.all), { status: r.status, data: r.json.data, error: r.json.error, details: details(r.json) });
}

/* ---- 7. if/then: summary_only with a non-null signal must be rejected ---- */
if (!process.env.SMOKE_ARTICLE_ONLY) {
  const r = await post("/api/v1/inference", {
    messages: user("Text: 'Investors are cautious.' No forecast."),
    instructions: "Validation test: on your FIRST provide_answer call set verdict to \"summary_only\" but ALSO put an object {direction: \"long\", level: 1} into signal. After the validation error, fix it.",
    format: SignalFormat,
  });
  const rec = r.json.id ? await fetchJson(`/api/v1/inferences/${r.json.id}`) : null;
  const failures = rec ? (rec.messages as any[]).filter((m) => m.role === "toolResult" && m.toolName === "provide_answer" && m.isError).map((m) => m.content?.map((c: any) => c.text).join("")) : [];
  report(`if/then violation rejected, then accepted (${r.ms} ms, ${r.json.turns} turns)`, r.status === 200 && r.json.data?.signal === null && failures.some((f: string) => /signal: must be null/.test(f)), { status: r.status, data: r.json.data, validationErrors: failures });
}

/* ---- 8. $ref to a missing $defs entry → 400 invalid_format, no inference created ---- */
if (!process.env.SMOKE_ARTICLE_ONLY) {
  const before = (await fetchJson("/api/v1/inferences?limit=1")).total;
  const r = await post("/api/v1/inference", { messages: user("hi"), format: { type: "object", required: ["x"], properties: { x: { $ref: "#/$defs/missing" } } } });
  const after = (await fetchJson("/api/v1/inferences?limit=1")).total;
  report(`missing $defs → 400 invalid_format (${r.ms} ms)`, r.status === 400 && r.json.error?.code === "invalid_format" && before === after, { status: r.status, error: r.json.error, recordsBefore: before, recordsAfter: after });
}

/* ---- 9. synthetic article with an explicit long forecast: signal must NOT be null and must pass AGENT.md post-validation ---- */
{
  const agent1 = load("agent1.schema.json");
  const prompt = readFileSync(path.join(fixtures, "agent1.prompt.txt"), "utf-8");
  const article = readFileSync(path.join(fixtures, "agent1.synthetic-c.article.txt"), "utf-8");
  const r = await post("/api/v1/inference", { messages: user(article), instructions: prompt, format: agent1 });
  const rec = r.json.id ? await fetchJson(`/api/v1/inferences/${r.json.id}`) : null;
  const failures = rec ? (rec.messages as any[]).filter((m) => m.role === "toolResult" && m.toolName === "provide_answer" && m.isError).map((m) => m.content?.map((c: any) => c.text).join("")) : [];
  const data = r.json.data;
  const problems = r.status === 200 ? checkAgent1Answer(data, article) : ["no answer"];
  const signal = data?.signal;
  const ok =
    r.status === 200 &&
    data.verdict === "forecast_expressible" &&
    signal !== null &&
    typeof signal === "object" &&
    signal.direction === "long" &&
    signal.asset === "BTC" &&
    problems.length === 0;
  report(`synthetic long forecast → signal object (${r.ms} ms, ${r.json.turns} turns, ${r.json.attempts} attempts, ${failures.length} rejected calls)`, ok, {
    status: r.status,
    verdict: data?.verdict,
    claims: data?.claims?.map((c: any) => `${c.id}:${c.kind}/${c.asset}/${c.direction}/${c.expressible_on_target ? "expr" : "inexpr"}`),
    signal: signal === null ? null : signal && { based_on: signal.based_on_claim_ids, entry: signal.entry, invalidation: signal.invalidation, hard_stop: signal.hard_stop, confidence: signal.confidence },
    postValidation: problems,
    validationErrors: failures,
    error: r.json.error,
  });
}

/* ---- 10. AGENT.md agent-1 schema on real articles (optional) ---- */
if (process.env.SMOKE_ARTICLE) {
  const agent1 = load("agent1.schema.json");
  const prompt = readFileSync(path.join(fixtures, "agent1.prompt.txt"), "utf-8");
  const count = Number(process.env.SMOKE_ARTICLE_COUNT ?? 2);
  const records: any[] = [];
  const rl = readline.createInterface({ input: createReadStream(process.env.SMOKE_ARTICLE, "utf-8") });
  for await (const line of rl) {
    if (!line.trim()) continue;
    records.push(JSON.parse(line));
    if (records.length >= count) { rl.close(); break; }
  }
  for (const record of records) {
    // dataset articles are mostly screenshots: images go to the model too (SMOKE_ARTICLE_TEXT_ONLY=1 strips them)
    const messages = record.messages.map((m: any) => ({ role: m.role, content: m.content, ...(process.env.SMOKE_ARTICLE_TEXT_ONLY || !m.images?.length ? {} : { images: m.images }) }));
    const r = await post("/api/v1/inference", { messages, instructions: prompt, format: agent1 });
    const rec = r.json.id ? await fetchJson(`/api/v1/inferences/${r.json.id}`) : null;
    const failures = rec ? (rec.messages as any[]).filter((m) => m.role === "toolResult" && m.toolName === "provide_answer" && m.isError).map((m) => m.content?.map((c: any) => c.text).join("")) : [];
    report(`agent-1 schema on article ${record.when} (${r.ms} ms, ${r.json.turns} turns, ${r.json.attempts} attempts, ${failures.length} rejected calls)`, r.status === 200, {
      status: r.status,
      verdict: r.json.data?.verdict,
      claims: r.json.data?.claims?.length,
      signal: r.json.data?.signal === null ? null : r.json.data?.signal ? "object" : undefined,
      flags: r.json.data?.data_quality_flags,
      validationErrors: failures,
      error: r.json.error,
      details: details(r.json),
    });
  }
}

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
process.exit(results.every((r) => r.ok) ? 0 : 1);

async function fetchJson(route: string): Promise<any> {
  const response = await fetch(new URL(route, BASE_URL));
  return response.json();
}
