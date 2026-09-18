import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveSafe, toWorkspacePath, WorkspacePathError } from "../src/paths.js";

let root: string;
let outside: string;

beforeAll(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "workspace-mcp-paths-")));
  outside = await realpath(await mkdtemp(path.join(tmpdir(), "workspace-mcp-outside-")));
  await mkdir(path.join(root, "src", "nested"), { recursive: true });
  await writeFile(path.join(root, "src", "index.ts"), "export {};\n");
  await writeFile(path.join(outside, "secret.txt"), "secret\n");
  await symlink(outside, path.join(root, "escape"));
});

afterAll(async () => {
  const { rm } = await import("node:fs/promises");
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe("resolveSafe", () => {
  it("resolves relative paths inside the root", async () => {
    const resolved = await resolveSafe(root, "src/index.ts");
    expect(resolved).toBe(path.join(root, "src", "index.ts"));
  });

  it("resolves absolute paths that are inside the root", async () => {
    const resolved = await resolveSafe(root, path.join(root, "src", "index.ts"));
    expect(resolved).toBe(path.join(root, "src", "index.ts"));
  });

  it("resolves not-yet-existing targets by realpathing the nearest ancestor", async () => {
    const resolved = await resolveSafe(root, "src/new/deep/file.txt");
    expect(resolved).toBe(path.join(root, "src", "new", "deep", "file.txt"));
  });

  it("allows the root itself", async () => {
    expect(await resolveSafe(root, ".")).toBe(root);
  });

  it("rejects traversal outside the root", async () => {
    await expect(resolveSafe(root, "../../etc/passwd")).rejects.toThrow(WorkspacePathError);
    await expect(resolveSafe(root, "../outside.txt")).rejects.toThrow(/path outside workspace root/);
  });

  it("rejects absolute paths outside the root", async () => {
    await expect(resolveSafe(root, "/etc/passwd")).rejects.toThrow(/path outside workspace root/);
    await expect(resolveSafe(root, path.join(outside, "secret.txt"))).rejects.toThrow(
      /path outside workspace root/,
    );
  });

  it("rejects symlinks that escape the root", async () => {
    await expect(resolveSafe(root, "escape/secret.txt")).rejects.toThrow(/path outside workspace root/);
    await expect(resolveSafe(root, "escape/new-file.txt")).rejects.toThrow(/path outside workspace root/);
  });

  it("rejects empty paths and embedded NUL bytes", async () => {
    await expect(resolveSafe(root, "")).rejects.toThrow(/non-empty/);
    await expect(resolveSafe(root, "a\0b")).rejects.toThrow(/NUL/);
  });

  it("rejects paths through a non-directory component", async () => {
    await expect(resolveSafe(root, "src/index.ts/child")).rejects.toThrow(/not a directory/);
  });
});

describe("toWorkspacePath", () => {
  it("returns forward-slash relative paths", () => {
    expect(toWorkspacePath(root, path.join(root, "src", "index.ts"))).toBe("src/index.ts");
  });

  it("returns . for the root itself", () => {
    expect(toWorkspacePath(root, root)).toBe(".");
  });
});
