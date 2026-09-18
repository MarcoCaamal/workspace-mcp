import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

export type ShellMode = "allowlist" | "any";

/** Configuration for the opt-in `run_command` tool. */
export interface ShellConfig {
  /** When false the tool is never registered. */
  enabled: boolean;
  /** "allowlist" restricts executable names; "any" skips the check entirely. */
  mode: ShellMode;
  /** Executable names (compared against `path.basename(command[0])`). */
  allow: string[];
}

/** Executables allowed when the user does not extend the allowlist. */
export const DEFAULT_SHELL_ALLOW: readonly string[] = ["pnpm", "npm", "npx", "node"];

export const DEFAULT_TIMEOUT_MS = 120_000;
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 600_000;

/** Environment variables never forwarded to child processes. */
const SCRUBBED_ENV_KEYS = ["CONTROL_PLANE_API_KEY", "OPENAI_API_KEY", "OPENAI_ADMIN_KEY", "MCP_TOKEN"] as const;

/** Accumulate up to this many bytes before collapsing to head + tail. */
export const MAX_CAPTURE_BYTES = 256 * 1024;
export const RETAINED_HEAD_BYTES = 32 * 1024;
export const RETAINED_TAIL_BYTES = 32 * 1024;

export const KILL_GRACE_MS = 3_000;

/** Renders a name list for the client-facing allowlist messages. */
export function formatList(names: readonly string[]): string {
  return names.length === 0 ? "(none)" : names.join(", ");
}

/**
 * Returns a client-safe rejection message when `command` may not run under
 * `config`, or undefined when it is allowed. Shared by run_command and
 * start_job so both enforce exactly the same allowlist rules.
 */
export function executableRejection(config: ShellConfig, command: readonly string[]): string | undefined {
  const executable = command[0];
  if (executable === undefined || executable === "") {
    return "command must contain at least one item";
  }
  const executableName = path.basename(executable);
  if (config.mode === "allowlist" && !config.allow.includes(executableName)) {
    return (
      `command not allowed: ${executableName}. Allowed executables: ${formatList(config.allow)}. ` +
      "Extend the allowlist with --shell-allow <list> (or WORKSPACE_MCP_SHELL_ALLOW), or allow everything with --shell-any."
    );
  }
  return undefined;
}

export interface CapturedOutput {
  /** Complete output when nothing was dropped; otherwise the first retained segment. */
  text: string;
  /** Last retained segment; empty when nothing was dropped. */
  tail: string;
  totalBytes: number;
  truncatedBytes: number;
}

export interface SpawnFailure {
  message: string;
  code: string | undefined;
}

export interface ExecutedCommand {
  output: CapturedOutput;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  timeoutMs: number;
  durationMs: number;
  spawnError: SpawnFailure | undefined;
}

/**
 * Returns a copy of the environment with credentials removed. Child commands
 * must never inherit the control-plane or provider keys this server was
 * started with.
 */
export function scrubbedEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source };
  for (const key of SCRUBBED_ENV_KEYS) {
    delete env[key];
  }
  env.NO_COLOR = "1";
  env.FORCE_COLOR = "0";
  return env;
}

/**
 * Bounded output capture. Keeps everything up to {@link MAX_CAPTURE_BYTES};
 * once that cap is exceeded it collapses to the first
 * {@link RETAINED_HEAD_BYTES} and a rolling last {@link RETAINED_TAIL_BYTES},
 * so a runaway command cannot exhaust memory. The tail matters because test
 * and build failures print at the end.
 */
export class OutputAccumulator {
  private chunks: Buffer[] = [];
  private bufferedBytes = 0;
  private head: Buffer | undefined;
  private tail: Buffer | undefined;
  private totalBytes = 0;

  push(chunk: Buffer): void {
    if (chunk.length === 0) {
      return;
    }
    this.totalBytes += chunk.length;

    if (this.head !== undefined) {
      this.tail = retainTail(Buffer.concat([this.tail ?? Buffer.alloc(0), chunk]));
      return;
    }

    this.chunks.push(chunk);
    this.bufferedBytes += chunk.length;
    if (this.bufferedBytes > MAX_CAPTURE_BYTES) {
      const merged = Buffer.concat(this.chunks);
      this.head = merged.subarray(0, RETAINED_HEAD_BYTES);
      this.tail = retainTail(merged);
      this.chunks = [];
      this.bufferedBytes = 0;
    }
  }

  finish(): CapturedOutput {
    if (this.head === undefined) {
      const text = stripAnsi(Buffer.concat(this.chunks).toString("utf8"));
      return { text, tail: "", totalBytes: this.totalBytes, truncatedBytes: 0 };
    }

    const head = this.head;
    const tail = this.tail ?? Buffer.alloc(0);
    return {
      text: stripAnsi(head.toString("utf8")),
      tail: stripAnsi(tail.toString("utf8")),
      totalBytes: this.totalBytes,
      truncatedBytes: Math.max(0, this.totalBytes - head.length - tail.length),
    };
  }
}

function retainTail(buffer: Buffer): Buffer {
  return buffer.length <= RETAINED_TAIL_BYTES ? buffer : buffer.subarray(buffer.length - RETAINED_TAIL_BYTES);
}

const ANSI_OSC = /\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g;
const ANSI_CSI = /\u001B\[[0-9;?]*[ -/]*[@-~]/g;
const ANSI_OTHER = /\u001B[@-Z\\-_]/g;

/** Removes ANSI escape sequences (colors, cursor movement, OSC) from text. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_OSC, "").replace(ANSI_CSI, "").replace(ANSI_OTHER, "");
}

/**
 * Runs `executable` with `args` without a shell, in its own process group so a
 * timeout can terminate the whole tree. stdout and stderr are merged in
 * arrival order (best effort). Never throws: failures are reported in the
 * result so the tool layer can render a clean message.
 */
export function executeCommand(
  executable: string,
  args: readonly string[],
  options: { cwd: string; timeoutMs: number },
): Promise<ExecutedCommand> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const accumulator = new OutputAccumulator();
    let timedOut = false;
    let settled = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    const finish = (
      exitCode: number | null,
      signal: NodeJS.Signals | null,
      spawnError: SpawnFailure | undefined,
    ): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutTimer !== undefined) {
        clearTimeout(timeoutTimer);
      }
      if (killTimer !== undefined) {
        clearTimeout(killTimer);
      }
      resolve({
        output: accumulator.finish(),
        exitCode,
        signal,
        timedOut,
        timeoutMs: options.timeoutMs,
        durationMs: Date.now() - startedAt,
        spawnError,
      });
    };

    const killGroup = (signal: NodeJS.Signals): void => {
      const pid = child.pid;
      if (pid !== undefined) {
        try {
          process.kill(-pid, signal);
          return;
        } catch {
          // Fall through to the direct kill below.
        }
      }
      try {
        child.kill(signal);
      } catch {
        // The process is already gone.
      }
    };

    let child: ChildProcess;
    try {
      child = spawn(executable, [...args], {
        cwd: options.cwd,
        env: scrubbedEnv(),
        shell: false,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      finish(null, null, {
        message: error instanceof Error ? error.message : String(error),
        code: (error as NodeJS.ErrnoException).code,
      });
      return;
    }

    child.stdout?.on("data", (chunk: Buffer) => accumulator.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => accumulator.push(chunk));

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      killTimer = setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS);
    }, options.timeoutMs);

    child.on("error", (error: NodeJS.ErrnoException) => {
      finish(null, null, { message: error.message, code: error.code });
    });

    child.on("close", (code, signal) => {
      finish(code, signal, undefined);
    });
  });
}
