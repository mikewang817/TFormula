import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ReaderDocument } from "../src/reader-document.js";
import { ReaderFileWatcher, readerWatchPaths } from "../src/reader-watch.js";

describe("reader live file watching", () => {
  it("watches the document and deduplicated local image resources", () => {
    const document = {
      path: "/tmp/notes.md",
      images: new Map([
        ["one", { url: "one", path: "/tmp/figure.png" }],
        ["duplicate", { url: "duplicate", path: "/tmp/figure.png" }],
        ["remote", { url: "https://example.com/figure.png" }]
      ])
    } as unknown as ReaderDocument;

    expect(readerWatchPaths(document)).toEqual([
      "/tmp/notes.md",
      "/tmp/figure.png"
    ]);
  });

  it("survives an editor-style atomic replacement", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tformula-reader-watch-"));
    const path = join(directory, "notes.md");
    const staged = join(directory, ".notes.md.tmp");
    await writeFile(path, "before\n");
    let watcher: ReaderFileWatcher | undefined;
    try {
      const changed = new Promise<string[]>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("file watcher timed out")), 3_000);
        watcher = new ReaderFileWatcher((paths) => {
          clearTimeout(timeout);
          resolve(paths);
        }, { debounceMs: 20 });
        watcher.update([path]);
      });

      await writeFile(staged, "after\n");
      await rename(staged, path);

      await expect(changed).resolves.toContain(path);
    } finally {
      watcher?.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 4_000);
});
