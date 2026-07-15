import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FormulaCache } from "../src/formula-cache.js";
import { MathRenderer } from "../src/math-renderer.js";
import { SCIENTIFIC_FORMULA_CORPUS } from "./scientific-formula-corpus.js";

const LAYOUT_CASES = [
  { id: "maxwell-ampere", columns: 44, rows: 4 },
  { id: "chemical-equilibrium", columns: 40, rows: 3 },
  { id: "lotka-volterra", columns: 48, rows: 4 },
  { id: "mathtools-dcases", columns: 36, rows: 4 },
  { id: "multilingual-text", columns: 40, rows: 2 }
] as const;

describe("scientific formula terminal geometry", () => {
  let root = "";
  let renderer: MathRenderer;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "tformula-scientific-layout-"));
    renderer = new MathRenderer(new FormulaCache({ root, maxDiskBytes: 0 }));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it.each(LAYOUT_CASES)("fits $id into its reserved $columns x $rows cells", async ({
    id,
    columns,
    rows
  }) => {
    const formula = SCIENTIFIC_FORMULA_CORPUS.find((candidate) => candidate.id === id)!;
    const rendered = await renderer.render(
      {
        startRow: 0,
        endRow: rows - 1,
        startCol: 0,
        endCol: columns,
        latex: formula.latex,
        display: formula.display ?? false,
        confidence: "explicit"
      },
      columns,
      rows,
      {
        kittyGraphics: true,
        foreground: "#eeeeee",
        background: "#202030",
        cell: { width: 9, height: 18, source: "cell-query" }
      },
      1
    );

    const png = Buffer.from(rendered.png);
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect(png.readUInt32BE(16)).toBe(columns * 9);
    expect(png.readUInt32BE(20)).toBe(rows * 18);
    expect(rendered.naturalAspectRatio).toBeGreaterThan(0);
    expect(rendered.naturalHeightEx).toBeGreaterThan(0);
  });
});
