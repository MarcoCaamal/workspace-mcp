import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { STATE_DIR_NAME, prepareStateDir, stateDir, writeTextAtomic } from "./state.js";

/**
 * SDD-lite work tracking. A *change* is the unit of work: a JSON record plus a
 * sibling directory holding its stage documents (proposal, spec, design,
 * notes). Everything lives under `<root>/.workspace-mcp/changes/`.
 */
export const CHANGES_DIR_NAME = "changes";

/** Longest slug produced by {@link slugify}, before dedupe suffixes. */
export const MAX_SLUG_CHARS = 40;

export const TASK_STATUSES = ["pending", "in_progress", "done", "blocked"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const CHANGE_STAGES = ["proposal", "spec", "design", "notes"] as const;
export type ChangeStage = (typeof CHANGE_STAGES)[number];

export interface TaskRecord {
  id: string;
  text: string;
  status: TaskStatus;
  notes: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ChangeRecord {
  id: string;
  title: string;
  goal?: string;
  constraints: string[];
  tasks: TaskRecord[];
  createdAt: string;
  updatedAt: string;
}

export interface ChangeDocInfo {
  stage: ChangeStage;
  present: boolean;
  bytes: number;
}

export interface TaskCounts {
  total: number;
  pending: number;
  in_progress: number;
  done: number;
  blocked: number;
}

/** Kebab-case slug used as the change id: `[a-z0-9-]`, max 40 chars. */
export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, MAX_SLUG_CHARS)
    .replace(/-+$/, "");
  return slug === "" ? "change" : slug;
}

export function changesDir(root: string): string {
  return path.join(stateDir(root), CHANGES_DIR_NAME);
}

export function changeDirRelativePath(id: string): string {
  return `${STATE_DIR_NAME}/${CHANGES_DIR_NAME}/${id}/`;
}

export function changeDocRelativePath(id: string, stage: ChangeStage): string {
  return `${STATE_DIR_NAME}/${CHANGES_DIR_NAME}/${id}/${stage}.md`;
}

export function changeJsonPath(root: string, id: string): string {
  return path.join(changesDir(root), `${id}.json`);
}

export function changeDocPath(root: string, id: string, stage: ChangeStage): string {
  return path.join(changesDir(root), id, `${stage}.md`);
}

/**
 * Serializes change mutations. MCP dispatches tool calls concurrently, so
 * handlers that read-then-write change state must run one at a time. The lock
 * is a plain promise-chain tail: operations run in arrival order, a failing
 * operation never poisons the chain, and helpers must never take it (only
 * tool handlers do) so nesting cannot deadlock.
 */
let changeLockTail: Promise<void> = Promise.resolve();

export function withChangeLock<T>(fn: () => Promise<T> | T): Promise<T> {
  const result = changeLockTail.then(fn);
  changeLockTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/** Allocating variant of {@link slugify}: appends `-2`, `-3`, ... on collisions. */
export async function allocateChangeId(root: string, title: string): Promise<string> {
  const base = slugify(title);
  const taken = new Set(await existingChangeIds(root));
  let candidate = base;
  let suffix = 2;
  while (taken.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

/** Creates the change record and its documents directory, then returns it. */
export async function createChange(root: string, title: string, goal?: string): Promise<ChangeRecord> {
  await prepareStateDir(root);
  const id = await allocateChangeId(root, title);
  const now = new Date().toISOString();
  const change: ChangeRecord = {
    id,
    title: title.trim(),
    constraints: [],
    tasks: [],
    createdAt: now,
    updatedAt: now,
  };
  if (goal !== undefined && goal.trim() !== "") {
    change.goal = goal.trim();
  }
  await writeChange(root, change);
  await mkdir(path.join(changesDir(root), id), { recursive: true });
  return change;
}

/** Reads and validates one change; returns null when missing or malformed. */
export async function readChange(root: string, id: string): Promise<ChangeRecord | null> {
  let raw: string;
  try {
    raw = await readFile(changeJsonPath(root, id), "utf8");
  } catch {
    return null;
  }
  try {
    return parseChange(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Atomically writes the change JSON exactly as given. */
export async function writeChange(root: string, change: ChangeRecord): Promise<void> {
  await prepareStateDir(root);
  await writeTextAtomic(changeJsonPath(root, change.id), `${JSON.stringify(change, null, 2)}\n`);
}

/** Writes the change JSON with a fresh `updatedAt` and returns the stamped record. */
export async function saveChange(root: string, change: ChangeRecord): Promise<ChangeRecord> {
  const stamped: ChangeRecord = { ...change, updatedAt: new Date().toISOString() };
  await writeChange(root, stamped);
  return stamped;
}

/** Every valid change, newest `updatedAt` first. */
export async function listChanges(root: string): Promise<ChangeRecord[]> {
  const ids = await existingChangeIds(root);
  const changes: ChangeRecord[] = [];
  for (const id of ids) {
    const change = await readChange(root, id);
    if (change !== null) {
      changes.push(change);
    }
  }
  changes.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  return changes;
}

/** Next sequential task id: `T1`, `T2`, ... = highest existing number + 1. */
export function nextTaskId(tasks: readonly TaskRecord[]): string {
  let highest = 0;
  for (const task of tasks) {
    const match = /^T(\d+)$/.exec(task.id);
    if (match !== null) {
      highest = Math.max(highest, Number.parseInt(match[1] as string, 10));
    }
  }
  return `T${highest + 1}`;
}

export function countTasks(tasks: readonly TaskRecord[]): TaskCounts {
  const counts: TaskCounts = { total: tasks.length, pending: 0, in_progress: 0, done: 0, blocked: 0 };
  for (const task of tasks) {
    counts[task.status] += 1;
  }
  return counts;
}

/** Presence and byte size of each stage document, in {@link CHANGE_STAGES} order. */
export async function inspectChangeDocs(root: string, id: string): Promise<ChangeDocInfo[]> {
  const infos: ChangeDocInfo[] = [];
  for (const stage of CHANGE_STAGES) {
    try {
      const info = await stat(changeDocPath(root, id, stage));
      infos.push({ stage, present: true, bytes: info.size });
    } catch {
      infos.push({ stage, present: false, bytes: 0 });
    }
  }
  return infos;
}

/** Reads one stage document; null when it does not exist yet. */
export async function readChangeDoc(root: string, id: string, stage: ChangeStage): Promise<string | null> {
  try {
    return await readFile(changeDocPath(root, id, stage), "utf8");
  } catch {
    return null;
  }
}

/**
 * Writes a stage document and returns the stored byte size. Replace mode
 * overwrites; append mode puts the new content after a blank line. The stored
 * file always ends with exactly one trailing newline.
 */
export async function writeChangeDoc(
  root: string,
  id: string,
  stage: ChangeStage,
  content: string,
  append: boolean,
): Promise<number> {
  let body = content;
  if (append) {
    const existing = (await readChangeDoc(root, id, stage)) ?? "";
    const trimmed = existing.replace(/\n+$/u, "");
    body = trimmed === "" ? content : `${trimmed}\n\n${content}`;
  }
  const data = body.endsWith("\n") ? body : `${body}\n`;
  await writeTextAtomic(changeDocPath(root, id, stage), data);
  return Buffer.byteLength(data, "utf8");
}

async function existingChangeIds(root: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(changesDir(root));
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => entry.slice(0, -".json".length))
    .sort();
}

function parseChange(value: unknown): ChangeRecord | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id === "" || typeof record.title !== "string") {
    return null;
  }
  const createdAt = typeof record.createdAt === "string" ? record.createdAt : new Date(0).toISOString();
  const updatedAt = typeof record.updatedAt === "string" ? record.updatedAt : createdAt;
  const change: ChangeRecord = {
    id: record.id,
    title: record.title,
    constraints: Array.isArray(record.constraints)
      ? record.constraints.filter((item): item is string => typeof item === "string")
      : [],
    tasks: Array.isArray(record.tasks)
      ? record.tasks.map(parseTask).filter((task): task is TaskRecord => task !== null)
      : [],
    createdAt,
    updatedAt,
  };
  if (typeof record.goal === "string" && record.goal !== "") {
    change.goal = record.goal;
  }
  return change;
}

function parseTask(value: unknown): TaskRecord | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id === "" || typeof record.text !== "string") {
    return null;
  }
  const status = TASK_STATUSES.find((candidate) => candidate === record.status) ?? "pending";
  const createdAt = typeof record.createdAt === "string" ? record.createdAt : new Date(0).toISOString();
  return {
    id: record.id,
    text: record.text,
    status,
    notes: Array.isArray(record.notes) ? record.notes.filter((item): item is string => typeof item === "string") : [],
    createdAt,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : createdAt,
  };
}
