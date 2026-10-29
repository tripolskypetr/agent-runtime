import type { RequestFile, RequestMessage } from "../model/Api.model.js";

const toBase64 = (data: Uint8Array | string): string =>
  typeof data === "string" ? Buffer.from(data, "utf-8").toString("base64") : Buffer.from(data).toString("base64");

/** Builds a request file from raw bytes or a UTF-8 string. */
export const encodeFile = (name: string, data: Uint8Array | string): RequestFile => ({
  name,
  content: toBase64(data),
});

/** Encodes image bytes (jpeg, png, gif, webp) as the base64 string expected in `messages[].images`. */
export const encodeImage = (data: Uint8Array): string => toBase64(data);

/** Shorthand for a user message with optional image attachments. */
export const userMessage = (content: string, images?: Uint8Array[]): RequestMessage => ({
  role: "user",
  content,
  ...(images?.length ? { images: images.map(encodeImage) } : {}),
});
