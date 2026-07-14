import { describe, expect, it } from "vitest";
import { detectFormulaRegions, detectorInternals } from "../src/detect.js";

describe("detectFormulaRegions", () => {
  it("does not infer a second formula inside an explicit delimiter", () => {
    const regions = detectFormulaRegions(["value \\(\\operatorname{Var}(X_i)\\) suffix"]);
    expect(regions).toHaveLength(1);
    expect(regions[0]).toMatchObject({
      latex: "\\operatorname{Var}(X_i)",
      confidence: "explicit"
    });
  });

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

  it("detects every numbered display equation without assigning layout semantics", () => {
    const regions = detectFormulaRegions([
      "1. $$\\oiint_S \\mathbf E \\cdot d\\mathbf A=Q/\\varepsilon_0$$",
      "2. $$\\oiint_S \\mathbf B \\cdot d\\mathbf A=0$$",
      "3. $$\\oint_C \\mathbf E \\cdot d\\mathbf l=-\\frac{d}{dt}\\oiint_S \\mathbf B \\cdot d\\mathbf A$$",
      "4. $$\\oint_C \\mathbf B \\cdot d\\mathbf l=\\mu_0 I+\\mu_0\\varepsilon_0\\frac{d}{dt}\\oiint_S \\mathbf E \\cdot d\\mathbf A$$"
    ]);
    expect(regions).toHaveLength(4);
    expect(regions.map((region) => region.startCol)).toEqual([3, 3, 3, 3]);
    expect(regions.every((region) => region.display)).toBe(true);
  });

  it("reassembles display math hard-wrapped by a terminal TUI", () => {
    const [region] = detectFormulaRegions([
      "4. $$\\oint_C \\mathbf{B} \\cdot d\\mathbf{l} = \\mu_0 I_{\\mathrm{enc}} +",
      "\\mu_0\\varepsilon_0\\frac{d}{dt}\\int_S \\mathbf{E} \\cdot d\\mathbf{A}$$"
    ]);
    expect(region).toMatchObject({
      startRow: 0,
      endRow: 1,
      startCol: 3,
      display: true,
      confidence: "explicit"
    });
    expect(region?.latex).toContain("\\oint_C \\mathbf{B}");
    expect(region?.latex).toContain("d\\mathbf{A}");
  });

  it("does not give a shared blank row to only one of two displays", () => {
    const regions = detectFormulaRegions([
      "$$\\frac{1}{x}$$",
      "",
      "$$\\frac{1}{x}$$"
    ]);
    expect(regions).toHaveLength(2);
    expect(regions.map((region) => region.endRow - region.startRow + 1)).toEqual([1, 1]);
    expect(regions.map((region) => region.endCol - region.startCol))
      .toEqual([regions[0]!.endCol, regions[0]!.endCol]);
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

  it("supports ordinary one-letter and scripted single-dollar math", () => {
    const regions = detectFormulaRegions([
      "variables $x$, $c^2$, $E_0$, $f(t)$, and $\\rho$; not prose $USD$ or price $12.50$"
    ]);
    expect(regions.map((region) => region.latex)).toEqual(["x", "c^2", "E_0", "f(t)", "\\rho"]);
    expect(regions.every((region) => region.confidence === "explicit")).toBe(true);
  });

  it("detects compound scripts inside explicit single-dollar delimiters", () => {
    const regions = detectFormulaRegions([
      "identities $x^2+y^2$, $10^8$, $a_{n+1}$, and product $xy$"
    ]);
    expect(regions.map((region) => region.latex)).toEqual([
      "x^2+y^2",
      "10^8",
      "a_{n+1}",
      "xy"
    ]);
  });

  it("leaves TeX-looking Markdown code spans and fences untouched", () => {
    const regions = detectFormulaRegions([
      "render $x^2$, but show `$y^2$` and `\\(z^2\\)` literally",
      "~~~latex",
      "$$E=mc^2$$",
      "~~~",
      "afterwards $p^2$"
    ]);
    expect(regions.map((region) => region.latex)).toEqual(["x^2", "p^2"]);
  });

  it("only closes a Markdown fence with the same marker and sufficient length", () => {
    const regions = detectFormulaRegions([
      "````math",
      "$x$",
      "```",
      "$y$",
      "~~~~",
      "$z$",
      "````",
      "$w$"
    ]);
    expect(regions.map((region) => region.latex)).toEqual(["w"]);
  });

  it("keeps escaped dollars inside dollar-delimited formulas", () => {
    const regions = detectFormulaRegions([
      "inline $x=\\$5$ and display $$y=\\$10$$"
    ]);
    expect(regions.map((region) => [region.latex, region.display])).toEqual([
      ["y=\\$10", true],
      ["x=\\$5", false]
    ]);
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

  it("infers common functions and uppercase Greek after delimiters are stripped", () => {
    const regions = detectFormulaRegions([
      "angle (\\Delta) and signal (\\sin x), but note (ordinary prose)"
    ]);
    expect(regions.map((region) => region.latex)).toEqual(["\\Delta", "\\sin x"]);
  });

  it("detects each inferred symbol without interpreting its surrounding sentence", () => {
    const regions = detectFormulaRegions([
      "其中 (\\mathbf E) 为电场，(\\mathbf B) 为磁感应强度，(\\rho) 为电荷密度"
    ]);
    expect(regions.map((region) => region.latex)).toEqual([
      "\\mathbf E",
      "\\mathbf B",
      "\\rho"
    ]);
    expect(regions.every((region) => region.confidence === "inferred")).toBe(true);
  });

  it("detects explicit symbols independently from a paired prose clause", () => {
    const regions = detectFormulaRegions([
      "其中 \\(\\mathbf E\\) 为电场，\\(\\mathbf B\\) 为磁感应强度，"
      + "\\(\\varepsilon_0\\)、\\(\\mu_0\\) 分别为真空介电常数与磁导率。"
    ]);
    expect(regions.map((region) => region.latex)).toEqual([
      "\\mathbf E",
      "\\mathbf B",
      "\\varepsilon_0",
      "\\mu_0"
    ]);
    expect(regions.every((region) => region.confidence === "explicit")).toBe(true);
  });

  it("infers chemistry and physics commands after delimiters are stripped", () => {
    const regions = detectFormulaRegions([
      "reaction (\\ce{2H2 + O2 -> 2H2O}) and rate (\\dv{x}{t})"
    ]);
    expect(regions.map((region) => region.latex)).toEqual([
      "\\ce{2H2 + O2 -> 2H2O}",
      "\\dv{x}{t}"
    ]);
  });

  it("renders a lone definition symbol without requiring a consecutive group", () => {
    const regions = detectFormulaRegions(["- (E): rest energy"]);
    expect(regions).toEqual([expect.objectContaining({
      startCol: 2,
      endCol: 5,
      latex: "E",
      display: false,
      confidence: "inferred"
    })]);
  });

  it("does not duplicate a TeX symbol in a lone definition", () => {
    const regions = detectFormulaRegions(["- (\\rho): charge density"]);
    expect(regions).toHaveLength(1);
    expect(regions[0]?.latex).toBe("\\rho");
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

  it("infers compound scripted ASCII math after delimiters are stripped", () => {
    const regions = detectFormulaRegions([
      "identities (x^2+y^2), scale (10^8), sequence (a_{n+1}), but release (version_2)"
    ]);
    expect(regions.map((region) => region.latex)).toEqual([
      "x^2+y^2",
      "10^8",
      "a_{n+1}"
    ]);
  });

  it("supports nested parentheses inside inferred inline formulas", () => {
    const [region] = detectFormulaRegions(["value (\\operatorname{Var}(X_i))：方差"]);
    expect(region?.latex).toBe("\\operatorname{Var}(X_i)");
  });

  it("detects display blocks longer than the old sixteen-row window", () => {
    const body = Array.from({ length: 20 }, (_, index) => `x_${index}+`);
    const [region] = detectFormulaRegions(["\\[", ...body, "x=1", "\\]"]);
    expect(region).toMatchObject({
      startRow: 0,
      endRow: 22,
      display: true,
      confidence: "explicit"
    });
    expect(region?.latex).toContain("x_19+");
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
