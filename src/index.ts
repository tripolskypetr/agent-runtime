import { CONFIG } from "./config.js";
import { createServer } from "./server.js";

const main = async () => {
  const { app } = await createServer();
  await app.listen({ port: CONFIG.PORT, host: CONFIG.HOST });
  app.log.info(
    { model: CONFIG.OLLAMA_MODEL, host: CONFIG.OLLAMA_HOST, vision: CONFIG.OLLAMA_VISION, think: CONFIG.OLLAMA_THINK ?? "default", data: CONFIG.DATA_DIR, db: CONFIG.DB_PATH },
    "agent-runtime started",
  );

  const shutdown = async (signal: string) => {
    app.log.info(`${signal} received, shutting down`);
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
