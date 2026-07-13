import { describe, expect, it } from "vitest";
import { calculateFormulaGeometry } from "../src/geometry.js";

const cell = { width: 10, height: 20, source: "cell-query" as const };

describe("calculateFormulaGeometry", () => {
  it("maps MathJax ex height to terminal glyph size without enlarging", () => {
    const geometry = calculateFormulaGeometry({
      aspectRatio: 4,
      naturalHeightEx: 2,
      depthEx: 0,
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
      depthEx: 0,
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

  it("left-aligns inline math within source columns", () => {
    const geometry = calculateFormulaGeometry({
      aspectRatio: 1,
      naturalHeightEx: 1,
      depthEx: 0,
      columns: 12,
      rows: 1,
      cell,
      scale: 1,
      display: false
    });
    expect(geometry.offsetX).toBeLessThan(cell.width);
    expect(geometry.offsetY).toBeGreaterThanOrEqual(0);
  });

  it("aligns inline formulas using their MathJax baselines", () => {
    const upright = calculateFormulaGeometry({
      aspectRatio: 1,
      naturalHeightEx: 1.5,
      depthEx: 0,
      columns: 8,
      rows: 1,
      cell,
      scale: 1,
      display: false
    });
    const descending = calculateFormulaGeometry({
      aspectRatio: 1,
      naturalHeightEx: 1.5,
      depthEx: 0.5,
      columns: 8,
      rows: 1,
      cell,
      scale: 1,
      display: false
    });
    const uprightBaseline = upright.offsetY + upright.formulaHeight;
    const descendingBaseline = descending.offsetY
      + descending.formulaHeight * (1 - 0.5 / 1.5);
    expect(Math.abs(uprightBaseline - descendingBaseline)).toBeLessThanOrEqual(1);
  });
});
