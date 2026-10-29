/**
 * End-to-end smoke test against a running agent-runtime.
 *   BASE_URL=http://localhost:8080 npm run smoke
 *   SMOKE_JSONL=/path/to/wwwroot.jsonl npm run smoke   # also runs a real record with photos
 */
import { deflateSync } from "zlib";
import { createReadStream } from "fs";
import readline from "readline";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:8080";

/* ---- minimal PNG encoder (RGB, no deps) ---- */
const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf: Buffer) => {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([len, typeAndData, crc]);
};
const encodePng = (width: number, height: number, pixel: (x: number, y: number) => [number, number, number]) => {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      const offset = y * (width * 3 + 1) + 1 + x * 3;
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
};

/* ---- helpers ---- */
import http from "http";
import https from "https";

/** POST without client-side timeouts: an inference can run for many minutes (Node fetch gives up after 300 s). */
const post = (body: unknown) =>
  new Promise<{ status: number; json: any; ms: number }>((resolve, reject) => {
    const started = Date.now();
    const url = new URL("/api/v1/inference", BASE_URL);
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

const report = (name: string, ok: boolean, info: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  console.log("      " + JSON.stringify(info).slice(0, 600));
  return ok;
};

const results: boolean[] = [];

/* ---- 1. files + bash ---- */
{
  const csv = ["city,amount", "Berlin,120.5", "Paris,340.25", "Madrid,99", "Rome,210"].join("\n");
  const { status, json, ms } = await post({
    messages: [
      {
        role: "user",
        content:
          "The file sales.csv is in your working directory. Compute the total of the amount column, " +
          "the number of data rows (without the header) and the city with the largest amount. Use bash to read the file.",
      },
    ],
    files: [{ name: "sales.csv", content: Buffer.from(csv).toString("base64") }],
    format: {
      type: "object",
      required: ["total", "rows", "topCity", "reasoning"],
      properties: {
        total: { type: "number", description: "Sum of the amount column" },
        rows: { type: "integer", description: "Number of data rows" },
        topCity: { type: "string", description: "City with the largest amount" },
        reasoning: { type: "string", description: "How you computed it" },
      },
    },
  });
  const data = json.data ?? {};
  const ok = status === 200 && Math.abs(data.total - 769.75) < 0.01 && data.rows === 4 && data.topCity === "Paris";
  results.push(report(`csv via bash (${ms} ms, ${json.turns} turns, ${json.attempts} attempts)`, ok, { status, data: json.data, error: json.error }));
}

/* ---- 2. image + view_image ---- */
{
  const png = encodePng(160, 160, (x, y) => {
    const dx = x - 80, dy = y - 80;
    return dx * dx + dy * dy < 50 * 50 ? [220, 30, 30] : [255, 255, 255];
  });
  const { status, json, ms } = await post({
    messages: [
      { role: "user", content: "Look at the attached picture and describe it.", images: [png.toString("base64")] },
    ],
    format: {
      type: "object",
      required: ["color", "shape"],
      properties: {
        color: { type: "string", enum: ["red", "green", "blue", "other"], description: "Dominant color of the figure" },
        shape: { type: "string", enum: ["circle", "square", "triangle", "other"], description: "Shape of the figure" },
      },
    },
  });
  const data = json.data ?? {};
  const ok = status === 200 && data.color === "red" && data.shape === "circle";
  results.push(report(`image via view_image (${ms} ms, ${json.turns} turns)`, ok, { status, data: json.data, error: json.error }));
}

/* ---- 2b. text endpoint (generateText) ---- */
{
  const started = Date.now();
  const response = await new Promise<{ status: number; json: any }>((resolve, reject) => {
    const url = new URL("/api/v1/text", BASE_URL);
    const payload = JSON.stringify({
      messages: [{ role: "user", content: "notes.txt is in your working directory. Read it with bash and answer in one sentence: what is the meeting date and who must attend?" }],
      files: [{ name: "notes.txt", content: Buffer.from("Team sync moved to Thursday, 14 November, 10:00. Mandatory for backend leads (Ivan, Olga).").toString("base64") }],
    });
    const request = (url.protocol === "https:" ? https : http).request(
      url,
      { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }, timeout: 0 },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try { resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString("utf-8")) }); } catch (e) { reject(e); }
        });
      },
    );
    request.on("error", reject);
    request.end(payload);
  });
  const text = String(response.json.text ?? "");
  const ok = response.status === 200 && /november|14/i.test(text) && /ivan|olga/i.test(text);
  results.push(report(`text via /api/v1/text (${Date.now() - started} ms, ${response.json.turns} turns)`, ok, { status: response.status, text, error: response.json.error }));
}

/* ---- 3. error path: unknown model → 500 with error JSON ---- */
{
  const { status, json, ms } = await post({
    model: "model-that-does-not-exist:latest",
    messages: [{ role: "user", content: "Say hi." }],
    format: { type: "object", required: ["hi"], properties: { hi: { type: "string", description: "greeting" } } },
  });
  const ok = status === 500 && json.status === "error" && typeof json.error?.code === "string" && typeof json.id === "string";
  results.push(report(`unknown model → 500 (${ms} ms)`, ok, { status, error: json.error }));
  if (ok) {
    const record = await (await fetch(`${BASE_URL}/api/v1/inferences/${json.id}`)).json();
    results.push(report("error recorded in admin API", record.status === "error" && record.error?.code === json.error.code, { id: record.id, status: record.status }));
  }
}

/* ---- 4. optional: a real wwwroot.jsonl record with photos ---- */
if (process.env.SMOKE_JSONL) {
  // the file can be hundreds of MB: stream only the first non-empty line
  const line = await new Promise<string>((resolve, reject) => {
    const rl = readline.createInterface({ input: createReadStream(process.env.SMOKE_JSONL!, "utf-8") });
    rl.on("line", (l) => { if (l.trim()) { resolve(l); rl.close(); } });
    rl.on("close", () => reject(new Error("empty jsonl")));
    rl.on("error", reject);
  }).catch((e) => { throw e; });
  const record = JSON.parse(line);
  const { status, json, ms } = await post({
    messages: record.messages,
    format: {
      type: "object",
      required: ["summary", "sentiment", "assets", "imagesDescribed"],
      properties: {
        summary: { type: "string", description: "Краткое содержание обзора, 2-3 предложения" },
        sentiment: { type: "string", enum: ["bullish", "bearish", "neutral"], description: "Общее настроение обзора" },
        assets: { type: "array", items: { type: "string" }, description: "Упомянутые криптоактивы, тикеры" },
        imagesDescribed: { type: "string", description: "Что изображено на приложенных картинках" },
      },
    },
  });
  results.push(report(`wwwroot.jsonl record ${record.id} (${ms} ms, ${json.turns} turns)`, status === 200, { status, data: json.data, error: json.error }));
}

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
