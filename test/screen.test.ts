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
      const cleanup = output.join("");
      expect(cleanup).toContain(`a=d,d=I,i=${firstImageId}`);
      expect(cleanup).toContain("a=d,d=Z,z=");

      await waitFor(() => debug.filter((message) => message.startsWith("rendered ")).length === 2);
      expect(output.join("").match(/\x1b_Ga=T/gu)).toHaveLength(1);
    } finally {
      screen.dispose();
    }
  });
});
