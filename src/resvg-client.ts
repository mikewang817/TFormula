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
  id: number;
  child: ChildProcess;
  resolve: (png: Buffer) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const WORKER_TIMEOUT_MS = 15_000;
let worker: ChildProcess | undefined;
let nextRequestId = 1;
const intentionallyClosed = new WeakSet<ChildProcess>();
let activeRequest: PendingRequest | undefined;
const queuedRequests: Array<{
  id: number;
  options: Omit<RasterRequest, "id">;
  resolve: (png: Buffer) => void;
  reject: (error: Error) => void;
}> = [];
const MAX_QUEUED_REQUESTS = 2;

function workerUnavailable(message: string): RasterWorkerError {
  return new RasterWorkerError("raster-error", `formula rasterization failed: ${message}`);
}

function releaseWorkerIfIdle(child: ChildProcess): void {
  if (activeRequest?.child === child) return;
  child.unref();
  child.channel?.unref();
}

function rejectActive(error: Error): void {
  const request = activeRequest;
  activeRequest = undefined;
  if (!request) return;
  clearTimeout(request.timer);
  request.reject(error);
}

function rejectQueued(error: Error): void {
  while (queuedRequests.length > 0) queuedRequests.shift()!.reject(error);
}

function pump(): void {
  if (activeRequest || queuedRequests.length === 0) return;
  const next = queuedRequests.shift()!;
  const child = worker?.connected ? worker : startWorker();
  child.ref();
  child.channel?.ref();
  const timer = setTimeout(() => {
    if (activeRequest?.child !== child || activeRequest === undefined) return;
    rejectActive(workerUnavailable(`isolated renderer timed out after ${WORKER_TIMEOUT_MS} ms`));
    child.kill("SIGKILL");
    pump();
  }, WORKER_TIMEOUT_MS);
  timer.unref();
  activeRequest = { id: next.id, child, resolve: next.resolve, reject: next.reject, timer };
  child.send({ id: next.id, ...next.options }, (error) => {
    if (!error || activeRequest?.child !== child) return;
    rejectActive(workerUnavailable(error.message));
    pump();
  });
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
    const request = activeRequest;
    if (!request || request.id !== value.id) return;
    clearTimeout(request.timer);
    activeRequest = undefined;
    if (value.ok && Buffer.isBuffer(value.png)) request.resolve(value.png);
    else request.reject(new RasterWorkerError(
      value.code ?? "raster-error",
      value.message ?? "formula rasterization failed"
    ));
    releaseWorkerIfIdle(child);
    pump();
  });
  child.on("error", (error) => {
    if (worker === child) worker = undefined;
    if (activeRequest?.child !== child) return;
    rejectActive(workerUnavailable(error.message));
    rejectQueued(workerUnavailable(error.message));
  });
  child.on("exit", (code, signal) => {
    if (worker === child) worker = undefined;
    if (activeRequest?.child !== child) return;
    const failure = workerUnavailable(
      `isolated renderer exited${signal ? ` on ${signal}` : ` with code ${code ?? "unknown"}`}`
    );
    rejectActive(failure);
    rejectQueued(failure);
  });
  releaseWorkerIfIdle(child);
  return child;
}

export function rasterizeSvgIsolated(options: Omit<RasterRequest, "id">): Promise<Buffer> {
  const id = nextRequestId++;
  return new Promise<Buffer>((resolve, reject) => {
    while (queuedRequests.length >= MAX_QUEUED_REQUESTS) {
      queuedRequests.shift()!.reject(new RasterWorkerError(
        "raster-error",
        "formula rasterization request superseded by a newer viewport"
      ));
    }
    queuedRequests.push({ id, options, resolve, reject });
    pump();
  });
}

export function closeRasterWorker(): void {
  const child = worker;
  worker = undefined;
  rejectActive(workerUnavailable("isolated renderer closed"));
  rejectQueued(workerUnavailable("isolated renderer closed"));
  if (!child) return;
  intentionallyClosed.add(child);
  child.kill();
}

/** Reset process-local raster state between isolated test cases. */
export function resetRasterWorkerState(): void {
  closeRasterWorker();
}
