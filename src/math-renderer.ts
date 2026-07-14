import { Resvg } from "@resvg/resvg-js";
import type { FormulaRegion, RenderedFormula, TerminalCapabilities } from "./types.js";
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
// v2 rejects MathJax's visual error boxes instead of persisting them as if
// they were successful formula images.
const MATHJAX_CACHE_VERSION = "mathjax-4.1.3-svg-v3";
const PNG_CACHE_VERSION = "resvg-2.6.2-terminal-canvas-v2";
const CANONICAL_CONTAINER_WIDTH = 100_000;

function mathJaxCacheRequest(latex: string, display: boolean): { source: string; svgKey: string } {
  const normalized = safeLatex(normalizeLatexForRendering(latex).trim());
  const source = display ? normalized : `\\textstyle{${normalized}}`;
  return {
    source,
    svgKey: formulaCacheKey({
      version: MATHJAX_CACHE_VERSION,
      source,
      display: true,
      em: 16,
      ex: 8,
      containerWidth: CANONICAL_CONTAINER_WIDTH,
      fontCache: "local"
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
        svg: { fontCache: "local" }
      });
      return mathJax;
    });
  }
  return mathJaxPromise;
}

function parseLength(value: string | undefined): { value: number; unit: string } | undefined {
  const match = value?.match(/^([\d.]+)(ex|em|px)?$/u);
  return match ? { value: Number(match[1]), unit: match[2] ?? "px" } : undefined;
}

export function readSvgDimensions(svg: string): SvgDimensions {
  const width = parseLength(svg.match(/\bwidth="([^"]+)"/u)?.[1]);
  const height = parseLength(svg.match(/\bheight="([^"]+)"/u)?.[1]);
  const viewBox = svg.match(/\bviewBox="[^\s]+\s+[^\s]+\s+([\d.]+)\s+([\d.]+)"/u);
  const fallbackRatio = viewBox ? Number(viewBox[1]) / Number(viewBox[2]) : 1;

  if (!width || !height) return { aspectRatio: fallbackRatio, heightEx: 1.8, depthEx: 0 };
  const unitToEx = (length: { value: number; unit: string }): number => {
    if (length.unit === "ex") return length.value;
    if (length.unit === "em") return length.value * 2;
    return length.value / 8;
  };
  const widthEx = unitToEx(width);
  const heightEx = unitToEx(height);
  const verticalAlign = svg.match(/vertical-align:\s*(-?[\d.]+)(ex|em|px)?/u);
  const verticalAlignEx = verticalAlign
    ? unitToEx({ value: Number(verticalAlign[1]), unit: verticalAlign[2] ?? "px" })
    : 0;
  return {
    aspectRatio: Number.isFinite(widthEx / heightEx) ? widthEx / heightEx : fallbackRatio,
    heightEx,
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
}

export function normalizeLatexForRendering(latex: string): string {
  const marker = /(?<![A-Za-z0-9.])1\s*\/\s*\\sqrt\s*\{/gu;
  let normalized = latex;
  let searchFrom = 0;

  while (searchFrom < normalized.length) {
    marker.lastIndex = searchFrom;
    const match = marker.exec(normalized);
    if (!match || match.index === undefined) break;
    const openBrace = marker.lastIndex - 1;
    let depth = 1;
    let closeBrace = -1;
    for (let index = openBrace + 1; index < normalized.length; index += 1) {
      if (normalized[index] === "{" && normalized[index - 1] !== "\\") depth += 1;
      if (normalized[index] === "}" && normalized[index - 1] !== "\\") depth -= 1;
      if (depth === 0) {
        closeBrace = index;
        break;
      }
    }
    if (closeBrace < 0) break;

    const sqrtOffset = match[0].indexOf("\\sqrt");
    const sqrt = normalized.slice(match.index + sqrtOffset, closeBrace + 1);
    const replacement = `\\frac{1}{${sqrt}}`;
    normalized = normalized.slice(0, match.index) + replacement + normalized.slice(closeBrace + 1);
    searchFrom = match.index + replacement.length;
  }
  return normalized;
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

export async function renderMathJaxSvg(
  latex: string,
  display: boolean,
  _containerWidth: number,
  cache: FormulaCache = sharedFormulaCache
): Promise<string> {
  // MathJax 4.1 can treat top-level relation and binary operators as inline
  // line-break opportunities and return only the first fragment when called
  // with display:false. Convert in display mode and force textstyle instead;
  // this preserves complete inline expressions without enlarging their glyphs.
  const { source, svgKey } = mathJaxCacheRequest(latex, display);
  const svg = await cache.getOrCreateSvg(svgKey, async () => {
    const mathJax = await getMathJax();
    const node = await mathJax.tex2svgPromise(source, {
      display: true,
      em: 16,
      ex: 8,
      containerWidth: CANONICAL_CONTAINER_WIDTH
    });
    const adaptor = mathJax.startup.adaptor;
    const svgNode = adaptor.tags(node, "svg")[0];
    if (!svgNode) throw new Error("MathJax produced no SVG");
    const serialized = adaptor.serializeXML(svgNode);
    assertValidMathJaxSvg(serialized);
    return serialized;
  });
  // Validate cache hits too. MathJax also represents unknown commands as red
  // mtext rather than merror; discard such legacy entries so they cannot
  // poison every later render of the same source.
  try {
    assertValidMathJaxSvg(svg);
  } catch (error) {
    await cache.deleteSvg(svgKey);
    throw error;
  }
  return svg;
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
    const { svgKey } = mathJaxCacheRequest(region.latex, region.display);
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
    const cached = this.#cache.get(cacheKey);
    if (cached) return cached;

    const formulaSvg = await renderMathJaxSvg(
      region.latex,
      region.display,
      Math.max(80, columns * 16),
      this.persistentCache
    );
    const dimensions = readSvgDimensions(formulaSvg);
    const logicalColumns = region.displayRange
      ? Math.max(1, region.displayRange.endCol - region.displayRange.startCol)
      : region.wrapSegments
      ? Math.max(...region.wrapSegments.map((segment) =>
        segment.logicalStartCol + segment.endCol - segment.startCol
      ))
      : columns;
    const segmented = Boolean(region.wrapSegments?.length);
    const rangedDisplay = Boolean(region.displayRange);
    const geometry = calculateFormulaGeometry({
      aspectRatio: dimensions.aspectRatio,
      naturalHeightEx: dimensions.heightEx,
      depthEx: dimensions.depthEx,
      columns: logicalColumns,
      rows: segmented || rangedDisplay ? 1 : rows,
      cell: capabilities.cell,
      scale,
      display: segmented || rangedDisplay ? false : region.display,
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
    const sliceBackgrounds = region.wrapSegments?.map((segment) => {
      const x = segment.startCol * capabilities.cell.width;
      const y = segment.rowOffset * capabilities.cell.height;
      const width = (segment.endCol - segment.startCol) * capabilities.cell.width;
      return `<rect x="${x}" y="${y}" width="${width}" height="${capabilities.cell.height}" fill="${escapeAttribute(background)}"/>`;
    }) ?? [];
    const wrapper = region.displayRange && region.wrapSegments?.length
      ? [
          `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${canvasHeight}" viewBox="0 0 ${canvasWidth} ${canvasHeight}">`,
          ...sliceBackgrounds,
          content,
          "</svg>"
        ].join("")
      : region.wrapSegments?.length
      ? [
          `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${canvasHeight}" viewBox="0 0 ${canvasWidth} ${canvasHeight}">`,
          ...region.wrapSegments.map((segment) => {
            const destinationX = segment.startCol * capabilities.cell.width;
            const destinationY = segment.rowOffset * capabilities.cell.height;
            const sourceX = segment.logicalStartCol * capabilities.cell.width;
            const width = (segment.endCol - segment.startCol) * capabilities.cell.width;
            return [
              `<svg x="${destinationX}" y="${destinationY}" width="${width}" height="${capabilities.cell.height}" viewBox="${sourceX} 0 ${width} ${capabilities.cell.height}" overflow="hidden">`,
              `<rect x="${sourceX}" width="${width}" height="${capabilities.cell.height}" fill="${escapeAttribute(background)}"/>`,
              content,
              "</svg>"
            ].join("");
          }),
          "</svg>"
        ].join("")
      : [
          `<svg xmlns="http://www.w3.org/2000/svg" width="${geometry.canvasWidth}" height="${geometry.canvasHeight}" viewBox="0 0 ${geometry.canvasWidth} ${geometry.canvasHeight}">`,
          `<rect width="100%" height="100%" fill="${escapeAttribute(background)}"/>`,
          content,
          "</svg>"
        ].join("");
    const png = await this.persistentCache.getOrCreatePng(cacheKey, async () =>
      new Resvg(wrapper, {
        fitTo: { mode: "original" }
      }).render().asPng()
    );
    const rendered: RenderedFormula = {
      png,
      cacheKey,
      columns,
      rows,
      widthPx: canvasWidth,
      heightPx: canvasHeight
    };
    this.#cache.set(cacheKey, rendered);
    if (this.#cache.size > 256) this.#cache.delete(this.#cache.keys().next().value!);
    return rendered;
  }

  clear(): void {
    this.#cache.clear();
  }
}
