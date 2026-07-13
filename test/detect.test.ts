import { describe, expect, it } from "vitest";
import { detectFormulaRegions, detectorInternals } from "../src/detect.js";

describe("detectFormulaRegions", () => {
  it("detects an explicit display block", () => {
    const regions = detectFormulaRegions([
      "before",
      "\\[",
      "D_{KL}(P\\|M)=\\frac12\\sum_i P_i",
      "\\]",
      "after"
    ]);
    expect(regions).toHaveLength(1);
    expect(regions[0]).toMatchObject({ startRow: 1, endRow: 3, display: true, confidence: "explicit" });
  });

  it("infers the bracket form left by terminal markdown renderers", () => {
    const regions = detectFormulaRegions([
      "[",
      "D_{KL}(P\\|M)=\\sum_i P(x_i)\\log\\frac{P(x_i)}{M(x_i)}",
      "]"
    ]);
    expect(regions).toHaveLength(1);
    expect(regions[0]?.confidence).toBe("inferred");
  });

  it("does not mistake a normal bracketed list for math", () => {
    expect(detectFormulaRegions(["[", "alpha, beta, gamma", "]"])).toEqual([]);
  });

  it("detects inline TeX and accounts for wide Chinese text", () => {
    const [region] = detectFormulaRegions(["其中公式 \\(x_i^2\\) 成立"]);
    expect(region?.startCol).toBeGreaterThan("其中公式 ".length);
    expect(region?.display).toBe(false);
  });

  it("requires math structure for single-dollar expressions", () => {
    expect(detectFormulaRegions(["price is $12.50$ today"])).toEqual([]);
    expect(detectFormulaRegions(["value is $x_i^2$ today"])).toHaveLength(1);
  });
});

describe("math scoring", () => {
  it("scores structured latex above prose", () => {
    expect(detectorInternals.mathScore("\\frac{P_i}{Q_i}")).toBeGreaterThan(3);
    expect(detectorInternals.mathScore("ordinary prose")).toBe(0);
  });
});
