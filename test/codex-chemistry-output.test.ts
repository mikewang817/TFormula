import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { detectFormulaRegions } from "../src/detect.js";
import { FormulaCache } from "../src/formula-cache.js";
import { MathRenderer, renderMathJaxSvg } from "../src/math-renderer.js";
import { detectScreenFormulaRegions } from "../src/screen-text.js";

const strippedRowBreak = "\\";

const CODEX_CHEMISTRY_BLOCKS = [
  {
    id: "multiline EDTA fraction",
    lines: [
      "[",
      "\\begin{aligned}",
      "\\alpha_{\\ce{Y^{4-}}}",
      "&=\\left[1+\\frac{H}{K_{a4}}+\\frac{H^2}{K_{a3}K_{a4}}",
      "+\\frac{H^3}{K_{a2}K_{a3}K_{a4}}"
        + "+\\frac{H^4}{K_{a1}K_{a2}K_{a3}K_{a4}}\\right]^{-1}"
        + strippedRowBreak,
      "&=\\left[1+10^{0.26}+10^{-3.58}+10^{-10.91}+10^{-18.91}"
        + "\\right]^{-1}",
      "=0.354614.",
      "\\end{aligned}",
      "]"
    ]
  },
  {
    id: "boxed result with spaced row break",
    lines: [
      "[",
      "\\begin{aligned}",
      "x&=\\frac{2C}{1+\\sqrt{1+4K_f'C}}" + strippedRowBreak,
      "&=\\frac{2(5.00\\times10^{-3})}",
      "{1+\\sqrt{1+4(1.5840\\times10^{10})(5.00\\times10^{-3})}}",
      "=5.618\\times10^{-7}\\ \\mathrm M," + strippedRowBreak,
      "\\mathrm{pCa}&=-\\log_{10}(5.618\\times10^{-7})=6.2504,\\[2pt]",
      "&\\boxed{\\begin{gathered}",
      "\\alpha_{\\ce{Y^{4-}}}=0.3546,\\qquad K_f'=1.584\\times10^{10},"
        + strippedRowBreak,
      "[\\ce{Ca^{2+}}]=5.62\\times10^{-7}\\ \\mathrm M,"
        + "\\qquad \\mathrm{pCa}=6.250",
      "\\end{gathered}}",
      "\\end{aligned}",
      "]"
    ]
  },
  {
    id: "EDTA dissociation sequence",
    lines: [
      "[",
      "\\begin{aligned}",
      "\\ce{H4Y &<=> H+ + H3Y^-} &&pK_{a1}=2.00" + strippedRowBreak,
      "\\ce{H3Y^- &<=> H+ + H2Y^{2-}} &&pK_{a2}=2.67" + strippedRowBreak,
      "\\ce{H2Y^{2-} &<=> H+ + HY^{3-}} &&pK_{a3}=6.16" + strippedRowBreak,
      "\\ce{HY^{3-} &<=> H+ + Y^{4-}} &&pK_{a4}=10.26" + strippedRowBreak,
      "\\ce{Ca^{2+} + Y^{4-} &<=> CaY^{2-}}&&K_f=10^{10.65}.",
      "\\end{aligned}",
      "]"
    ]
  },
  {
    id: "EDTA uncomplexed fraction definition",
    lines: [
      "[",
      "\\begin{aligned}",
      "F_Y&=[\\ce{H4Y}]+[\\ce{H3Y^-}]+[\\ce{H2Y^{2-}}]"
        + "+[\\ce{HY^{3-}}]+[\\ce{Y^{4-}}]," + strippedRowBreak,
      "\\alpha_{\\ce{Y^{4-}}}",
      "&=\\frac{[\\ce{Y^{4-}}]}{F_Y}" + strippedRowBreak,
      "&=\\frac{K_{a1}K_{a2}K_{a3}K_{a4}}",
      "{H^4+K_{a1}H^3+K_{a1}K_{a2}H^2+K_{a1}K_{a2}K_{a3}H",
      "+K_{a1}K_{a2}K_{a3}K_{a4}}.",
      "\\end{aligned}",
      "]"
    ]
  },
  {
    id: "conditional formation constant",
    lines: [
      "[",
      "\\begin{aligned}",
      "K_f'&=\\frac{[\\ce{CaY^{2-}}]}{[\\ce{Ca^{2+}}]F_Y}",
      "=\\alpha_{\\ce{Y^{4-}}}K_f" + strippedRowBreak,
      "&=(0.354614)(10^{10.65})",
      "=1.5840\\times10^{10}.",
      "\\end{aligned}",
      "]"
    ]
  },
  {
    id: "equivalence-point mass balances",
    lines: [
      "[",
      "\\begin{aligned}",
      "C&=\\frac{(0.0100)(50.00)}{100.00}=5.00\\times10^{-3}\\ \\mathrm M,"
        + strippedRowBreak,
      "C&=[\\ce{Ca^{2+}}]+[\\ce{CaY^{2-}}]",
      "=F_Y+[\\ce{CaY^{2-}}].",
      "\\end{aligned}",
      "\\qquad",
      "\\begin{aligned}",
      "x&\\equiv[\\ce{Ca^{2+}}]=F_Y," + strippedRowBreak,
      "K_f'&=\\frac{C-x}{x^2}," + strippedRowBreak,
      "K_f'x^2+x-C=0.",
      "\\end{aligned}",
      "]"
    ]
  }
] as const;

describe("real Codex analytical-chemistry output regression", () => {
  let root = "";
  let cache: FormulaCache;
  let renderer: MathRenderer;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "tformula-codex-chemistry-"));
    cache = new FormulaCache({ root, maxDiskBytes: 0 });
    renderer = new MathRenderer(cache);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it.each(CODEX_CHEMISTRY_BLOCKS)(
    "maps the standalone $id block to the complete terminal width",
    ({ lines }) => {
      const snapshot = detectScreenFormulaRegions(
        lines.map((text, row) => ({ row, text, isWrapped: false })),
        120
      );

      expect(snapshot.deferred).toEqual([]);
      expect(snapshot.regions).toHaveLength(1);
      expect(snapshot.regions[0]).toMatchObject({
        startRow: 0,
        endRow: lines.length - 1,
        startCol: 0,
        endCol: 120,
        display: true
      });
    }
  );

  it("keeps a split left-hand side on the same aligned row", () => {
    const [region] = detectFormulaRegions(CODEX_CHEMISTRY_BLOCKS[0].lines);
    expect(region?.latex).toContain("\\alpha_{\\ce{Y^{4-}}}\n&=\\left[");
    expect(region?.latex).not.toContain("\\alpha_{\\ce{Y^{4-}}}\\\\\n");
  });

  it("restores a Markdown-stripped \\\\[2pt] row break before MathJax", async () => {
    const [region] = detectFormulaRegions(CODEX_CHEMISTRY_BLOCKS[1].lines);
    expect(region?.latex).toContain("6.2504,\\\\[2pt]\n");
    expect(region?.latex).not.toContain("6.2504,\\[2pt]\\\\");
    await expect(renderMathJaxSvg(region!.latex, true, 1080, cache))
      .resolves.toContain('data-mml-node="math"');
  });

  it("keeps all six display blocks independent in one Codex response", () => {
    const lines = CODEX_CHEMISTRY_BLOCKS.flatMap((block, index) => [
      `${index + 1}. analytical chemistry step`,
      ...block.lines,
      ""
    ]);
    const snapshot = detectScreenFormulaRegions(
      lines.map((text, row) => ({ row, text, isWrapped: false })),
      120
    );

    expect(snapshot.deferred).toEqual([]);
    expect(snapshot.regions).toHaveLength(CODEX_CHEMISTRY_BLOCKS.length);
    expect(snapshot.regions.every((region) =>
      region.display && region.startCol === 0 && region.endCol === 120
    )).toBe(true);
  });

  it.each(CODEX_CHEMISTRY_BLOCKS)(
    "renders the complete $id terminal rectangle",
    async ({ lines }) => {
      const snapshot = detectScreenFormulaRegions(
        lines.map((text, row) => ({ row, text, isWrapped: false })),
        120
      );
      const rendered = await renderer.render(
        snapshot.regions[0]!,
        120,
        lines.length,
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
      expect(png.readUInt32BE(16)).toBe(120 * 9);
      expect(png.readUInt32BE(20)).toBe(lines.length * 18);
    }
  );
});
