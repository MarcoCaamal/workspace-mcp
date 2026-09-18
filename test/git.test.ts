import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type CreateServerOptions } from "../src/server.js";

interface ToolResponse {
  text: string;
  isError: boolean;
}

interface Session {
  client: Client;
  server: McpServer;
}

async function connect(options: { root: string } & Omit<CreateServerOptions, "workspaces">): Promise<Session> {
  const { root, ...rest } = options;
  const server = createServer({ workspaces: [{ name: "default", path: root }], ...rest });
  const client = new Client({ name: "workspace-mcp-git-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, server };
}

async function close(session: Session): Promise<void> {
  await session.client.close().catch(() => undefined);
  await session.server.close().catch(() => undefined);
}

async function callTool(session: Session, name: string, args: Record<string, unknown>): Promise<ToolResponse> {
  const result = await session.client.callTool({ name, arguments: args });
  const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
  const text = content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
  return { text, isError: result.isError === true };
}

function git(dir: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", [...args], { cwd: dir }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`git ${args.join(" ")} failed: ${stderr.trim() || error.message}`));
        return;
      }
      resolve(stdout);
    });
  });
}

let repo: string;
let session: Session;

beforeAll(async () => {
  repo = await mkdtemp(path.join(tmpdir(), "workspace-mcp-git-"));
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.email", "workspace-mcp@example.com"]);
  await git(repo, ["config", "user.name", "workspace-mcp tests"]);
  await writeFile(path.join(repo, "tracked.txt"), "line one\n");
  await writeFile(path.join(repo, "other.txt"), "other one\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "initial"]);
  session = await connect({ root: repo, version: "test" });
});

afterAll(async () => {
  await close(session);
  await rm(repo, { recursive: true, force: true });
});

describe("git_status", () => {
  it("reports the branch plus modified and untracked porcelain lines", async () => {
    await writeFile(path.join(repo, "tracked.txt"), "line one changed\n");
    await writeFile(path.join(repo, "untracked.txt"), "new\n");

    const response = await callTool(session, "git_status", {});
    expect(response.isError).toBe(false);
    expect(response.text).toMatch(/^branch: /m);
    expect(response.text).toContain(" M tracked.txt");
    expect(response.text).toContain("?? untracked.txt");
    expect(response.text).not.toContain("working tree clean");
  });

  it("reports a clean error outside a git repository", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "workspace-mcp-nogit-"));
    try {
      const realDir = await realpath(dir);
      const isolated = await connect({ root: dir, version: "test" });
      try {
        const response = await callTool(isolated, "git_status", {});
        expect(response.isError).toBe(true);
        expect(response.text).toBe(`not a git repository: ${realDir}`);
      } finally {
        await close(isolated);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports git not found in PATH when the binary cannot be resolved", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "workspace-mcp-nopath-"));
    const emptyPath = await mkdtemp(path.join(tmpdir(), "workspace-mcp-empty-bin-"));
    try {
      const isolated = await connect({ root: dir, version: "test" });
      const originalPath = process.env.PATH;
      process.env.PATH = emptyPath;
      try {
        const response = await callTool(isolated, "git_status", {});
        expect(response.isError).toBe(true);
        expect(response.text).toBe("git not found in PATH");
      } finally {
        process.env.PATH = originalPath;
        await close(isolated);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(emptyPath, { recursive: true, force: true });
    }
  });
});

describe("git_diff", () => {
  it("shows unstaged changes and honors the path filter", async () => {
    await writeFile(path.join(repo, "other.txt"), "other one changed\n");

    const all = await callTool(session, "git_diff", {});
    expect(all.isError).toBe(false);
    expect(all.text).toContain("diff --git");
    expect(all.text).toContain("+line one changed");
    expect(all.text).toContain("+other one changed");

    const filtered = await callTool(session, "git_diff", { path: "other.txt" });
    expect(filtered.isError).toBe(false);
    expect(filtered.text).toContain("other.txt");
    expect(filtered.text).toContain("+other one changed");
    expect(filtered.text).not.toContain("line one changed");
  });

  it("shows staged changes with staged=true and empty unstaged diffs afterwards", async () => {
    await git(repo, ["add", "tracked.txt", "other.txt"]);

    const staged = await callTool(session, "git_diff", { staged: true });
    expect(staged.isError).toBe(false);
    expect(staged.text).toContain("+line one changed");
    expect(staged.text).toContain("+other one changed");

    const unstaged = await callTool(session, "git_diff", { path: "tracked.txt" });
    expect(unstaged.text).toBe("(no changes)");
  });

  it("supports stat output", async () => {
    const response = await callTool(session, "git_diff", { staged: true, stat: true });
    expect(response.isError).toBe(false);
    expect(response.text).toContain("tracked.txt");
    expect(response.text).toMatch(/2 files changed/);
  });

  it("reports (no changes) on a clean tree", async () => {
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-m", "second"]);

    const response = await callTool(session, "git_diff", {});
    expect(response.isError).toBe(false);
    expect(response.text).toBe("(no changes)");
  });
});
