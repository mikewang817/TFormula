import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  utimes,
  writeFile
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

type CacheKind = "svg" | "png";

interface CacheEntry {
  path: string;
  size: number;
  mtimeMs: number;
}

export interface FormulaCacheOptions {
  root?: string;
  memoryEntries?: number;
  maxDiskBytes?: number;
}

const CACHE_SCHEMA = "v1";
const DEFAULT_MAX_DISK_BYTES = 256 * 1024 * 1024;
const LOCK_STALE_MS = 30_000;
const LOCK_POLL_MS = 30;
const CLEANUP_WRITE_INTERVAL = 32;

function defaultCacheRoot(): string {
  if (process.env.TFORMULA_CACHE_DIR) return process.env.TFORMULA_CACHE_DIR;
  // Test runs must never populate or depend on the user's real cache.
  if (process.env.VITEST) return join(tmpdir(), `tformula-vitest-${process.pid}`);
  if (process.platform === "darwin") return join(homedir(), "Library", "Caches", "TFormula");
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "tformula");
}

function configuredMaxDiskBytes(): number {
  const megabytes = Number(process.env.TFORMULA_CACHE_MAX_MB);
  return Number.isFinite(megabytes) && megabytes > 0
    ? Math.floor(megabytes * 1024 * 1024)
    : DEFAULT_MAX_DISK_BYTES;
}

export function formulaCacheKey(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function isValid(kind: CacheKind, data: Buffer): boolean {
  if (kind === "svg") return /<svg(?:\s|>)/u.test(data.subarray(0, 256).toString("utf8"));
  return data.length >= 24
    && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    && data.subarray(12, 16).toString("ascii") === "IHDR";
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export class FormulaCache {
  readonly root: string;
  readonly #memoryEntries: number;
  readonly #maxDiskBytes: number;
  readonly #memory = new Map<string, Buffer>();
  readonly #inFlight = new Map<string, Promise<Buffer>>();
  #cleanupRunning = false;
  #hasCleaned = false;
  #writesSinceCleanup = 0;

  constructor(options: FormulaCacheOptions = {}) {
    this.root = join(options.root ?? defaultCacheRoot(), CACHE_SCHEMA);
    this.#memoryEntries = Math.max(1, options.memoryEntries ?? 256);
    this.#maxDiskBytes = Math.max(0, options.maxDiskBytes ?? configuredMaxDiskBytes());
  }

  async getSvg(key: string): Promise<string | undefined> {
    const data = await this.#read("svg", key);
    return data?.toString("utf8");
  }

  async getPng(key: string): Promise<Buffer | undefined> {
    return this.#read("png", key);
  }

  async getOrCreateSvg(key: string, create: () => Promise<string>): Promise<string> {
    const data = await this.#getOrCreate("svg", key, async () => Buffer.from(await create(), "utf8"));
    return data.toString("utf8");
  }

  async getOrCreatePng(key: string, create: () => Promise<Uint8Array>): Promise<Buffer> {
    return this.#getOrCreate("png", key, async () => Buffer.from(await create()));
  }

  clearMemory(): void {
    this.#memory.clear();
  }

  async clearDisk(): Promise<void> {
    this.#memory.clear();
    await rm(this.root, { force: true, recursive: true });
  }

  #memoryKey(kind: CacheKind, key: string): string {
    return `${kind}:${key}`;
  }

  #path(kind: CacheKind, key: string): string {
    const extension = kind === "svg" ? "svg" : "png";
    return join(this.root, kind, key.slice(0, 2), `${key}.${extension}`);
  }

  #remember(kind: CacheKind, key: string, data: Buffer): Buffer {
    const memoryKey = this.#memoryKey(kind, key);
    this.#memory.delete(memoryKey);
    this.#memory.set(memoryKey, data);
    while (this.#memory.size > this.#memoryEntries) {
      this.#memory.delete(this.#memory.keys().next().value!);
    }
    return data;
  }

  async #read(kind: CacheKind, key: string): Promise<Buffer | undefined> {
    const memoryKey = this.#memoryKey(kind, key);
    const memory = this.#memory.get(memoryKey);
    if (memory) return this.#remember(kind, key, memory);

    const path = this.#path(kind, key);
    try {
      const data = await readFile(path);
      if (!isValid(kind, data)) {
        await rm(path, { force: true });
        return undefined;
      }
      const now = new Date();
      void utimes(path, now, now).catch(() => undefined);
      return this.#remember(kind, key, data);
    } catch (error) {
      if (isCode(error, "ENOENT")) return undefined;
      throw error;
    }
  }

  async #getOrCreate(
    kind: CacheKind,
    key: string,
    create: () => Promise<Buffer>
  ): Promise<Buffer> {
    const cached = await this.#read(kind, key);
    if (cached) return cached;

    const inFlightKey = this.#memoryKey(kind, key);
    const existing = this.#inFlight.get(inFlightKey);
    if (existing) return existing;

    const promise = this.#createWithLock(kind, key, create).finally(() => {
      this.#inFlight.delete(inFlightKey);
    });
    this.#inFlight.set(inFlightKey, promise);
    return promise;
  }

  async #createWithLock(
    kind: CacheKind,
    key: string,
    create: () => Promise<Buffer>
  ): Promise<Buffer> {
    const path = this.#path(kind, key);
    const lockPath = `${path}.lock`;
    await mkdir(dirname(path), { recursive: true });

    let lock: Awaited<ReturnType<typeof open>> | undefined;
    while (!lock) {
      try {
        lock = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
        await lock.writeFile(`${process.pid}\n`);
      } catch (error) {
        if (!isCode(error, "EEXIST")) throw error;
        const cached = await this.#read(kind, key);
        if (cached) return cached;
        try {
          const lockInfo = await stat(lockPath);
          if (Date.now() - lockInfo.mtimeMs > LOCK_STALE_MS) {
            await unlink(lockPath).catch(() => undefined);
            continue;
          }
        } catch (statError) {
          if (!isCode(statError, "ENOENT")) throw statError;
          continue;
        }
        await sleep(LOCK_POLL_MS);
      }
    }

    try {
      const cached = await this.#read(kind, key);
      if (cached) return cached;
      const data = await create();
      if (!isValid(kind, data)) throw new Error(`refusing to cache invalid ${kind} data`);

      const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, data, { flag: "wx" });
        await rename(temporary, path);
      } finally {
        await rm(temporary, { force: true });
      }
      this.#startCleanup();
      return this.#remember(kind, key, data);
    } finally {
      await lock.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
    }
  }

  #startCleanup(): void {
    if (this.#maxDiskBytes === 0) return;
    this.#writesSinceCleanup += 1;
    if (this.#cleanupRunning || (this.#hasCleaned
      && this.#writesSinceCleanup < CLEANUP_WRITE_INTERVAL)) return;
    this.#cleanupRunning = true;
    this.#writesSinceCleanup = 0;
    void this.#trimDisk()
      .catch(() => undefined)
      .finally(() => {
        this.#cleanupRunning = false;
        this.#hasCleaned = true;
        if (this.#writesSinceCleanup >= CLEANUP_WRITE_INTERVAL) this.#startCleanup();
      });
  }

  async #trimDisk(): Promise<void> {
    const entries: CacheEntry[] = [];
    const visit = async (directory: string): Promise<void> => {
      let children;
      try {
        children = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (isCode(error, "ENOENT")) return;
        throw error;
      }
      await Promise.all(children.map(async (child) => {
        const path = join(directory, child.name);
        if (child.isDirectory()) return visit(path);
        if (child.name.endsWith(".lock") || child.name.endsWith(".tmp")) return;
        const info = await stat(path);
        entries.push({ path, size: info.size, mtimeMs: info.mtimeMs });
      }));
    };
    await visit(this.root);

    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    if (total <= this.#maxDiskBytes) return;
    entries.sort((left, right) => left.mtimeMs - right.mtimeMs);
    for (const entry of entries) {
      if (total <= this.#maxDiskBytes) break;
      await rm(entry.path, { force: true });
      total -= entry.size;
    }
  }
}

export const sharedFormulaCache = new FormulaCache();
