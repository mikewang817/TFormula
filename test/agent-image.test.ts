import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentImagePreviews, localImageReference } from "../src/agent-image.js";
import { loadSharp } from "../src/sharp-loader.js";
import { TFORMULA_FOCUS_Z_INDEX } from "../src/kitty.js";
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
  it("rasterizes real source pixels into the transmitted PNG instead of a blank canvas", async () => {
    const prepared = await new AgentImagePreviews().prepare(
      join(directory, "sample.png"), 30, 60, 8, capabilities.cell, capabilities.background
    );
    expect(prepared).toBeDefined();
    const sharp = await loadSharp();
    const { data, info } = await sharp(prepared!.png).raw().toBuffer({ resolveWithObject: true });
    expect(info.width).toBe(prepared!.columns * capabilities.cell.width);
    expect(info.height).toBe(prepared!.rows * capabilities.cell.height);
    let hasRedPixel = false;
    for (let offset = 0; offset < data.length; offset += info.channels) {
      if (data[offset] === 255 && data[offset + 1] === 0 && data[offset + 2] === 0) {
        hasRedPixel = true;
        break;
      }
    }
    expect(hasRedPixel).toBe(true);
  });

  it("keeps image canvas padding transparent", async () => {
    const prepared = await new AgentImagePreviews().prepare(
      join(process.cwd(), "assets", "tformula-maxwell.png"),
      30, 60, 8, capabilities.cell, capabilities.background, true
    );
    const sharp = await loadSharp();
    const { data, info } = await sharp(prepared!.png).ensureAlpha().raw()
      .toBuffer({ resolveWithObject: true });
    const corner = ((info.height - 1) * info.width + (info.width - 1)) * 4;
    expect(data[corner + 3]).toBe(0);
  });

  it("keeps the ordinary preview canvas transparent too", async () => {
    const prepared = await new AgentImagePreviews().prepare(
      join(directory, "sample.png"), 30, 80, 3, capabilities.cell, capabilities.background
    );
    expect(prepared).toBeDefined();
    const sharp = await loadSharp();
    const { data, info } = await sharp(prepared!.png).ensureAlpha().raw()
      .toBuffer({ resolveWithObject: true });
    expect(data[3]).toBeGreaterThan(0);
    expect(info.channels).toBe(4);
  });

  it("uses a fixed nearest-ratio terminal-background mask for inline previews", async () => {
    const prepared = await new AgentImagePreviews().prepare(
      join(directory, "sample.png"), 30, 80, 12, capabilities.cell, "#123456", false, 2
    );
    expect(prepared).toMatchObject({ columns: 45, rows: 12 });
    const sharp = await loadSharp();
    const { data, info } = await sharp(prepared!.png).ensureAlpha().raw()
      .toBuffer({ resolveWithObject: true });
    const maskPixel = ((info.height - 1) * info.width + 2 * capabilities.cell.width) * 4;
    expect([...data.subarray(maskPixel, maskPixel + 3)]).toEqual([18, 52, 86]);
    expect(data[maskPixel + 3]).toBe(255);
    const leftMarginPixel = (2 * capabilities.cell.width - 1) * 4;
    expect(data[leftMarginPixel + 3]).toBe(0);
  });

  it("prepares a small preview and a full-viewport focus image", async () => {
    const previews = new AgentImagePreviews();
    const source = join(process.cwd(), "assets", "tformula-maxwell.png");
    const small = await previews.prepare(
      source, 30, 80, 12, capabilities.cell, capabilities.background
    );
    expect(small!.columns).toBeLessThanOrEqual(48);
    expect(small!.rows).toBeLessThanOrEqual(12);
    expect(small!.columns * small!.rows).toBeGreaterThan(24);
    const full = await previews.prepare(
      source, 80, 80, 24, capabilities.cell, capabilities.background, true
    );
    expect(full).toMatchObject({ columns: 80, rows: 24 });
    const sharp = await loadSharp();
    const stats = await sharp(full!.png).stats();
    expect(stats.channels[0]!.max).toBeGreaterThan(100);
  });

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

  it("renders an OpenTUI-style OSC 8 image label whose Markdown markup was concealed", async () => {
    const output: string[] = [];
    const debug: string[] = [];
    const screen = new FormulaScreen({
      cols: 60, rows: 8, cwd: directory, capabilities, scale: 1,
      writeOuter: (data) => output.push(String(data)),
      debug: (message) => debug.push(message)
    });
    try {
      const label = "TFormula 麦克斯韦方程组截图";
      await screen.write(`\x1b]8;;./sample.png\x1b\\${label}\x1b]8;;\x1b\\`);
      expect(debug).toContain(`local image target indexed: img-1 ${join(directory, "sample.png")}`);
      expect(screen.canSkipOutputCheckpoints).toBe(false);
      await screen.flushScan();
      expect(output.join("")).toContain("a=p");
      expect(screen.terminal.buffer.active.getLine(0)?.translateToString(true)).toBe(label);
      expect(screen.recentImages).toHaveLength(1);
      expect(screen.recentImages[0]).toMatchObject({
        id: "img-1", path: join(directory, "sample.png")
      });

      output.length = 0;
      await screen.write("\r\x1b[2KSee \x1b]8;;./sample.png\x1b\\preview\x1b]8;;\x1b\\ here");
      await screen.flushScan();
      expect(output.join("")).toContain("a=d,d=i");
      expect(output.join("")).not.toContain("a=p");
    } finally { screen.dispose(); }
  });

  it("keeps a process-local image id while moving repeated paths to the front", async () => {
    const screen = new FormulaScreen({
      cols: 60, rows: 8, cwd: directory, capabilities, scale: 1,
      writeOuter: () => undefined
    });
    try {
      await screen.write(
        "\x1b]8;;./sample.png\x1b\\first\x1b]8;;\x1b\\"
        + "\r\n\x1b]8;;./second.png\x1b\\second\x1b]8;;\x1b\\"
      );
      await screen.flushScan();
      const first = screen.recentImages.find((entry) => entry.path === join(directory, "sample.png"));
      const second = screen.recentImages.find((entry) => entry.path === join(directory, "second.png"));
      expect(first?.id).toBe("img-1");
      expect(second?.id).toBe("img-2");
      await screen.write("\r\x1b[2K\x1b]8;;./sample.png\x1b\\again\x1b]8;;\x1b\\");
      await screen.flushScan();
      expect(screen.recentImages.map((entry) => entry.id)).toEqual(["img-1", "img-2"]);
      expect(screen.recentImages[0]?.observedAt).toBeGreaterThanOrEqual(second?.observedAt ?? 0);
    } finally { screen.dispose(); }
  });

  it("focuses a linked image even when there is no blank line to borrow", async () => {
    const output: string[] = [];
    const screen = new FormulaScreen({
      cols: 60, rows: 8, cwd: directory, capabilities, scale: 1,
      writeOuter: (data) => output.push(String(data))
    });
    try {
      await screen.write("\x1b]8;;./sample.png\x1b\\preview\x1b]8;;\x1b\\\r\nnext line");
      expect(screen.recentImageCount).toBe(1);
      await screen.flushScan();
      expect(output.join("")).toContain("a=p");

      output.length = 0;
      expect(await screen.focusLatestImage()).toBe(true);
      expect(output.join("")).toContain(`c=60,r=8,C=1,z=${TFORMULA_FOCUS_Z_INDEX}`);
      expect(screen.terminal.buffer.active.getLine(0)?.translateToString(true)).toBe("preview");
      screen.resize(65, 9);
      output.length = 0;
      expect(await screen.refreshFormulaFocus()).toBe(true);
      expect(output.join("")).toContain(`c=65,r=9,C=1,z=${TFORMULA_FOCUS_Z_INDEX}`);

      output.length = 0;
      await screen.closeFormulaFocus();
      expect(output.join("")).toContain("a=d,d=i");
      expect(screen.formulaFocusActive).toBe(false);
    } finally { screen.dispose(); }
  });

  it("focuses an image selected through the OpenCode bridge path", async () => {
    const output: string[] = [];
    const screen = new FormulaScreen({
      cols: 60, rows: 8, cwd: directory, capabilities, scale: 1,
      writeOuter: (data) => output.push(String(data))
    });
    try {
      expect(await screen.focusImagePath(join(directory, "sample.png"))).toBe(true);
      expect(output.join("")).toContain(`z=${TFORMULA_FOCUS_Z_INDEX}`);
      expect(screen.formulaFocusActive).toBe(true);
    } finally {
      await screen.closeFormulaFocus();
      screen.dispose();
    }
  });

  it("reports a missing target once and focuses an earlier valid image", async () => {
    const output: string[] = [];
    const debug: string[] = [];
    const screen = new FormulaScreen({
      cols: 60, rows: 8, cwd: directory, capabilities, scale: 1,
      writeOuter: (data) => output.push(String(data)),
      debug: (message) => debug.push(message)
    });
    try {
      await screen.write(
        "\x1b]8;;./sample.png\x1b\\valid\x1b]8;;\x1b\\"
        + "\x1b[2;1H\x1b]8;;./image.png\x1b\\missing\x1b]8;;\x1b\\"
      );
      await screen.flushScan();
      await screen.flushScan();
      expect(debug.filter((message) => message.includes("ENOENT"))).toHaveLength(1);
      expect(screen.recentImageCount).toBe(2);

      output.length = 0;
      expect(await screen.focusLatestImage()).toBe(true);
      expect(debug).toContainEqual(expect.stringContaining("image focus skipped: ENOENT"));
      expect(output.join("")).toContain(`z=${TFORMULA_FOCUS_Z_INDEX}`);
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
      expect(output.join("")).toContain("a=p");

      output.length = 0;
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
