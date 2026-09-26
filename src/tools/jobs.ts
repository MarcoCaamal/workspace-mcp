import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  DEFAULT_MAX_RUNTIME_MS,
  DEFAULT_TAIL_BYTES,
  MAX_LISTED_JOBS,
  MAX_MAX_RUNTIME_MS,
  MAX_TAIL_BYTES,
  MIN_MAX_RUNTIME_MS,
  getJob,
  killJob,
  listJobs,
  readJobTail,
  startJob,
  type JobLogTail,
  type JobSnapshot,
} from "../jobs.js";
import { resolveSafeDirectory } from "../paths.js";
import { OutputAccumulator, executableRejection, formatList, stripAnsi, type ShellConfig } from "../shell.js";
import { appendJournal } from "../state.js";
import type { WorkspaceRegistry } from "../workspaces.js";
import { describeError, errorResult, renderCapturedOutputBody, textResult, workspaceArg } from "./shared.js";

/**
 * Registers the opt-in background job tools (start_job, job_status, job_kill).
 * They share the run_command gate, allowlist and cwd confinement, but delegate
 * process lifecycle to the process-global engine in `src/jobs.ts` so jobs
 * outlive individual client connections and server instances.
 */
export function registerJobTools(server: McpServer, registry: WorkspaceRegistry, config: ShellConfig): void {
  const allowed = [...config.allow];
  const defaultMaxRuntimeMs = config.maxRuntimeMs ?? DEFAULT_MAX_RUNTIME_MS;
  const primaryRoot = registry.resolve().root;
  const modeDescription =
    config.mode === "any"
      ? "This server runs commands in UNRESTRICTED mode: any executable name is accepted."
      : `This server runs commands in allowlist mode: only ${formatList(allowed)} can run; every other name is rejected before anything starts.`;

  server.registerTool(
    "start_job",
    {
      title: "Start background job",
      description:
        "Start an executable with arguments as a background job and return immediately with a jobId. " +
        "Use this instead of run_command for anything that may take more than about 60 seconds (test suites with containers, docker pulls, server boot): " +
        "the process runs detached from this connection, so a client timeout or disconnect cannot lose the work. " +
        "Output accumulates in a log file; follow it with job_status (read-only, no confirmation needed). " +
        "The command is an argv array: the first item is the executable and the remaining items are its arguments. " +
        "There is NO shell: pipes (|), '&&', redirection (>), $VAR expansion and globs are not interpreted; pass every argument literally. " +
        `${modeDescription} ` +
        "Like run_command, the job inherits a scrubbed environment: secret-bearing variables are removed before spawn. " +
        "Re-attach with job_status (read-only, no confirmation needed) instead of starting a duplicate job. " +
        `The job's process group is killed after maxRuntimeMs (default ${defaultMaxRuntimeMs} ms, max ${MAX_MAX_RUNTIME_MS} ms).`,
      inputSchema: {
        command: z
          .array(z.string().min(1))
          .min(1)
          .describe("argv array: [executable, ...args]. The first item is the executable. There is no shell interpretation."),
        cwd: z
          .string()
          .optional()
          .describe("Working directory, workspace-relative. Defaults to the workspace root and must resolve inside it."),
        name: z.string().min(1).max(200).optional().describe('Optional label shown by job_status, for example "pnpm test".'),
        maxRuntimeMs: z
          .number()
          .int()
          .min(MIN_MAX_RUNTIME_MS)
          .max(MAX_MAX_RUNTIME_MS)
          .optional()
          .describe(`Kill the job after this many milliseconds. Defaults to ${defaultMaxRuntimeMs} and is capped at ${MAX_MAX_RUNTIME_MS}.`),
        workspace: workspaceArg(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ command, cwd, name, maxRuntimeMs, workspace }) => {
      const { root } = registry.resolve(workspace);
      const detail = command.join(" ");
      const rejection = executableRejection(config, command);
      if (rejection !== undefined) {
        await appendJournal(root, { tool: "start_job", detail, result: `error: ${rejection}` });
        return errorResult(rejection);
      }
      const executable = command[0];
      if (executable === undefined) {
        const message = "command must contain at least one item";
        await appendJournal(root, { tool: "start_job", detail, result: `error: ${message}` });
        return errorResult(message);
      }

      try {
        const workingDirectory = await resolveSafeDirectory(root, cwd ?? ".");
        const job = await startJob({
          executable,
          args: command.slice(1),
          cwd: workingDirectory,
          name,
          maxRuntimeMs: maxRuntimeMs ?? config.maxRuntimeMs,
        });
        await appendJournal(root, { tool: "start_job", detail, result: `started (${job.id})` });
        return textResult(renderJobStarted(job));
      } catch (error) {
        const message = describeError(error, cwd ?? ".");
        await appendJournal(root, { tool: "start_job", detail, result: `error: ${message}` });
        return errorResult(message);
      }
    },
  );

  server.registerTool(
    "job_status",
    {
      title: "Job status",
      description:
        "Read the status of a background job started with start_job. This tool is read-only and requires no confirmation. " +
        "With jobId: returns status (running, exited, killed, timed-out or failed-to-start), the exit code when exited, duration, log size and the tail of the log (ANSI-stripped). " +
        `Without jobId: lists the ${MAX_LISTED_JOBS} most recent jobs in this server process. ` +
        "Jobs keep running when the client disconnects or the MCP request ends; only restarting the server kills them. " +
        "Jobs do not survive a server restart: after a restart every pre-restart job id reports unknown job id.",
      inputSchema: {
        jobId: z.string().optional().describe("Job id returned by start_job. Omit to list the most recent jobs."),
        tailBytes: z
          .number()
          .int()
          .min(0)
          .max(MAX_TAIL_BYTES)
          .optional()
          .describe(`Bytes of log tail to return. Defaults to ${DEFAULT_TAIL_BYTES} and is capped at ${MAX_TAIL_BYTES}.`),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ jobId, tailBytes }) => {
      if (jobId === undefined) {
        return textResult(renderJobList(listJobs()));
      }
      const job = getJob(jobId);
      if (job === undefined) {
        return errorResult(`unknown job id: ${jobId}`);
      }
      try {
        const tail = await readJobTail(jobId, tailBytes ?? DEFAULT_TAIL_BYTES);
        if (tail === undefined) {
          return errorResult(`unknown job id: ${jobId}`);
        }
        return textResult(renderJobStatus(job, tail));
      } catch (error) {
        return errorResult(describeError(error, job.logPath));
      }
    },
  );

  server.registerTool(
    "job_kill",
    {
      title: "Kill background job",
      description:
        "Terminate a background job started with start_job. Sends SIGTERM to the job's whole process group, then SIGKILL after a 3 second grace period, and returns the final status. " +
        "Killing a job that already finished is not an error.",
      inputSchema: {
        jobId: z.string().min(1).describe("Job id returned by start_job."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ jobId }) => {
      const job = getJob(jobId);
      if (job === undefined) {
        const message = `unknown job id: ${jobId}`;
        await appendJournal(primaryRoot, { tool: "job_kill", detail: jobId, result: `error: ${message}` });
        return errorResult(message);
      }
      if (job.finished) {
        const suffix = job.status === "exited" ? ` (exit code ${job.exitCode ?? "unknown"})` : "";
        await appendJournal(primaryRoot, { tool: "job_kill", detail: jobId, result: job.status });
        return textResult(`job ${jobId} already finished with status ${job.status}${suffix}; nothing to kill.`);
      }
      try {
        const final = await killJob(jobId);
        if (final === undefined) {
          const message = `unknown job id: ${jobId}`;
          await appendJournal(primaryRoot, { tool: "job_kill", detail: jobId, result: `error: ${message}` });
          return errorResult(message);
        }
        await appendJournal(primaryRoot, { tool: "job_kill", detail: jobId, result: final.status });
        return textResult(
          final.finished
            ? `job ${jobId}: ${describeJobStatus(final)}`
            : `job ${jobId}: kill requested (SIGTERM sent; SIGKILL follows after a 3 s grace period)`,
        );
      } catch (error) {
        const message = describeError(error);
        await appendJournal(primaryRoot, { tool: "job_kill", detail: jobId, result: `error: ${message}` });
        return errorResult(message);
      }
    },
  );
}

function renderJobStarted(job: JobSnapshot): string {
  return [
    `jobId: ${job.id}`,
    `name: ${sanitizeName(job.name)}`,
    `pid: ${job.pid ?? "unknown"}`,
    `startedAt: ${new Date(job.startedAt).toISOString()}`,
    `log: ${job.logPath}`,
    `maxRuntimeMs: ${job.maxRuntimeMs}`,
    "",
    "Job started. Follow with job_status (read-only, no confirmation needed).",
  ].join("\n");
}

function renderJobStatus(job: JobSnapshot, tail: JobLogTail): string {
  const lines = [
    `job ${job.id} - ${sanitizeName(job.name)}`,
    `status: ${describeJobStatus(job)}`,
    `pid: ${job.pid ?? "unknown"}`,
    `startedAt: ${new Date(job.startedAt).toISOString()}`,
    `log: ${job.logPath} (${job.logBytes} bytes)`,
  ];
  if (job.logCapped) {
    lines.push("log capped at 64 MiB; further output was discarded");
  }
  if (tail.bytesRead > 0) {
    const accumulator = new OutputAccumulator();
    accumulator.push(tail.buffer);
    lines.push("", `--- output tail (last ${tail.bytesRead} bytes) ---`, renderCapturedOutputBody(accumulator.finish()));
  } else {
    lines.push("", "(no output)");
  }
  return lines.join("\n");
}

function renderJobList(jobs: JobSnapshot[]): string {
  if (jobs.length === 0) {
    return "No jobs have been started in this process.";
  }
  const lines = jobs.map((job) => {
    const outcome = job.finished
      ? job.status === "exited"
        ? `exit code ${job.exitCode ?? "unknown"}, duration ${job.durationMs}ms`
        : `${job.status}, duration ${job.durationMs}ms`
      : `running, duration ${job.durationMs}ms`;
    return `${job.id}  ${sanitizeName(job.name)}  started ${new Date(job.startedAt).toISOString()}  ${outcome}`;
  });
  return [`Recent jobs (newest first, up to ${MAX_LISTED_JOBS}):`, "", ...lines].join("\n");
}

function describeJobStatus(job: JobSnapshot): string {
  const duration = `duration: ${job.durationMs}ms`;
  switch (job.status) {
    case "running":
      return `running  ${duration}`;
    case "exited":
      return `exited  exit code: ${job.exitCode ?? "unknown"}  ${duration}`;
    case "killed":
      return `killed  signal: ${job.signal ?? "SIGKILL"}  ${duration}`;
    case "timed-out":
      return `timed-out  maxRuntimeMs: ${job.maxRuntimeMs}  ${duration}`;
    case "failed-to-start":
      return `failed-to-start  error: ${job.spawnError ?? "spawn failed"}  ${duration}`;
  }
}

function sanitizeName(name: string): string {
  const single = stripAnsi(name).replace(/\s+/g, " ").trim();
  return single === "" ? "(unnamed)" : single;
}
