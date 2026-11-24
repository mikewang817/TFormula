import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { escapeTexText } from "../src/detect.js";
import { FormulaCache } from "../src/formula-cache.js";
import { normalizeLatexForRendering, renderMathJaxMathMl, renderMathJaxSvg } from "../src/math-renderer.js";
import { detectScreenFormulaRegions } from "../src/screen-text.js";

// A memory-only cache makes every SVG assertion reach MathJax.
const coldCache = () => new FormulaCache({
  root: join(tmpdir(), `tformula-literal-text-${randomUUID()}`),
  maxDiskBytes: 0
});

function textContent(mathml: string): string {
  return [...mathml.matchAll(/<mtext\b[^>]*>([^<]*)<\/mtext>/gu)]
    .map((match) => match[1]).join("")
    .replace(/&#x([0-9a-f]+);/giu, (_, value: string) => String.fromCodePoint(parseInt(value, 16)))
    .replace(/&#([0-9]+);/gu, (_, value: string) => String.fromCodePoint(Number(value)))
    .replace(/&lt;/gu, "<").replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"').replace(/&apos;/gu, "'").replace(/&amp;/gu, "&")
    // MathJax uses non-breaking spaces for some text-mode group boundaries.
    .replace(/\u00a0/gu, " ");
}

function svgGlyphs(svg: string): string {
  return [...svg.matchAll(/data-c="([0-9A-F]+)"/gu)]
    .map((match) => String.fromCodePoint(parseInt(match[1]!, 16))).join("")
    .replace(/\u00a0/gu, " ");
}

describe("literal text rendering", () => {
  it.each([
    "\\",
    String.raw`C:\Users\example\notes.txt`,
    String.raw`\\server\share\notes.txt`,
    String.raw`\(not math\) and $x^2$`,
    "^ ^2 ~ home ~name",
    String.raw`\{}$%&#_^~`,
    "<tag> & value #1"
  ])("preserves the actual text characters in %s", async (text) => {
    const latex = `\\text{${escapeTexText(text)}}`;
    expect(normalizeLatexForRendering(latex)).toBe(latex);
    const mathml = await renderMathJaxMathMl(latex, false);
    expect(textContent(mathml)).toBe(text);
    expect(mathml).not.toMatch(/<merror\b|<mover\b|linebreak="newline"|mathcolor="red"/u);
  });

  it("preserves literal characters in styled and nested text", async () => {
    const text = String.raw`path\name ^2 ~home`;
    const mathml = await renderMathJaxMathMl(`\\textbf{${escapeTexText(text)}}`, false);
    expect(textContent(mathml)).toBe(text);
    expect(mathml).toContain('mathvariant="bold"');
    const nested = await renderMathJaxMathMl(
      `\\text{outer \\(\\text{${escapeTexText(text)}}+x\\) tail}`, false);
    expect(textContent(nested)).toBe(`outer ${text} tail`);
  });

  it("renders a composed screen row with its literal prose", async () => {
    const row = String.raw`see $x^2$ at C:\tmp\a~b ^c`;
    const [region] = detectScreenFormulaRegions([
      { row: 0, text: row, isWrapped: false, uniformStyle: true }
    ], 160).formulas;
    expect(region?.composite).toBe(true);
    const svg = await renderMathJaxSvg(region!.formula.latex, false, 160, coldCache());
    expect(svgGlyphs(svg)).toBe(String.raw`𝑥2 at C:\tmp\a~b ^c`);
  });

  it("keeps math-mode commands out of text mode", async () => {
    await expect(renderMathJaxSvg(String.raw`\text{\backslash}`, false, 160, coldCache()))
      .rejects.toMatchObject({
        code: "tex-error",
        message: expect.stringContaining("only supported in math mode")
      });
  });

  it("preserves backslash and accents in actual math", async () => {
    const latex = String.raw`\backslash+x^2+\hat{x}+\tilde{x}`;
    expect(normalizeLatexForRendering(latex)).toBe(latex);
    const mathml = await renderMathJaxMathMl(latex, false);
    expect(mathml).toContain("<msup");
    expect(mathml).toContain(String.raw`<mi mathvariant="normal" data-latex="\backslash">\</mi>`);
    expect(mathml.match(/<mover\b/gu)).toHaveLength(2);
  });
});
