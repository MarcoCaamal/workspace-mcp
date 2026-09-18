import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { FileToolError } from "../files.js";
import { WorkspacePathError } from "../paths.js";
import type { CapturedOutput } from "../shell.js";
import type { JournalEntry } from "../state.js";
import { WorkspaceError } from "../workspaces.js";

/**
 * Shared optional `workspace` argument so every path, state and shell tool
 * documents it identically. Omitted means the primary workspace.
 */
export function workspaceArg() {
  return z.string().optional().describe("Workspace name (see workspace_list). Defaults to the primary workspace.");
}

/** Successful tool result containing a single text block. */
export function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

/**
 * Failed tool result. The message must be one short, actionable sentence and
 * must never contain stack traces or raw filesystem error dumps.
 */
export function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

/**
 * Renders captured command output: the full text when nothing was dropped,
 * otherwise the retained head, a truncation marker and the retained tail.
 * Shared by run_command and job_status so both present output the same way.
 */
export function renderCapturedOutputBody(output: CapturedOutput): string {
  const body =
    output.truncatedBytes > 0
      ? [output.text, `... (${output.truncatedBytes} bytes truncated) ...`, output.tail]
          .filter((part) => part.length > 0)
          .join("\n")
      : output.text;

  return body.trim() === "" ? "(no output)" : body.replace(/\n+$/, "");
}

/** {@link renderCapturedOutputBody} plus a trailing status line. */
export function renderCapturedOutput(output: CapturedOutput, status: string): string {
  return `${renderCapturedOutputBody(output)}\n\n${status}`;
}

/** One journal entry rendered as a single line, shared by work_log and change_status. */
export function renderJournalEntry(entry: JournalEntry): string {
  const parts = [entry.ts, entry.tool];
  if (entry.paths !== undefined && entry.paths.length > 0) {
    parts.push(entry.paths.join(", "));
  }
  if (entry.detail !== undefined && entry.detail !== "") {
    parts.push(`\u2014 ${entry.detail}`);
  }
  const line = parts.join("  ");
  return entry.result !== undefined && entry.result !== "" ? `${line}  [${entry.result}]` : line;
}

/**
 * Maps an unknown error to a short client-safe message. Full details (stack
 * included) are written to stderr, which is safe: the MCP protocol stream is
 * stdout only.
 */
export function describeError(error: unknown, fallbackPath?: string): string {
  if (error instanceof WorkspacePathError || error instanceof FileToolError || error instanceof WorkspaceError) {
    return error.message;
  }

  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const suffix = fallbackPath ? `: ${fallbackPath}` : "";
  switch (code) {
    case "ENOENT":
      return `path not found${suffix}`;
    case "EACCES":
    case "EPERM":
      return `permission denied${suffix}`;
    case "EISDIR":
      return `path is a directory, not a file${suffix}`;
    case "ENOTDIR":
      return `a path component is not a directory${suffix}`;
    default:
      break;
  }

  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`[workspace-mcp] internal tool error: ${detail}\n`);
  return `unexpected internal error${suffix}`;
}
