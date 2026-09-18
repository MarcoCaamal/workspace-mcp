import { writeFile } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { FileToolError, readTextFile } from "../files.js";
import { resolveSafe, toWorkspacePath } from "../paths.js";
import { appendJournal } from "../state.js";
import type { WorkspaceRegistry } from "../workspaces.js";
import { applyReplacement, countOccurrences } from "./edit.js";
import { describeError, errorResult, textResult, workspaceArg } from "./shared.js";

const editSchema = z.object({
  path: z.string().describe("Workspace-relative path of the file to edit."),
  oldString: z.string().min(1).describe("Exact text to replace. Must not be empty."),
  newString: z.string().describe("Replacement text. Use an empty string to delete the matched text."),
  replaceAll: z.boolean().optional().describe("Replace every occurrence instead of requiring a unique match. Defaults to false."),
});

interface VirtualFile {
  absolutePath: string;
  relativePath: string;
  content: string;
}

export function registerPatchTool(server: McpServer, registry: WorkspaceRegistry): void {
  server.registerTool(
    "patch",
    {
      title: "Patch files",
      description:
        "Apply several exact-string edits across one or more files in a single all-or-nothing operation. " +
        "Every edit is validated against the current file contents first; if any edit fails, NO file is modified and the failing edit index is reported. " +
        "Use this instead of several edit_file calls when changes belong together. " +
        "Read the affected files first with read_file. Changes are written to disk immediately when all edits are valid.",
      inputSchema: {
        edits: z
          .array(editSchema)
          .min(1)
          .describe("Edits to apply. All must be valid against the current file contents, otherwise nothing is written."),
        workspace: workspaceArg(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ edits, workspace }) => {
      const { root } = registry.resolve(workspace);
      const files = new Map<string, VirtualFile>();
      const countsPerFile = new Map<string, number>();
      const attemptedPaths: string[] = [];
      let currentIndex = 0;
      let errorMessage: string | undefined;
      let summary = "";

      try {
        for (let index = 0; index < edits.length; index += 1) {
          currentIndex = index;
          const edit = edits[index] as (typeof edits)[number];
          const absolutePath = await resolveSafe(root, edit.path);
          const relativePath = toWorkspacePath(root, absolutePath);
          if (!attemptedPaths.includes(relativePath)) {
            attemptedPaths.push(relativePath);
          }

          let file = files.get(absolutePath);
          if (!file) {
            file = {
              absolutePath,
              relativePath,
              content: await readTextFile(absolutePath, relativePath),
            };
            files.set(absolutePath, file);
          }

          const count = countOccurrences(file.content, edit.oldString);
          if (count === 0) {
            throw new FileToolError(`oldString not found in ${relativePath}`);
          }
          if (count > 1 && edit.replaceAll !== true) {
            throw new FileToolError(
              `oldString appears ${count} times in ${relativePath}; add more surrounding context or set replaceAll=true`,
            );
          }

          file.content = applyReplacement(file.content, edit.oldString, edit.newString, edit.replaceAll === true);
          countsPerFile.set(relativePath, (countsPerFile.get(relativePath) ?? 0) + count);
        }

        for (const file of files.values()) {
          await writeFile(file.absolutePath, file.content, "utf8");
        }

        summary = [...countsPerFile.entries()]
          .map(([relativePath, count]) => `patched ${relativePath} (${count} replacement${count === 1 ? "" : "s"})`)
          .join("\n");
      } catch (error) {
        errorMessage = `edit[${currentIndex}] failed: ${describeError(error, undefined)}`;
      }

      if (errorMessage !== undefined) {
        await appendJournal(root, { tool: "patch", paths: attemptedPaths, result: `error: ${errorMessage}` });
        return errorResult(errorMessage);
      }

      await appendJournal(root, {
        tool: "patch",
        paths: attemptedPaths,
        detail: `${edits.length} edit${edits.length === 1 ? "" : "s"} across ${files.size} file${files.size === 1 ? "" : "s"}`,
        result: "ok",
      });
      return textResult(
        `${summary}\n${edits.length} edit${edits.length === 1 ? "" : "s"} across ${files.size} file${files.size === 1 ? "" : "s"}`,
      );
    },
  );
}
