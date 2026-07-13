import { describe, expect, it } from "vitest";
import { calculateFormulaGeometry } from "../src/geometry.js";

const cell = { width: 10, height: 20, source: "cell-query" as const };

describe("calculateFormulaGeometry", () => {
  it("maps MathJax ex height to terminal glyph size without enlarging", () => {
    const geometry = calculateFormulaGeometry({
      aspectRatio: 4,
      naturalHeightEx: 2,
      columns: 80,
      rows: 3,
      cell,
      scale: 1,
      display: true
    });
    expect(geometry.canvasWidth).toBe(800);
    expect(geometry.canvasHeight).toBe(60);
    expect(geometry.formulaHeight).toBe(18);
    expect(geometry.formulaWidth).toBe(72);
  });

  it("shrinks an over-wide formula proportionally", () => {
    const geometry = calculateFormulaGeometry({
      aspectRatio: 100,
      naturalHeightEx: 2,
      columns: 20,
      rows: 3,
      cell,
      scale: 1,
      display: true
    });
    expect(geometry.formulaWidth).toBeLessThanOrEqual(180);
    // Integer pixels introduce rounding when a very wide expression becomes
    // only a couple of pixels tall, but it must remain strongly horizontal.
    expect(geometry.formulaWidth / geometry.formulaHeight).toBeGreaterThan(80);
  });
});
