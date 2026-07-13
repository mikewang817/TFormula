import process from "node:process";
import { chmodSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import * as pty from "node-pty";
import { FormulaScreen } from "./screen.js";
import { parseTerminalResponses } from "./probe.js";
import type { CliOptions, TerminalCapabilities } from "./types.js";

function ensureNodePtyHelper(): void {
  if (process.platform !== "darwin") return;
  try {
    const entry = createRequire(import.meta.url).resolve("node-pty");
    const packageRoot = dirname(dirname(entry));
    chmodSync(join(packageRoot, "prebuilds", `darwin-${process.arch}`, "spawn-helper"), 0o755);
  } catch {
    // Standard npm installs already preserve this executable bit. The fallback
    // is only needed for package managers that suppress dependency scripts.
  }
}

export async function runProxy(
  options: CliOptions,
  initialCapabilities: TerminalCapabilities,
  pendingInput = ""
): Promise<number> {
  const cols = Math.max(2, process.stdout.columns ?? 80);
  const rows = Math.max(2, process.stdout.rows ?? 24);
  let capabilities = initialCapabilities;
  let child: pty.IPty;
  let probeCapture = "";
  let probeTimer: NodeJS.Timeout | undefined;
  let exiting = false;

  const debug = (message: string): void => {
    if (options.debug) process.stderr.write(`\r\n[tformula] ${message}\r\n`);
  };
  const writeOuter = (data: string | Uint8Array): void => {
    process.stdout.write(data);
  };
  const screen = options.renderMath
    ? new FormulaScreen({ cols, rows, capabilities, scale: options.scale, writeOuter, debug })
    : undefined;

  const finishProbe = (): void => {
    probeTimer = undefined;
    const captured = probeCapture;
    probeCapture = "";
    if (!captured) return;
    const parsed = parseTerminalResponses(captured);
    const nextCell = options.cellOverride
      ? { ...options.cellOverride, source: "override" as const }
      : parsed.cell
        ? { ...parsed.cell, source: "cell-query" as const }
        : parsed.windowPixels
          ? {
              width: parsed.windowPixels.width / Math.max(1, process.stdout.columns ?? cols),
              height: parsed.windowPixels.height / Math.max(1, process.stdout.rows ?? rows),
              source: "window-query" as const
            }
          : capabilities.cell;
    capabilities = {
      ...capabilities,
      cell: nextCell,
      windowPixels: parsed.windowPixels ?? capabilities.windowPixels,
      foreground: parsed.foreground ?? capabilities.foreground,
      background: parsed.background ?? capabilities.background
    };
    screen?.updateCapabilities(capabilities);
    if (parsed.residual) child.write(parsed.residual);
    debug(`cell ${nextCell.width.toFixed(2)}x${nextCell.height.toFixed(2)}px (${nextCell.source})`);
  };

  const requestProbe = (): void => {
    if (!process.stdin.isTTY || options.cellOverride) return;
    if (probeTimer) {
      clearTimeout(probeTimer);
      finishProbe();
    }
    probeCapture = "";
    writeOuter("\x1b[16t\x1b[14t\x1b]10;?\x1b\\\x1b]11;?\x1b\\");
    probeTimer = setTimeout(finishProbe, 160);
  };

  ensureNodePtyHelper();
  child = pty.spawn(options.command, options.args, {
    name: process.env.TERM || "xterm-256color",
    cols,
    rows,
    cwd: options.cwd,
    env: { ...process.env, TFORMULA_ACTIVE: "1" } as Record<string, string>
  });

  const previousRaw = process.stdin.isRaw;
  if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", (chunk: Buffer | string) => {
    const data = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
    if (probeTimer) probeCapture += data;
    else child.write(data);
  });

  child.onData((data) => {
    writeOuter(data);
    screen?.write(data);
  });

  const onResize = (): void => {
    const nextCols = Math.max(2, process.stdout.columns ?? 80);
    const nextRows = Math.max(2, process.stdout.rows ?? 24);
    child.resize(nextCols, nextRows);
    screen?.resize(nextCols, nextRows);
    requestProbe();
  };
  process.on("SIGWINCH", onResize);

  if (pendingInput) child.write(pendingInput);
  debug(`started ${options.command}; math=${Boolean(screen && capabilities.kittyGraphics)}; cell=${capabilities.cell.width.toFixed(2)}x${capabilities.cell.height.toFixed(2)}px`);

  return await new Promise<number>((resolve) => {
    child.onExit(({ exitCode, signal }) => {
      if (exiting) return;
      exiting = true;
      if (probeTimer) clearTimeout(probeTimer);
      process.off("SIGWINCH", onResize);
      screen?.dispose();
      process.stdin.pause();
      if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function" && !previousRaw) {
        process.stdin.setRawMode(false);
      }
      resolve(signal ? 128 + signal : exitCode);
    });
  });
}
