/* Runtime test against a running agent-runtime: BASE_URL=http://localhost:10050 node test/test.mjs */
import { createClient, AgentRuntimeError, encodeFile, defineFormat, generateObject, generateText, DEFAULT_BASE_URL } from "../build/index.mjs";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const cjs = require("../build/index.cjs");
if (typeof cjs.createClient !== "function") throw new Error("commonjs build is broken");

const client = createClient({ baseUrl: process.env.BASE_URL ?? "http://localhost:10050" });
const results = [];
const check = (name, ok, info) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (info !== undefined) console.log("      " + JSON.stringify(info).slice(0, 300));
  results.push(ok);
};

const health = await client.health();
check("health()", health.status === "ok", health);

const csv = ["city,amount", "Berlin,120.5", "Paris,340.25", "Madrid,99", "Rome,210"].join("\n");
const format = defineFormat({
  type: "object",
  required: ["total", "rows", "topCity"],
  properties: {
    total: { type: "number", description: "Sum of the amount column" },
    rows: { type: "integer", description: "Number of data rows" },
    topCity: { type: "string", enum: ["Berlin", "Paris", "Madrid", "Rome"], description: "City with the largest amount" },
  },
});
const answer = await client.generateObject({
  messages: [{ role: "user", content: "sales.csv is in the working directory. Compute the total of amount, the number of data rows and the city with the largest amount. Use bash." }],
  files: [encodeFile("sales.csv", csv)],
  format,
});
check("generateObject()", Math.abs(answer.total - 769.75) < 0.01 && answer.rows === 4 && answer.topCity === "Paris", answer);

const text = await client.generateText({
  messages: [{ role: "user", content: "Answer with exactly one word: what is the capital of France?" }],
});
check("generateText()", /paris/i.test(text), text);

const failure = await client.inference({
  model: "model-that-does-not-exist:latest",
  messages: [{ role: "user", content: "hi" }],
  format: { type: "object", required: ["hi"], properties: { hi: { type: "string", description: "greeting" } } },
});
check("inference() returns typed failure", failure.status === "error" && failure.error.code === "provider_error", failure.error);

let thrown = null;
try {
  await client.generateText({ model: "model-that-does-not-exist:latest", messages: [{ role: "user", content: "hi" }] });
} catch (error) {
  thrown = error;
}
check("generateText() throws AgentRuntimeError", thrown instanceof AgentRuntimeError && thrown.code === "provider_error" && thrown.status === 500, thrown && { code: thrown.code, id: thrown.inferenceId });

let badRequest = null;
try {
  await client.generateText({ messages: [] });
} catch (error) {
  badRequest = error;
}
check("validation error → 400", badRequest instanceof AgentRuntimeError && badRequest.status === 400, badRequest && { status: badRequest.status, message: badRequest.message });

const baseUrl = process.env.BASE_URL ?? DEFAULT_BASE_URL;
const viaFunction = await generateObject(
  { messages: [{ role: "user", content: "Answer with the number 42." }], format: { type: "object", required: ["value"], properties: { value: { type: "integer", description: "The number" } } } },
  { baseUrl },
);
check("generateObject() function with config", viaFunction.value === 42, viaFunction);

process.env.AGENT_RUNTIME_URL = baseUrl;
const viaDefault = await generateText({ messages: [{ role: "user", content: "Answer with exactly one word: what color is the sky on a clear day?" }] });
check("generateText() function without config (AGENT_RUNTIME_URL)", /blue/i.test(viaDefault), viaDefault);
delete process.env.AGENT_RUNTIME_URL;

const SignalFormat = defineFormat({
  type: "object",
  additionalProperties: false,
  required: ["verdict", "published_at", "signal"],
  properties: {
    verdict: { enum: ["summary_only", "forecast_expressible"], description: "summary_only when there is no forecast" },
    published_at: { type: ["string", "null"], description: "ISO-8601 or null when the text has no time" },
    signal: { oneOf: [{ type: "null" }, { type: "object", required: ["direction"], properties: { direction: { const: "long" } } }] },
  },
  allOf: [{ if: { properties: { verdict: { const: "summary_only" } }, required: ["verdict"] }, then: { properties: { signal: { type: "null" } } } }],
});
const roundTrip = await generateObject(
  { messages: [{ role: "user", content: "Text: 'Investors are cautious; the market is balanced.' No forecast, no publication time." }], format: SignalFormat },
  { baseUrl },
);
check("nullable + oneOf round trip (verdict summary_only, signal null, published_at null)", roundTrip.verdict === "summary_only" && roundTrip.signal === null && roundTrip.published_at === null, roundTrip);

let invalidFormat = null;
try {
  await generateObject({ messages: [{ role: "user", content: "hi" }], format: { type: "object", required: ["x"], properties: { x: { $ref: "#/$defs/missing" } } } }, { baseUrl });
} catch (error) {
  invalidFormat = error;
}
check("invalid $ref → AgentRuntimeError 400 invalid_format", invalidFormat instanceof AgentRuntimeError && invalidFormat.status === 400 && invalidFormat.code === "invalid_format", invalidFormat && { status: invalidFormat.status, code: invalidFormat.code, message: invalidFormat.message });

const list = await client.listInferences({ limit: 5, mode: "object" });
check("listInferences()", list.total >= 1 && list.items.every((item) => item.mode === "object"), { total: list.total, first: list.items[0]?.id });

const record = await client.getInference(list.items.find((item) => item.status === "success").id);
check("getInference()", record.status === "success" && Array.isArray(record.messages) && record.messages.length > 0, { id: record.id, messages: record.messages.length, attachments: record.attachments.length });

const fileMeta = record.attachments.find((item) => item.kind === "file");
if (fileMeta) {
  const attachment = await client.getAttachment(record.id, fileMeta.id);
  check("getAttachment()", attachment.data.byteLength === fileMeta.size && Buffer.from(attachment.data).toString("utf-8") === csv, { name: attachment.name, size: attachment.size, mime: attachment.mime });
}

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
