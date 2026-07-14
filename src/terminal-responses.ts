import { TFORMULA_IMAGE_ID_MAX, TFORMULA_IMAGE_ID_MIN } from "./kitty.js";

export interface KittyGraphicsResponse {
  imageId: number;
  placementId?: number;
  message: string;
  raw: string;
}

export interface FilteredTerminalInput {
  residual: string;
  graphics: KittyGraphicsResponse[];
}

/** Removes only Kitty responses belonging to TFormula's reserved image IDs. */
export class TerminalResponseFilter {
  #tail = "";
  readonly #ownsImage: (imageId: number) => boolean;
  readonly #maximumResponseLength: number;

  constructor(ownsImage?: (imageId: number) => boolean, maximumResponseLength = 64 * 1024) {
    this.#ownsImage = ownsImage ?? ((imageId) =>
      imageId >= TFORMULA_IMAGE_ID_MIN && imageId <= TFORMULA_IMAGE_ID_MAX
    );
    // Kitty replies are tiny control messages. A bound prevents an accidental
    // or malicious ESC_G prefix from buffering an unbounded stream of user
    // input while waiting for a terminator that will never arrive.
    this.#maximumResponseLength = Math.max(256, Math.floor(maximumResponseLength));
  }

  get hasPending(): boolean {
    return this.#tail.length > 0;
  }

  get hasConfirmedGraphicsResponse(): boolean {
    return this.#tail.startsWith("\x1b_G") || this.#tail.startsWith("\u009fG");
  }

  push(input: string): FilteredTerminalInput {
    const data = this.#tail + input;
    this.#tail = "";
    const graphics: KittyGraphicsResponse[] = [];
    let residual = "";
    let cursor = 0;

    while (cursor < data.length) {
      const sevenBitStart = data.indexOf("\x1b_G", cursor);
      const eightBitStart = data.indexOf("\u009fG", cursor);
      const start = sevenBitStart < 0
        ? eightBitStart
        : eightBitStart < 0
          ? sevenBitStart
          : Math.min(sevenBitStart, eightBitStart);
      if (start < 0) {
        const remainder = data.slice(cursor);
        // An APC introducer can be split after ESC, ESC_, or an 8-bit APC.
        // Keep the longest suffix that may become a graphics response so it is
        // never leaked to the child before the next input chunk arrives.
        const prefixLength = remainder.endsWith("\x1b_")
          ? 2
          : remainder.endsWith("\x1b") || remainder.endsWith("\u009f")
            ? 1
            : 0;
        residual += prefixLength > 0 ? remainder.slice(0, -prefixLength) : remainder;
        if (prefixLength > 0) this.#tail = remainder.slice(-prefixLength);
        break;
      }
      residual += data.slice(cursor, start);
      const sevenBit = data.startsWith("\x1b_G", start);
      const bodyStart = start + (sevenBit ? 3 : 2);
      const sevenBitEnd = data.indexOf("\x1b\\", bodyStart);
      const eightBitEnd = data.indexOf("\u009c", bodyStart);
      const end = sevenBitEnd < 0
        ? eightBitEnd
        : eightBitEnd < 0
          ? sevenBitEnd
          : Math.min(sevenBitEnd, eightBitEnd);
      if (end < 0) {
        const pending = data.slice(start);
        if (pending.length <= this.#maximumResponseLength) {
          this.#tail = pending;
        } else {
          // Stop recognizing this prefix as a response. Passing it through is
          // safer than indefinitely swallowing subsequent keyboard input.
          residual += pending;
        }
        break;
      }

      const terminatorLength = end === eightBitEnd ? 1 : 2;
      const raw = data.slice(start, end + terminatorLength);
      const body = data.slice(bodyStart, end);
      const separator = body.indexOf(";");
      const controls = separator >= 0 ? body.slice(0, separator) : body;
      const message = separator >= 0 ? body.slice(separator + 1) : "";
      const imageId = Number(controls.match(/(?:^|,)i=(\d+)(?:,|$)/u)?.[1]);
      const placementIdValue = Number(controls.match(/(?:^|,)p=(\d+)(?:,|$)/u)?.[1]);
      if (Number.isInteger(imageId) && this.#ownsImage(imageId)) {
        graphics.push({
          imageId,
          ...(Number.isInteger(placementIdValue) ? { placementId: placementIdValue } : {}),
          message,
          raw
        });
      } else {
        residual += raw;
      }
      cursor = end + terminatorLength;
    }

    return { residual, graphics };
  }

  flush(): string {
    const tail = this.#tail;
    this.#tail = "";
    return tail;
  }
}
