interface WeightedCacheEntry<Value> {
  value: Value;
  bytes: number;
}

/** LRU storage bounded by both entry count and retained byte weight. */
export class WeightedLruCache<Value> {
  readonly #entries = new Map<string, WeightedCacheEntry<Value>>();
  #bytes = 0;

  constructor(
    readonly maxEntries: number,
    readonly maxBytes: number
  ) {}

  has(key: string): boolean {
    return this.#entries.has(key);
  }

  get(key: string): Value | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: Value, bytes: number): void {
    const previous = this.#entries.get(key);
    if (previous) {
      this.#bytes -= previous.bytes;
      this.#entries.delete(key);
    }
    const weight = Math.max(0, Math.floor(bytes));
    this.#entries.set(key, { value, bytes: weight });
    this.#bytes += weight;
    while (this.#entries.size > Math.max(0, this.maxEntries)
      || this.#bytes > Math.max(0, this.maxBytes)) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
  }

  delete(key: string): boolean {
    const entry = this.#entries.get(key);
    if (!entry) return false;
    this.#bytes -= entry.bytes;
    return this.#entries.delete(key);
  }

  clear(): void {
    this.#entries.clear();
    this.#bytes = 0;
  }

  get size(): number {
    return this.#entries.size;
  }

  get bytes(): number {
    return this.#bytes;
  }
}
