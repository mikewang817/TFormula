import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  unlink,
  utimes,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FormulaCache, formulaCacheKey } from "../src/formula-cache.js";

const roots: string[] = [];

async function cacheRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tformula-cache-test-"));
  roots.push(root);
  return root;
}

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return crc >>> 0;
});

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC32_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data = Buffer.alloc(0)): Buffer {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 4, "ascii");
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return chunk;
}

function validPng(marker = 1): Uint8Array {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(marker, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const pixels = Buffer.alloc(marker * 5);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND")
  ]);
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

  it("rejects a PNG that has a plausible header but is truncated before IEND", async () => {
    const root = await cacheRoot();
    const key = formulaCacheKey({ variant: "truncated-png" });
    const cache = new FormulaCache({ root });
    const path = join(cache.root, "png", key.slice(0, 2), `${key}.png`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, Buffer.from(validPng(3)).subarray(0, 33));

    let producers = 0;
    const png = await cache.getOrCreatePng(key, async () => {
      producers += 1;
      return validPng(11);
    });
    expect(producers).toBe(1);
    expect(png[23]).toBe(11);
  });

  it("rejects a framed PNG whose payload no longer matches its CRC", async () => {
    const root = await cacheRoot();
    const key = formulaCacheKey({ variant: "bad-crc" });
    const cache = new FormulaCache({ root });
    const path = join(cache.root, "png", key.slice(0, 2), `${key}.png`);
    await mkdir(dirname(path), { recursive: true });
    const corrupt = Buffer.from(validPng(3));
    const imageData = corrupt.indexOf("IDAT", 0, "ascii") + 4;
    corrupt[imageData] ^= 0xff;
    await writeFile(path, corrupt);

    let producers = 0;
    const png = await cache.getOrCreatePng(key, async () => {
      producers += 1;
      return validPng(5);
    });
    expect(producers).toBe(1);
    expect(png[23]).toBe(5);
  });

  it("rejects a truncated SVG root and regenerates it", async () => {
    const root = await cacheRoot();
    const key = formulaCacheKey({ variant: "truncated-svg" });
    const cache = new FormulaCache({ root });
    const path = join(cache.root, "svg", key.slice(0, 2), `${key}.svg`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '<svg width="1ex"><g>');

    let producers = 0;
    const svg = await cache.getOrCreateSvg(key, async () => {
      producers += 1;
      return '<svg width="1ex"><g/></svg>';
    });
    expect(producers).toBe(1);
    expect(svg).toBe('<svg width="1ex"><g/></svg>');
  });

  it("recovers an abandoned lock immediately when its owner no longer exists", async () => {
    const root = await cacheRoot();
    const key = formulaCacheKey({ variant: "dead-lock-owner" });
    const cache = new FormulaCache({ root });
    const path = join(cache.root, "svg", key.slice(0, 2), `${key}.svg`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(`${path}.lock`, "2147483647\n");

    const started = Date.now();
    const svg = await cache.getOrCreateSvg(key, async () => '<svg width="1ex" height="1ex"/>');
    expect(svg).toContain("<svg");
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("removes its published lock when writing the owner record fails", async () => {
    const root = await cacheRoot();
    const key = formulaCacheKey({ variant: "failed-lock-initialization" });
    const cache = new FormulaCache({ root });
    const path = join(cache.root, "svg", key.slice(0, 2), `${key}.svg`);
    const lockPath = `${path}.lock`;
    await mkdir(dirname(path), { recursive: true });

    const probePath = join(root, "file-handle-prototype-probe");
    const probe = await open(probePath, "w");
    const fileHandlePrototype = Object.getPrototypeOf(probe) as {
      writeFile: (...args: unknown[]) => Promise<void>;
    };
    await probe.close();
    await rm(probePath, { force: true });

    const writeFailure = Object.assign(new Error("injected lock record failure"), { code: "EIO" });
    const writeSpy = vi.spyOn(fileHandlePrototype, "writeFile")
      .mockRejectedValueOnce(writeFailure);
    let producers = 0;
    try {
      await expect(cache.getOrCreateSvg(key, async () => {
        producers += 1;
        return '<svg width="1ex" height="1ex"/>';
      })).rejects.toBe(writeFailure);
    } finally {
      writeSpy.mockRestore();
    }

    expect(producers).toBe(0);
    await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("expires an old lock even when its recorded PID is currently alive", async () => {
    const root = await cacheRoot();
    const key = formulaCacheKey({ variant: "reused-live-pid" });
    const cache = new FormulaCache({ root });
    const path = join(cache.root, "svg", key.slice(0, 2), `${key}.svg`);
    const lockPath = `${path}.lock`;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(lockPath, `${process.pid} abandoned-owner-token\n`);
    const expired = new Date(Date.now() - 60_000);
    await utimes(lockPath, expired, expired);

    const started = Date.now();
    const svg = await cache.getOrCreateSvg(
      key,
      async () => '<svg width="1ex" height="1ex"/>'
    );
    expect(svg).toContain("<svg");
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("does not let a fenced-out owner delete a replacement owner's lock", async () => {
    const root = await cacheRoot();
    const key = formulaCacheKey({ variant: "replacement-owner" });
    const cache = new FormulaCache({ root });
    const path = join(cache.root, "svg", key.slice(0, 2), `${key}.svg`);
    const lockPath = `${path}.lock`;

    let announceStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      announceStarted = resolve;
    });
    let releaseProducer!: () => void;
    const producerMayFinish = new Promise<void>((resolve) => {
      releaseProducer = resolve;
    });

    const result = cache.getOrCreateSvg(key, async () => {
      announceStarted();
      await producerMayFinish;
      return '<svg id="old-owner"/>';
    });
    await started;

    await unlink(lockPath);
    const replacementRecord = `${process.pid} replacement-owner-token\n`;
    await writeFile(lockPath, replacementRecord, { flag: "wx" });
    await writeFile(path, '<svg id="replacement-owner"/>');
    releaseProducer();

    expect(await result).toBe('<svg id="replacement-owner"/>');
    expect(await readFile(lockPath, "utf8")).toBe(replacementRecord);
  });
});
