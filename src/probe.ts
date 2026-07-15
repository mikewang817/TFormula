import type { TerminalCapabilities } from "./types.js";

const DEFAULT_CELL = { width: 9, height: 18, source: "fallback" as const };
const DEFAULT_FOREGROUND = "#d8dee9";
const DEFAULT_BACKGROUND = "#1e1e2e";

interface ParsedResponses {
  cell?: { width: number; height: number };
  windowPixels?: { width: number; height: number };
  foreground?: string;
  background?: string;
  kittyGraphics?: boolean;
  primaryDeviceAttributes: boolean;
  residual: string;
}

// Query actions never store an image, but the protocol still requires a
// positive image id. Keep it adjacent to (but outside) TFormula's allocatable
// range so it can never collide with a real cached formula image.
export const KITTY_QUERY_IMAGE_ID = 2_000_000_000;
/** Safety fallback; the tagged Kitty reply normally ends quarantine earlier. */
export const STARTUP_PROBE_QUARANTINE_MS = 1_000;
// Keep the tagged Kitty response last. It is the only startup response that
// carries our generation id, so putting DA before it makes the Kitty ACK an
// actual ordering barrier for every untagged CSI/OSC response.
const KITTY_GRAPHICS_QUERY = `\x1b[c\x1b_Gi=${KITTY_QUERY_IMAGE_ID},s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\`;

// Runtime cell probes use a distinct query id as an ordering barrier. Kitty
// replies carry the id back verbatim, unlike CSI 16t/14t and OSC 10/11 replies,
// so a late acknowledgement can never complete the wrong resize generation.
export const RUNTIME_PROBE_QUERY_ID_MIN = KITTY_QUERY_IMAGE_ID + 1;
export const RUNTIME_PROBE_QUERY_ID_MAX = KITTY_QUERY_IMAGE_ID + 99_999_999;

export function runtimeProbeQueryId(generation: number): number {
  const range = RUNTIME_PROBE_QUERY_ID_MAX - RUNTIME_PROBE_QUERY_ID_MIN + 1;
  const offset = ((Math.floor(generation) - 1) % range + range) % range;
  return RUNTIME_PROBE_QUERY_ID_MIN + offset;
}

export function runtimeProbeBarrier(imageId: number): string {
  return `\x1b_Gi=${imageId},s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\`;
}

export function isRuntimeProbeQueryId(imageId: number): boolean {
  return Number.isInteger(imageId)
    && imageId >= RUNTIME_PROBE_QUERY_ID_MIN
    && imageId <= RUNTIME_PROBE_QUERY_ID_MAX;
}

export interface FilteredProbeResponses {
  /** Ordinary keyboard input and responses belonging to the wrapped Agent. */
  residual: string;
  /** Complete replies to CSI 16t/14t, OSC 10/11, or an opted-in DA. */
  responses: string[];
}

/**
 * Streaming filter for the untagged replies produced by a TFormula cell probe.
 *
 * This filter is enabled only while one of our own queries is active, or for a
 * short quarantine after it times out. It therefore does not steal replies to
 * terminal queries emitted later by the wrapped Agent. A separate, tagged
 * Kitty query is used as the end-of-generation barrier.
 */
export class TerminalProbeResponseFilter {
  #tail = "";
  readonly #maximumResponseLength: number;

  constructor(maximumResponseLength = 4096) {
    this.#maximumResponseLength = Math.max(128, Math.floor(maximumResponseLength));
  }

  get hasPending(): boolean {
    return this.#tail.length > 0;
  }

  push(input: string, captureDeviceAttributes = false): FilteredProbeResponses {
    const data = this.#tail + input;
    this.#tail = "";
    const responses: string[] = [];
    let residual = "";
    let cursor = 0;

    const hold = (start: number): boolean => {
      const candidate = data.slice(start);
      if (candidate.length > this.#maximumResponseLength) return false;
      this.#tail = candidate;
      return true;
    };

    while (cursor < data.length) {
      const start = cursor;
      let kind: "csi" | "osc" | undefined;
      let bodyStart = cursor;
      if (data[cursor] === "\x1b") {
        if (cursor + 1 >= data.length) {
          if (!hold(cursor)) residual += data[cursor];
          break;
        }
        if (data[cursor + 1] === "[") {
          kind = "csi";
          bodyStart = cursor + 2;
        } else if (data[cursor + 1] === "]") {
          kind = "osc";
          bodyStart = cursor + 2;
        }
      } else if (data[cursor] === "\u009b") {
        kind = "csi";
        bodyStart = cursor + 1;
      } else if (data[cursor] === "\u009d") {
        kind = "osc";
        bodyStart = cursor + 1;
      }

      if (!kind) {
        residual += data[cursor];
        cursor += 1;
        continue;
      }

      if (kind === "csi") {
        const body = data.slice(bodyStart);
        const complete = body.match(/^(?:6|4);\d+;\d+t/u)?.[0];
        if (complete) {
          const end = bodyStart + complete.length;
          responses.push(data.slice(start, end));
          cursor = end;
          continue;
        }
        if (captureDeviceAttributes) {
          const deviceAttributes = body.match(/^(?:\?|>)?[0-9;]*c/u)?.[0];
          if (deviceAttributes) {
            const end = bodyStart + deviceAttributes.length;
            responses.push(data.slice(start, end));
            cursor = end;
            continue;
          }
          if (/^(?:\?|>)?[0-9;]*$/u.test(body) && hold(start)) break;
        }
        // A valid response can be split after any field or digit. Empty CSI
        // bodies are retained as well so ESC and '[' may arrive separately.
        const possible = /^(?:[46](?:;\d*(?:;\d*)?)?)?$/u.test(body);
        if (possible && hold(start)) break;
        // It is another application's CSI. Preserve the introducer verbatim
        // and continue scanning its body for a later, independent response.
        residual += data.slice(start, bodyStart);
        cursor = bodyStart;
        continue;
      }

      const body = data.slice(bodyStart);
      const selectorPossible = body === ""
        || body === "1"
        || body === "10"
        || body === "11"
        || body.startsWith("10;")
        || body.startsWith("11;");
      if (!selectorPossible) {
        residual += data.slice(start, bodyStart);
        cursor = bodyStart;
        continue;
      }

      const bel = data.indexOf("\x07", bodyStart);
      const sevenBitSt = data.indexOf("\x1b\\", bodyStart);
      const eightBitSt = data.indexOf("\u009c", bodyStart);
      const terminators = [bel, sevenBitSt, eightBitSt].filter((value) => value >= 0);
      if (terminators.length === 0) {
        if (hold(start)) break;
        residual += data.slice(start);
        break;
      }
      const end = Math.min(...terminators);
      const terminatorLength = end === sevenBitSt ? 2 : 1;
      const raw = data.slice(start, end + terminatorLength);
      const responseBody = data.slice(bodyStart, end);
      if (responseBody.startsWith("10;") || responseBody.startsWith("11;")) {
        responses.push(raw);
      } else {
        residual += raw;
      }
      cursor = end + terminatorLength;
    }

    return { residual, responses };
  }

  /**
   * Release an ambiguous user Escape, but optionally discard a longer prefix
   * which has already identified itself as a truncated terminal reply.
   */
  flush(discardIncompleteResponse = false): string {
    const tail = this.#tail;
    this.#tail = "";
    if (!discardIncompleteResponse || tail === "\x1b") return tail;
    return "";
  }
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
  let kittyGraphics: boolean | undefined;
  let primaryDeviceAttributes = false;

  residual = residual.replace(
    /(?:\x1b_G|\u009fG)([^;\x1b\u009c]*);([^\x1b\u009c]*)(?:\x1b\\|\u009c)/gu,
    (all, controls, message) => {
      const imageId = Number(String(controls).match(/(?:^|,)i=(\d+)(?:,|$)/u)?.[1]);
      if (imageId !== KITTY_QUERY_IMAGE_ID) return all;
      kittyGraphics = String(message).trim().toUpperCase() === "OK";
      return "";
    }
  );
  residual = residual.replace(/(?:\x1b\[|\u009b)(?:\?|>)?[0-9;]*c/gu, () => {
    primaryDeviceAttributes = true;
    return "";
  });

  residual = residual.replace(/(?:\x1b\[|\u009b)6;(\d+);(\d+)t/gu, (_all, height, width) => {
    cell = { width: Number(width), height: Number(height) };
    return "";
  });
  residual = residual.replace(/(?:\x1b\[|\u009b)4;(\d+);(\d+)t/gu, (_all, height, width) => {
    windowPixels = { width: Number(width), height: Number(height) };
    return "";
  });
  residual = residual.replace(
    /(?:\x1b\]|\u009d)(10|11);([^\x07\x1b\u009c]+)(?:\x07|\x1b\\|\u009c)/gu,
    (_all, slot, value) => {
      const color = parseRgb(value);
      if (slot === "10") foreground = color;
      if (slot === "11") background = color;
      return "";
    }
  );

  return {
    cell,
    windowPixels,
    foreground,
    background,
    kittyGraphics,
    primaryDeviceAttributes,
    residual
  };
}

function supportsKittyGraphics(env: NodeJS.ProcessEnv): boolean {
  const term = (env.TERM ?? "").toLowerCase();
  // TFormula currently emits the Kitty protocol directly. tmux/screen require
  // DCS passthrough and can otherwise print the APC payload (including PNG
  // Base64) as ordinary text. Disable graphics until passthrough is negotiated.
  if (env.TMUX || env.STY || env.ZELLIJ || env.MOSH_CONNECTION
    || /^(?:screen|tmux)(?:[-.]|$)/u.test(term)) return false;
  const identity = `${term} ${env.TERM_PROGRAM ?? ""}`.toLowerCase();
  return /ghostty|kitty|wezterm/u.test(identity);
}

/**
 * A terminal name is only a reason to ask about Kitty graphics, never proof
 * that APC payloads are safe.  Requiring the protocol's explicit OK response
 * makes a delayed, swallowed, or unsupported query fail closed instead of
 * exposing direct-transfer PNG Base64 as ordinary terminal text.
 */
function confirmedKittyGraphics(requested: boolean, response: boolean | undefined): boolean {
  return requested && response === true;
}

export interface ProbeResult {
  capabilities: TerminalCapabilities;
  pendingInput: string;
  /** Startup queries were sent but their tagged Kitty barrier has not arrived. */
  startupProbePending: boolean;
}

function startupProbeBarrierReceived(parsed: ParsedResponses, requestedKitty: boolean): boolean {
  return requestedKitty
    ? parsed.kittyGraphics !== undefined
    : parsed.primaryDeviceAttributes;
}

export async function probeTerminal(
  cellOverride?: { width: number; height: number },
  timeoutMs = 180
): Promise<ProbeResult> {
  const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const fallback: TerminalCapabilities = {
    // Never place APC graphics into a pipe or redirected file merely because
    // TERM_PROGRAM was inherited from a graphical terminal.
    kittyGraphics: tty && supportsKittyGraphics(process.env),
    foreground: DEFAULT_FOREGROUND,
    background: DEFAULT_BACKGROUND,
    cell: cellOverride
      ? { ...cellOverride, source: "override" }
      : DEFAULT_CELL
  };

  if (!tty || typeof process.stdin.setRawMode !== "function") {
    return { capabilities: fallback, pendingInput: "", startupProbePending: false };
  }

  const wasRaw = process.stdin.isRaw;
  const chunks: Buffer[] = [];
  let finishProbe: (() => void) | undefined;
  const barrier = new Promise<void>((resolve) => {
    finishProbe = resolve;
  });
  const onData = (chunk: Buffer | string): void => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const parsed = parseTerminalResponses(Buffer.concat(chunks).toString("utf8"));
    if (startupProbeBarrierReceived(parsed, fallback.kittyGraphics)) finishProbe?.();
  };

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", onData);
  // Cell pixels, text-area pixels, foreground, and background. For terminals
  // that claim Kitty compatibility, use the protocol's official query action
  // followed by primary device attributes. Seeing the latter without the
  // graphics response is a definitive negative and prevents raw PNG payloads
  // from being sent on a false-positive TERM hint.
  process.stdout.write(
    `\x1b[16t\x1b[14t\x1b]10;?\x1b\\\x1b]11;?\x1b\\${fallback.kittyGraphics ? KITTY_GRAPHICS_QUERY : "\x1b[c"}`
  );
  const timer = setTimeout(() => finishProbe?.(), Math.max(0, timeoutMs));
  await barrier;
  clearTimeout(timer);
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
      kittyGraphics: confirmedKittyGraphics(fallback.kittyGraphics, parsed.kittyGraphics),
      foreground: parsed.foreground ?? fallback.foreground,
      background: parsed.background ?? fallback.background,
      cell,
      windowPixels: parsed.windowPixels
    },
    pendingInput: parsed.residual,
    // A Kitty response is the ordered barrier after every untagged startup
    // query.  If it did not arrive before the fixed probe window, runProxy
    // briefly quarantines late CSI/OSC/DA replies instead of feeding them to
    // the newly spawned Agent as keyboard input.
    startupProbePending: fallback.kittyGraphics && parsed.kittyGraphics === undefined
  };
}

export const probeInternals = {
  KITTY_GRAPHICS_QUERY,
  KITTY_QUERY_IMAGE_ID,
  confirmedKittyGraphics,
  parseRgb,
  startupProbeBarrierReceived,
  supportsKittyGraphics
};
