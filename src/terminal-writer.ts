import { Buffer } from "node:buffer";

interface WritableOutput {
  write(chunk: Uint8Array, callback: (error?: Error | null) => void): boolean;
}

/**
 * Serializes terminal output into bounded writes.
 *
 * A Kitty image upload is a stateful byte stream: text, resize probes, or a
 * second image must never be inserted between its continuation packets.  The
 * queue keeps each submitted value transactional while the bounded writes
 * avoid handing a very large string to a TTY in one operation.
 */
export class TerminalWriter {
  readonly #output: WritableOutput;
  readonly #chunkBytes: number;
  #tail = Promise.resolve();
  #failure?: Error;

  constructor(output: WritableOutput, chunkBytes = 2048) {
    this.#output = output;
    this.#chunkBytes = Math.max(256, Math.floor(chunkBytes));
  }

  enqueue(data: string | Uint8Array): void {
    void this.#schedule(data).catch(() => undefined);
  }

  write(data: string | Uint8Array, onStart?: () => void): Promise<void> {
    return this.#schedule(data, onStart);
  }

  /**
   * Write a transaction only if it is still valid when it reaches the head of
   * the queue.  Resize probes and cell-addressed graphics can become stale
   * while a preceding PNG upload is draining; checking at enqueue time is too
   * early because the real terminal may have changed geometry in between.
   */
  writeIf(
    data: string | Uint8Array,
    canStart: () => boolean
  ): Promise<boolean> {
    return this.writeGenerated(() => canStart() ? data : undefined);
  }

  /** Build bytes only when the transaction reaches the output head. */
  writeGenerated(
    create: () => string | Uint8Array | undefined
  ): Promise<boolean> {
    const operation = this.#tail.then(async () => {
      if (this.#failure) throw this.#failure;
      const data = create();
      if (data === undefined) return false;
      const bytes = Buffer.isBuffer(data)
        ? Buffer.from(data)
        : typeof data === "string"
          ? Buffer.from(data, "utf8")
          : Buffer.from(data);
      for (let offset = 0; offset < bytes.length; offset += this.#chunkBytes) {
        await this.#writeChunk(bytes.subarray(offset, offset + this.#chunkBytes));
      }
      return true;
    });
    this.#tail = operation.then(() => undefined).catch((error: unknown) => {
      this.#failure ??= error instanceof Error ? error : new Error(String(error));
    });
    return operation;
  }

  async flush(): Promise<void> {
    await this.#tail;
    if (this.#failure) throw this.#failure;
  }

  #schedule(data: string | Uint8Array, onStart?: () => void): Promise<void> {
    const bytes = Buffer.isBuffer(data)
      ? Buffer.from(data)
      : typeof data === "string"
        ? Buffer.from(data, "utf8")
        : Buffer.from(data);
    const operation = this.#tail.then(async () => {
      if (this.#failure) throw this.#failure;
      onStart?.();
      for (let offset = 0; offset < bytes.length; offset += this.#chunkBytes) {
        await this.#writeChunk(bytes.subarray(offset, offset + this.#chunkBytes));
      }
    });
    this.#tail = operation.catch((error: unknown) => {
      this.#failure ??= error instanceof Error ? error : new Error(String(error));
    });
    return operation;
  }

  #writeChunk(chunk: Uint8Array): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.#output.write(chunk, (error?: Error | null) => {
          if (error) reject(error);
          else resolve();
        });
      } catch (error) {
        reject(error);
      }
    });
  }
}
