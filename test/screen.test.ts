import { describe, expect, it } from "vitest";
import { FormulaScreen } from "../src/screen.js";
import { OutputCheckpointSplitter } from "../src/output-checkpoints.js";
import { MathRenderer } from "../src/math-renderer.js";
import { KittyImageTransmitter } from "../src/image-transmitter.js";
import { TerminalOutputTransformer } from "../src/terminal-output.js";

const capabilities = {
  kittyGraphics: true,
  foreground: "#eaf2f1",
  background: "#282a3a",
  cell: { width: 9, height: 18, source: "cell-query" as const }
};

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for FormulaScreen");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function formulaOutput(): string {
  return [
    "\x1b[2J\x1b[H",
    "\\[\r\nx=1\r\n\\]\r\n",
    "\\[\r\ny=2\r\n\\]\r\n",
    "\\[\r\nz=3\r\n\\]\r\n"
  ].join("");
}

class DelayedMathRenderer extends MathRenderer {
  delay = false;
  fail = false;
  failNext = 0;
  calls = 0;
  started?: () => void;
  release?: () => void;

  override async render(...args: Parameters<MathRenderer["render"]>): ReturnType<MathRenderer["render"]> {
    this.calls += 1;
    if (this.fail) throw new Error("intentional render failure");
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error("intentional one-shot render failure");
    }
    if (this.delay) {
      this.delay = false;
      await new Promise<void>((resolve) => {
        this.release = resolve;
        this.started?.();
      });
    }
    return super.render(...args);
  }
}

class FastMathRenderer extends MathRenderer {
  override async render(
    ...args: Parameters<MathRenderer["render"]>
  ): ReturnType<MathRenderer["render"]> {
    const [region, columns, rows] = args;
    return {
      png: new Uint8Array([137, 80, 78, 71]),
      cacheKey: `${region.display ? "display" : "inline"}:${region.latex}:${columns}:${rows}`,
      columns,
      rows,
      widthPx: columns * 9,
      heightPx: rows * 18
    };
  }
}

describe("FormulaScreen lifecycle", () => {
  it("uses grapheme-aware cell widths like modern Ghostty", async () => {
    const screen = new FormulaScreen({
      cols: 80,
      rows: 4,
      capabilities,
      scale: 1,
      writeOuter: () => undefined
    });
    try {
      await screen.write("😀🧪⚠️👨‍👩‍👧‍👦");
      expect(screen.terminal.buffer.active.cursorX).toBe(8);
    } finally {
      screen.dispose();
    }
  });

  it("cleans orphaned TFormula placements before the first image id is reused", () => {
    const output: string[] = [];
    const screen = new FormulaScreen({
      cols: 80,
      rows: 24,
      capabilities,
      scale: 1,
      writeOuter: (data) => output.push(String(data))
    });
    try {
      expect(output.join("")).toContain("a=d,d=Z,z=20260713");
    } finally {
      screen.dispose();
    }
  });

  it("places a standalone one-line display across a reserved blank row", async () => {
    const output: string[] = [];
    const debug: string[] = [];
    const screen = new FormulaScreen({
      cols: 80,
      rows: 24,
      capabilities,
      scale: 1,
      writeOuter: (data) => output.push(String(data)),
      debug: (message) => debug.push(message)
    });
    try {
      screen.write([
        "\x1b[2J\x1b[H1. Gauss's law",
        "",
        "$$\\nabla \\cdot \\mathbf{E}=\\frac{\\rho}{\\varepsilon_0}$$",
        "Electric field explanation"
      ].join("\r\n"));
      await waitFor(() => debug.some((message) => message.startsWith("rendered ")));
      expect(output.join("")).toContain("c=80,r=2,C=1");
    } finally {
      screen.dispose();
    }
  });

  it("places display math hard-wrapped by a terminal TUI", async () => {
    const output: string[] = [];
    const screen = new FormulaScreen({
      cols: 100,
      rows: 12,
      capabilities,
      scale: 1,
      writeOuter: (data) => output.push(String(data))
    });
    try {
      await screen.write([
        "4. $$\\oint_C \\mathbf{B} \\cdot d\\mathbf{l} = \\mu_0 I_{\\mathrm{enc}} +",
        "\\mu_0\\varepsilon_0\\frac{d}{dt}\\int_S \\mathbf{E} \\cdot d\\mathbf{A}$$",
        "next"
      ].join("\r\n"));
      await screen.flushScan();

      const encoded = output.join("");
      expect(encoded.match(/\x1b_Ga=p/gu)).toHaveLength(1);
      expect(encoded).toContain("c=100,r=2,C=1");
    } finally {
      screen.dispose();
    }
  });

  it("composes inferred inline formulas and literal text as one overlay", async () => {
    const output: string[] = [];
    const screen = new FormulaScreen({
      cols: 100,
      rows: 8,
      capabilities,
      scale: 1,
      writeOuter: (data) => output.push(String(data))
    });
    try {
      await screen.write(
        "其中 (\\mathbf E) 为电场，(\\mathbf B) 为磁感应强度，(\\rho) 为电荷密度"
      );
      await screen.flushScan();

      const encoded = output.join("");
      expect(encoded.match(/\x1b_Ga=p/gu)).toHaveLength(1);
      expect(encoded.match(/\x1b_Ga=t/gu)).toHaveLength(1);
    } finally {
      screen.dispose();
    }
  });

  it("composes explicit inline formulas and literal text as one overlay", async () => {
    const output: string[] = [];
    const screen = new FormulaScreen({
      cols: 180,
      rows: 8,
      capabilities,
      scale: 1,
      writeOuter: (data) => output.push(String(data))
    });
    try {
      await screen.write(
        "其中 \\(\\mathbf E\\) 为电场，\\(\\mathbf B\\) 为磁感应强度，"
        + "\\(\\rho\\) 为电荷密度，\\(\\mathbf J\\) 为电流密度，"
        + "\\(\\varepsilon_0\\)、\\(\\mu_0\\) 分别为真空介电常数与磁导率。"
      );
      await screen.flushScan();

      const encoded = output.join("");
      expect(encoded.match(/\x1b_Ga=p/gu)).toHaveLength(1);
      expect(encoded.match(/\x1b_Ga=t/gu)).toHaveLength(1);
    } finally {
      screen.dispose();
    }
  });

  it("renders adjacent identical displays at one consistent centered size", async () => {
    const output: string[] = [];
    const screen = new FormulaScreen({
      cols: 80,
      rows: 8,
      capabilities,
      scale: 1,
      writeOuter: (data) => output.push(String(data))
    });
    try {
      await screen.write(
        "$$\\frac{1}{x}$$\r\n\r\n$$\\frac{1}{x}$$\r\ndescription"
      );
      await screen.flushScan();
      const encoded = output.join("");
      expect(encoded.match(/a=p,[^;]*c=80,r=1/gu)).toHaveLength(2);
      expect(encoded.match(/\x1b_Ga=t/gu)).toHaveLength(1);
    } finally {
      screen.dispose();
    }
  });

  it("renders every formula while unrelated terminal output keeps changing", async () => {
    const debug: string[] = [];
    const screen = new FormulaScreen({
      cols: 80,
      rows: 24,
      capabilities,
      scale: 1,
      writeOuter: () => undefined,
      debug: (message) => debug.push(message)
    });
    screen.write(formulaOutput());
    let tick = 0;
    const interval = setInterval(() => {
      screen.write(`\x1b[24;1Hstatus ${tick++}`);
    }, 20);

    try {
      await waitFor(() => debug.filter((message) => message.startsWith("rendered ")).length >= 3);
      expect(debug.filter((message) => message.startsWith("rendered "))).toHaveLength(3);
    } finally {
      clearInterval(interval);
      screen.dispose();
    }
  });

  it("does not commit an in-flight scan while the real cursor is catching up", async () => {
    const output: string[] = [];
    const renderer = new DelayedMathRenderer();
    renderer.delay = true;
    let renderStarted!: () => void;
    const started = new Promise<void>((resolve) => { renderStarted = resolve; });
    renderer.started = renderStarted;
    const screen = new FormulaScreen({
      cols: 80,
      rows: 8,
      capabilities,
      scale: 1,
      renderer,
      writeOuter: (data) => output.push(String(data))
    });
    try {
      await screen.write("\\[\r\nx=1\r\n\\]");
      const scanning = screen.flushScan();
      await started;

      // This is the proxy's two-part reservation: one for mirror.write(), and
      // one for the final grapheme which the mirror has previewed but Ghostty
      // has not received yet. An older render must not restore the real cursor
      // using the mirror's post-grapheme position during that interval.
      screen.queueWrite();
      screen.queueWrite();
      await screen.write("\x1b[8;1Hstatus", true);
      renderer.release?.();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(output.join("")).not.toContain("a=p");

      screen.cancelQueuedWrite();
      await scanning;
      await screen.flushScan();
      expect(output.join("")).toContain("a=p");
    } finally {
      renderer.release?.();
      screen.dispose();
    }
  });

  it("places formulas without destroying a held right-margin pending-wrap cell", async () => {
    const output: string[] = [];
    const debug: string[] = [];
    const screen = new FormulaScreen({
      cols: 20,
      rows: 8,
      capabilities,
      scale: 1,
      writeOuter: (data) => output.push(String(data)),
      debug: (message) => debug.push(message)
    });
    try {
      await screen.write(
        "\\[\r\nx=1\r\n\\]\x1b[5;1H12345678901234567890"
      );
      expect(screen.pendingWrap).toBe(true);
      output.length = 0;
      await screen.flushScanBeforeHeldCell();
      expect(output.join("")).toContain("a=p");
      expect(output.join("")).toContain("\x1b[5;20H");
      expect(debug).not.toContain(
        "formula placement deferred while cursor is in pending-wrap state"
      );
    } finally {
      screen.dispose();
    }
  });

  it("restores the cursor before a held double-width right-margin grapheme", async () => {
    const output: string[] = [];
    const screen = new FormulaScreen({
      cols: 20,
      rows: 8,
      capabilities,
      scale: 1,
      writeOuter: (data) => output.push(String(data))
    });
    try {
      await screen.write(
        "\\[\r\nx=1\r\n\\]\x1b[5;1H123456789012345678你"
      );
      expect(screen.pendingWrap).toBe(true);
      output.length = 0;
      await screen.flushScanBeforeHeldCell(2);
      expect(output.join("")).toContain("a=p");
      expect(output.join("")).toContain("\x1b[5;19H");
    } finally {
      screen.dispose();
    }
  });

  it("uses the real pre-held sync mode when a held suffix closes the Agent frame", async () => {
    const output: string[] = [];
    const screen = new FormulaScreen({
      cols: 20,
      rows: 8,
      capabilities,
      scale: 1,
      writeOuter: (data) => output.push(String(data))
    });
    try {
      await screen.write(
        "\x1b[?2026h\\[\r\nx=1\r\n\\]\x1b[5;1H12345678901234567890\x1b[?2026l"
      );
      expect(screen.pendingWrap).toBe(true);
      expect(screen.synchronizedOutputMode).toBe(false);
      output.length = 0;

      // The mirror consumed the held DECRST, but the real terminal is still
      // inside the Agent-owned frame. Graphics must not open/close another
      // boolean frame and accidentally close the Agent's frame early.
      await screen.flushScanBeforeHeldCell(1, true);
      expect(output.join("")).toContain("a=p");
      expect(output.join("")).not.toContain("\x1b[?2026h");
      expect(output.join("")).not.toContain("\x1b[?2026l");
    } finally {
      screen.dispose();
    }
  });

  it("wraps graphics when a held suffix opens sync mode only in the mirror", async () => {
    const output: string[] = [];
    const screen = new FormulaScreen({
      cols: 20,
      rows: 8,
      capabilities,
      scale: 1,
      writeOuter: (data) => output.push(String(data))
    });
    try {
      await screen.write(
        "\\[\r\nx=1\r\n\\]\x1b[5;1H12345678901234567890\x1b[?2026h"
      );
      expect(screen.pendingWrap).toBe(true);
      expect(screen.synchronizedOutputMode).toBe(true);
      output.length = 0;

      // The held DECSET has not reached the real terminal, so TFormula must
      // create its own synchronized transaction despite the mirror mode.
      await screen.flushScanBeforeHeldCell(1, false);
      expect(output.join("")).toContain("a=p");
      expect(output.join("")).toContain("\x1b[?2026h");
      expect(output.join("")).toContain("\x1b[?2026l");
    } finally {
      screen.dispose();
    }
  });

  it("keeps a pending-wrap cell held until a resize probe resumes layout", async () => {
    const output: string[] = [];
    const screen = new FormulaScreen({
      cols: 20,
      rows: 8,
      capabilities,
      scale: 1,
      writeOuter: (data) => output.push(String(data))
    });
    try {
      await screen.write(
        "\\[\r\nx=1\r\n\\]\x1b[5;1H12345678901234567890"
      );
      expect(screen.pendingWrap).toBe(true);
      output.length = 0;

      const firstEpoch = screen.invalidateLayout();
      screen.resize(20, 8, firstEpoch, true);
      let completed = false;
      const flushing = screen.flushScanBeforeHeldCell().then(() => { completed = true; });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(completed).toBe(false);
      expect(output.join("")).not.toContain("a=p");

      // Rapid Cmd+/- can supersede the probe while the cell is held. A stale
      // response must not release it at the previous geometry.
      const latestEpoch = screen.invalidateLayout();
      screen.resize(24, 8, latestEpoch, true);
      screen.updateCapabilities(capabilities, firstEpoch);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(completed).toBe(false);

      screen.updateCapabilities(capabilities, latestEpoch);
      await flushing;
      expect(output.join("")).toContain("a=p");
      expect(output.join("")).toContain("\x1b[5;20H");
    } finally {
      screen.dispose();
    }
  });

  it("removes an overwritten formula at the same anchor even when its replacement fails", async () => {
    const output: string[] = [];
    const renderer = new DelayedMathRenderer();
    const screen = new FormulaScreen({
      cols: 40,
      rows: 8,
      capabilities,
      scale: 1,
      renderer,
      writeOuter: (data) => output.push(String(data))
    });
    try {
      await screen.write("\x1b[2J\x1b[H\\[\r\nx=1\r\n\\]");
      await screen.flushScan();
      const first = output.join("").match(/a=p,i=(\d+),p=(\d+)/u);
      expect(first).toBeTruthy();

      output.length = 0;
      renderer.fail = true;
      await screen.write("\x1b[H\\[\r\ny=2\r\n\\]");
      await screen.flushScan();
      expect(output.join("")).toContain(`a=d,d=i,i=${first![1]},p=${first![2]}`);
      expect(output.join("")).not.toContain("a=p");
      expect(screen.hasTerminalPlacements).toBe(false);
    } finally {
      screen.dispose();
    }
  });

  it("detaches a markerless placement when scrollback row numbers wrap", async () => {
    const output: string[] = [];
    const screen = new FormulaScreen({
      cols: 40,
      rows: 4,
      capabilities,
      scale: 1,
      writeOuter: (data) => output.push(String(data))
    });
    const scrollbackCycle = "line\r\n".repeat(10_010);
    try {
      await screen.write(`${scrollbackCycle}\\[\r\nx=1\r\n\\]`);
      await screen.flushScan();
      const first = output.join("").match(/a=p,i=(\d+),p=(\d+)/u);
      expect(first).toBeTruthy();

      // Age both xterm markers out of the fixed-size mirror. Ghostty can still
      // retain the older pin because its scrollback limit is byte based. A new
      // identical formula receives the same recycled xterm absolute-row anchor
      // but must not delete or replace that historical placement.
      screen.resize(40, 4);
      output.length = 0;
      await screen.write(`${scrollbackCycle}\\[\r\nx=1\r\n\\]`);
      await screen.flushScan();
      const recycled = output.join("");
      expect(recycled).not.toContain(`a=d,d=i,i=${first![1]},p=${first![2]}`);
      expect(recycled.match(/\x1b_Ga=p/gu)).toHaveLength(1);
      expect(recycled).toContain(`a=p,i=${first![1]},`);
    } finally {
      screen.dispose();
    }
  });

  it("bounds detached placements and terminal uploads in a long unique-formula session", async () => {
    const output: string[] = [];
    const screen = new FormulaScreen({
      cols: 60,
      rows: 24,
      capabilities,
      scale: 1,
      renderer: new FastMathRenderer(),
      maxTerminalImages: 3,
      writeOuter: (data) => output.push(String(data))
    });
    try {
      await screen.write(Array.from(
        { length: 6 },
        (_, index) => `\\[\r\nx_${index}=${index}\r\n\\]\r\n`
      ).join(""));
      await screen.flushScan();
      const placements = Array.from(
        output.join("").matchAll(/a=p,i=(\d+),p=(\d+)/gu),
        (match) => ({ imageId: Number(match[1]), placementId: Number(match[2]) })
      );
      expect(placements).toHaveLength(6);
      expect(new Set(placements.map(({ imageId }) => imageId)).size).toBe(6);

      output.length = 0;
      await screen.write("history\r\n".repeat(10_050));
      await screen.flushScan();
      const evicted = output.join("");
      for (const placement of placements.slice(0, 3)) {
        expect(evicted).toContain(
          `a=d,d=i,i=${placement.imageId},p=${placement.placementId}`
        );
        expect(evicted).toContain(`a=d,d=I,i=${placement.imageId}`);
        expect(screen.markTerminalPlacementAccepted(
          placement.imageId,
          placement.placementId
        )).toBe(false);
      }
      for (const placement of placements.slice(3)) {
        expect(screen.markTerminalPlacementAccepted(
          placement.imageId,
          placement.placementId
        )).toBe(true);
      }
    } finally {
      screen.dispose();
    }
  });

  it("keeps shared-image references balanced while pruning detached placements", async () => {
    const output: string[] = [];
    const screen = new FormulaScreen({
      cols: 60,
      rows: 16,
      capabilities,
      scale: 1,
      renderer: new FastMathRenderer(),
      maxTerminalImages: 1,
      maxDetachedPlacements: 3,
      writeOuter: (data) => output.push(String(data))
    });
    try {
      await screen.write("\\[\r\nx=1\r\n\\]\r\n".repeat(4));
      await screen.flushScan();
      const placements = Array.from(
        output.join("").matchAll(/a=p,i=(\d+),p=(\d+)/gu),
        (match) => ({ imageId: Number(match[1]), placementId: Number(match[2]) })
      );
      expect(placements).toHaveLength(4);
      expect(new Set(placements.map(({ imageId }) => imageId)).size).toBe(1);

      output.length = 0;
      await screen.write("history\r\n".repeat(10_050));
      await screen.flushScan();
      const pruned = output.join("");
      expect(pruned.match(/a=d,d=i/gu)).toHaveLength(1);
      expect(pruned).not.toContain(`a=d,d=I,i=${placements[0]!.imageId}`);
      for (const placement of placements.slice(1)) {
        expect(screen.markTerminalPlacementAccepted(
          placement.imageId,
          placement.placementId
        )).toBe(true);
      }

      output.length = 0;
      await screen.write("\\[\r\ny=2\r\n\\]");
      await screen.flushScan();
      expect(output.join("")).not.toContain(`a=d,d=I,i=${placements[0]!.imageId}`);

      for (const [index, placement] of placements.slice(1).entries()) {
        output.length = 0;
        expect(screen.invalidateTerminalPlacement(
          placement.imageId,
          placement.placementId,
          "test cleanup",
          false
        )).toBe(true);
        if (index < 2) {
          expect(output.join("")).not.toContain(`a=d,d=I,i=${placements[0]!.imageId}`);
        } else {
          expect(output.join("")).toContain(`a=d,d=I,i=${placements[0]!.imageId}`);
        }
      }
    } finally {
      screen.dispose();
    }
  });

  it("invalidates a visible resize hint when capped scrollback trims before its first scan", async () => {
    const output: string[] = [];
    const screen = new FormulaScreen({
      cols: 50,
      rows: 8,
      capabilities,
      scale: 1,
      writeOuter: (data) => output.push(String(data))
    });
    const formula = "This is a deliberately long prefix before the trailing formula \\(x_i^2\\)";
    try {
      await screen.write(`${"line\r\n".repeat(10_010)}${formula}\r\nnext`);
      await screen.flushScan();
      const first = output.join("").match(/a=p,i=(\d+),p=(\d+)/u);
      expect(first).toBeTruthy();

      // Widening merges the visible continuation row and destroys both xterm
      // markers, leaving a resize hint. Before its scheduled scan can run, only
      // eight CRLFs trim the already-capped buffer and recycle that hint's row.
      screen.resize(100, 8);
      output.length = 0;
      await screen.write(`${"\r\n".repeat(8)}${formula}\r\nnext`);
      await screen.flushScan();

      const recycled = output.join("");
      expect(recycled).not.toContain(`a=d,d=i,i=${first![1]},p=${first![2]}`);
      expect(recycled.match(/\x1b_Ga=p/gu)).toHaveLength(1);
      expect(recycled).toContain(`a=p,i=${first![1]},`);
    } finally {
      screen.dispose();
    }
  });

  it("detaches a capped visible reflow pin when one checkpoint scrolls it off-screen", async () => {
    const output: string[] = [];
    const screen = new FormulaScreen({
      cols: 50,
      rows: 24,
      capabilities,
      scale: 1,
      writeOuter: (data) => output.push(String(data))
    });
    const formula = "This is a deliberately long prefix before the trailing formula \\(x_i^2\\)";
    try {
      // Put the continuation-row formula at the top of a full viewport after
      // xterm's absolute row numbers have saturated. Ghostty's byte-based
      // scrollback still retains all of this small transcript.
      await screen.write([
        "old\r\n".repeat(10_020),
        formula,
        "\r\n",
        "body\r\n".repeat(20),
        "tail"
      ].join(""));
      await screen.flushScan();
      const first = output.join("").match(/a=p,i=(\d+),p=(\d+)/u);
      expect(first).toBeTruthy();

      // At 24 rows the proxy permits eight line feeds before its next output
      // checkpoint. Widening first disposes both continuation-row markers;
      // those eight lines then recycle the hint's absolute row and move the
      // real Ghostty pin into scrollback before the first post-resize scan.
      screen.resize(100, 24);
      output.length = 0;
      await screen.write("\r\n".repeat(8));
      await screen.flushScan();

      const checkpoint = output.join("");
      expect(checkpoint).not.toContain(`a=d,d=i,i=${first![1]},p=${first![2]}`);
      expect(checkpoint).not.toContain("\x1b_Ga=p");
      expect(screen.hasTerminalPlacements).toBe(true);
    } finally {
      screen.dispose();
    }
  });

  it("deletes the old placement before rendering a new font-size variant", async () => {
    const output: string[] = [];
    const debug: string[] = [];
    const screen = new FormulaScreen({
      cols: 80,
      rows: 24,
      capabilities,
      scale: 1,
      writeOuter: (data) => output.push(String(data)),
      debug: (message) => debug.push(message)
    });
    try {
      screen.write("\x1b[2J\x1b[H\\[\r\nE=mc^2\r\n\\]");
      await waitFor(() => debug.filter((message) => message.startsWith("rendered ")).length === 1);
      const firstOutput = output.join("");
      const firstImageId = firstOutput.match(/a=t,[^;]*i=(\d+)/u)?.[1];
      const firstPlacementId = firstOutput.match(/a=p,[^;]*p=(\d+)/u)?.[1];
      expect(firstImageId).toBeTruthy();
      expect(firstPlacementId).toBeTruthy();

      output.length = 0;
      screen.resize(90, 30);
      screen.updateCapabilities({
        ...capabilities,
        cell: { width: 10, height: 20, source: "cell-query" }
      });
      await waitFor(() => debug.filter((message) => message.startsWith("rendered ")).length === 2);
      const redraw = output.join("");
      expect(redraw).toContain(`a=d,d=i,i=${firstImageId},p=${firstPlacementId}`);
      expect(redraw).not.toContain(`a=d,d=I,i=${firstImageId}`);
      expect(redraw).not.toContain("a=d,d=R,x=1400000000,y=1999999999");
      expect(redraw.match(/\x1b_Ga=t/gu)).toHaveLength(1);
      expect(redraw.match(/\x1b_Ga=p/gu)).toHaveLength(1);
    } finally {
      screen.dispose();
    }
  });

  it("renders formulas again after a TUI clear-screen redraw", async () => {
    const output: string[] = [];
    const debug: string[] = [];
    const screen = new FormulaScreen({
      cols: 80,
      rows: 24,
      capabilities,
      scale: 1,
      writeOuter: (data) => output.push(String(data)),
      debug: (message) => debug.push(message)
    });
    const frame = [
      "\x1b[H1. Electric",
      "[",
      "\\nabla\\cdot\\mathbf{E}=\\frac{\\rho}{\\varepsilon_0}",
      "]",
      "2. Magnetic",
      "[",
      "\\nabla\\cdot\\mathbf{B}=0",
      "]"
    ].join("\r\n");
    try {
      screen.write(`\x1b[2J${frame}`);
      await waitFor(() => debug.filter((message) => message.startsWith("rendered ")).length === 2);
      output.length = 0;

      // Split the clear sequence as a PTY is allowed to do, then redraw the
      // identical frame. It must not be skipped because of the old fingerprint.
      screen.write("\x1b[2");
      screen.write(`J${frame}`);
      await waitFor(() => debug.filter((message) => message.startsWith("rendered ")).length === 4);
      const redraw = output.join("");
      // Ghostty clears both placements and uploaded image data for the active
      // screen on CSI 2J, so every visible image must be transmitted again.
      expect(redraw.match(/\x1b_Ga=t/gu)).toHaveLength(2);
      expect(redraw.match(/\x1b_Ga=p/gu)).toHaveLength(2);
    } finally {
      screen.dispose();
    }
  });

  it("forgets terminal images after an unrewritten 8-bit ED 2", async () => {
    const output: string[] = [];
    const screen = new FormulaScreen({
      cols: 80,
      rows: 24,
      capabilities,
      scale: 1,
      writeOuter: (data) => output.push(String(data))
    });
    try {
      await screen.write("\x1b[H\\[\r\nE=mc^2\r\n\\]");
      await screen.flushScan();
      const firstImageId = output.join("").match(/a=t,[^;]*i=(\d+)/u)?.[1];
      expect(firstImageId).toBeTruthy();

      output.length = 0;
      await screen.write("\u009b2J\x1b[H\\[\r\nE=mc^2\r\n\\]");
      await screen.flushScan();
      const redraw = output.join("");
      expect(redraw.match(/\x1b_Ga=t/gu)).toHaveLength(1);
      expect(redraw.match(/\x1b_Ga=p/gu)).toHaveLength(1);
      expect(redraw).not.toContain(`a=p,i=${firstImageId},`);
    } finally {
      screen.dispose();
    }
  });

  it("reuses uploads when ED 2 is rewritten to preserve scrollback images", async () => {
    const output: string[] = [];
    const debug: string[] = [];
    const screen = new FormulaScreen({
      cols: 80,
      rows: 24,
      capabilities,
      scale: 1,
      preserveImagesOnClear: true,
      writeOuter: (data) => output.push(String(data)),
      debug: (message) => debug.push(message)
    });
    const frame = "\x1b[H\\[\r\nE=mc^2\r\n\\]";
    try {
      await screen.write(`\x1b[2J${frame}`);
      await screen.flushScan();
      output.length = 0;

      // The proxy replaced this ED 2 in the real terminal, while the headless
      // mirror still receives the original control for correct text semantics.
      await screen.write(`\x1b[0J\x1b[1J${frame}`, false, [0]);
      await screen.flushScan();
      const redraw = output.join("");
      expect(redraw).toContain("a=d,d=i");
      expect(redraw.match(/\x1b_Ga=p/gu)).toHaveLength(1);
      expect(redraw).not.toContain("\x1b_Ga=t");
    } finally {
      screen.dispose();
    }
  });

  it("places inside an Agent synchronized-output frame without closing it", async () => {
    const output: string[] = [];
    const screen = new FormulaScreen({
      cols: 80,
      rows: 24,
      capabilities,
      scale: 1,
      writeOuter: (data) => output.push(String(data))
    });
    try {
      output.length = 0;
      await screen.write("\x1b[?2026h\\[\r\nE=mc^2\r\n\\]");
      await screen.flushScan();
      expect(output.join("").match(/\x1b_Ga=p/gu)).toHaveLength(1);
      expect(output.join("")).not.toContain("\x1b[?2026l");

      output.length = 0;
      await screen.write("\x1b[?2026l");
      await screen.flushScan();
      expect(output.join("")).not.toContain("a=p");
    } finally {
      screen.dispose();
    }
  });

  it("does not close a synchronized-output frame opened while MathJax is pending", async () => {
    const output: string[] = [];
    const renderer = new DelayedMathRenderer();
    let renderStarted!: () => void;
    const started = new Promise<void>((resolve) => { renderStarted = resolve; });
    renderer.delay = true;
    renderer.started = renderStarted;
    const screen = new FormulaScreen({
      cols: 80,
      rows: 24,
      capabilities,
      scale: 1,
      renderer,
      writeOuter: (data) => output.push(String(data))
    });
    try {
      await screen.write("\x1b[2J\x1b[H\\[\r\nE=mc^2\r\n\\]");
      const scan = screen.flushScan();
      await started;
      output.length = 0;
      await screen.write("\x1b[?2026h");
      renderer.release?.();
      await scan;

      expect(output.join("")).toContain("a=p");
      expect(output.join("")).not.toContain("\x1b[?2026l");
      expect(screen.synchronizedOutputMode).toBe(true);

      await screen.write("\x1b[?2026l");
      await screen.flushScan();
      expect(output.join("").match(/\x1b_Ga=p/gu)).toHaveLength(1);
    } finally {
      renderer.release?.();
      screen.dispose();
    }
  });

  it("renders a formula before a long synchronized frame scrolls it away", async () => {
    const output: string[] = [];
    const screen = new FormulaScreen({
      cols: 60,
      rows: 5,
      capabilities,
      scale: 1,
      writeOuter: (data) => output.push(String(data))
    });
    try {
      output.length = 0;
      await screen.write("\x1b[?2026h\\[\r\nx=1\r\n\\]\r\nfirst line");
      await screen.flushScan(true);
      expect(output.join("")).toContain("a=p");
      expect(output.join("")).not.toContain("\x1b[?2026l");

      await screen.write("\r\n2\r\n3\r\n4\r\n5\r\n6\r\n7\r\n8\x1b[?2026l");
      await screen.flushScan();
      expect(screen.hasTerminalPlacements).toBe(true);
    } finally {
      screen.dispose();
    }
  });

  it("deletes preserved-clear placements without closing an Agent frame", async () => {
    const output: string[] = [];
    const screen = new FormulaScreen({
      cols: 80,
      rows: 24,
      capabilities,
      scale: 1,
      preserveImagesOnClear: true,
      writeOuter: (data) => output.push(String(data))
    });
    try {
      await screen.write("\x1b[2J\x1b[H\\[\r\nE=mc^2\r\n\\]");
      await screen.flushScan();
      await screen.write("\x1b[?2026h");
      output.length = 0;

      await screen.write("\x1b[0J\x1b[1J", false, [0]);
      expect(output.join("")).toContain("a=d,d=i");
      expect(output.join("")).not.toContain("\x1b[?2026l");
      expect(screen.synchronizedOutputMode).toBe(true);
    } finally {
      await screen.write("\x1b[?2026l");
      screen.dispose();
    }
  });

  it("does not spin flushScan while origin mode disables placement", async () => {
    const output: string[] = [];
    const screen = new FormulaScreen({
      cols: 80,
      rows: 24,
      capabilities,
      scale: 1,
      writeOuter: (data) => output.push(String(data))
    });
    try {
      await screen.write("\x1b[2J\x1b[H\\[\r\nE=mc^2\r\n\\]");
      await screen.flushScan();
      output.length = 0;

      await screen.write("\x1b[?6hnew text");
      await Promise.race([
        screen.flushScan(),
        new Promise<never>((_, reject) => setTimeout(
          () => reject(new Error("flushScan spun in origin mode")),
          250
        ))
      ]);
      expect(output.join("")).toContain("a=d,d=i");
      expect(screen.originMode).toBe(true);

      await screen.write("\x1b[?6l");
      await screen.flushScan();
    } finally {
      screen.dispose();
    }
  });

  it("tracks a split 8-bit origin-mode control for image lifecycle", async () => {
    const output: string[] = [];
    const screen = new FormulaScreen({
      cols: 80,
      rows: 24,
      capabilities,
      scale: 1,
      writeOuter: (data) => output.push(String(data))
    });
    try {
      await screen.write("\\[\r\nE=mc^2\r\n\\]");
      await screen.flushScan();
      output.length = 0;

      await screen.write("\u009b?");
      await screen.write("6h");
      await screen.flushScan();
      expect(screen.originMode).toBe(true);
      expect(output.join("")).toContain("a=d,d=i");
    } finally {
      await screen.write("\u009b?6l");
      screen.dispose();
    }
  });

  it("reuploads a cached PNG after the terminal rejects its image id", async () => {
    const output: string[] = [];
    const debug: string[] = [];
    const screen = new FormulaScreen({
      cols: 80,
      rows: 24,
      capabilities,
      scale: 1,
      writeOuter: (data) => output.push(String(data)),
      debug: (message) => debug.push(message)
    });
    try {
      await screen.write("\x1b[2J\x1b[H\\[\r\nE=mc^2\r\n\\]");
      await screen.flushScan();
      const firstImageId = Number(output.join("").match(/a=t,[^;]*i=(\d+)/u)?.[1]);
      expect(firstImageId).toBeGreaterThan(0);

      output.length = 0;
      expect(screen.invalidateTerminalImage(firstImageId, "Kitty ENOENT")).toBe(true);
      await waitFor(() => output.join("").includes("a=p"));
      await screen.flushScan();

      const retry = output.join("");
      expect(retry.match(/\x1b_Ga=t/gu)).toHaveLength(1);
      expect(retry.match(/\x1b_Ga=p/gu)).toHaveLength(1);
      expect(retry).not.toContain(`a=t,f=100,t=d,i=${firstImageId},`);
    } finally {
      screen.dispose();
    }
  });

  it("retries a rejected placement without invalidating its shared image", async () => {
    const output: string[] = [];
    const screen = new FormulaScreen({
      cols: 80,
      rows: 24,
      capabilities,
      scale: 1,
      writeOuter: (data) => output.push(String(data))
    });
    try {
      await screen.write([
        "\x1b[2J\x1b[H",
        "\\[\r\nE=mc^2\r\n\\]\r\n",
        "\\[\r\nE=mc^2\r\n\\]"
      ].join(""));
      await screen.flushScan();
      const initial = output.join("");
      const placements = Array.from(
        initial.matchAll(/a=p,i=(\d+),p=(\d+)/gu),
        (match) => ({ imageId: Number(match[1]), placementId: Number(match[2]) })
      );
      expect(placements).toHaveLength(2);
      expect(placements[0]!.imageId).toBe(placements[1]!.imageId);

      output.length = 0;
      expect(screen.invalidateTerminalPlacement(
        placements[0]!.imageId,
        placements[0]!.placementId,
        "Kitty EINVAL"
      )).toBe(true);
      await waitFor(() => output.join("").includes("a=p"));
      await screen.flushScan();
      const retry = output.join("");
      expect(retry).toContain(
        `a=d,d=i,i=${placements[0]!.imageId},p=${placements[0]!.placementId}`
      );
      expect(retry).not.toContain(
        `a=d,d=i,i=${placements[1]!.imageId},p=${placements[1]!.placementId}`
      );
      expect(retry.match(/\x1b_Ga=p/gu)).toHaveLength(1);
      expect(retry).not.toContain("\x1b_Ga=t");
    } finally {
      screen.dispose();
    }
  });

  it("does not retry a permanently invalid graphics variant forever", async () => {
    const output: string[] = [];
    const screen = new FormulaScreen({
      cols: 80,
      rows: 24,
      capabilities,
      scale: 1,
      writeOuter: (data) => output.push(String(data))
    });
    try {
      await screen.write("\x1b[2J\x1b[H\\[\r\nE=mc^2\r\n\\]");
      await screen.flushScan();
      const imageId = Number(output.join("").match(/a=t,[^;]*i=(\d+)/u)?.[1]);
      expect(imageId).toBeGreaterThan(0);

      expect(screen.invalidateTerminalImage(imageId, "Kitty EINVAL", false)).toBe(true);
      output.length = 0;
      screen.scheduleScan(0);
      await screen.flushScan();
      expect(output.join("")).not.toContain("\x1b_Ga=t");
      expect(output.join("")).not.toContain("\x1b_Ga=p");
    } finally {
      screen.dispose();
    }
  });

  it("evicts idle variants and retries a terminal quota error", async () => {
    const output: string[] = [];
    const screen = new FormulaScreen({
      cols: 80,
      rows: 24,
      capabilities,
      scale: 1,
      maxTerminalImages: 10,
      writeOuter: (data) => output.push(String(data))
    });
    try {
      for (const latex of ["x=1", "y=2", "z=3"]) {
        await screen.write(`\x1b[H\x1b[2K\\[${latex}\\]`);
        await screen.flushScan();
      }
      const currentImageId = Number(
        Array.from(output.join("").matchAll(/a=t,[^;]*i=(\d+)/gu)).at(-1)?.[1]
      );
      expect(currentImageId).toBeGreaterThan(0);

      output.length = 0;
      // The caller classified this as non-retryable, but quota pressure is
      // recoverable after idle uploads are explicitly freed.
      expect(screen.invalidateTerminalImage(
        currentImageId,
        "Kitty ENOSPC: image quota exceeded",
        false
      )).toBe(true);
      await waitFor(() => output.join("").includes("a=p"));
      const recovered = output.join("");
      expect(recovered.match(/a=d,d=I/gu)?.length).toBeGreaterThanOrEqual(3);
      expect(recovered).toContain("\x1b_Ga=t");
      expect(recovered).toContain("\x1b_Ga=p");
    } finally {
      screen.dispose();
    }
  });

  it("releases the oldest detached pin first under terminal resource pressure", async () => {
    const output: string[] = [];
    const screen = new FormulaScreen({
      cols: 60,
      rows: 12,
      capabilities,
      scale: 1,
      renderer: new FastMathRenderer(),
      maxTerminalImages: 4,
      writeOuter: (data) => output.push(String(data))
    });
    try {
      await screen.write("\\[\r\nx=1\r\n\\]\r\n\\[\r\ny=2\r\n\\]");
      await screen.flushScan();
      const historical = Array.from(
        output.join("").matchAll(/a=p,i=(\d+),p=(\d+)/gu),
        (match) => ({ imageId: Number(match[1]), placementId: Number(match[2]) })
      );
      expect(historical).toHaveLength(2);

      await screen.write("history\r\n".repeat(10_050));
      await screen.flushScan();
      output.length = 0;
      await screen.write("\\[\r\nz=3\r\n\\]");
      await screen.flushScan();
      const currentImageId = Number(
        Array.from(output.join("").matchAll(/a=p,i=(\d+)/gu)).at(-1)?.[1]
      );
      expect(currentImageId).toBeGreaterThan(0);

      output.length = 0;
      expect(screen.invalidateTerminalImage(
        currentImageId,
        "Kitty ENOMEM: image storage exhausted",
        false
      )).toBe(true);
      const pressureCleanup = output.join("");
      expect(pressureCleanup).toContain(
        `a=d,d=i,i=${historical[0]!.imageId},p=${historical[0]!.placementId}`
      );
      expect(pressureCleanup).toContain(`a=d,d=I,i=${historical[0]!.imageId}`);
      expect(screen.markTerminalPlacementAccepted(
        historical[0]!.imageId,
        historical[0]!.placementId
      )).toBe(false);
      expect(screen.markTerminalPlacementAccepted(
        historical[1]!.imageId,
        historical[1]!.placementId
      )).toBe(true);
    } finally {
      screen.dispose();
    }
  });

  it("resets image retry history after each successful reupload", async () => {
    const output: string[] = [];
    const screen = new FormulaScreen({
      cols: 80,
      rows: 24,
      capabilities,
      scale: 1,
      writeOuter: (data) => output.push(String(data))
    });
    try {
      await screen.write("\x1b[2J\x1b[H\\[\r\nE=mc^2\r\n\\]");
      await screen.flushScan();
      for (let cycle = 0; cycle < 7; cycle += 1) {
        const imageId = Number(
          Array.from(output.join("").matchAll(/a=t,[^;]*i=(\d+)/gu)).at(-1)?.[1]
        );
        expect(imageId).toBeGreaterThan(0);
        output.length = 0;
        expect(screen.invalidateTerminalImage(imageId, "Kitty ENOENT")).toBe(true);
        await waitFor(() => output.join("").includes("a=p"));
        await screen.flushScan();
        expect(output.join("").match(/\x1b_Ga=t/gu), `cycle ${cycle}`).toHaveLength(1);
        const acceptedImageId = Number(
          Array.from(output.join("").matchAll(/a=t,[^;]*i=(\d+)/gu)).at(-1)?.[1]
        );
        const acceptedPlacement = Array.from(
          output.join("").matchAll(/a=p,i=(\d+),p=(\d+)/gu)
        ).at(-1);
        expect(screen.markTerminalImageAccepted(acceptedImageId)).toBe(true);
        expect(screen.markTerminalPlacementAccepted(
          Number(acceptedPlacement?.[1]),
          Number(acceptedPlacement?.[2])
        )).toBe(true);
      }
    } finally {
      screen.dispose();
    }
  });

  it("stops retransmitting an image that never acknowledges any retry", async () => {
    const output: string[] = [];
    const debug: string[] = [];
    const screen = new FormulaScreen({
      cols: 80,
      rows: 24,
      capabilities,
      scale: 1,
      writeOuter: (data) => output.push(String(data)),
      debug: (message) => debug.push(message)
    });
    try {
      await screen.write("\x1b[2J\x1b[H\\[\r\nE=mc^2\r\n\\]");
      await screen.flushScan();
      let imageId = Number(output.join("").match(/a=t,[^;]*i=(\d+)/u)?.[1]);
      expect(imageId).toBeGreaterThan(0);

      for (let attempt = 1; attempt <= 5; attempt += 1) {
        output.length = 0;
        expect(screen.invalidateTerminalImage(imageId, "Kitty EINVAL", true)).toBe(true);
        await waitFor(() => output.join("").includes("a=p"), 3_000);
        imageId = Number(output.join("").match(/a=t,[^;]*i=(\d+)/u)?.[1]);
        expect(imageId).toBeGreaterThan(0);
        // Deliberately do not call markTerminalImageAccepted: merely queuing
        // upload/place bytes is not proof that Kitty accepted the image.
      }

      output.length = 0;
      expect(screen.invalidateTerminalImage(imageId, "Kitty EINVAL", true)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(output.join("")).not.toContain("\x1b_Ga=t");
      expect(output.join("")).not.toContain("\x1b_Ga=p");
      expect(debug.some((message) => message.includes("exceeded the graphics retry limit")))
        .toBe(true);
    } finally {
      screen.dispose();
    }
  });

  it("keeps a standalone display rendered across 140-to-60-column reflow", async () => {
    const output: string[] = [];
    const debug: string[] = [];
    const screen = new FormulaScreen({
      cols: 140,
      rows: 12,
      capabilities,
      scale: 1,
      writeOuter: (data) => output.push(String(data)),
      debug: (message) => debug.push(message)
    });
    const formula = "\\[\\nabla \\times \\mathbf{B}=\\mu_0\\mathbf{J}+"
      + "\\mu_0\\varepsilon_0\\frac{\\partial \\mathbf{E}}{\\partial t}"
      + "+\\frac{\\rho}{\\varepsilon_0}\\]";
    try {
      await screen.write(`\x1b[2J\x1b[H${formula}\r\nexplanation`);
      await screen.flushScan();
      expect(debug.filter((message) => message.startsWith("rendered "))).toHaveLength(1);
      const initial = output.join("");
      const firstImageId = initial.match(/a=t,[^;]*i=(\d+)/u)?.[1];
      const firstPlacementId = initial.match(/a=p,[^;]*p=(\d+)/u)?.[1];
      expect(firstImageId).toBeTruthy();
      expect(firstPlacementId).toBeTruthy();

      output.length = 0;
      screen.resize(60, 12);
      await screen.flushScan();
      const narrow = output.join("");
      expect(debug.filter((message) => message.startsWith("rendered "))).toHaveLength(2);
      expect(narrow).toContain("a=p");
      expect(narrow).toContain("c=60,r=3,C=1");
      const narrowPlacementOffset = narrow.indexOf("a=p");
      const oldDeletionOffset = narrow.indexOf(
        `a=d,d=i,i=${firstImageId},p=${firstPlacementId}`
      );
      expect(oldDeletionOffset).toBeGreaterThanOrEqual(0);
      expect(narrowPlacementOffset).toBeGreaterThan(oldDeletionOffset);

      output.length = 0;
      screen.resize(140, 12);
      await screen.flushScan();
      const wideAgain = output.join("");
      expect(debug.filter((message) => message.startsWith("rendered "))).toHaveLength(3);
      expect(wideAgain).toContain("a=p");
      expect(wideAgain).toContain(`a=p,i=${firstImageId},`);
      // The MathJax/PNG cache and terminal upload from the first 140-column
      // render are reused; only a fresh placement is needed.
      expect(wideAgain).not.toContain("\x1b_Ga=t");
    } finally {
      screen.dispose();
    }
  });

  it("replaces every visible placement across repeated soft-wrap reflows", async () => {
    const output: string[] = [];
    const screen = new FormulaScreen({
      cols: 140,
      rows: 20,
      capabilities,
      scale: 1,
      writeOuter: (data) => output.push(String(data))
    });
    const formula = "\\[\\nabla \\times \\mathbf{B}=\\mu_0\\mathbf{J}+"
      + "\\mu_0\\varepsilon_0\\frac{\\partial \\mathbf{E}}{\\partial t}"
      + "+\\frac{\\rho}{\\varepsilon_0}\\]";
    try {
      await screen.write(`\x1b[2J\x1b[H${formula}\r\n${formula}\r\n`);
      await screen.flushScan();
      expect(output.join("").match(/\x1b_Ga=p/gu)).toHaveLength(2);

      for (const columns of [60, 90, 40, 140, 60, 140]) {
        output.length = 0;
        screen.resize(columns, 20);
        await screen.flushScan();
        const transaction = output.join("");
        expect(transaction.match(/\x1b_Ga=p/gu), `placements at ${columns} columns`)
          .toHaveLength(2);
        expect(transaction.match(/a=d,d=i/gu), `deletions at ${columns} columns`)
          .toHaveLength(2);
      }
    } finally {
      screen.dispose();
    }
  });

  it("reflows a final formula line that has no trailing newline", async () => {
    const output: string[] = [];
    const screen = new FormulaScreen({
      cols: 140,
      rows: 12,
      capabilities,
      scale: 1,
      writeOuter: (data) => output.push(String(data))
    });
    const formula = "\\[\\nabla \\times \\mathbf{B}=\\mu_0\\mathbf{J}+"
      + "\\mu_0\\varepsilon_0\\frac{\\partial \\mathbf{E}}{\\partial t}\\]";
    try {
      await screen.write(`\x1b[2J\x1b[H${formula}`);
      await screen.flushScan();
      expect(output.join("").match(/\x1b_Ga=p/gu)).toHaveLength(1);

      for (const columns of [60, 140]) {
        output.length = 0;
        screen.resize(columns, 12);
        await screen.flushScan();
        const transaction = output.join("");
        expect(transaction.match(/\x1b_Ga=p/gu), `placement at ${columns} columns`)
          .toHaveLength(1);
        expect(transaction.match(/a=d,d=i/gu), `deletion at ${columns} columns`)
          .toHaveLength(1);
      }
    } finally {
      screen.dispose();
    }
  });

  it("cleans a placement whose graphics write crosses a resize", async () => {
    const transactions: string[] = [];
    let blockPlacement = false;
    let announceBlocked!: () => void;
    let releaseBlocked!: () => void;
    const placementBlocked = new Promise<void>((resolve) => {
      announceBlocked = resolve;
    });
    const placementMayFinish = new Promise<void>((resolve) => {
      releaseBlocked = resolve;
    });
    const screen = new FormulaScreen({
      cols: 100,
      rows: 12,
      capabilities,
      scale: 1,
      writeOuter: () => undefined,
      writeGraphics: async (create) => {
        const data = create();
        if (data === undefined) return false;
        const value = String(data);
        transactions.push(`start:${value}`);
        if (blockPlacement && value.includes("a=p")) {
          blockPlacement = false;
          announceBlocked();
          await placementMayFinish;
        }
        transactions.push(`finish:${value}`);
        return true;
      },
      transmitImage: (_png, imageId) => `\x1b_Ga=t,i=${imageId},q=0;UPLOAD\x1b\\`
    });
    try {
      await screen.write("\r\n\\[\r\nE=mc^2\r\n\\]\r\n");
      await screen.flushScan();
      expect(transactions.some((value) => value.includes("a=p"))).toBe(true);
      const initialCount = transactions.length;

      blockPlacement = true;
      screen.resize(58, 12);
      const replacement = screen.flushScan();
      await placementBlocked;
      // Simulate SIGWINCH while the small cell-addressed transaction is under
      // stdout backpressure and therefore can no longer be cancelled.
      screen.resize(96, 12);
      releaseBlocked();
      await replacement;

      const later = transactions.slice(initialCount);
      const staleFinish = later.findIndex((value) =>
        value.startsWith("finish:") && value.includes("a=p")
      );
      expect(staleFinish).toBeGreaterThanOrEqual(0);
      expect(later.slice(staleFinish + 1).some((value) =>
        value.startsWith("start:")
          && value.includes("a=d,d=i")
          && /\x1b\[\d+;\d+H/u.test(value)
      )).toBe(true);
      // Upload and placement must never share one transaction. Otherwise a
      // large direct PNG can carry an old final CUP into the new geometry.
      expect(transactions.some((value) =>
        value.includes("UPLOAD") && value.includes("a=p")
      )).toBe(false);
    } finally {
      screen.dispose();
    }
  });

  it("repositions a whole trailing inline formula after its prose soft-wraps", async () => {
    const output: string[] = [];
    const screen = new FormulaScreen({
      cols: 80,
      rows: 8,
      capabilities,
      scale: 1,
      writeOuter: (data) => output.push(String(data))
    });
    try {
      await screen.write(
        "This is a deliberately long prefix before the trailing formula \\(x_i^2\\)"
      );
      await screen.flushScan();
      const initial = output.join("").match(/a=p,i=(\d+),p=(\d+)/u);
      expect(initial).toBeTruthy();

      output.length = 0;
      screen.resize(24, 8);
      await screen.flushScan();
      const resized = output.join("");
      expect(resized.match(/\x1b_Ga=p/gu)).toHaveLength(1);
      expect(resized).toContain(`a=d,d=i,i=${initial![1]},p=${initial![2]}`);
    } finally {
      screen.dispose();
    }
  });

  it("replaces a wide inline placement with transparent wrapped slices", async () => {
    const output: string[] = [];
    const screen = new FormulaScreen({
      cols: 100,
      rows: 12,
      capabilities,
      scale: 1,
      writeOuter: (data) => output.push(String(data))
    });
    const line = "prefix \\(\\operatorname{VarianceOfALongQuantity}(X_i,Y_j)"
      + "+\\frac{1}{2}\\) suffix";
    try {
      await screen.write(line);
      await screen.flushScan();
      const first = output.join("").match(/a=p,i=(\d+),p=(\d+)/u);
      expect(first).toBeTruthy();

      output.length = 0;
      screen.resize(30, 12);
      await screen.flushScan();

      const narrow = output.join("");
      // The formula now shares several wrapped rows with prose. Replace its old
      // one-row image with a full-width transparent canvas whose opaque slices
      // cover only the source TeX cells on each row.
      expect(narrow).toContain(`a=d,d=i,i=${first![1]},p=${first![2]}`);
      expect(narrow.match(/\x1b_Ga=p/gu)).toHaveLength(1);
      expect(narrow).toContain("c=30,r=3,C=1");
      expect(screen.hasTerminalPlacements).toBe(true);
    } finally {
      screen.dispose();
    }
  });

  it("transactionally replaces a visible continuation-row formula when widening loses both markers", async () => {
    const output: string[] = [];
    const screen = new FormulaScreen({
      cols: 50,
      rows: 8,
      capabilities,
      scale: 1,
      writeOuter: (data) => output.push(String(data))
    });
    try {
      await screen.write([
        "This is a deliberately long prefix before the trailing formula ",
        "\\(x_i^2\\)\r\nnext"
      ].join(""));
      await screen.flushScan();
      const initial = output.join("").match(/a=p,i=(\d+),p=(\d+)/u);
      expect(initial).toBeTruthy();

      output.length = 0;
      screen.resize(100, 8);
      await screen.flushScan();
      const resized = output.join("");
      expect(resized.match(/\x1b_Ga=p/gu)).toHaveLength(1);
      expect(resized).toContain(`a=d,d=i,i=${initial![1]},p=${initial![2]}`);
      expect(resized.indexOf(`a=d,d=i,i=${initial![1]},p=${initial![2]}`))
        .toBeLessThan(resized.indexOf("\x1b_Ga=p"));
    } finally {
      screen.dispose();
    }
  });

  it("keeps a wide inline formula rendered after narrowing across rows", async () => {
    const output: string[] = [];
    const screen = new FormulaScreen({
      cols: 100,
      rows: 8,
      capabilities,
      scale: 1,
      writeOuter: (data) => output.push(String(data))
    });
    const line = "prefix \\(" + [
      "\\operatorname{Var}(X_i)",
      "+\\frac{a+b+c+d+e+f}{g+h+i+j+k+l}",
      "+\\sum_{n=1}^{N}n^2"
    ].join("") + "\\) suffix";
    try {
      await screen.write(line);
      await screen.flushScan();
      const initial = output.join("").match(/a=p,i=(\d+),p=(\d+)/u);
      expect(initial).toBeTruthy();

      output.length = 0;
      screen.resize(30, 8);
      await screen.flushScan();
      const narrow = output.join("");
      // Transparent pixels preserve prose outside the row slices while opaque
      // pixels replace every cell occupied by the wrapped source formula.
      expect(narrow).toContain(`a=d,d=i,i=${initial![1]},p=${initial![2]}`);
      expect(narrow.match(/\x1b_Ga=p/gu)).toHaveLength(1);
      expect(narrow).toContain("c=30,r=4,C=1");
    } finally {
      screen.dispose();
    }
  });

  it("keeps the last good placement until a failed resize render can be replaced", async () => {
    const output: string[] = [];
    const renderer = new DelayedMathRenderer();
    const screen = new FormulaScreen({
      cols: 140,
      rows: 12,
      capabilities,
      scale: 1,
      renderer,
      writeOuter: (data) => output.push(String(data))
    });
    const formula = "\\[\\nabla \\times \\mathbf{B}=\\mu_0\\mathbf{J}+"
      + "\\mu_0\\varepsilon_0\\frac{\\partial \\mathbf{E}}{\\partial t}\\]";
    try {
      await screen.write(`\x1b[2J\x1b[H${formula}\r\nexplanation`);
      await screen.flushScan();
      const initial = output.join("");
      const imageId = initial.match(/a=t,[^;]*i=(\d+)/u)?.[1];
      const placementId = initial.match(/a=p,[^;]*p=(\d+)/u)?.[1];
      expect(imageId).toBeTruthy();
      expect(placementId).toBeTruthy();

      output.length = 0;
      renderer.fail = true;
      screen.resize(60, 12);
      await screen.flushScan();
      expect(output.join(""))
        .not.toContain(`a=d,d=i,i=${imageId},p=${placementId}`);
      expect(screen.hasTerminalPlacements).toBe(true);

      output.length = 0;
      renderer.fail = false;
      await waitFor(() => output.join("").includes("a=p"));
      await screen.flushScan();
      const recovered = output.join("");
      const deletion = recovered.indexOf(`a=d,d=i,i=${imageId},p=${placementId}`);
      const placement = recovered.indexOf("a=p", deletion);
      expect(deletion).toBeGreaterThanOrEqual(0);
      expect(placement).toBeGreaterThan(deletion);
    } finally {
      screen.dispose();
    }
  });

  it("claims each identical replacement once when one render fails", async () => {
    const output: string[] = [];
    const renderer = new DelayedMathRenderer();
    const screen = new FormulaScreen({
      cols: 60,
      rows: 20,
      capabilities,
      scale: 1,
      renderer,
      writeOuter: (data) => output.push(String(data))
    });
    const formula = "\\[\\nabla \\times \\mathbf{B}=\\mu_0\\mathbf{J}+"
      + "\\mu_0\\varepsilon_0\\frac{\\partial \\mathbf{E}}{\\partial t}"
      + "+\\frac{\\rho}{\\varepsilon_0}\\]";
    try {
      await screen.write(`\x1b[2J\x1b[H${formula}\r\n${formula}`);
      await screen.flushScan();
      const initial = output.join("");
      const placements = Array.from(
        initial.matchAll(/a=p,i=(\d+),p=(\d+)/gu),
        (match) => ({ imageId: match[1]!, placementId: match[2]! })
      );
      expect(placements).toHaveLength(2);

      output.length = 0;
      renderer.failNext = 1;
      screen.resize(140, 20);
      await screen.flushScan();
      const partial = output.join("");
      expect(partial.match(/\x1b_Ga=p/gu)).toHaveLength(1);
      expect(partial.match(/a=d,d=i/gu)).toHaveLength(1);
      expect(partial).not.toContain(
        `a=d,d=i,i=${placements[0]!.imageId},p=${placements[0]!.placementId}`
      );
      expect(partial).toContain(
        `a=d,d=i,i=${placements[1]!.imageId},p=${placements[1]!.placementId}`
      );

      output.length = 0;
      await waitFor(() => output.join("").includes("a=p"));
      await screen.flushScan();
      const recovered = output.join("");
      expect(recovered).toContain(
        `a=d,d=i,i=${placements[0]!.imageId},p=${placements[0]!.placementId}`
      );
      expect(recovered.match(/\x1b_Ga=p/gu)).toHaveLength(1);
    } finally {
      screen.dispose();
    }
  });

  it("retries a one-shot MathJax failure without requiring more Agent output", async () => {
    const output: string[] = [];
    const renderer = new DelayedMathRenderer();
    renderer.failNext = 1;
    const screen = new FormulaScreen({
      cols: 80,
      rows: 24,
      capabilities,
      scale: 1,
      renderer,
      writeOuter: (data) => output.push(String(data))
    });
    try {
      await screen.write("\x1b[2J\x1b[H\\[\r\nE=mc^2\r\n\\]");
      await screen.flushScan();
      expect(output.join("")).not.toContain("a=p");

      await waitFor(() => output.join("").includes("a=p"));
      expect(renderer.calls).toBe(2);
      expect(output.join("").match(/\x1b_Ga=p/gu)).toHaveLength(1);
    } finally {
      screen.dispose();
    }
  });

  it("replaces a reflowed placement transactionally while a status bar updates", async () => {
    const output: string[] = [];
    const debug: string[] = [];
    const renderer = new DelayedMathRenderer();
    const screen = new FormulaScreen({
      cols: 140,
      rows: 12,
      capabilities,
      scale: 1,
      renderer,
      writeOuter: (data) => output.push(String(data)),
      debug: (message) => debug.push(message)
    });
    const formula = "\\[\\nabla \\times \\mathbf{B}=\\mu_0\\mathbf{J}+"
      + "\\mu_0\\varepsilon_0\\frac{\\partial \\mathbf{E}}{\\partial t}"
      + "+\\frac{\\rho}{\\varepsilon_0}\\]";
    let interval: NodeJS.Timeout | undefined;
    try {
      await screen.write(`\x1b[2J\x1b[H${formula}\r\nexplanation`);
      await screen.flushScan();
      const initial = output.join("");
      const oldImageId = initial.match(/a=t,[^;]*i=(\d+)/u)?.[1];
      const oldPlacementId = initial.match(/a=p,[^;]*p=(\d+)/u)?.[1];
      expect(oldImageId).toBeTruthy();
      expect(oldPlacementId).toBeTruthy();

      let renderStarted!: () => void;
      const started = new Promise<void>((resolve) => { renderStarted = resolve; });
      renderer.delay = true;
      renderer.started = renderStarted;
      output.length = 0;
      screen.resize(60, 12);
      await started;
      let tick = 0;
      interval = setInterval(() => {
        void screen.write(`\x1b[12;1Hstatus ${tick++}`);
      }, 20);
      await new Promise((resolve) => setTimeout(resolve, 100));
      renderer.release?.();
      await waitFor(() => debug.filter((message) => message.startsWith("rendered ")).length === 2);

      const replacement = output.join("");
      expect(replacement).toContain("a=p");
      expect(replacement).toContain(
        `a=d,d=i,i=${oldImageId},p=${oldPlacementId}`
      );
    } finally {
      if (interval) clearInterval(interval);
      renderer.release?.();
      screen.dispose();
    }
  });

  it("preserves a formula image after it scrolls off-screen and the font size changes", async () => {
    const output: string[] = [];
    const debug: string[] = [];
    const screen = new FormulaScreen({
      cols: 60,
      rows: 8,
      capabilities,
      scale: 1,
      writeOuter: (data) => output.push(String(data)),
      debug: (message) => debug.push(message)
    });
    try {
      screen.write("\x1b[2J\x1b[H[\r\nE=mc^2\r\n]");
      await waitFor(() => debug.some((message) => message.startsWith("rendered ")));
      const firstImageId = output.join("").match(/a=t,[^;]*i=(\d+)/u)?.[1];
      expect(firstImageId).toBeTruthy();

      output.length = 0;
      screen.write(Array.from({ length: 12 }, (_, index) => `\r\nline ${index}`).join(""));
      await new Promise((resolve) => setTimeout(resolve, 300));
      screen.resize(70, 8);
      screen.updateCapabilities({
        ...capabilities,
        cell: { width: 10, height: 20, source: "cell-query" }
      });
      await new Promise((resolve) => setTimeout(resolve, 300));

      const lifecycleOutput = output.join("");
      expect(lifecycleOutput).not.toContain(`a=d,d=I,i=${firstImageId}`);
      expect(lifecycleOutput).not.toContain(`a=d,d=i,i=${firstImageId}`);
      expect(lifecycleOutput).not.toContain("a=d,d=R,x=1400000000,y=1999999999");
    } finally {
      screen.dispose();
    }
  });

  it("retains an off-screen inline formula when widening disposes both continuation-row markers", async () => {
    const output: string[] = [];
    const debug: string[] = [];
    const screen = new FormulaScreen({
      cols: 50,
      rows: 8,
      capabilities,
      scale: 1,
      writeOuter: (data) => output.push(String(data)),
      debug: (message) => debug.push(message)
    });
    try {
      // The formula is wholly on a soft-wrapped continuation row. xterm merges
      // that row into the preceding logical line at 100 columns and disposes
      // both markers, while Ghostty keeps the off-screen Kitty placement pin.
      await screen.write([
        "\x1b[2J\x1b[H",
        "This is a deliberately long prefix before the trailing formula ",
        "\\(x_i^2\\)\r\nnext"
      ].join(""));
      await screen.flushScan();
      const initial = output.join("");
      const imageId = initial.match(/a=p,i=(\d+),p=(\d+)/u)?.[1];
      const placementId = initial.match(/a=p,i=(\d+),p=(\d+)/u)?.[2];
      expect(imageId).toBeTruthy();
      expect(placementId).toBeTruthy();

      await screen.write("\r\n" + "line\r\n".repeat(20));
      await screen.flushScan();
      output.length = 0;
      screen.resize(100, 8);
      await screen.flushScan();

      const resized = output.join("");
      expect(resized).not.toContain(`a=d,d=i,i=${imageId},p=${placementId}`);
      expect(resized).not.toContain(`a=d,d=I,i=${imageId}`);
      expect(screen.hasTerminalPlacements).toBe(true);
      expect(debug).toContain("retained 1 markerless scrollback formula placement(s)");
      // An acknowledgement can arrive after resize detached the placement;
      // it still belongs to this screen and must be recognized.
      expect(screen.markTerminalPlacementAccepted(
        Number(imageId),
        Number(placementId)
      )).toBe(true);
    } finally {
      screen.dispose();
    }
  });

  it("invalidates a quota-evicted image even after its placement detached from xterm", async () => {
    const output: string[] = [];
    const screen = new FormulaScreen({
      cols: 50,
      rows: 8,
      capabilities,
      scale: 1,
      writeOuter: (data) => output.push(String(data))
    });
    try {
      await screen.write([
        "This is a deliberately long prefix before the trailing formula ",
        "\\(x_i^2\\)\r\nnext"
      ].join(""));
      await screen.flushScan();
      const initial = output.join("").match(/a=p,i=(\d+),p=(\d+)/u);
      expect(initial).toBeTruthy();

      await screen.write("\r\n" + "line\r\n".repeat(20));
      await screen.flushScan();
      screen.resize(100, 8);
      await screen.flushScan();
      expect(screen.hasTerminalPlacements).toBe(true);

      output.length = 0;
      expect(screen.invalidateTerminalImage(
        Number(initial![1]),
        "Kitty ENOENT",
        false
      )).toBe(true);
      expect(output.join("")).toContain(`a=d,d=I,i=${initial![1]}`);
      expect(screen.hasTerminalPlacements).toBe(false);
    } finally {
      screen.dispose();
    }
  });

  it("does not delete a block formula while only part of it is visible", async () => {
    const output: string[] = [];
    const screen = new FormulaScreen({
      cols: 40,
      rows: 5,
      capabilities,
      scale: 1,
      writeOuter: (data) => output.push(String(data))
    });
    try {
      await screen.write("\x1b[2J\x1b[H[\r\nE=mc^2\r\n]");
      await screen.flushScan();
      const initial = output.join("");
      const imageId = initial.match(/a=t,[^;]*i=(\d+)/u)?.[1];
      const placementId = initial.match(/a=p,[^;]*p=(\d+)/u)?.[1];
      expect(imageId).toBeTruthy();
      expect(placementId).toBeTruthy();

      output.length = 0;
      for (let index = 0; index < 3; index += 1) {
        await screen.write(`\r\nline ${index}`);
        await screen.flushScan();
      }
      expect(output.join(""))
        .not.toContain(`a=d,d=i,i=${imageId},p=${placementId}`);
    } finally {
      screen.dispose();
    }
  });

  it("deletes a partially visible placement after its visible source is overwritten", async () => {
    const output: string[] = [];
    const screen = new FormulaScreen({
      cols: 40,
      rows: 5,
      capabilities,
      scale: 1,
      writeOuter: (data) => output.push(String(data))
    });
    try {
      await screen.write("\x1b[2J\x1b[H[\r\nE=mc^2\r\n]");
      await screen.flushScan();
      const initial = output.join("");
      const imageId = initial.match(/a=t,[^;]*i=(\d+)/u)?.[1];
      const placementId = initial.match(/a=p,[^;]*p=(\d+)/u)?.[1];
      expect(imageId).toBeTruthy();
      expect(placementId).toBeTruthy();

      for (let index = 0; index < 3; index += 1) {
        await screen.write(`\r\nline ${index}`);
        await screen.flushScan();
      }
      output.length = 0;
      await screen.write(Array.from(
        { length: 5 },
        (_, row) => `\x1b[${row + 1};1H\x1b[2Kordinary ${row}`
      ).join(""));
      await screen.flushScan();
      expect(output.join(""))
        .toContain(`a=d,d=i,i=${imageId},p=${placementId}`);
    } finally {
      screen.dispose();
    }
  });

  it("uploads an identical PNG once and shares it across placements", async () => {
    const output: string[] = [];
    const debug: string[] = [];
    const screen = new FormulaScreen({
      cols: 80,
      rows: 24,
      capabilities,
      scale: 1,
      writeOuter: (data) => output.push(String(data)),
      debug: (message) => debug.push(message)
    });
    try {
      screen.write([
        "\x1b[2J\x1b[H",
        "\\[\r\nE=mc^2\r\n\\]\r\n",
        "\\[\r\nE=mc^2\r\n\\]\r\n"
      ].join(""));
      await waitFor(() => debug.filter((message) => message.startsWith("rendered ")).length === 2);
      const encoded = output.join("");
      expect(encoded.match(/\x1b_Ga=t/gu)).toHaveLength(1);
      expect(encoded.match(/\x1b_Ga=p/gu)).toHaveLength(2);
      const imageIds = Array.from(encoded.matchAll(/a=p,i=(\d+)/gu), (match) => match[1]);
      expect(new Set(imageIds).size).toBe(1);
    } finally {
      screen.dispose();
    }
  });

  it("evicts only idle terminal uploads while retaining the rendered cache", async () => {
    const output: string[] = [];
    const screen = new FormulaScreen({
      cols: 80,
      rows: 12,
      capabilities,
      scale: 1,
      maxTerminalImages: 2,
      writeOuter: (data) => output.push(String(data))
    });
    try {
      for (const latex of ["x=1", "y=2"]) {
        await screen.write(`\x1b[H\x1b[2K\\[${latex}\\]`);
        await screen.flushScan();
      }
      expect(output.join("")).not.toContain("a=d,d=I");

      output.length = 0;
      await screen.write("\x1b[H\x1b[2K\\[z=3\\]");
      await screen.flushScan();
      const third = output.join("");
      expect(third.match(/a=d,d=I/gu)).toHaveLength(1);
      expect(third.match(/\x1b_Ga=p/gu)).toHaveLength(1);

      output.length = 0;
      await screen.write("\x1b[H\x1b[2K\\[x=1\\]");
      await screen.flushScan();
      // The PNG/MathJax result is still cached, but an evicted terminal id must
      // be uploaded once more before it can be placed safely.
      expect(output.join("").match(/\x1b_Ga=t/gu)).toHaveLength(1);
    } finally {
      screen.dispose();
    }
  });

  it("keeps PNG base64 out of the terminal stream with temporary-file transport", async () => {
    const output: string[] = [];
    const debug: string[] = [];
    const transmitter = new KittyImageTransmitter("temp-file");
    const screen = new FormulaScreen({
      cols: 80,
      rows: 24,
      capabilities,
      scale: 1,
      transmitImage: transmitter.transmit,
      writeOuter: (data) => output.push(String(data)),
      debug: (message) => debug.push(message)
    });
    try {
      screen.write([
        "\x1b[2J\x1b[H",
        "\\[\r\nE=mc^2\r\n\\]\r\n",
        "\\[\r\nE=mc^2\r\n\\]\r\n"
      ].join(""));
      await waitFor(() => debug.filter((message) => message.startsWith("rendered ")).length === 2);
      const encoded = output.join("");
      expect(encoded.match(/a=t,f=100,t=t/gu)).toHaveLength(1);
      expect(encoded.match(/a=p/gu)).toHaveLength(2);
      expect(encoded).not.toContain("iVBORw0KGgo");
    } finally {
      screen.dispose();
      await transmitter.dispose(0);
    }
  });

  it("keeps normal-buffer placements tracked across an alternate-screen round trip", async () => {
    const output: string[] = [];
    const debug: string[] = [];
    const screen = new FormulaScreen({
      cols: 80,
      rows: 24,
      capabilities,
      scale: 1,
      writeOuter: (data) => output.push(String(data)),
      debug: (message) => debug.push(message)
    });
    try {
      screen.write("\x1b[2J\x1b[H\\[\r\nE=mc^2\r\n\\]");
      await waitFor(() => debug.filter((message) => message.startsWith("rendered ")).length === 1);
      output.length = 0;

      screen.write("\x1b[?1049h");
      screen.write("alternate screen");
      screen.write("\x1b[?1049l");
      await new Promise((resolve) => setTimeout(resolve, 400));

      const lifecycleOutput = output.join("");
      expect(lifecycleOutput).not.toContain("\x1b_Ga=t");
      expect(lifecycleOutput).not.toContain("\x1b_Ga=p");
      expect(debug.filter((message) => message.startsWith("rendered "))).toHaveLength(1);
    } finally {
      screen.dispose();
    }
  });

  it("applies a preserved clear to the buffer active at its exact output offset", async () => {
    const output: string[] = [];
    const screen = new FormulaScreen({
      cols: 80,
      rows: 24,
      capabilities,
      scale: 1,
      preserveImagesOnClear: true,
      writeOuter: (data) => output.push(String(data))
    });
    try {
      await screen.write("\x1b[2J\x1b[H\\[\r\nE=mc^2\r\n\\]");
      await screen.flushScan();
      const initial = output.join("");
      const normalImageId = initial.match(/a=t,[^;]*i=(\d+)/u)?.[1];
      const normalPlacementId = initial.match(/a=p,[^;]*p=(\d+)/u)?.[1];
      expect(normalImageId).toBeTruthy();
      expect(normalPlacementId).toBeTruthy();

      output.length = 0;
      const transformed = new TerminalOutputTransformer().push(
        "\x1b[?1049h\x1b[2Jalternate\x1b[?1049l",
        true
      );
      await screen.write(
        transformed.data,
        false,
        transformed.preservedEraseDisplayOffsets
      );
      await screen.flushScan();
      expect(output.join(""))
        .not.toContain(`a=d,d=i,i=${normalImageId},p=${normalPlacementId}`);
      expect(output.join("")).not.toContain("\x1b_Ga=t");
    } finally {
      screen.dispose();
    }
  });

  it("uploads identical formulas independently for normal and alternate screens", async () => {
    const output: string[] = [];
    const debug: string[] = [];
    const screen = new FormulaScreen({
      cols: 80,
      rows: 24,
      capabilities,
      scale: 1,
      writeOuter: (data) => output.push(String(data)),
      debug: (message) => debug.push(message)
    });
    const formula = "\\[\r\nE=mc^2\r\n\\]";
    try {
      screen.write(`\x1b[2J\x1b[H${formula}`);
      await waitFor(() => debug.filter((message) => message.startsWith("rendered ")).length === 1);
      const normalUpload = output.join("").match(/a=t,[^;]*i=(\d+)/u)?.[1];
      expect(normalUpload).toBeTruthy();

      output.length = 0;
      screen.write(`\x1b[?1049h\x1b[2J\x1b[H${formula}`);
      await waitFor(() => debug.filter((message) => message.startsWith("rendered ")).length === 2);
      const alternateOutput = output.join("");
      const alternateUpload = alternateOutput.match(/a=t,[^;]*i=(\d+)/u)?.[1];
      expect(alternateUpload).toBeTruthy();
      expect(alternateUpload).not.toBe(normalUpload);
      expect(alternateOutput.match(/\x1b_Ga=t/gu)).toHaveLength(1);

      output.length = 0;
      screen.write("\x1b[?1049l");
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(output.join("")).not.toContain("\x1b_Ga=t");
      expect(debug.filter((message) => message.startsWith("rendered "))).toHaveLength(2);
    } finally {
      screen.dispose();
    }
  });

  it("replaces alternate-screen placements after an explicit row scroll", async () => {
    const output: string[] = [];
    const screen = new FormulaScreen({
      cols: 80,
      rows: 8,
      capabilities,
      scale: 1,
      writeOuter: (data) => output.push(String(data))
    });
    const formula = "\\[\r\nE=mc^2\r\n\\]";
    try {
      await screen.write(`\x1b[?1049h\x1b[H${formula}`);
      await screen.flushScan();
      const first = output.join("").match(/a=p,i=(\d+),p=(\d+)/u);
      expect(first).toBeTruthy();

      output.length = 0;
      await screen.write(
        "\x1b[1S\x1b[H\x1b[2K\\[\r\n\x1b[2KE=mc^2\r\n\x1b[2K\\]"
      );
      await screen.flushScan();
      const replacement = output.join("");
      expect(replacement).toContain(`a=d,d=i,i=${first![1]},p=${first![2]}`);
      expect(replacement.match(/\x1b_Ga=p/gu)).toHaveLength(1);
      expect(replacement).not.toContain("\x1b_Ga=t");
    } finally {
      screen.dispose();
    }
  });

  it("invalidates markerless alternate placements across a row resize", async () => {
    const output: string[] = [];
    const screen = new FormulaScreen({
      cols: 80,
      rows: 10,
      capabilities,
      scale: 1,
      writeOuter: (data) => output.push(String(data))
    });
    try {
      await screen.write("\x1b[?1049h\x1b[9;1H\\[\r\nE=mc^2\r\n\\]");
      await screen.flushScan();
      const first = output.join("").match(/a=p,i=(\d+),p=(\d+)/u);
      expect(first).toBeTruthy();

      output.length = 0;
      screen.resize(80, 5);
      await screen.flushScan();
      const resized = output.join("");
      expect(resized).toContain(`a=d,d=i,i=${first![1]},p=${first![2]}`);
      expect(resized.match(/\x1b_Ga=p/gu)).toHaveLength(1);
    } finally {
      screen.dispose();
    }
  });

  it("does not delete Ghostty-retained mode-47 placements on a pure re-entry", async () => {
    const output: string[] = [];
    const screen = new FormulaScreen({
      cols: 80,
      rows: 8,
      capabilities,
      scale: 1,
      writeOuter: (data) => output.push(String(data))
    });
    try {
      await screen.write("\x1b[?47h\x1b[H\\[\r\nE=mc^2\r\n\\]");
      await screen.flushScan();
      expect(output.join("")).toContain("a=p");

      await screen.write("\x1b[?47l");
      await screen.flushScan();
      output.length = 0;
      await screen.write("\x1b[?47h");
      await screen.flushScan();
      expect(output.join("")).not.toContain("a=d,d=i");
      expect(output.join("")).not.toContain("a=p");
      expect(screen.hasTerminalPlacements).toBe(true);
    } finally {
      screen.dispose();
    }
  });

  it("renders formulas at output checkpoints before a long response scrolls them away", async () => {
    const debug: string[] = [];
    const screen = new FormulaScreen({
      cols: 60,
      rows: 8,
      capabilities,
      scale: 1,
      writeOuter: () => undefined,
      debug: (message) => debug.push(message)
    });
    const splitter = new OutputCheckpointSplitter(4);
    const transcript = [
      "\x1b[2J\x1b[H\\[\r\nx=1\r\n\\]\r\nafter x\r\n",
      "\\[\r\ny=2\r\n\\]\r\nafter y\r\n",
      "\\[\r\nz=3\r\n\\]\r\nafter z\r\n"
    ].join("");
    try {
      for (const slice of splitter.push(transcript)) {
        await screen.write(slice.data);
        if (slice.checkpoint) await screen.flushScan();
      }
      await screen.flushScan();
      expect(debug.filter((message) => message.startsWith("rendered "))).toHaveLength(3);
    } finally {
      screen.dispose();
    }
  });

  it("holds an output checkpoint across a resize probe before later rows can scroll", async () => {
    const output: string[] = [];
    const screen = new FormulaScreen({
      cols: 60,
      rows: 6,
      capabilities,
      scale: 1,
      writeOuter: (data) => output.push(String(data))
    });
    try {
      const epoch = screen.invalidateLayout();
      screen.resize(60, 6, epoch, true);
      await screen.write("\x1b[2J\x1b[H\\[\r\nx=1\r\n\\]");

      let checkpointCompleted = false;
      const checkpoint = screen.flushScan(true).then(() => { checkpointCompleted = true; });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(checkpointCompleted).toBe(false);
      expect(output.join("")).not.toContain("a=p");

      screen.updateCapabilities(capabilities, epoch);
      await checkpoint;
      expect(output.join("")).toContain("a=p");

      // This is the next queued PTY slice. The formula already has a terminal
      // pin before these rows are allowed to move it into scrollback.
      await screen.write("\r\nlater".repeat(8));
      expect(output.join("").indexOf("a=p")).toBeGreaterThanOrEqual(0);
    } finally {
      screen.dispose();
    }
  });

  it("does not deadlock a checkpoint behind later reserved PTY slices", async () => {
    const output: string[] = [];
    const screen = new FormulaScreen({
      cols: 60,
      rows: 8,
      capabilities,
      scale: 1,
      writeOuter: (data) => output.push(String(data))
    });
    try {
      // The proxy reserves every slice immediately. Slice B therefore appears
      // pending while slice A is executing its checkpoint in outputQueue.
      screen.queueWrite();
      screen.queueWrite();
      await screen.write("\x1b[2J\x1b[H\\[\r\nx=1\r\n\\]", true);
      await Promise.race([
        screen.flushScan(true),
        new Promise<never>((_, reject) => setTimeout(
          () => reject(new Error("checkpoint waited for a later queue entry")),
          3_000
        ))
      ]);
      expect(output.join("")).toContain("a=p");

      await screen.write("\r\nlater slice", true);
      await screen.flushScan();
    } finally {
      screen.dispose();
    }
  });

  it("keeps the old placement when rapid zoom invalidates its replacement render", async () => {
    const output: string[] = [];
    const debug: string[] = [];
    const renderer = new DelayedMathRenderer();
    const screen = new FormulaScreen({
      cols: 60,
      rows: 10,
      capabilities,
      scale: 1,
      renderer,
      writeOuter: (data) => output.push(String(data)),
      debug: (message) => debug.push(message)
    });
    try {
      await screen.write([
        "\x1b[2J\x1b[H\\[\r\nE=mc^2\r\n\\]\r\n",
        "line 1\r\nline 2\r\nline 3\r\nline 4"
      ].join(""));
      await screen.flushScan();
      expect(debug.filter((message) => message.startsWith("rendered "))).toHaveLength(1);
      const initial = output.join("");
      const imageId = initial.match(/a=t,[^;]*i=(\d+)/u)?.[1];
      const placementId = initial.match(/a=p,[^;]*p=(\d+)/u)?.[1];
      expect(imageId).toBeTruthy();
      expect(placementId).toBeTruthy();
      output.length = 0;

      let renderStarted!: () => void;
      const started = new Promise<void>((resolve) => { renderStarted = resolve; });
      renderer.delay = true;
      renderer.started = renderStarted;
      screen.updateCapabilities({
        ...capabilities,
        cell: { width: 10, height: 20, source: "cell-query" }
      });
      await started;

      // A second zoom moves the formula out of the four-row viewport while
      // the replacement for the previous size is still being prepared.
      screen.resize(60, 4);
      renderer.release?.();
      await new Promise((resolve) => setTimeout(resolve, 500));

      const lifecycleOutput = output.join("");
      expect(lifecycleOutput).not.toContain(`a=d,d=i,i=${imageId},p=${placementId}`);

      // When zooming back out, the formula becomes visible again. It may be
      // upgraded to the crisp cached size, but the old placement cannot be
      // removed unless its replacement is emitted in the same transaction.
      output.length = 0;
      screen.resize(60, 10);
      await waitFor(() => debug.filter((message) => message.startsWith("rendered ")).length === 2);
      const restored = output.join("");
      const deletionOffset = restored.indexOf(`a=d,d=i,i=${imageId},p=${placementId}`);
      if (deletionOffset >= 0) {
        expect(restored.indexOf("a=p", deletionOffset)).toBeGreaterThan(deletionOffset);
      }
    } finally {
      renderer.release?.();
      screen.dispose();
    }
  });
});
