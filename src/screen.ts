import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type {
  IBufferLine,
  IMarker,
  ITerminalAddon,
  Terminal as XtermTerminal
} from "@xterm/headless";
import { MathRenderer } from "./math-renderer.js";
import {
  cursorPosition,
  kittyDeleteByZIndex,
  kittyDeleteImage,
  kittyDeletePlacement,
  kittyPlaceImage,
  kittyTransmitImage,
  synchronizedOutput,
  TFORMULA_IMAGE_ID_MAX,
  TFORMULA_IMAGE_ID_MIN
} from "./kitty.js";
import { detectScreenFormulaRegions } from "./screen-text.js";
import type { FormulaRegion, TerminalCapabilities } from "./types.js";

const { Terminal } = createRequire(import.meta.url)("@xterm/headless") as {
  Terminal: typeof XtermTerminal;
};
const { UnicodeGraphemesAddon } = createRequire(import.meta.url)(
  "@xterm/addon-unicode-graphemes"
) as {
  UnicodeGraphemesAddon: new () => ITerminalAddon;
};

interface PlacedFormula {
  anchor: string;
  imageId: number;
  placementId: number;
  imageKey: string;
  latex: string;
  sourceText: string;
  fingerprint: string;
  bufferType: string;
  absoluteStartRow: number;
  absoluteEndRow: number;
  startMarker?: IMarker;
  endMarker?: IMarker;
  /** Last known visible bounds, retained only until a resize replacement. */
  layoutHint?: { start: number; end: number };
  /** Normal-buffer trim generation at which layoutHint was captured. */
  layoutHintTrimGeneration?: number;
}

interface TerminalImage {
  imageId: number;
  placements: number;
  lastUsed: number;
}

const DEFAULT_MAX_TERMINAL_IMAGES = 256;
const DEFAULT_MAX_DETACHED_PLACEMENTS = 4_096;
const MIRROR_SCROLLBACK_ROWS = 10_000;

interface MutableXtermBufferCursor {
  x: number;
  y: number;
  ybase: number;
}

interface CursorLineReflowSnapshot {
  bufferType: string;
  /** Normal-buffer marker at the start of the wrapped logical line. */
  startMarker?: IMarker;
}

function lineTrimmedColumns(line: IBufferLine): number {
  for (let column = line.length - 1; column >= 0; column -= 1) {
    const cell = line.getCell(column);
    // A width-zero cell is the occupied second half of a wide grapheme. Null
    // cells have no characters and width one; printed spaces retain " ".
    if (cell && (cell.getChars().length > 0 || cell.getWidth() === 0)) {
      return column + 1;
    }
  }
  return 0;
}

function mutableXtermBufferCursor(
  terminal: XtermTerminal
): MutableXtermBufferCursor | undefined {
  // xterm exposes cursorX/Y as read-only. Version 6.0.0 has an upstream
  // reflowCursorLine bug that requires narrowly feature-detected access to the
  // active internal buffer; if its private shape changes, safely do nothing.
  const candidate = (terminal as unknown as {
    _core?: { _bufferService?: { buffer?: Partial<MutableXtermBufferCursor> } };
  })._core?._bufferService?.buffer;
  if (!candidate
    || typeof candidate.x !== "number"
    || typeof candidate.y !== "number"
    || typeof candidate.ybase !== "number") return undefined;
  return candidate as MutableXtermBufferCursor;
}

function rgbHex(value: number): string {
  return `#${value.toString(16).padStart(6, "0").slice(-6)}`;
}

export class FormulaScreen {
  readonly terminal: XtermTerminal;
  readonly #renderer: MathRenderer;
  readonly #transmitImage: (png: Uint8Array, imageId: number) => string;
  readonly #placed = new Map<string, PlacedFormula>();
  /**
   * Normal-buffer pins which Ghostty still owns after xterm lost both markers.
   * They deliberately have no coordinate key: xterm absolute rows recycle at
   * its scrollback cap and must never match a later, unrelated formula.
   */
  readonly #detachedPlacements = new Map<string, PlacedFormula>();
  readonly #terminalImages = new Map<string, TerminalImage>();
  readonly #allocatedImageIds = new Set<number>();
  readonly #blockedImageKeys = new Set<string>();
  readonly #imageRetries = new Map<string, { attempt: number; notBefore: number }>();
  readonly #blockedPlacementKeys = new Set<string>();
  readonly #placementRetries = new Map<string, { attempt: number; notBefore: number }>();
  readonly #writeOuter: (data: string | Uint8Array) => void;
  readonly #writeGraphics?: (
    create: () => string | Uint8Array | undefined
  ) => Promise<boolean>;
  readonly #debug: (message: string) => void;
  readonly #preserveImagesOnClear: boolean;
  readonly #maxTerminalImages: number;
  readonly #maxDetachedPlacements: number;
  #capabilities: TerminalCapabilities;
  #scale: number;
  #imageId = TFORMULA_IMAGE_ID_MIN;
  #imageUse = 0;
  #placementId = 1;
  #scanTimer?: NodeJS.Timeout;
  #scanTimerDueAt = 0;
  #scanTimerRetryOnly = false;
  #scanVersion = 0;
  #layoutVersion = 0;
  #scanning = false;
  #rescanRequested = false;
  readonly #scanWaiters: Array<() => void> = [];
  #pendingWrites = 0;
  readonly #writeWaiters: Array<() => void> = [];
  #layoutEpoch = 0;
  #layoutSuspended = false;
  readonly #layoutWaiters: Array<() => void> = [];
  #alternateLayoutDirty = false;
  #alternate47Restored = false;
  #pendingWrapHeldColumns?: number;
  #graphicsSynchronizedOutputOverride?: boolean;
  #normalTrimGeneration = 0;
  #resizing = false;
  #disposed = false;
  #controlTail = "";

  constructor(options: {
    cols: number;
    rows: number;
    capabilities: TerminalCapabilities;
    scale: number;
    writeOuter: (data: string | Uint8Array) => void;
    writeGraphics?: (
      create: () => string | Uint8Array | undefined
    ) => Promise<boolean>;
    debug?: (message: string) => void;
    renderer?: MathRenderer;
    transmitImage?: (png: Uint8Array, imageId: number) => string;
    preserveImagesOnClear?: boolean;
    maxTerminalImages?: number;
    maxDetachedPlacements?: number;
  }) {
    this.terminal = new Terminal({
      cols: options.cols,
      rows: options.rows,
      scrollback: MIRROR_SCROLLBACK_ROWS,
      allowProposedApi: true,
      // Agent responses commonly end with a formula and no trailing newline.
      // Without this xterm option, shrinking the terminal truncates the active
      // cursor line in the mirror, making a complete formula disappear from
      // detection even though Ghostty reflows it on screen.
      reflowCursorLine: true
    });
    // Match modern terminal grapheme widths (emoji, variation selectors and
    // ZWJ families). Wrong cell widths corrupt both formula anchors and the
    // cursor position restored after a Kitty placement.
    this.terminal.loadAddon(new UnicodeGraphemesAddon());
    this.#capabilities = options.capabilities;
    this.#scale = options.scale;
    this.#renderer = options.renderer ?? new MathRenderer();
    this.#transmitImage = options.transmitImage ?? kittyTransmitImage;
    this.#writeOuter = options.writeOuter;
    this.#writeGraphics = options.writeGraphics;
    this.#debug = options.debug ?? (() => undefined);
    this.#preserveImagesOnClear = options.preserveImagesOnClear ?? false;
    this.#maxTerminalImages = Math.max(
      1,
      Math.floor(options.maxTerminalImages ?? DEFAULT_MAX_TERMINAL_IMAGES)
    );
    // Detached placements outlive xterm's 10k-row mirror, so marker disposal
    // cannot bound them. Their budget is intentionally independent from image
    // count: thousands of identical formulas share one upload and should keep
    // their rendered scrollback, while unique images are bounded separately.
    this.#maxDetachedPlacements = Math.max(
      0,
      Math.floor(options.maxDetachedPlacements ?? DEFAULT_MAX_DETACHED_PLACEMENTS)
    );
    if (this.#capabilities.kittyGraphics) {
      // A previous TFormula process may have crashed before dispose(). Image
      // ids restart per process, so remove only our dedicated z-index before
      // the first upload can accidentally rebind an orphaned placement.
      this.#writeGraphicsTransaction(kittyDeleteByZIndex());
    }
    this.terminal.buffer.onBufferChange(() => {
      // Buffer-specific invalidation is driven by the actual mode sequences in
      // write(). Merely switching back to the primary screen must not discard
      // its placements: Ghostty restores that screen and its image storage.
      this.#layoutVersion += 1;
      this.#scanVersion += 1;
      if (!this.#layoutSuspended) this.scheduleScan(16);
    });
    this.terminal.onScroll(() => {
      const buffer = this.terminal.buffer.active;
      if (!this.#resizing
        && buffer.type === "normal"
        && buffer.baseY >= MIRROR_SCROLLBACK_ROWS) {
        // Once baseY saturates, xterm recycles the same absolute row numbers.
        // onScroll still fires for each real trim, giving resize hints a way to
        // prove that their old static coordinates are no longer authoritative.
        this.#normalTrimGeneration += 1;
      }
      // The alternate screen has no scrollback and xterm does not expose
      // markers there. Even though its viewportY stays zero, a bottom-margin
      // scroll changes every Kitty cell pin's row identity.
      this.#markAlternateLayoutDirty();
    });
    for (const final of ["S", "T", "L", "M"]) {
      this.terminal.parser.registerCsiHandler({ final }, () => {
        this.#markAlternateLayoutDirty();
        return false;
      });
    }
    for (const final of ["D", "E", "M"]) {
      this.terminal.parser.registerEscHandler({ final }, () => {
        this.#markAlternateLayoutDirty();
        return false;
      });
    }
  }

  queueWrite(): void {
    this.#pendingWrites += 1;
    this.#scanVersion += 1;
    this.#rescanRequested = true;
  }

  cancelQueuedWrite(): void {
    this.#completeWrite();
  }

  async write(
    data: string,
    alreadyQueued = false,
    preservedEraseDisplayOffsets: readonly number[] = []
  ): Promise<void> {
    if (!alreadyQueued) this.queueWrite();
    const initialBufferType = this.terminal.buffer.active.type;
    const controls = this.#controlTail + data;
    this.#controlTail = this.#incompleteControlSuffix(controls);
    try {
      let cursor = 0;
      const offsets = Array.from(new Set(preservedEraseDisplayOffsets))
        .filter((offset) => Number.isInteger(offset) && offset >= 0 && offset <= data.length)
        .sort((left, right) => left - right);
      for (const offset of offsets) {
        // Advance the mirror to the exact buffer and viewport in which this
        // rewritten ED 2 occurred before reconciling its image placements.
        await this.#writeTerminal(data.slice(cursor, offset));
        if (this.#preserveImagesOnClear) {
          this.#forgetVisiblePlacementsRetainingImages();
          this.#debug(`terminal text clear retained ${this.terminal.buffer.active.type} scrollback formula images`);
        }
        cursor = offset;
      }
      await this.#writeTerminal(data.slice(cursor));
      // Unrewritten ED 2/3 and screen switches still have their native Kitty
      // lifecycle. Parse them after xterm has consumed the bytes; the initial
      // buffer type keeps multiple switches in one write ordered correctly.
      this.#applyImageLifecycleControls(controls, initialBufferType);
    } finally {
      this.#completeWrite();
    }
  }

  #writeTerminal(data: string): Promise<void> {
    if (!data) return Promise.resolve();
    return new Promise((resolve) => this.terminal.write(data, resolve));
  }

  async #writeGraphicsTransaction(
    value: string | (() => string | Uint8Array | undefined)
  ): Promise<boolean> {
    const create = (): string | Uint8Array | undefined => {
      const data = typeof value === "function" ? value() : value;
      if (data === undefined) return undefined;
      // DEC synchronized output is a boolean mode, not a stack. Opening and
      // closing our own frame inside an Agent-owned frame would close theirs.
      return (this.#graphicsSynchronizedOutputOverride
        ?? this.terminal.modes.synchronizedOutputMode)
        ? data
        : synchronizedOutput(String(data));
    };
    try {
      if (this.#writeGraphics) return await this.#writeGraphics(create);
      const data = create();
      if (data === undefined) return false;
      this.#writeOuter(data);
      return true;
    } catch (error) {
      // Fire-and-forget lifecycle deletes use this same path. Never create an
      // unhandled rejection; TerminalWriter still retains and reports the
      // poisoned stdout error during proxy cleanup.
      this.#debug(`terminal graphics write failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  get originMode(): boolean {
    return this.terminal.modes.originMode;
  }

  get synchronizedOutputMode(): boolean {
    return this.terminal.modes.synchronizedOutputMode;
  }

  get pendingWrap(): boolean {
    return this.terminal.buffer.active.cursorX >= this.terminal.cols;
  }

  /**
   * Scan while the real terminal is still one ordinary cell behind the mirror.
   * Every CUP restore targets that pre-cell position; the proxy writes the held
   * character only after all graphics commands have been queued.
   */
  async flushScanBeforeHeldCell(
    heldColumns = 1,
    synchronizedOutputModeBeforeHeld?: boolean
  ): Promise<void> {
    const previousOverride = this.#graphicsSynchronizedOutputOverride;
    this.#graphicsSynchronizedOutputOverride = synchronizedOutputModeBeforeHeld;
    try {
      if (!this.pendingWrap) {
        await this.flushScan(true);
        return;
      }
      // A resize probe temporarily suspends placement while the real terminal
      // is already at its new geometry. Returning here would let the proxy
      // forward the held right-margin cell. The real terminal would then enter
      // pending wrap, a state CUP cannot restore, and every later scan would
      // defer the formula indefinitely. Keep that single cell held until the
      // newest probe resumes layout, even when resize epochs supersede it.
      while (!this.#disposed && this.#capabilities.kittyGraphics && !this.originMode) {
        if (this.#layoutSuspended) {
          await new Promise<void>((resolve) => this.#layoutWaiters.push(resolve));
          continue;
        }
        this.#pendingWrapHeldColumns = Math.max(1, Math.floor(heldColumns));
        try {
          await this.flushScan(true);
        } finally {
          this.#pendingWrapHeldColumns = undefined;
        }
        if (!this.#layoutSuspended) return;
      }
    } finally {
      this.#graphicsSynchronizedOutputOverride = previousOverride;
    }
  }

  /** True while at least one terminal-side placement must survive ED 2. */
  get hasTerminalPlacements(): boolean {
    return this.#placed.size > 0 || this.#detachedPlacements.size > 0;
  }

  #completeWrite(): void {
    if (this.#pendingWrites > 0) this.#pendingWrites -= 1;
    if (this.#pendingWrites > 0) return;
    for (const resolve of this.#writeWaiters.splice(0)) resolve();
    if (!this.#layoutSuspended) this.scheduleScan();
  }

  /** Complete a scan before more PTY rows are allowed to scroll the viewport. */
  async flushScan(allowQueuedWrites = false): Promise<void> {
    while (!this.#disposed) {
      if (!allowQueuedWrites && this.#pendingWrites > 0) {
        await new Promise<void>((resolve) => this.#writeWaiters.push(resolve));
        continue;
      }
      if (this.#layoutSuspended) {
        // Resize geometry is applied synchronously and capability probes resume
        // the layout directly from the terminal-input/timeout path. A PTY
        // checkpoint can therefore wait without depending on outputQueue. If it
        // returned, an already-buffered Agent response could scroll every
        // formula in this slice away during the short probe window.
        if (!allowQueuedWrites) return;
        await new Promise<void>((resolve) => this.#layoutWaiters.push(resolve));
        continue;
      }
      // These modes deliberately disable placement. Returning here is also
      // essential: #scan() exits early without consuming rescanRequested, so
      // looping in flushScan would otherwise starve the event loop forever.
      if (!this.#capabilities.kittyGraphics || this.terminal.modes.originMode) return;
      if (this.#scanTimer) {
        // A retry timer represents a real backoff deadline. A checkpoint must
        // not fast-forward it repeatedly and exhaust the retry budget in one
        // synchronous flush.
        if (this.#scanTimerRetryOnly) return;
        clearTimeout(this.#scanTimer);
        this.#scanTimer = undefined;
        this.#scanTimerDueAt = 0;
        this.#scanTimerRetryOnly = false;
      }
      if (this.#scanning) {
        await new Promise<void>((resolve) => this.#scanWaiters.push(resolve));
        // The scan we joined may have started before the checkpoint slice was
        // mirrored. Run one scan of our own before releasing the queue barrier.
        if (allowQueuedWrites) continue;
      } else {
        await this.#scan(allowQueuedWrites);
        // Later PTY slices are deliberately reserved before they execute so an
        // unrelated background scan cannot commit stale coordinates. At an
        // output checkpoint, however, those slices are behind this operation
        // in outputQueue. Waiting for them here is a dependency cycle; scan the
        // exact mirror state at the barrier once, then let them proceed.
        if (allowQueuedWrites) return;
      }
      if (!this.#scanning && !this.#scanTimer && !this.#rescanRequested) return;
    }
  }

  resize(cols: number, rows: number, epoch?: number, deferUntilCapabilities = false): void {
    // Reflow may dispose both xterm markers before the replacement scan can
    // match the old placement. Snapshot only currently visible placements;
    // off-screen scrollback pins must remain untouched by layout work.
    for (const placement of this.#placed.values()) {
      if (!this.#placementIsVisible(placement)) continue;
      const bounds = this.#placementBounds(placement);
      if (bounds.start >= 0 && bounds.end >= 0) {
        placement.layoutHint = bounds;
        placement.layoutHintTrimGeneration = placement.bufferType === "normal"
          ? this.#normalTrimGeneration
          : undefined;
      }
    }
    // Unlike the normal buffer, alternate-screen rows cannot be followed by
    // markers through a terminal resize. Treat their coordinates as stale.
    this.#markAlternateLayoutDirty(true);
    const nextCols = Math.max(2, cols);
    const nextRows = Math.max(2, rows);
    const cursorLineReflow = nextCols === this.terminal.cols
      ? undefined
      : this.#captureCursorLineReflow();
    this.#resizing = true;
    try {
      this.terminal.resize(nextCols, nextRows);
      if (cursorLineReflow) this.#restoreCursorLineReflow(cursorLineReflow);
    } finally {
      cursorLineReflow?.startMarker?.dispose();
      this.#resizing = false;
    }
    for (const placement of this.#placed.values()) {
      if (!placement.layoutHint) continue;
      const hasLiveMarker = [placement.startMarker, placement.endMarker].some((marker) =>
        Boolean(marker && !marker.isDisposed && marker.line >= 0)
      );
      // The hint is only needed when this synchronous reflow destroyed both
      // markers. If either survived, it is authoritative and clearing the hint
      // prevents a much later scrollback trim from reusing stale coordinates.
      if (hasLiveMarker) {
        placement.layoutHint = undefined;
        placement.layoutHintTrimGeneration = undefined;
      }
    }
    // Kitty placements are cell-based and resize with the terminal. Keep them
    // until the next scan selectively replaces formulas still in the live
    // viewport; off-screen scrollback cannot be reconstructed later.
    this.#layoutVersion += 1;
    if (epoch === undefined || epoch === this.#layoutEpoch) {
      this.#layoutSuspended = deferUntilCapabilities;
    }
    if (!this.#layoutSuspended) {
      for (const resolve of this.#layoutWaiters.splice(0)) resolve();
    }
    if (!this.#layoutSuspended) this.scheduleScan(16);
  }

  #captureCursorLineReflow(): CursorLineReflowSnapshot | undefined {
    const buffer = this.terminal.buffer.active;
    const cursorAbsoluteRow = buffer.baseY + buffer.cursorY;
    const cursorLine = buffer.getLine(cursorAbsoluteRow);
    // The xterm bug is specific to a current line that already continues a
    // wrapped logical line. Avoid touching ordinary TUI cursor positioning.
    if (!cursorLine?.isWrapped) return undefined;

    let startAbsoluteRow = cursorAbsoluteRow;
    while (startAbsoluteRow > 0
      && buffer.getLine(startAbsoluteRow)?.isWrapped) startAbsoluteRow -= 1;

    let endAbsoluteRow = cursorAbsoluteRow;
    while (endAbsoluteRow + 1 < buffer.length
      && buffer.getLine(endAbsoluteRow + 1)?.isWrapped) endAbsoluteRow += 1;
    if (endAbsoluteRow !== cursorAbsoluteRow) return undefined;

    const trimmedColumns = lineTrimmedColumns(cursorLine);
    const cursorAtContentEnd = buffer.cursorX === trimmedColumns
      || (buffer.cursorX >= this.terminal.cols
        && trimmedColumns === this.terminal.cols);
    if (!cursorAtContentEnd) return undefined;

    // xterm does not support markers in the alternate buffer. There its own
    // post-reflow y remains correct and #restoreCursorLineReflow walks from
    // that row. Normal-buffer markers survive row insertion/removal and also
    // account for scrollback movement during resize.
    const startMarker = buffer.type === "normal"
      ? this.terminal.registerMarker(startAbsoluteRow - cursorAbsoluteRow) as IMarker | undefined
      : undefined;
    return { bufferType: buffer.type, startMarker };
  }

  #restoreCursorLineReflow(snapshot: CursorLineReflowSnapshot): void {
    const buffer = this.terminal.buffer.active;
    if (buffer.type !== snapshot.bufferType) return;
    const mutableCursor = mutableXtermBufferCursor(this.terminal);
    if (!mutableCursor) return;

    let startAbsoluteRow: number;
    if (snapshot.startMarker) {
      if (snapshot.startMarker.isDisposed || snapshot.startMarker.line < 0) return;
      startAbsoluteRow = snapshot.startMarker.line;
    } else {
      // Alternate buffers cannot create markers. xterm 6.0 keeps y on the
      // reflowed logical line even when x is stale, so recover its start.
      startAbsoluteRow = mutableCursor.ybase + mutableCursor.y;
      while (startAbsoluteRow > 0
        && buffer.getLine(startAbsoluteRow)?.isWrapped) startAbsoluteRow -= 1;
    }

    let endAbsoluteRow = startAbsoluteRow;
    while (endAbsoluteRow + 1 < buffer.length
      && buffer.getLine(endAbsoluteRow + 1)?.isWrapped) endAbsoluteRow += 1;
    const endLine = buffer.getLine(endAbsoluteRow);
    if (!endLine) return;
    const targetY = endAbsoluteRow - mutableCursor.ybase;
    const targetX = lineTrimmedColumns(endLine);
    if (!Number.isInteger(targetX)
      || !Number.isInteger(targetY)
      || targetX < 0
      || targetX > this.terminal.cols
      || targetY < 0
      || targetY >= this.terminal.rows) return;

    // In xterm 6.0.0 reflowCursorLine moves/merges the cells correctly, but
    // leaves x at its old physical-row value. The next PTY fragment therefore
    // overwrites earlier LaTeX. Set x/y to the actual reflowed content end;
    // x===cols intentionally restores pending-wrap at an exact boundary.
    mutableCursor.x = targetX;
    mutableCursor.y = targetY;
  }

  /** Cancel work prepared for the old real-terminal geometry immediately. */
  invalidateLayout(): number {
    this.#layoutEpoch += 1;
    this.#layoutSuspended = true;
    this.#layoutVersion += 1;
    this.#scanVersion += 1;
    this.#rescanRequested = true;
    if (this.#scanTimer) clearTimeout(this.#scanTimer);
    this.#scanTimer = undefined;
    this.#scanTimerDueAt = 0;
    this.#scanTimerRetryOnly = false;
    return this.#layoutEpoch;
  }

  updateCapabilities(capabilities: TerminalCapabilities, resumeEpoch?: number): void {
    const graphicsChanged = capabilities.kittyGraphics !== this.#capabilities.kittyGraphics;
    const dimensionsChanged = capabilities.cell.width !== this.#capabilities.cell.width
      || capabilities.cell.height !== this.#capabilities.cell.height;
    const colorsChanged = capabilities.foreground !== this.#capabilities.foreground
      || capabilities.background !== this.#capabilities.background;
    this.#capabilities = capabilities;
    if (graphicsChanged && capabilities.kittyGraphics) {
      this.#writeGraphicsTransaction(kittyDeleteByZIndex());
    }
    if (resumeEpoch !== undefined && resumeEpoch === this.#layoutEpoch) {
      this.#layoutSuspended = false;
    }
    if (!this.#layoutSuspended) {
      for (const resolve of this.#layoutWaiters.splice(0)) resolve();
    }
    if (graphicsChanged || dimensionsChanged || colorsChanged) {
      this.#layoutVersion += 1;
    }
    if (!this.#layoutSuspended
      && (graphicsChanged || dimensionsChanged || colorsChanged || resumeEpoch !== undefined)) {
      this.scheduleScan(16);
    }
  }

  setScale(scale: number): void {
    this.#scale = scale;
    this.#layoutVersion += 1;
    this.scheduleScan();
  }

  scheduleScan(delayMs = 110, retryOnly = false): void {
    if (this.#disposed) return;
    if (!retryOnly) this.#scanVersion += 1;
    const delay = Math.max(0, delayMs);
    const dueAt = Date.now() + delay;
    // Coalesce bursts without postponing forever. Agent status bars and
    // spinners can write more frequently than the scan delay. If ordinary
    // work arrives while a retry is sleeping, retain the earlier deadline but
    // mark it flushable; conversely, never let a later retry delay new output.
    if (this.#scanTimer) {
      this.#scanTimerRetryOnly = this.#scanTimerRetryOnly && retryOnly;
      if (this.#scanTimerDueAt <= dueAt) return;
      clearTimeout(this.#scanTimer);
    }
    this.#scanTimerDueAt = dueAt;
    this.#scanTimerRetryOnly = retryOnly;
    this.#scanTimer = setTimeout(() => {
      this.#scanTimer = undefined;
      this.#scanTimerDueAt = 0;
      this.#scanTimerRetryOnly = false;
      void this.#scan();
    }, delay);
  }

  resetPlacements(): void {
    this.#layoutVersion += 1;
    if (this.#capabilities.kittyGraphics) {
      const imageIds = new Set(Array.from(this.#terminalImages.values(), (image) => image.imageId));
      const commands = [
        ...Array.from(imageIds, (imageId) => kittyDeleteImage(imageId)),
        // The dedicated z-index catches placements from interrupted scans and
        // previous crashed sessions. Avoid d=R: Ghostty 1.3.1 implements its
        // range predicate incorrectly and can delete unrelated applications'
        // Kitty images.
        kittyDeleteByZIndex()
      ];
      this.#writeGraphicsTransaction(commands.join(""));
    }
    for (const placement of this.#placed.values()) this.#releasePlacement(placement);
    for (const placement of this.#detachedPlacements.values()) {
      this.#releasePlacement(placement);
    }
    this.#placed.clear();
    this.#detachedPlacements.clear();
    this.#terminalImages.clear();
    this.#blockedImageKeys.clear();
    this.#imageRetries.clear();
    this.#blockedPlacementKeys.clear();
    this.#placementRetries.clear();
    this.#alternateLayoutDirty = false;
    this.#alternate47Restored = false;
  }

  /**
   * Forget a terminal-side image rejected or evicted by Kitty graphics.
   * MathRenderer's content cache remains intact; the next scan only reuploads
   * the already-rendered PNG and creates a fresh placement.
   */
  ownsTerminalImage(imageId: number): boolean {
    return this.#allocatedImageIds.has(imageId);
  }

  /** Confirm that the terminal, rather than only stdout, accepted an upload. */
  markTerminalImageAccepted(imageId: number): boolean {
    const keys = Array.from(this.#terminalImages.entries())
      .filter(([, image]) => image.imageId === imageId)
      .map(([key]) => key);
    for (const key of keys) {
      this.#imageRetries.delete(key);
      this.#blockedImageKeys.delete(key);
    }
    return keys.length > 0;
  }

  /** Confirm one placement before forgetting its consecutive-error history. */
  markTerminalPlacementAccepted(imageId: number, placementId: number): boolean {
    const placement = Array.from(this.#placed.values()).find((candidate) =>
      candidate.imageId === imageId && candidate.placementId === placementId
    ) ?? this.#findDetachedPlacement(imageId, placementId);
    if (!placement) return false;
    const key = `${placement.anchor}|${placement.fingerprint}`;
    this.#placementRetries.delete(key);
    this.#blockedPlacementKeys.delete(key);
    return true;
  }

  #detachedPlacementKey(placement: PlacedFormula): string {
    return `${placement.imageId}:${placement.placementId}`;
  }

  #findDetachedPlacement(imageId: number, placementId: number): PlacedFormula | undefined {
    const placement = this.#detachedPlacements.get(`${imageId}:${placementId}`);
    return placement?.imageId === imageId && placement.placementId === placementId
      ? placement
      : undefined;
  }

  #detachPlacement(anchor: string, placement: PlacedFormula): void {
    this.#placed.delete(anchor);
    placement.layoutHint = undefined;
    placement.layoutHintTrimGeneration = undefined;
    this.#placementRetries.delete(`${anchor}|${placement.fingerprint}`);
    this.#blockedPlacementKeys.delete(`${anchor}|${placement.fingerprint}`);
    this.#detachedPlacements.set(this.#detachedPlacementKey(placement), placement);
    this.#pruneDetachedPlacements(this.#maxDetachedPlacements, false, true);
  }

  #deleteDetachedPlacement(placement: PlacedFormula): void {
    this.#detachedPlacements.delete(this.#detachedPlacementKey(placement));
    this.#releasePlacement(placement);
  }

  invalidateTerminalImage(
    imageId: number,
    reason = "terminal graphics error",
    retry = true
  ): boolean {
    const resourcePressure = /\b(?:ENOSPC|ENOMEM)\b/iu.test(reason);
    const shouldRetry = retry || resourcePressure;
    const affected = Array.from(this.#placed.entries())
      .filter(([, placement]) => placement.imageId === imageId);
    const detachedAffected = Array.from(this.#detachedPlacements.values())
      .filter((placement) => placement.imageId === imageId);
    const imageKeys = Array.from(this.#terminalImages.entries())
      .filter(([, image]) => image.imageId === imageId)
      .map(([key]) => key);
    if (affected.length === 0 && detachedAffected.length === 0 && imageKeys.length === 0) {
      return false;
    }

    if (this.#capabilities.kittyGraphics) this.#writeOuter(kittyDeleteImage(imageId));

    for (const [anchor, placement] of affected) {
      this.#releasePlacement(placement);
      this.#placed.delete(anchor);
    }
    for (const placement of detachedAffected) this.#deleteDetachedPlacement(placement);
    for (const key of imageKeys) this.#terminalImages.delete(key);
    // A terminal quota error can be transient. The oldest markerless pin is
    // the least useful terminal allocation we still own, so release one before
    // deleting idle uploads. Repeated bounded retries progressively free more
    // historical pins instead of sacrificing a currently visible formula.
    if (resourcePressure) {
      const released = this.#pruneDetachedPlacements(
        Math.max(0, this.#detachedPlacements.size - 1),
        true
      );
      if (released === 0) this.#evictIdleTerminalImages(true);
    }
    let retryDelay = 0;
    let willRetry = false;
    for (const key of imageKeys) {
      if (!shouldRetry) {
        this.#blockedImageKeys.add(key);
        continue;
      }
      const attempt = (this.#imageRetries.get(key)?.attempt ?? 0) + 1;
      if (attempt > 5) {
        this.#blockedImageKeys.add(key);
        this.#imageRetries.delete(key);
        this.#debug(`terminal image ${imageId} exceeded the graphics retry limit`);
        continue;
      }
      retryDelay = Math.max(retryDelay, Math.min(2_000, 50 * (2 ** (attempt - 1))));
      this.#imageRetries.set(key, { attempt, notBefore: Date.now() + retryDelay });
      willRetry = true;
    }
    this.#layoutVersion += 1;
    this.#debug(`${reason}; invalidated terminal image ${imageId}`);
    if (willRetry) this.scheduleScan(retryDelay || 50, true);
    return true;
  }

  /** Retry one rejected placement without invalidating its shared image. */
  invalidateTerminalPlacement(
    imageId: number,
    placementId: number,
    reason = "terminal graphics placement error",
    retry = true
  ): boolean {
    const affected = Array.from(this.#placed.entries()).find(([, placement]) =>
      placement.imageId === imageId && placement.placementId === placementId
    );
    if (!affected) {
      const detached = this.#findDetachedPlacement(imageId, placementId);
      if (!detached) return false;
      if (this.#capabilities.kittyGraphics) {
        this.#writeOuter(kittyDeletePlacement(imageId, placementId));
      }
      // Once the mirror has lost both markers there is no safe CUP coordinate
      // at which to retry this one placement. Keep the shared rendered/image
      // caches, but stop tracking the rejected pin.
      this.#deleteDetachedPlacement(detached);
      this.#layoutVersion += 1;
      this.#debug(`${reason}; dropped detached terminal placement ${placementId}`);
      this.#evictIdleTerminalImages();
      return true;
    }
    const [anchor, placement] = affected;
    if (this.#capabilities.kittyGraphics) {
      this.#writeOuter(kittyDeletePlacement(imageId, placementId));
    }
    this.#releasePlacement(placement, true);
    this.#placed.delete(anchor);

    const key = `${anchor}|${placement.fingerprint}`;
    let retryDelay = 0;
    if (!retry) {
      this.#blockedPlacementKeys.add(key);
    } else {
      const attempt = (this.#placementRetries.get(key)?.attempt ?? 0) + 1;
      if (attempt > 5) {
        this.#blockedPlacementKeys.add(key);
        this.#placementRetries.delete(key);
        this.#debug(`terminal placement ${placementId} exceeded the graphics retry limit`);
      } else {
        retryDelay = Math.min(2_000, 50 * (2 ** (attempt - 1)));
        this.#placementRetries.set(key, {
          attempt,
          notBefore: Date.now() + retryDelay
        });
      }
    }
    this.#layoutVersion += 1;
    this.#debug(`${reason}; invalidated terminal placement ${placementId}`);
    this.#evictIdleTerminalImages();
    if (retryDelay > 0) this.scheduleScan(retryDelay, true);
    return true;
  }

  #forgetAllPlacements(): void {
    this.#layoutVersion += 1;
    for (const placement of this.#placed.values()) this.#releasePlacement(placement);
    for (const placement of this.#detachedPlacements.values()) {
      this.#releasePlacement(placement);
    }
    this.#placed.clear();
    this.#detachedPlacements.clear();
    this.#terminalImages.clear();
    this.#blockedImageKeys.clear();
    this.#imageRetries.clear();
    this.#blockedPlacementKeys.clear();
    this.#placementRetries.clear();
    this.#alternateLayoutDirty = false;
    this.#alternate47Restored = false;
  }

  #forgetBufferState(bufferType: string): void {
    this.#layoutVersion += 1;
    for (const [anchor, placement] of this.#placed) {
      if (placement.bufferType !== bufferType) continue;
      this.#releasePlacement(placement);
      this.#placed.delete(anchor);
    }
    for (const placement of Array.from(this.#detachedPlacements.values())) {
      if (placement.bufferType !== bufferType) continue;
      this.#deleteDetachedPlacement(placement);
    }
    const prefix = `${bufferType}:`;
    for (const key of this.#terminalImages.keys()) {
      if (key.startsWith(prefix)) this.#terminalImages.delete(key);
    }
    for (const key of this.#imageRetries.keys()) {
      if (key.startsWith(prefix)) this.#imageRetries.delete(key);
    }
    for (const key of this.#blockedImageKeys) {
      if (key.startsWith(prefix)) this.#blockedImageKeys.delete(key);
    }
    for (const key of this.#placementRetries.keys()) {
      if (key.startsWith(prefix)) this.#placementRetries.delete(key);
    }
    for (const key of this.#blockedPlacementKeys) {
      if (key.startsWith(prefix)) this.#blockedPlacementKeys.delete(key);
    }
    if (bufferType === "alternate") {
      this.#alternateLayoutDirty = false;
      this.#alternate47Restored = false;
    }
  }

  #markAlternateLayoutDirty(force = false): void {
    if ((!force && this.terminal.buffer.active.type !== "alternate")
      || !Array.from(this.#placed.values()).some((placement) =>
        placement.bufferType === "alternate"
      )) return;
    this.#alternateLayoutDirty = true;
    this.#layoutVersion += 1;
    this.#scanVersion += 1;
    this.#rescanRequested = true;
  }

  #invalidateDirtyAlternatePlacements(): void {
    const commands: string[] = [];
    for (const [anchor, placement] of this.#placed) {
      if (placement.bufferType !== "alternate") continue;
      commands.push(kittyDeletePlacement(placement.imageId, placement.placementId));
      this.#releasePlacement(placement);
      this.#placed.delete(anchor);
    }
    for (const key of this.#placementRetries.keys()) {
      if (key.startsWith("alternate:")) this.#placementRetries.delete(key);
    }
    for (const key of this.#blockedPlacementKeys) {
      if (key.startsWith("alternate:")) this.#blockedPlacementKeys.delete(key);
    }
    this.#alternateLayoutDirty = false;
    this.#layoutVersion += 1;
    if (commands.length > 0) this.#writeGraphicsTransaction(commands.join(""));
    this.#evictIdleTerminalImages();
  }

  #forgetVisiblePlacementsRetainingImages(): void {
    this.#layoutVersion += 1;
    const commands: string[] = [];
    for (const [anchor, placement] of this.#placed) {
      // A clear must remove every placement intersecting the viewport. Keeping
      // a partially visible placement would leave its visible rows floating
      // over the newly cleared text. Fully off-screen pins remain intact.
      if (!this.#placementIsVisible(placement)) continue;
      commands.push(kittyDeletePlacement(placement.imageId, placement.placementId));
      this.#releasePlacement(placement);
      this.#placed.delete(anchor);
    }
    if (commands.length > 0) this.#writeGraphicsTransaction(commands.join(""));
    this.#evictIdleTerminalImages();
  }

  #applyImageLifecycleControls(data: string, initialBufferType: string): void {
    let bufferType = initialBufferType;
    const controls = /\x1bc|(?:\x1b\[|\u009b)\?([0-9;]+)([hl])|(?:\x1b\[|\u009b)([0-9;]*)J/gu;
    for (const match of data.matchAll(controls)) {
      const sequence = match[0];
      if (sequence === "\x1bc") {
        // RIS resets terminal graphics state, not just the active viewport.
        this.#forgetAllPlacements();
        this.#debug("terminal reset forgot all formula images");
        bufferType = "normal";
        continue;
      }

      if (match[1] !== undefined && match[2] !== undefined) {
        const modes = match[1].split(";");
        const enabled = match[2] === "h";
        if (enabled && modes.includes("6")) {
          // CUP coordinates are relative to the scrolling margins in DECOM.
          // Remove visible overlays without moving the cursor; once DECOM is
          // disabled, the ordinary scan can place them again safely.
          this.#forgetVisiblePlacementsRetainingImages();
          this.#debug("origin mode deferred formula placement");
        }
        const alternateMode = modes.includes("1049")
          ? "1049"
          : modes.includes("1047")
            ? "1047"
            : modes.includes("47")
              ? "47"
              : undefined;
        if (!alternateMode) continue;
        if (alternateMode === "47"
          && enabled
          && Array.from(this.#placed.values()).some((placement) =>
            placement.bufferType === "alternate"
          )) {
          // Ghostty preserves mode-47 alternate text and Kitty storage, while
          // xterm-headless starts with an empty mirror on re-entry. Until a
          // real clear realigns them, never delete retained pins merely because
          // they are absent from that empty mirror.
          this.#alternate47Restored = true;
        }
        // DECSET 1049 clears the alternate screen on entry; DECSET 1047
        // clears it on exit. Ghostty stores Kitty images per screen.
        if ((alternateMode === "1049" && enabled)
          || (alternateMode === "1047" && !enabled)) {
          this.#forgetBufferState("alternate");
          this.#debug("alternate-screen clear forgot alternate formula images");
        }
        bufferType = enabled ? "alternate" : "normal";
        continue;
      }

      const eraseMode = Number((match[3] ?? "0").split(";")[0] || "0");
      if (eraseMode !== 2 && eraseMode !== 3) continue;
      // Ghostty's ED 2 and ED 3 implementation deletes all Kitty image data
      // for the active screen. Keeping image IDs here creates zombie cache
      // entries whose later a=p commands fail with ENOENT.
      this.#forgetBufferState(bufferType);
      this.#debug(`terminal clear forgot ${bufferType} formula images`);
    }
  }

  #placementIsVisible(placement: PlacedFormula): boolean {
    const buffer = this.terminal.buffer.active;
    const viewportStart = buffer.viewportY;
    const viewportEnd = viewportStart + this.terminal.rows - 1;
    const { start, end } = this.#placementBounds(placement);
    return placement.bufferType === buffer.type
      && start >= 0
      && end >= viewportStart
      && start <= viewportEnd;
  }

  #placementBounds(placement: PlacedFormula): { start: number; end: number } {
    const markerLine = (marker: IMarker | undefined): number | undefined =>
      marker && !marker.isDisposed && marker.line >= 0 ? marker.line : undefined;
    const startMarker = markerLine(placement.startMarker);
    const endMarker = markerLine(placement.endMarker);
    if (startMarker !== undefined && endMarker !== undefined) {
      return { start: startMarker, end: endMarker };
    }

    // xterm reflow can dispose only the marker on a wrapped continuation row.
    // Infer that missing edge from the last committed row span so the next
    // layout scan can still pair and transactionally replace the old image.
    const span = Math.max(0, placement.absoluteEndRow - placement.absoluteStartRow);
    if (startMarker !== undefined) return { start: startMarker, end: startMarker + span };
    if (endMarker !== undefined) return { start: Math.max(0, endMarker - span), end: endMarker };
    if (placement.layoutHint) return placement.layoutHint;

    // Alternate-screen placements have no xterm markers and use fixed rows.
    // Marker-backed placements whose two markers are gone have left xterm's
    // retained scrollback and must not masquerade as live absolute rows.
    if (placement.startMarker || placement.endMarker) return { start: -1, end: -1 };
    return { start: placement.absoluteStartRow, end: placement.absoluteEndRow };
  }

  #detachExpiredMarkerPlacements(): void {
    let detached = 0;
    for (const [anchor, placement] of Array.from(this.#placed.entries())) {
      if (!placement.startMarker && !placement.endMarker) continue;
      const hasLiveMarker = [placement.startMarker, placement.endMarker].some((marker) =>
        Boolean(marker && !marker.isDisposed && marker.line >= 0)
      );
      if (hasLiveMarker) continue;
      // A visible placement receives this hint immediately before resize. If
      // that same reflow destroys both markers, keep it coordinate-indexed for
      // the imminent scan so the replacement and old-pin deletion are emitted
      // atomically. Off-screen/trimmed placements have no such hint and detach.
      if (placement.layoutHint
        && placement.layoutHintTrimGeneration === this.#normalTrimGeneration) continue;

      // xterm disposes markers on soft-wrapped continuation rows when a wider
      // resize merges those rows.  It also trims at our 10k-line mirror limit,
      // which can be earlier than Ghostty's byte-based scrollback limit.  In
      // both cases Ghostty still owns and reflows the off-screen Kitty pin. A
      // delete here makes the formula raw when the user scrolls back locally,
      // and that local scroll is invisible to the PTY proxy.  Keep the pin and
      // rendered-image reference until an explicit terminal clear/reset forgets
      // it, an image error proves it was evicted, or process teardown clears our
      // z-index. Move it out of the coordinate-indexed collection entirely:
      // xterm recycles absolute row/anchor values at its scrollback cap, while
      // Ghostty's older pin still belongs to a different historical row.
      this.#detachPlacement(anchor, placement);
      detached += 1;
    }
    if (detached > 0) {
      this.#debug(`retained ${detached} markerless scrollback formula placement(s)`);
    }
  }

  #placementIsPartiallyVisible(placement: PlacedFormula): boolean {
    const buffer = this.terminal.buffer.active;
    if (placement.bufferType !== buffer.type) return false;
    const { start, end } = this.#placementBounds(placement);
    if (start < 0 || end < 0) return false;
    const viewportStart = buffer.viewportY;
    const viewportEnd = viewportStart + this.terminal.rows - 1;
    return (start < viewportStart && end >= viewportStart)
      || (start <= viewportEnd && end > viewportEnd);
  }

  #partialPlacementSourceStillVisible(placement: PlacedFormula): boolean {
    if (!this.#placementIsPartiallyVisible(placement)) return false;
    const buffer = this.terminal.buffer.active;
    const { start, end } = this.#placementBounds(placement);
    const viewportStart = buffer.viewportY;
    const viewportEnd = viewportStart + this.terminal.rows - 1;
    const first = Math.max(start, viewportStart);
    const last = Math.min(end, viewportEnd);
    const normalize = (value: string): string => value.replace(/\s+/gu, "");
    const source = normalize(placement.sourceText);
    for (let row = first; row <= last; row += 1) {
      const visible = normalize(buffer.getLine(row)?.translateToString(true) ?? "");
      if (visible && source.includes(visible)) return true;
    }
    return false;
  }

  #releasePlacement(placement: PlacedFormula, preservePlacementRetry = false): void {
    const image = this.#terminalImages.get(placement.imageKey);
    if (image) {
      image.placements = Math.max(0, image.placements - 1);
      image.lastUsed = ++this.#imageUse;
    }
    if (!preservePlacementRetry) {
      const retryKey = `${placement.anchor}|${placement.fingerprint}`;
      this.#placementRetries.delete(retryKey);
      this.#blockedPlacementKeys.delete(retryKey);
    }
    placement.startMarker?.dispose();
    if (placement.endMarker !== placement.startMarker) placement.endMarker?.dispose();
  }

  #takeIdleTerminalImageEvictions(force = false): string[] {
    const excess = force
      ? this.#terminalImages.size
      : this.#terminalImages.size - this.#maxTerminalImages;
    if (excess <= 0) return [];
    const idle = Array.from(this.#terminalImages.entries())
      .filter(([, image]) => image.placements === 0)
      .sort((left, right) => left[1].lastUsed - right[1].lastUsed)
      .slice(0, excess);
    if (idle.length === 0) return [];
    const commands: string[] = [];
    for (const [key, image] of idle) {
      commands.push(kittyDeleteImage(image.imageId));
      this.#terminalImages.delete(key);
      this.#imageRetries.delete(key);
      this.#blockedImageKeys.delete(key);
    }
    return commands;
  }

  #evictIdleTerminalImages(force = false): void {
    const commands = this.#takeIdleTerminalImageEvictions(force);
    if (commands.length === 0) return;
    this.#writeGraphicsTransaction(commands.join(""));
    this.#debug(`evicted ${commands.length} idle terminal image(s); rendered PNG cache retained`);
  }

  #pruneDetachedPlacements(
    targetSize: number,
    forceIdleImages = false,
    enforceImageBudget = false
  ): number {
    if (this.#detachedPlacements.size <= targetSize
      && (!enforceImageBudget || this.#terminalImages.size <= this.#maxTerminalImages)) return 0;

    // Map insertion order is detach order. Delete the oldest Ghostty pins one
    // at a time, decrementing shared image references exactly once. Under the
    // image budget, 4096 copies of one formula remain because they still use a
    // single upload; unique historical formulas shed their oldest pin until an
    // upload becomes idle and the configured image bound is restored.
    const commands: string[] = [];
    let removed = 0;
    let removedImages = 0;
    while (this.#detachedPlacements.size > targetSize
      || (enforceImageBudget && this.#terminalImages.size > this.#maxTerminalImages)) {
      const placement = this.#detachedPlacements.values().next().value as
        | PlacedFormula
        | undefined;
      if (!placement) break;
      commands.push(kittyDeletePlacement(placement.imageId, placement.placementId));
      this.#deleteDetachedPlacement(placement);
      removed += 1;
      const imageDeletes = this.#takeIdleTerminalImageEvictions(false);
      removedImages += imageDeletes.length;
      commands.push(...imageDeletes);
    }
    // Keep placement and upload deletion in one ordered transaction. In the
    // shared-image case this returns no image delete until its last placement
    // reference is gone.
    const imageDeletes = this.#takeIdleTerminalImageEvictions(forceIdleImages);
    removedImages += imageDeletes.length;
    commands.push(...imageDeletes);
    if (this.#capabilities.kittyGraphics) this.#writeGraphicsTransaction(commands.join(""));
    this.#debug(
      `evicted ${removed} oldest detached formula placement(s)`
      + (removedImages > 0 ? ` and ${removedImages} idle terminal image(s)` : "")
    );
    return removed;
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
    this.#allocatedImageIds.add(imageId);
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
    this.#scanTimerDueAt = 0;
    this.#scanTimerRetryOnly = false;
    for (const resolve of this.#scanWaiters.splice(0)) resolve();
    for (const resolve of this.#writeWaiters.splice(0)) resolve();
    for (const resolve of this.#layoutWaiters.splice(0)) resolve();
    this.resetPlacements();
    this.terminal.dispose();
  }

  #formulaSnapshot(): ReturnType<typeof detectScreenFormulaRegions> {
    const buffer = this.terminal.buffer.active;
    const physicalLines = Array.from({ length: this.terminal.rows }, (_, row) => {
      const line = buffer.getLine(buffer.viewportY + row);
      return {
        row,
        text: line?.translateToString(true) ?? "",
        isWrapped: line?.isWrapped ?? false
      };
    });
    const nextLine = buffer.getLine(buffer.viewportY + this.terminal.rows);
    return detectScreenFormulaRegions(
      physicalLines,
      this.terminal.cols,
      nextLine?.isWrapped ?? false
    );
  }

  #incompleteControlSuffix(data: string): string {
    const escapeIndex = data.lastIndexOf("\x1b");
    const c1Index = data.lastIndexOf("\u009b");
    const controlIndex = Math.max(escapeIndex, c1Index);
    if (controlIndex < 0) return "";
    const suffix = data.slice(controlIndex);
    if (controlIndex === c1Index) {
      return /[\x40-\x7e]/u.test(suffix.slice(1)) ? "" : suffix.slice(-32);
    }
    if (suffix === "\x1b") return suffix;
    if (!suffix.startsWith("\x1b[")) return "";
    // A CSI sequence is incomplete until its final byte in the 0x40-0x7e
    // range arrives. Keep only that suffix for split PTY writes.
    return /[\x40-\x7e]/u.test(suffix.slice(2)) ? "" : suffix.slice(-32);
  }

  #regionColors(region: FormulaRegion): { foreground: string; background: string } {
    const buffer = this.terminal.buffer.active;
    const line = buffer.getLine(buffer.viewportY + region.startRow);
    const colorColumn = region.wrapSegments?.[0]?.startCol ?? region.startCol;
    const cell = line?.getCell(Math.min(colorColumn, this.terminal.cols - 1));
    if (!cell) return this.#capabilities;

    let foreground = cell.isFgRGB() ? rgbHex(cell.getFgColor()) : this.#capabilities.foreground;
    let background = cell.isBgRGB() ? rgbHex(cell.getBgColor()) : this.#capabilities.background;
    if (cell.isInverse()) [foreground, background] = [background, foreground];
    return { foreground, background };
  }

  #regionSourceText(region: FormulaRegion): string {
    const buffer = this.terminal.buffer.active;
    return Array.from(
      { length: region.endRow - region.startRow + 1 },
      (_, offset) => buffer.getLine(buffer.viewportY + region.startRow + offset)
        ?.translateToString(true) ?? ""
    ).join("\n");
  }

  #anchor(
    region: FormulaRegion,
    columns: number,
    rows: number,
    bufferType: string,
    viewportY: number
  ): string {
    return `${bufferType}:${viewportY + region.startRow}:${region.startCol}:${columns}:${rows}`;
  }

  #regionStillVisible(region: FormulaRegion, viewportY: number, bufferType: string): boolean {
    const buffer = this.terminal.buffer.active;
    if (buffer.viewportY !== viewportY || buffer.type !== bufferType) return false;
    return this.#formulaSnapshot().regions.some((candidate) =>
      candidate.startRow === region.startRow
      && candidate.endRow === region.endRow
      && candidate.startCol === region.startCol
      && candidate.endCol === region.endCol
      && candidate.latex === region.latex
      && candidate.display === region.display
      && candidate.compact === region.compact
      && JSON.stringify(candidate.displayRange) === JSON.stringify(region.displayRange)
      && candidate.composite === region.composite
      && JSON.stringify(candidate.wrapSegments) === JSON.stringify(region.wrapSegments)
    );
  }

  #replacementForRegion(
    anchor: string,
    region: FormulaRegion,
    bufferType: string,
    viewportY: number,
    claimedAnchors: ReadonlySet<string>
  ): { anchor: string; placement: PlacedFormula } | undefined {
    const exact = claimedAnchors.has(anchor) ? undefined : this.#placed.get(anchor);
    if (exact) return { anchor, placement: exact };
    const start = viewportY + region.startRow;
    const end = viewportY + region.endRow;
    for (const [oldAnchor, placement] of this.#placed) {
      if (claimedAnchors.has(oldAnchor)) continue;
      if (placement.bufferType !== bufferType || placement.latex !== region.latex) continue;
      const bounds = this.#placementBounds(placement);
      if (bounds.start < 0 || bounds.end < 0) continue;
      if (bounds.start <= end && bounds.end >= start) {
        return { anchor: oldAnchor, placement };
      }
    }
    // Widening can merge the wrapped continuation row containing a visible
    // inline formula into a non-overlapping row and dispose both markers. The
    // pre-resize layout hint still identifies a valid replacement candidate;
    // choose the nearest unclaimed one so repeated identical formulas pair in
    // visual order instead of leaving duplicate Ghostty pins behind.
    const candidates = Array.from(this.#placed.entries())
      .filter(([oldAnchor, placement]) => !claimedAnchors.has(oldAnchor)
        && placement.bufferType === bufferType
        && placement.latex === region.latex
        && placement.layoutHint
        && ![placement.startMarker, placement.endMarker].some((marker) =>
          Boolean(marker && !marker.isDisposed && marker.line >= 0)
        ))
      .sort((left, right) => {
        const leftDistance = Math.abs(left[1].layoutHint!.start - start);
        const rightDistance = Math.abs(right[1].layoutHint!.start - start);
        return leftDistance - rightDistance;
      });
    if (candidates[0]) return { anchor: candidates[0][0], placement: candidates[0][1] };
    return undefined;
  }

  #placementExactlyTracksRegion(
    placement: PlacedFormula,
    region: FormulaRegion,
    bufferType: string,
    viewportY: number
  ): boolean {
    if (placement.bufferType !== bufferType || placement.latex !== region.latex) return false;
    // Normal-buffer absolute row numbers are reused after xterm reaches its
    // scrollback limit. Once both markers have expired, layoutHint is only a
    // resize fallback; it is not proof that an old placement belongs to new
    // text which later occupies the same absolute row and anchor.
    if (bufferType === "normal") {
      const hasLiveMarker = [placement.startMarker, placement.endMarker].some((marker) =>
        Boolean(marker && !marker.isDisposed && marker.line >= 0)
      );
      if (!hasLiveMarker) return false;
    }
    const bounds = this.#placementBounds(placement);
    return bounds.start === viewportY + region.startRow
      && bounds.end === viewportY + region.endRow;
  }

  async #scan(allowQueuedWrites = false): Promise<void> {
    if (this.#disposed || !this.#capabilities.kittyGraphics || this.terminal.modes.originMode) return;
    if ((!allowQueuedWrites && this.#pendingWrites > 0) || this.#layoutSuspended) {
      this.#rescanRequested = true;
      return;
    }
    if (this.#scanning) {
      this.#rescanRequested = true;
      return;
    }

    this.#scanning = true;
    this.#rescanRequested = false;
    if (this.terminal.buffer.active.type === "alternate" && this.#alternateLayoutDirty) {
      if (this.#alternate47Restored) {
        // Ghostty itself tracks the retained placement pins through scrolling;
        // the xterm mirror does not contain the retained rows to reconstruct.
        this.#alternateLayoutDirty = false;
      } else {
        this.#invalidateDirtyAlternatePlacements();
      }
    }
    const version = this.#scanVersion;
    const layoutVersion = this.#layoutVersion;
    const activeBuffer = this.terminal.buffer.active;
    const viewportY = activeBuffer.viewportY;
    const bufferType = activeBuffer.type;
    let retryDelay: number | undefined;
    try {
      this.#detachExpiredMarkerPlacements();
      const snapshot = this.#formulaSnapshot();
      const regions = snapshot.regions;
      const prepared = regions.map((region) => {
        const rows = region.endRow - region.startRow + 1;
        const columns = rows > 1 && !region.compact
          ? this.terminal.cols
          : Math.max(1, Math.min(this.terminal.cols - region.startCol, region.endCol - region.startCol));
        const anchor = this.#anchor(region, columns, rows, bufferType, viewportY);
        return { region, rows, columns, anchor };
      });
      const desiredAnchors = new Set(prepared.map(({ anchor }) => anchor));
      // A resize can move the same formula to a new anchor. Keep its last
      // successfully committed placement until the replacement is actually
      // emitted; render errors and graphics retry backoff must not create a
      // raw-text gap in between.
      const retainedReplacementAnchors = new Set<string>();
      const claimedReplacementAnchors = new Set<string>();

      for (const { region, rows, columns, anchor } of prepared) {
        if (this.#disposed
          || (!allowQueuedWrites && this.#pendingWrites > 0)
          || this.#layoutSuspended
          || layoutVersion !== this.#layoutVersion
          || this.terminal.buffer.active.type !== bufferType) break;
        if (version !== this.#scanVersion
          && !this.#regionStillVisible(region, viewportY, bufferType)) continue;
        const colors = this.#regionColors(region);
        const fingerprint = createHash("sha1").update(JSON.stringify({
          latex: region.latex,
          display: region.display,
          compact: region.compact,
          displayRange: region.displayRange,
          composite: region.composite,
          wrapSegments: region.wrapSegments,
          colors,
          cell: this.#capabilities.cell,
          scale: this.#scale
        })).digest("hex");
        let replacement = this.#replacementForRegion(
          anchor,
          region,
          bufferType,
          viewportY,
          claimedReplacementAnchors
        );
        let existing = replacement?.placement;
        if (replacement?.anchor === anchor
          && existing
          && (existing.bufferType !== bufferType || existing.latex !== region.latex)) {
          // An anchor identifies terminal coordinates, not content. A TUI can
          // overwrite those cells with a different formula, and absolute row
          // numbers are also recycled at the scrollback cap. Do not leave the
          // old, semantically wrong image covering the new source while its
          // render is pending or failing.
          this.#writeGraphicsTransaction(
            kittyDeletePlacement(existing.imageId, existing.placementId)
          );
          this.#releasePlacement(existing);
          this.#placed.delete(replacement.anchor);
          replacement = undefined;
          existing = undefined;
        }
        if (replacement) {
          claimedReplacementAnchors.add(replacement.anchor);
          retainedReplacementAnchors.add(replacement.anchor);
        }
        if (replacement?.anchor === anchor
          && existing?.fingerprint === fingerprint
          && this.#placementExactlyTracksRegion(existing, region, bufferType, viewportY)) {
          // Live markers are now authoritative at the current geometry. Do not
          // let an old resize fallback survive until those markers eventually
          // expire at the scrollback cap and make an evicted row look live.
          existing.layoutHint = undefined;
          existing.layoutHintTrimGeneration = undefined;
          continue;
        }
        const placementRetryKey = `${anchor}|${fingerprint}`;
        if (this.#blockedPlacementKeys.has(placementRetryKey)) continue;
        const placementRetry = this.#placementRetries.get(placementRetryKey);
        if (placementRetry && placementRetry.notBefore > Date.now()) {
          const remaining = placementRetry.notBefore - Date.now();
          retryDelay = Math.min(retryDelay ?? remaining, remaining);
          continue;
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
          if (this.#disposed
            || (!allowQueuedWrites && this.#pendingWrites > 0)
            || this.#layoutSuspended
            || layoutVersion !== this.#layoutVersion
            || this.terminal.buffer.active.type !== bufferType) break;
          if (this.terminal.modes.originMode) {
            // Origin mode may have changed while MathJax was awaited even if
            // the formula stayed visible. Synchronized output is safe here:
            // #writeGraphicsTransaction appends commands to the Agent frame
            // without closing it.
            this.#rescanRequested = true;
            break;
          }
          // Unrelated output (for example a spinner in the status bar) should
          // not starve formulas that are unchanged at their screen location.
          if (version !== this.#scanVersion
            && !this.#regionStillVisible(region, viewportY, bufferType)) continue;

          const buffer = this.terminal.buffer.active;
          // CUP cannot reproduce xterm's pending-wrap state exactly.
          if (buffer.cursorX >= this.terminal.cols
            && this.#pendingWrapHeldColumns === undefined) {
            this.#debug("formula placement deferred while cursor is in pending-wrap state");
            break;
          }
          const terminalImageKey = `${buffer.type}:${rendered.cacheKey}`;
          if (this.#blockedImageKeys.has(terminalImageKey)) continue;
          const retry = this.#imageRetries.get(terminalImageKey);
          if (retry && retry.notBefore > Date.now()) {
            const remaining = retry.notBefore - Date.now();
            retryDelay = Math.min(retryDelay ?? remaining, remaining);
            continue;
          }
          let image = this.#terminalImages.get(terminalImageKey);
          let transmission = "";
          let createdImage = false;
          if (!image) {
            image = {
              imageId: this.#nextImageId(),
              placements: 0,
              lastUsed: ++this.#imageUse
            };
            transmission = this.#transmitImage(rendered.png, image.imageId);
            this.#terminalImages.set(terminalImageKey, image);
            createdImage = true;
          }
          // Image upload is cursor-neutral.  Drain it separately so a resize
          // during a large direct-PNG transfer cannot leave an old CUP/place/
          // cursor-restore sequence waiting behind the upload.
          if (transmission) {
            try {
              const uploaded = await this.#writeGraphicsTransaction(() =>
                this.#disposed ? undefined : transmission
              );
              if (!uploaded) {
                if (createdImage) this.#terminalImages.delete(terminalImageKey);
                break;
              }
            } catch (error) {
              if (createdImage) this.#terminalImages.delete(terminalImageKey);
              throw error;
            }
          }
          if (this.#disposed
            || this.#layoutSuspended
            || layoutVersion !== this.#layoutVersion
            || this.terminal.buffer.active.type !== bufferType) {
            // The uploaded image is content-addressed and remains reusable.
            // Only its cell-addressed placement needs a fresh scan.
            this.#rescanRequested = true;
            this.#evictIdleTerminalImages();
            break;
          }
          const placementId = this.#nextPlacementId();
          let emitted = false;
          try {
            emitted = await this.#writeGraphicsTransaction(() => {
              if (this.#disposed
                || this.#layoutSuspended
                || layoutVersion !== this.#layoutVersion
                || this.terminal.buffer.active.type !== bufferType) return undefined;
              const liveBuffer = this.terminal.buffer.active;
              if (liveBuffer.cursorX >= this.terminal.cols
                && this.#pendingWrapHeldColumns === undefined) return undefined;
              return [
                existing ? kittyDeletePlacement(existing.imageId, existing.placementId) : "",
                cursorPosition(region.startRow + 1, region.startCol + 1),
                kittyPlaceImage(image.imageId, placementId, columns, rows),
                cursorPosition(
                  liveBuffer.cursorY + 1,
                  this.#pendingWrapHeldColumns !== undefined
                    ? Math.max(1, liveBuffer.cursorX - this.#pendingWrapHeldColumns + 1)
                    : liveBuffer.cursorX + 1
                )
              ].join("");
            });
          } catch (error) {
            if (createdImage) this.#terminalImages.delete(terminalImageKey);
            throw error;
          }
          if (!emitted) {
            this.#rescanRequested = true;
            break;
          }
          if (this.#disposed
            || this.#layoutSuspended
            || layoutVersion !== this.#layoutVersion
            || this.terminal.buffer.active.type !== bufferType) {
            // SIGWINCH can arrive after the guarded transaction starts. It is
            // then too late to cancel its APC, but no child output can overtake
            // this scan in TerminalWriter. Delete the provisional placement
            // and restore the real cursor from the newly reflowed mirror before
            // releasing the output queue.
            await this.#writeGraphicsTransaction(() => {
              if (this.#disposed) return kittyDeletePlacement(image.imageId, placementId);
              const liveBuffer = this.terminal.buffer.active;
              const restoreColumn = this.#pendingWrapHeldColumns !== undefined
                ? Math.max(1, liveBuffer.cursorX - this.#pendingWrapHeldColumns + 1)
                : liveBuffer.cursorX + 1;
              return kittyDeletePlacement(image.imageId, placementId)
                + cursorPosition(liveBuffer.cursorY + 1, restoreColumn);
            });
            if (existing) {
              this.#releasePlacement(existing);
              this.#placed.delete(replacement!.anchor);
              retainedReplacementAnchors.delete(replacement!.anchor);
            }
            this.#rescanRequested = true;
            break;
          }
          if (existing) {
            this.#releasePlacement(existing);
            this.#placed.delete(replacement!.anchor);
            retainedReplacementAnchors.delete(replacement!.anchor);
          }
          image.placements += 1;
          image.lastUsed = ++this.#imageUse;
          const markers = this.#markersForRegion(region);
          this.#placed.set(anchor, {
            anchor,
            imageId: image.imageId,
            placementId,
            imageKey: terminalImageKey,
            latex: region.latex,
            sourceText: this.#regionSourceText(region),
            fingerprint,
            bufferType: buffer.type,
            absoluteStartRow: buffer.viewportY + region.startRow,
            absoluteEndRow: buffer.viewportY + region.endRow,
            ...markers
          });
          this.#evictIdleTerminalImages();
          this.#debug(`rendered ${region.confidence} formula at ${anchor} (${rendered.widthPx}x${rendered.heightPx}px)`);
        } catch (error) {
          this.#debug(`formula render skipped: ${error instanceof Error ? error.message : String(error)}`);
          // The old placement is the last known-good rendering of this exact
          // LaTeX. Leave it in place; a later layout/output scan can replace it
          // transactionally instead of exposing raw source on a transient
          // MathJax or terminal-graphics failure.
          const attempt = (this.#placementRetries.get(placementRetryKey)?.attempt ?? 0) + 1;
          if (attempt > 5) {
            this.#placementRetries.delete(placementRetryKey);
            this.#blockedPlacementKeys.add(placementRetryKey);
            this.#debug(`formula variant at ${anchor} exceeded the render retry limit`);
          } else {
            const delay = Math.min(2_000, 50 * (2 ** (attempt - 1)));
            this.#placementRetries.set(placementRetryKey, {
              attempt,
              notBefore: Date.now() + delay
            });
            retryDelay = Math.min(retryDelay ?? delay, delay);
          }
        }
      }
      // Stale placement deletion is deliberately transactional as well. A
      // resize can invalidate an in-flight scan; deleting before all current
      // formulas are prepared would permanently lose an image that has just
      // moved into scrollback. Markers keep this visibility check valid after
      // normal-buffer reflow.
      if (layoutVersion === this.#layoutVersion && version === this.#scanVersion) {
        let detachedAfterLayout = 0;
        for (const [anchor, placement] of this.#placed) {
          const hasLiveMarker = [placement.startMarker, placement.endMarker].some((marker) =>
            Boolean(marker && !marker.isDisposed && marker.line >= 0)
          );
          if (placement.bufferType === "normal"
            && !hasLiveMarker
            && placement.layoutHint
            && !desiredAnchors.has(anchor)
            && !retainedReplacementAnchors.has(anchor)
            && !this.#placementIsVisible(placement)) {
            // The hint served its one purpose: pairing a placement whose
            // markers were destroyed by the just-completed visible reflow. If
            // it is now wholly outside the stable viewport and no region has
            // claimed it, keeping the static anchor would let a later xterm
            // row recycle delete Ghostty's unrelated historical pin.
            this.#detachPlacement(anchor, placement);
            detachedAfterLayout += 1;
            continue;
          }
          if (desiredAnchors.has(anchor)
            || retainedReplacementAnchors.has(anchor)
            || (bufferType === "alternate" && this.#alternate47Restored)
            || !this.#placementIsVisible(placement)
            || this.#partialPlacementSourceStillVisible(placement)) continue;
          this.#writeOuter(kittyDeletePlacement(placement.imageId, placement.placementId));
          this.#releasePlacement(placement);
          this.#placed.delete(anchor);
        }
        if (detachedAfterLayout > 0) {
          this.#debug(`detached ${detachedAfterLayout} off-screen resize placement(s)`);
        }
        this.#evictIdleTerminalImages();
      }
    } finally {
      this.#scanning = false;
      for (const resolve of this.#scanWaiters.splice(0)) resolve();
      if (!this.#disposed && (this.#rescanRequested || version !== this.#scanVersion)) {
        this.#rescanRequested = false;
        if (this.#pendingWrites === 0 && !this.#layoutSuspended) this.scheduleScan(140);
      } else if (!this.#disposed && retryDelay !== undefined) {
        this.scheduleScan(Math.max(16, retryDelay), true);
      }
    }
  }
}
