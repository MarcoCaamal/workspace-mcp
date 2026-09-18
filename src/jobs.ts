import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, open, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { KILL_GRACE_MS, scrubbedEnv, stripAnsi } from "./shell.js";

export type JobStatus = "running" | "exited" | "killed" | "timed-out" | "failed-to-start";

/** Hard cap per job log; output past this point is discarded and flagged. */
export const MAX_LOG_BYTES = 64 * 1024 * 1024;

export const DEFAULT_MAX_RUNTIME_MS = 1_800_000;
export const MIN_MAX_RUNTIME_MS = 1_000;
export const MAX_MAX_RUNTIME_MS = 7_200_000;

export const DEFAULT_TAIL_BYTES = 8_192;
export const MAX_TAIL_BYTES = 262_144;

export const MAX_LISTED_JOBS = 20;

/**
 * Directory for job logs, resolved at call time so tests and parallel
 * instances can isolate their logs via WORKSPACE_MCP_JOB_DIR.
 * Logs live outside the workspace so they never show up in list_files or grep.
 */
export function jobLogDir(): string {
  const override = process.env.WORKSPACE_MCP_JOB_DIR?.trim();
  return override !== undefined && override !== "" ? override : path.join(tmpdir(), "workspace-mcp-jobs");
}

export function jobLogPath(jobId: string): string {
  return path.join(jobLogDir(), `${jobId}.log`);
}

/** Immutable view of a job, safe to hand to the tool layer. */
export interface JobSnapshot {
  id: string;
  name: string;
  status: JobStatus;
  /** True once the process has exited (or failed to start) and its log is flushed. */
  finished: boolean;
  pid: number | undefined;
  command: readonly string[];
  cwd: string;
  logPath: string;
  startedAt: number;
  endedAt: number | undefined;
  durationMs: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  maxRuntimeMs: number;
  logBytes: number;
  logCapped: boolean;
  spawnError: string | undefined;
}

export interface StartJobOptions {
  executable: string;
  args: readonly string[];
  cwd: string;
  name?: string;
  maxRuntimeMs?: number;
}

export interface JobLogTail {
  /** Raw bytes read from the end of the log, in file order. */
  buffer: Buffer;
  bytesRead: number;
  /** Total log file size in bytes. */
  size: number;
}

interface JobEntry {
  id: string;
  name: string;
  command: readonly string[];
  cwd: string;
  pid: number | undefined;
  logPath: string;
  startedAt: number;
  endedAt: number | undefined;
  status: JobStatus;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  killRequested: boolean;
  maxRuntimeMs: number;
  logBytes: number;
  logCapped: boolean;
  spawnError: string | undefined;
  settled: boolean;
  child: ChildProcess | undefined;
  timeoutTimer: NodeJS.Timeout | undefined;
  killTimer: NodeJS.Timeout | undefined;
  handle: FileHandle;
  writeChain: Promise<void>;
  finished: Promise<void>;
  resolveFinished: () => void;
}

/**
 * Process-global registry. Deliberately module-level and not per-server: the
 * HTTP stateless mode creates a fresh McpServer per request in the same
 * process, and jobs must remain visible across those instances. Nothing in a
 * job's lifecycle depends on a transport or connection, so client timeouts and
 * disconnects cannot lose the work.
 */
const registry = new Map<string, JobEntry>();

function clampRuntime(maxRuntimeMs: number | undefined): number {
  const requested = maxRuntimeMs ?? DEFAULT_MAX_RUNTIME_MS;
  return Math.min(Math.max(requested, MIN_MAX_RUNTIME_MS), MAX_MAX_RUNTIME_MS);
}

/**
 * Spawns a detached process group whose stdout+stderr append to a per-job log
 * file, and returns as soon as the process is started (no waiting for output).
 * The engine never throws for spawn failures: they are recorded as a
 * `failed-to-start` job so the caller can report a jobId consistently.
 */
export async function startJob(options: StartJobOptions): Promise<JobSnapshot> {
  const id = `job_${randomBytes(4).toString("hex")}`;
  const logPath = jobLogPath(id);
  await mkdir(jobLogDir(), { recursive: true });
  const handle = await open(logPath, "a");

  let resolveFinished: () => void = () => undefined;
  const finished = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });

  const trimmedName = options.name?.trim();
  const entry: JobEntry = {
    id,
    name:
      trimmedName !== undefined && trimmedName !== ""
        ? stripAnsi(trimmedName)
        : stripAnsi([options.executable, ...options.args].join(" ")).slice(0, 120),
    command: [options.executable, ...options.args],
    cwd: options.cwd,
    pid: undefined,
    logPath,
    startedAt: Date.now(),
    endedAt: undefined,
    status: "running",
    exitCode: null,
    signal: null,
    timedOut: false,
    killRequested: false,
    maxRuntimeMs: clampRuntime(options.maxRuntimeMs),
    logBytes: 0,
    logCapped: false,
    spawnError: undefined,
    settled: false,
    child: undefined,
    timeoutTimer: undefined,
    killTimer: undefined,
    handle,
    writeChain: Promise.resolve(),
    finished,
    resolveFinished,
  };
  registry.set(id, entry);

  const append = (chunk: Buffer): void => {
    if (entry.settled || entry.logCapped || chunk.length === 0) {
      return;
    }
    const remaining = MAX_LOG_BYTES - entry.logBytes;
    if (remaining <= 0) {
      entry.logCapped = true;
      return;
    }
    let slice = chunk;
    if (chunk.length > remaining) {
      slice = chunk.subarray(0, remaining);
      entry.logCapped = true;
    }
    entry.logBytes += slice.length;
    entry.writeChain = entry.writeChain.then(() => writeFully(handle, slice)).catch(() => undefined);
  };

  let child: ChildProcess;
  try {
    child = spawn(options.executable, [...options.args], {
      cwd: options.cwd,
      env: scrubbedEnv(),
      shell: false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    entry.spawnError = error instanceof Error ? error.message : String(error);
    await finalize(entry, "failed-to-start", null, null);
    return snapshot(entry);
  }

  entry.child = child;
  entry.pid = child.pid;

  child.stdout?.on("data", append);
  child.stderr?.on("data", append);

  entry.timeoutTimer = setTimeout(() => {
    if (entry.settled) {
      return;
    }
    entry.timedOut = true;
    entry.status = "timed-out";
    killGroup(entry, "SIGTERM");
    entry.killTimer = setTimeout(() => killGroup(entry, "SIGKILL"), KILL_GRACE_MS);
  }, entry.maxRuntimeMs);

  child.on("error", (error: NodeJS.ErrnoException) => {
    entry.spawnError = error.message;
    void finalize(entry, entry.timedOut ? "timed-out" : "failed-to-start", null, null);
  });

  child.on("close", (code, signal) => {
    const status: JobStatus = entry.timedOut
      ? "timed-out"
      : entry.killRequested
        ? "killed"
        : entry.spawnError !== undefined
          ? "failed-to-start"
          : "exited";
    void finalize(entry, status, code, signal);
  });

  return snapshot(entry);
}

/** 20 most recent jobs, newest first. Backed by Map insertion order. */
export function listJobs(limit: number = MAX_LISTED_JOBS): JobSnapshot[] {
  const all = [...registry.values()];
  const start = Math.max(0, all.length - limit);
  return all.slice(start).reverse().map(snapshot);
}

export function getJob(jobId: string): JobSnapshot | undefined {
  const entry = registry.get(jobId);
  return entry === undefined ? undefined : snapshot(entry);
}

/**
 * Reads at most `tailBytes` from the end of the job log with positional reads;
 * the whole log is never loaded into memory.
 */
export async function readJobTail(jobId: string, tailBytes: number): Promise<JobLogTail | undefined> {
  const entry = registry.get(jobId);
  if (entry === undefined) {
    return undefined;
  }
  const handle = await open(entry.logPath, "r");
  try {
    const { size } = await handle.stat();
    const length = Math.min(Math.max(tailBytes, 0), size);
    const position = size - length;
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
      if (bytesRead === 0) {
        break;
      }
      offset += bytesRead;
    }
    return { buffer: buffer.subarray(0, offset), bytesRead: offset, size };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * SIGTERM to the job's process group, SIGKILL after the shared grace period,
 * and resolves once the job is finished (or the deadline passes).
 */
export async function killJob(jobId: string): Promise<JobSnapshot | undefined> {
  const entry = registry.get(jobId);
  if (entry === undefined) {
    return undefined;
  }
  if (entry.settled) {
    return snapshot(entry);
  }
  entry.killRequested = true;
  killGroup(entry, "SIGTERM");
  if (entry.killTimer === undefined) {
    entry.killTimer = setTimeout(() => killGroup(entry, "SIGKILL"), KILL_GRACE_MS);
  }
  await waitForFinished(entry, KILL_GRACE_MS + 1_000);
  return snapshot(entry);
}

/**
 * Kills every running job. Called from the server shutdown path so the process
 * can exit without leaving orphaned children behind. SIGKILL is used directly
 * because shutdown must be fast and must not depend on children honoring
 * SIGTERM; running jobs do not survive a daemon restart.
 */
export async function shutdownJobs(): Promise<void> {
  const running = [...registry.values()].filter((entry) => !entry.settled);
  for (const entry of running) {
    entry.killRequested = true;
    killGroup(entry, "SIGKILL");
  }
  await Promise.all(running.map((entry) => waitForFinished(entry, 2_000)));
}

async function finalize(
  entry: JobEntry,
  status: JobStatus,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
): Promise<void> {
  if (entry.settled) {
    return;
  }
  entry.settled = true;
  if (entry.timeoutTimer !== undefined) {
    clearTimeout(entry.timeoutTimer);
  }
  if (entry.killTimer !== undefined) {
    clearTimeout(entry.killTimer);
  }
  await entry.writeChain.catch(() => undefined);
  await entry.handle.close().catch(() => undefined);
  entry.status = status;
  entry.exitCode = exitCode;
  entry.signal = signal;
  entry.endedAt = Date.now();
  entry.resolveFinished();
}

function killGroup(entry: JobEntry, signal: NodeJS.Signals): void {
  const pid = entry.pid;
  if (pid !== undefined) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Fall through to the direct kill below.
    }
  }
  try {
    entry.child?.kill(signal);
  } catch {
    // The process is already gone.
  }
}

async function writeFully(handle: FileHandle, buffer: Buffer): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset);
    if (bytesWritten === 0) {
      return;
    }
    offset += bytesWritten;
  }
}

function waitForFinished(entry: JobEntry, timeoutMs: number): Promise<void> {
  return Promise.race([
    entry.finished,
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      timer.unref();
    }),
  ]);
}

function snapshot(entry: JobEntry): JobSnapshot {
  return {
    id: entry.id,
    name: entry.name,
    status: entry.status,
    finished: entry.settled,
    pid: entry.pid,
    command: [...entry.command],
    cwd: entry.cwd,
    logPath: entry.logPath,
    startedAt: entry.startedAt,
    endedAt: entry.endedAt,
    durationMs: (entry.endedAt ?? Date.now()) - entry.startedAt,
    exitCode: entry.exitCode,
    signal: entry.signal,
    timedOut: entry.timedOut,
    maxRuntimeMs: entry.maxRuntimeMs,
    logBytes: entry.logBytes,
    logCapped: entry.logCapped,
    spawnError: entry.spawnError,
  };
}
