import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

import { CONFIG } from "../../config.js";
import { mimeByExtension, sniffImageMime } from "../../helpers/images.js";
import { getLogger, type ScopedLogger } from "../../lib/logger.js";
import type { Workspace } from "../workspace.js";

export const VIEW_IMAGE_TOOL = "view_image";

const parameters = Type.Object({
  path: Type.String({ description: "Path of the image relative to the working directory, e.g. images/message_1_0.jpg" }),
});

interface ViewImageDetails {
  path: string;
  mime: string;
  size: number;
}

/**
 * Returns an image from the workspace as image content so a vision model can look at it.
 * When the model has no image input the tool refuses and points the agent to bash.
 */
export const createViewImageTool = (workspace: Workspace, vision: boolean, logger: ScopedLogger = getLogger("tool:view_image")): AgentTool<typeof parameters, ViewImageDetails> => ({
  name: VIEW_IMAGE_TOOL,
  label: "View image",
  description:
    "Look at an image file (jpeg, png, gif, webp) from the working directory. " +
    "Images attached to the task are stored under images/. " +
    (vision
      ? "The picture is shown to you directly."
      : "NOTE: the current model cannot see images, so this tool is unavailable; inspect pictures with bash tools instead."),
  parameters,
  executionMode: "sequential",
  execute: async (toolCallId, params) => {
    const log = logger.child(VIEW_IMAGE_TOOL);
    log.debug("view", { toolCallId, path: params.path, vision });
    if (!vision) {
      log.warn("rejected: model has no image input", { toolCallId, path: params.path });
      throw new Error("The current model has no image input. Process the file with bash instead (e.g. python3, identify).");
    }
    const absolute = workspace.resolve(params.path);
    const stat = await workspace.stat(params.path).catch(() => null);
    if (!stat || !stat.isFile()) {
      log.warn("rejected: file not found", { toolCallId, path: params.path, absolute });
      throw new Error(`File not found: ${params.path}`);
    }
    if (stat.size > CONFIG.IMAGE_MAX_BYTES) {
      log.warn("rejected: image too large", { toolCallId, path: params.path, size: stat.size, limit: CONFIG.IMAGE_MAX_BYTES });
      throw new Error(`Image is too large (${stat.size} bytes, limit ${CONFIG.IMAGE_MAX_BYTES}). Downscale it with bash first.`);
    }
    const bytes = await workspace.read(params.path);
    const mime = sniffImageMime(bytes) ?? mimeByExtension(absolute);
    if (!mime) {
      log.warn("rejected: not an image", { toolCallId, path: params.path, size: stat.size, head: Buffer.from(bytes.subarray(0, 8)).toString("hex") });
      throw new Error(`File is not a supported image: ${params.path}`);
    }
    log.info("image returned to model", { toolCallId, path: params.path, mime, size: stat.size });
    return {
      content: [
        { type: "image", data: bytes.toString("base64"), mimeType: mime },
        { type: "text", text: `Image ${params.path} (${mime}, ${stat.size} bytes)` },
      ],
      details: { path: params.path, mime, size: stat.size },
    };
  },
});
