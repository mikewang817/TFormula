export interface OutputSlice {
  data: string;
  checkpoint: boolean;
}

/**
 * Splits a streaming PTY transcript only at line boundaries. A checkpoint lets
 * the renderer place formulas before a large burst scrolls them out of view.
 * The line count is retained across PTY chunks.
 */
export class OutputCheckpointSplitter {
  #lineInterval: number;
  #linesSinceCheckpoint = 0;

  constructor(lineInterval: number) {
    this.#lineInterval = 1;
    this.setLineInterval(lineInterval);
  }

  setLineInterval(lineInterval: number): void {
    this.#lineInterval = Math.max(1, Math.floor(lineInterval));
  }

  push(data: string): OutputSlice[] {
    if (!data) return [];
    const slices: OutputSlice[] = [];
    let sliceStart = 0;
    for (let index = 0; index < data.length; index += 1) {
      if (data[index] !== "\n") continue;
      this.#linesSinceCheckpoint += 1;
      if (this.#linesSinceCheckpoint < this.#lineInterval) continue;
      slices.push({ data: data.slice(sliceStart, index + 1), checkpoint: true });
      sliceStart = index + 1;
      this.#linesSinceCheckpoint = 0;
    }
    if (sliceStart < data.length) slices.push({ data: data.slice(sliceStart), checkpoint: false });
    return slices;
  }
}
