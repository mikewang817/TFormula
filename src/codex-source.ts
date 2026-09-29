import { execFile } from "node:child_process";
import { open, realpath, stat, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { FormulaSource } from "./formula-source.js";

const exec = promisify(execFile);
const MAX_RECORD_BYTES = 8 * 1024 * 1024;

/** A requested UUID identifies a source even when resume is read-only/locked. */
export async function findCodexResumeSource(
  args: string[],
  root = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions")
): Promise<string | undefined> {
  const resume = args.indexOf("resume");
  if (resume < 0) return undefined;
  const id = args.slice(resume + 1).find((arg) =>
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(arg));
  if (!id) return undefined;
  const matches: string[] = [];
  const visit = async (directory: string, depth: number): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isFile() && entry.name.startsWith("rollout-")
        && entry.name.endsWith(`-${id}.jsonl`)) matches.push(join(directory, entry.name));
      else if (entry.isDirectory() && depth < 3 && /^\d{2,4}$/u.test(entry.name)) {
        await visit(join(directory, entry.name), depth + 1);
      }
    }
  };
  // Only filenames are inspected, and only the explicitly requested UUID can
  // be loaded. Never use newest-file or cwd heuristics across conversations.
  await visit(root, 0);
  return matches.length === 1 ? matches[0] : undefined;
}

/** Only discover files actually held open by this child and its descendants. */
export async function discoverCodexSession(pid: number): Promise<string | undefined> {
  const { stdout } = await exec("ps", ["-axo", "pid=,ppid="], { timeout: 1500, maxBuffer: 2 * 1024 * 1024 });
  const rows = stdout.trim().split("\n").map((line) => line.trim().split(/\s+/u).map(Number));
  const family = new Map([[pid, 0]]);
  for (let pass = 0; pass < 8; pass += 1) {
    const before = family.size;
    for (const [child, parent] of rows) if (family.has(parent!) && !family.has(child!)) {
      family.set(child!, family.get(parent!)! + 1);
    }
    if (family.size === before) break;
  }
  const files = await exec("lsof", ["-p", [...family.keys()].join(","), "-Fpn"], { timeout: 1500, maxBuffer: 4 * 1024 * 1024 });
  const paths = new Set<string>();
  let depth = Infinity;
  let nearest = Infinity;
  for (const line of files.stdout.split("\n")) {
    if (/^p\d+$/u.test(line)) depth = family.get(Number(line.slice(1))) ?? Infinity;
    if (!/^n.*\/rollout-[^/]+\.jsonl$/u.test(line) || depth > nearest) continue;
    if (depth < nearest) { paths.clear(); nearest = depth; }
    paths.add(line.slice(1));
  }
  // Prefer the main child over its subagents, but never guess at equal depth.
  return paths.size === 1 ? [...paths][0] : undefined;
}

export class CodexFormulaSource extends FormulaSource {
  #path?: string;
  #offset = 0;
  #tail = Buffer.alloc(0);
  #discardLine = false;
  #inode?: number;
  #busy?: Promise<boolean>;
  #lastDiscovery = 0;
  #closed = false;
  readonly #explicitPath?: string;
  readonly #followProcess: boolean;
  #pid?: number;
  readonly #debug: (message: string) => void;

  constructor(options: { path?: string; pid?: number; followProcess?: boolean; debug?: (message: string) => void }) {
    super();
    this.#explicitPath = options.path;
    this.#followProcess = options.followProcess ?? !options.path;
    this.#pid = options.pid;
    this.#debug = options.debug ?? (() => {});
  }

  close(): void { this.#closed = true; }
  setPid(pid: number): void { this.#pid = pid; }

  refresh(): Promise<boolean> {
    if (this.#closed) return Promise.resolve(false);
    return this.#busy ??= this.#read().catch((error) => {
      this.#debug(`Codex source unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }).finally(() => { this.#busy = undefined; });
  }

  async #read(): Promise<boolean> {
    let changed = false;
    let nextPath = this.#path;
    if (!nextPath && this.#explicitPath) nextPath = await realpath(this.#explicitPath);
    if (this.#followProcess && this.#pid && Date.now() - this.#lastDiscovery >= 1000) {
      this.#lastDiscovery = Date.now();
      // Revalidate the main process after /resume or /new. A missing/ambiguous
      // result must not discard a preloaded, possibly read-only resume source.
      const discovered = await discoverCodexSession(this.#pid).catch(() => undefined);
      if (discovered) nextPath = await realpath(discovered);
    }
    if (!nextPath) return false;
    if (nextPath !== this.#path) {
      changed = this.size > 0;
      this.clear(); this.#offset = 0; this.#tail = Buffer.alloc(0);
      this.#inode = undefined; this.#discardLine = false;
      this.#path = nextPath;
      this.#debug("connected to the Codex session formula source");
    }
    const info = await stat(this.#path);
    if (!info.isFile()) return changed;
    if (info.ino !== this.#inode || info.size < this.#offset) {
      changed = this.size > 0 || changed;
      this.clear(); this.#offset = 0; this.#tail = Buffer.alloc(0); this.#inode = info.ino;
      this.#discardLine = false;
    }
    if (info.size === this.#offset) return changed;
    const file = await open(this.#path, "r");
    try {
      // Incremental reads preserve split UTF-8 and partial JSON records. Only
      // assistant message text is indexed; user/tool/system content is ignored.
      while (this.#offset < info.size) {
        const chunk = Buffer.alloc(Math.min(256 * 1024, info.size - this.#offset));
        const { bytesRead } = await file.read(chunk, 0, chunk.length, this.#offset);
        if (!bytesRead) break;
        this.#offset += bytesRead;
        this.#tail = Buffer.concat([this.#tail, chunk.subarray(0, bytesRead)]);
        let newline: number;
        while ((newline = this.#tail.indexOf(10)) >= 0) {
          const line = this.#tail.subarray(0, newline);
          this.#tail = this.#tail.subarray(newline + 1);
          if (this.#discardLine) { this.#discardLine = false; continue; }
          if (line.length > MAX_RECORD_BYTES) continue;
          try {
            const record = JSON.parse(line.toString("utf8"));
            const payload = record?.payload;
            if (record?.type !== "response_item" || payload?.type !== "message"
              || payload?.role !== "assistant" || !Array.isArray(payload.content)) continue;
            for (const part of payload.content) {
              if (part?.type === "output_text" && typeof part.text === "string") {
                changed = this.addMarkdown(part.text) || changed;
              }
            }
          } catch { /* Ignore incomplete/foreign records, never alter the log. */ }
        }
        if (this.#discardLine || this.#tail.length > MAX_RECORD_BYTES) {
          this.#tail = Buffer.alloc(0); this.#discardLine = true;
        }
      }
    } finally { await file.close(); }
    return changed;
  }
}
