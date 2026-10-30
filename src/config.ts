import path from "path";

const env = (name: string, fallback: string): string => {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
};

const envInt = (name: string, fallback: number): number => {
  const value = Number.parseInt(env(name, String(fallback)), 10);
  return Number.isFinite(value) ? value : fallback;
};

const envBool = (name: string, fallback: boolean): boolean => {
  const value = env(name, fallback ? "1" : "0").toLowerCase();
  return value === "1" || value === "true" || value === "yes";
};

/** Ollama `think` parameter: omitted, boolean, or an effort level for models that support it. */
const parseThink = (raw: string): boolean | "low" | "medium" | "high" | undefined => {
  const value = raw.trim().toLowerCase();
  if (value === "" || value === "default") return undefined;
  if (value === "1" || value === "true" || value === "on") return true;
  if (value === "0" || value === "false" || value === "off") return false;
  if (value === "low" || value === "medium" || value === "high") return value;
  return undefined;
};

const root = process.cwd();

export const CONFIG = {
  /** HTTP server */
  PORT: envInt("PORT", 10050),
  HOST: env("HOST", "0.0.0.0"),
  BODY_LIMIT_BYTES: envInt("BODY_LIMIT_MB", 256) * 1024 * 1024,

  /** Ollama inference (same conventions as json-inference OllamaProvider) */
  OLLAMA_HOST: env("OLLAMA_HOST", "https://ollama.com"),
  OLLAMA_API_KEY: env("OLLAMA_API_KEY", ""),
  OLLAMA_MODEL: env("OLLAMA_MODEL", "gemma4:31b-cloud"),
  OLLAMA_VISION: envBool("OLLAMA_VISION", true),
  OLLAMA_THINK: parseThink(env("OLLAMA_THINK", "")),
  OLLAMA_NUM_CTX: envInt("OLLAMA_NUM_CTX", 0),
  OLLAMA_NUM_PREDICT: envInt("OLLAMA_NUM_PREDICT", 0),
  OLLAMA_TEMPERATURE: env("OLLAMA_TEMPERATURE", ""),

  /** Harness limits */
  MAX_ATTEMPTS: envInt("MAX_ATTEMPTS", 3),
  MAX_TURNS: envInt("MAX_TURNS", 40),
  INFERENCE_TIMEOUT_MS: envInt("INFERENCE_TIMEOUT_MS", 15 * 60 * 1000),
  BASH_TIMEOUT_SEC: envInt("BASH_TIMEOUT_SEC", 120),
  BASH_MAX_OUTPUT_BYTES: envInt("BASH_MAX_OUTPUT_BYTES", 50 * 1024),
  BASH_MAX_OUTPUT_LINES: envInt("BASH_MAX_OUTPUT_LINES", 2000),
  IMAGE_MAX_BYTES: envInt("IMAGE_MAX_BYTES", 20 * 1024 * 1024),
  OUTPUT_FILE_MAX_BYTES: envInt("OUTPUT_FILE_MAX_BYTES", 20 * 1024 * 1024),
  OUTPUT_FILE_MAX_COUNT: envInt("OUTPUT_FILE_MAX_COUNT", 200),

  /** How many levels of local $ref (into $defs) are inlined in the schema shown to the model; 0 = pass $ref/$defs through as written */
  MODEL_SCHEMA_REF_DEPTH: envInt("MODEL_SCHEMA_REF_DEPTH", 3),

  /** Logging: ./logs/debug.log via pinolog; the same records echoed to stdout (LOG_CONSOLE=all|warn|off, default all so `docker logs` shows everything) */
  LOGS_ENABLED: envBool("LOGS_ENABLED", true),
  LOGS_DIR: path.resolve(root, env("LOGS_DIR", "./logs")),
  LOG_FILE: env("LOG_FILE", "debug.log"),
  LOG_CONSOLE: (["all", "warn", "off"].includes(env("LOG_CONSOLE", "all")) ? env("LOG_CONSOLE", "all") : "all") as "all" | "warn" | "off",
  LOG_LEVEL: env("LOG_LEVEL", "info"),

  /** Storage */
  DATA_DIR: path.resolve(root, env("DATA_DIR", "./data")),
  DB_PATH: path.resolve(root, env("DB_PATH", "./storage/agent-runtime.sqlite")),
  SYSTEM_PROMPT_PATH: path.resolve(root, env("SYSTEM_PROMPT_PATH", "./assets/system.mustache")),
  SYSTEM_PROMPT_TEXT_PATH: path.resolve(root, env("SYSTEM_PROMPT_TEXT_PATH", "./assets/system-text.mustache")),
  PUBLIC_DIR: path.resolve(root, env("PUBLIC_DIR", "./public")),
} as const;

export type Config = typeof CONFIG;

export default CONFIG;
