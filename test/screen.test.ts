import { describe, expect, it } from "vitest";
import { FormulaScreen } from "../src/screen.js";

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

  it("deletes old image ids before rendering again after a font-size change", async () => {
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
      const firstImageId = firstOutput.match(/a=T,[^;]*i=(\d+)/u)?.[1];
      expect(firstImageId).toBeTruthy();

      output.length = 0;
      screen.resize(90, 30);
      screen.updateCapabilities({
        ...capabilities,
        cell: { width: 10, height: 20, source: "cell-query" }
      });
      await waitFor(() => debug.filter((message) => message.startsWith("rendered ")).length === 2);
      const redraw = output.join("");
      expect(redraw).toContain(`a=d,d=I,i=${firstImageId}`);
      expect(redraw).not.toContain("a=d,d=R,x=1400000000,y=1999999999");
      expect(redraw.match(/\x1b_Ga=T/gu)).toHaveLength(1);
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
      expect(redraw.match(/\x1b_Ga=T/gu)).toHaveLength(2);
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
      const firstImageId = output.join("").match(/a=T,[^;]*i=(\d+)/u)?.[1];
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
});
