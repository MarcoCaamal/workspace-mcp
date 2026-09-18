import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveSafe, toWorkspacePath } from "../paths.js";
import { appendJournal } from "../state.js";
import type { WorkspaceRegistry } from "../workspaces.js";
import { describeError, errorResult, textResult, workspaceArg } from "./shared.js";

export function registerWriteTool(server: McpServer, registry: WorkspaceRegistry): void {
  server.registerTool(
    "write_file",
    {
      title: "Write file",
      description:
        "Create a file (parent directories are created automatically) or overwrite an existing file with exactly the given content. " +
        "Use this for new files or full rewrites. Prefer edit_file or patch for targeted changes to existing files, because this tool replaces the whole file and is not reversible. " +
        "The file is written to disk immediately.",
      inputSchema: {
        path: z
          .string()
          .describe("Workspace-relative path of the file to write. Absolute paths inside the workspace are also accepted."),
        content: z.string().describe("Exact file content to write, as a UTF-8 string."),
        workspace: workspaceArg(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ path: userPath, content, workspace }) => {
      const { root } = registry.resolve(workspace);
      let relativePath: string | undefined;
      try {
        const absolutePath = await resolveSafe(root, userPath);
        relativePath = toWorkspacePath(root, absolutePath);

        let existed = false;
        try {
          const info = await stat(absolutePath);
          existed = true;
          if (info.isDirectory()) {
            const message = `path is a directory, not a file: ${relativePath}`;
            await appendJournal(root, { tool: "write_file", paths: [relativePath], result: `error: ${message}` });
            return errorResult(message);
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
          }
        }

        await mkdir(path.dirname(absolutePath), { recursive: true });
        const data = Buffer.from(content, "utf8");
        await writeFile(absolutePath, data);
        await appendJournal(root, {
          tool: "write_file",
          paths: [relativePath],
          detail: `${existed ? "updated" : "created"} ${data.byteLength} bytes`,
          result: "ok",
        });
        return textResult(`${existed ? "Updated" : "Created"} ${relativePath} (${data.byteLength} bytes)`);
      } catch (error) {
        const message = describeError(error, userPath);
        await appendJournal(root, {
          tool: "write_file",
          paths: [relativePath ?? userPath],
          result: `error: ${message}`,
        });
        return errorResult(message);
      }
    },
  );
}
