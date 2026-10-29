import type { AttachmentKind, AttachmentMeta } from "../model/Inference.model.js";
import { decodeImage, extensionByMime, sha256 } from "./images.js";

export interface ImageSink {
  /** Stores an image once (deduplicated by content hash) and returns its attachment id. */
  store(input: { base64: string; mime: string; kind: AttachmentKind; name: string }): AttachmentMeta;
}

/**
 * Deep-copies an agent transcript replacing every inline image
 * `{ type: "image", data, mimeType }` with `{ type: "image", attachmentId, mimeType }`
 * so the stored history stays small and the admin UI can load images lazily.
 */
export const externalizeImages = (messages: unknown[], sink: ImageSink, kind: AttachmentKind = "tool_image"): unknown[] => {
  let counter = 0;
  const visit = (value: unknown, pathHint: string): unknown => {
    if (Array.isArray(value)) {
      return value.map((item, index) => visit(item, `${pathHint}_${index}`));
    }
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (record.type === "image" && typeof record.data === "string") {
        const mime = typeof record.mimeType === "string" ? record.mimeType : "image/jpeg";
        const meta = sink.store({
          base64: record.data,
          mime,
          kind,
          name: `${pathHint || "image"}_${counter++}.${extensionByMime(mime)}`,
        });
        return { type: "image", attachmentId: meta.id, mimeType: meta.mime, size: meta.size };
      }
      const copy: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(record)) {
        copy[key] = visit(item, key === "content" ? pathHint : key);
      }
      return copy;
    }
    return value;
  };
  return messages.map((message, index) => visit(message, `message_${index}`));
};

/**
 * Creates an image sink bound to one inference. Identical images (same bytes)
 * are stored once even when they appear in several transcript snapshots.
 */
export const createImageSink = (
  addAttachment: (input: { kind: AttachmentKind; name: string; mime: string; sha256: string; data: Uint8Array }) => AttachmentMeta,
): ImageSink & { known: Map<string, AttachmentMeta> } => {
  const known = new Map<string, AttachmentMeta>();
  return {
    known,
    store({ base64, mime, kind, name }) {
      const decoded = decodeImage(base64, mime);
      const hash = sha256(decoded.bytes);
      const existing = known.get(hash);
      if (existing) return existing;
      const meta = addAttachment({ kind, name, mime: decoded.mime, sha256: hash, data: decoded.bytes });
      known.set(hash, meta);
      return meta;
    },
  };
};
