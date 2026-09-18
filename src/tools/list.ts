import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { FileToolError, IGNORED_DIRS, isTextFile } from "../files.js";
import { matchGlob } from "../glob.js";
import { resolveSafe, toWorkspacePath } from "../paths.js";
import type { WorkspaceRegistry } from "../workspaces.js";
import { describeError, errorResult, textResult, workspaceArg } from "./shared.js";

const DEFAULT_LIMIT = 500;
const LIMIT_CAP = 5000;
const DEFAULT_MAX_DEPTH = 6;
const MAX_DEPTH_CAP = 12;

interface Entry {
  key: string;
  isDirectory: boolean;
}

export function registerListTool(server: McpServer, registry: WorkspaceRegistry): void {
  server.registerTool(
    "list_files",
    {
      title: "List files",
      description:
        "List files and directories inside the workspace, sorted by workspace-relative path. Directories are marked with a trailing '/'. " +
        "Use this to discover what exists before reading or editing, optionally filtered with a glob pattern. " +
        "Skips the .git, node_modules and .cache directories and does not follow symbolic links. " +
        "Do not use it to read content (use read_file) or to search text (use grep).",
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe("Directory to list, workspace-relative. Defaults to the workspace root."),
        pattern: z
          .string()
          .optional()
          .describe("Glob filter such as '*.ts', 'src/**' or '**/*.{js,json}'. Patterns without a slash match the name at any depth. Defaults to all entries."),
        maxDepth: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Maximum directory depth to descend. Defaults to 6 and is capped at 12."),
        limit: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Maximum number of entries to return. Defaults to 500 and is capped at 5000."),
        workspace: workspaceArg(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ path: targetPath, pattern, maxDepth, limit, workspace }) => {
      const { root } = registry.resolve(workspace);
      const effectiveLimit = Math.min(limit ?? DEFAULT_LIMIT, LIMIT_CAP);
      const effectiveMaxDepth = Math.min(maxDepth ?? DEFAULT_MAX_DEPTH, MAX_DEPTH_CAP);

      try {
        const targetAbsolute = await resolveSafe(root, targetPath ?? ".");
        const targetRelative = toWorkspacePath(root, targetAbsolute);

        let targetInfo;
        try {
          targetInfo = await stat(targetAbsolute);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            throw new FileToolError(`path not found: ${targetRelative}`);
          }
          throw error;
        }
        if (!targetInfo.isDirectory()) {
          throw new FileToolError(`not a directory: ${targetRelative}`);
        }

        const entries = new Map<string, Entry>();
        const queue: Array<{ directory: string; depth: number }> = [{ directory: targetAbsolute, depth: 0 }];

        for (let cursor = 0; cursor < queue.length; cursor += 1) {
          const item = queue[cursor] as { directory: string; depth: number };
          let children;
          try {
            children = await readdir(item.directory, { withFileTypes: true });
          } catch {
            continue;
          }

          for (const child of children) {
            if (child.isSymbolicLink()) {
              continue;
            }
            const childDepth = item.depth + 1;
            if (childDepth > effectiveMaxDepth) {
              continue;
            }

            const absolutePath = path.join(item.directory, child.name);
            const relativePath = toWorkspacePath(root, absolutePath);

            if (child.isDirectory()) {
              if (IGNORED_DIRS.has(child.name)) {
                continue;
              }
              queue.push({ directory: absolutePath, depth: childDepth });
              if (matches(pattern, relativePath)) {
                entries.set(relativePath, { key: relativePath, isDirectory: true });
              }
            } else if (child.isFile()) {
              if (matches(pattern, relativePath) && (await isTextFile(absolutePath))) {
                entries.set(relativePath, { key: relativePath, isDirectory: false });
              }
            }
          }
        }

        const sorted = [...entries.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
        const visible = sorted.slice(0, effectiveLimit);
        const lines = visible.map((entry) => (entry.isDirectory ? `${entry.key}/` : entry.key));

        if (lines.length === 0) {
          return textResult(pattern ? `no entries match pattern: ${pattern}` : `no entries found in ${targetRelative}`);
        }

        const header = `${lines.length} entr${lines.length === 1 ? "y" : "ies"}${pattern ? ` matching ${pattern}` : ""}`;
        const footer =
          sorted.length > visible.length
            ? `\n... (showing ${visible.length} of ${sorted.length} entries; increase limit to see more)`
            : "";
        return textResult(`${header}\n${lines.join("\n")}${footer}`);
      } catch (error) {
        return errorResult(describeError(error, targetPath ?? "."));
      }
    },
  );
}

function matches(pattern: string | undefined, relativePath: string): boolean {
  return pattern === undefined || pattern === "" || matchGlob(pattern, relativePath);
}
