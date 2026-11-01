import { createHash } from "crypto";
import path from "path";

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
};

/** Strips a `data:*;base64,` prefix, returning the raw base64 payload. */
export const stripDataUrl = (image: string): string =>
  image.startsWith("data:") ? image.slice(image.indexOf(",") + 1) : image;

/** Mime type declared by a data: URL, if any. */
export const dataUrlMime = (image: string): string | null => {
  if (!image.startsWith("data:")) return null;
  const match = /^data:([^;,]+)[;,]/.exec(image);
  return match ? match[1] : null;
};

/** BITMAPINFOHEADER and its relatives: the sizes a real bmp declares at offset 14. */
const BMP_HEADER_SIZES = new Set([12, 40, 52, 56, 64, 108, 124]);

/**
 * Detects an image mime type from magic bytes. Returns null for non-images. The gif and bmp
 * signatures are checked in full: "GIF" and "BM" alone are also how plain text can start.
 */
export const sniffImageMime = (bytes: Uint8Array): string | null => {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61
  ) return "image/gif";
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return "image/webp";
  if (
    bytes.length >= 18 &&
    bytes[0] === 0x42 && bytes[1] === 0x4d &&
    bytes[6] === 0 && bytes[7] === 0 && bytes[8] === 0 && bytes[9] === 0 &&
    bytes[15] === 0 && bytes[16] === 0 && bytes[17] === 0 && BMP_HEADER_SIZES.has(bytes[14])
  ) return "image/bmp";
  return null;
};

export const extensionByMime = (mime: string): string => EXT_BY_MIME[mime] ?? "bin";

export const sha256 = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

export interface DecodedImage {
  bytes: Buffer;
  base64: string;
  mime: string;
}

/** Decodes a base64 or data: URL image, deriving the mime type from the payload. */
export const decodeImage = (image: string, fallbackMime = "image/jpeg"): DecodedImage => {
  const base64 = stripDataUrl(image).replace(/\s+/g, "");
  const bytes = Buffer.from(base64, "base64");
  const mime = sniffImageMime(bytes) ?? dataUrlMime(image) ?? fallbackMime;
  return { bytes, base64, mime };
};

/** Best-effort mime for an arbitrary request file. */
export const guessFileMime = (fileName: string, bytes: Uint8Array): string => {
  const sniffed = sniffImageMime(bytes);
  if (sniffed) return sniffed;
  const ext = path.extname(fileName).slice(1).toLowerCase();
  const known: Record<string, string> = {
    txt: "text/plain",
    md: "text/markdown",
    csv: "text/csv",
    json: "application/json",
    jsonl: "application/x-ndjson",
    html: "text/html",
    xml: "application/xml",
    pdf: "application/pdf",
    zip: "application/zip",
    svg: "image/svg+xml",
  };
  return known[ext] ?? "application/octet-stream";
};
