import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { READ_MAX_LINES, readTextFile, renderNumberedLines } from "../files.js";
import { resolveSafe, toWorkspacePath } from "../paths.js";
import type { WorkspaceRegistry } from "../workspaces.js";
import { describeError, errorResult, textResult, workspaceArg } from "./shared.js";

export function registerReadTool(server: McpServer, registry: WorkspaceRegistry): void {
  server.registerTool(
    "read_file",
    {
      title: "Read file",
      description:
        "Read a UTF-8 text file from the workspace and return its content with 1-based line numbers in the form 'N: <content>'. " +
        "Use this before editing a file, or to inspect specific line ranges with offset/limit. " +
        "Do not use it for binary files (they are rejected), to search file contents (use grep), or to discover files (use list_files).",
      inputSchema: {
        path: z
          .string()
          .describe("Workspace-relative path of the file to read. Absolute paths inside the workspace are also accepted."),
        offset: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("1-based line number to start reading from. Defaults to 1."),
        limit: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Maximum number of lines to return. Defaults to 2000 and is capped at 2000."),
        workspace: workspaceArg(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ path, offset, limit, workspace }) => {
      try {
        const { root } = registry.resolve(workspace);
        const absolutePath = await resolveSafe(root, path);
        const relativePath = toWorkspacePath(root, absolutePath);
        const content = await readTextFile(absolutePath, relativePath);
        const text = renderNumberedLines(content, offset ?? 1, limit ?? READ_MAX_LINES);
        return textResult(text);
      } catch (error) {
        return errorResult(describeError(error, path));
      }
    },
  );
}
