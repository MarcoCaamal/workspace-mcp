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

/** One catalog entry: skill directory name plus the trigger that calls for it. */
export interface ChatSkillEntry {
  readonly name: string;
  readonly trigger: string;
}

/**
 * MCP-local chat skill catalog (single source of truth). Rendered into the
 * server instructions AND the session bootstrap block, so chats see it
 * whether or not their client surfaces initialization instructions.
 * Keep this list identical to the seeded `<skillsDir>/<name>/SKILL.md` set.
 */
export const HARNESS_CHAT_SKILLS: readonly ChatSkillEntry[] = [
  { name: "work-setup", trigger: "work_start: ask mode (interactive/automatic) and delivery (single-pr/chained)" },
  { name: "work-unit-commits", trigger: "implementation: commit splitting, chained PRs, tests with code" },
  { name: "jira-task", trigger: "Jira task, ticket, or issue: parent/child structure with title conventions" },
  { name: "jira-epic", trigger: "Jira epic or large feature: overview, requirements, split into tasks" },
  { name: "cognitive-doc-design", trigger: "guides, READMEs, RFCs, onboarding, architecture, or review-facing docs" },
  { name: "issue-creation", trigger: "GitHub issues, bug reports, or feature requests" },
  { name: "comment-writer", trigger: "PR feedback, issue replies, reviews, or human-read comments" },
  { name: "github-pr", trigger: "creating PRs, PR descriptions, or gh CLI pull requests" },
  { name: "chained-pr", trigger: "PRs over 400 lines, stacked PRs, review slices" },
  { name: "sdd-explore", trigger: "exploring an idea: codebase investigation, approaches, explore stage" },
  { name: "sdd-propose", trigger: "change proposal: intent, scope, approach, propose stage" },
  { name: "sdd-spec", trigger: "requirements with RFC 2119 keywords and Given/When/Then, spec stage" },
  { name: "sdd-design", trigger: "technical approach with decisions and rationale, design stage" },
  { name: "sdd-tasks", trigger: "task breakdown with workload forecast, tasks stage" },
  { name: "sdd-apply", trigger: "implementing tasks with tests and evidence, apply stage" },
  { name: "sdd-verify", trigger: "requested verification diagnostics, verify stage" },
  { name: "sdd-archive", trigger: "closing a change with its honest final state, archive stage" },
];

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
