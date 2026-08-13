import { fork, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type RasterFailureCode =
  | "raster-limit"
  | "empty-raster"
  | "png-limit"
  | "raster-error";

export class RasterWorkerError extends Error {
  constructor(readonly code: RasterFailureCode, message: string) {
    super(message);
    this.name = "RasterWorkerError";
  }
}

interface RasterRequest {
  id: number;
  svg: string;
  loadSystemFonts: boolean;
  fontFiles?: string[];
  maxDimension: number;
  maxPngBytes: number;
}

interface RasterResponse {
  id: number;
  ok: boolean;
  png?: Buffer;
  code?: RasterFailureCode;
  message?: string;
}

interface PendingRequest {
  child: ChildProcess;
  resolve: (png: Buffer) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const WORKER_TIMEOUT_MS = 15_000;
let worker: ChildProcess | undefined;
let nextRequestId = 1;
const pending = new Map<number, PendingRequest>();

function workerUnavailable(message: string): RasterWorkerError {
  return new RasterWorkerError("raster-error", `formula rasterization failed: ${message}`);
}

function releaseWorkerIfIdle(child: ChildProcess): void {
  if ([...pending.values()].some((request) => request.child === child)) return;
  child.unref();
  child.channel?.unref();
}

function rejectPending(child: ChildProcess, error: Error): void {
  for (const [id, request] of pending) {
    if (request.child !== child) continue;
    clearTimeout(request.timer);
    request.reject(error);
    pending.delete(id);
  }
}

function workerModulePath(): string {
  const adjacent = fileURLToPath(new URL("./resvg-worker.js", import.meta.url));
  if (existsSync(adjacent)) return adjacent;
  // Vitest imports TypeScript from src/ after `npm run build`; production
  // imports the adjacent dist file directly.
  return fileURLToPath(new URL("../dist/resvg-worker.js", import.meta.url));
}

function startWorker(): ChildProcess {
  const child = fork(workerModulePath(), [], {
    // Do not inherit test runners, loaders, --input-type, or debugger ports
    // from the Agent's Node process. The worker is already compiled ESM.
    execArgv: [],
    serialization: "advanced",
    stdio: ["ignore", "ignore", "ignore", "ipc"]
  });
  worker = child;

  child.on("message", (value: RasterResponse) => {
    if (!value || !Number.isSafeInteger(value.id)) return;
    const request = pending.get(value.id);
    if (!request) return;
    pending.delete(value.id);
    clearTimeout(request.timer);
    if (value.ok && Buffer.isBuffer(value.png)) request.resolve(value.png);
    else request.reject(new RasterWorkerError(
      value.code ?? "raster-error",
      value.message ?? "formula rasterization failed"
    ));
    releaseWorkerIfIdle(child);
  });
  child.on("error", (error) => {
    if (worker === child) worker = undefined;
    rejectPending(child, workerUnavailable(error.message));
  });
  child.on("exit", (code, signal) => {
    if (worker === child) worker = undefined;
    rejectPending(child, workerUnavailable(
      `isolated renderer exited${signal ? ` on ${signal}` : ` with code ${code ?? "unknown"}`}`
    ));
  });
  releaseWorkerIfIdle(child);
  return child;
}

export function rasterizeSvgIsolated(options: Omit<RasterRequest, "id">): Promise<Buffer> {
  const child = worker?.connected ? worker : startWorker();
  const id = nextRequestId++;
  child.ref();
  child.channel?.ref();

  return new Promise<Buffer>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!pending.delete(id)) return;
      reject(workerUnavailable(`isolated renderer timed out after ${WORKER_TIMEOUT_MS} ms`));
      child.kill("SIGKILL");
    }, WORKER_TIMEOUT_MS);
    timer.unref();
    pending.set(id, { child, resolve, reject, timer });
    child.send({ id, ...options }, (error) => {
      if (!error) return;
      const request = pending.get(id);
      if (!request) return;
      pending.delete(id);
      clearTimeout(request.timer);
      request.reject(workerUnavailable(error.message));
      releaseWorkerIfIdle(child);
    });
  });
}

export function closeRasterWorker(): void {
  const child = worker;
  worker = undefined;
  if (!child) return;
  rejectPending(child, workerUnavailable("isolated renderer closed"));
  child.kill();
}
