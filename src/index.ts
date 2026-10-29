import { CONFIG } from "./config.js";
import { closeLogger, getLogger } from "./lib/logger.js";
import { createServer } from "./server.js";

const log = getLogger("main");

const main = async () => {
  log.info("starting", {
    node: process.version,
    pid: process.pid,
    cwd: process.cwd(),
    config: { ...CONFIG, OLLAMA_API_KEY: CONFIG.OLLAMA_API_KEY ? "***" : "" },
  });
  const { app, queue } = await createServer();
  await app.listen({ port: CONFIG.PORT, host: CONFIG.HOST });
  app.log.info(
    { model: CONFIG.OLLAMA_MODEL, host: CONFIG.OLLAMA_HOST, vision: CONFIG.OLLAMA_VISION, think: CONFIG.OLLAMA_THINK ?? "default", data: CONFIG.DATA_DIR, db: CONFIG.DB_PATH, logs: CONFIG.LOGS_DIR },
    "agent-runtime started",
  );
  log.info("listening", { port: CONFIG.PORT, host: CONFIG.HOST, logFile: `${CONFIG.LOGS_DIR}/${CONFIG.LOG_FILE}` });

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    log.info("shutdown", { signal, queueRunning: queue.running, queuePending: queue.pending });
    app.log.info(`${signal} received, shutting down`);
    await app.close();
    await closeLogger();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("unhandledRejection", (reason) => log.error("unhandledRejection", reason));
  process.on("uncaughtException", (error) => {
    log.error("uncaughtException", error);
    void closeLogger().finally(() => process.exit(1));
  });
};

main().catch(async (error) => {
  log.error("startup failed", error);
  console.error(error);
  await closeLogger();
  process.exit(1);
});
