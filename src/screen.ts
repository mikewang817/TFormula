import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { IMarker, Terminal as XtermTerminal } from "@xterm/headless";
import { detectFormulaRegions } from "./detect.js";
import { MathRenderer } from "./math-renderer.js";
import {
  cursorPosition,
  kittyDeleteByZIndex,
  kittyDeleteImage,
  kittyDeletePlacement,
  kittyDeleteRange,
  kittyPlaceImage,
  kittyTransmitImage,
  synchronizedOutput,
  TFORMULA_IMAGE_ID_MAX,
  TFORMULA_IMAGE_ID_MIN
} from "./kitty.js";
import type { FormulaRegion, TerminalCapabilities } from "./types.js";

const { Terminal } = createRequire(import.meta.url)("@xterm/headless") as {
  Terminal: typeof XtermTerminal;
};

interface PlacedFormula {
  imageId: number;
  placementId: number;
  imageKey: string;
  fingerprint: string;
  bufferType: string;
  absoluteStartRow: number;
  absoluteEndRow: number;
  startMarker?: IMarker;
  endMarker?: IMarker;
}

interface TerminalImage {
  imageId: number;
  placements: number;
}

function rgbHex(value: number): string {
  return `#${value.toString(16).padStart(6, "0").slice(-6)}`;
}

export class FormulaScreen {
  readonly terminal: XtermTerminal;
  readonly #renderer: MathRenderer;
  readonly #placed = new Map<string, PlacedFormula>();
  readonly #terminalImages = new Map<string, TerminalImage>();
  readonly #writeOuter: (data: string | Uint8Array) => void;
  readonly #debug: (message: string) => void;
  #capabilities: TerminalCapabilities;
  #scale: number;
  #imageId = TFORMULA_IMAGE_ID_MIN;
  #placementId = 1;
  #scanTimer?: NodeJS.Timeout;
  #scanVersion = 0;
  #layoutVersion = 0;
  #scanning = false;
  #rescanRequested = false;
  readonly #scanWaiters: Array<() => void> = [];
  #disposed = false;
  #controlTail = "";

  constructor(options: {
    cols: number;
    rows: number;
    capabilities: TerminalCapabilities;
    scale: number;
    writeOuter: (data: string | Uint8Array) => void;
    debug?: (message: string) => void;
    renderer?: MathRenderer;
  }) {
    this.terminal = new Terminal({
      cols: options.cols,
      rows: options.rows,
      scrollback: 10_000,
      allowProposedApi: true
    });
    this.#capabilities = options.capabilities;
    this.#scale = options.scale;
    this.#renderer = options.renderer ?? new MathRenderer();
    this.#writeOuter = options.writeOuter;
    this.#debug = options.debug ?? (() => undefined);
    this.terminal.buffer.onBufferChange(() => {
      // The alternate buffer is cleared when entering or leaving it. The
      // normal buffer and its scrollback are restored, not cleared, so their
      // placements must remain tracked to avoid placing duplicates on return.
      this.#invalidateBufferPlacements("alternate", false);
    });
  }

  write(data: string): Promise<void> {
    const controls = this.#controlTail + data;
    if (/\x1bc|\x1b\[(?:[0-9;]*)3J/u.test(controls)) {
      // RIS and ED 3 clear scrollback as well as the live screen.
      this.resetPlacements();
      this.#debug("terminal reset invalidated all formula placements");
    } else if (/\x1b\[(?:[0-9;]*)2J/u.test(controls)) {
      // Kitty images are cleared by ED 2/3 and RIS independently of xterm's
      // text buffer. ED 2 only affects the live viewport; scrollback images
      // continue to be owned and scrolled by the terminal.
      this.#invalidateVisiblePlacements(false);
      this.#debug("terminal clear invalidated visible formula placements");
    }
    this.#controlTail = this.#incompleteControlSuffix(controls);
    return new Promise((resolve) => {
      this.terminal.write(data, () => {
        this.scheduleScan();
        resolve();
      });
    });
  }

  /** Complete a scan before more PTY rows are allowed to scroll the viewport. */
  async flushScan(): Promise<void> {
    while (!this.#disposed) {
      if (this.#scanTimer) clearTimeout(this.#scanTimer);
      this.#scanTimer = undefined;
      if (this.#scanning) {
        await new Promise<void>((resolve) => this.#scanWaiters.push(resolve));
      } else {
        await this.#scan();
      }
      if (!this.#scanning && !this.#scanTimer && !this.#rescanRequested) return;
    }
  }

  resize(cols: number, rows: number): void {
    this.terminal.resize(Math.max(2, cols), Math.max(2, rows));
    // Kitty placements are cell-based and resize with the terminal. Keep them
    // until the next scan selectively replaces formulas still in the live
    // viewport; off-screen scrollback cannot be reconstructed later.
    this.#layoutVersion += 1;
    // Font zoom can move a formula through the viewport in a fraction of the
    // normal debounce interval. Scan promptly; transactional replacement
    // prevents rapid resize events from destroying the previous placement.
    this.scheduleScan(16);
  }

  updateCapabilities(capabilities: TerminalCapabilities): void {
    const dimensionsChanged = capabilities.cell.width !== this.#capabilities.cell.width
      || capabilities.cell.height !== this.#capabilities.cell.height;
    const colorsChanged = capabilities.foreground !== this.#capabilities.foreground
      || capabilities.background !== this.#capabilities.background;
    this.#capabilities = capabilities;
    if (dimensionsChanged || colorsChanged) {
      this.#layoutVersion += 1;
      this.scheduleScan(16);
    }
  }

  setScale(scale: number): void {
    this.#scale = scale;
    this.#layoutVersion += 1;
    this.scheduleScan();
  }

  scheduleScan(delayMs = 110): void {
    if (this.#disposed) return;
    this.#scanVersion += 1;
    // Coalesce bursts without postponing forever. Agent status bars and
    // spinners can write more frequently than the scan delay.
    if (this.#scanTimer) return;
    this.#scanTimer = setTimeout(() => {
      this.#scanTimer = undefined;
      void this.#scan();
    }, delayMs);
  }

  resetPlacements(): void {
    this.#layoutVersion += 1;
    if (this.#capabilities.kittyGraphics) {
      const imageIds = new Set(Array.from(this.#terminalImages.values(), (image) => image.imageId));
      const commands = [
        // Range deletion also catches an image transmitted by an interrupted
        // scan before it could be entered into #placed. Older terminals can
        // ignore this command and fall back to the ID and z-index deletions.
        kittyDeleteRange(),
        ...Array.from(imageIds, (imageId) => kittyDeleteImage(imageId)),
        // Also remove any placement that an earlier interrupted scan may have
        // transmitted before it could be recorded in #placed.
        kittyDeleteByZIndex()
      ];
      this.#writeOuter(synchronizedOutput(commands.join("")));
    }
    for (const placement of this.#placed.values()) this.#releasePlacement(placement);
    this.#placed.clear();
    this.#terminalImages.clear();
  }

  #placementIsVisible(placement: PlacedFormula): boolean {
    const buffer = this.terminal.buffer.active;
    const viewportStart = buffer.viewportY;
    const viewportEnd = viewportStart + this.terminal.rows - 1;
    if (placement.startMarker || placement.endMarker) {
      const start = placement.startMarker?.line ?? placement.endMarker?.line ?? -1;
      const end = placement.endMarker?.line ?? placement.startMarker?.line ?? -1;
      return placement.bufferType === buffer.type
        && start >= 0
        && end >= viewportStart
        && start <= viewportEnd;
    }
    return placement.bufferType === buffer.type
      && placement.absoluteEndRow >= viewportStart
      && placement.absoluteStartRow <= viewportEnd;
  }

  #invalidateVisiblePlacements(deleteImages: boolean): void {
    this.#layoutVersion += 1;
    const placements: PlacedFormula[] = [];
    for (const [anchor, placement] of this.#placed) {
      if (!this.#placementIsVisible(placement)) continue;
      if (deleteImages) placements.push(placement);
      this.#releasePlacement(placement);
      this.#placed.delete(anchor);
    }
    if (placements.length > 0 && this.#capabilities.kittyGraphics) {
      this.#writeOuter(synchronizedOutput(placements.map((placement) =>
        kittyDeletePlacement(placement.imageId, placement.placementId)
      ).join("")));
    }
  }

  #invalidateBufferPlacements(bufferType: string, deleteImages: boolean): void {
    this.#layoutVersion += 1;
    const placements: PlacedFormula[] = [];
    for (const [anchor, placement] of this.#placed) {
      if (placement.bufferType !== bufferType) continue;
      if (deleteImages) placements.push(placement);
      this.#releasePlacement(placement);
      this.#placed.delete(anchor);
    }
    if (placements.length > 0 && this.#capabilities.kittyGraphics) {
      this.#writeOuter(synchronizedOutput(placements.map((placement) =>
        kittyDeletePlacement(placement.imageId, placement.placementId)
      ).join("")));
    }
  }

  #releasePlacement(placement: PlacedFormula): void {
    const image = this.#terminalImages.get(placement.imageKey);
    if (image) image.placements = Math.max(0, image.placements - 1);
    placement.startMarker?.dispose();
    if (placement.endMarker !== placement.startMarker) placement.endMarker?.dispose();
  }

  #markersForRegion(region: FormulaRegion): { startMarker?: IMarker; endMarker?: IMarker } {
    const buffer = this.terminal.buffer.active;
    if (buffer.type !== "normal") return {};
    const cursorAbsoluteRow = buffer.baseY + buffer.cursorY;
    const startAbsoluteRow = buffer.viewportY + region.startRow;
    const endAbsoluteRow = buffer.viewportY + region.endRow;
    return {
      startMarker: this.terminal.registerMarker(startAbsoluteRow - cursorAbsoluteRow),
      endMarker: this.terminal.registerMarker(endAbsoluteRow - cursorAbsoluteRow)
    };
  }

  #nextImageId(): number {
    const imageId = this.#imageId++;
    if (this.#imageId > TFORMULA_IMAGE_ID_MAX) this.#imageId = TFORMULA_IMAGE_ID_MIN;
    return imageId;
  }

  #nextPlacementId(): number {
    const placementId = this.#placementId++;
    if (this.#placementId > 2_147_483_647) this.#placementId = 1;
    return placementId;
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#scanTimer) clearTimeout(this.#scanTimer);
    this.#scanTimer = undefined;
    for (const resolve of this.#scanWaiters.splice(0)) resolve();
    this.resetPlacements();
    this.terminal.dispose();
  }

  #visibleLines(): string[] {
    const buffer = this.terminal.buffer.active;
    return Array.from({ length: this.terminal.rows }, (_, row) =>
      buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? ""
    );
  }

  #incompleteControlSuffix(data: string): string {
    const escapeIndex = data.lastIndexOf("\x1b");
    if (escapeIndex < 0) return "";
    const suffix = data.slice(escapeIndex);
    if (suffix === "\x1b") return suffix;
    if (!suffix.startsWith("\x1b[")) return "";
    // A CSI sequence is incomplete until its final byte in the 0x40-0x7e
    // range arrives. Keep only that suffix for split PTY writes.
    return /[\x40-\x7e]/u.test(suffix.slice(2)) ? "" : suffix.slice(-32);
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

  #regionStillVisible(region: FormulaRegion, viewportY: number): boolean {
    const buffer = this.terminal.buffer.active;
    if (buffer.viewportY !== viewportY) return false;
    return detectFormulaRegions(this.#visibleLines()).some((candidate) =>
      candidate.startRow === region.startRow
      && candidate.endRow === region.endRow
      && candidate.startCol === region.startCol
      && candidate.endCol === region.endCol
      && candidate.latex === region.latex
      && candidate.display === region.display
      && candidate.compact === region.compact
    );
  }

  async #scan(): Promise<void> {
    if (this.#disposed || !this.#capabilities.kittyGraphics || this.terminal.modes.originMode) return;
    if (this.#scanning) {
      this.#rescanRequested = true;
      return;
    }

    this.#scanning = true;
    const version = this.#scanVersion;
    const layoutVersion = this.#layoutVersion;
    const viewportY = this.terminal.buffer.active.viewportY;
    try {
      const regions = detectFormulaRegions(this.#visibleLines());
      const prepared = regions.map((region) => {
        const rows = region.endRow - region.startRow + 1;
        const columns = rows > 1 && !region.compact
          ? this.terminal.cols
          : Math.max(1, Math.min(this.terminal.cols - region.startCol, region.endCol - region.startCol));
        const anchor = this.#anchor(region, columns, rows);
        return { region, rows, columns, anchor };
      });
      const desiredAnchors = new Set(prepared.map(({ anchor }) => anchor));

      for (const { region, rows, columns, anchor } of prepared) {
        if (this.#disposed || layoutVersion !== this.#layoutVersion) break;
        if (version !== this.#scanVersion && !this.#regionStillVisible(region, viewportY)) continue;
        const colors = this.#regionColors(region);
        const fingerprint = createHash("sha1").update(JSON.stringify({
          latex: region.latex,
          display: region.display,
          compact: region.compact,
          colors,
          cell: this.#capabilities.cell,
          scale: this.#scale
        })).digest("hex");
        const existing = this.#placed.get(anchor);
        if (existing?.fingerprint === fingerprint) continue;

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
          if (this.#disposed || layoutVersion !== this.#layoutVersion) break;
          // Unrelated output (for example a spinner in the status bar) should
          // not starve formulas that are unchanged at their screen location.
          if (version !== this.#scanVersion && !this.#regionStillVisible(region, viewportY)) continue;

          const buffer = this.terminal.buffer.active;
          // CUP cannot reproduce xterm's pending-wrap state exactly.
          if (buffer.cursorX >= this.terminal.cols) {
            this.#rescanRequested = true;
            break;
          }
          let image = this.#terminalImages.get(rendered.cacheKey);
          let transmission = "";
          if (!image) {
            image = { imageId: this.#nextImageId(), placements: 0 };
            this.#terminalImages.set(rendered.cacheKey, image);
            transmission = kittyTransmitImage(rendered.png, image.imageId);
          }
          const placementId = this.#nextPlacementId();
          const placement = [
            existing ? kittyDeletePlacement(existing.imageId, existing.placementId) : "",
            cursorPosition(region.startRow + 1, region.startCol + 1),
            transmission,
            kittyPlaceImage(image.imageId, placementId, columns, rows),
            cursorPosition(buffer.cursorY + 1, buffer.cursorX + 1)
          ].join("");
          this.#writeOuter(synchronizedOutput(placement));
          if (existing) {
            this.#releasePlacement(existing);
            this.#placed.delete(anchor);
          }
          image.placements += 1;
          const markers = this.#markersForRegion(region);
          this.#placed.set(anchor, {
            imageId: image.imageId,
            placementId,
            imageKey: rendered.cacheKey,
            fingerprint,
            bufferType: buffer.type,
            absoluteStartRow: buffer.viewportY + region.startRow,
            absoluteEndRow: buffer.viewportY + region.endRow,
            ...markers
          });
          this.#debug(`rendered ${region.confidence} formula at ${anchor} (${rendered.widthPx}x${rendered.heightPx}px)`);
        } catch (error) {
          this.#debug(`formula render skipped: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      // Stale placement deletion is deliberately transactional as well. A
      // resize can invalidate an in-flight scan; deleting before all current
      // formulas are prepared would permanently lose an image that has just
      // moved into scrollback. Markers keep this visibility check valid after
      // normal-buffer reflow.
      if (layoutVersion === this.#layoutVersion && version === this.#scanVersion) {
        for (const [anchor, placement] of this.#placed) {
          if (desiredAnchors.has(anchor) || !this.#placementIsVisible(placement)) continue;
          this.#writeOuter(kittyDeletePlacement(placement.imageId, placement.placementId));
          this.#releasePlacement(placement);
          this.#placed.delete(anchor);
        }
      }
    } finally {
      this.#scanning = false;
      for (const resolve of this.#scanWaiters.splice(0)) resolve();
      if (!this.#disposed && (this.#rescanRequested || version !== this.#scanVersion)) {
        this.#rescanRequested = false;
        this.scheduleScan(140);
      }
    }
  }
}
