import { renderAsync } from "@resvg/resvg-js";
import type {
  CellMetrics,
  FormulaRegion,
  FormulaWrapSegment,
  RenderedFormula,
  TerminalCapabilities
} from "./types.js";
import { calculateFormulaGeometry } from "./geometry.js";
import { FormulaCache, formulaCacheKey, sharedFormulaCache } from "./formula-cache.js";

interface MathJaxApi {
  init(config: Record<string, unknown>): Promise<MathJaxApi>;
  tex2svgPromise(tex: string, options: Record<string, unknown>): Promise<unknown>;
  startup: {
    adaptor: {
      tags(node: unknown, name: string): unknown[];
      serializeXML(node: unknown): string;
    };
  };
}

interface SvgDimensions {
  aspectRatio: number;
  heightEx: number;
  depthEx: number;
}

let mathJaxPromise: Promise<MathJaxApi> | undefined;
const MATHJAX_CACHE_VERSION = "mathjax-4.1.3-svg-v4";
const PNG_CACHE_VERSION = "resvg-2.6.2-terminal-canvas-v3";
const CANONICAL_CONTAINER_WIDTH = 100_000;
const MATHJAX_EX_PX = 8;

function normalizedContainerWidth(display: boolean, containerWidth: number): number {
  if (!display) return CANONICAL_CONTAINER_WIDTH;
  return Number.isFinite(containerWidth) && containerWidth > 0
    ? Math.max(1, Math.round(containerWidth))
    : CANONICAL_CONTAINER_WIDTH;
}

function mathJaxCacheRequest(
  latex: string,
  display: boolean,
  containerWidth: number
): { source: string; svgKey: string; containerWidth: number } {
  // TeX whitespace is usually insignificant, but a trailing space can be the
  // operand of the control-space command (`\\ `). Preserve the source exactly.
  const source = safeLatex(normalizeLatexForRendering(latex));
  const effectiveContainerWidth = normalizedContainerWidth(display, containerWidth);
  return {
    source,
    containerWidth: effectiveContainerWidth,
    svgKey: formulaCacheKey({
      version: MATHJAX_CACHE_VERSION,
      source,
      display,
      em: 16,
      ex: 8,
      containerWidth: effectiveContainerWidth,
      fontCache: "local",
      displayOverflow: "linebreak",
      inlineLinebreaks: false
    })
  };
}

async function getMathJax(): Promise<MathJaxApi> {
  if (!mathJaxPromise) {
    mathJaxPromise = import("@mathjax/src").then(async (module) => {
      const mathJax = module.default as unknown as MathJaxApi;
      await mathJax.init({
        loader: {
          load: ["input/tex", "[tex]/mhchem", "[tex]/physics", "output/svg"]
        },
        tex: {
          maxBuffer: 8192,
          packages: { "[+]": ["mhchem", "physics"] }
        },
        svg: {
          fontCache: "local",
          displayOverflow: "linebreak",
          linebreaks: { inline: false }
        }
      });
      return mathJax;
    });
  }
  return mathJaxPromise;
}

function parseLength(value: string | undefined): { value: number; unit: string } | undefined {
  const match = value?.match(/^((?:\d+(?:\.\d*)?|\.\d+))(ex|em|px)?$/u);
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed > 0
    ? { value: parsed, unit: match[2] ?? "px" }
    : undefined;
}

export function readSvgDimensions(svg: string): SvgDimensions {
  const width = parseLength(svg.match(/\bwidth="([^"]+)"/u)?.[1]);
  const height = parseLength(svg.match(/\bheight="([^"]+)"/u)?.[1]);
  const viewBox = svg.match(/\bviewBox="[^\s]+\s+[^\s]+\s+([\d.]+)\s+([\d.]+)"/u);
  const viewBoxRatio = viewBox ? Number(viewBox[1]) / Number(viewBox[2]) : 1;
  const fallbackRatio = Number.isFinite(viewBoxRatio) && viewBoxRatio > 0 ? viewBoxRatio : 1;

  const unitToEx = (length: { value: number; unit: string }): number => {
    if (length.unit === "ex") return length.value;
    if (length.unit === "em") return length.value * 2;
    return length.value / 8;
  };
  const parsedHeightEx = height
    ? unitToEx(height)
    : width
      ? unitToEx(width) / fallbackRatio
      : 1.8;
  const parsedWidthEx = width
    ? unitToEx(width)
    : parsedHeightEx * fallbackRatio;
  const verticalAlign = svg.match(/vertical-align:\s*(-?[\d.]+)(ex|em|px)?/u);
  const parsedVerticalAlignEx = verticalAlign
    ? unitToEx({ value: Number(verticalAlign[1]), unit: verticalAlign[2] ?? "px" })
    : 0;
  const verticalAlignEx = Number.isFinite(parsedVerticalAlignEx) ? parsedVerticalAlignEx : 0;
  const aspectRatio = parsedWidthEx / parsedHeightEx;
  return {
    aspectRatio: Number.isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : fallbackRatio,
    heightEx: Number.isFinite(parsedHeightEx) && parsedHeightEx > 0 ? parsedHeightEx : 1.8,
    depthEx: Math.max(0, -verticalAlignEx)
  };
}

function safeLatex(latex: string): string {
  if (latex.length > 8192) throw new Error("formula exceeds the 8192 character limit");
  if (/\\(?:require|href|url|html|class|cssId|style)\b/iu.test(latex)) {
    throw new Error("formula contains a disabled command");
  }
  return latex;
}

function assertValidMathJaxSvg(svg: string): void {
  const redErrorText = /<g\b(?=[^>]*\bdata-mml-node=["']mtext["'])(?=[^>]*\bfill=["']red["'])(?=[^>]*\bstroke=["']red["'])[^>]*>/iu;
  if (/\bdata-mjx-error\s*=|\bdata-mml-node=["']merror["']|<merror\b/iu.test(svg)
    || redErrorText.test(svg)) {
    throw new Error("MathJax could not parse the formula");
  }
  const dimensions = readSvgDimensions(svg);
  if (!/^<svg\b/iu.test(svg)
    || !/\bwidth=["'][^"']+["']/iu.test(svg)
    || !/\bheight=["'][^"']+["']/iu.test(svg)
    || !/\bviewBox=["'][^"']+["']/iu.test(svg)
    || !/\bdata-mml-node=["']math["']/iu.test(svg)
    || !Number.isFinite(dimensions.aspectRatio)
    || dimensions.aspectRatio <= 0
    || !Number.isFinite(dimensions.heightEx)
    || dimensions.heightEx <= 0) {
    throw new Error("MathJax produced an incomplete SVG");
  }
}

export function normalizeLatexForRendering(latex: string): string {
  // Rendering must not algebraically rewrite valid TeX. In particular,
  // changing x^1/\sqrt{y} into x^\frac{1}{\sqrt{y}} changes its meaning.
  // `\textcircled` is a presentational LaTeX command which MathJax 4 does not
  // implement. Map its simple form to MathJax's equivalent enclosure while
  // preserving the enclosed expression exactly.
  return latex
    .replace(
      /\\text\s*\{\s*\\textcircled\s*\{([^{}]*)\}\s*\}/gu,
      (_match, contents: string) => `\\enclose{circle}{${contents}}`
    )
    .replace(
      /\\textcircled\s*\{([^{}]*)\}/gu,
      (_match, contents: string) => `\\enclose{circle}{${contents}}`
    );
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

function resizeNestedSvg(svg: string, x: number, y: number, width: number, height: number): string {
  return svg.replace(/^<svg\b([^>]*)>/u, (_all, attributes: string) => {
    const cleaned = attributes
      .replace(/\s(?:width|height|x|y|style)="[^"]*"/gu, "")
      .replace(/\sxmlns="[^"]*"/u, "");
    return `<svg x="${x}" y="${y}" width="${width}" height="${height}"${cleaned}>`;
  });
}

function svgNeedsSystemFonts(svg: string): boolean {
  // MathJax normally emits every glyph as an SVG path. Resvg otherwise scans
  // the complete system font collection for every formula, even though those
  // fonts cannot affect path-only output. Keep font loading for MathJax's
  // fallback <text> nodes (for example CJK text that is not in its SVG font).
  return /<(?:[A-Za-z_][\w.-]*:)?text(?=[\s/>])/iu.test(svg);
}

function sharedContentId(content: string): string {
  const prefix = "tformula-sliced-content";
  let id = prefix;
  let suffix = 0;
  while (content.includes(`id="${id}"`) || content.includes(`id='${id}'`)) {
    suffix += 1;
    id = `${prefix}-${suffix}`;
  }
  return id;
}

function buildHorizontallySlicedSvg(options: {
  canvasWidth: number;
  canvasHeight: number;
  wrapSegments: FormulaWrapSegment[];
  cell: CellMetrics;
  background: string;
  content: string;
}): string {
  const contentId = sharedContentId(options.content);
  const reference = `<use href="#${contentId}"/>`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${options.canvasWidth}" height="${options.canvasHeight}" viewBox="0 0 ${options.canvasWidth} ${options.canvasHeight}">`,
    `<defs><g id="${contentId}">${options.content}</g></defs>`,
    ...options.wrapSegments.map((segment) => {
      const destinationX = segment.startCol * options.cell.width;
      const destinationY = segment.rowOffset * options.cell.height;
      const sourceX = segment.logicalStartCol * options.cell.width;
      const width = (segment.endCol - segment.startCol) * options.cell.width;
      return [
        `<svg x="${destinationX}" y="${destinationY}" width="${width}" height="${options.cell.height}" viewBox="${sourceX} 0 ${width} ${options.cell.height}" overflow="hidden">`,
        `<rect x="${sourceX}" width="${width}" height="${options.cell.height}" fill="${escapeAttribute(options.background)}"/>`,
        reference,
        "</svg>"
      ].join("");
    }),
    "</svg>"
  ].join("");
}

function lruCacheGet<Key, Value>(cache: Map<Key, Value>, key: Key): Value | undefined {
  const value = cache.get(key);
  if (value === undefined) return undefined;
  cache.delete(key);
  cache.set(key, value);
  return value;
}

async function renderSvgToPng(svg: string, loadSystemFonts: boolean): Promise<Buffer> {
  const rendered = await renderAsync(svg, {
    fitTo: { mode: "original" },
    font: { loadSystemFonts }
  });
  return rendered.asPng();
}

export async function renderMathJaxSvg(
  latex: string,
  display: boolean,
  containerWidth: number,
  cache: FormulaCache = sharedFormulaCache
): Promise<string> {
  const request = mathJaxCacheRequest(latex, display, containerWidth);
  const create = async (): Promise<string> => {
    const mathJax = await getMathJax();
    const node = await mathJax.tex2svgPromise(request.source, {
      display,
      em: 16,
      ex: 8,
      containerWidth: request.containerWidth
    });
    const adaptor = mathJax.startup.adaptor;
    const svgNode = adaptor.tags(node, "svg")[0];
    if (!svgNode) throw new Error("MathJax produced no SVG");
    const serialized = adaptor.serializeXML(svgNode);
    assertValidMathJaxSvg(serialized);
    return serialized;
  };
  const svg = await cache.getOrCreateSvg(request.svgKey, create);
  // Validate cache hits too. MathJax also represents unknown commands as red
  // mtext rather than merror. Incomplete but well-formed SVG roots must not
  // persist as blank formula images either. Since newly-created output was
  // already checked above, a failure here is necessarily a stale cache hit;
  // delete it and repair the request immediately.
  try {
    assertValidMathJaxSvg(svg);
    return svg;
  } catch {
    await cache.deleteSvg(request.svgKey);
    const repaired = await cache.getOrCreateSvg(request.svgKey, create);
    assertValidMathJaxSvg(repaired);
    return repaired;
  }
}

export class MathRenderer {
  readonly #cache = new Map<string, RenderedFormula>();

  constructor(readonly persistentCache: FormulaCache = sharedFormulaCache) {}

  async render(
    region: FormulaRegion,
    columns: number,
    rows: number,
    capabilities: TerminalCapabilities,
    scale: number,
    foreground = capabilities.foreground,
    background = capabilities.background
  ): Promise<RenderedFormula> {
    const wrapSegments = region.wrapSegments?.length ? region.wrapSegments : undefined;
    const segmentLogicalColumns = wrapSegments
      ? Math.max(...wrapSegments.map((segment) =>
        segment.logicalStartCol + segment.endCol - segment.startCol
      ))
      : 0;
    const logicalColumns = region.displayRange
      ? Math.max(1, region.displayRange.endCol - region.displayRange.startCol)
      : wrapSegments
      ? Math.max(1, segmentLogicalColumns)
      : columns;
    const segmented = Boolean(wrapSegments);
    const rangedDisplay = Boolean(region.displayRange);
    const horizontallySliced = segmented && !rangedDisplay;
    // A one-row TUI region has no vertical space for MathJax's line boxes and
    // can become less legible when several lines are compressed back into it.
    // Multi-row, non-segmented displays can use their reserved height safely.
    const linebreakDisplay = region.display && !horizontallySliced && rows > 1;
    const availableWidthPx = Math.max(
      1,
      logicalColumns * capabilities.cell.width - capabilities.cell.width * 2
    );
    const targetExPx = capabilities.cell.height * 0.45 * scale;
    const mathJaxContainerWidth = linebreakDisplay
      ? Math.max(1, availableWidthPx * MATHJAX_EX_PX / targetExPx)
      : CANONICAL_CONTAINER_WIDTH;
    const { svgKey } = mathJaxCacheRequest(
      region.latex,
      region.display,
      mathJaxContainerWidth
    );
    const cacheKey = formulaCacheKey({
      version: PNG_CACHE_VERSION,
      svgKey,
      display: region.display,
      compact: Boolean(region.compact),
      displayRange: region.displayRange,
      composite: Boolean(region.composite),
      wrapSegments: region.wrapSegments,
      columns,
      rows,
      cell: { width: capabilities.cell.width, height: capabilities.cell.height },
      scale,
      foreground,
      background
    });
    const cached = lruCacheGet(this.#cache, cacheKey);
    if (cached) return cached;

    const formulaSvg = await renderMathJaxSvg(
      region.latex,
      region.display,
      mathJaxContainerWidth,
      this.persistentCache
    );
    const dimensions = readSvgDimensions(formulaSvg);
    const geometry = calculateFormulaGeometry({
      aspectRatio: dimensions.aspectRatio,
      naturalHeightEx: dimensions.heightEx,
      depthEx: dimensions.depthEx,
      columns: logicalColumns,
      rows: horizontallySliced ? 1 : rows,
      cell: capabilities.cell,
      scale,
      display: horizontallySliced ? false : region.display,
      leftAlign: !region.display || Boolean(region.compact)
    });
    const nestedX = geometry.offsetX
      + (region.displayRange?.startCol ?? 0) * capabilities.cell.width;
    const nested = resizeNestedSvg(
      formulaSvg,
      nestedX,
      geometry.offsetY,
      geometry.formulaWidth,
      geometry.formulaHeight
    );
    const content = `<g color="${escapeAttribute(foreground)}" fill="${escapeAttribute(foreground)}">${nested}</g>`;
    const canvasWidth = Math.max(1, Math.round(columns * capabilities.cell.width));
    const canvasHeight = Math.max(1, Math.round(rows * capabilities.cell.height));
    const sliceBackgrounds = wrapSegments?.map((segment) => {
      const x = segment.startCol * capabilities.cell.width;
      const y = segment.rowOffset * capabilities.cell.height;
      const width = (segment.endCol - segment.startCol) * capabilities.cell.width;
      return `<rect x="${x}" y="${y}" width="${width}" height="${capabilities.cell.height}" fill="${escapeAttribute(background)}"/>`;
    }) ?? [];
    const wrapper = region.displayRange && wrapSegments
      ? [
          `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${canvasHeight}" viewBox="0 0 ${canvasWidth} ${canvasHeight}">`,
          ...sliceBackgrounds,
          content,
          "</svg>"
        ].join("")
      : wrapSegments
      ? buildHorizontallySlicedSvg({
          canvasWidth,
          canvasHeight,
          wrapSegments,
          cell: capabilities.cell,
          background,
          content
        })
      : [
          `<svg xmlns="http://www.w3.org/2000/svg" width="${geometry.canvasWidth}" height="${geometry.canvasHeight}" viewBox="0 0 ${geometry.canvasWidth} ${geometry.canvasHeight}">`,
          `<rect width="100%" height="100%" fill="${escapeAttribute(background)}"/>`,
          content,
          "</svg>"
        ].join("");
    const png = await this.persistentCache.getOrCreatePng(cacheKey, () =>
      renderSvgToPng(wrapper, svgNeedsSystemFonts(formulaSvg))
    );
    const rendered: RenderedFormula = {
      png,
      cacheKey,
      columns,
      rows,
      widthPx: canvasWidth,
      heightPx: canvasHeight,
      naturalAspectRatio: dimensions.aspectRatio,
      naturalHeightEx: dimensions.heightEx
    };
    this.#cache.set(cacheKey, rendered);
    if (this.#cache.size > 256) this.#cache.delete(this.#cache.keys().next().value!);
    return rendered;
  }

  clear(): void {
    this.#cache.clear();
  }
}

export const mathRendererInternals = {
  buildHorizontallySlicedSvg,
  lruCacheGet,
  renderSvgToPng,
  svgNeedsSystemFonts
};
