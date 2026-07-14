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

interface LockSnapshot {
  dev: number;
  ino: number;
  mtimeMs: number;
  contents: string;
  pid?: number;
  token?: string;
}

export interface FormulaCacheOptions {
  root?: string;
  memoryEntries?: number;
  maxDiskBytes?: number;
}

const CACHE_SCHEMA = "v1";
const DEFAULT_MAX_DISK_BYTES = 256 * 1024 * 1024;
const LOCK_STALE_MS = 30_000;
const LOCK_HEARTBEAT_MS = Math.max(1_000, Math.floor(LOCK_STALE_MS / 3));
const LOCK_POLL_MS = 30;
const CLEANUP_WRITE_INTERVAL = 32;
const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return crc >>> 0;
});

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

function crc32(data: Buffer, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let index = start; index < end; index += 1) {
    crc = CRC32_TABLE[(crc ^ data[index]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function isValid(kind: CacheKind, data: Buffer): boolean {
  if (kind === "svg") {
    const svg = data.toString("utf8").trim();
    return /^<svg(?:\s|>)/u.test(svg)
      && !svg.includes("\0")
      && /(?:\/>|<\/svg>)$/u.test(svg);
  }
  if (data.length < 45
    || !data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return false;
  }

  // A header-only/truncated PNG previously passed validation and was then
  // retried from the persistent cache after every terminal rejection. Walk
  // the chunk framing and CRCs through IEND so corrupt cache files are
  // regenerated instead of being sent to the terminal on every retry.
  let offset = 8;
  let first = true;
  let sawImageData = false;
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset);
    const chunkEnd = offset + 12 + length;
    if (chunkEnd > data.length) return false;
    const type = data.subarray(offset + 4, offset + 8).toString("ascii");
    const expectedCrc = data.readUInt32BE(offset + 8 + length);
    if (crc32(data, offset + 4, offset + 8 + length) !== expectedCrc) return false;
    if (first && (type !== "IHDR" || length !== 13)) return false;
    if (type === "IHDR"
      && (data.readUInt32BE(offset + 8) === 0 || data.readUInt32BE(offset + 12) === 0)) {
      return false;
    }
    if (type === "IDAT") sawImageData = true;
    if (type === "IEND") {
      return sawImageData && length === 0 && chunkEnd === data.length;
    }
    first = false;
    offset = chunkEnd;
  }
  return false;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function isUnavailableDisk(error: unknown): boolean {
  return ["EACCES", "EDQUOT", "ENOSPC", "ENOTDIR", "EPERM", "EROFS"]
    .some((code) => isCode(error, code));
}

function parseLockOwner(contents: string): Pick<LockSnapshot, "pid" | "token"> {
  const match = /^(\d+)(?:\s+(\S+))?\s*$/u.exec(contents);
  if (!match) return {};
  const pid = Number.parseInt(match[1]!, 10);
  if (!Number.isSafeInteger(pid) || pid <= 0) return {};
  return { pid, token: match[2] };
}

async function readLockSnapshot(lockPath: string): Promise<LockSnapshot | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(lockPath, constants.O_RDONLY);
    const info = await handle.stat();
    const contents = await handle.readFile("utf8");
    return {
      dev: info.dev,
      ino: info.ino,
      mtimeMs: info.mtimeMs,
      contents,
      ...parseLockOwner(contents)
    };
  } catch (error) {
    if (isCode(error, "ENOENT")) return undefined;
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function sameLock(left: LockSnapshot, right: LockSnapshot): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.contents === right.contents
    && left.token === right.token;
}

async function lockStillOwned(lockPath: string, expected: LockSnapshot): Promise<boolean> {
  const current = await readLockSnapshot(lockPath);
  return current !== undefined && sameLock(current, expected);
}

async function unlinkLockIfOwned(lockPath: string, expected: LockSnapshot): Promise<boolean> {
  // unlink(2) is path based, so take a fresh descriptor-backed snapshot just
  // before removing the name. In particular, never let an expired owner use a
  // blind unlink to delete a replacement owner's lock.
  const current = await readLockSnapshot(lockPath);
  if (!current || !sameLock(current, expected)) return false;
  try {
    const pathInfo = await stat(lockPath);
    if (pathInfo.dev !== expected.dev || pathInfo.ino !== expected.ino) return false;
    await unlink(lockPath);
    return true;
  } catch (error) {
    if (isCode(error, "ENOENT")) return false;
    throw error;
  }
}

function lockOwnerStatus(snapshot: LockSnapshot): "alive" | "gone" | "unknown" {
  const owner = snapshot.pid;
  if (owner === undefined) return "unknown";
  if (owner === process.pid) return "alive";
  try {
    process.kill(owner, 0);
    return "alive";
  } catch (error) {
    return isCode(error, "ESRCH") ? "gone" : "alive";
  }
}

function lockHasExpired(snapshot: LockSnapshot): boolean {
  if (Date.now() - snapshot.mtimeMs > LOCK_STALE_MS) return true;
  return lockOwnerStatus(snapshot) === "gone";
}

async function snapshotNewLock(
  lock: Awaited<ReturnType<typeof open>>,
  contents: string
): Promise<LockSnapshot> {
  const info = await lock.stat();
  return {
    dev: info.dev,
    ino: info.ino,
    mtimeMs: info.mtimeMs,
    contents,
    ...parseLockOwner(contents)
  };
}

function startLockHeartbeat(lock: Awaited<ReturnType<typeof open>>): NodeJS.Timeout {
  const heartbeat = setInterval(() => {
    const now = new Date();
    // Touch the descriptor, not the pathname. If this owner was fenced out,
    // it can only refresh its detached inode and cannot extend the new lease.
    void lock.utimes(now, now).catch(() => undefined);
  }, LOCK_HEARTBEAT_MS);
  heartbeat.unref();
  return heartbeat;
}

async function openNewLock(
  lockPath: string
): Promise<{
  handle: Awaited<ReturnType<typeof open>>;
  snapshot: LockSnapshot;
}> {
  const handle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
  const token = randomUUID();
  const contents = `${process.pid} ${token}\n`;
  const initial = await snapshotNewLock(handle, contents);
  try {
    await handle.writeFile(contents);
    return {
      handle,
      snapshot: {
        ...initial,
        mtimeMs: (await handle.stat()).mtimeMs
      }
    };
  } catch (error) {
    // open(O_EXCL) already published the pathname. A failed initialization
    // must not leave an empty/partial lock behind, but must also not blindly
    // unlink a path which another process has since replaced.
    await handle.close().catch(() => undefined);
    await unlinkLockIfOwned(lockPath, { ...initial, contents: "", token: undefined })
      .catch(() => undefined);
    // A partial write changes only contents, not the inode. Retry the cleanup
    // with an inode snapshot of the current path when it is still our file.
    try {
      const current = await readLockSnapshot(lockPath);
      if (current && current.dev === initial.dev && current.ino === initial.ino) {
        await unlinkLockIfOwned(lockPath, current);
      }
    } catch {
      // Preserve the initialization error; cleanup is best effort.
    }
    throw error;
  }
}

export class FormulaCache {
  readonly root: string;
  readonly #memoryEntries: number;
  readonly #maxDiskBytes: number;
  readonly #memory = new Map<string, Buffer>();
  readonly #inFlight = new Map<string, Promise<Buffer>>();
  #diskDisabled = false;
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

  async deleteSvg(key: string): Promise<void> {
    this.#memory.delete(this.#memoryKey("svg", key));
    if (this.#diskDisabled) return;
    try {
      await rm(this.#path("svg", key), { force: true });
    } catch (error) {
      if (!isUnavailableDisk(error)) throw error;
      this.#diskDisabled = true;
    }
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
    if (this.#diskDisabled) return undefined;

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
      if (isUnavailableDisk(error)) {
        this.#diskDisabled = true;
        return undefined;
      }
      throw error;
    }
  }

  async #createInMemory(
    kind: CacheKind,
    key: string,
    create: () => Promise<Buffer>
  ): Promise<Buffer> {
    const data = await create();
    if (!isValid(kind, data)) throw new Error(`refusing to cache invalid ${kind} data`);
    return this.#remember(kind, key, data);
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

    let produced: Promise<Buffer> | undefined;
    const produceOnce = (): Promise<Buffer> => {
      produced ??= create();
      return produced;
    };
    const createAvailable = async (): Promise<Buffer> => {
      if (this.#diskDisabled) return this.#createInMemory(kind, key, produceOnce);
      try {
        return await this.#createWithLock(kind, key, produceOnce);
      } catch (error) {
        if (!isUnavailableDisk(error)) throw error;
        this.#diskDisabled = true;
        return this.#createInMemory(kind, key, produceOnce);
      }
    };
    const promise = createAvailable().finally(() => {
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

    // If an owner is paused past the bounded lease, a successor may fence it
    // out. Retain an already-rendered value across reacquisition, but publish
    // it only while this process still owns the exact inode and owner token.
    let produced: Buffer | undefined;
    while (true) {
      let acquired:
        | {
          handle: Awaited<ReturnType<typeof open>>;
          snapshot: LockSnapshot;
        }
        | undefined;

      while (!acquired) {
        try {
          acquired = await openNewLock(lockPath);
        } catch (error) {
          if (!isCode(error, "EEXIST")) throw error;
          const cached = await this.#read(kind, key);
          if (cached) return cached;

          const observed = await readLockSnapshot(lockPath);
          if (!observed) continue;
          if (lockHasExpired(observed)) {
            if (await unlinkLockIfOwned(lockPath, observed)) continue;
            // The pathname changed while it was inspected. Retry against the
            // new owner instead of deleting it using the stale observation.
            continue;
          }
          await sleep(LOCK_POLL_MS);
        }
      }

      const { handle: lock, snapshot } = acquired;
      const heartbeat = startLockHeartbeat(lock);
      try {
        const cached = await this.#read(kind, key);
        if (cached) return cached;
        const data = produced ?? await create();
        produced = data;
        if (!isValid(kind, data)) throw new Error(`refusing to cache invalid ${kind} data`);

        // A lease can be taken over while the producer is suspended. Fence a
        // resumed old owner before it publishes or removes anything.
        if (!await lockStillOwned(lockPath, snapshot)) continue;

        const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, data, { flag: "wx" });
          if (!await lockStillOwned(lockPath, snapshot)) continue;
          await rename(temporary, path);
        } finally {
          await rm(temporary, { force: true });
        }
        this.#startCleanup();
        return this.#remember(kind, key, data);
      } finally {
        clearInterval(heartbeat);
        await lock.close().catch(() => undefined);
        await unlinkLockIfOwned(lockPath, snapshot).catch(() => undefined);
      }
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
