import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";

interface ToolResponse {
  text: string;
  isError: boolean;
}

let root: string;
let outside: string;
let client: Client;
let server: McpServer;

async function callTool(name: string, args: Record<string, unknown>): Promise<ToolResponse> {
  const result = await client.callTool({ name, arguments: args });
  const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
  const text = content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
  return { text, isError: result.isError === true };
}

function lines(count: number): string {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n");
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "workspace-mcp-e2e-"));
  outside = await mkdtemp(path.join(tmpdir(), "workspace-mcp-e2e-outside-"));
  await symlink(outside, path.join(root, "escape"));
  await writeFile(path.join(outside, "secret.txt"), "secret\n");

  server = createServer({ workspaces: [{ name: "default", path: root }], version: "test" });
  client = new Client({ name: "workspace-mcp-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
});

afterAll(async () => {
  await client.close().catch(() => undefined);
  await server.close().catch(() => undefined);
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe("handshake and tool discovery", () => {
  it("lists exactly the nineteen always-on tools", async () => {
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();
    expect(names).toEqual([
      "change_activate",
      "change_create",
      "change_doc",
      "change_status",
      "constraint_add",
      "edit_file",
      "git_diff",
      "git_status",
      "grep",
      "list_files",
      "patch",
      "read_file",
      "recall",
      "remember",
      "task_add",
      "task_update",
      "work_log",
      "workspace_list",
      "write_file",
    ]);
  });

  it("exposes the expected annotations", async () => {
    const listed = await client.listTools();
    const tools = new Map(listed.tools.map((tool) => [tool.name, tool]));
    expect(tools.get("read_file")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.get("grep")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.get("list_files")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.get("work_log")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.get("recall")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.get("git_status")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.get("git_diff")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.get("change_status")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.get("write_file")?.annotations?.destructiveHint).toBe(true);
    expect(tools.get("edit_file")?.annotations?.destructiveHint).toBe(true);
    expect(tools.get("patch")?.annotations?.destructiveHint).toBe(true);
  });

  it("sends instructions mentioning the workspace root and conventions", () => {
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toContain(root);
    expect(instructions).toContain("workspace-relative");
    expect(instructions).toContain("not reversible");
  });
});

describe("write_file and read_file", () => {
  it("creates parent directories and reports the byte count", async () => {
    const response = await callTool("write_file", { path: "notes/hello.txt", content: "first\nsecond\nthird" });
    expect(response.isError).toBe(false);
    expect(response.text).toBe("Created notes/hello.txt (18 bytes)");
  });

  it("reads back content with 1-based line numbers", async () => {
    const response = await callTool("read_file", { path: "notes/hello.txt" });
    expect(response.isError).toBe(false);
    expect(response.text).toBe("1: first\n2: second\n3: third");
  });

  it("reports Updated when overwriting an existing file", async () => {
    const response = await callTool("write_file", { path: "notes/hello.txt", content: "changed" });
    expect(response.text).toBe("Updated notes/hello.txt (7 bytes)");
    expect(await readFile(path.join(root, "notes", "hello.txt"), "utf8")).toBe("changed");
  });

  it("supports offset and limit with a truncation note", async () => {
    await callTool("write_file", { path: "notes/lines.txt", content: lines(10) });
    const response = await callTool("read_file", { path: "notes/lines.txt", offset: 3, limit: 2 });
    expect(response.text).toBe("3: line 3\n4: line 4\n... (truncated at line 4 of 10)");

    const tail = await callTool("read_file", { path: "notes/lines.txt", offset: 9, limit: 5 });
    expect(tail.text).toBe("9: line 9\n10: line 10");
  });

  it("caps a segment at 2000 lines", async () => {
    await callTool("write_file", { path: "notes/big.txt", content: lines(2100) });
    const response = await callTool("read_file", { path: "notes/big.txt", limit: 5000 });
    const rendered = response.text.split("\n");
    expect(rendered).toHaveLength(2001);
    expect(rendered[0]).toBe("1: line 1");
    expect(rendered[1999]).toBe("2000: line 2000");
    expect(rendered[2000]).toBe("... (truncated at line 2000 of 2100)");
  });

  it("truncates very long lines with a marker", async () => {
    await callTool("write_file", { path: "notes/long.txt", content: "x".repeat(2500) });
    const response = await callTool("read_file", { path: "notes/long.txt" });
    expect(response.text).toContain("... (line truncated)");
    expect(response.text.length).toBeLessThan(2200);
  });

  it("rejects binary files", async () => {
    await writeFile(path.join(root, "notes", "bin.dat"), Buffer.from([0x00, 0x01, 0x02, 0x00]));
    const response = await callTool("read_file", { path: "notes/bin.dat" });
    expect(response.isError).toBe(true);
    expect(response.text).toMatch(/^binary file cannot be read as text: notes\/bin.dat$/);
  });

  it("reports missing files and directories with short messages", async () => {
    const missing = await callTool("read_file", { path: "notes/missing.txt" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toBe("file not found: notes/missing.txt");

    const directory = await callTool("read_file", { path: "notes" });
    expect(directory.isError).toBe(true);
    expect(directory.text).toBe("path is a directory, not a file: notes");
  });
});

describe("edit_file", () => {
  it("replaces a unique match", async () => {
    await callTool("write_file", { path: "edit/unique.txt", content: "hello world\n" });
    const response = await callTool("edit_file", {
      path: "edit/unique.txt",
      oldString: "world",
      newString: "there",
    });
    expect(response.isError).toBe(false);
    expect(response.text).toBe("Replaced 1 occurrence in edit/unique.txt");
    expect(await readFile(path.join(root, "edit", "unique.txt"), "utf8")).toBe("hello there\n");
  });

  it("fails when oldString is not found", async () => {
    const response = await callTool("edit_file", {
      path: "edit/unique.txt",
      oldString: "not-present",
      newString: "x",
    });
    expect(response.isError).toBe(true);
    expect(response.text).toBe("oldString not found in edit/unique.txt");
  });

  it("fails on ambiguous matches unless replaceAll is set", async () => {
    await callTool("write_file", { path: "edit/ambiguous.txt", content: "a\na\n" });
    const ambiguous = await callTool("edit_file", { path: "edit/ambiguous.txt", oldString: "a", newString: "b" });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.text).toBe(
      "oldString appears 2 times in edit/ambiguous.txt; add more surrounding context or set replaceAll=true",
    );

    const replaceAll = await callTool("edit_file", {
      path: "edit/ambiguous.txt",
      oldString: "a",
      newString: "b",
      replaceAll: true,
    });
    expect(replaceAll.isError).toBe(false);
    expect(replaceAll.text).toBe("Replaced 2 occurrences in edit/ambiguous.txt");
    expect(await readFile(path.join(root, "edit", "ambiguous.txt"), "utf8")).toBe("b\nb\n");
  });

  it("rejects an empty oldString", async () => {
    const response = await callTool("edit_file", { path: "edit/ambiguous.txt", oldString: "", newString: "x" });
    expect(response.isError).toBe(true);
  });
});

describe("patch", () => {
  it("applies every edit across files when all are valid", async () => {
    await callTool("write_file", { path: "patch/a.txt", content: "alpha\n" });
    await callTool("write_file", { path: "patch/b.txt", content: "bravo\n" });

    const response = await callTool("patch", {
      edits: [
        { path: "patch/a.txt", oldString: "alpha", newString: "ALPHA" },
        { path: "patch/b.txt", oldString: "bravo", newString: "BRAVO" },
      ],
    });
    expect(response.isError).toBe(false);
    expect(response.text).toContain("patched patch/a.txt (1 replacement)");
    expect(response.text).toContain("patched patch/b.txt (1 replacement)");
    expect(response.text).toContain("2 edits across 2 files");
    expect(await readFile(path.join(root, "patch", "a.txt"), "utf8")).toBe("ALPHA\n");
    expect(await readFile(path.join(root, "patch", "b.txt"), "utf8")).toBe("BRAVO\n");
  });

  it("validates later edits against earlier edits on the same file", async () => {
    const response = await callTool("patch", {
      edits: [
        { path: "patch/a.txt", oldString: "ALPHA", newString: "one" },
        { path: "patch/a.txt", oldString: "one", newString: "two" },
      ],
    });
    expect(response.isError).toBe(false);
    expect(await readFile(path.join(root, "patch", "a.txt"), "utf8")).toBe("two\n");
  });

  it("is all-or-nothing: one invalid edit modifies no file", async () => {
    const response = await callTool("patch", {
      edits: [
        { path: "patch/a.txt", oldString: "two", newString: "TWO" },
        { path: "patch/b.txt", oldString: "does-not-exist", newString: "x" },
      ],
    });
    expect(response.isError).toBe(true);
    expect(response.text).toBe("edit[1] failed: oldString not found in patch/b.txt");
    expect(await readFile(path.join(root, "patch", "a.txt"), "utf8")).toBe("two\n");
    expect(await readFile(path.join(root, "patch", "b.txt"), "utf8")).toBe("BRAVO\n");
  });
});

describe("path containment", () => {
  it("rejects relative traversal", async () => {
    const response = await callTool("read_file", { path: "../../etc/passwd" });
    expect(response.isError).toBe(true);
    expect(response.text).toBe("path outside workspace root: ../../etc/passwd");
  });

  it("rejects absolute paths outside the root", async () => {
    const response = await callTool("read_file", { path: "/etc/passwd" });
    expect(response.isError).toBe(true);
    expect(response.text).toBe("path outside workspace root: /etc/passwd");
  });

  it("rejects reads through a symlink that escapes the root", async () => {
    const response = await callTool("read_file", { path: "escape/secret.txt" });
    expect(response.isError).toBe(true);
    expect(response.text).toBe("path outside workspace root: escape/secret.txt");
  });

  it("rejects writes through a symlink that escapes the root", async () => {
    const response = await callTool("write_file", { path: "escape/created.txt", content: "x" });
    expect(response.isError).toBe(true);
    expect(response.text).toBe("path outside workspace root: escape/created.txt");
    await expect(readFile(path.join(outside, "created.txt"), "utf8")).rejects.toThrow();
  });

  it("rejects traversal in list_files and grep", async () => {
    const listed = await callTool("list_files", { path: "../" });
    expect(listed.isError).toBe(true);
    expect(listed.text).toContain("path outside workspace root");

    const grepped = await callTool("grep", { pattern: "root", path: "../../etc" });
    expect(grepped.isError).toBe(true);
    expect(grepped.text).toContain("path outside workspace root");
  });
});

describe("grep", () => {
  beforeAll(async () => {
    await callTool("write_file", { path: "grep/src/app.ts", content: "const TODO = 1;\nfunction main() {}\n" });
    await callTool("write_file", { path: "grep/src/notes.md", content: "TODO: docs\n" });
    await callTool("write_file", { path: "grep/node_modules/pkg/index.js", content: "TODO: vendored\n" });
    await callTool("write_file", { path: "grep/binary.bin", content: "TODO" });
    await writeFile(path.join(root, "grep", "binary.bin"), Buffer.from([0x00, 0x54, 0x4f, 0x44, 0x4f]));
  });

  it("finds matches as relative/path:LINE: text and skips node_modules", async () => {
    const response = await callTool("grep", { pattern: "TODO", path: "grep" });
    expect(response.isError).toBe(false);
    expect(response.text).toContain("grep/src/app.ts:1: const TODO = 1;");
    expect(response.text).toContain("grep/src/notes.md:1: TODO: docs");
    expect(response.text).not.toContain("node_modules");
    expect(response.text).toContain("2 matches in 2 files");
  });

  it("honors the include glob", async () => {
    const response = await callTool("grep", { pattern: "TODO", path: "grep", include: "*.ts" });
    expect(response.text).toContain("grep/src/app.ts:1:");
    expect(response.text).not.toContain("notes.md");
    expect(response.text).toContain("1 match in 1 file");
  });

  it("supports ignoreCase", async () => {
    const response = await callTool("grep", { pattern: "todo", path: "grep/src/app.ts", ignoreCase: true });
    expect(response.text).toContain("grep/src/app.ts:1:");
  });

  it("stops at maxResults with a note", async () => {
    const response = await callTool("grep", { pattern: "TODO", path: "grep", maxResults: 1 });
    expect(response.text).toContain("1 match in 1 file");
    expect(response.text).toContain("stopped at maxResults=1");
  });

  it("returns a clear error for an invalid regex", async () => {
    const response = await callTool("grep", { pattern: "[", path: "grep" });
    expect(response.isError).toBe(true);
    expect(response.text).toMatch(/^invalid regex:/);
  });

  it("reports no matches without failing", async () => {
    const response = await callTool("grep", { pattern: "zzz-not-there", path: "grep" });
    expect(response.isError).toBe(false);
    expect(response.text).toBe("no matches for /zzz-not-there/");
  });
});

describe("list_files", () => {
  beforeAll(async () => {
    await callTool("write_file", { path: "list/src/index.ts", content: "" });
    await callTool("write_file", { path: "list/README.md", content: "" });
    await callTool("write_file", { path: "list/deep/a/b/c/d.txt", content: "" });
    await callTool("write_file", { path: "list/node_modules/pkg/index.js", content: "" });
    await writeFile(path.join(root, "list", "image.bin"), Buffer.from([0x00, 0x01, 0x02, 0x03]));
  });

  it("lists entries sorted with trailing slashes on directories", async () => {
    const response = await callTool("list_files", { path: "list" });
    expect(response.isError).toBe(false);
    const body = response.text.split("\n");
    expect(body).toContain("list/src/");
    expect(body).toContain("list/src/index.ts");
    expect(body).toContain("list/README.md");
    expect(body).not.toContain("list/node_modules/");
    expect(body).not.toContain("list/image.bin");
    const entries = body.slice(1);
    expect([...entries].sort()).toEqual(entries);
  });

  it("honors the glob pattern", async () => {
    const response = await callTool("list_files", { path: "list", pattern: "*.ts" });
    expect(response.text).toContain("list/src/index.ts");
    expect(response.text).not.toContain("README.md");
    expect(response.text).toContain("1 entry matching *.ts");
  });

  it("honors maxDepth", async () => {
    const shallow = await callTool("list_files", { path: "list", maxDepth: 2 });
    expect(shallow.text).not.toContain("d.txt");
    expect(shallow.text).toContain("list/src/index.ts");

    const deep = await callTool("list_files", { path: "list", maxDepth: 8 });
    expect(deep.text).toContain("list/deep/a/b/c/d.txt");
  });

  it("honors limit with a truncation note", async () => {
    const response = await callTool("list_files", { path: "list", limit: 2 });
    expect(response.text).toContain("showing 2 of");
  });

  it("rejects paths that are not directories", async () => {
    const response = await callTool("list_files", { path: "list/README.md" });
    expect(response.isError).toBe(true);
    expect(response.text).toBe("not a directory: list/README.md");
  });
});
