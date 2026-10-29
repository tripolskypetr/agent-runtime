/**
 * Central debug logger: every module writes through here.
 *
 * File: ./logs/debug.log via pinolog (pino + rotating-file-stream, rotated at 100 MB),
 * one JSON line per record: { logLevel, createdAt, args: [scope, message, data] }.
 * Console: warn/error always, everything when LOG_CONSOLE=all, nothing when LOG_CONSOLE=off.
 *
 * Data is sanitized before it is written: secrets are masked, long strings
 * (base64 images, prompts) are truncated, Errors are flattened, depth is limited.
 */
import { createLogger, type ILogger } from "pinolog";
import { CONFIG } from "../config.js";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogData = Record<string, unknown> | undefined;

const SECRET_KEYS = /^(apikey|api_key|authorization|ollama_api_key|token|password|secret)$/i;
const MAX_STRING = 2000;
const MAX_DEPTH = 6;
const MAX_ARRAY = 50;
const MAX_KEYS = 100;

let file: ILogger | null = null;
const getFile = (): ILogger | null => {
  if (!CONFIG.LOGS_ENABLED) return null;
  if (!file) file = createLogger(CONFIG.LOG_FILE, CONFIG.LOGS_DIR);
  return file;
};

/** Makes any value safe and compact for the log: masks secrets, truncates, flattens errors. */
export const sanitize = (value: unknown, depth = 0, key = ""): unknown => {
  if (SECRET_KEYS.test(key) && value) return "***";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…<${value.length} chars>` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return `[function ${value.name || "anonymous"}]`;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
      ...(typeof (value as { code?: unknown }).code !== "undefined" ? { code: (value as { code?: unknown }).code } : {}),
      ...(typeof (value as { status_code?: unknown }).status_code !== "undefined" ? { status_code: (value as { status_code?: unknown }).status_code } : {}),
      ...(typeof (value as { cause?: unknown }).cause !== "undefined" ? { cause: sanitize((value as { cause?: unknown }).cause, depth + 1) } : {}),
    };
  }
  if (value instanceof Uint8Array) return `<bytes ${value.byteLength}>`;
  if (value instanceof Date) return value.toISOString();
  if (depth >= MAX_DEPTH) return "[depth limit]";
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY).map((item) => sanitize(item, depth + 1));
    return value.length > MAX_ARRAY ? [...items, `…<${value.length - MAX_ARRAY} more>`] : items;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>);
    for (const [k, v] of entries.slice(0, MAX_KEYS)) out[k] = sanitize(v, depth + 1, k);
    if (entries.length > MAX_KEYS) out["…"] = `<${entries.length - MAX_KEYS} more keys>`;
    return out;
  }
  return String(value);
};

const toConsole = (level: LogLevel, scope: string, message: string, data: unknown) => {
  const mode = CONFIG.LOG_CONSOLE;
  if (mode === "off") return;
  if (mode === "warn" && level !== "warn" && level !== "error") return;
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${scope}: ${message}`;
  const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  data === undefined ? fn(line) : fn(line, JSON.stringify(data));
};

const write = (level: LogLevel, scope: string, message: string, data?: LogData) => {
  const safe = data === undefined ? undefined : sanitize(data);
  toConsole(level, scope, message, safe);
  const target = getFile();
  if (!target) return;
  const args = safe === undefined ? [scope, message] : [scope, message, safe];
  switch (level) {
    case "debug":
      target.log(...args);
      break;
    case "info":
      target.info(...args);
      break;
    case "warn":
      target.warn(...args);
      break;
    case "error":
      target.error(...args);
      break;
  }
};

export interface ScopedLogger {
  readonly scope: string;
  debug(message: string, data?: LogData): void;
  info(message: string, data?: LogData): void;
  warn(message: string, data?: LogData): void;
  error(message: string, error?: unknown, data?: LogData): void;
  /** Child logger whose scope is `parent:child`, e.g. per inference id. */
  child(scope: string): ScopedLogger;
}

/** Creates a logger bound to a scope (module or inference id). */
export const getLogger = (scope: string): ScopedLogger => ({
  scope,
  debug: (message, data) => write("debug", scope, message, data),
  info: (message, data) => write("info", scope, message, data),
  warn: (message, data) => write("warn", scope, message, data),
  error: (message, error, data) => write("error", scope, message, { ...(data ?? {}), ...(error === undefined ? {} : { error }) }),
  child: (child) => getLogger(`${scope}:${child}`),
});

/** Flushes and closes the file transport; call on shutdown. */
export const closeLogger = async () => {
  if (!file) return;
  const current = file;
  file = null;
  await current.destroy().catch(() => undefined);
};

/** Milliseconds since `started`, rounded, for duration fields. */
export const since = (started: number) => Date.now() - started;

/** Short preview of a long text for log lines. */
export const preview = (text: string | undefined | null, max = 200): string => {
  if (!text) return "";
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

export default getLogger;
