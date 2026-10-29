import type { FastifyInstance } from "fastify";

import { CONFIG } from "../config.js";
import type { SerialQueue } from "../agent/queue.js";

export const registerHealthRoutes = (app: FastifyInstance, queue: SerialQueue) => {
  app.get(
    "/api/v1/health",
    {
      schema: {
        tags: ["system"],
        summary: "Service health and queue state",
        response: { 200: { $ref: "Health#" } },
      },
    },
    async () => ({
      status: "ok",
      model: CONFIG.OLLAMA_MODEL,
      host: CONFIG.OLLAMA_HOST,
      vision: CONFIG.OLLAMA_VISION,
      running: queue.running,
      queued: queue.pending,
      uptimeSeconds: Math.round(process.uptime()),
    }),
  );
};
