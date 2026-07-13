import { describe, expect, it } from "vitest";
import { FormulaScreen } from "../src/screen.js";
import { OutputCheckpointSplitter } from "../src/output-checkpoints.js";
import { MathRenderer } from "../src/math-renderer.js";

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
  started?: () => void;
  release?: () => void;

  override async render(...args: Parameters<MathRenderer["render"]>): ReturnType<MathRenderer["render"]> {
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

describe("FormulaScreen lifecycle", () => {
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
      // The exact PNGs remain uploaded across CSI 2J. Only their placements
      // are recreated when the TUI redraws the same formulas.
      expect(redraw).not.toContain("\x1b_Ga=t");
      expect(redraw.match(/\x1b_Ga=p/gu)).toHaveLength(2);
    } finally {
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
      expect(lifecycleOutput).not.toContain("a=d,d=R,x=1400000000,y=1999999999");
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
