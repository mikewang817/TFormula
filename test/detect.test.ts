import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { detectFormulas, detectorInternals } from "../src/detect.js";

/** Test-only projection while legacy coordinate assertions migrate to source.*. */
function detectedSources(lines: string[]) {
  return detectFormulas(lines).map((formula) => ({
    ...formula.source,
    latex: formula.latex,
    intent: formula.intent,
    display: formula.intent !== "inline",
    confidence: formula.confidence,
    ...(formula.compact ? { compact: true } : {})
  }));
}

const detectFormulaRegions = detectedSources;

describe("detectFormulas", () => {
  it("returns semantic detections without terminal placement fields", () => {
    const [formula] = detectFormulas(["before $$x=1$$ after"]);

    expect(formula).toEqual({
      source: { startRow: 0, endRow: 0, startCol: 7, endCol: 14 },
      latex: "x=1",
      intent: "embedded-display",
      confidence: "explicit"
    });
    expect(formula).not.toHaveProperty("display");
    expect(formula).not.toHaveProperty("canvasMode");
    expect(formula).not.toHaveProperty("sourceSegments");
    expect(formula).not.toHaveProperty("wrapSegments");
  });

  it("does not infer a second formula inside an explicit delimiter", () => {
    const regions = detectFormulaRegions(["value \\(\\operatorname{Var}(X_i)\\) suffix"]);
    expect(regions).toHaveLength(1);
    expect(regions[0]).toMatchObject({
      latex: "\\operatorname{Var}(X_i)",
      intent: "inline",
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
    expect(regions[0]).toMatchObject({
      startRow: 1,
      endRow: 3,
      intent: "display",
      display: true,
      confidence: "explicit"
    });
  });

  it("keeps standalone display detection on its exact source row", () => {
    const [region] = detectFormulaRegions([
      "1. Gauss's law",
      "",
      "$$\\nabla \\cdot \\mathbf{E} = \\frac{\\rho}{\\varepsilon_0}$$",
      "Electric field explanation"
    ]);
    expect(region).toMatchObject({
      startRow: 2,
      endRow: 2,
      startCol: 0,
      display: true,
      confidence: "explicit"
    });
  });

  it("classifies display delimiters embedded in prose explicitly", () => {
    const [region] = detectFormulaRegions(["", "before $$x=1$$ after", ""]);
    expect(region).toMatchObject({
      startRow: 1,
      endRow: 1,
      intent: "embedded-display"
    });
  });

  it("rejects malformed standalone displays without exponential backtracking", () => {
    const line = `$$${"\\a".repeat(24)}\\[x\\]$`;
    const started = performance.now();
    expect(detectFormulaRegions([line]).map((region) => region.latex)).toEqual(["x"]);
    expect(performance.now() - started).toBeLessThan(100);
  });

  it("preserves escaped dollars while classifying standalone displays", () => {
    expect(detectorInternals.isStandaloneDisplayLine("$$x\\$$y$$")).toBe(true);
    expect(detectorInternals.isStandaloneDisplayLine("$$x$$y$$")).toBe(false);
    expect(detectorInternals.isStandaloneDisplayLine("$$$$")).toBe(false);
  });

  it("recognizes inline code ranges without interpreting their contents", () => {
    expect(detectorInternals.inlineCodeRanges("```open `` tail")).toEqual([
      { start: 1, end: 10 }
    ]);
  });

  it("handles long inline-code delimiters without quadratic rescans", () => {
    const started = performance.now();
    expect(detectorInternals.inlineCodeRanges("`".repeat(30_000))).toEqual([]);
    expect(performance.now() - started).toBeLessThan(250);
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
    expect(regions.every((region) => region.intent === "embedded-display")).toBe(true);
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

  it("keeps a TeX line boundary after a spacing command", () => {
    const [region] = detectFormulaRegions([
      "$$",
      "X\\in\\mathbb{R}^{n\\times d},\\qquad",
      "y\\in\\mathbb{R}^{n\\times 1},\\qquad",
      "w\\in\\mathbb{R}^{d\\times 1},\\qquad",
      "L(w)=\\frac{1}{2n}\\lVert Xw-y\\rVert_2^2",
      "$$"
    ]);

    expect(region?.latex).toBe([
      "X\\in\\mathbb{R}^{n\\times d},\\qquad",
      "y\\in\\mathbb{R}^{n\\times 1},\\qquad",
      "w\\in\\mathbb{R}^{d\\times 1},\\qquad",
      "L(w)=\\frac{1}{2n}\\lVert Xw-y\\rVert_2^2"
    ].join("\n"));
    expect(region?.latex).not.toContain("\\qquady");
  });

  it("reassembles every explicit delimiter across TUI hard rows without losing suffix formulas", () => {
    const cases: Array<{ lines: string[]; latex: string; display: boolean }> = [
      {
        lines: ["prefix \\(x_i +", "y_i\\) suffix $z$"],
        latex: "x_i +\ny_i",
        display: false
      },
      {
        lines: ["prefix \\[x_i +", "y_i\\] suffix $z$"],
        latex: "x_i +\ny_i",
        display: true
      },
      {
        lines: ["prefix $x_i +", "y_i$ suffix \\(z\\)"],
        latex: "x_i +\ny_i",
        display: false
      },
      {
        lines: ["prefix $$x_i +", "y_i$$ suffix $z$"],
        latex: "x_i +\ny_i",
        display: true
      }
    ];

    for (const { lines, latex, display } of cases) {
      const regions = detectFormulaRegions(lines);
      expect(regions, lines.join(" | ")).toContainEqual(expect.objectContaining({
        startRow: 0,
        endRow: 1,
        latex,
        display,
        confidence: "explicit"
      }));
      expect(regions.map((region) => region.latex), lines.join(" | ")).toContain("z");
    }
  });

  it("repairs a TeX control word split by a TUI hard row", () => {
    const regions = detectFormulaRegions([
      "prefix $$\\frac{1}{\\varep",
      "silon_0}$$ suffix $x$"
    ]);
    expect(regions.map((region) => region.latex)).toEqual([
      "\\frac{1}{\\varepsilon_0}",
      "x"
    ]);
  });

  it("detects TeX display environments without dollar delimiters", () => {
    const regions = detectFormulaRegions([
      "before \\begin{align}",
      "a&=b+c\\\\",
      "d&=e",
      "\\end{align} after \\(z\\)"
    ]);
    expect(regions).toContainEqual(expect.objectContaining({
      startRow: 0,
      endRow: 3,
      latex: "\\begin{align}\na&=b+c\\\\\nd&=e\n\\end{align}",
      display: true,
      confidence: "explicit"
    }));
    expect(regions.map((region) => region.latex)).toContain("z");
  });

  it("leaves TeX environments in Markdown code untouched", () => {
    expect(detectFormulaRegions([
      "`\\begin{equation}x=1\\end{equation}`",
      "```latex",
      "\\begin{align}a&=b\\end{align}",
      "```"
    ])).toEqual([]);
  });

  it("leaves blank-row ownership out of semantic display detection", () => {
    const regions = detectFormulaRegions([
      "$$\\frac{1}{x}$$",
      "",
      "$$\\frac{1}{x}$$"
    ]);
    expect(regions).toHaveLength(2);
    expect(regions.map((region) => [region.startRow, region.endRow]))
      .toEqual([[0, 0], [2, 2]]);
  });

  it("does not infer bare brackets or unwrapped equations", () => {
    expect(detectFormulaRegions([
      "[",
      "D_{KL}(P\\|M)=\\sum_i P(x_i)\\log\\frac{P(x_i)}{M(x_i)}",
      "]"
    ])).toEqual([]);
    expect(detectFormulaRegions(["[E=mc^2]", "p=0", "(\\rho)"])).toEqual([]);
  });

  it.each([
    ["slash display", ["\\[", "\\begin{aligned}", "x&=\\frac{1}{2}"]],
    ["dollar display", ["$$", "\\begin{aligned}", "x&=\\frac{1}{2}"]],
    ["display environment", ["\\begin{aligned}", "x&=\\frac{1}{2}"]]
  ])("waits for an unclosed streamed %s", (_name, lines) => {
    expect(detectFormulaRegions(lines)).toEqual([]);
  });

  it("does not render a closed outer block around an incomplete environment", () => {
    expect(detectFormulaRegions([
      "\\[",
      "\\begin{aligned}",
      "x&=\\frac{1}{2}",
      "\\]"
    ])).toEqual([]);
  });

  it("repairs aligned row separators stripped by terminal Markdown", () => {
    const strippedRowBreak = "\\";
    const [region] = detectFormulaRegions([
      "\\[",
      "\\begin{aligned}",
      `a&=b${strippedRowBreak}`,
      "c&=d",
      "=e",
      "\\end{aligned}",
      "\\]"
    ]);

    expect(region).toMatchObject({ display: true, confidence: "explicit" });
    expect(region?.latex).toBe([
      "\\begin{aligned}",
      "a&=b\\\\",
      "c&=d\\\\",
      "&=e",
      "\\end{aligned}"
    ].join("\n"));
  });

  it("restores stripped aligned row spacing without treating intervals as row breaks", () => {
    const [spaced] = detectFormulaRegions([
      "\\[",
      "\\begin{aligned}",
      "a&=b,\\[2pt]",
      "\\end{aligned}",
      "\\]"
    ]);
    expect(spaced?.latex).toContain("a&=b,\\\\[2pt]");

    const [interval] = detectFormulaRegions([
      "\\begin{aligned}",
      "A&=\\text{domain}\\ [0,1]",
      "B&=2",
      "\\end{aligned}"
    ]);
    expect(interval?.latex).toContain("A&=\\text{domain}\\ [0,1]\nB&=2");
    expect(interval?.latex).not.toContain("\\\\ [0,1]");
  });

  it("does not force row breaks without stripped-Markdown evidence", () => {
    const [region] = detectFormulaRegions([
      "\\begin{aligned}",
      "a&=b+",
      "c",
      "\\end{aligned}"
    ]);
    expect(region?.latex).toBe("\\begin{aligned}\na&=b+\nc\n\\end{aligned}");
  });

  it("keeps hard lines inside an open TeX group on the same aligned row", () => {
    const strippedRowBreak = "\\";
    const [region] = detectFormulaRegions([
      "\\[",
      "\\begin{aligned}",
      "a&=\\frac{",
      "1+x",
      `}{y}${strippedRowBreak}`,
      "b&=2",
      "\\end{aligned}",
      "\\]"
    ]);
    expect(region?.latex).toContain("a&=\\frac{\n1+x\n}{y}\\\\\nb&=2");
  });

  it("detects a complete explicit environment without its own wrapper", () => {
    const regions = detectFormulaRegions([
      "\\begin{aligned}",
      "a&=b",
      "\\end{aligned}"
    ]);
    expect(regions).toEqual([
      expect.objectContaining({
        latex: "\\begin{aligned}\na&=b\n\\end{aligned}",
        confidence: "explicit"
      })
    ]);
  });

  it("does not mistake a normal bracketed list for math", () => {
    expect(detectFormulaRegions(["[", "alpha, beta, gamma", "]"])).toEqual([]);
  });

  it("detects inline TeX and accounts for wide Chinese text", () => {
    const [region] = detectFormulaRegions(["其中公式 \\(x_i^2\\) 成立"]);
    expect(region?.startCol).toBeGreaterThan("其中公式 ".length);
    expect(region?.display).toBe(false);
  });

  it("keeps a trailing inline formula on its exact semantic source row", () => {
    const [region] = detectFormulaRegions([
      "waves propagate at \\(c=1/\\sqrt{\\mu_0\\varepsilon_0}\\).",
      ""
    ]);
    expect(region).toMatchObject({
      startRow: 0,
      endRow: 0,
      latex: "c=1/\\sqrt{\\mu_0\\varepsilon_0}\\text{.}",
      display: false,
      compact: true
    });
  });

  it("recognizes nonempty single-dollar expressions with valid delimiter boundaries", () => {
    expect(detectFormulaRegions(["price is $12.50$ today"])).toEqual([
      expect.objectContaining({ latex: "12.50", confidence: "explicit" })
    ]);
    expect(detectFormulaRegions(["value is $x_i^2$ today"])).toHaveLength(1);
  });

  it("supports ordinary one-letter and scripted single-dollar math", () => {
    const regions = detectFormulaRegions([
      "variables $x$, $c^2$, $E_0$, $f(t)$, and $\\rho$"
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

  it("recovers dollar math after unmatched prices, variables, and code-span dollars", () => {
    const cases = [
      "cost is $12; variable $x$",
      "environment $HOME then variable $x$",
      "code `$`, then variable $x$"
    ];
    for (const line of cases) {
      expect(detectFormulaRegions([line]).map((region) => region.latex), line).toEqual(["x"]);
    }

    expect(detectFormulaRegions(["cost $12, vars $x$ and $y$"])
      .map((region) => region.latex)).toEqual(["x", "y"]);
    expect(detectFormulaRegions(["code `$$`, then display $$x=1$$"])
      .map((region) => region.latex)).toEqual(["x=1"]);
  });

  it("does not recognize slash delimiters whose backslash is itself escaped", () => {
    expect(detectFormulaRegions([String.raw`literal \\(x^2\\) and \\[y^2\\]`])).toEqual([]);
    expect(detectFormulaRegions(["valid \\(x^2\\)"]))
      .toEqual([expect.objectContaining({ latex: "x^2", confidence: "explicit" })]);
  });

  it("accepts Unicode math and arbitrary TeX commands in explicit dollar delimiters", () => {
    const regions = detectFormulaRegions([
      "$π$, $α_i$, $E₀$, $x²$, $∑$, $\\hbar$, and $\\langle x \\rangle$"
    ]);
    expect(regions.map((region) => region.latex)).toEqual([
      "π",
      "α_i",
      "E₀",
      "x²",
      "∑",
      "\\hbar",
      "\\langle x \\rangle"
    ]);
  });

  it("accepts a short word when the author explicitly uses dollar markers", () => {
    expect(detectFormulaRegions(["literal $the$ but variable $xy$"])
      .map((region) => region.latex)).toEqual(["the", "xy"]);
  });

  it("does not pair unrelated single-dollar fragments across hard rows", () => {
    expect(detectFormulaRegions(["prefix $x", "$y suffix"])).toEqual([]);
    expect(detectFormulaRegions(["prefix $x_i+", "y_i$ suffix"]))
      .toEqual([expect.objectContaining({ latex: "x_i+\ny_i", startRow: 0, endRow: 1 })]);
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

  it("leaves unwrapped math-like prose, symbols, and definitions untouched", () => {
    expect(detectFormulaRegions([
      "circle ratio (π), field (α_i), and value [x^2+y^2]",
      "其中 (\\mathbf E) 为电场，(\\rho) 为电荷密度",
      "- (E): rest energy",
      "E=mc^2",
      "identities (x^2+y^2), scale (10^8), sequence (a_{n+1})"
    ])).toEqual([]);
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
