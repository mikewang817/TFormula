import { Buffer } from "node:buffer";

interface WritableOutput {
  write(chunk: Uint8Array, callback: (error?: Error | null) => void): boolean;
}

export type TerminalPayloadPart = string | Uint8Array;
export type TerminalPayload = TerminalPayloadPart | Iterable<TerminalPayloadPart>;

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

  enqueue(data: TerminalPayload): void {
    void this.#schedule(data).catch(() => undefined);
  }

  write(data: TerminalPayload, onStart?: () => void): Promise<void> {
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
    create: () => TerminalPayload | undefined
  ): Promise<boolean> {
    const operation = this.#tail.then(async () => {
      if (this.#failure) throw this.#failure;
      const data = create();
      if (data === undefined) return false;
      await this.#writePayload(data);
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

  #schedule(data: TerminalPayload, onStart?: () => void): Promise<void> {
    // Ordinary byte buffers retain the historical snapshot-at-enqueue
    // contract. Iterable packet streams stay lazy so a large direct image is
    // encoded only when its transaction reaches the queue head.
    const queued = data instanceof Uint8Array ? Buffer.from(data) : data;
    const operation = this.#tail.then(async () => {
      if (this.#failure) throw this.#failure;
      onStart?.();
      await this.#writePayload(queued);
    });
    this.#tail = operation.catch((error: unknown) => {
      this.#failure ??= error instanceof Error ? error : new Error(String(error));
    });
    return operation;
  }

  async #writePayload(data: TerminalPayload): Promise<void> {
    const parts: Iterable<TerminalPayloadPart> = typeof data === "string"
      || data instanceof Uint8Array
      ? [data]
      : data;
    for (const part of parts) {
      const bytes = typeof part === "string" ? Buffer.from(part, "utf8") : Buffer.from(part);
      for (let offset = 0; offset < bytes.length; offset += this.#chunkBytes) {
        await this.#writeChunk(bytes.subarray(offset, offset + this.#chunkBytes));
      }
    }
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
