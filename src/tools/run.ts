import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveSafeDirectory } from "../paths.js";
import {
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  executableRejection,
  executeCommand,
  formatList,
  type ExecutedCommand,
  type ShellConfig,
} from "../shell.js";
import { appendJournal } from "../state.js";
import type { WorkspaceRegistry } from "../workspaces.js";
import { describeError, errorResult, renderCapturedOutput, textResult, workspaceArg } from "./shared.js";

/**
 * Registers the opt-in `run_command` tool. Arguments are executed argv-style
 * with `shell: false`: nothing is ever interpolated into a shell string.
 */
export function registerRunTool(server: McpServer, registry: WorkspaceRegistry, config: ShellConfig): void {
  const allowed = [...config.allow];

  const modeDescription =
    config.mode === "any"
      ? "This server runs commands in UNRESTRICTED mode: any executable name is accepted."
      : `This server runs commands in allowlist mode: only ${formatList(allowed)} can run; every other name is rejected before anything starts.`;

  server.registerTool(
    "run_command",
    {
      title: "Run command",
      description:
        "Run an executable with arguments inside the workspace and capture its combined stdout and stderr. " +
        "Use this for quick test suites, linters, builds and commands such as 'git status'. " +
        "For commands that may take more than about 60 seconds (long test suites, docker pulls, server boot), use start_job instead: " +
        "it returns immediately and keeps running even if this client disconnects. " +
        "The command is an argv array: the first item is the executable and the remaining items are its arguments. " +
        "There is NO shell: pipes (|), '&&', redirection (>), $VAR expansion and globs are not interpreted; pass every argument literally. " +
        "No TTY is attached, so interactive and watch commands are not supported and will run until the timeout. " +
        `${modeDescription} ` +
        "Output is stripped of ANSI escape codes and truncated in the middle when it exceeds 256 KiB. " +
        `Defaults: cwd is the workspace root and timeoutMs is ${DEFAULT_TIMEOUT_MS} (max ${MAX_TIMEOUT_MS}); a timeout kills the whole process group.`,
      inputSchema: {
        command: z
          .array(z.string().min(1))
          .min(1)
          .describe(
            "argv array: [executable, ...args]. The first item is the executable. There is no shell, so |, &&, >, $VAR and globs are passed literally, not interpreted.",
          ),
        cwd: z
          .string()
          .optional()
          .describe("Working directory, workspace-relative. Defaults to the workspace root and must resolve inside it."),
        timeoutMs: z
          .number()
          .int()
          .min(MIN_TIMEOUT_MS)
          .max(MAX_TIMEOUT_MS)
          .optional()
          .describe(`Timeout in milliseconds. Defaults to ${DEFAULT_TIMEOUT_MS} and is capped at ${MAX_TIMEOUT_MS}.`),
        workspace: workspaceArg(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ command, cwd, timeoutMs, workspace }) => {
      const { root } = registry.resolve(workspace);
      const detail = command.join(" ");
      const rejection = executableRejection(config, command);
      if (rejection !== undefined) {
        await appendJournal(root, { tool: "run_command", detail, result: `error: ${rejection}` });
        return errorResult(rejection);
      }
      const executable = command[0];
      if (executable === undefined) {
        const message = "command must contain at least one item";
        await appendJournal(root, { tool: "run_command", detail, result: `error: ${message}` });
        return errorResult(message);
      }

      try {
        const workingDirectory = await resolveSafeDirectory(root, cwd ?? ".");

        const result = await executeCommand(executable, command.slice(1), {
          cwd: workingDirectory,
          timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS,
        });

        if (result.spawnError !== undefined) {
          const message =
            result.spawnError.code === "ENOENT"
              ? `executable not found: ${executable}`
              : `failed to start: ${result.spawnError.message}`;
          await appendJournal(root, { tool: "run_command", detail, result: `error: ${message}` });
          return errorResult(message);
        }

        await appendJournal(root, { tool: "run_command", detail, result: describeOutcome(result) });
        return textResult(renderCapturedOutput(result.output, statusLine(result)));
      } catch (error) {
        const message = describeError(error, cwd ?? ".");
        await appendJournal(root, { tool: "run_command", detail, result: `error: ${message}` });
        return errorResult(message);
      }
    },
  );
}

function statusLine(result: ExecutedCommand): string {
  if (result.timedOut) {
    return `timed out after ${result.timeoutMs}ms  duration: ${result.durationMs}ms`;
  }
  if (result.exitCode !== null) {
    return `exit code: ${result.exitCode}  duration: ${result.durationMs}ms`;
  }
  return `terminated by signal ${result.signal ?? "unknown"}  duration: ${result.durationMs}ms`;
}

/** Short outcome stored in the activity journal. */
function describeOutcome(result: ExecutedCommand): string {
  if (result.timedOut) {
    return `timed out (${result.durationMs}ms)`;
  }
  if (result.exitCode !== null) {
    return `exit ${result.exitCode} (${result.durationMs}ms)`;
  }
  return `signal ${result.signal ?? "unknown"} (${result.durationMs}ms)`;
}
