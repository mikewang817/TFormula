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

  it("borrows an adjacent blank row for a standalone one-line display", () => {
    const [region] = detectFormulaRegions([
      "1. Gauss's law",
      "",
      "$$\\nabla \\cdot \\mathbf{E} = \\frac{\\rho}{\\varepsilon_0}$$",
      "Electric field explanation"
    ]);
    expect(region).toMatchObject({
      startRow: 1,
      endRow: 2,
      startCol: 0,
      display: true,
      confidence: "explicit"
    });
  });

  it("does not expand display delimiters embedded in prose", () => {
    const [region] = detectFormulaRegions(["", "before $$x=1$$ after", ""]);
    expect(region).toMatchObject({ startRow: 1, endRow: 1 });
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

  it("infers a short equation inside a bare bracket display block", () => {
    const [region] = detectFormulaRegions(["[", "E=mc^2", "]"]);
    expect(region).toMatchObject({ latex: "E=mc^2", display: true, confidence: "inferred" });
  });

  it("does not mistake a normal bracketed list for math", () => {
    expect(detectFormulaRegions(["[", "alpha, beta, gamma", "]"])).toEqual([]);
  });

  it("detects inline TeX and accounts for wide Chinese text", () => {
    const [region] = detectFormulaRegions(["其中公式 \\(x_i^2\\) 成立"]);
    expect(region?.startCol).toBeGreaterThan("其中公式 ".length);
    expect(region?.display).toBe(false);
  });

  it("uses a following blank row for a trailing inline formula and its punctuation", () => {
    const [region] = detectFormulaRegions([
      "waves propagate at \\(c=1/\\sqrt{\\mu_0\\varepsilon_0}\\).",
      ""
    ]);
    expect(region).toMatchObject({
      startRow: 0,
      endRow: 1,
      latex: "c=1/\\sqrt{\\mu_0\\varepsilon_0}\\text{.}",
      display: false,
      compact: true
    });
  });

  it("requires math structure for single-dollar expressions", () => {
    expect(detectFormulaRegions(["price is $12.50$ today"])).toEqual([]);
    expect(detectFormulaRegions(["value is $x_i^2$ today"])).toHaveLength(1);
  });

  it("infers inline math when a TUI strips backslashes from delimiters", () => {
    const regions = detectFormulaRegions([
      "- (\\rho)：电荷密度",
      "- (ordinary note)：不应渲染"
    ]);
    expect(regions).toHaveLength(1);
    expect(regions[0]?.latex).toBe("\\rho");
    expect(regions.every((region) => region.confidence === "inferred" && !region.display)).toBe(true);
  });

  it("aligns consecutive symbol definitions as a compact two-column group", () => {
    const [region] = detectFormulaRegions([
      "- (\\mathbf E)：电场强度",
      "- (\\mathbf B)：磁感应强度",
      "- (\\rho)：电荷密度",
      "- (\\mathbf J)：电流密度",
      "- (\\varepsilon_0)：真空介电常数",
      "- (\\mu_0)：真空磁导率"
    ]);
    expect(region).toMatchObject({
      startRow: 0,
      endRow: 5,
      startCol: 2,
      compact: true,
      display: false,
      confidence: "inferred"
    });
    expect(region?.latex).toContain("\\begin{array}{ll}");
    expect(region?.latex).toContain("\\mathbf E & \\text{：电场强度}");
    expect(region?.latex).toContain("\\mu_0 & \\text{：真空磁导率}");
  });

  it("supports simple symbols and embedded math in a definition group", () => {
    const [region] = detectFormulaRegions([
      "- (E)：物体的静止能量",
      "- (m)：物体的静止质量",
      "- (c)：真空中的光速，约为 (3.0\\times10^8\\ \\text{m/s})"
    ]);
    expect(region).toMatchObject({ startRow: 0, endRow: 2, compact: true });
    expect(region?.latex).toContain("E & \\text{：物体的静止能量}");
    expect(region?.latex).toContain(
      "c & \\text{：真空中的光速，约为 }3.0\\times10^8\\ \\text{m/s}"
    );
  });

  it("infers compact ASCII math but leaves ordinary parenthetical prose alone", () => {
    const regions = detectFormulaRegions([
      "当粒子静止，即动量 (p=0) 时，光速平方为 (c^2)，单位制 (SI)，接口为 (input/output)"
    ]);
    expect(regions.map((region) => region.latex)).toEqual(["p=0", "c^2"]);
  });

  it("supports nested parentheses inside inferred inline formulas", () => {
    const [region] = detectFormulaRegions(["value (\\operatorname{Var}(X_i))：方差"]);
    expect(region?.latex).toBe("\\operatorname{Var}(X_i)");
  });
});

describe("math scoring", () => {
  it("scores structured latex above prose", () => {
    expect(detectorInternals.mathScore("\\frac{P_i}{Q_i}")).toBeGreaterThan(3);
    expect(detectorInternals.mathScore("ordinary prose")).toBe(0);
    expect(detectorInternals.isLikelyMath("E=mc^2")).toBe(true);
    expect(detectorInternals.isLikelyMath("SI")).toBe(false);
  });
});
