import { describe, expect, it } from "vitest";
import {
  MathRenderer,
  normalizeLatexForRendering,
  readSvgDimensions,
  renderMathJaxSvg
} from "../src/math-renderer.js";

describe("MathRenderer", () => {
  it("reads MathJax ex dimensions", () => {
    expect(readSvgDimensions('<svg width="10ex" height="2.5ex" viewBox="0 0 4000 1000"></svg>'))
      .toEqual({ aspectRatio: 4, heightEx: 2.5, depthEx: 0 });
    expect(readSvgDimensions('<svg style="vertical-align: -0.5ex" width="2ex" height="1.5ex"></svg>'))
      .toEqual({ aspectRatio: 4 / 3, heightEx: 1.5, depthEx: 0.5 });
  });

  it("keeps complete operator expressions in inline MathJax output", async () => {
    const svg = await renderMathJaxSvg("E=mc^2", false, 160);
    const dimensions = readSvgDimensions(svg);
    expect(dimensions.aspectRatio).toBeGreaterThan(3);
    expect(svg.match(/<use\b/gu)?.length ?? 0).toBeGreaterThanOrEqual(5);
  });

  it("typesets reciprocal square roots as fractions without changing unit slashes", () => {
    expect(normalizeLatexForRendering("c=1/\\sqrt{\\mu_0\\varepsilon_0}"))
      .toBe("c=\\frac{1}{\\sqrt{\\mu_0\\varepsilon_0}}");
    expect(normalizeLatexForRendering("3.0\\times10^8\\ \\text{m/s}"))
      .toBe("3.0\\times10^8\\ \\text{m/s}");
  });

  it("renders a PNG exactly matching the terminal cell rectangle", async () => {
    const rendered = await new MathRenderer().render(
      {
        startRow: 0,
        endRow: 2,
        startCol: 0,
        endCol: 40,
        latex: "D_{KL}(P\\|M)=\\frac12\\sum_i P_i",
        display: true,
        confidence: "explicit"
      },
      40,
      3,
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
    expect(png.readUInt32BE(16)).toBe(360);
    expect(png.readUInt32BE(20)).toBe(54);
  });

  it("renders an aligned definition group containing Chinese text", async () => {
    const rendered = await new MathRenderer().render(
      {
        startRow: 0,
        endRow: 5,
        startCol: 2,
        endCol: 32,
        latex: "\\begin{array}{ll}\\mathbf E & \\text{：电场强度}\\\\\\rho & \\text{：电荷密度}\\\\\\varepsilon_0 & \\text{：真空介电常数}\\end{array}",
        display: false,
        confidence: "inferred",
        compact: true
      },
      30,
      6,
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
    expect(png.readUInt32BE(16)).toBe(270);
    expect(png.readUInt32BE(20)).toBe(108);
  });

  it("reuses the same content-addressed PNG after changing scale and changing back", async () => {
    const renderer = new MathRenderer();
    const region = {
      startRow: 0,
      endRow: 1,
      startCol: 0,
      endCol: 20,
      latex: "E=mc^2",
      display: true,
      confidence: "explicit" as const
    };
    const capabilities = {
      kittyGraphics: true,
      foreground: "#eeeeee",
      background: "#202030",
      cell: { width: 9, height: 18, source: "cell-query" as const }
    };

    const original = await renderer.render(region, 20, 2, capabilities, 1);
    const enlarged = await renderer.render(region, 20, 2, capabilities, 1.2);
    renderer.clear();
    const restored = await renderer.render(region, 20, 2, capabilities, 1);

    expect(enlarged.cacheKey).not.toBe(original.cacheKey);
    expect(restored.cacheKey).toBe(original.cacheKey);
    expect(restored.png).toEqual(original.png);
  });
});
