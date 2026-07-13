const ESC = "\x1b";
const APC_START = `${ESC}_G`;
const ST = `${ESC}\\`;

export const TFORMULA_Z_INDEX = 20_260_713;

export function kittyDeleteImage(imageId: number): string {
  return `${APC_START}a=d,d=I,i=${imageId},q=2${ST}`;
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
    const controls = first
      ? `a=T,f=100,t=d,i=${imageId},q=2,c=${columns},r=${rows},C=1,z=${TFORMULA_Z_INDEX},m=${more}`
      : `m=${more},q=2`;
    return `${APC_START}${controls};${chunk}${ST}`;
  }).join("");
}

export function cursorPosition(row: number, column: number): string {
  return `${ESC}[${Math.max(1, row)};${Math.max(1, column)}H`;
}

export function synchronizedOutput(content: string): string {
  return `${ESC}[?2026h${content}${ESC}[?2026l`;
}
