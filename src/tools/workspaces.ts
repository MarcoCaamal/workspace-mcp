import { existsSync } from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { STATE_DIR_NAME, activeChangeId } from "../state.js";
import type { WorkspaceRegistry } from "../workspaces.js";
import { describeError, errorResult, textResult } from "./shared.js";

/**
 * Registers `workspace_list`: the discovery tool that tells the model which
 * named workspaces this process serves and where each one lives.
 */
export function registerWorkspaceTools(server: McpServer, registry: WorkspaceRegistry): void {
  server.registerTool(
    "workspace_list",
    {
      title: "List workspaces",
      description:
        "Read-only list of the named project workspaces served by this process: name, absolute root path, which one is primary, " +
        "whether it already has workspace state under .workspace-mcp/, and the id of its active change when state.json exists. " +
        "Every path or state tool accepts an optional workspace argument (defaults to the primary workspace), so call this first to discover the available names.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const lines: string[] = [];
        for (const workspace of registry.list()) {
          const stateDirPath = path.join(workspace.root, STATE_DIR_NAME);
          const statePresent = existsSync(stateDirPath);
          const stateJsonPresent = existsSync(path.join(stateDirPath, "state.json"));
          const active = stateJsonPresent ? await activeChangeId(workspace.root) : null;
          const primary = workspace.name === registry.primary ? "  (primary)" : "";
          lines.push(
            `- ${workspace.name}  ${workspace.root}${primary}  state: ${statePresent ? "present" : "absent"}  active change: ${active ?? "none"}`,
          );
        }
        return textResult(`Workspaces (${lines.length}):\n${lines.join("\n")}`);
      } catch (error) {
        return errorResult(describeError(error));
      }
    },
  );
}
