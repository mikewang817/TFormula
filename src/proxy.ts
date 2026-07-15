import process from "node:process";
import { appendFileSync, chmodSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import * as pty from "node-pty";
import { containsFormulaTrigger } from "./detect.js";
import { FormulaScreen } from "./screen.js";
import {
  isGhosttyTerminal,
  KittyImageTransmitter,
  selectImageTransmissionMode
} from "./image-transmitter.js";
import { OutputCheckpointSplitter } from "./output-checkpoints.js";
import { TFORMULA_IMAGE_ID_MAX, TFORMULA_IMAGE_ID_MIN } from "./kitty.js";
import {
  isRuntimeProbeQueryId,
  KITTY_QUERY_IMAGE_ID,
  parseTerminalResponses,
  runtimeProbeBarrier,
  runtimeProbeQueryId,
  STARTUP_PROBE_QUARANTINE_MS,
  TerminalProbeResponseFilter
} from "./probe.js";
import { TerminalResponseFilter } from "./terminal-responses.js";
import {
  TerminalCellHoldback,
  TerminalControlGate,
  TerminalOutputTransformer
} from "./terminal-output.js";
import { TerminalWriter } from "./terminal-writer.js";
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
  pendingInput = "",
  startupProbePending = false
): Promise<number> {
  const cols = Math.max(2, process.stdout.columns ?? 80);
  const rows = Math.max(2, process.stdout.rows ?? 24);
  let capabilities = initialCapabilities;
  let child: pty.IPty;
  let probeCapture = "";
  let probeTimer: NodeJS.Timeout | undefined;
  let probeQueued = false;
  let probeActive = false;
  let probeRequestedEpoch: number | undefined;
  let activeProbeEpoch = 0;
  let activeProbeQueryId: number | undefined;
  let probeGeneration = 0;
  let probeQuarantineQueryId: number | undefined;
  let probeQuarantineTimer: NodeJS.Timeout | undefined;
  let startupProbeQuarantine = startupProbePending;
  let startupProbeTimer: NodeJS.Timeout | undefined;
  let startupProbeCapture = "";
  let responseTailTimer: NodeJS.Timeout | undefined;
  let latestLayoutEpoch = 0;
  let exiting = false;
  let outputQueue = Promise.resolve();
  const terminalWriter = new TerminalWriter(process.stdout);
  const childControlGate = new TerminalControlGate();
  const outputTransformer = new TerminalOutputTransformer();
  const cellHoldback = new TerminalCellHoldback();
  const ghosttyTerminal = isGhosttyTerminal();
  const imageTransmitter = options.renderMath
    ? new KittyImageTransmitter(selectImageTransmissionMode())
    : undefined;
  const debugLogPath = options.debug && process.stderr.isTTY
    ? join(tmpdir(), `tformula-${process.pid}.log`)
    : undefined;

  const debug = (message: string): void => {
    if (!options.debug) return;
    const line = `[${new Date().toISOString()}] ${message}\n`;
    if (!process.stderr.isTTY) process.stderr.write(`[tformula] ${message}\n`);
    else if (debugLogPath) {
      try {
        appendFileSync(debugLogPath, line, { encoding: "utf8", mode: 0o600 });
      } catch {
        // Diagnostics must never disturb or terminate the proxied TUI.
      }
    }
  };
  const writeOuter = (data: string | Uint8Array): void => {
    terminalWriter.enqueue(data);
  };
  const screen = options.renderMath
    ? new FormulaScreen({
        cols,
        rows,
        capabilities,
        scale: options.scale,
        writeOuter,
        writeGraphics: (create) => terminalWriter.writeGenerated(create),
        debug,
        transmitImage: imageTransmitter?.transmit,
        // A delayed explicit Kitty ACK can safely enable graphics shortly
        // after startup. Ghostty's ED2 rewrite policy must already be active
        // when that happens or its first clear would orphan image pins.
        preserveImagesOnClear: ghosttyTerminal
      })
    : undefined;
  const responseFilter = new TerminalResponseFilter((imageId) =>
    imageId === KITTY_QUERY_IMAGE_ID
      || isRuntimeProbeQueryId(imageId)
      || (imageId >= TFORMULA_IMAGE_ID_MIN && imageId <= TFORMULA_IMAGE_ID_MAX)
  );
  const probeResponseFilter = new TerminalProbeResponseFilter();
  const inputDecoder = new StringDecoder("utf8");
  const outputSplitter = new OutputCheckpointSplitter(Math.max(2, Math.floor(rows / 3)));
  outputSplitter.setCharacterInterval(cols * Math.max(2, Math.floor(rows / 3)));
  let plainOutputFastPath = false;

  const enqueueScreenOperation = (operation: () => Promise<void> | void): void => {
    outputQueue = outputQueue.then(operation).catch((error) => {
      debug(`screen operation failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  };

  const startRequestedProbe = (): void => {
    if (probeRequestedEpoch === undefined || exiting
      || probeQuarantineQueryId !== undefined || startupProbeQuarantine) return;
    const requestedEpoch = probeRequestedEpoch;
    probeRequestedEpoch = undefined;
    requestProbe(requestedEpoch);
  };

  const finishProbeQuarantine = (queryId: number): void => {
    if (probeQuarantineQueryId !== queryId) return;
    if (probeQuarantineTimer) clearTimeout(probeQuarantineTimer);
    probeQuarantineTimer = undefined;
    probeQuarantineQueryId = undefined;
    // A lone Escape is ambiguous keyboard input. Longer retained prefixes have
    // identified themselves as a truncated reply and must not reach the Agent.
    const residual = probeResponseFilter.flush(true);
    if (residual) child.write(residual);
    startRequestedProbe();
  };

  const finishStartupProbeQuarantine = (kittyMessage?: string): void => {
    if (!startupProbeQuarantine) return;
    const captured = startupProbeCapture;
    startupProbeCapture = "";
    startupProbeQuarantine = false;
    if (startupProbeTimer) clearTimeout(startupProbeTimer);
    startupProbeTimer = undefined;
    const residual = probeResponseFilter.flush(true);
    if (residual && !exiting) child.write(residual);
    if (!exiting && kittyMessage?.trim().toUpperCase() === "OK") {
      const parsed = parseTerminalResponses(captured);
      const validCell = parsed.cell
        && parsed.cell.width > 0 && parsed.cell.height > 0
        ? parsed.cell
        : undefined;
      const validWindow = parsed.windowPixels
        && parsed.windowPixels.width > 0 && parsed.windowPixels.height > 0
        ? parsed.windowPixels
        : undefined;
      const nextCell = options.cellOverride
        ? { ...options.cellOverride, source: "override" as const }
        : validCell
          ? { ...validCell, source: "cell-query" as const }
          : validWindow
            ? {
                width: validWindow.width / Math.max(1, process.stdout.columns ?? cols),
                height: validWindow.height / Math.max(1, process.stdout.rows ?? rows),
                source: "window-query" as const
              }
            : capabilities.cell;
      capabilities = {
        ...capabilities,
        kittyGraphics: true,
        cell: nextCell,
        windowPixels: validWindow ?? capabilities.windowPixels,
        foreground: parsed.foreground ?? capabilities.foreground,
        background: parsed.background ?? capabilities.background
      };
      screen?.updateCapabilities(capabilities);
      debug(`accepted delayed startup Kitty capability; cell ${nextCell.width.toFixed(2)}x${nextCell.height.toFixed(2)}px`);
    }
    startRequestedProbe();
  };

  const quarantineTimedOutProbe = (queryId: number): void => {
    probeQuarantineQueryId = queryId;
    if (probeQuarantineTimer) clearTimeout(probeQuarantineTimer);
    probeQuarantineTimer = setTimeout(() => finishProbeQuarantine(queryId), 240);
  };

  const finishProbe = (generation: number, acknowledged = false): void => {
    if (!probeActive || generation !== probeGeneration) return;
    if (probeTimer) clearTimeout(probeTimer);
    probeTimer = undefined;
    probeActive = false;
    const queryId = activeProbeQueryId;
    activeProbeQueryId = undefined;
    if (acknowledged) {
      const residual = probeResponseFilter.flush();
      if (residual) child.write(residual);
    }
    const captured = probeCapture;
    probeCapture = "";
    const parsed = parseTerminalResponses(captured);
    const stale = probeRequestedEpoch !== undefined && probeRequestedEpoch > activeProbeEpoch;
    if (!stale) {
      const validCell = parsed.cell
        && Number.isFinite(parsed.cell.width)
        && Number.isFinite(parsed.cell.height)
        && parsed.cell.width > 0
        && parsed.cell.height > 0
        ? parsed.cell
        : undefined;
      const validWindow = parsed.windowPixels
        && Number.isFinite(parsed.windowPixels.width)
        && Number.isFinite(parsed.windowPixels.height)
        && parsed.windowPixels.width > 0
        && parsed.windowPixels.height > 0
        ? parsed.windowPixels
        : undefined;
      const nextCell = options.cellOverride
        ? { ...options.cellOverride, source: "override" as const }
        : validCell
          ? { ...validCell, source: "cell-query" as const }
          : validWindow
            ? {
                width: validWindow.width / Math.max(1, process.stdout.columns ?? cols),
                height: validWindow.height / Math.max(1, process.stdout.rows ?? rows),
                source: "window-query" as const
              }
            : capabilities.cell;
      capabilities = {
        ...capabilities,
        cell: nextCell,
        windowPixels: validWindow ?? capabilities.windowPixels,
        foreground: parsed.foreground ?? capabilities.foreground,
        background: parsed.background ?? capabilities.background
      };
      const completedEpoch = activeProbeEpoch;
      // Resume the mirror immediately. Putting this behind the PTY backlog
      // leaves checkpoint scans suspended long enough for formulas to scroll
      // out of the viewport before they can ever be placed.
      screen?.updateCapabilities(capabilities, completedEpoch);
      debug(`cell ${nextCell.width.toFixed(2)}x${nextCell.height.toFixed(2)}px (${nextCell.source})`);
    }
    if (parsed.residual) child.write(parsed.residual);
    if (!acknowledged && queryId !== undefined && !exiting) {
      quarantineTimedOutProbe(queryId);
    } else {
      startRequestedProbe();
    }
  };

  const requestProbe = (layoutEpoch: number): void => {
    if (exiting || !process.stdin.isTTY || options.cellOverride || !screen
      || !capabilities.kittyGraphics) return;
    if (probeQueued || probeActive || probeQuarantineQueryId !== undefined
      || startupProbeQuarantine) {
      probeRequestedEpoch = Math.max(probeRequestedEpoch ?? 0, layoutEpoch);
      return;
    }
    const generation = ++probeGeneration;
    const queryId = runtimeProbeQueryId(generation);
    probeQueued = true;
    void terminalWriter.writeIf(
      `\x1b[16t\x1b[14t\x1b]10;?\x1b\\\x1b]11;?\x1b\\${runtimeProbeBarrier(queryId)}`,
      () => {
        if (generation !== probeGeneration || exiting) return false;
        probeQueued = false;
        probeActive = true;
        // If the query waited behind an image transaction, it has not observed
        // the old geometry yet. Coalesce every resize received before onStart
        // into this generation instead of issuing a redundant stale probe.
        activeProbeEpoch = Math.max(layoutEpoch, probeRequestedEpoch ?? 0);
        if (probeRequestedEpoch !== undefined
          && probeRequestedEpoch <= activeProbeEpoch) probeRequestedEpoch = undefined;
        activeProbeQueryId = queryId;
        probeCapture = "";
        return true;
      }
    ).then((started) => {
      if (!started) {
        if (generation === probeGeneration) probeQueued = false;
        return;
      }
      if (!probeActive || generation !== probeGeneration || exiting) return;
      // Start the timeout only once the query bytes have actually reached the
      // TTY. A large image already in the writer queue can otherwise make the
      // timeout expire before the query is sent.
      probeTimer = setTimeout(() => finishProbe(generation), 160);
    }).catch((error) => {
      if (generation !== probeGeneration) return;
      probeQueued = false;
      debug(`terminal probe failed: ${error instanceof Error ? error.message : String(error)}`);
      if (probeTimer) clearTimeout(probeTimer);
      probeTimer = undefined;
      probeActive = false;
      activeProbeQueryId = undefined;
      probeCapture = "";
      const residual = probeResponseFilter.flush();
      if (residual) child.write(residual);
      // A failure before onStart used to resume only layoutEpoch. If rapid
      // resizes had already requested a newer epoch, that left FormulaScreen
      // suspended forever because no matching updateCapabilities ever arrived.
      const resumeEpoch = Math.max(layoutEpoch, activeProbeEpoch, probeRequestedEpoch ?? 0);
      probeRequestedEpoch = undefined;
      probeGeneration += 1;
      screen.updateCapabilities(capabilities, resumeEpoch);
      // writeIf rejects only after its predicate accepted the transaction, so
      // a failed write may have emitted a partial query and needs quarantine.
      if (!exiting) quarantineTimedOutProbe(queryId);
    });
  };

  ensureNodePtyHelper();
  child = pty.spawn(options.command, options.args, {
    name: process.env.TERM || "xterm-256color",
    cols,
    rows,
    cwd: options.cwd,
    env: { ...process.env, TFORMULA_ACTIVE: "1" } as Record<string, string>
  });

  if (startupProbeQuarantine) {
    startupProbeTimer = setTimeout(finishStartupProbeQuarantine, STARTUP_PROBE_QUARANTINE_MS);
  }

  const previousRaw = process.stdin.isRaw;
  if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") process.stdin.setRawMode(true);
  process.stdin.resume();
  const routeInput = (data: string): void => {
    if (!data) return;
    if (!startupProbeQuarantine && !probeActive
      && probeQuarantineQueryId === undefined) {
      child.write(data);
      return;
    }
    const filtered = probeResponseFilter.push(data, startupProbeQuarantine);
    if (startupProbeQuarantine && filtered.responses.length > 0) {
      startupProbeCapture += filtered.responses.join("");
    }
    if (probeActive && filtered.responses.length > 0) {
      probeCapture += filtered.responses.join("");
    }
    // Keyboard input is never held for the full probe timeout. Only an
    // incomplete prefix that could still become one of our replies is retained
    // by the streaming filter; all definite residual bytes reach the Agent now.
    if (filtered.residual) child.write(filtered.residual);
  };
  process.stdin.on("data", (chunk: Buffer | string) => {
    if (responseTailTimer) clearTimeout(responseTailTimer);
    responseTailTimer = undefined;
    const data = Buffer.isBuffer(chunk) ? inputDecoder.write(chunk) : chunk;
    const filtered = responseFilter.push(data);
    // Preserve stream order for the runtime barrier: every untagged cell/theme
    // response in this chunk must be recorded before its tagged Kitty ACK can
    // complete the generation.
    routeInput(filtered.residual);
    for (const response of filtered.graphics) {
      if (response.imageId === KITTY_QUERY_IMAGE_ID) {
        // A delayed startup capability ACK belongs to TFormula, but is not a
        // terminal image acceptance and must never be forwarded to the Agent.
        finishStartupProbeQuarantine(response.message);
        continue;
      }
      if (isRuntimeProbeQueryId(response.imageId)) {
        if (response.imageId === activeProbeQueryId && probeActive) {
          finishProbe(probeGeneration, true);
        } else if (response.imageId === probeQuarantineQueryId) {
          finishProbeQuarantine(response.imageId);
        }
        // An old generation's tagged response is always swallowed. It must not
        // accidentally mark a real formula image as accepted after ID reuse.
        continue;
      }
      const message = response.message.trim();
      if (message.toUpperCase() === "OK") {
        if (response.placementId === undefined) {
          imageTransmitter?.markImageAccepted(response.imageId);
          screen?.markTerminalImageAccepted(response.imageId);
        } else {
          screen?.markTerminalPlacementAccepted(
            response.imageId,
            response.placementId
          );
        }
        continue;
      }
      // q=0 asks Kitty for an explicit OK/error response. An empty or
      // malformed response is neither proof of acceptance nor a useful retry
      // signal; leave the outstanding state intact instead of resetting its
      // budget or deleting a still-valid placement.
      if (!message) {
        debug(`ignored empty Kitty response for image ${response.imageId}`);
        continue;
      }
      const missingImage = /^ENOENT\b/iu.test(message);
      const rejectedTemporaryFile = response.placementId === undefined
        && Boolean(imageTransmitter?.wasTemporaryFileImage(response.imageId));
      const fellBack = rejectedTemporaryFile
        && Boolean(imageTransmitter?.fallbackToDirect());
      if (fellBack) {
        debug("terminal rejected temporary-file graphics; falling back to bounded direct transfer");
      }
      if (response.placementId !== undefined && !missingImage) {
        screen?.invalidateTerminalPlacement(
          response.imageId,
          response.placementId,
          `Kitty ${message}`,
          true
        );
      } else {
        screen?.invalidateTerminalImage(
          response.imageId,
          `Kitty ${message}`,
          true
        );
      }
    }
    if (responseFilter.hasPending) {
      // A real Escape key is often delivered as a one-byte chunk. Hold a
      // possible ESC_G prefix only briefly so response fragmentation works
      // without making Escape unusable in the child TUI.
      responseTailTimer = setTimeout(() => {
        responseTailTimer = undefined;
        routeInput(responseFilter.flush());
      }, responseFilter.hasConfirmedGraphicsResponse ? 1_000 : 20);
    }
  });

  const enqueueReleasedChildOutput = (data: string): void => {
    if (!data) return;
    if (!screen) {
      writeOuter(data);
      return;
    }
    // If the stable screen has no formula state and this burst cannot begin or
    // continue any supported formula syntax, intermediate scans cannot reveal
    // useful work. Keeping it as one xterm write avoids turning large ordinary
    // logs into thousands of Promise callbacks and viewport scans. Once
    // enabled, the fast path may span adjacent queued callbacks because every
    // one is independently trigger-free.
    const formulaOrLayoutTrigger = containsFormulaTrigger(data) || data.includes("\x1b");
    const skipCheckpoints = !formulaOrLayoutTrigger
      && (plainOutputFastPath || screen.canSkipOutputCheckpoints);
    plainOutputFastPath = skipCheckpoints;
    const slices = skipCheckpoints
      ? [{ data, checkpoint: false }]
      : outputSplitter.push(data);
    // Reserve the entire callback before it waits behind outputQueue. This
    // retains the stale-layout guard without allocating one Promise chain node
    // and closure for every checkpoint slice in a large PTY burst.
    screen.queueWrites(slices.length);
    enqueueScreenOperation(async () => {
      for (const slice of slices) {
        let queued = true;
        let realCursorCatchupQueued = false;
        try {
          const transformed = outputTransformer.push(
            slice.data,
            ghosttyTerminal
              && capabilities.kittyGraphics
              && screen.hasTerminalPlacements
          );
          const held = cellHoldback.push(transformed.data);
          // While `held` is previewed by the xterm mirror but not yet written
          // to the real TTY, their cursor positions differ by one grapheme.
          // Keep an extra write reservation across that short interval so an
          // older asynchronous MathJax scan cannot commit using the mirror's
          // post-cell cursor and restore Ghostty to the wrong column.  The
          // pending-wrap path below deliberately scans with allowQueuedWrites
          // and supplies its pre-cell cursor override.
          if (held.held !== undefined) {
            screen.queueWrite();
            realCursorCatchupQueued = true;
          }
          await terminalWriter.write(held.data);
          // The mirror must consume the exact text controls sent to Ghostty.
          // Feeding it the original ED 2 would dispose xterm markers while the
          // real terminal kept the corresponding image pins alive.
          // screen.write owns the reservation from this point and always
          // completes it in its own finally block, including on parse errors.
          queued = false;
          await screen.write(
            transformed.data,
            true,
            transformed.preservedEraseDisplayOffsets
          );
          let scannedBeforeHeldCell = false;
          if (held.held !== undefined) {
            if (screen.pendingWrap) {
              await screen.flushScanBeforeHeldCell(
                held.heldColumns ?? 1,
                held.heldSynchronizedOutputMode
              );
              scannedBeforeHeldCell = true;
            }
            await terminalWriter.write(held.held);
            screen.cancelQueuedWrite();
            realCursorCatchupQueued = false;
          }
          if (slice.checkpoint && !scannedBeforeHeldCell) await screen.flushScan(true);
        } catch (error) {
          // Match the former one-operation-per-slice queue semantics: a bad
          // slice must release its reservations without dropping every later
          // slice from the same PTY callback.
          debug(`screen operation failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          if (realCursorCatchupQueued) screen.cancelQueuedWrite();
          if (queued) screen.cancelQueuedWrite();
        }
      }
    });
  };

  child.onData((data) => {
    if (!screen) {
      // --no-math is a byte-transparent PTY proxy: it has no graphics or
      // runtime probe transaction that could interleave with child controls.
      writeOuter(data);
      return;
    }
    // A PTY data event is not a terminal-protocol boundary. Keep a child OSC,
    // DCS, APC, or CSI that spans events off the real terminal until complete;
    // otherwise an asynchronously rendered Kitty image could be inserted into
    // the open control string and expose its remaining PNG Base64 as text.
    enqueueReleasedChildOutput(childControlGate.push(data));
  });

  const onResize = (): void => {
    if (exiting) return;
    // A resize can reveal/reflow formula-bearing scrollback and starts a new
    // layout epoch. Revalidate the viewport before any later plain burst is
    // allowed to bypass intermediate checkpoints.
    plainOutputFastPath = false;
    const nextCols = Math.max(2, process.stdout.columns ?? 80);
    const nextRows = Math.max(2, process.stdout.rows ?? 24);
    outputSplitter.setLineInterval(Math.max(2, Math.floor(nextRows / 3)));
    outputSplitter.setCharacterInterval(nextCols * Math.max(2, Math.floor(nextRows / 3)));
    // The real terminal has already resized. Bytes still waiting in outputQueue
    // will therefore be interpreted at the new geometry; resize the mirror now
    // as well instead of putting the barrier behind those bytes.
    const epoch = screen?.invalidateLayout();
    if (epoch !== undefined) latestLayoutEpoch = epoch;
    const deferUntilProbe = Boolean(epoch !== undefined
      && process.stdin.isTTY
      && !options.cellOverride
      && capabilities.kittyGraphics);
    screen?.resize(nextCols, nextRows, epoch, deferUntilProbe);
    child.resize(nextCols, nextRows);
    if (epoch !== undefined && deferUntilProbe) requestProbe(epoch);
  };
  process.on("SIGWINCH", onResize);

  if (pendingInput) child.write(pendingInput);
  debug(`started ${options.command}; math=${Boolean(screen && capabilities.kittyGraphics)}; image=${imageTransmitter?.mode ?? "disabled"}; cell=${capabilities.cell.width.toFixed(2)}x${capabilities.cell.height.toFixed(2)}px`);

  return await new Promise<number>((resolve) => {
    child.onExit(({ exitCode, signal }) => {
      if (exiting) return;
      exiting = true;
      // Wake every checkpoint before waiting for outputQueue.  Otherwise an
      // exit between two resize epochs can leave the queue blocked on a
      // layout waiter whose probe is deliberately cancelled below.
      process.off("SIGWINCH", onResize);
      probeGeneration += 1;
      probeQueued = false;
      probeActive = false;
      activeProbeQueryId = undefined;
      probeRequestedEpoch = undefined;
      if (probeTimer) clearTimeout(probeTimer);
      probeTimer = undefined;
      if (probeQuarantineTimer) clearTimeout(probeQuarantineTimer);
      probeQuarantineTimer = undefined;
      probeQuarantineQueryId = undefined;
      if (startupProbeTimer) clearTimeout(startupProbeTimer);
      startupProbeTimer = undefined;
      startupProbeQuarantine = false;
      startupProbeCapture = "";
      probeResponseFilter.flush(true);
      if (latestLayoutEpoch > 0) {
        screen?.updateCapabilities(capabilities, latestLayoutEpoch);
      }
      // Invalid/truncated child controls are cancelled before cleanup so the
      // terminal and mirror both return to ground. Sending an open APC and then
      // a delete/image transaction would recreate the very interleaving this
      // gate prevents, while leaving it open would corrupt the parent shell.
      if (screen) enqueueReleasedChildOutput(childControlGate.flush(true));
      void outputQueue.finally(async () => {
        let finalExitCode = signal ? 128 + signal : exitCode;
        try {
          await screen?.flushScan();
          if (responseTailTimer) clearTimeout(responseTailTimer);
          responseTailTimer = undefined;
          const outputTail = outputTransformer.flush();
          if (outputTail) await terminalWriter.write(outputTail);
          screen?.dispose();
          await terminalWriter.flush();
        } catch (error) {
          finalExitCode = finalExitCode || 1;
          process.stderr.write(`tformula: terminal output failed: ${error instanceof Error ? error.message : String(error)}\n`);
        } finally {
          await imageTransmitter?.dispose();
          process.stdin.pause();
          if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function" && !previousRaw) {
            process.stdin.setRawMode(false);
          }
          if (debugLogPath) process.stderr.write(`tformula: debug log: ${debugLogPath}\n`);
          resolve(finalExitCode);
        }
      });
    });
  });
}
