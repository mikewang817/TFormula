import { extname } from "node:path";
import type { FormulaExportFormat } from "./types.js";

const FORMAT_ALIASES: Readonly<Record<string, FormulaExportFormat>> = {
  raw: "latex",
  tex: "latex",
  latex: "latex",
  inline: "latex-inline",
  "latex-inline": "latex-inline",
  display: "latex-display",
  "latex-display": "latex-display",
  md: "markdown",
  markdown: "markdown",
  mml: "mathml",
  mathml: "mathml",
  html: "html",
  svg: "svg",
  png: "png",
  tif: "tiff",
  tiff: "tiff"
};

const EXTENSION_FORMATS: Readonly<Record<string, FormulaExportFormat>> = {
  ".tex": "latex",
  ".latex": "latex",
  ".md": "markdown",
  ".markdown": "markdown",
  ".mml": "mathml",
  ".mathml": "mathml",
  ".htm": "html",
  ".html": "html",
  ".svg": "svg",
  ".png": "png",
  ".tif": "tiff",
  ".tiff": "tiff"
};

export function normalizeFormulaExportFormat(value: string): FormulaExportFormat | undefined {
  return FORMAT_ALIASES[value.toLowerCase()];
}

export function inferFormulaExportFormat(path: string): FormulaExportFormat | undefined {
  return EXTENSION_FORMATS[extname(path).toLowerCase()];
}

export const formulaExportFormatInternals = { EXTENSION_FORMATS, FORMAT_ALIASES };
