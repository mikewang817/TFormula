const ESC = "\x1b";
const APC_START = `${ESC}_G`;
const ST = `${ESC}\\`;

export const TFORMULA_Z_INDEX = 20_260_713;
export const TFORMULA_IMAGE_ID_MIN = 1_400_000_000;
export const TFORMULA_IMAGE_ID_MAX = 1_999_999_999;

export function kittyDeleteImage(imageId: number): string {
  return `${APC_START}a=d,d=I,i=${imageId},q=2${ST}`;
}

/** Delete one placement while retaining the shared image data in the terminal. */
export function kittyDeletePlacement(imageId: number, placementId: number): string {
  return `${APC_START}a=d,d=i,i=${imageId},p=${placementId},q=2${ST}`;
}

export function kittyDeleteByZIndex(): string {
  return `${APC_START}a=d,d=Z,z=${TFORMULA_Z_INDEX},q=2${ST}`;
}

export function kittyTransmitAndPlace(
  png: Uint8Array,
  imageId: number,
  columns: number,
  rows: number
): string {
  const base64 = Buffer.from(png).toString("base64");
  const chunkSize = 4096;
  const chunks: string[] = [];

  for (let offset = 0; offset < base64.length; offset += chunkSize) {
    chunks.push(base64.slice(offset, offset + chunkSize));
  }
  if (chunks.length === 0) chunks.push("");

  return chunks.map((chunk, index) => {
    const first = index === 0;
    const more = index < chunks.length - 1 ? 1 : 0;
    // Suppress acknowledgements for intermediate chunks, but request one for
    // the final packet.  The cache must distinguish "queued to stdout" from
    // "accepted by the terminal" before it can reset an error retry budget.
    const quiet = more ? 1 : 0;
    const controls = first
      ? `a=T,f=100,t=d,i=${imageId},q=${quiet},c=${columns},r=${rows},C=1,z=${TFORMULA_Z_INDEX},m=${more}`
      : `m=${more},q=${quiet}`;
    return `${APC_START}${controls};${chunk}${ST}`;
  }).join("");
}

/** Upload PNG data without creating a placement. */
export function kittyTransmitImage(png: Uint8Array, imageId: number): string {
  const base64 = Buffer.from(png).toString("base64");
  const chunks = base64.match(/.{1,4096}/gu) ?? [""];
  return chunks.map((chunk, index) => {
    const first = index === 0;
    const more = index < chunks.length - 1 ? 1 : 0;
    const quiet = more ? 1 : 0;
    const controls = first
      ? `a=t,f=100,t=d,i=${imageId},q=${quiet},m=${more}`
      : `m=${more},q=${quiet}`;
    return `${APC_START}${controls};${chunk}${ST}`;
  }).join("");
}

/** Upload a PNG through a terminal-owned temporary file. */
export function kittyTransmitImageFile(path: string, imageId: number): string {
  const encodedPath = Buffer.from(path, "utf8").toString("base64");
  return `${APC_START}a=t,f=100,t=t,i=${imageId},q=0;${encodedPath}${ST}`;
}

/** Place image data that has already been uploaded to the terminal. */
export function kittyPlaceImage(
  imageId: number,
  placementId: number,
  columns: number,
  rows: number
): string {
  return `${APC_START}a=p,i=${imageId},p=${placementId},q=0,c=${columns},r=${rows},C=1,z=${TFORMULA_Z_INDEX}${ST}`;
}

export function cursorPosition(row: number, column: number): string {
  return `${ESC}[${Math.max(1, row)};${Math.max(1, column)}H`;
}

export function synchronizedOutput(content: string): string {
  return `${ESC}[?2026h${content}${ESC}[?2026l`;
}
