import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readNotes } from "../state.js";
import type { WorkspaceRegistry } from "../workspaces.js";
import { describeError, errorResult, textResult, workspaceArg } from "./shared.js";

export function registerRecallTool(server: McpServer, registry: WorkspaceRegistry): void {
  server.registerTool(
    "recall",
    {
      title: "Recall notes",
      description:
        "Read the persistent notes saved with remember for this workspace, newest first. " +
        "Call it at the start of a session together with work_log to recover context from previous chats. " +
        "Filter by free-text query (case-insensitive substring) and/or tag. " +
        "This tool is read-only; use work_log for the automatic activity journal instead.",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe("Case-insensitive substring matched against the note text."),
        tag: z
          .string()
          .optional()
          .describe("Tag to filter by (case-insensitive, exact match)."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Maximum notes to return, newest first. Defaults to 20 and is capped at 100."),
        workspace: workspaceArg(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, tag, limit, workspace }) => {
      const { root } = registry.resolve(workspace);
      try {
        const notes = await readNotes(root, { query, tag, limit });
        if (notes.length === 0) {
          return textResult("no notes match");
        }
        return textResult(notes.map(renderNote).join("\n"));
      } catch (error) {
        return errorResult(describeError(error));
      }
    },
  );
}

function renderNote(note: { ts: string; text: string; tags: string[] }): string {
  const parts = [note.ts.slice(0, 10)];
  if (note.tags.length > 0) {
    parts.push(note.tags.map((tag) => `[#${tag}]`).join(" "));
  }
  parts.push(note.text);
  return parts.join("  ");
}
