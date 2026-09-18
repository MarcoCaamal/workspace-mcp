import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readJournal } from "../state.js";
import type { WorkspaceRegistry } from "../workspaces.js";
import { describeError, errorResult, renderJournalEntry, textResult, workspaceArg } from "./shared.js";

export function registerWorkLogTool(server: McpServer, registry: WorkspaceRegistry): void {
  server.registerTool(
    "work_log",
    {
      title: "Work log",
      description:
        "Read the automatic activity journal of this workspace: a newest-first list of the mutating operations this server performed " +
        "(write_file, edit_file, patch, run_command, start_job, job_kill) plus the change-tracking operations (change_create, change_activate, change_doc, task_add, task_update, constraint_add), " +
        "each with timestamp, paths, a short detail and the outcome. " +
        "Entries made while a change was active carry a change tag, so the log can be scoped to one change. " +
        "Call it at the start of a session to recover what happened in previous chats. " +
        "Read-only operations (read_file, grep, list_files, work_log itself, recall, git tools, change_status) are never journaled. " +
        "Filter with since, path and change; use recall to read the deliberate notes saved with remember.",
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe("Maximum entries to return, newest first. Defaults to 50 and is capped at 500."),
        since: z.iso
          .datetime({ offset: true })
          .optional()
          .describe("ISO 8601 timestamp (for example 2026-09-18T00:00:00Z). Only entries at or after this time are returned."),
        path: z
          .string()
          .optional()
          .describe("Substring filter applied to the workspace-relative paths recorded in each entry."),
        change: z
          .string()
          .min(1)
          .optional()
          .describe("Exact change id filter: only entries tagged with that change are returned (for example the id from change_create)."),
        workspace: workspaceArg(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ limit, since, path, change, workspace }) => {
      const { root } = registry.resolve(workspace);
      try {
        const entries = await readJournal(root, { limit, since, path, change });
        if (entries.length === 0) {
          return textResult("no activity recorded yet");
        }
        const lines = entries.map(renderJournalEntry);
        return textResult(`Activity (newest first, ${entries.length}):\n\n${lines.join("\n")}`);
      } catch (error) {
        return errorResult(describeError(error));
      }
    },
  );
}
