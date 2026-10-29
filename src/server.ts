import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";

import { CONFIG } from "./config.js";
import { Database } from "./db/database.js";
import { getLogger, since } from "./lib/logger.js";
import { SerialQueue } from "./agent/queue.js";
import { Workspace } from "./agent/workspace.js";
import { registerHealthRoutes } from "./routes/health.route.js";
import { registerInferenceRoutes } from "./routes/inference.route.js";
import { registerAdminRoutes } from "./routes/admin.route.js";
import { sharedSchemas } from "./schemas/inference.schema.js";

export interface AppContext {
  app: FastifyInstance;
  db: Database;
  queue: SerialQueue;
  workspace: Workspace;
}

export const createServer = async (): Promise<AppContext> => {
  const log = getLogger("server");
  log.info("creating server", { dbPath: CONFIG.DB_PATH, dataDir: CONFIG.DATA_DIR, publicDir: CONFIG.PUBLIC_DIR, bodyLimitBytes: CONFIG.BODY_LIMIT_BYTES });
  const db = new Database(CONFIG.DB_PATH);
  const queue = new SerialQueue();
  const workspace = new Workspace(CONFIG.DATA_DIR);
  await workspace.reset();

  const app = Fastify({
    logger: { level: CONFIG.LOG_LEVEL },
    bodyLimit: CONFIG.BODY_LIMIT_BYTES,
    requestTimeout: 0,
    keepAliveTimeout: 65_000,
    // `example` is an OpenAPI keyword used for Swagger samples; Ajv must be told to ignore it.
    ajv: { customOptions: { keywords: ["example"] } },
  });

  for (const schema of sharedSchemas) {
    app.addSchema(schema);
  }

  const http = getLogger("http");
  app.addHook("onRequest", async (request) => {
    (request as { startedAt?: number }).startedAt = Date.now();
    http.debug("request", { id: request.id, method: request.method, url: request.url, remote: request.ip, contentLength: request.headers["content-length"] ?? null, userAgent: request.headers["user-agent"] });
  });
  app.addHook("onResponse", async (request, reply) => {
    const startedAt = (request as { startedAt?: number }).startedAt;
    const data = { id: request.id, method: request.method, url: request.url, status: reply.statusCode, durationMs: startedAt ? since(startedAt) : undefined };
    if (reply.statusCode >= 500) http.error("response", undefined, data);
    else if (reply.statusCode >= 400) http.warn("response", data);
    else http.debug("response", data);
  });
  app.addHook("onError", async (request, _reply, error: Error & { statusCode?: number }) => {
    // 4xx are reported by the error handler below; here only genuine handler failures
    if ((error.statusCode ?? 500) >= 500) {
      http.error("handler error", error, { id: request.id, method: request.method, url: request.url });
    }
  });
  app.addHook("onTimeout", async (request) => {
    http.warn("request timeout", { id: request.id, method: request.method, url: request.url });
  });
  app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status >= 500) http.error("unhandled error", error, { id: request.id, method: request.method, url: request.url });
    else http.warn("client error", { id: request.id, method: request.method, url: request.url, status, message: error.message });
    reply.code(status).send({ statusCode: status, error: error.name ?? "Error", message: error.message });
  });

  await app.register(fastifySwagger, {
    openapi: {
      openapi: "3.0.3",
      info: {
        title: "agent-runtime",
        description:
          "REST harness for a pi-based agent on Ollama. POST /api/v1/inference runs the agent with bash, view_image and " +
          "provide_answer tools in an isolated data workspace and returns a JSON answer matching the given schema.",
        version: "0.1.0",
      },
      tags: [
        { name: "inference", description: "Run the agent" },
        { name: "admin", description: "History of inferences (no authentication)" },
        { name: "system", description: "Health" },
      ],
    },
    refResolver: { buildLocalReference: (json) => String(json.$id) },
  });
  await app.register(fastifySwaggerUi, { routePrefix: "/docs" });

  await app.register(fastifyStatic, {
    root: CONFIG.PUBLIC_DIR,
    prefix: "/admin/",
    index: ["index.html"],
    decorateReply: true,
  });

  app.get("/", { schema: { hide: true } }, async (_request, reply) => reply.redirect("/admin/"));
  app.get("/admin", { schema: { hide: true } }, async (_request, reply) => reply.redirect("/admin/"));

  registerHealthRoutes(app, queue);
  registerInferenceRoutes(app, { db, queue, workspace });
  registerAdminRoutes(app, db);

  app.addHook("onClose", async () => {
    log.info("closing: database");
    db.close();
  });

  log.info("server created", { routes: ["/api/v1/inference", "/api/v1/text", "/api/v1/inferences", "/api/v1/health", "/docs", "/admin"] });
  return { app, db, queue, workspace };
};
