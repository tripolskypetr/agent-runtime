import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

import { CONFIG } from "../../config.js";
import { isImageMime, mimeByExtension, sniffImageMime } from "../../helpers/images.js";
import { getLogger, type ScopedLogger } from "../../lib/logger.js";
import type { Workspace } from "../workspace.js";
import { formatSize, truncateHead, type TruncationResult } from "./truncate.js";
import { VIEW_IMAGE_TOOL } from "./viewImage.tool.js";

export const READ_FILE_TOOL = "read_file";

const parameters = Type.Object({
  path: Type.String({ description: "Path of the file relative to the working directory, e.g. notes.txt or data/report.csv" }),
  offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
  limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

interface ReadFileDetails {
  path: string;
  size: number;
  totalLines: number;
  truncation?: TruncationResult;
}

/**
 * Text file reader copied from pi's coding-agent `read` tool
 * (packages/coding-agent/src/core/tools/read.ts): 1-indexed offset/limit, head
 * truncation within READ_MAX_LINES / READ_MAX_BYTES and a continuation notice that
 * names the next offset. Differences from pi: paths are confined to the workspace,
 * images are not attached (that is view_image's job) but refused with a hint, and
 * binary files are refused with a pointer to bash.
 */
export const createReadFileTool = (workspace: Workspace, logger: ScopedLogger = getLogger("tool:read_file")): AgentTool<typeof parameters, ReadFileDetails> => ({
  name: READ_FILE_TOOL,
  label: "Read file",
  description:
    "Read the contents of a text file from the working directory. " +
    `Output is truncated to ${CONFIG.READ_MAX_LINES} lines or ${Math.round(CONFIG.READ_MAX_BYTES / 1024)}KB (whichever is hit first). ` +
    "Use offset/limit for large files. When you need the full file, continue with offset until complete. " +
    `Images are shown with ${VIEW_IMAGE_TOOL}; binary files (pdf, xlsx, archives) are processed with bash.`,
  parameters,
  executionMode: "sequential",
  execute: async (toolCallId, { path, offset, limit }, signal) => {
    const log = logger.child(READ_FILE_TOOL);
    if (signal?.aborted) throw new Error("Operation aborted");
    log.debug("read", { toolCallId, path, offset, limit });
    if (limit !== undefined && limit < 1) {
      log.warn("rejected: invalid limit", { toolCallId, path, limit });
      throw new Error(`limit must be at least 1, got ${limit}`);
    }
    workspace.resolve(path);
    const stat = await workspace.stat(path).catch(() => null);
    if (!stat || !stat.isFile()) {
      log.warn("rejected: file not found", { toolCallId, path });
      throw new Error(`File not found: ${path}`);
    }
    const buffer = await workspace.read(path);
    const mime = sniffImageMime(buffer) ?? mimeByExtension(path);
    if (mime && isImageMime(mime)) {
      log.warn("rejected: image", { toolCallId, path, mime });
      throw new Error(`${path} is an image (${mime}); look at it with ${VIEW_IMAGE_TOOL} instead.`);
    }
    if (buffer.subarray(0, 8192).includes(0)) {
      log.warn("rejected: binary file", { toolCallId, path, size: stat.size });
      throw new Error(`${path} is not a text file (binary content); process it with bash (python3, pdftotext, unzip, …) instead.`);
    }

    // Read text content.
    const textContent = buffer.toString("utf-8");
    const allLines = textContent.split("\n");
    const totalFileLines = allLines.length;
    // Apply offset if specified. Convert from 1-indexed input to 0-indexed array access.
    const startLine = offset ? Math.max(0, offset - 1) : 0;
    const startLineDisplay = startLine + 1;
    // Check if offset is out of bounds.
    if (startLine >= allLines.length) {
      log.warn("rejected: offset beyond end of file", { toolCallId, path, offset, totalLines: allLines.length });
      throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
    }
    let selectedContent: string;
    let userLimitedLines: number | undefined;
    // If limit is specified by the user, honor it first. Otherwise truncateHead decides.
    if (limit !== undefined) {
      const endLine = Math.min(startLine + limit, allLines.length);
      selectedContent = allLines.slice(startLine, endLine).join("\n");
      userLimitedLines = endLine - startLine;
    } else {
      selectedContent = allLines.slice(startLine).join("\n");
    }
    // Apply truncation, respecting both line and byte limits.
    const truncation = truncateHead(selectedContent);
    let outputText: string;
    if (truncation.firstLineExceedsLimit) {
      // First line alone exceeds the byte limit. Point the model at a bash fallback.
      const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine], "utf-8"));
      outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(CONFIG.READ_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' '${path}' | head -c ${CONFIG.READ_MAX_BYTES}]`;
    } else if (truncation.truncated) {
      // Truncation occurred. Build an actionable continuation notice.
      const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
      const nextOffset = endLineDisplay + 1;
      outputText = truncation.content;
      if (truncation.truncatedBy === "lines") {
        outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
      } else {
        outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(CONFIG.READ_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
      }
    } else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
      // User-specified limit stopped early, but the file still has more content.
      const remaining = allLines.length - (startLine + userLimitedLines);
      const nextOffset = startLine + userLimitedLines + 1;
      outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
    } else {
      // No truncation and no remaining user-limited content.
      outputText = truncation.content;
    }

    log.info("file returned to model", {
      toolCallId,
      path,
      size: stat.size,
      totalLines: totalFileLines,
      offset: startLineDisplay,
      limit: limit ?? null,
      outputLines: truncation.outputLines,
      outputBytes: truncation.outputBytes,
      truncatedBy: truncation.truncatedBy,
    });
    return {
      content: [{ type: "text", text: outputText }],
      details: { path, size: stat.size, totalLines: totalFileLines, ...(truncation.truncated ? { truncation } : {}) },
    };
  },
});
