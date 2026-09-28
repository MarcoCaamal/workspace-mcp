import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { describeError, errorResult, textResult } from "./shared.js";

/**
 * MCP-local chat skills (ODD harness-chat-skills, T1).
 *
 * The linear harness chat has no subagents, so procedures live as Markdown
 * files under an outside-repo skills directory
 * (`~/.config/workspace-mcp/skills/<name>/SKILL.md`). This tool only reads
 * them: `list` names the installed skills, `get` returns one body. Nothing
 * is ever written here by the MCP, and skill contents never enter the repo.
 */

/** Skill names are lowercase slug directories; nothing else resolves. */
export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
/** Bodies larger than this are truncated with an explicit marker, never cut silently. */
export const SKILL_BODY_MAX_CHARS = 32768;

function skillFile(skillsDir: string, name: string): string {
  return path.join(skillsDir, name, "SKILL.md");
}

/** Sorted installed skill names. A missing directory means no skills, never an error. */
export async function listSkillNames(skillsDir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory() && SKILL_NAME_PATTERN.test(entry.name)) {
      names.push(entry.name);
    }
  }
  return names.sort();
}

export interface SkillRead {
  found: boolean;
  body: string;
}

/** Reads one skill body. Unknown names and invalid names resolve to `found: false`, never a path escape. */
export async function readSkillBody(skillsDir: string, name: string): Promise<SkillRead> {
  if (!SKILL_NAME_PATTERN.test(name)) {
    return { found: false, body: "" };
  }
  let body: string;
  try {
    body = await readFile(skillFile(skillsDir, name), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { found: false, body: "" };
    }
    throw error;
  }
  if (body.length <= SKILL_BODY_MAX_CHARS) {
    return { found: true, body };
  }
  const removed = body.length - SKILL_BODY_MAX_CHARS;
  const marker = `… [truncated ${removed} chars]`;
  return { found: true, body: `${body.slice(0, SKILL_BODY_MAX_CHARS - marker.length)}${marker}` };
}

const skillActionSchema = z.enum(["list", "get"]).describe("list names the installed skills; get returns one SKILL.md body.");
const skillNameSchema = z
  .string()
  .min(1)
  .max(64)
  .describe("Skill directory name (lowercase slug). Required for get.");

/** Registers `harness_skill`. The caller gates this on `harness.session`. */
export function registerHarnessSkillTool(server: McpServer, skillsDir: string): void {
  server.registerTool(
    "harness_skill",
    {
      title: "Read harness chat skills",
      description:
        "List or read the MCP-local chat skill library (procedures for the linear harness chat: work setup, Jira, delivery, SDD stages). " +
        "Use list to discover names, then get with an explicit name to load one body before following it. " +
        "Skills are read-only reference; they never read or write harness sessions, works, or metrics.",
      inputSchema: {
        action: skillActionSchema,
        name: skillNameSchema.optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ action, name }) => {
      try {
        if (action === "list") {
          const names = await listSkillNames(skillsDir);
          if (names.length === 0) {
            return textResult(`No skills installed under ${skillsDir}. Add <name>/SKILL.md directories there to extend the chat.`);
          }
          return textResult(`Skills (${names.length}):\n${names.map((skill) => `- ${skill}`).join("\n")}`);
        }
        if (name === undefined || name.trim() === "") {
          return errorResult("skill name is required for get");
        }
        const read = await readSkillBody(skillsDir, name);
        if (!read.found) {
          return errorResult(`unknown skill: ${name}`);
        }
        return textResult(read.body);
      } catch (error) {
        return errorResult(`skills unavailable: ${describeError(error)}`);
      }
    },
  );
}
