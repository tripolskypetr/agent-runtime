import { DatabaseSync } from "node:sqlite";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

import { getLogger } from "../lib/logger.js";
import type {
  AttachmentKind,
  AttachmentMeta,
  InferenceError,
  InferenceMode,
  InferenceRecord,
  InferenceStatus,
  InferenceSummary,
  StoredRequest,
} from "../model/Inference.model.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS inferences (
  id            TEXT PRIMARY KEY,
  created_at    TEXT NOT NULL,
  finished_at   TEXT,
  status        TEXT NOT NULL,
  mode          TEXT NOT NULL DEFAULT 'object',
  model         TEXT NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  turns         INTEGER NOT NULL DEFAULT 0,
  duration_ms   INTEGER,
  request_json  TEXT NOT NULL,
  messages_json TEXT NOT NULL DEFAULT '[]',
  result_json   TEXT,
  error_json    TEXT
);
CREATE INDEX IF NOT EXISTS idx_inferences_created ON inferences(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inferences_status ON inferences(status);

CREATE TABLE IF NOT EXISTS attachments (
  id           TEXT PRIMARY KEY,
  inference_id TEXT NOT NULL REFERENCES inferences(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,
  name         TEXT NOT NULL,
  mime         TEXT NOT NULL,
  size         INTEGER NOT NULL,
  sha256       TEXT NOT NULL,
  data         BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attachments_inference ON attachments(inference_id);
`;

interface InferenceRow {
  id: string;
  created_at: string;
  finished_at: string | null;
  status: InferenceStatus;
  mode: InferenceMode;
  model: string;
  attempts: number;
  turns: number;
  duration_ms: number | null;
  request_json: string;
  messages_json: string;
  result_json: string | null;
  error_json: string | null;
}

interface AttachmentRow {
  id: string;
  inference_id: string;
  kind: AttachmentKind;
  name: string;
  mime: string;
  size: number;
  sha256: string;
}

export interface ListOptions {
  limit: number;
  offset: number;
  status?: InferenceStatus;
  mode?: InferenceMode;
  /** Case-insensitive substring over id, model, request, result and error. */
  q?: string;
}

const log = getLogger("db");

/** Columns the admin search looks into: request_json holds messages, instructions, file names and the schema. */
const SEARCH_COLUMNS = ["id", "model", "request_json", "result_json", "error_json"];

export class Database {
  private readonly db: DatabaseSync;

  constructor(filePath: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const existed = fs.existsSync(filePath);
    this.db = new DatabaseSync(filePath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    // Unicode case folding for the admin search: SQLite's LIKE and lower() fold ASCII only.
    this.db.function("fold", { deterministic: true }, (value) => (typeof value === "string" ? value.toLowerCase() : value));
    this.db.exec(SCHEMA);
    this.migrate();
    this.recoverInterrupted();
    const count = (this.db.prepare(`SELECT COUNT(*) AS count FROM inferences`).get() as unknown as { count: number }).count;
    log.info("opened", { path: filePath, existed, inferences: count, sqlite: (this.db.prepare("select sqlite_version() as v").get() as unknown as { v: string }).v });
  }

  /** Adds columns introduced after the first release to databases created by older versions. */
  private migrate() {
    const columns = (this.db.prepare(`PRAGMA table_info(inferences)`).all() as unknown as { name: string }[]).map((c) => c.name);
    if (!columns.includes("mode")) {
      this.db.exec(`ALTER TABLE inferences ADD COLUMN mode TEXT NOT NULL DEFAULT 'object'`);
      log.info("migrated: added inferences.mode");
    }
  }

  /** Inferences left in `running` state by a previous process crash are marked as errors. */
  private recoverInterrupted() {
    const now = new Date().toISOString();
    const error: InferenceError = {
      code: "internal_error",
      message: "Process restarted while the inference was running",
      details: [],
    };
    const result = this.db
      .prepare(`UPDATE inferences SET status = 'error', finished_at = ?, error_json = ? WHERE status = 'running'`)
      .run(now, JSON.stringify(error));
    if (Number(result.changes) > 0) log.warn("recovered interrupted inferences", { count: Number(result.changes) });
  }

  public createInference(input: { id?: string; mode: InferenceMode; model: string; request: StoredRequest }): string {
    const id = input.id ?? randomUUID();
    this.db
      .prepare(
        `INSERT INTO inferences (id, created_at, status, mode, model, request_json) VALUES (?, ?, 'running', ?, ?, ?)`,
      )
      .run(id, new Date().toISOString(), input.mode, input.model, JSON.stringify(input.request));
    log.debug("createInference", { id, mode: input.mode, model: input.model });
    return id;
  }

  public updateRequest(id: string, request: StoredRequest) {
    const json = JSON.stringify(request);
    this.db.prepare(`UPDATE inferences SET request_json = ? WHERE id = ?`).run(json, id);
    log.debug("updateRequest", { id, bytes: json.length, files: request.files.length, messages: request.messages.length });
  }

  public updateProgress(id: string, input: { messages: unknown[]; attempts: number; turns: number }) {
    const json = JSON.stringify(input.messages);
    this.db
      .prepare(`UPDATE inferences SET messages_json = ?, attempts = ?, turns = ? WHERE id = ?`)
      .run(json, input.attempts, input.turns, id);
    log.debug("updateProgress", { id, attempts: input.attempts, turns: input.turns, messages: input.messages.length, bytes: json.length });
  }

  public finishInference(
    id: string,
    input: {
      status: Exclude<InferenceStatus, "running">;
      messages: unknown[];
      attempts: number;
      turns: number;
      durationMs: number;
      result: unknown | null;
      error: InferenceError | null;
    },
  ) {
    this.db
      .prepare(
        `UPDATE inferences
           SET status = ?, finished_at = ?, messages_json = ?, attempts = ?, turns = ?, duration_ms = ?, result_json = ?, error_json = ?
         WHERE id = ?`,
      )
      .run(
        input.status,
        new Date().toISOString(),
        JSON.stringify(input.messages),
        input.attempts,
        input.turns,
        input.durationMs,
        input.result === null ? null : JSON.stringify(input.result),
        input.error === null ? null : JSON.stringify(input.error),
        id,
      );
    log.debug("finishInference", { id, status: input.status, attempts: input.attempts, turns: input.turns, durationMs: input.durationMs, messages: input.messages.length, errorCode: input.error?.code });
  }

  public addAttachment(input: {
    inferenceId: string;
    kind: AttachmentKind;
    name: string;
    mime: string;
    sha256: string;
    data: Uint8Array;
  }): AttachmentMeta {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO attachments (id, inference_id, kind, name, mime, size, sha256, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.inferenceId, input.kind, input.name, input.mime, input.data.byteLength, input.sha256, input.data);
    log.debug("addAttachment", { id, inferenceId: input.inferenceId, kind: input.kind, name: input.name, mime: input.mime, size: input.data.byteLength });
    return {
      id,
      inferenceId: input.inferenceId,
      kind: input.kind,
      name: input.name,
      mime: input.mime,
      size: input.data.byteLength,
      sha256: input.sha256,
    };
  }

  public listAttachments(inferenceId: string): AttachmentMeta[] {
    const rows = this.db
      .prepare(`SELECT id, inference_id, kind, name, mime, size, sha256 FROM attachments WHERE inference_id = ? ORDER BY rowid`)
      .all(inferenceId) as unknown as AttachmentRow[];
    return rows.map(toAttachmentMeta);
  }

  public getAttachment(inferenceId: string, attachmentId: string): (AttachmentMeta & { data: Uint8Array }) | null {
    const row = this.db
      .prepare(`SELECT id, inference_id, kind, name, mime, size, sha256, data FROM attachments WHERE inference_id = ? AND id = ?`)
      .get(inferenceId, attachmentId) as unknown as (AttachmentRow & { data: Uint8Array }) | undefined;
    if (!row) return null;
    return { ...toAttachmentMeta(row), data: row.data };
  }

  public listInferences(options: ListOptions): { items: InferenceSummary[]; total: number } {
    const conditions: string[] = [];
    const params: (string | number)[] = [];
    if (options.status) {
      conditions.push("status = ?");
      params.push(options.status);
    }
    if (options.mode) {
      conditions.push("mode = ?");
      params.push(options.mode);
    }
    const q = options.q?.trim().toLowerCase();
    if (q) {
      const pattern = `%${q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
      conditions.push(`(${SEARCH_COLUMNS.map((column) => `fold(${column}) LIKE ? ESCAPE '\\'`).join(" OR ")})`);
      params.push(...SEARCH_COLUMNS.map(() => pattern));
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS count FROM inferences ${where}`).get(...params) as unknown as { count: number }
    ).count;
    const rows = this.db
      .prepare(
        `SELECT i.id, i.created_at, i.finished_at, i.status, i.mode, i.model, i.attempts, i.turns, i.duration_ms,
                i.request_json, i.error_json,
                (SELECT COUNT(*) FROM attachments a WHERE a.inference_id = i.id AND a.kind = 'file') AS file_count,
                json_array_length(i.messages_json) AS message_count
           FROM inferences i ${where}
          ORDER BY i.created_at DESC
          LIMIT ? OFFSET ?`,
      )
      .all(...params, options.limit, options.offset) as unknown as (InferenceRow & {
      file_count: number;
      message_count: number;
    })[];
    return {
      total,
      items: rows.map((row) => toSummary(row, row.message_count, row.file_count)),
    };
  }

  public getInference(id: string): InferenceRecord | null {
    const row = this.db.prepare(`SELECT * FROM inferences WHERE id = ?`).get(id) as unknown as InferenceRow | undefined;
    if (!row) return null;
    const attachments = this.listAttachments(id);
    const messages = JSON.parse(row.messages_json) as unknown[];
    return {
      ...toSummary(row, messages.length, attachments.filter((a) => a.kind === "file").length),
      request: JSON.parse(row.request_json) as StoredRequest,
      messages,
      result: row.result_json ? JSON.parse(row.result_json) : null,
      error: row.error_json ? (JSON.parse(row.error_json) as InferenceError) : null,
      attachments,
    };
  }

  public deleteInference(id: string): boolean {
    const result = this.db.prepare(`DELETE FROM inferences WHERE id = ?`).run(id);
    log.debug("deleteInference", { id, deleted: Number(result.changes) > 0 });
    return Number(result.changes) > 0;
  }

  public close() {
    log.info("closed");
    this.db.close();
  }
}

const toAttachmentMeta = (row: AttachmentRow): AttachmentMeta => ({
  id: row.id,
  inferenceId: row.inference_id,
  kind: row.kind,
  name: row.name,
  mime: row.mime,
  size: row.size,
  sha256: row.sha256,
});

const toSummary = (row: InferenceRow, messageCount: number, fileCount: number): InferenceSummary => {
  const error = row.error_json ? (JSON.parse(row.error_json) as InferenceError) : null;
  return {
    id: row.id,
    mode: row.mode ?? "object",
    status: row.status,
    model: row.model,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    attempts: row.attempts,
    turns: row.turns,
    errorCode: error?.code ?? null,
    errorMessage: error?.message ?? null,
    messageCount,
    fileCount,
  };
};
