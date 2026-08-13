import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { delimiter as pathDelimiter } from "node:path";

export type TeXDefinitionMap = Record<string, string | unknown[]>;

export interface MathRendererConfig {
  macros: TeXDefinitionMap;
  environments: TeXDefinitionMap;
  fontFiles?: string[];
  loadSystemFonts: boolean;
  fingerprint: string;
}

const DISABLED_TEX_COMMAND_RE = /\\(?:require|href|url|html|class|cssId|style|includegraphics|input|include|usepackage|documentclass)\b/iu;

function validDefinitionValue(value: unknown): boolean {
  return typeof value === "string"
    || typeof value === "number"
    || (Array.isArray(value) && value.every(validDefinitionValue));
}

function definitionSource(definition: string | unknown[]): string {
  const parts: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === "string") parts.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
  };
  visit(definition);
  return parts.join("\n");
}

function definitionMap(value: string | undefined, variable: string): TeXDefinitionMap {
  if (!value?.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`${variable} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error(`${variable} must be a JSON object`);
  }

  const definitions: TeXDefinitionMap = {};
  for (const [rawName, definition] of Object.entries(parsed)) {
    const name = rawName.replace(/^\\/u, "");
    if (!/^[A-Za-z][A-Za-z0-9]*$/u.test(name)) {
      throw new Error(`${variable} contains an invalid TeX name: ${rawName}`);
    }
    if (typeof definition !== "string" && !Array.isArray(definition)) {
      throw new Error(`${variable}.${rawName} must be a string or array definition`);
    }
    if (Array.isArray(definition)
      && (typeof definition[0] !== "string" || !validDefinitionValue(definition))) {
      throw new Error(`${variable}.${rawName} has an unsupported array definition`);
    }
    if (DISABLED_TEX_COMMAND_RE.test(definitionSource(definition))) {
      throw new Error(`${variable}.${rawName} contains a disabled command`);
    }
    definitions[name] = definition;
  }
  return definitions;
}

function configuredFontFiles(value: string | undefined): string[] | undefined {
  if (!value?.trim()) return undefined;
  const files = [...new Set(value
    .split(pathDelimiter)
    .map((path) => path.trim())
    .filter(Boolean))];
  const missing = files.find((path) => !existsSync(path));
  if (missing) throw new Error(`TFORMULA_FONT_FILES does not exist: ${missing}`);
  return files;
}

function enabled(value: string | undefined): boolean {
  if (value === undefined) return true;
  return value !== "0" && value.toLowerCase() !== "false";
}

/** Load process-local, local-only MathJax/Resvg customization. */
export function loadMathRendererConfig(
  environment: NodeJS.ProcessEnv = process.env
): MathRendererConfig {
  const macros = definitionMap(environment.TFORMULA_MATH_MACROS, "TFORMULA_MATH_MACROS");
  const environments = definitionMap(
    environment.TFORMULA_MATH_ENVIRONMENTS,
    "TFORMULA_MATH_ENVIRONMENTS"
  );
  const fontFiles = configuredFontFiles(environment.TFORMULA_FONT_FILES);
  const loadSystemFonts = enabled(environment.TFORMULA_SYSTEM_FONTS);
  const fingerprint = createHash("sha256").update(JSON.stringify({
    macros,
    environments,
    fontFiles: fontFiles ?? [],
    loadSystemFonts
  })).digest("hex");
  return {
    macros,
    environments,
    ...(fontFiles ? { fontFiles } : {}),
    loadSystemFonts,
    fingerprint
  };
}

export const mathRendererConfig = loadMathRendererConfig();
