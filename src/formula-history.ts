import { randomUUID } from "node:crypto";
import {
  appendFile,
  chmod,
  mkdir,
  readFile,
  readdir,
  rm
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import type {
  FormulaRenderedEvent,
  HistoryCliOptions
} from "./types.js";

const HISTORY_VERSION = 1;
const DEFAULT_HISTORY_LIMIT = 20;
const MAX_HISTORY_LIMIT = 1_000;
const MAX_FORMULAS_PER_SESSION = 1_000;
const MAX_LATEX_LENGTH = 8_192;

export interface FormulaHistoryEntry {
  version: 1;
  id: string;
  sessionId: string;
  recordedAt: string;
  latex: string;
  display: boolean;
  confidence: "explicit" | "inferred";
  command?: string[];
  cwd?: string;
}

interface FormulaHistoryStoreOptions {
  root?: string;
  sessionId?: string;
  now?: () => Date;
  createId?: () => string;
  command?: string[];
  cwd?: string;
  debug?: (message: string) => void;
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function defaultHistoryRoot(): string {
  if (process.env.TFORMULA_HISTORY_DIR) return process.env.TFORMULA_HISTORY_DIR;
  // Never read or write a developer's real history during tests.
  if (process.env.VITEST) return join(process.env.TMPDIR ?? "/tmp", `tformula-history-vitest-${process.pid}`);
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "TFormula", "history");
  }
  return join(
    process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
    "tformula",
    "history"
  );
}

function safeSessionId(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]/gu, "_").slice(0, 160);
  return safe || randomUUID();
}

function validEntry(value: unknown): value is FormulaHistoryEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<FormulaHistoryEntry>;
  return entry.version === HISTORY_VERSION
    && typeof entry.id === "string"
    && entry.id.length > 0
    && entry.id.length <= 160
    && typeof entry.sessionId === "string"
    && entry.sessionId.length > 0
    && typeof entry.recordedAt === "string"
    && Number.isFinite(Date.parse(entry.recordedAt))
    && typeof entry.latex === "string"
    && entry.latex.length > 0
    && entry.latex.length <= MAX_LATEX_LENGTH
    && typeof entry.display === "boolean"
    && (entry.confidence === "explicit" || entry.confidence === "inferred")
    && (entry.command === undefined
      || (Array.isArray(entry.command) && entry.command.every((part) => typeof part === "string")))
    && (entry.cwd === undefined || typeof entry.cwd === "string");
}

async function historyFiles(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => join(root, entry.name));
  } catch (error) {
    if (isCode(error, "ENOENT")) return [];
    throw error;
  }
}

function parseHistoryFile(contents: string, debug: (message: string) => void): FormulaHistoryEntry[] {
  const entries: FormulaHistoryEntry[] = [];
  let malformed = 0;
  for (const line of contents.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (validEntry(value)) entries.push(value);
      else malformed += 1;
    } catch {
      malformed += 1;
    }
  }
  if (malformed > 0) debug(`formula history ignored ${malformed} malformed record(s)`);
  return entries;
}

export class FormulaHistoryStore {
  readonly #root: string;
  readonly #sessionId: string;
  readonly #path: string;
  readonly #now: () => Date;
  readonly #createId: () => string;
  readonly #command?: string[];
  readonly #cwd?: string;
  readonly #debug: (message: string) => void;
  #pending = Promise.resolve();
  #recorded = 0;
  #limitReported = false;
  readonly #seenFormulaKeys = new Set<string>();

  constructor(options: FormulaHistoryStoreOptions = {}) {
    this.#root = options.root ?? defaultHistoryRoot();
    this.#sessionId = safeSessionId(
      options.sessionId ?? `${new Date().toISOString().replace(/[:.]/gu, "-")}-${process.pid}-${randomUUID()}`
    );
    this.#path = join(this.#root, `${this.#sessionId}.jsonl`);
    this.#now = options.now ?? (() => new Date());
    this.#createId = options.createId ?? randomUUID;
    this.#command = options.command ? [...options.command] : undefined;
    this.#cwd = options.cwd;
    this.#debug = options.debug ?? (() => undefined);
  }

  record(event: FormulaRenderedEvent): void {
    if (this.#recorded >= MAX_FORMULAS_PER_SESSION) {
      if (!this.#limitReported) {
        this.#limitReported = true;
        this.#debug(`formula history reached the per-session limit (${MAX_FORMULAS_PER_SESSION})`);
      }
      return;
    }
    if (!event.latex || event.latex.length > MAX_LATEX_LENGTH) {
      this.#debug(`formula history skipped invalid source (${event.latex.length} chars)`);
      return;
    }
    const formulaKey = `${event.display ? "display" : "inline"}\0${event.latex}`;
    if (this.#seenFormulaKeys.has(formulaKey)) {
      this.#debug(
        `formula history skipped duplicate (${event.display ? "display" : "inline"}, ${event.latex.length} chars)`
      );
      return;
    }
    this.#seenFormulaKeys.add(formulaKey);
    this.#recorded += 1;
    const recordedAt = this.#now().toISOString();
    const entry: FormulaHistoryEntry = {
      version: HISTORY_VERSION,
      id: this.#createId(),
      sessionId: this.#sessionId,
      recordedAt,
      latex: event.latex,
      display: event.display,
      confidence: event.confidence,
      ...(this.#command ? { command: [...this.#command] } : {}),
      ...(this.#cwd ? { cwd: this.#cwd } : {})
    };
    this.#pending = this.#pending.then(async () => {
      await mkdir(this.#root, { recursive: true, mode: 0o700 });
      // Existing directories can have been created under a permissive umask.
      // History contains plaintext formulas, so tighten both levels explicitly.
      await chmod(this.#root, 0o700);
      await appendFile(this.#path, `${JSON.stringify(entry)}\n`, {
        encoding: "utf8",
        mode: 0o600
      });
      await chmod(this.#path, 0o600);
      this.#debug(
        `formula history recorded ${entry.id} (${entry.display ? "display" : "inline"}, ${entry.latex.length} chars)`
      );
    }).catch((error) => {
      // A history failure must never interrupt the wrapped Agent.
      this.#debug(`formula history write failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  async flush(): Promise<void> {
    await this.#pending;
  }

  async list(limit = DEFAULT_HISTORY_LIMIT): Promise<FormulaHistoryEntry[]> {
    await this.flush();
    const boundedLimit = Math.max(1, Math.min(MAX_HISTORY_LIMIT, Math.floor(limit)));
    const files = await historyFiles(this.#root);
    const batches = await Promise.all(files.map(async (path) => {
      try {
        return parseHistoryFile(await readFile(path, "utf8"), this.#debug);
      } catch (error) {
        this.#debug(`formula history read failed for ${path}: ${error instanceof Error ? error.message : String(error)}`);
        return [];
      }
    }));
    const entries = batches.flat().sort((left, right) => {
      const byTime = Date.parse(right.recordedAt) - Date.parse(left.recordedAt);
      return byTime || right.id.localeCompare(left.id);
    }).slice(0, boundedLimit);
    this.#debug(`formula history loaded ${entries.length} record(s) from ${files.length} session file(s)`);
    return entries;
  }

  async resolve(selector: string): Promise<FormulaHistoryEntry> {
    const entries = await this.list(MAX_HISTORY_LIMIT);
    if (selector === "last") {
      const entry = entries[0];
      if (entry) return entry;
      throw new Error("formula history is empty");
    }
    const exact = entries.find((entry) => entry.id === selector);
    if (exact) return exact;
    const matches = entries.filter((entry) => entry.id.startsWith(selector));
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) throw new Error(`formula history id prefix is ambiguous: ${selector}`);
    throw new Error(`formula history entry not found: ${selector}`);
  }

  async clear(): Promise<number> {
    await this.flush();
    const files = await historyFiles(this.#root);
    await Promise.all(files.map((path) => rm(path, { force: true })));
    this.#debug(`formula history cleared ${files.length} session file(s)`);
    return files.length;
  }
}

function historySummary(entry: FormulaHistoryEntry): string {
  const source = entry.latex.replace(/\s+/gu, " ").trim();
  const shortened = source.length > 80 ? `${source.slice(0, 77)}...` : source;
  return [
    entry.id.slice(0, 12).padEnd(12),
    entry.recordedAt,
    (entry.display ? "display" : "inline").padEnd(7),
    shortened
  ].join("  ");
}

export async function runHistoryCommand(
  options: HistoryCliOptions,
  debug: (message: string) => void
): Promise<number> {
  const store = new FormulaHistoryStore({ debug });
  if (options.clear) {
    const cleared = await store.clear();
    process.stdout.write(`Cleared ${cleared} formula history session file(s).\n`);
    return 0;
  }
  const entries = await store.list(options.limit);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
  } else if (entries.length === 0) {
    process.stdout.write("No recorded formulas.\n");
  } else {
    process.stdout.write(`${entries.map(historySummary).join("\n")}\n`);
  }
  return 0;
}

export const formulaHistoryInternals = {
  constants: {
    DEFAULT_HISTORY_LIMIT,
    MAX_HISTORY_LIMIT,
    MAX_FORMULAS_PER_SESSION,
    MAX_LATEX_LENGTH
  },
  defaultHistoryRoot,
  historySummary,
  parseHistoryFile,
  validEntry
};
