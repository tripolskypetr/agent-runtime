import { DatabaseSync } from "node:sqlite";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

import type {
  AttachmentKind,
  AttachmentMeta,
  InferenceError,
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
}

export class Database {
  private readonly db: DatabaseSync;

  constructor(filePath: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
    this.recoverInterrupted();
  }

  /** Inferences left in `running` state by a previous process crash are marked as errors. */
  private recoverInterrupted() {
    const now = new Date().toISOString();
    const error: InferenceError = {
      code: "internal_error",
      message: "Process restarted while the inference was running",
      details: [],
    };
    this.db
      .prepare(`UPDATE inferences SET status = 'error', finished_at = ?, error_json = ? WHERE status = 'running'`)
      .run(now, JSON.stringify(error));
  }

  public createInference(input: { id?: string; model: string; request: StoredRequest }): string {
    const id = input.id ?? randomUUID();
    this.db
      .prepare(
        `INSERT INTO inferences (id, created_at, status, model, request_json) VALUES (?, ?, 'running', ?, ?)`,
      )
      .run(id, new Date().toISOString(), input.model, JSON.stringify(input.request));
    return id;
  }

  public updateRequest(id: string, request: StoredRequest) {
    this.db.prepare(`UPDATE inferences SET request_json = ? WHERE id = ?`).run(JSON.stringify(request), id);
  }

  public updateProgress(id: string, input: { messages: unknown[]; attempts: number; turns: number }) {
    this.db
      .prepare(`UPDATE inferences SET messages_json = ?, attempts = ?, turns = ? WHERE id = ?`)
      .run(JSON.stringify(input.messages), input.attempts, input.turns, id);
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
    const where = options.status ? `WHERE status = ?` : "";
    const params: (string | number)[] = options.status ? [options.status] : [];
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS count FROM inferences ${where}`).get(...params) as unknown as { count: number }
    ).count;
    const rows = this.db
      .prepare(
        `SELECT i.id, i.created_at, i.finished_at, i.status, i.model, i.attempts, i.turns, i.duration_ms,
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
    return Number(result.changes) > 0;
  }

  public close() {
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
