import { watch, type FSWatcher } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type { ReaderDocument } from "./reader-document.js";

export const READER_WATCH_DEBOUNCE_MS = 100;

export interface ReaderFileWatcherOptions {
  debounceMs?: number;
  onError?: (error: Error) => void;
}

function normalizedName(value: string): string {
  return value.normalize("NFC");
}

/** Files whose changes can alter the active reader document. */
export function readerWatchPaths(document: ReaderDocument): string[] {
  const paths = new Set<string>([resolve(document.path)]);
  for (const resource of document.images.values()) {
    if (resource.path) paths.add(resolve(resource.path));
  }
  return [...paths];
}

/**
 * Watch parent directories instead of file inodes. Editors commonly save by
 * renaming a temporary file over the original, which can detach a file-level
 * watcher after the first update.
 */
export class ReaderFileWatcher {
  readonly #onChange: (paths: string[]) => void;
  readonly #onError?: (error: Error) => void;
  readonly #debounceMs: number;
  readonly #watchers = new Map<string, FSWatcher>();
  #targetsByDirectory = new Map<string, Map<string, string>>();
  readonly #pending = new Set<string>();
  #timer?: NodeJS.Timeout;
  #closed = false;

  constructor(
    onChange: (paths: string[]) => void,
    options: ReaderFileWatcherOptions = {}
  ) {
    this.#onChange = onChange;
    this.#onError = options.onError;
    this.#debounceMs = Math.max(0, options.debounceMs ?? READER_WATCH_DEBOUNCE_MS);
  }

  update(paths: Iterable<string>): void {
    if (this.#closed) return;
    const next = new Map<string, Map<string, string>>();
    const nextPaths = new Set<string>();
    for (const input of paths) {
      const path = resolve(input);
      nextPaths.add(path);
      const directory = dirname(path);
      let targets = next.get(directory);
      if (!targets) {
        targets = new Map();
        next.set(directory, targets);
      }
      targets.set(normalizedName(basename(path)), path);
    }
    this.#targetsByDirectory = next;
    for (const path of this.#pending) {
      if (!nextPaths.has(path)) this.#pending.delete(path);
    }
    if (this.#pending.size === 0 && this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }

    for (const [directory, watcher] of this.#watchers) {
      if (next.has(directory)) continue;
      watcher.close();
      this.#watchers.delete(directory);
    }
    for (const directory of next.keys()) {
      if (this.#watchers.has(directory)) continue;
      this.#watchDirectory(directory);
    }
  }

  #watchDirectory(directory: string): void {
    try {
      const watcher = watch(directory, { persistent: false }, (_event, filename) => {
        if (this.#closed) return;
        const targets = this.#targetsByDirectory.get(directory);
        if (!targets) return;
        if (filename === null) {
          for (const path of targets.values()) this.#schedule(path);
          return;
        }
        const name = normalizedName(
          Buffer.isBuffer(filename) ? filename.toString("utf8") : filename
        );
        const path = targets.get(name);
        if (path) this.#schedule(path);
      });
      watcher.on("error", (error) => {
        if (this.#watchers.get(directory) !== watcher) return;
        watcher.close();
        this.#watchers.delete(directory);
        this.#onError?.(error);
      });
      this.#watchers.set(directory, watcher);
    } catch (error) {
      this.#onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  #schedule(path: string): void {
    this.#pending.add(path);
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      if (this.#closed || this.#pending.size === 0) return;
      const changed = [...this.#pending];
      this.#pending.clear();
      this.#onChange(changed);
    }, this.#debounceMs);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#pending.clear();
    for (const watcher of this.#watchers.values()) watcher.close();
    this.#watchers.clear();
    this.#targetsByDirectory.clear();
  }
}
