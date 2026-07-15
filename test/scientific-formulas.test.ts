import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FormulaCache } from "../src/formula-cache.js";
import {
  normalizeLatexForRendering,
  readSvgDimensions,
  renderMathJaxSvg,
  SCIENTIFIC_TEX_PACKAGES
} from "../src/math-renderer.js";
import {
  FULL_LATEX_BOUNDARY_CORPUS,
  SCIENTIFIC_FORMULA_CORPUS
} from "./scientific-formula-corpus.js";

describe("scientific formula compatibility corpus", () => {
  let root = "";
  let cache: FormulaCache;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "tformula-scientific-corpus-"));
    cache = new FormulaCache({ root, maxDiskBytes: 0 });
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it.each(SCIENTIFIC_FORMULA_CORPUS)(
    "$domain/$id renders $feature",
    async ({ latex, display = false }) => {
      const svg = await renderMathJaxSvg(latex, display, 720, cache);
      const dimensions = readSvgDimensions(svg);
      expect(svg).toContain('data-mml-node="math"');
      expect(svg).not.toMatch(/data-mjx-error|data-mml-node=["']merror["']/u);
      expect(dimensions.aspectRatio).toBeGreaterThan(0);
      expect(dimensions.heightEx).toBeGreaterThan(0);
    }
  );

  it.each(FULL_LATEX_BOUNDARY_CORPUS)(
    "$domain/$id is rejected instead of being rendered misleadingly",
    async ({ latex, display = false }) => {
      await expect(renderMathJaxSvg(latex, display, 720, cache)).rejects.toThrow();
    }
  );

  it("keeps the package profile local-only and deterministic", () => {
    expect(SCIENTIFIC_TEX_PACKAGES).toEqual(expect.arrayContaining([
      "mhchem", "physics", "mathtools", "units", "upgreek", "gensymb"
    ]));
    expect(SCIENTIFIC_TEX_PACKAGES).not.toEqual(expect.arrayContaining([
      "require", "html", "texhtml"
    ]));
  });

  it("disambiguates siunitx v3 quantities without changing physics quantities", () => {
    expect(normalizeLatexForRendering("d=\\qty{5.0}{\\micro\\metre}"))
      .toBe("d=\\SI{5.0}{\\micro\\metre}");
    expect(normalizeLatexForRendering("x=\\qty(\\frac{a}{b})"))
      .toBe("x=\\qty(\\frac{a}{b})");
    expect(normalizeLatexForRendering("x=\\qty{\\frac{a}{b}}"))
      .toBe("x=\\qty{\\frac{a}{b}}");
    expect(normalizeLatexForRendering("a=\\qty{1}{\\metre},b=\\qty{2}{\\second}"))
      .toBe("a=\\SI{1}{\\metre},b=\\SI{2}{\\second}");
  });

  it("reports the unsupported command that caused a MathJax failure", async () => {
    await expect(renderMathJaxSvg("\\unknownscientific{x}", false, 720, cache))
      .rejects.toThrow(/MathJax could not parse.*unknownscientific/u);
  });
});
