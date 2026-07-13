import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FormulaCache, formulaCacheKey } from "../src/formula-cache.js";

const roots: string[] = [];

async function cacheRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tformula-cache-test-"));
  roots.push(root);
  return root;
}

function validPng(marker = 0): Uint8Array {
  const png = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
  Buffer.from("IHDR").copy(png, 12);
  png[23] = marker;
  return png;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("FormulaCache", () => {
  it("shares a persistent entry between cache instances", async () => {
    const root = await cacheRoot();
    const key = formulaCacheKey({ latex: "E=mc^2" });
    const first = new FormulaCache({ root });
    await first.getOrCreateSvg(key, async () => '<svg width="1ex" height="1ex"/>');
    first.clearMemory();

    const second = new FormulaCache({ root });
    expect(await second.getSvg(key)).toBe('<svg width="1ex" height="1ex"/>');
  });

  it("runs one producer when independent instances request the same item concurrently", async () => {
    const root = await cacheRoot();
    const key = formulaCacheKey({ variant: "shared-png" });
    const first = new FormulaCache({ root });
    const second = new FormulaCache({ root });
    let producers = 0;
    const produce = async (): Promise<Uint8Array> => {
      producers += 1;
      await new Promise((resolve) => setTimeout(resolve, 80));
      return validPng(7);
    };

    const [left, right] = await Promise.all([
      first.getOrCreatePng(key, produce),
      second.getOrCreatePng(key, produce)
    ]);
    expect(producers).toBe(1);
    expect(left).toEqual(right);
  });

  it("rejects a corrupt disk entry and regenerates it", async () => {
    const root = await cacheRoot();
    const key = formulaCacheKey({ variant: "corrupt" });
    const cache = new FormulaCache({ root });
    const path = join(cache.root, "png", key.slice(0, 2), `${key}.png`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "not a png");
    let producers = 0;
    const png = await cache.getOrCreatePng(key, async () => {
      producers += 1;
      return validPng(9);
    });
    expect(producers).toBe(1);
    expect(png[23]).toBe(9);
  });
});
