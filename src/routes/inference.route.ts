import type { FastifyInstance } from "fastify";
import { randomUUID } from "crypto";

import { CONFIG } from "../config.js";
import type { Database } from "../db/database.js";
import type { SerialQueue } from "../agent/queue.js";
import { runInference } from "../agent/runInference.js";
import { Workspace } from "../agent/workspace.js";
import type { InferenceRequest } from "../model/Inference.model.js";

export interface InferenceDeps {
  db: Database;
  queue: SerialQueue;
  workspace: Workspace;
}

export const registerInferenceRoutes = (app: FastifyInstance, deps: InferenceDeps) => {
  app.post<{ Body: InferenceRequest }>(
    "/api/v1/inference",
    {
      schema: {
        tags: ["inference"],
        summary: "Run the agent and return a structured answer",
        description:
          "Writes the request files and images into the data workspace, runs the agent (bash, view_image, provide_answer) " +
          "on Ollama and returns the provide_answer arguments validated against `format`. " +
          "Inferences are executed one at a time; the workspace is wiped before and after each one. " +
          "A 500 with an InferenceFailure body is returned when the model did not produce a valid answer; " +
          "every run, successful or not, is stored and visible in the admin UI.",
        body: { $ref: "InferenceRequest#" },
        response: {
          200: { $ref: "InferenceSuccess#" },
          500: { $ref: "InferenceFailure#" },
        },
      },
    },
    async (request, reply) => {
      const id = randomUUID();
      const body = request.body;
      const modelName = body.model?.trim() || CONFIG.OLLAMA_MODEL;
      const log = (message: string, data?: unknown) =>
        data === undefined ? app.log.info({ inference: id }, message) : app.log.info({ inference: id, data }, message);

      deps.db.createInference({
        id,
        model: modelName,
        request: {
          messages: body.messages.map(({ role, content }) => ({ role, content })),
          files: [],
          format: body.format,
          model: modelName,
          ...(body.instructions ? { instructions: body.instructions } : {}),
        },
      });
      log(`queued (${deps.queue.pending} ahead)`);

      const outcome = await deps.queue.run(() =>
        runInference(body, { id, db: deps.db, workspace: deps.workspace, log }),
      );

      if (outcome.status === "success") {
        return reply.code(200).send({
          id,
          status: "success",
          data: outcome.data,
          model: outcome.model,
          attempts: outcome.attempts,
          turns: outcome.turns,
          durationMs: outcome.durationMs,
        });
      }
      return reply.code(500).send({
        id,
        status: "error",
        error: outcome.error,
        model: outcome.model,
        attempts: outcome.attempts,
        turns: outcome.turns,
        durationMs: outcome.durationMs,
      });
    },
  );
};
