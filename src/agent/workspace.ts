import fs from "fs/promises";
import path from "path";

import { CONFIG } from "../config.js";
import { sha256 } from "../helpers/images.js";

/**
 * The data workspace: a single directory that is wiped before every inference,
 * filled with the request files and images, used by the agent through bash and
 * view_image, and snapshotted into the database when the inference ends.
 */
export class Workspace {
  constructor(public readonly root: string = CONFIG.DATA_DIR) {}

  /** Removes everything inside the workspace, keeping the directory itself. */
  public async reset() {
    await fs.mkdir(this.root, { recursive: true });
    const entries = await fs.readdir(this.root);
    await Promise.all(entries.map((entry) => fs.rm(path.join(this.root, entry), { recursive: true, force: true })));
  }

  /**
   * Resolves a user-supplied relative path inside the workspace.
   * Throws when the path escapes the workspace.
   */
  public resolve(relativePath: string): string {
    const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
    const absolute = path.resolve(this.root, normalized);
    const rootWithSep = this.root.endsWith(path.sep) ? this.root : this.root + path.sep;
    if (absolute !== this.root && !absolute.startsWith(rootWithSep)) {
      throw new Error(`Path "${relativePath}" is outside of the workspace`);
    }
    return absolute;
  }

  /** Sanitizes a request file name into a safe relative path (sub directories allowed, `..` dropped). */
  public static safeName(name: string, fallback: string): string {
    const parts = name
      .replace(/\\/g, "/")
      .split("/")
      .map((part) => part.trim())
      .filter((part) => part && part !== "." && part !== "..")
      .map((part) => part.replace(/[^\w.\-()+ ]/g, "_"));
    return parts.length ? parts.join("/") : fallback;
  }

  public async write(relativePath: string, bytes: Uint8Array): Promise<string> {
    const absolute = this.resolve(relativePath);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, bytes);
    return path.relative(this.root, absolute);
  }

  public async read(relativePath: string): Promise<Buffer> {
    return fs.readFile(this.resolve(relativePath));
  }

  public async stat(relativePath: string) {
    return fs.stat(this.resolve(relativePath));
  }

  /** Lists every regular file in the workspace with its relative path. */
  public async listFiles(): Promise<{ path: string; size: number }[]> {
    const result: { path: string; size: number }[] = [];
    const walk = async (dir: string) => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const absolute = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(absolute);
        } else if (entry.isFile()) {
          const { size } = await fs.stat(absolute);
          result.push({ path: path.relative(this.root, absolute), size });
        }
      }
    };
    await walk(this.root);
    return result.sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * Returns files that were created or modified by the agent: everything present
   * at the end that does not match an input file by path and content hash.
   */
  public async collectOutputs(inputs: Map<string, string>): Promise<{ path: string; bytes: Buffer; sha256: string }[]> {
    const files = await this.listFiles();
    const outputs: { path: string; bytes: Buffer; sha256: string }[] = [];
    for (const file of files) {
      if (outputs.length >= CONFIG.OUTPUT_FILE_MAX_COUNT) break;
      if (file.size > CONFIG.OUTPUT_FILE_MAX_BYTES) continue;
      const bytes = await this.read(file.path);
      const hash = sha256(bytes);
      if (inputs.get(file.path) === hash) continue;
      outputs.push({ path: file.path, bytes, sha256: hash });
    }
    return outputs;
  }
}
