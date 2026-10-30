import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "crypto";

import { CONFIG } from "../config.js";
import type { Database } from "../db/database.js";
import { getLogger, preview, since } from "../lib/logger.js";
import { compileFormat, InvalidFormatError } from "../helpers/schema.js";
import type { SerialQueue } from "../agent/queue.js";
import { runInference } from "../agent/runInference.js";
import { Workspace } from "../agent/workspace.js";
import type { InferenceMode, InferenceRequest, TextRequest } from "../model/Inference.model.js";

export interface InferenceDeps {
  db: Database;
  queue: SerialQueue;
  workspace: Workspace;
}

/** Shared handler: records the request, queues the run and maps the outcome to 200 / 500. */
const handle = async (
  app: FastifyInstance,
  deps: InferenceDeps,
  mode: InferenceMode,
  request: FastifyRequest<{ Body: InferenceRequest | TextRequest }>,
  reply: FastifyReply,
) => {
  const id = randomUUID();
  const body = request.body;
  const modelName = body.model?.trim() || CONFIG.OLLAMA_MODEL;
  const received = Date.now();
  const log = getLogger("inference").child(id);
  if ("format" in body && body.format) {
    try {
      compileFormat(body.format as unknown as Record<string, unknown>);
    } catch (error) {
      if (error instanceof InvalidFormatError) {
        log.warn("request rejected: invalid format", { route: request.url, message: error.message });
        return reply.code(400).send({ status: "error", error: { code: "invalid_format", message: error.message, details: [] } });
      }
      throw error;
    }
  }
  request.log.info({ inference: id, mode }, "inference accepted");
  log.info("request received", {
    mode,
    route: request.url,
    requestId: request.id,
    remote: request.ip,
    model: modelName,
    bodyBytes: request.headers["content-length"] ?? null,
    messages: body.messages.map((m, index) => ({ index, role: m.role, length: m.content.length, images: m.images?.length ?? 0, preview: preview(m.content, 80) })),
    files: (body.files ?? []).map((f) => ({ name: f.name, base64Length: f.content.length })),
    format: "format" in body && body.format ? body.format : null,
    instructions: preview(body.instructions),
    queueAhead: deps.queue.pending,
    queueRunning: deps.queue.running,
  });

  deps.db.createInference({
    id,
    mode,
    model: modelName,
    request: {
      messages: body.messages.map(({ role, content }) => ({ role, content })),
      files: [],
      ...("format" in body && body.format ? { format: body.format } : {}),
      model: modelName,
      ...(body.instructions ? { instructions: body.instructions } : {}),
    },
  });
  log.debug("record created, queued", { ahead: deps.queue.pending });

  const outcome = await deps.queue.run(() => runInference(body, { id, mode, db: deps.db, workspace: deps.workspace, logger: log }), `${mode}:${id}`);
  log.info("response", {
    status: outcome.status,
    httpStatus: outcome.status === "success" ? 200 : 500,
    code: outcome.error?.code,
    attempts: outcome.attempts,
    turns: outcome.turns,
    agentMs: outcome.durationMs,
    totalMs: since(received),
  });

  const common = { id, model: outcome.model, attempts: outcome.attempts, turns: outcome.turns, durationMs: outcome.durationMs };
  if (outcome.status === "success") {
    return reply.code(200).send(
      mode === "text" ? { ...common, status: "success", text: outcome.data } : { ...common, status: "success", data: outcome.data },
    );
  }
  return reply.code(500).send({ ...common, status: "error", error: outcome.error });
};

export const registerInferenceRoutes = (app: FastifyInstance, deps: InferenceDeps) => {
  app.post<{ Body: InferenceRequest }>(
    "/api/v1/inference",
    {
      schema: {
        tags: ["inference"],
        summary: "Run the agent and return a structured answer (generateObject)",
        description:
          "Writes the request files and images into the data workspace, runs the agent (bash, view_image, provide_answer) " +
          "on Ollama and returns the provide_answer arguments validated against `format` (JSON Schema draft 2020-12, see FormatModel). " +
          "A schema that does not compile (e.g. a `$ref` to a missing `$defs` entry) is rejected with 400 `invalid_format` before anything runs. " +
          "Inferences are executed one at a time; the workspace is wiped before and after each one. " +
          "A 500 with an InferenceFailure body is returned when the model did not produce a valid answer; " +
          "every run, successful or not, is stored and visible in the admin UI.",
        body: { $ref: "InferenceRequest#" },
        response: {
          200: { $ref: "InferenceSuccess#" },
          400: { $ref: "InvalidFormat#" },
          500: { $ref: "InferenceFailure#" },
        },
      },
    },
    (request, reply) => handle(app, deps, "object", request, reply),
  );

  app.post<{ Body: TextRequest }>(
    "/api/v1/text",
    {
      schema: {
        tags: ["inference"],
        summary: "Run the agent and return a plain text answer (generateText)",
        description:
          "Same workspace, tools (bash, view_image) and history as /api/v1/inference, but without a schema: " +
          "the text of the agent's final message is returned as is. If the model finishes without text, it is asked again " +
          "up to MAX_ATTEMPTS times; afterwards a 500 with code `empty_answer` is returned.",
        body: { $ref: "TextRequest#" },
        response: {
          200: { $ref: "TextSuccess#" },
          500: { $ref: "InferenceFailure#" },
        },
      },
    },
    (request, reply) => handle(app, deps, "text", request, reply),
  );
};
