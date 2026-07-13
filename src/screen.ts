import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { Terminal as XtermTerminal } from "@xterm/headless";
import { detectFormulaRegions } from "./detect.js";
import { MathRenderer } from "./math-renderer.js";
import {
  cursorPosition,
  kittyDeleteByZIndex,
  kittyDeleteImage,
  kittyTransmitAndPlace,
  synchronizedOutput
} from "./kitty.js";
import type { FormulaRegion, TerminalCapabilities } from "./types.js";

const { Terminal } = createRequire(import.meta.url)("@xterm/headless") as {
  Terminal: typeof XtermTerminal;
};

interface PlacedFormula {
  imageId: number;
  fingerprint: string;
}

function rgbHex(value: number): string {
  return `#${value.toString(16).padStart(6, "0").slice(-6)}`;
}

export class FormulaScreen {
  readonly terminal: XtermTerminal;
  readonly #renderer = new MathRenderer();
  readonly #placed = new Map<string, PlacedFormula>();
  readonly #writeOuter: (data: string | Uint8Array) => void;
  readonly #debug: (message: string) => void;
  #capabilities: TerminalCapabilities;
  #scale: number;
  #imageId = 1_400_000_000;
  #scanTimer?: NodeJS.Timeout;
  #scanVersion = 0;
  #scanning = false;
  #rescanRequested = false;

  constructor(options: {
    cols: number;
    rows: number;
    capabilities: TerminalCapabilities;
    scale: number;
    writeOuter: (data: string | Uint8Array) => void;
    debug?: (message: string) => void;
  }) {
    this.terminal = new Terminal({
      cols: options.cols,
      rows: options.rows,
      scrollback: 10_000,
      allowProposedApi: true
    });
    this.#capabilities = options.capabilities;
    this.#scale = options.scale;
    this.#writeOuter = options.writeOuter;
    this.#debug = options.debug ?? (() => undefined);
    this.terminal.buffer.onBufferChange(() => this.resetPlacements());
  }

  write(data: string): void {
    this.terminal.write(data, () => this.scheduleScan());
  }

  resize(cols: number, rows: number): void {
    this.terminal.resize(Math.max(2, cols), Math.max(2, rows));
    this.resetPlacements();
    this.scheduleScan(180);
  }

  updateCapabilities(capabilities: TerminalCapabilities): void {
    const dimensionsChanged = capabilities.cell.width !== this.#capabilities.cell.width
      || capabilities.cell.height !== this.#capabilities.cell.height;
    const colorsChanged = capabilities.foreground !== this.#capabilities.foreground
      || capabilities.background !== this.#capabilities.background;
    this.#capabilities = capabilities;
    if (dimensionsChanged || colorsChanged) {
      this.#renderer.clear();
      this.resetPlacements();
      this.scheduleScan(180);
    }
  }

  setScale(scale: number): void {
    this.#scale = scale;
    this.#renderer.clear();
    this.resetPlacements();
    this.scheduleScan();
  }

  scheduleScan(delayMs = 110): void {
    this.#scanVersion += 1;
    if (this.#scanTimer) clearTimeout(this.#scanTimer);
    this.#scanTimer = setTimeout(() => void this.#scan(), delayMs);
  }

  resetPlacements(): void {
    if (this.#placed.size > 0 && this.#capabilities.kittyGraphics) {
      this.#writeOuter(kittyDeleteByZIndex());
    }
    this.#placed.clear();
  }

  dispose(): void {
    if (this.#scanTimer) clearTimeout(this.#scanTimer);
    this.resetPlacements();
    this.terminal.dispose();
  }

  #visibleLines(): string[] {
    const buffer = this.terminal.buffer.active;
    return Array.from({ length: this.terminal.rows }, (_, row) =>
      buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? ""
    );
  }

  #regionColors(region: FormulaRegion): { foreground: string; background: string } {
    const buffer = this.terminal.buffer.active;
    const line = buffer.getLine(buffer.viewportY + region.startRow);
    const cell = line?.getCell(Math.min(region.startCol, this.terminal.cols - 1));
    if (!cell) return this.#capabilities;

    let foreground = cell.isFgRGB() ? rgbHex(cell.getFgColor()) : this.#capabilities.foreground;
    let background = cell.isBgRGB() ? rgbHex(cell.getBgColor()) : this.#capabilities.background;
    if (cell.isInverse()) [foreground, background] = [background, foreground];
    return { foreground, background };
  }

  #anchor(region: FormulaRegion, columns: number, rows: number): string {
    const buffer = this.terminal.buffer.active;
    return `${buffer.type}:${buffer.viewportY + region.startRow}:${region.startCol}:${columns}:${rows}`;
  }

  async #scan(): Promise<void> {
    if (!this.#capabilities.kittyGraphics || this.terminal.modes.originMode) return;
    if (this.#scanning) {
      this.#rescanRequested = true;
      return;
    }

    this.#scanning = true;
    const version = this.#scanVersion;
    try {
      const regions = detectFormulaRegions(this.#visibleLines());
      for (const region of regions) {
        if (version !== this.#scanVersion) break;
        const rows = region.endRow - region.startRow + 1;
        const columns = rows > 1 && !region.compact
          ? this.terminal.cols
          : Math.max(1, Math.min(this.terminal.cols - region.startCol, region.endCol - region.startCol));
        const anchor = this.#anchor(region, columns, rows);
        const colors = this.#regionColors(region);
        const fingerprint = createHash("sha1").update(JSON.stringify({
          latex: region.latex,
          colors,
          cell: this.#capabilities.cell,
          scale: this.#scale
        })).digest("hex");
        const existing = this.#placed.get(anchor);
        if (existing?.fingerprint === fingerprint) continue;

        if (existing) {
          this.#writeOuter(kittyDeleteImage(existing.imageId));
          this.#placed.delete(anchor);
        }

        try {
          const rendered = await this.#renderer.render(
            region,
            columns,
            rows,
            this.#capabilities,
            this.#scale,
            colors.foreground,
            colors.background
          );
          if (version !== this.#scanVersion) break;

          const buffer = this.terminal.buffer.active;
          // CUP cannot reproduce xterm's pending-wrap state exactly.
          if (buffer.cursorX >= this.terminal.cols) {
            this.#rescanRequested = true;
            break;
          }
          const imageId = this.#imageId++;
          if (this.#imageId >= 2_000_000_000) this.#imageId = 1_400_000_000;
          const placement = [
            cursorPosition(region.startRow + 1, region.startCol + 1),
            kittyTransmitAndPlace(rendered.png, imageId, columns, rows),
            cursorPosition(buffer.cursorY + 1, buffer.cursorX + 1)
          ].join("");
          this.#writeOuter(synchronizedOutput(placement));
          this.#placed.set(anchor, { imageId, fingerprint });
          this.#debug(`rendered ${region.confidence} formula at ${anchor} (${rendered.widthPx}x${rendered.heightPx}px)`);
        } catch (error) {
          this.#debug(`formula render skipped: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } finally {
      this.#scanning = false;
      if (this.#rescanRequested || version !== this.#scanVersion) {
        this.#rescanRequested = false;
        this.scheduleScan(140);
      }
    }
  }
}
