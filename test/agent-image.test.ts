import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localImageReference } from "../src/agent-image.js";
import { loadSharp } from "../src/sharp-loader.js";
import { FormulaScreen } from "../src/screen.js";

const capabilities = {
  kittyGraphics: true,
  foreground: "#ffffff",
  background: "#202020",
  cell: { width: 9, height: 18, source: "cell-query" as const }
};

let directory: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "tformula-agent-image-"));
  const sharp = await loadSharp();
  await sharp({ create: { width: 360, height: 180, channels: 3, background: "red" } })
    .png().toFile(join(directory, "sample.png"));
});
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

describe("local Agent image overlays", () => {
  it("accepts only standalone local Markdown images, including encoded and file paths", () => {
    expect(localImageReference("![preview](./sample.png)", directory)?.path)
      .toBe(join(directory, "sample.png"));
    expect(localImageReference(`![preview](${pathToFileURL(join(directory, "sample.png"))})`, directory)?.path)
      .toBe(join(directory, "sample.png"));
    expect(localImageReference("![preview](./with%20space.png)", directory)?.path)
      .toBe(join(directory, "with space.png"));
    expect(localImageReference("see ![preview](./sample.png)", directory)).toBeUndefined();
    expect(localImageReference("![preview](https://example.org/sample.png)", directory)).toBeUndefined();
    expect(localImageReference("![preview](./sample.txt)", directory)).toBeUndefined();
  });

  it("places the preview over its source and blank rows without altering terminal text", async () => {
    const output: string[] = [];
    const screen = new FormulaScreen({
      cols: 60, rows: 10, cwd: directory, capabilities, scale: 1,
      writeOuter: (data) => output.push(String(data))
    });
    try {
      const reference = "![preview](./sample.png)";
      await screen.write(`header\r\n${reference}`);
      await screen.flushScan();
      const placed = output.join("");
      expect(placed).toContain("\x1b_Ga=t,");
      expect(placed).toMatch(/\x1b\[2;1H\x1b_Ga=p,[^;]*c=\d+,r=[2-9]/u);
      expect(screen.terminal.buffer.active.getLine(1)?.translateToString(true)).toBe(reference);

      const first = placed.match(/a=p,i=(\d+),p=(\d+)/u)!;
      output.length = 0;
      await screen.flushScan();
      expect(output.join("")).not.toContain("a=p");

      // A TUI can overwrite a borrowed row without a newline. Remove the old
      // pin before it can cover the new text; the reference remains recoverable.
      await screen.write("\x1b[3;1Hnew status");
      await screen.flushScan();
      expect(output.join("")).toContain(`a=d,d=i,i=${first[1]},p=${first[2]}`);
      expect(screen.terminal.buffer.active.getLine(2)?.translateToString(true)).toBe("new status");
    } finally { screen.dispose(); }
  });

  it("leaves references raw when there is no safe canvas or the file is missing", async () => {
    const output: string[] = [];
    const screen = new FormulaScreen({
      cols: 60, rows: 5, cwd: directory, capabilities, scale: 1,
      writeOuter: (data) => output.push(String(data))
    });
    try {
      await screen.write("![preview](./sample.png)\r\noccupied");
      await screen.flushScan();
      expect(output.join("")).not.toContain("a=p");

      await screen.write("\x1b[2J\x1b[H![preview](./missing.png)");
      await screen.flushScan();
      expect(output.join("")).not.toContain("a=p");
      expect(screen.terminal.buffer.active.getLine(0)?.translateToString(true))
        .toBe("![preview](./missing.png)");
    } finally { screen.dispose(); }
  });

  it("ignores fenced examples and reuses uploads after a resize", async () => {
    const output: string[] = [];
    const screen = new FormulaScreen({
      cols: 60, rows: 10, cwd: directory, capabilities, scale: 1,
      writeOuter: (data) => output.push(String(data))
    });
    try {
      await screen.write("```md\r\n![example](./sample.png)\r\n```");
      await screen.flushScan();
      expect(output.join("")).not.toContain("a=p");

      await screen.write("\x1b[2J\x1b[H![preview](./sample.png)");
      await screen.flushScan();
      const first = output.join("").match(/a=p,i=(\d+),p=(\d+)/u)!;
      expect(first).toBeTruthy();
      output.length = 0;
      screen.resize(62, 10);
      await screen.flushScan();
      expect(output.join("")).toContain(`a=d,d=i,i=${first[1]},p=${first[2]}`);
      expect(output.join("")).toContain("a=p");
      expect(output.join("")).not.toContain("a=t");
    } finally { screen.dispose(); }
  });

  it("deletes stale previews when the reference is replaced or the screen is cleared", async () => {
    const output: string[] = [];
    const screen = new FormulaScreen({
      cols: 60, rows: 8, cwd: directory, capabilities, scale: 1,
      writeOuter: (data) => output.push(String(data))
    });
    try {
      await screen.write("![preview](./sample.png)");
      await screen.flushScan();
      const first = output.join("").match(/a=p,i=(\d+),p=(\d+)/u)!;
      output.length = 0;

      await screen.write("\r\x1b[2Kordinary text");
      await screen.flushScan();
      expect(output.join("")).toContain(`a=d,d=i,i=${first[1]},p=${first[2]}`);
      expect(screen.hasTerminalPlacements).toBe(false);

      output.length = 0;
      await screen.write("\x1b[2J\x1b[H![preview](./sample.png)");
      await screen.flushScan();
      expect(output.join("")).toContain("a=t");
      expect(output.join("")).toContain("a=p");
    } finally { screen.dispose(); }
  });
});
