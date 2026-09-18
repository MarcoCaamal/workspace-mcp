import { execFile, type ExecFileException } from "node:child_process";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveSafe } from "../paths.js";
import { scrubbedEnv, type CapturedOutput } from "../shell.js";
import type { WorkspaceRegistry } from "../workspaces.js";
import { describeError, errorResult, renderCapturedOutputBody, textResult, workspaceArg } from "./shared.js";

const GIT_STATUS_TIMEOUT_MS = 10_000;
const GIT_DIFF_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/** git_diff output is capped at 64 KiB, keeping 32 KiB of head and 32 KiB of tail. */
const GIT_DIFF_MAX_BYTES = 64 * 1024;
const GIT_DIFF_HEAD_BYTES = 32 * 1024;
const GIT_DIFF_TAIL_BYTES = 32 * 1024;

interface GitRun {
  stdout: string;
  stderr: string;
  error: ExecFileException | undefined;
}

/**
 * Registers the read-only git tools. They never use a shell: `git` is spawned
 * argv-style with `LC_ALL=C`, a scrubbed environment and a hard timeout, so
 * they work even when the shell tools are disabled.
 */
export function registerGitTools(server: McpServer, registry: WorkspaceRegistry): void {
  server.registerTool(
    "git_status",
    {
      title: "Git status",
      description:
        "Read-only git status of the workspace: runs 'git status --porcelain=v1 -b' without a shell (LC_ALL=C, 10 s timeout) and returns " +
        "a 'branch: ...' header followed by the porcelain lines exactly as git prints them. " +
        "A clean tree reports 'working tree clean'. A directory that is not a git repository or a missing git binary is reported as a clear error. " +
        "No --shell flag is needed for this tool.",
      inputSchema: { workspace: workspaceArg() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ workspace }) => {
      const { root } = registry.resolve(workspace);
      const run = await runGit(root, ["-C", root, "status", "--porcelain=v1", "-b"], GIT_STATUS_TIMEOUT_MS);
      if (run.error !== undefined) {
        return errorResult(gitFailureMessage("status", run, root));
      }
      return textResult(renderGitStatus(run.stdout));
    },
  );

  server.registerTool(
    "git_diff",
    {
      title: "Git diff",
      description:
        "Read-only git diff of the workspace: runs 'git diff' without a shell (LC_ALL=C, 30 s timeout) and returns the patch text. " +
        "Use staged=true for the index (--cached), stat=true for a diffstat (--stat), and path to limit the diff to one workspace-relative file (passed after '--'). " +
        "Reports '(no changes)' when the diff is empty. Output longer than 64 KiB keeps the first 32 KiB and the last 32 KiB. " +
        "No --shell flag is needed for this tool.",
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe("Workspace-relative file or directory to limit the diff to. Absolute paths inside the workspace are also accepted."),
        staged: z.boolean().optional().describe("Diff the staged changes (git diff --cached) instead of the working tree. Defaults to false."),
        stat: z.boolean().optional().describe("Return a diffstat (git diff --stat) instead of the full patch. Defaults to false."),
        workspace: workspaceArg(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ path: userPath, staged, stat, workspace }) => {
      const { root } = registry.resolve(workspace);
      try {
        const args = ["-C", root, "diff"];
        if (staged === true) {
          args.push("--cached");
        }
        if (stat === true) {
          args.push("--stat");
        }
        if (userPath !== undefined) {
          const absolutePath = await resolveSafe(root, userPath);
          args.push("--", absolutePath);
        }
        const run = await runGit(root, args, GIT_DIFF_TIMEOUT_MS);
        if (run.error !== undefined) {
          return errorResult(gitFailureMessage("diff", run, root));
        }
        return textResult(renderGitDiff(run.stdout));
      } catch (error) {
        return errorResult(describeError(error, userPath));
      }
    },
  );
}

function runGit(root: string, args: readonly string[], timeoutMs: number): Promise<GitRun> {
  return new Promise((resolve) => {
    execFile(
      "git",
      [...args],
      {
        cwd: root,
        timeout: timeoutMs,
        maxBuffer: GIT_MAX_BUFFER_BYTES,
        encoding: "utf8",
        shell: false,
        env: { ...scrubbedEnv(), LC_ALL: "C" },
      },
      (error, stdout, stderr) => {
        resolve({
          stdout: typeof stdout === "string" ? stdout : "",
          stderr: typeof stderr === "string" ? stderr : "",
          error: error ?? undefined,
        });
      },
    );
  });
}

function gitFailureMessage(subcommand: string, run: GitRun, root: string): string {
  const error = run.error as ExecFileException;
  if (error.code === "ENOENT") {
    return "git not found in PATH";
  }
  if (error.killed === true || error.signal !== null && error.signal !== undefined) {
    return `git ${subcommand} timed out`;
  }
  const stderr = run.stderr.trim();
  if (stderr.includes("not a git repository")) {
    return `not a git repository: ${root}`;
  }
  if (stderr !== "") {
    const firstLine = stderr.split("\n")[0]?.trim();
    return firstLine !== undefined && firstLine !== "" ? firstLine : `git ${subcommand} failed`;
  }
  return `git ${subcommand} failed (exit code ${String(error.code ?? "unknown")})`;
}

function renderGitStatus(stdout: string): string {
  const lines = stdout.split(/\r?\n/).filter((line) => line !== "");
  const branchLine = lines.find((line) => line.startsWith("## "));
  const statusLines = branchLine === undefined ? lines : lines.filter((line) => line !== branchLine);

  const parts: string[] = [];
  if (branchLine !== undefined) {
    parts.push(`branch: ${branchLine.slice(3)}`);
  }
  parts.push(statusLines.length === 0 ? "working tree clean" : statusLines.join("\n"));
  return parts.join("\n\n");
}

function renderGitDiff(stdout: string): string {
  if (stdout.trim() === "") {
    return "(no changes)";
  }
  const buffer = Buffer.from(stdout, "utf8");
  const output: CapturedOutput =
    buffer.length <= GIT_DIFF_MAX_BYTES
      ? { text: stdout, tail: "", totalBytes: buffer.length, truncatedBytes: 0 }
      : {
          text: buffer.subarray(0, GIT_DIFF_HEAD_BYTES).toString("utf8"),
          tail: buffer.subarray(buffer.length - GIT_DIFF_TAIL_BYTES).toString("utf8"),
          totalBytes: buffer.length,
          truncatedBytes: buffer.length - GIT_DIFF_HEAD_BYTES - GIT_DIFF_TAIL_BYTES,
        };
  return renderCapturedOutputBody(output);
}
