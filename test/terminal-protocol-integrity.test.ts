import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { OutputCheckpointSplitter } from "../src/output-checkpoints.js";
import { TerminalControlGate, TerminalOutputTransformer } from "../src/terminal-output.js";
import { TerminalWriter } from "../src/terminal-writer.js";

const mixedTranscript = [
  "plain😀",
  "\x1b[38;2;1;2;3mcolor\x1b[0m",
  "\x1b]0;title with ESC[2J text\x07",
  "\x1bP1;2|dcs payload\x1b\\",
  "\x1b_Gi=7,m=0;QUJDREVGRw==\x1b\\",
  "\u009b?2026hframe\u009b?2026l",
  "\u009d10;rgb:ffff/ffff/ffff\u009c",
  "tail"
].join("");

describe("terminal protocol pipeline integrity", () => {
  it("is byte-transparent with image-preserving rewrites disabled at every split width", () => {
    for (let width = 1; width <= 23; width += 1) {
      const gate = new TerminalControlGate();
      const transformer = new TerminalOutputTransformer();
      let output = "";
      for (let offset = 0; offset < mixedTranscript.length; offset += width) {
        const complete = gate.push(mixedTranscript.slice(offset, offset + width));
        output += transformer.push(complete, false).data;
      }
      output += transformer.flush();
      output += gate.flush();
      expect(output, `split width ${width}`).toBe(mixedTranscript);
    }
  });

  it("never lets checkpoints divide a child APC released by the control gate", () => {
    const gate = new TerminalControlGate();
    const splitter = new OutputCheckpointSplitter(2, 32);
    const packet = `\x1b_Gi=7,m=0;${"QUJD".repeat(2_000)}\x1b\\`;

    expect(splitter.push(gate.push(packet.slice(0, 1_000)))).toEqual([]);
    const slices = splitter.push(gate.push(packet.slice(1_000)));
    expect(slices.map(({ data }) => data).join("")).toBe(packet);
    expect(slices).toHaveLength(1);
    // A checkpoint after ST is safe; the important invariant is that there is
    // no slice boundary between the APC introducer, payload, and terminator.
    expect(slices[0]?.checkpoint).toBe(true);
  });

  it("keeps injected and child graphics transactions separately ordered under backpressure", async () => {
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
    const writer = new TerminalWriter(output, 256);
    const gate = new TerminalControlGate();
    const childPacket = `\x1b_Gi=7,m=0;${"QUJD".repeat(1_000)}\x1b\\`;
    const injected = `\x1b_Gi=1400000000,m=0;${"UE5H".repeat(1_000)}\x1b\\`;

    expect(gate.push(childPacket.slice(0, 777))).toBe("");
    const first = writer.write(injected);
    const second = writer.write(gate.push(childPacket.slice(777)));
    await Promise.all([first, second]);

    expect(Buffer.concat(chunks).toString("utf8")).toBe(injected + childPacket);
  });
});
