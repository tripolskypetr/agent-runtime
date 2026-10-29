import type { FastifyInstance } from "fastify";

import type { Database } from "../db/database.js";
import type { InferenceMode, InferenceStatus } from "../model/Inference.model.js";

interface ListQuery {
  limit?: number;
  offset?: number;
  status?: InferenceStatus;
  mode?: InferenceMode;
}

export const registerAdminRoutes = (app: FastifyInstance, db: Database) => {
  app.get<{ Querystring: ListQuery }>(
    "/api/v1/inferences",
    {
      schema: {
        tags: ["admin"],
        summary: "List inferences, newest first",
        querystring: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 500, default: 50 },
            offset: { type: "integer", minimum: 0, default: 0 },
            status: { type: "string", enum: ["running", "success", "error"] },
            mode: { type: "string", enum: ["object", "text"] },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              total: { type: "integer" },
              items: { type: "array", items: { $ref: "InferenceSummary#" } },
            },
          },
        },
      },
    },
    async (request) =>
      db.listInferences({
        limit: request.query.limit ?? 50,
        offset: request.query.offset ?? 0,
        status: request.query.status,
        mode: request.query.mode,
      }),
  );

  app.get<{ Params: { id: string } }>(
    "/api/v1/inferences/:id",
    {
      schema: {
        tags: ["admin"],
        summary: "Full inference record: request, transcript, result or error, attachments",
        params: { type: "object", properties: { id: { type: "string" } } },
        response: {
          200: { $ref: "InferenceRecord#" },
          404: { type: "object", properties: { message: { type: "string" } } },
        },
      },
    },
    async (request, reply) => {
      const record = db.getInference(request.params.id);
      if (!record) return reply.code(404).send({ message: "Inference not found" });
      return record;
    },
  );

  app.get<{ Params: { id: string; attachmentId: string }; Querystring: { download?: boolean } }>(
    "/api/v1/inferences/:id/attachments/:attachmentId",
    {
      schema: {
        tags: ["admin"],
        summary: "Raw bytes of an attachment (request file, image, tool image or produced file)",
        params: { type: "object", properties: { id: { type: "string" }, attachmentId: { type: "string" } } },
        querystring: { type: "object", properties: { download: { type: "boolean", default: false } } },
        produces: ["application/octet-stream", "image/*"],
      },
    },
    async (request, reply) => {
      const attachment = db.getAttachment(request.params.id, request.params.attachmentId);
      if (!attachment) return reply.code(404).send({ message: "Attachment not found" });
      const disposition = request.query.download ? "attachment" : "inline";
      const fileName = attachment.name.split("/").pop() ?? "file";
      return reply
        .header("Content-Type", attachment.mime)
        .header("Content-Length", attachment.size)
        .header("Content-Disposition", `${disposition}; filename*=UTF-8''${encodeURIComponent(fileName)}`)
        .header("Cache-Control", "private, max-age=31536000, immutable")
        .send(Buffer.from(attachment.data));
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/v1/inferences/:id",
    {
      schema: {
        tags: ["admin"],
        summary: "Delete an inference and its attachments",
        params: { type: "object", properties: { id: { type: "string" } } },
        response: {
          200: { type: "object", properties: { ok: { type: "boolean" } } },
          404: { type: "object", properties: { message: { type: "string" } } },
        },
      },
    },
    async (request, reply) => {
      if (!db.deleteInference(request.params.id)) return reply.code(404).send({ message: "Inference not found" });
      return { ok: true };
    },
  );
};
