import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, HARNESS_CHAT_SKILLS, buildInstructions } from "../src/server.js";
import { renderBootstrapBlock } from "../src/tools/recall.js";
import { defaultSkillsDir, resolveSkillsDir } from "../src/config.js";
import {
  SKILL_BODY_MAX_CHARS,
  registerHarnessSkillTool,
} from "../src/tools/harness-skill.js";
import type { HarnessStore } from "../src/session-store.js";
import { openHarnessStore } from "../src/session-store.js";
import type { WorkspaceConfig } from "../src/workspaces.js";
import { WorkspaceRegistry } from "../src/workspaces.js";

/**
 * ODD harness-chat-skills, T1 (TDD RED): the linear harness chat needs its
 * own MCP-local skills folder plus a `harness_skill` list/get tool. Skills
 * live outside the repo (`~/.config/workspace-mcp/skills/`); the tool only
 * reads them. Nothing here may become repo-local state.
 */

const SETUP_BODY = `---\nname: work-setup\ndescription: "Trigger: work_start. Ask mode and delivery options."\n---\n\n# Work setup\n\nAsk interactive/automatic and single-pr/chained.\n`;
const WUC_BODY = "# Work unit commits\n\nKeep tests and docs with the unit they verify.\n";

let skillsDir: string;
let sandbox: string;

async function seedSkills(): Promise<void> {
  await mkdir(path.join(skillsDir, "work-setup"), { recursive: true });
  await writeFile(path.join(skillsDir, "work-setup", "SKILL.md"), SETUP_BODY);
  await mkdir(path.join(skillsDir, "work-unit-commits"), { recursive: true });
  await writeFile(path.join(skillsDir, "work-unit-commits", "SKILL.md"), WUC_BODY);
  await mkdir(path.join(skillsDir, "huge-skill"), { recursive: true });
  await writeFile(path.join(skillsDir, "huge-skill", "SKILL.md"), `x`.repeat(SKILL_BODY_MAX_CHARS + 500));
}

async function callSkill(skills: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const server: McpServer = new McpServer({ name: "skills-red-client", version: "test" });
  registerHarnessSkillTool(server, skills);
  const client = new Client({ name: "skills-red-caller", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const result = await client.callTool({ name: "harness_skill", arguments: args });
    const content = result.content as Array<{ type: string; text?: string }>;
    return { text: content.map((part) => part.text ?? "").join("\n"), isError: result.isError === true };
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}

describe("harness skills dir resolution", () => {
  it("defaults outside the repo and honors explicit config", () => {
    expect(defaultSkillsDir({})).toBe(path.join(process.env.HOME ?? "", ".config", "workspace-mcp", "skills"));
    expect(defaultSkillsDir({ XDG_CONFIG_HOME: "/tmp/xdg" })).toBe("/tmp/xdg/workspace-mcp/skills");
    expect(resolveSkillsDir(undefined, {})).toBe(defaultSkillsDir({}));
    expect(resolveSkillsDir("/tmp/custom-skills", {})).toBe("/tmp/custom-skills");
  });
});

describe("harness_skill tool", () => {
  beforeAll(async () => {
    sandbox = await mkdtemp(path.join(tmpdir(), "workspace-mcp-skills-"));
    skillsDir = path.join(sandbox, "skills");
    await mkdir(skillsDir, { recursive: true });
    await seedSkills();
  });

  afterAll(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  it("lists seeded skill names", async () => {
    const { text, isError } = await callSkill(skillsDir, { action: "list" });
    expect(isError).toBe(false);
    expect(text).toContain("work-setup");
    expect(text).toContain("work-unit-commits");
  });

  it("returns the exact body on get", async () => {
    const { text, isError } = await callSkill(skillsDir, { action: "get", name: "work-setup" });
    expect(isError).toBe(false);
    expect(text).toBe(SETUP_BODY);
  });

  it("rejects unknown skills explicitly", async () => {
    const { text, isError } = await callSkill(skillsDir, { action: "get", name: "nope-missing" });
    expect(isError).toBe(true);
    expect(text).toMatch(/unknown skill/i);
  });

  it("rejects traversal names without touching the filesystem outside", async () => {
    for (const name of ["../escape", "a/b", ".."]) {
      const { isError } = await callSkill(skillsDir, { action: "get", name });
      expect(isError).toBe(true);
    }
  });

  it("returns empty plus hint when the dir is missing, and truncates huge bodies", async () => {
    const missing = await callSkill(path.join(sandbox, "absent"), { action: "list" });
    expect(missing.isError).toBe(false);
    expect(missing.text).toMatch(/no skills/i);
    const huge = await callSkill(skillsDir, { action: "get", name: "huge-skill" });
    expect(huge.isError).toBe(false);
    expect(huge.text).toMatch(/truncated \d+ chars/);
    expect(huge.text.length).toBeLessThanOrEqual(SKILL_BODY_MAX_CHARS + 100);
  });
});

describe("harness_skill registration gate", () => {
  let store: HarnessStore;
  let dbDir: string;
  const workspaces: WorkspaceConfig[] = [{ name: "ws", path: "" }];

  beforeAll(async () => {
    dbDir = await mkdtemp(path.join(tmpdir(), "workspace-mcp-skills-gate-"));
    workspaces[0]!.path = await mkdtemp(path.join(tmpdir(), "workspace-mcp-skills-ws-"));
    store = openHarnessStore({ dbPath: path.join(dbDir, "harness.db"), workspaceRoots: [workspaces[0]!.path] });
    store.open();
  });

  afterAll(async () => {
    store.close();
    await rm(dbDir, { recursive: true, force: true });
    await rm(workspaces[0]!.path, { recursive: true, force: true });
  });

  async function toolNames(harness: { session?: boolean; recall?: boolean } | undefined): Promise<string[]> {
    const server: McpServer = createServer({
      workspaces,
      version: "test",
      harness: harness === undefined ? undefined : { ...harness, store, skillsDir },
    });
    const client = new Client({ name: "skills-gate-caller", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    try {
      const tools = await client.listTools();
      return tools.tools.map((tool) => tool.name);
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  }

  it("registers harness_skill only under harness.session", async () => {
    expect(await toolNames({ session: true })).toContain("harness_skill");
    expect(await toolNames(undefined)).not.toContain("harness_skill");
    expect(await toolNames({ recall: true })).not.toContain("harness_skill");
  });
});

describe("chat skills catalog in instructions", () => {
  let wsRoot: string;

  beforeAll(async () => {
    wsRoot = await mkdtemp(path.join(tmpdir(), "workspace-mcp-skills-catalog-"));
  });

  afterAll(async () => {
    await rm(wsRoot, { recursive: true, force: true });
  });

  function instructions(harness: { session?: boolean } | undefined): string {
    const registry = new WorkspaceRegistry([{ name: "ws", path: wsRoot }]);
    return buildInstructions(registry, undefined, harness);
  }

  it("lists every catalog skill with its trigger under harness.session", () => {
    const text = instructions({ session: true });
    expect(HARNESS_CHAT_SKILLS.length).toBeGreaterThan(0);
    for (const skill of HARNESS_CHAT_SKILLS) {
      expect(text).toContain(skill.name);
      expect(text).toContain(skill.trigger);
    }
    expect(text).toContain("harness_skill");
  });

  it("catalog covers all ported skills", () => {
    const names = HARNESS_CHAT_SKILLS.map((skill) => skill.name);
    for (const expected of [
      "work-setup",
      "work-unit-commits",
      "jira-task",
      "jira-epic",
      "cognitive-doc-design",
      "issue-creation",
      "comment-writer",
      "github-pr",
      "chained-pr",
      "sdd-explore",
      "sdd-propose",
      "sdd-spec",
      "sdd-design",
      "sdd-tasks",
      "sdd-apply",
      "sdd-verify",
      "sdd-archive",
    ]) {
      expect(names).toContain(expected);
    }
  });

  it("omits the catalog without harness.session", () => {
    expect(instructions(undefined)).not.toContain("Chat skills");
    expect(instructions({})).not.toContain("Chat skills");
  });

  it("bootstrap block carries the catalog on the always-visible channel", () => {
    const block = renderBootstrapBlock({
      sessionId: "s",
      primaryWorkspace: "/ws",
      works: [],
      latestSummary: null,
      next: "explore",
    });
    for (const skill of HARNESS_CHAT_SKILLS) {
      expect(block).toContain(skill.name);
    }
    expect(block).toContain("harness_skill");
    expect(block.length).toBeLessThanOrEqual(2000);
  });
});
