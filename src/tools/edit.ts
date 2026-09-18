import { writeFile } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { FileToolError, readTextFile } from "../files.js";
import { resolveSafe, toWorkspacePath } from "../paths.js";
import { appendJournal } from "../state.js";
import type { WorkspaceRegistry } from "../workspaces.js";
import { describeError, errorResult, textResult, workspaceArg } from "./shared.js";

/** Counts non-overlapping occurrences of `needle` in `haystack`. */
export function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") {
    return 0;
  }
  let count = 0;
  let index = 0;
  for (;;) {
    const found = haystack.indexOf(needle, index);
    if (found === -1) {
      return count;
    }
    count += 1;
    index = found + needle.length;
  }
}

/**
 * Replaces either the first occurrence or every occurrence. Uses plain string
 * operations so `$&`-style replacement patterns in `newString` stay literal.
 */
export function applyReplacement(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): string {
  if (replaceAll) {
    return content.split(oldString).join(newString);
  }
  const index = content.indexOf(oldString);
  if (index === -1) {
    return content;
  }
  return content.slice(0, index) + newString + content.slice(index + oldString.length);
}

export function registerEditTool(server: McpServer, registry: WorkspaceRegistry): void {
  server.registerTool(
    "edit_file",
    {
      title: "Edit file",
      description:
        "Replace an exact string in an existing text file. The oldString must match the file content exactly, including whitespace and indentation. " +
        "If oldString appears more than once, either add more surrounding context to make it unique or set replaceAll=true. " +
        "Read the file first with read_file. The change is written to disk immediately and is not reversible. " +
        "For several files or several changes at once, prefer patch so all edits succeed or none are applied.",
      inputSchema: {
        path: z
          .string()
          .describe("Workspace-relative path of the file to edit. Absolute paths inside the workspace are also accepted."),
        oldString: z.string().min(1).describe("Exact text to replace. Must not be empty."),
        newString: z.string().describe("Replacement text. Use an empty string to delete the matched text."),
        replaceAll: z
          .boolean()
          .optional()
          .describe("Replace every occurrence instead of requiring a unique match. Defaults to false."),
        workspace: workspaceArg(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ path: userPath, oldString, newString, replaceAll, workspace }) => {
      const { root } = registry.resolve(workspace);
      let relativePath: string | undefined;
      try {
        const absolutePath = await resolveSafe(root, userPath);
        relativePath = toWorkspacePath(root, absolutePath);
        const content = await readTextFile(absolutePath, relativePath);

        const count = countOccurrences(content, oldString);
        if (count === 0) {
          throw new FileToolError(`oldString not found in ${relativePath}`);
        }
        if (count > 1 && replaceAll !== true) {
          throw new FileToolError(
            `oldString appears ${count} times in ${relativePath}; add more surrounding context or set replaceAll=true`,
          );
        }

        const updated = applyReplacement(content, oldString, newString, replaceAll === true);
        await writeFile(absolutePath, updated, "utf8");
        await appendJournal(root, {
          tool: "edit_file",
          paths: [relativePath],
          detail: `${count} replacement${count === 1 ? "" : "s"}`,
          result: "ok",
        });
        return textResult(`Replaced ${count} occurrence${count === 1 ? "" : "s"} in ${relativePath}`);
      } catch (error) {
        const message = describeError(error, userPath);
        await appendJournal(root, {
          tool: "edit_file",
          paths: [relativePath ?? userPath],
          result: `error: ${message}`,
        });
        return errorResult(message);
      }
    },
  );
}
