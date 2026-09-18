import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { appendNote, countNotes } from "../state.js";
import type { WorkspaceRegistry } from "../workspaces.js";
import { describeError, errorResult, textResult, workspaceArg } from "./shared.js";

export function registerRememberTool(server: McpServer, registry: WorkspaceRegistry): void {
  server.registerTool(
    "remember",
    {
      title: "Remember note",
      description:
        "Save a short persistent note for this workspace so any future chat can recover it with recall. " +
        "Use it after finishing a chunk of work: record what changed, what should happen next, or a decision that must survive the conversation. " +
        "Notes are append-only JSONL stored under <workspace>/.workspace-mcp/ and are never edited or deleted by this tool. " +
        "Keep each note short and self-contained; use tags for later filtering.",
      inputSchema: {
        text: z.string().min(1).describe("Note text. One short, self-contained sentence or paragraph."),
        tags: z
          .array(z.string().min(1).max(50))
          .max(20)
          .optional()
          .describe('Optional short tags for recall filtering, for example ["todo", "phase-2"].'),
        workspace: workspaceArg(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ text, tags, workspace }) => {
      const { root } = registry.resolve(workspace);
      try {
        await appendNote(root, { text, tags });
        const total = await countNotes(root);
        return textResult(`noted (#${total} total)`);
      } catch (error) {
        return errorResult(describeError(error));
      }
    },
  );
}
