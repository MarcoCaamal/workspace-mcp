import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { FileToolError, IGNORED_DIRS, MAX_LINE_CHARS, readForScan } from "../files.js";
import { matchGlob } from "../glob.js";
import { resolveSafe, toWorkspacePath } from "../paths.js";
import type { WorkspaceRegistry } from "../workspaces.js";
import { describeError, errorResult, textResult, workspaceArg } from "./shared.js";

const DEFAULT_MAX_RESULTS = 100;
const MAX_RESULTS_CAP = 1000;

export function registerGrepTool(server: McpServer, registry: WorkspaceRegistry): void {
  server.registerTool(
    "grep",
    {
      title: "Search file contents",
      description:
        "Search file contents in the workspace with a JavaScript regular expression and return matches as 'relative/path:LINE: <line text>'. " +
        "Use this to find where a symbol, string or pattern appears. Narrow the search with path and include. " +
        "Skips binary files and the .git, node_modules and .cache directories. " +
        "Do not use it to list files (use list_files) or to read a known file (use read_file).",
      inputSchema: {
        pattern: z.string().describe("JavaScript regular expression source, e.g. 'function\\s+main' or 'TODO:'. Not a shell glob."),
        path: z
          .string()
          .optional()
          .describe("File or directory to search, workspace-relative. Defaults to the workspace root."),
        include: z
          .string()
          .optional()
          .describe("Glob filter for file paths, e.g. '*.ts' or 'src/**/*.ts'. Patterns without a slash match the file name at any depth."),
        ignoreCase: z.boolean().optional().describe("Case-insensitive matching. Defaults to false."),
        maxResults: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Maximum number of matching lines to return. Defaults to 100 and is capped at 1000."),
        workspace: workspaceArg(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ pattern, path: targetPath, include, ignoreCase, maxResults, workspace }) => {
      const { root } = registry.resolve(workspace);
      let regex: RegExp;
      try {
        regex = new RegExp(pattern, ignoreCase === true ? "i" : "");
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return errorResult(`invalid regex: ${detail}`);
      }

      const limit = Math.min(maxResults ?? DEFAULT_MAX_RESULTS, MAX_RESULTS_CAP);

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

        const files = targetInfo.isDirectory() ? await collectFiles(targetAbsolute) : [targetAbsolute];
        files.sort(comparePaths);

        const results: string[] = [];
        const matchedFiles = new Set<string>();
        let stopped = false;

        for (const absolutePath of files) {
          const relativePath = toWorkspacePath(root, absolutePath);
          if (include !== undefined && include !== "" && !matchGlob(include, relativePath)) {
            continue;
          }

          const content = await readForScan(absolutePath);
          if (content === null) {
            continue;
          }

          const lines = content.split("\n");
          for (let index = 0; index < lines.length; index += 1) {
            const rawLine = (lines[index] as string).replace(/\r$/, "");
            if (!regex.test(rawLine)) {
              continue;
            }
            const line = rawLine.length > MAX_LINE_CHARS ? `${rawLine.slice(0, MAX_LINE_CHARS)}... (line truncated)` : rawLine;
            results.push(`${relativePath}:${index + 1}: ${line}`);
            matchedFiles.add(relativePath);
            if (results.length >= limit) {
              stopped = true;
              break;
            }
          }
          if (stopped) {
            break;
          }
        }

        if (results.length === 0) {
          return textResult(`no matches for /${pattern}/`);
        }

        const summary = stopped
          ? `${results.length} match${results.length === 1 ? "" : "es"} in ${matchedFiles.size} file${matchedFiles.size === 1 ? "" : "s"} (stopped at maxResults=${limit}; narrow the pattern or path to see more)`
          : `${results.length} match${results.length === 1 ? "" : "es"} in ${matchedFiles.size} file${matchedFiles.size === 1 ? "" : "s"}`;
        return textResult(`${results.join("\n")}\n\n${summary}`);
      } catch (error) {
        return errorResult(describeError(error, targetPath ?? "."));
      }
    },
  );
}

async function collectFiles(startDirectory: string): Promise<string[]> {
  const files: string[] = [];
  const queue: Array<{ directory: string; depth: number }> = [{ directory: startDirectory, depth: 0 }];

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const item = queue[cursor] as { directory: string; depth: number };
    let entries;
    try {
      entries = await readdir(item.directory, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      const absolutePath = path.join(item.directory, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) {
          continue;
        }
        queue.push({ directory: absolutePath, depth: item.depth + 1 });
      } else if (entry.isFile()) {
        files.push(absolutePath);
      }
    }
  }

  return files;
}

function comparePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
