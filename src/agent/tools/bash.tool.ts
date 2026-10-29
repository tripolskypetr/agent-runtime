import { spawn } from "child_process";
import fs from "fs";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

import { CONFIG } from "../../config.js";
import { getLogger, preview, since, type ScopedLogger } from "../../lib/logger.js";

export const BASH_TOOL = "bash";

const parameters = Type.Object({
  command: Type.String({ description: "Bash command to execute" }),
  timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional)" })),
});

interface BashDetails {
  exitCode: number | null;
  truncated: boolean;
  wallTimeSeconds: number;
}

/**
 * Bash tool modelled after pi's coding-agent bash tool: runs `bash -c` in the
 * workspace, streams combined stdout/stderr, kills the whole process group on
 * timeout or abort and truncates long output for the model.
 */
export const createBashTool = (cwd: string, logger: ScopedLogger = getLogger("tool:bash")): AgentTool<typeof parameters, BashDetails> => ({
  name: BASH_TOOL,
  label: "Bash",
  description:
    `Execute a bash command in the working directory (${cwd}). ` +
    "Use it to list, read, convert and analyse the files of the task, run scripts (python3, jq, etc.) " +
    "or process images with command line tools. stdout and stderr are returned together. " +
    `Output longer than ${CONFIG.BASH_MAX_OUTPUT_LINES} lines or ${Math.round(CONFIG.BASH_MAX_OUTPUT_BYTES / 1024)}KB is truncated, ` +
    "so prefer targeted commands (head, grep, wc) over dumping whole files.",
  parameters,
  executionMode: "sequential",
  execute: async (toolCallId, params, signal, onUpdate) => {
    const log = logger.child(BASH_TOOL);
    if (!fs.existsSync(cwd)) {
      log.error("working directory missing", undefined, { cwd, toolCallId });
      throw new Error(`Working directory does not exist: ${cwd}`);
    }
    const timeoutMs = resolveTimeoutMs(params.timeout);
    const started = Date.now();
    log.debug("spawn", { toolCallId, cwd, command: params.command, timeoutMs: timeoutMs ?? null });

    return new Promise((resolve, reject) => {
      const child = spawn("bash", ["-c", params.command], {
        cwd,
        env: { ...process.env, PWD: cwd },
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });

      const chunks: Buffer[] = [];
      let collected = 0;
      let killedBy: "timeout" | "abort" | null = null;
      let lastUpdate = 0;

      const collect = (chunk: Buffer) => {
        chunks.push(chunk);
        collected += chunk.length;
        const now = Date.now();
        if (onUpdate && now - lastUpdate > 500) {
          lastUpdate = now;
          const { text, truncated } = truncateOutput(Buffer.concat(chunks).toString("utf-8"));
          onUpdate({
            content: [{ type: "text", text }],
            details: { exitCode: null, truncated, wallTimeSeconds: (now - started) / 1000 },
          });
        }
      };
      child.stdout?.on("data", collect);
      child.stderr?.on("data", collect);

      const killTree = () => {
        if (child.pid === undefined) return;
        try {
          if (process.platform !== "win32") {
            process.kill(-child.pid, "SIGKILL");
          } else {
            child.kill("SIGKILL");
          }
        } catch {
          try {
            child.kill("SIGKILL");
          } catch {
            /* already gone */
          }
        }
      };

      const timer = timeoutMs
        ? setTimeout(() => {
            killedBy = "timeout";
            log.warn("timeout, killing process group", { toolCallId, pid: child.pid, timeoutMs, collectedBytes: collected });
            killTree();
          }, timeoutMs)
        : undefined;

      const onAbort = () => {
        killedBy = "abort";
        log.warn("aborted, killing process group", { toolCallId, pid: child.pid, collectedBytes: collected });
        killTree();
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      child.on("error", (error) => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        log.error("spawn failed", error, { toolCallId, command: params.command });
        reject(new Error(`Failed to start bash: ${error.message}`));
      });

      child.on("close", (code, signalName) => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        const wallTimeSeconds = (Date.now() - started) / 1000;
        const output = Buffer.concat(chunks).toString("utf-8");
        const { text, truncated } = truncateOutput(output);
        const exitCode = code ?? (signalName ? 128 + signalNumber(signalName) : null);
        const details: BashDetails = { exitCode, truncated, wallTimeSeconds };
        log.info("exit", {
          toolCallId,
          pid: child.pid,
          exitCode,
          signal: signalName ?? null,
          killedBy,
          durationMs: since(started),
          outputBytes: collected,
          truncated,
          output: preview(output, 500),
        });

        if (killedBy === "abort") {
          resolve({ content: [{ type: "text", text: appendLine(text, "Command aborted") }], details, isError: true });
          return;
        }
        if (killedBy === "timeout") {
          resolve({
            content: [{ type: "text", text: appendLine(text, `Command timed out after ${Math.round((timeoutMs ?? 0) / 1000)} seconds`) }],
            details,
            isError: true,
          });
          return;
        }
        if (exitCode === null) {
          resolve({ content: [{ type: "text", text: appendLine(text, "Command terminated without an exit code") }], details, isError: true });
          return;
        }
        if (exitCode !== 0) {
          resolve({ content: [{ type: "text", text: appendLine(text, `Command exited with code ${exitCode}`) }], details, isError: true });
          return;
        }
        resolve({ content: [{ type: "text", text: text || "(no output)" }], details });
      });
    });
  },
});

const resolveTimeoutMs = (timeoutSeconds: number | undefined): number | undefined => {
  const seconds = timeoutSeconds !== undefined && Number.isFinite(timeoutSeconds) && timeoutSeconds > 0
    ? timeoutSeconds
    : CONFIG.BASH_TIMEOUT_SEC;
  if (!seconds || seconds <= 0) return undefined;
  return Math.min(seconds * 1000, 2 ** 31 - 1);
};

const appendLine = (text: string, line: string) => (text ? `${text.replace(/\n+$/, "")}\n\n${line}` : line);

/** Keeps the tail of the output within the configured line and byte limits. */
export const truncateOutput = (output: string): { text: string; truncated: boolean } => {
  const lines = output.split("\n");
  let truncated = false;
  let kept = lines;
  if (lines.length > CONFIG.BASH_MAX_OUTPUT_LINES) {
    kept = lines.slice(lines.length - CONFIG.BASH_MAX_OUTPUT_LINES);
    truncated = true;
  }
  let text = kept.join("\n");
  if (Buffer.byteLength(text, "utf-8") > CONFIG.BASH_MAX_OUTPUT_BYTES) {
    const buffer = Buffer.from(text, "utf-8");
    text = buffer.subarray(buffer.length - CONFIG.BASH_MAX_OUTPUT_BYTES).toString("utf-8");
    truncated = true;
  }
  if (truncated) {
    const shownFrom = Math.max(1, lines.length - kept.length + 1);
    text = `[Output truncated: showing lines ${shownFrom}-${lines.length} of ${lines.length}]\n${text}`;
  }
  return { text, truncated };
};

const signalNumber = (name: NodeJS.Signals): number => {
  const table: Partial<Record<NodeJS.Signals, number>> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15, SIGSEGV: 11 };
  return table[name] ?? 0;
};
