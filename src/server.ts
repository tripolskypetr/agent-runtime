import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";

import { CONFIG } from "./config.js";
import { Database } from "./db/database.js";
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
  const db = new Database(CONFIG.DB_PATH);
  const queue = new SerialQueue();
  const workspace = new Workspace(CONFIG.DATA_DIR);
  await workspace.reset();

  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "info" },
    bodyLimit: CONFIG.BODY_LIMIT_BYTES,
    requestTimeout: 0,
    keepAliveTimeout: 65_000,
  });

  for (const schema of sharedSchemas) {
    app.addSchema(schema);
  }

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
    db.close();
  });

  return { app, db, queue, workspace };
};
