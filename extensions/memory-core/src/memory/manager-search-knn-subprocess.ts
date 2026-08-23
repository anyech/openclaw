// Parent-side subprocess boundary for synchronous sqlite-vec KNN work.
import { spawn } from "node:child_process";
import {
  isPidAlive,
  killProcessTree,
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "openclaw/plugin-sdk/process-runtime";
import type { VectorKnnChildInput, VectorKnnChildResult } from "./manager-search-knn.child.js";
import {
  isVectorKnnRow,
  type VectorKnnRequest,
  type VectorKnnResponse,
} from "./manager-search-knn.js";

const MAX_STDIN_BYTES = 1024 * 1024;
const MAX_STDOUT_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const GRACEFUL_KILL_GRACE_MS = 50;
const KILL_EXIT_TIMEOUT_MS = 2_000;
const MAX_CONCURRENT_VECTOR_KNN_CHILDREN = 2;

class VectorKnnSubprocessError extends Error {
  constructor(
    message: string,
    readonly code: "unavailable" | "failed" | "protocol" | "termination-timeout",
  ) {
    super(message);
    this.name = "VectorKnnSubprocessError";
  }
}

export type VectorKnnSubprocessExit = {
  pid: number | undefined;
  code: number | null;
  signal: NodeJS.Signals | null;
  pidAlive: boolean;
};

function resolveVectorKnnChildUrl(currentModuleUrl = import.meta.url): URL {
  return resolveRuntimeWorkerUrl({
    currentModuleUrl,
    sourceWorkerName: "manager-search-knn.child",
    distWorkerPath: "extensions/memory-core/memory-search-knn.child.js",
  });
}

function buildChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR"]) {
    if (env[name]) {
      childEnv[name] = env[name];
    }
  }
  return childEnv;
}

function toAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("memory vector KNN aborted");
}

type VectorKnnAdmission = {
  acquire: (signal?: AbortSignal) => Promise<() => void>;
  active: () => number;
  queued: () => number;
};

function createVectorKnnAdmission(maxConcurrent: number): VectorKnnAdmission {
  let active = 0;
  const waiters: Array<{
    signal?: AbortSignal;
    resolve: (release: () => void) => void;
    reject: (error: Error) => void;
    abort: () => void;
  }> = [];

  const releaseNext = (): void => {
    while (waiters.length > 0) {
      const next = waiters.shift()!;
      next.signal?.removeEventListener("abort", next.abort);
      if (next.signal?.aborted) {
        next.reject(toAbortError(next.signal));
        continue;
      }
      next.resolve(createRelease());
      return;
    }
    active -= 1;
  };
  const createRelease = (): (() => void) => {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      releaseNext();
    };
  };

  return {
    acquire: async (signal) => {
      if (signal?.aborted) {
        throw toAbortError(signal);
      }
      if (active < maxConcurrent) {
        active += 1;
        return createRelease();
      }
      return await new Promise<() => void>((resolve, reject) => {
        const waiter = {
          signal,
          resolve,
          reject,
          abort: () => {
            const index = waiters.indexOf(waiter);
            if (index >= 0) {
              waiters.splice(index, 1);
            }
            reject(toAbortError(signal!));
          },
        };
        waiters.push(waiter);
        signal?.addEventListener("abort", waiter.abort, { once: true });
        if (signal?.aborted) {
          waiter.abort();
        }
      });
    },
    active: () => active,
    queued: () => waiters.length,
  };
}

const vectorKnnAdmission = createVectorKnnAdmission(MAX_CONCURRENT_VECTOR_KNN_CHILDREN);

function parseChildResult(output: Buffer, maxRows: number): VectorKnnResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.toString("utf8"));
  } catch {
    throw new VectorKnnSubprocessError(
      "memory vector KNN child returned malformed JSON",
      "protocol",
    );
  }
  if (!parsed || typeof parsed !== "object" || !("status" in parsed)) {
    throw new VectorKnnSubprocessError(
      "memory vector KNN child returned an invalid envelope",
      "protocol",
    );
  }
  // SAFETY: the envelope object/status guard above narrows the only protocol discriminator.
  const result = parsed as VectorKnnChildResult;
  if (result.status === "failed") {
    throw new VectorKnnSubprocessError(result.error || "memory vector KNN child failed", "failed");
  }
  if (
    result.status !== "ok" ||
    !result.value ||
    !Array.isArray(result.value.rows) ||
    result.value.rows.length > maxRows ||
    result.value.rows.some((row) => !isVectorKnnRow(row)) ||
    typeof result.value.fallbackScanRequired !== "boolean"
  ) {
    throw new VectorKnnSubprocessError(
      "memory vector KNN child returned an invalid result",
      "protocol",
    );
  }
  return result.value;
}

type VectorKnnSubprocessParams = {
  databasePath: string;
  extensionPath?: string;
  request: VectorKnnRequest;
  signal?: AbortSignal;
  childUrl?: URL;
  onSpawn?: (pid: number | undefined) => void;
  onExit?: (exit: VectorKnnSubprocessExit) => void;
};

async function runVectorKnnWithAdmission(
  params: VectorKnnSubprocessParams,
  admission: VectorKnnAdmission,
  killExitTimeoutMs: number,
  terminateProcess: typeof killProcessTree = killProcessTree,
): Promise<VectorKnnResponse> {
  if (params.signal?.aborted) {
    throw toAbortError(params.signal);
  }
  const input: VectorKnnChildInput = {
    databasePath: params.databasePath,
    extensionPath: params.extensionPath,
    request: params.request,
  };
  const inputPayload = Buffer.from(JSON.stringify(input), "utf8");
  if (inputPayload.byteLength > MAX_STDIN_BYTES) {
    throw new VectorKnnSubprocessError("memory vector KNN child input is too large", "protocol");
  }

  const releaseAdmission = await admission.acquire(params.signal);
  if (params.signal?.aborted) {
    releaseAdmission();
    throw toAbortError(params.signal);
  }
  const childUrl = params.childUrl ?? resolveVectorKnnChildUrl();
  let child;
  try {
    child = spawn(process.execPath, resolveRuntimeWorkerArgv(childUrl), {
      detached: process.platform !== "win32",
      env: buildChildEnv(),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    releaseAdmission();
    throw new VectorKnnSubprocessError(
      error instanceof Error ? error.message : String(error),
      "unavailable",
    );
  }
  params.onSpawn?.(child.pid);

  return await new Promise<VectorKnnResponse>((resolve, reject) => {
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let closed = false;
    let callerSettled = false;
    let terminationReason: Error | undefined;
    let protocolFailure: Error | undefined;
    let killExitTimer: ReturnType<typeof setTimeout> | undefined;

    const clearKillExitTimer = () => {
      if (killExitTimer) {
        clearTimeout(killExitTimer);
        killExitTimer = undefined;
      }
    };
    const settleCaller = (action: () => void) => {
      if (callerSettled) {
        return;
      }
      callerSettled = true;
      params.signal?.removeEventListener("abort", abort);
      action();
    };
    const releaseClosedChild = () => {
      clearKillExitTimer();
      params.signal?.removeEventListener("abort", abort);
      releaseAdmission();
    };
    const requestTermination = (reason: Error) => {
      if (terminationReason || closed) {
        return;
      }
      terminationReason = reason;
      child.stdin.destroy();
      if (typeof child.pid === "number") {
        terminateProcess(child.pid, {
          detached: process.platform !== "win32",
          graceMs: GRACEFUL_KILL_GRACE_MS,
        });
      } else {
        child.kill("SIGKILL");
      }
      killExitTimer = setTimeout(() => {
        if (!closed) {
          if (typeof child.pid === "number") {
            terminateProcess(child.pid, {
              detached: process.platform !== "win32",
              force: true,
            });
          } else {
            child.kill("SIGKILL");
          }
          // The caller may return, but this child keeps its admission slot until
          // close. Destroying pipes and unref'ing prevents one unkillable OS task
          // from pinning the Gateway while the slot bounds future accumulation.
          child.stdin.destroy();
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref();
          settleCaller(() =>
            reject(
              new VectorKnnSubprocessError(
                "memory vector KNN child did not exit after SIGKILL",
                "termination-timeout",
              ),
            ),
          );
        }
      }, GRACEFUL_KILL_GRACE_MS + killExitTimeoutMs);
    };
    const abort = () => {
      requestTermination(toAbortError(params.signal!));
    };

    params.signal?.addEventListener("abort", abort, { once: true });
    if (params.signal?.aborted) {
      abort();
    }
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        protocolFailure = new VectorKnnSubprocessError(
          "memory vector KNN child stdout exceeded its limit",
          "protocol",
        );
        stdoutChunks.length = 0;
        requestTermination(protocolFailure);
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > MAX_STDERR_BYTES) {
        protocolFailure = new VectorKnnSubprocessError(
          "memory vector KNN child stderr exceeded its limit",
          "protocol",
        );
        requestTermination(protocolFailure);
      }
    });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (!terminationReason && error.code !== "EPIPE") {
        protocolFailure = new VectorKnnSubprocessError(error.message, "failed");
        requestTermination(protocolFailure);
      }
    });
    child.once("error", (error) => {
      protocolFailure = new VectorKnnSubprocessError(error.message, "unavailable");
      requestTermination(protocolFailure);
    });
    child.once("close", (code, signal) => {
      closed = true;
      const pidAlive = typeof child.pid === "number" && isPidAlive(child.pid);
      params.onExit?.({ pid: child.pid, code, signal, pidAlive });
      releaseClosedChild();
      settleCaller(() => {
        if (pidAlive) {
          reject(
            new VectorKnnSubprocessError(
              "memory vector KNN child PID remained alive after close",
              "termination-timeout",
            ),
          );
          return;
        }
        if (terminationReason) {
          reject(terminationReason);
          return;
        }
        if (protocolFailure) {
          reject(protocolFailure);
          return;
        }
        if (code !== 0 || signal) {
          reject(
            new VectorKnnSubprocessError(
              `memory vector KNN child exited before returning a result (code ${code}, signal ${signal ?? "none"})`,
              "failed",
            ),
          );
          return;
        }
        try {
          resolve(parseChildResult(Buffer.concat(stdoutChunks), params.request.limit));
        } catch (error) {
          reject(
            error instanceof Error
              ? error
              : new VectorKnnSubprocessError(String(error), "protocol"),
          );
        }
      });
    });
    child.stdin.end(inputPayload);
  });
}

/** Run one file-backed KNN query in a bounded, OS-killable child process. */
export async function runVectorKnnInSubprocess(
  params: VectorKnnSubprocessParams,
): Promise<VectorKnnResponse> {
  return await runVectorKnnWithAdmission(params, vectorKnnAdmission, KILL_EXIT_TIMEOUT_MS);
}

export const testing = {
  createVectorKnnAdmission,
  gracefulKillGraceMs: GRACEFUL_KILL_GRACE_MS,
  isProcessAlive: (pid: number | undefined) => (typeof pid === "number" ? isPidAlive(pid) : false),
  maxConcurrentChildren: MAX_CONCURRENT_VECTOR_KNN_CHILDREN,
  maxStderrBytes: MAX_STDERR_BYTES,
  maxStdoutBytes: MAX_STDOUT_BYTES,
  resolveVectorKnnChildUrl,
  runVectorKnnWithAdmission,
};
