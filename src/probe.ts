import type { TerminalCapabilities } from "./types.js";

const DEFAULT_CELL = { width: 9, height: 18, source: "fallback" as const };
const DEFAULT_FOREGROUND = "#d8dee9";
const DEFAULT_BACKGROUND = "#1e1e2e";

interface ParsedResponses {
  cell?: { width: number; height: number };
  windowPixels?: { width: number; height: number };
  foreground?: string;
  background?: string;
  residual: string;
}

function normalizeRgbComponent(value: string): number {
  const parsed = Number.parseInt(value, 16);
  const maximum = (16 ** value.length) - 1;
  return Math.round((parsed / maximum) * 255);
}

function parseRgb(value: string): string | undefined {
  const match = value.match(/^rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})$/iu);
  if (!match) return undefined;
  return `#${match.slice(1, 4).map((part) => normalizeRgbComponent(part!).toString(16).padStart(2, "0")).join("")}`;
}

export function parseTerminalResponses(input: string): ParsedResponses {
  let residual = input;
  let cell: ParsedResponses["cell"];
  let windowPixels: ParsedResponses["windowPixels"];
  let foreground: string | undefined;
  let background: string | undefined;

  residual = residual.replace(/\x1b\[6;(\d+);(\d+)t/gu, (_all, height, width) => {
    cell = { width: Number(width), height: Number(height) };
    return "";
  });
  residual = residual.replace(/\x1b\[4;(\d+);(\d+)t/gu, (_all, height, width) => {
    windowPixels = { width: Number(width), height: Number(height) };
    return "";
  });
  residual = residual.replace(/\x1b\](10|11);([^\x07\x1b]+)(?:\x07|\x1b\\)/gu, (_all, slot, value) => {
    const color = parseRgb(value);
    if (slot === "10") foreground = color;
    if (slot === "11") background = color;
    return "";
  });

  return { cell, windowPixels, foreground, background, residual };
}

function supportsKittyGraphics(env: NodeJS.ProcessEnv): boolean {
  const identity = `${env.TERM ?? ""} ${env.TERM_PROGRAM ?? ""}`.toLowerCase();
  return /ghostty|kitty|wezterm/u.test(identity);
}

export interface ProbeResult {
  capabilities: TerminalCapabilities;
  pendingInput: string;
}

export async function probeTerminal(
  cellOverride?: { width: number; height: number },
  timeoutMs = 180
): Promise<ProbeResult> {
  const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const fallback: TerminalCapabilities = {
    kittyGraphics: supportsKittyGraphics(process.env),
    foreground: DEFAULT_FOREGROUND,
    background: DEFAULT_BACKGROUND,
    cell: cellOverride
      ? { ...cellOverride, source: "override" }
      : DEFAULT_CELL
  };

  if (!tty || typeof process.stdin.setRawMode !== "function") {
    return { capabilities: fallback, pendingInput: "" };
  }

  const wasRaw = process.stdin.isRaw;
  const chunks: Buffer[] = [];
  const onData = (chunk: Buffer | string): void => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  };

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", onData);
  // Cell pixels, text-area pixels, foreground, and background.
  process.stdout.write("\x1b[16t\x1b[14t\x1b]10;?\x1b\\\x1b]11;?\x1b\\");
  await new Promise((resolve) => setTimeout(resolve, timeoutMs));
  process.stdin.off("data", onData);
  if (!wasRaw) process.stdin.setRawMode(false);
  process.stdin.pause();

  const parsed = parseTerminalResponses(Buffer.concat(chunks).toString("utf8"));
  let cell = fallback.cell;
  if (!cellOverride && parsed.cell && parsed.cell.width > 0 && parsed.cell.height > 0) {
    cell = { ...parsed.cell, source: "cell-query" };
  } else if (!cellOverride && parsed.windowPixels) {
    const cols = Math.max(1, process.stdout.columns ?? 80);
    const rows = Math.max(1, process.stdout.rows ?? 24);
    cell = {
      width: parsed.windowPixels.width / cols,
      height: parsed.windowPixels.height / rows,
      source: "window-query"
    };
  }

  return {
    capabilities: {
      ...fallback,
      foreground: parsed.foreground ?? fallback.foreground,
      background: parsed.background ?? fallback.background,
      cell,
      windowPixels: parsed.windowPixels
    },
    pendingInput: parsed.residual
  };
}

export const probeInternals = { parseRgb, supportsKittyGraphics };
