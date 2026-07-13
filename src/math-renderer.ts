import { createHash } from "node:crypto";
import { Resvg } from "@resvg/resvg-js";
import type { FormulaRegion, RenderedFormula, TerminalCapabilities } from "./types.js";
import { calculateFormulaGeometry } from "./geometry.js";

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

async function getMathJax(): Promise<MathJaxApi> {
  if (!mathJaxPromise) {
    mathJaxPromise = import("@mathjax/src").then(async (module) => {
      const mathJax = module.default as unknown as MathJaxApi;
      await mathJax.init({
        loader: { load: ["input/tex", "output/svg"] },
        tex: { maxBuffer: 8192 },
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

export class MathRenderer {
  readonly #cache = new Map<string, RenderedFormula>();

  async render(
    region: FormulaRegion,
    columns: number,
    rows: number,
    capabilities: TerminalCapabilities,
    scale: number,
    foreground = capabilities.foreground,
    background = capabilities.background
  ): Promise<RenderedFormula> {
    const cacheKey = createHash("sha256").update(JSON.stringify({
      latex: region.latex,
      display: region.display,
      columns,
      rows,
      cell: capabilities.cell,
      scale,
      foreground,
      background
    })).digest("hex");
    const cached = this.#cache.get(cacheKey);
    if (cached) return cached;

    const mathJax = await getMathJax();
    const node = await mathJax.tex2svgPromise(safeLatex(region.latex), {
      display: region.display,
      em: 16,
      ex: 8,
      containerWidth: Math.max(80, columns * 16)
    });
    const adaptor = mathJax.startup.adaptor;
    const svgNode = adaptor.tags(node, "svg")[0];
    if (!svgNode) throw new Error("MathJax produced no SVG");
    const formulaSvg = adaptor.serializeXML(svgNode);
    const dimensions = readSvgDimensions(formulaSvg);
    const geometry = calculateFormulaGeometry({
      aspectRatio: dimensions.aspectRatio,
      naturalHeightEx: dimensions.heightEx,
      depthEx: dimensions.depthEx,
      columns,
      rows,
      cell: capabilities.cell,
      scale,
      display: region.display
    });
    const nested = resizeNestedSvg(
      formulaSvg,
      geometry.offsetX,
      geometry.offsetY,
      geometry.formulaWidth,
      geometry.formulaHeight
    );
    const wrapper = [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${geometry.canvasWidth}" height="${geometry.canvasHeight}" viewBox="0 0 ${geometry.canvasWidth} ${geometry.canvasHeight}">`,
      `<rect width="100%" height="100%" fill="${escapeAttribute(background)}"/>`,
      `<g color="${escapeAttribute(foreground)}" fill="${escapeAttribute(foreground)}">${nested}</g>`,
      "</svg>"
    ].join("");
    const png = new Resvg(wrapper, {
      background: background,
      fitTo: { mode: "original" }
    }).render().asPng();
    const rendered: RenderedFormula = {
      png,
      columns,
      rows,
      widthPx: geometry.canvasWidth,
      heightPx: geometry.canvasHeight
    };
    this.#cache.set(cacheKey, rendered);
    if (this.#cache.size > 256) this.#cache.delete(this.#cache.keys().next().value!);
    return rendered;
  }

  clear(): void {
    this.#cache.clear();
  }
}
