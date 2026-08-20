import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { describe, expect, it } from "vitest";
import { FormulaCache } from "../src/formula-cache.js";
import {
  mathRendererInternals,
  MathRenderError,
  MathRenderer,
  MAX_FORMULA_LENGTH,
  normalizeLatexForRendering,
  readSvgDimensions,
  renderMathJaxSvg
} from "../src/math-renderer.js";
import type { FormulaIntent, FormulaWrapSegment, TerminalCapabilities } from "../src/types.js";

interface TestFormulaRegion {
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
  latex: string;
  display: boolean;
  intent?: FormulaIntent;
  confidence: "explicit" | "inferred";
  compact?: boolean;
  composite?: boolean;
  displayRange?: { startCol: number; endCol: number };
  sourceSegments?: FormulaWrapSegment[];
  wrapSegments?: FormulaWrapSegment[];
}

function renderTestRegion(
  renderer: MathRenderer,
  region: TestFormulaRegion,
  columns: number,
  rows: number,
  capabilities: TerminalCapabilities,
  scale: number
) {
  const wraps = region.wrapSegments?.length ? region.wrapSegments : [];
  const sourceMasks = region.sourceSegments?.length ? region.sourceSegments : wraps;
  const formulaSlices = region.sourceSegments?.length || region.displayRange ? [] : wraps;
  return renderer.renderPlacement(
    {
      formula: {
        source: {
          startRow: region.startRow,
          endRow: region.endRow,
          startCol: region.startCol,
          endCol: region.endCol
        },
        latex: region.latex,
        intent: region.intent ?? (region.display ? "display" : "inline"),
        confidence: region.confidence,
        ...(region.compact ? { compact: true } : {})
      },
      canvas: {
        startRow: region.startRow,
        endRow: region.startRow + rows - 1,
        startCol: region.startCol,
        endCol: region.startCol + columns
      },
      sourceMasks,
      formulaSlices,
      ...(region.displayRange ? { displayRange: region.displayRange } : {}),
      mode: region.displayRange
        ? "embedded"
        : formulaSlices.length ? "wrapped" : region.compact ? "compact" : "source",
      estimatedQuality: 100,
      composite: Boolean(region.composite)
    },
    capabilities,
    scale
  );
}

describe("MathRenderer", () => {
  it("reads MathJax ex dimensions", () => {
    expect(readSvgDimensions('<svg width="10ex" height="2.5ex" viewBox="0 0 4000 1000"></svg>'))
      .toEqual({ aspectRatio: 4, heightEx: 2.5, depthEx: 0 });
    expect(readSvgDimensions('<svg style="vertical-align: -0.5ex" width="2ex" height="1.5ex"></svg>'))
      .toEqual({ aspectRatio: 4 / 3, heightEx: 1.5, depthEx: 0.5 });
    expect(readSvgDimensions(
      '<svg style="vertical-align: -2ex" width="100%" height="6ex" viewBox="0 0 6000 1000"></svg>'
    )).toEqual({ aspectRatio: 6, heightEx: 6, depthEx: 2 });
  });

  it("keeps complete operator expressions in inline MathJax output", async () => {
    const svg = await renderMathJaxSvg("E=mc^2", false, 160);
    const dimensions = readSvgDimensions(svg);
    expect(dimensions.aspectRatio).toBeGreaterThan(3);
    expect(svg.match(/<use\b/gu)?.length ?? 0).toBeGreaterThanOrEqual(5);
  });

  it("loads system fonts only when MathJax leaves real SVG text nodes", async () => {
    const pathOnly = await renderMathJaxSvg("\\text{velocity }v=3", false, 160);
    const cjkFallback = await renderMathJaxSvg("\\text{中文}", false, 160);

    expect(pathOnly).not.toMatch(/<text(?=[\s/>])/iu);
    expect(mathRendererInternals.svgNeedsSystemFonts(pathOnly)).toBe(false);
    expect(cjkFallback).toMatch(/<text(?=[\s/>])/iu);
    expect(mathRendererInternals.svgNeedsSystemFonts(cjkFallback)).toBe(true);
    expect(mathRendererInternals.svgNeedsSystemFonts("<svg><svg:text>字</svg:text></svg>"))
      .toBe(true);
    expect(mathRendererInternals.svgNeedsSystemFonts('<svg data-label="&lt;text&gt;"/>'))
      .toBe(false);
  });

  it("shares one formula definition across wrapped slices without changing pixels", async () => {
    const canvasWidth = 90;
    const canvasHeight = 36;
    const cell = { width: 9, height: 18, source: "cell-query" as const };
    const wrapSegments = [
      { rowOffset: 0, startCol: 1, endCol: 5, logicalStartCol: 0 },
      { rowOffset: 1, startCol: 0, endCol: 4, logicalStartCol: 4 }
    ];
    // Deliberately collide with the preferred shared-content id and include
    // an internal SVG reference, as MathJax's real output does for glyphs.
    const content = [
      '<g color="#eeeeee" fill="#eeeeee">',
      '<svg x="1" y="2" width="70" height="14" viewBox="0 0 70 14">',
      '<defs><linearGradient id="tformula-sliced-content">',
      '<stop stop-color="#ffffff"/><stop offset="1" stop-color="#888888"/>',
      "</linearGradient></defs>",
      '<rect width="70" height="14" fill="url(#tformula-sliced-content)"/>',
      "</svg></g>"
    ].join("");
    const optimized = mathRendererInternals.buildHorizontallySlicedSvg({
      canvasWidth,
      canvasHeight,
      wrapSegments,
      cell,
      background: "#202030",
      content
    });
    const legacy = [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${canvasHeight}" viewBox="0 0 ${canvasWidth} ${canvasHeight}">`,
      ...wrapSegments.map((segment) => {
        const destinationX = segment.startCol * cell.width;
        const destinationY = segment.rowOffset * cell.height;
        const sourceX = segment.logicalStartCol * cell.width;
        const width = (segment.endCol - segment.startCol) * cell.width;
        return [
          `<svg x="${destinationX}" y="${destinationY}" width="${width}" height="${cell.height}" viewBox="${sourceX} 0 ${width} ${cell.height}" overflow="hidden">`,
          `<rect x="${sourceX}" width="${width}" height="${cell.height}" fill="#202030"/>`,
          content,
          "</svg>"
        ].join("");
      }),
      "</svg>"
    ].join("");

    expect(optimized.indexOf(content)).toBeGreaterThanOrEqual(0);
    expect(optimized.indexOf(content, optimized.indexOf(content) + content.length)).toBe(-1);
    expect(optimized.match(/<use href="#tformula-sliced-content-1"\/>/gu)).toHaveLength(2);
    const options = { fitTo: { mode: "original" as const }, font: { loadSystemFonts: false } };
    const optimizedPng = new Resvg(optimized, options).render().asPng();
    const legacyPng = new Resvg(legacy, options).render().asPng();
    expect(optimizedPng).toEqual(legacyPng);
    expect(await mathRendererInternals.renderSvgToPng(optimized, false))
      .toEqual(optimizedPng);
  });

  it("masks only TeX source cells inside a larger borrowed display canvas", () => {
    const svg = mathRendererInternals.buildSourceMaskedSvg({
      canvasWidth: 720,
      canvasHeight: 54,
      sourceSegments: [
        { rowOffset: 1, startCol: 4, endCol: 20, logicalStartCol: 0 }
      ],
      cell: { width: 9, height: 18, source: "cell-query" },
      background: "#202030",
      content: '<g id="formula-content"/>'
    });

    expect(svg).toContain('<rect x="36" y="18" width="144" height="18" fill="#202030"/>');
    expect(svg).not.toContain('<rect width="100%"');
    expect(svg.match(/id="formula-content"/gu)).toHaveLength(1);
  });

  it("contains native Resvg panics and restarts the isolated rasterizer", async () => {
    const resvgPanic = [
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">',
      '<g opacity="0.5" transform="translate(100 100)">',
      '<rect width="5" height="5"/>',
      "</g></svg>"
    ].join("");
    await expect(mathRendererInternals.renderSvgToPng(resvgPanic, false))
      .rejects.toMatchObject({ code: "raster-error" });
    await expect(mathRendererInternals.renderSvgToPng(
      '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2"/></svg>',
      false
    )).resolves.toBeInstanceOf(Buffer);
  });

  it("reports structured raster failures and enforces raster boundaries", async () => {
    await expect(mathRendererInternals.renderSvgToPng("<svg><broken>", false))
      .rejects.toMatchObject({ code: "raster-error" });
    await expect(mathRendererInternals.renderSvgToPng(
      '<svg xmlns="http://www.w3.org/2000/svg" width="4097" height="1"><rect width="1" height="1"/></svg>',
      false
    )).rejects.toMatchObject({ code: "raster-limit" });
    await expect(mathRendererInternals.renderSvgToPng(
      '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>',
      false
    )).rejects.toMatchObject({ code: "empty-raster" });
  });

  it("computes exact half-open alpha bounds", () => {
    const pixels = Buffer.alloc(4 * 4 * 4);
    pixels[(1 * 4 + 2) * 4 + 3] = 255;
    pixels[(2 * 4 + 3) * 4 + 3] = 1;
    expect(mathRendererInternals.alphaBounds(pixels, 4, 4)).toEqual({
      left: 2,
      top: 1,
      right: 4,
      bottom: 3
    });
    expect(mathRendererInternals.alphaBounds(Buffer.alloc(16), 2, 2)).toBeUndefined();
  });

  it("refreshes a rendered formula on an in-memory cache hit", () => {
    const cache = new Map([
      ["frequent", 1],
      ["older", 2],
      ["newest", 3]
    ]);

    expect(mathRendererInternals.lruCacheGet(cache, "frequent")).toBe(1);
    expect(Array.from(cache.keys())).toEqual(["older", "newest", "frequent"]);
    expect(mathRendererInternals.lruCacheGet(cache, "missing")).toBeUndefined();
    expect(Array.from(cache.keys())).toEqual(["older", "newest", "frequent"]);
  });

  it("keeps inline output unbroken and independent of the display container width", async () => {
    const latex = "a+b+c+d+e+f+g+h+i+j+k+l+m+n+o+p+q+r+s+t";
    const narrow = await renderMathJaxSvg(latex, false, 80);
    const wide = await renderMathJaxSvg(latex, false, 800);

    expect(narrow).toBe(wide);
    expect(narrow).not.toContain("data-mjx-linebox");
    expect(narrow.match(/<use\b/gu)?.length ?? 0).toBeGreaterThanOrEqual(39);
  });

  it("renders a trailing TeX comment without an artificial wrapper brace", async () => {
    const svg = await renderMathJaxSvg("x% comment", false, 160);
    expect(svg).toContain('data-mml-node="math"');
    expect(svg).not.toContain("data-mjx-error");
  });

  it("preserves a trailing TeX control-space command", async () => {
    const svg = await renderMathJaxSvg("x\\ ", false, 160);
    expect(svg).toContain('data-mml-node="math"');
    expect(svg).not.toContain("data-mjx-error");
  });

  it("line-breaks display output according to its effective container width", async () => {
    const latex = "a+b+c+d+e+f+g+h+i+j+k+l+m+n+o+p+q+r+s+t";
    const narrow = await renderMathJaxSvg(latex, true, 160);
    const wide = await renderMathJaxSvg(latex, true, 1_600);

    expect(narrow).not.toBe(wide);
    expect(narrow.match(/data-mjx-linebox/gu)?.length ?? 0).toBeGreaterThan(1);
    expect(readSvgDimensions(narrow).heightEx).toBeGreaterThan(readSvgDimensions(wide).heightEx);
  });

  it("enforces the shared 20,000-character input boundary", async () => {
    expect(MAX_FORMULA_LENGTH).toBe(20_000);
    await expect(renderMathJaxSvg("x".repeat(MAX_FORMULA_LENGTH + 1), false, 160))
      .rejects.toMatchObject({ code: "input-too-long" });
  });

  it("rejects MathJax error boxes with structured diagnostics", async () => {
    const error = await renderMathJaxSvg("\\frac{1}", false, 160)
      .then(() => undefined, (failure: unknown) => failure);
    expect(error).toBeInstanceOf(MathRenderError);
    expect(error).toMatchObject({ code: "tex-error" });
    expect(error).toHaveProperty("message", expect.stringContaining("MathJax could not parse"));
  });

  it("rejects unknown commands that MathJax otherwise paints as red source text", async () => {
    await expect(renderMathJaxSvg("\\unknown{x}", false, 160))
      .rejects.toThrow("MathJax could not parse the formula");
  });

  it("repairs a semantic-error SVG already stored in the persistent cache", async () => {
    const root = await mkdtemp(join(tmpdir(), "tformula-math-error-cache-"));
    try {
      const cache = new FormulaCache({ root, maxDiskBytes: 0 });
      await renderMathJaxSvg("x+1", false, 160, cache);
      cache.clearMemory();
      const [bucket] = await readdir(join(cache.root, "svg"));
      const [filename] = await readdir(join(cache.root, "svg", bucket!));
      const path = join(cache.root, "svg", bucket!, filename!);
      await writeFile(path, '<svg width="1ex" height="1ex"><g data-mml-node="mtext" fill="red" stroke="red" data-latex="\\unknown"/></svg>');

      const repaired = await renderMathJaxSvg("x+1", false, 160, cache);
      expect(repaired).toContain("<svg");
      expect(repaired).not.toContain('fill="red" stroke="red"');
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("repairs a well-formed but empty SVG cache entry in the same call", async () => {
    const root = await mkdtemp(join(tmpdir(), "tformula-math-empty-cache-"));
    try {
      const cache = new FormulaCache({ root, maxDiskBytes: 0 });
      await renderMathJaxSvg("x+2", false, 160, cache);
      cache.clearMemory();
      const [bucket] = await readdir(join(cache.root, "svg"));
      const [filename] = await readdir(join(cache.root, "svg", bucket!));
      await writeFile(join(cache.root, "svg", bucket!, filename!), "<svg></svg>");

      const repaired = await renderMathJaxSvg("x+2", false, 160, cache);
      expect(repaired).toContain('data-mml-node="math"');
      expect(repaired).toContain("viewBox=");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("typesets directly when a peer process restores the bad cache entry", async () => {
    // The SVG cache is shared between processes, so the delete that opens the
    // repair can be undone by a peer before the re-read. Overriding deleteSvg
    // reproduces exactly that outcome: the repair reads back the entry it just
    // rejected. The formula itself is impeccable, so the call must still yield
    // its rendering rather than a failure code that reads as a source verdict.
    class RacingFormulaCache extends FormulaCache {
      override async deleteSvg(): Promise<void> {}
    }
    const root = await mkdtemp(join(tmpdir(), "tformula-math-race-cache-"));
    try {
      const cache = new RacingFormulaCache({ root, maxDiskBytes: 0 });
      await renderMathJaxSvg("x+3", false, 160, cache);
      cache.clearMemory();
      const [bucket] = await readdir(join(cache.root, "svg"));
      const [filename] = await readdir(join(cache.root, "svg", bucket!));
      await writeFile(join(cache.root, "svg", bucket!, filename!), "<svg></svg>");

      const repaired = await renderMathJaxSvg("x+3", false, 160, cache);
      expect(repaired).toContain('data-mml-node="math"');
      expect(repaired).toContain("viewBox=");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("accepts an escaped currency symbol inside valid TeX", async () => {
    const svg = await renderMathJaxSvg("x=\\$5", false, 160);
    expect(svg).toContain("<svg");
    expect(svg).not.toContain("data-mjx-error");
  });

  it("renders chemistry and physics extension commands used by technical agents", async () => {
    for (const latex of ["\\ce{2H2 + O2 -> 2H2O}", "\\dv{x}{t}", "\\bra{\\psi}"]) {
      const svg = await renderMathJaxSvg(latex, true, 240);
      expect(svg, latex).toContain("<svg");
      expect(svg, latex).not.toContain("data-mjx-error");
    }
  });

  it("renders textcircled compatibility and tagged display equations", async () => {
    const circled = "^{(\\text{\\textcircled{=}})}";
    expect(normalizeLatexForRendering(circled)).toBe("^{(\\enclose{circle}{=})}");
    await expect(renderMathJaxSvg(circled, false, 160)).resolves.toContain("<svg");

    const tagged = "K L (P | | Q) = \\sum_ {i = 1} ^ {n} P (x) \\log "
      + "\\frac {P (x)}{Q (x)} \\tag {2}";
    const svg = await renderMathJaxSvg(tagged, true, 100_000);
    const dimensions = readSvgDimensions(svg);
    expect(dimensions.heightEx).toBeGreaterThan(5);
    expect(dimensions.aspectRatio).toBeGreaterThan(5);
  });

  it("renders a representative technical formula corpus without error glyphs", async () => {
    const formulas = [
      "\\begin{aligned}a&=b+c\\\\d&=e\\end{aligned}",
      "f(x)=\\begin{cases}x^2&x>0\\\\0&x\\le0\\end{cases}",
      "\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}",
      "\\int_{-\\infty}^{\\infty}e^{-x^2}\\,dx=\\sqrt{\\pi}",
      "\\text{速度 }v=3.0\\times10^8\\ \\mathrm{m/s}"
    ];
    for (const latex of formulas) {
      const svg = await renderMathJaxSvg(latex, true, 240);
      expect(svg, latex).toContain("<svg");
      expect(svg, latex).not.toMatch(/data-mjx-error|data-mml-node="merror"/u);
    }
  });

  it("preserves reciprocal square roots without changing valid TeX semantics", () => {
    expect(normalizeLatexForRendering("c=1/\\sqrt{\\mu_0\\varepsilon_0}"))
      .toBe("c=1/\\sqrt{\\mu_0\\varepsilon_0}");
    expect(normalizeLatexForRendering("x^1/\\sqrt{y}"))
      .toBe("x^1/\\sqrt{y}");
    expect(normalizeLatexForRendering("x_1/\\sqrt{y}"))
      .toBe("x_1/\\sqrt{y}");
    expect(normalizeLatexForRendering("3.0\\times10^8\\ \\text{m/s}"))
      .toBe("3.0\\times10^8\\ \\text{m/s}");
  });

  it("renders a PNG exactly matching the terminal cell rectangle", async () => {
    const rendered = await renderTestRegion(new MathRenderer(),
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
    expect(rendered.fitScale).toBeGreaterThan(0);
    expect(rendered.fitScale).toBeLessThanOrEqual(1);
  });

  it("renders an aligned definition group containing Chinese text", async () => {
    const rendered = await renderTestRegion(new MathRenderer(),
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

  it("renders one-row reader math as a tight natural-size PNG", async () => {
    const rendered = await renderTestRegion(new MathRenderer(),
      {
        startRow: 0,
        endRow: 0,
        startCol: 0,
        endCol: 3,
        latex: "X_{ij}",
        display: false,
        confidence: "explicit",
        compact: true
      },
      3,
      1,
      {
        kittyGraphics: true,
        foreground: "#eeeeee",
        background: "#202030",
        cell: { width: 9, height: 18, source: "cell-query" }
      },
      1
    );
    const png = Buffer.from(rendered.png);

    expect(rendered.pixelPlacement).toEqual(expect.objectContaining({
      offsetX: expect.any(Number),
      offsetY: expect.any(Number)
    }));
    expect(rendered.widthPx).toBeLessThan(27);
    expect(rendered.heightPx).toBeLessThanOrEqual(18);
    expect(png.readUInt32BE(16)).toBe(rendered.widthPx);
    expect(png.readUInt32BE(20)).toBe(rendered.heightPx);
  });

  it("treats an empty wrap segment list as an ordinary rectangular region", async () => {
    const rendered = await renderTestRegion(new MathRenderer(),
      {
        startRow: 0,
        endRow: 0,
        startCol: 0,
        endCol: 20,
        latex: "E=mc^2",
        display: false,
        confidence: "explicit",
        wrapSegments: []
      },
      20,
      1,
      {
        kittyGraphics: true,
        foreground: "#eeeeee",
        background: "#202030",
        cell: { width: 9, height: 18, source: "cell-query" }
      },
      1
    );
    const png = Buffer.from(rendered.png);
    expect(png.readUInt32BE(16)).toBe(180);
    expect(png.readUInt32BE(20)).toBe(18);
    expect(rendered.widthPx).toBe(180);
  });

  it("only line-breaks display regions that reserve more than one row", async () => {
    const root = await mkdtemp(join(tmpdir(), "tformula-math-linebreak-layout-"));
    try {
      const cache = new FormulaCache({ root, maxDiskBytes: 0 });
      const renderer = new MathRenderer(cache);
      const latex = "a+b+c+d+e+f+g+h+i+j+k+l+m+n+o+p+q+r+s+t";
      const capabilities = {
        kittyGraphics: true,
        foreground: "#eeeeee",
        background: "#202030",
        cell: { width: 9, height: 18, source: "cell-query" as const }
      };
      const region = {
        startRow: 0,
        endRow: 0,
        startCol: 0,
        endCol: 20,
        latex,
        display: true,
        confidence: "explicit" as const
      };

      await renderTestRegion(renderer, region, 20, 1, capabilities, 1);
      await renderTestRegion(renderer, { ...region, endRow: 2 }, 20, 3, capabilities, 1);

      const svgRoot = join(cache.root, "svg");
      const buckets = await readdir(svgRoot);
      const svgs = (await Promise.all(buckets.map(async (bucket) =>
        Promise.all((await readdir(join(svgRoot, bucket))).map((filename) =>
          readFile(join(svgRoot, bucket, filename), "utf8")
        ))
      ))).flat();
      expect(svgs).toHaveLength(2);
      expect(svgs.some((svg) => svg.includes("data-mjx-linebox"))).toBe(true);
      expect(svgs.some((svg) => !svg.includes("data-mjx-linebox"))).toBe(true);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("uses the full multi-row display range instead of slicing it into one-row fragments", async () => {
    const root = await mkdtemp(join(tmpdir(), "tformula-math-ranged-display-"));
    try {
      const cache = new FormulaCache({ root, maxDiskBytes: 0 });
      const renderer = new MathRenderer(cache);
      const rendered = await renderTestRegion(renderer,
        {
          startRow: 0,
          endRow: 1,
          startCol: 0,
          endCol: 40,
          latex: "a+b+c+d+e+f+g+h+i+j+k+l+m+n+o+p+q+r+s+t",
          display: true,
          confidence: "explicit",
          displayRange: { startCol: 4, endCol: 40 },
          wrapSegments: [
            { rowOffset: 0, startCol: 4, endCol: 40, logicalStartCol: 0 },
            { rowOffset: 1, startCol: 0, endCol: 18, logicalStartCol: 36 }
          ]
        },
        40,
        2,
        {
          kittyGraphics: true,
          foreground: "#eeeeee",
          background: "#202030",
          cell: { width: 9, height: 18, source: "cell-query" }
        },
        1
      );

      expect(rendered.widthPx).toBe(360);
      expect(rendered.heightPx).toBe(36);
      const buckets = await readdir(join(cache.root, "svg"));
      const svgs = (await Promise.all(buckets.map(async (bucket) =>
        Promise.all((await readdir(join(cache.root, "svg", bucket))).map((filename) =>
          readFile(join(cache.root, "svg", bucket, filename), "utf8")
        ))
      ))).flat();
      expect(svgs).toHaveLength(1);
      expect(svgs[0]).toContain("data-mjx-linebox");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
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

    const original = await renderTestRegion(renderer, region, 20, 2, capabilities, 1);
    const enlarged = await renderTestRegion(renderer, region, 20, 2, capabilities, 1.2);
    renderer.clear();
    const restored = await renderTestRegion(renderer, region, 20, 2, capabilities, 1);

    expect(enlarged.cacheKey).not.toBe(original.cacheKey);
    expect(restored.cacheKey).toBe(original.cacheKey);
    expect(restored.png).toEqual(original.png);
  });
});
