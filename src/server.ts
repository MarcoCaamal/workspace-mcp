import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DEFAULT_SHELL_ALLOW, type ShellConfig } from "./shell.js";
import { registerChangeTools } from "./tools/changes.js";
import { registerEditTool } from "./tools/edit.js";
import { registerGitTools } from "./tools/git.js";
import { registerGrepTool } from "./tools/grep.js";
import { registerJobTools } from "./tools/jobs.js";
import { registerListTool } from "./tools/list.js";
import { registerPatchTool } from "./tools/patch.js";
import { registerReadTool } from "./tools/read.js";
import { registerRecallTool } from "./tools/recall.js";
import { registerRememberTool } from "./tools/remember.js";
import { registerRunTool } from "./tools/run.js";
import { registerWorkLogTool } from "./tools/work-log.js";
import { registerWorkspaceTools } from "./tools/workspaces.js";
import { registerWriteTool } from "./tools/write.js";
import { WorkspaceRegistry, type WorkspaceConfig } from "./workspaces.js";

export const SERVER_NAME = "workspace-mcp";
export const FALLBACK_VERSION = "0.0.0";

export interface CreateServerOptions {
  /** Named workspace roots. Each tool resolves one of them per call. */
  workspaces: WorkspaceConfig[];
  /** Name of the primary workspace. Defaults to the first entry. */
  defaultWorkspace?: string;
  /** Server version reported to clients. Defaults to "0.0.0". */
  version?: string;
  /** Command execution config. When omitted or disabled, run_command is not registered. */
  shell?: ShellConfig;
}

/**
 * Creates a fully configured MCP server scoped to one or more named
 * workspaces. Roots are validated and resolved with `fs.realpathSync` once
 * here, so workspace-relative paths are correct even when a root is reached
 * through a symbolic link.
 */
export function createServer({ workspaces, defaultWorkspace, version, shell }: CreateServerOptions): McpServer {
  const registry = new WorkspaceRegistry(workspaces, defaultWorkspace);
  const shellConfig: ShellConfig = shell ?? { enabled: false, mode: "allowlist", allow: [...DEFAULT_SHELL_ALLOW] };

  const server = new McpServer(
    { name: SERVER_NAME, version: version ?? FALLBACK_VERSION },
    { instructions: buildInstructions(registry, shellConfig) },
  );

  registerWorkspaceTools(server, registry);
  registerReadTool(server, registry);
  registerWriteTool(server, registry);
  registerEditTool(server, registry);
  registerPatchTool(server, registry);
  registerGrepTool(server, registry);
  registerListTool(server, registry);
  registerWorkLogTool(server, registry);
  registerRememberTool(server, registry);
  registerRecallTool(server, registry);
  registerGitTools(server, registry);
  registerChangeTools(server, registry);
  if (shellConfig.enabled) {
    registerRunTool(server, registry, shellConfig);
    registerJobTools(server, registry, shellConfig);
  }

  return server;
}

/** Server instructions sent to MCP clients during initialization. */
export function buildInstructions(registry: WorkspaceRegistry, shell?: ShellConfig): string {
  const workspaces = registry.list();
  const workspaceLine = `Workspaces: ${workspaces
    .map((workspace) => `${workspace.name} \u2192 ${workspace.root}${workspace.name === registry.primary ? " (primary)" : ""}`)
    .join("; ")}`;

  const lines = [
    `${SERVER_NAME} exposes filesystem, memory and git tools scoped to named project workspaces.`,
    workspaceLine,
  ];

  if (workspaces.length > 1) {
    lines.push('Pass workspace: "<name>" to operate on a specific workspace.');
  }

  lines.push(
    "",
    "Session memory:",
    "- At the start of a session call work_log (automatic journal of past mutating operations) and recall (notes saved deliberately) to recover context from previous chats.",
    "- After finishing a chunk of work call remember with what changed and what should happen next, so the next session can pick it up.",
    "",
    "Changes and tasks (SDD-lite):",
    "- For multi-step work, track it: change_create, then change_doc for the proposal/spec/design documents on demand, then task_add and task_update for the task list.",
    "- Re-orient in one call with change_status (read-only, no confirmation needed): it shows the documents, tasks, constraints, recent tagged journal entries and a suggested next action.",
    "",
    "Conventions:",
    "- All tool paths are workspace-relative (absolute paths inside the selected workspace root are also accepted). Paths outside the selected workspace root are rejected.",
    "- Tool responses use workspace-relative paths.",
    "- Read a file before editing it. read_file returns 1-based line numbers.",
    "- write_file, edit_file and patch mutate files on disk immediately and are not reversible. Prefer edit_file or patch for targeted changes; use write_file only for new files or full rewrites.",
    "- Binary files cannot be read or searched.",
  );

  if (shell?.enabled === true) {
    const mode =
      shell.mode === "any"
        ? "unrestricted (any executable)"
        : `allowlist (${shell.allow.length > 0 ? shell.allow.join(", ") : "none"})`;
    lines.push(
      `- run_command runs real processes with your OS user's permissions inside the selected workspace root; it is NOT a sandbox. Commands are argv-only (no shell interpretation, no TTY). Mode: ${mode}.`,
      "- Use run_command for quick commands. Use start_job + job_status for anything that may take more than ~60 seconds (test suites, docker pulls, server boot) so client timeouts cannot lose the work: start_job returns a jobId immediately and keeps running detached from the client, and job_status is read-only, so it needs no confirmation.",
      "- Background job output goes to a log file under the OS temp directory; job_kill terminates a running job's process group. Jobs do not survive a server restart.",
    );
  } else {
    lines.push("- There is no shell tool: commands cannot be executed through this server.");
  }

  return lines.join("\n");
}
