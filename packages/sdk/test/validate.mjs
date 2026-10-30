/* Validator and client-side retry, no server needed: node test/validate.mjs */
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { validateToolArguments, validateAnswer, assertAnswer, validateValue, createClient, generateObject, AgentRuntimeError } from "../build/index.mjs";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "demo", "fixtures");
const load = (name) => JSON.parse(readFileSync(path.join(fixtures, name), "utf-8"));
const agent1 = load("agent1.schema.json");
const results = [];
const check = (name, ok, info) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (info !== undefined) console.log("      " + JSON.stringify(info).slice(0, 300));
  results.push(ok);
};

/* ---- the validator on the AGENT.md fixtures ---- */
for (const name of ["agent1.fixture-a.json", "agent1.fixture-b.json", "agent1.fixture-c.json"]) {
  const r = validateAnswer(load(name), agent1);
  check(`${name} valid`, r.success && r.data.verdict !== undefined, r.error);
}
const c = load("agent1.fixture-c.json");
const bad = (patch) => validateToolArguments({ ...c, signal: { ...c.signal, ...patch } }, agent1);
check("const", /signal\.direction: must be exactly "long"/.test(bad({ direction: "short" }).error), bad({ direction: "short" }).error);
check("pattern", /based_on_claim_ids\[0\]: must match pattern/.test(bad({ based_on_claim_ids: ["claim-1"] }).error), bad({ based_on_claim_ids: ["claim-1"] }).error);
check("$ref enum at depth 3", /signal\.entry\.all\[0\]\.any\[0\]\.not\.feature: must be one of/.test(bad({ entry: { all: [{ any: [{ not: { feature: "rsi", op: "gt", value: 1 } }] }] } }).error));
check("if/then", /signal: must be null/.test(validateToolArguments({ ...c, verdict: "summary_only" }, agent1).error));
check("additionalProperties", /answer: has unexpected property "extra"/.test(validateToolArguments({ ...c, extra: 1 }, agent1).error));
check("nullable", validateToolArguments({ ...c, article: { ...c.article, published_at: null } }, agent1).success && /published_at: must be string or null/.test(validateToolArguments({ ...c, article: { ...c.article, published_at: 1 } }, agent1).error));
check("validateValue unresolvable $ref reported", /unresolvable \$ref/.test(validateValue(1, { $ref: "#/$defs/x" }, "answer") ?? ""));
let thrown = null;
try { assertAnswer({ ...c, verdict: "x" }, agent1); } catch (e) { thrown = e; }
check("assertAnswer throws", thrown instanceof Error && /verdict: must be one of/.test(thrown.message), thrown?.message);

/* ---- client-side retry with a mocked server ---- */
const format = { type: "object", required: ["direction"], properties: { direction: { const: "long" } } };
const respond = (data) => new Response(JSON.stringify({ id: `inf-${Math.random().toString(36).slice(2, 8)}`, status: "success", data, model: "mock", attempts: 1, turns: 1, durationMs: 10 }), { status: 200, headers: { "content-type": "application/json" } });
let calls = 0;
const flaky = createClient({ baseUrl: "http://mock", fetch: async () => respond(++calls === 1 ? { direction: "short" } : { direction: "long" }) });
const fixed = await flaky.generateObject({ messages: [{ role: "user", content: "x" }], format });
check("retry: second inference accepted after a client-side rejection", fixed.direction === "long" && calls === 2, { calls, fixed });

calls = 0;
const broken = createClient({ baseUrl: "http://mock", maxAttempts: 2, fetch: async () => (calls++, respond({ direction: "short" })) });
const failure = await broken.inference({ messages: [{ role: "user", content: "x" }], format });
check("retry exhausted: inference() returns schema_mismatch with per-attempt details", failure.status === "error" && failure.error.code === "schema_mismatch" && failure.error.details.length === 2 && failure.attempts === 2 && calls === 2, failure.error);
let error = null;
try { await broken.generateObject({ messages: [{ role: "user", content: "x" }], format }); } catch (e) { error = e; }
check("retry exhausted: generateObject() throws AgentRuntimeError schema_mismatch", error instanceof AgentRuntimeError && error.code === "schema_mismatch" && error.details.length === 2, error?.message);

calls = 0;
const off = createClient({ baseUrl: "http://mock", validateAnswer: false, fetch: async () => (calls++, respond({ direction: "short" })) });
const unchecked = await off.generateObject({ messages: [{ role: "user", content: "x" }], format });
check("validateAnswer: false returns the answer as is, one call", unchecked.direction === "short" && calls === 1);

calls = 0;
const viaFunction = await generateObject({ messages: [{ role: "user", content: "x" }], format }, { baseUrl: "http://mock", maxAttempts: 1, validateAnswer: true, fetch: async () => (calls++, respond({ direction: "long" })) });
check("standalone function passes validateAnswer/maxAttempts through", viaFunction.direction === "long" && calls === 1);

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
