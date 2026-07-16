import { mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FormulaHistoryStore } from "../src/formula-history.js";

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tformula-history-test-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

describe("formula history", () => {
  it("records successful formulas in order without logging their contents", async () => {
    const root = await temporaryRoot();
    const debug: string[] = [];
    let tick = 0;
    const store = new FormulaHistoryStore({
      root,
      sessionId: "session-a",
      now: () => new Date(1_700_000_000_000 + tick++ * 1_000),
      createId: () => `entry-${tick}`,
      command: ["codex", "--resume"],
      cwd: "/work",
      debug: (message) => debug.push(message)
    });

    store.record({ latex: "x^2 + y^2 = z^2", display: true, confidence: "explicit" });
    store.record({ latex: "x^2 + y^2 = z^2", display: true, confidence: "explicit" });
    store.record({ latex: "\\alpha+\\beta", display: false, confidence: "inferred" });
    await store.flush();

    const entries = await store.list(20);
    expect(entries.map(({ latex }) => latex)).toEqual([
      "\\alpha+\\beta",
      "x^2 + y^2 = z^2"
    ]);
    expect(entries[1]).toMatchObject({
      id: "entry-1",
      sessionId: "session-a",
      display: true,
      confidence: "explicit",
      command: ["codex", "--resume"],
      cwd: "/work"
    });
    expect(debug).toContain("formula history recorded entry-1 (display, 15 chars)");
    expect(debug).toContain("formula history skipped duplicate (display, 15 chars)");
    expect(debug.join("\n")).not.toContain("x^2 + y^2");

    const files = await readdir(root);
    expect(files).toHaveLength(1);
    expect((await stat(join(root, files[0]!))).mode & 0o777).toBe(0o600);
  });

  it("ignores malformed records and resolves unique id prefixes", async () => {
    const root = await temporaryRoot();
    const store = new FormulaHistoryStore({
      root,
      sessionId: "session-b",
      createId: () => "abcdef123456",
      now: () => new Date("2026-07-16T10:00:00.000Z")
    });
    store.record({ latex: "\\int_0^1 x\\,dx", display: true, confidence: "explicit" });
    await store.flush();
    await writeFile(join(root, "broken.jsonl"), "not-json\n{\"version\":99}\n", {
      encoding: "utf8",
      mode: 0o600
    });

    await expect(store.resolve("last")).resolves.toMatchObject({ id: "abcdef123456" });
    await expect(store.resolve("abcdef")).resolves.toMatchObject({ latex: "\\int_0^1 x\\,dx" });
    await expect(store.resolve("missing")).rejects.toThrow("formula history entry not found");
  });

  it("clears all persisted sessions", async () => {
    const root = await temporaryRoot();
    const store = new FormulaHistoryStore({ root, sessionId: "session-c" });
    store.record({ latex: "E=mc^2", display: false, confidence: "explicit" });
    await store.flush();

    await expect(store.clear()).resolves.toBe(1);
    await expect(store.list(20)).resolves.toEqual([]);
  });
});
