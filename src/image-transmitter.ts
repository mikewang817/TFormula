import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  kittyTransmitImage,
  kittyTransmitImageChunks,
  kittyTransmitImageFile
} from "./kitty.js";
import type { TerminalPayload } from "./terminal-writer.js";

export type ImageTransmissionMode = "direct" | "temp-file";

export function isGhosttyTerminal(env: NodeJS.ProcessEnv = process.env): boolean {
  const identity = `${env.TERM ?? ""} ${env.TERM_PROGRAM ?? ""}`.toLowerCase();
  return /ghostty/u.test(identity);
}

/** Prefer the local filesystem path on macOS Ghostty; it avoids large APCs. */
export function selectImageTransmissionMode(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): ImageTransmissionMode {
  const remote = Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY || env.MOSH_CONNECTION);
  return platform === "darwin" && isGhosttyTerminal(env) && !remote
    ? "temp-file"
    : "direct";
}

export class KittyImageTransmitter {
  #mode: ImageTransmissionMode;
  #directory?: string;
  readonly #temporaryFileImages = new Set<number>();

  constructor(mode: ImageTransmissionMode) {
    this.#mode = mode;
  }

  get mode(): ImageTransmissionMode {
    return this.#mode;
  }

  /** Fall back when a terminal rejects the local-path transport itself. */
  fallbackToDirect(): boolean {
    if (this.#mode === "direct") return false;
    this.#mode = "direct";
    // All later uploads use direct packets. Late responses for already queued
    // path uploads are handled as ordinary bounded image errors, so retaining
    // every historical id only leaks memory in long-running sessions.
    this.#temporaryFileImages.clear();
    return true;
  }

  /** Whether this id still has an outstanding temporary-file transmission. */
  wasTemporaryFileImage(imageId: number): boolean {
    return this.#temporaryFileImages.has(imageId);
  }

  /** A successful upload response makes any older path error impossible. */
  markImageAccepted(imageId: number): void {
    this.#temporaryFileImages.delete(imageId);
  }

  #writeTemporaryImage(png: Uint8Array, imageId: number): string {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      this.#directory ??= mkdtempSync(join(tmpdir(), "tformula-tty-graphics-protocol-"));
      const path = join(this.#directory, `tty-graphics-protocol-${imageId}.png`);
      try {
        writeFileSync(path, png, { mode: 0o600 });
        return path;
      } catch (error) {
        const missingDirectory = (error as NodeJS.ErrnoException).code === "ENOENT";
        if (!missingDirectory || attempt > 0) throw error;
        // Long-running sessions can outlive an aggressive temporary-directory
        // cleaner. Recreate only our private directory and retry once instead
        // of permanently breaking every later formula upload.
        this.#directory = undefined;
      }
    }
    throw new Error("could not create a temporary image file");
  }

  transmit = (png: Uint8Array, imageId: number): string => {
    if (this.#mode === "direct") return kittyTransmitImage(png, imageId);

    this.#temporaryFileImages.add(imageId);
    try {
      return kittyTransmitImageFile(this.#writeTemporaryImage(png, imageId), imageId);
    } catch (error) {
      this.#temporaryFileImages.delete(imageId);
      throw error;
    }
  };

  /** Direct mode is generated packet-by-packet to bound Base64 peak memory. */
  transmitPayload = (png: Uint8Array, imageId: number): TerminalPayload => {
    return this.#mode === "direct"
      ? kittyTransmitImageChunks(png, imageId)
      : this.transmit(png, imageId);
  };

  async dispose(waitMs = 250): Promise<void> {
    if (!this.#directory) return;
    const directory = this.#directory;
    const deadline = Date.now() + Math.max(0, waitMs);
    try {
      // A stdout flush means the bytes reached the TTY, but Ghostty may still
      // be opening the final t=t file on its parser thread. Give it a short
      // window to consume and delete terminal-owned files before removing
      // leftovers. External cleanup must not make proxy teardown hang.
      while (Date.now() < deadline) {
        let remaining: string[];
        try {
          remaining = readdirSync(directory);
        } catch {
          break;
        }
        if (remaining.length === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      // With t=t the terminal normally removes each file after reading it.
      // The recursive cleanup only catches leftovers from rejected uploads.
      try {
        rmSync(directory, { force: true, recursive: true });
      } catch {
        // Teardown is best effort; an external permission/race error must not
        // leave the interactive proxy waiting forever after its child exits.
      }
      this.#directory = undefined;
      this.#temporaryFileImages.clear();
    }
  }
}
