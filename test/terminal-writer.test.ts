import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { TerminalControlGate } from "../src/terminal-output.js";
import { TerminalWriter } from "../src/terminal-writer.js";

describe("TerminalWriter", () => {
  it("runs an onStart hook only when the queued transaction begins", async () => {
    const events: string[] = [];
    const output = {
      write(chunk: Uint8Array, callback: (error?: Error | null) => void): boolean {
        events.push(Buffer.from(chunk).toString("utf8"));
        callback();
        return true;
      }
    };
    const writer = new TerminalWriter(output, 256);
    const first = writer.write("first");
    const second = writer.write("second", () => events.push("start-second"));
    await Promise.all([first, second]);
    expect(events).toEqual(["first", "start-second", "second"]);
  });

  it("builds or cancels a generated transaction only at the queue head", async () => {
    const events: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const output = {
      write(chunk: Uint8Array, callback: (error?: Error | null) => void): boolean {
        const value = Buffer.from(chunk).toString("utf8");
        events.push(value);
        if (value === "first") releaseFirst = callback;
        else callback();
        return true;
      }
    };
    const writer = new TerminalWriter(output, 256);
    const first = writer.write("first");
    let current = "old";
    const generated = writer.writeGenerated(() => {
      events.push("generate");
      return current;
    });
    const cancelled = writer.writeIf("stale", () => false);

    await new Promise((resolve) => setTimeout(resolve, 0));
    current = "new";
    expect(events).toEqual(["first"]);
    releaseFirst?.();

    await expect(generated).resolves.toBe(true);
    await expect(cancelled).resolves.toBe(false);
    await first;
    expect(events).toEqual(["first", "generate", "new"]);
  });

  it("keeps concurrent terminal transactions ordered under backpressure", async () => {
    const chunks: Buffer[] = [];
    const output = new Writable({
      highWaterMark: 1,
      write(chunk: Buffer, _encoding, callback) {
        setTimeout(() => {
          chunks.push(Buffer.from(chunk));
          callback();
        }, 1);
      }
    });
    const writer = new TerminalWriter(output, 1024);
    const first = "A".repeat(5000);
    const second = "B".repeat(5000);

    await Promise.all([writer.write(first), writer.write(second)]);
    await writer.flush();

    expect(chunks.every((chunk) => chunk.length <= 1024)).toBe(true);
    expect(Buffer.concat(chunks).toString("utf8")).toBe(first + second);
  });

  it("preserves UTF-8 bytes even when a write boundary splits a character", async () => {
    const chunks: Buffer[] = [];
    const output = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      }
    });
    const writer = new TerminalWriter(output, 256);
    const text = `${"x".repeat(255)}数学公式`;

    await writer.write(text);
    await writer.flush();

    expect(Buffer.concat(chunks).toString("utf8")).toBe(text);
  });

  it("never interleaves concurrent Kitty-style multi-packet transactions", async () => {
    const chunks: Buffer[] = [];
    let writeIndex = 0;
    const output = new Writable({
      highWaterMark: 1,
      write(chunk: Buffer, _encoding, callback) {
        const delay = (writeIndex++ % 3) + 1;
        setTimeout(() => {
          chunks.push(Buffer.from(chunk));
          callback();
        }, delay);
      }
    });
    const writer = new TerminalWriter(output, 256);
    const transactions = Array.from({ length: 30 }, (_, index) =>
      `\x1b_Gi=${index},m=1;${String(index).padStart(2, "0").repeat(200)}\x1b\\`
      + `\x1b_Gm=0;${String(index).padStart(2, "0").repeat(200)}\x1b\\`
    );

    await Promise.all(transactions.map((transaction) => writer.write(transaction)));
    expect(Buffer.concat(chunks).toString("utf8")).toBe(transactions.join(""));
  });

  it("streams iterable packets lazily while retaining transaction ordering", async () => {
    const events: string[] = [];
    const output = {
      write(chunk: Uint8Array, callback: (error?: Error | null) => void): boolean {
        events.push(Buffer.from(chunk).toString("utf8"));
        callback();
        return true;
      }
    };
    const writer = new TerminalWriter(output, 256);
    function* packets(): Generator<string> {
      events.push("generate-1");
      yield "packet-1";
      events.push("generate-2");
      yield "packet-2";
    }

    const first = writer.write("first");
    const streamed = writer.write(packets());
    const last = writer.write("last");
    expect(events).toEqual([]);
    await Promise.all([first, streamed, last]);

    expect(events).toEqual([
      "first",
      "generate-1",
      "packet-1",
      "generate-2",
      "packet-2",
      "last"
    ]);
  });

  it("copies queued bytes and surfaces a poisoned output queue on flush", async () => {
    const received: Buffer[] = [];
    let writes = 0;
    const output = {
      write(chunk: Uint8Array, callback: (error?: Error | null) => void): boolean {
        writes += 1;
        if (writes === 2) callback(new Error("terminal closed"));
        else {
          received.push(Buffer.from(chunk));
          callback();
        }
        return true;
      }
    };
    const writer = new TerminalWriter(output, 256);
    const mutable = Buffer.from("A".repeat(300));
    const failed = writer.write(mutable);
    mutable.fill(0x42);

    await expect(failed).rejects.toThrow("terminal closed");
    await expect(writer.write("later")).rejects.toThrow("terminal closed");
    await expect(writer.flush()).rejects.toThrow("terminal closed");
    expect(received[0]?.toString("utf8")).toBe("A".repeat(256));
  });

  it("cannot insert a formula transaction into a child APC split by the PTY", async () => {
    const chunks: Buffer[] = [];
    const output = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      }
    });
    const writer = new TerminalWriter(output, 256);
    const gate = new TerminalControlGate();
    const childPacket = `\x1b_Gi=7,m=0;${"QUJD".repeat(500)}\x1b\\`;
    const formulaPacket = "\x1b_Gi=1400000000,m=0;UE5H\x1b\\";

    await writer.write(gate.push(childPacket.slice(0, 700)));
    await writer.write(formulaPacket);
    await writer.write(gate.push(childPacket.slice(700)));
    await writer.flush();

    // The child introducer was withheld, so the complete formula transaction
    // precedes the complete child packet instead of appearing inside it.
    expect(Buffer.concat(chunks).toString("utf8")).toBe(formulaPacket + childPacket);
  });
});
