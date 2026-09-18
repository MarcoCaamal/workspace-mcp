import { appendFile, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Workspace-local state directory. It lives inside the workspace root but is
 * hidden from git (an internal `.gitignore` with `*`) and from traversal-based
 * tools (`IGNORED_DIRS` in `src/files.ts`).
 */
export const STATE_DIR_NAME = ".workspace-mcp";

export const JOURNAL_FILE_NAME = "journal.jsonl";
export const NOTES_FILE_NAME = "notes.jsonl";
export const STATE_FILE_NAME = "state.json";

/** Rotation threshold per stream. Override with WORKSPACE_MCP_JOURNAL_MAX_BYTES. */
export const DEFAULT_MAX_STATE_BYTES = 5 * 1024 * 1024;

/** Reads are bounded to the tail of the current file (then the rotated one). */
export const MAX_STATE_READ_BYTES = 1024 * 1024;

/** Journal detail/result fields are capped so a single entry stays small. */
export const MAX_DETAIL_CHARS = 300;

/** Maximum tags kept per note. */
export const MAX_NOTE_TAGS = 20;

/** Maximum characters kept per tag. */
export const MAX_TAG_CHARS = 50;

/**
 * One `journal.jsonl` line. Unknown fields are preserved on read only when
 * recognized: the format is append-only, so later phases can add fields (for
 * example a `change` tag) without breaking existing readers.
 */
export interface JournalEntry {
  /** ISO 8601 timestamp of the operation. */
  ts: string;
  /** Tool name, for example "write_file" or "run_command". */
  tool: string;
  /** Workspace-relative paths the operation addressed, when known. */
  paths?: string[];
  /** Short human-readable summary (truncated to {@link MAX_DETAIL_CHARS}). */
  detail?: string;
  /** Outcome: "ok", "exit 0 (12ms)", "started (job_...)", "error: ...", etc. */
  result?: string;
  /** Reserved for Phase 2 change tracking; readers ignore unknown values. */
  change?: string;
}

/** Input accepted by {@link appendJournal}; `ts` is set by the helper. */
export interface JournalInput {
  tool: string;
  paths?: readonly string[];
  detail?: string;
  result?: string;
  /** Explicit change tag. When omitted, the active change id is attached. */
  change?: string;
}

/** One `notes.jsonl` line. */
export interface NoteRecord {
  ts: string;
  text: string;
  tags: string[];
}

export interface NoteInput {
  text: string;
  tags?: readonly string[];
}

export interface JournalQuery {
  /** Maximum entries to return, newest first. Defaults to 50. */
  limit?: number;
  /** ISO 8601 timestamp; only entries with `ts >= since` are returned. */
  since?: string;
  /** Substring matched against any of the entry's paths. */
  path?: string;
  /** Exact match against the entry's change tag. */
  change?: string;
}

export interface NoteQuery {
  /** Case-insensitive substring matched against the note text. */
  query?: string;
  /** Case-insensitive exact tag match. */
  tag?: string;
  /** Maximum notes to return, newest first. Defaults to 20. */
  limit?: number;
}

interface PendingWrite {
  chain: Promise<void>;
}

/** Serializes appends per state file so concurrent tools cannot interleave lines. */
const appendChains = new Map<string, PendingWrite>();

/** Roots whose state directory was already created in this process. */
const preparedRoots = new Set<string>();

/** Absolute path of the state directory for `root`. */
export function stateDir(root: string): string {
  return path.join(root, STATE_DIR_NAME);
}

/** Rotation threshold in bytes, read at call time (tests may override it). */
export function maxStateBytes(): number {
  const raw = process.env.WORKSPACE_MCP_JOURNAL_MAX_BYTES;
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_MAX_STATE_BYTES;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_STATE_BYTES;
}

/**
 * Appends one journal entry. Best effort: failures are logged to stderr and
 * never propagate, because journaling must not change a tool's own result.
 * Appends to the same file are serialized through a promise chain and use
 * `fs.appendFile`, which is atomic for small lines.
 */
export async function appendJournal(root: string, entry: JournalInput): Promise<void> {
  const change = entry.change ?? ((await activeChangeId(root)) ?? undefined);
  const normalized: JournalEntry = {
    ts: new Date().toISOString(),
    tool: entry.tool,
  };
  if (entry.paths !== undefined && entry.paths.length > 0) {
    normalized.paths = [...entry.paths];
  }
  if (entry.detail !== undefined) {
    normalized.detail = truncateDetail(entry.detail);
  }
  if (entry.result !== undefined) {
    normalized.result = truncateDetail(entry.result);
  }
  if (change !== undefined && change !== "") {
    normalized.change = change;
  }
  await appendJsonLine(root, JOURNAL_FILE_NAME, normalized);
}

/** Appends one note and returns the stored record (text trimmed, tags normalized). */
export async function appendNote(root: string, note: NoteInput): Promise<NoteRecord> {
  const record: NoteRecord = {
    ts: new Date().toISOString(),
    text: note.text.trim(),
    tags: normalizeTags(note.tags ?? []),
  };
  await appendJsonLine(root, NOTES_FILE_NAME, record);
  return record;
}

/** Newest-first journal entries, bounded and tolerant of malformed lines. */
export async function readJournal(root: string, options: JournalQuery = {}): Promise<JournalEntry[]> {
  const limit = normalizeLimit(options.limit, 50);
  const sinceMs = options.since !== undefined ? Date.parse(options.since) : Number.NaN;
  const pathFilter = options.path !== undefined && options.path !== "" ? options.path : undefined;
  const changeFilter = options.change !== undefined && options.change !== "" ? options.change : undefined;

  return readLatestMatching(root, JOURNAL_FILE_NAME, limit, parseJournalEntry, (entry) => {
    if (Number.isFinite(sinceMs)) {
      const ts = Date.parse(entry.ts);
      if (!Number.isFinite(ts) || ts < sinceMs) {
        return false;
      }
    }
    if (pathFilter !== undefined && !(entry.paths ?? []).some((candidate) => candidate.includes(pathFilter))) {
      return false;
    }
    if (changeFilter !== undefined && entry.change !== changeFilter) {
      return false;
    }
    return true;
  });
}

/** Newest-first notes, bounded and tolerant of malformed lines. */
export async function readNotes(root: string, options: NoteQuery = {}): Promise<NoteRecord[]> {
  const limit = normalizeLimit(options.limit, 20);
  const query = options.query !== undefined && options.query !== "" ? options.query.toLowerCase() : undefined;
  const tag = options.tag !== undefined && options.tag !== "" ? options.tag.toLowerCase() : undefined;

  return readLatestMatching(root, NOTES_FILE_NAME, limit, parseNote, (note) => {
    if (query !== undefined && !note.text.toLowerCase().includes(query)) {
      return false;
    }
    if (tag !== undefined && !note.tags.some((candidate) => candidate.toLowerCase() === tag)) {
      return false;
    }
    return true;
  });
}

/** Total number of valid notes in the current and rotated files. */
export async function countNotes(root: string): Promise<number> {
  let total = 0;
  for (const file of [notesPath(root), rotatedFilePath(notesPath(root))]) {
    let content: string;
    try {
      content = await readFile(file, "utf8");
    } catch {
      continue;
    }
    for (const line of content.split("\n")) {
      if (parseLine(line, parseNote) !== undefined) {
        total += 1;
      }
    }
  }
  return total;
}

/**
 * Reads the active change id from `state.json`. Best effort: an unreadable or
 * malformed file (or a missing directory) means "no active change".
 */
export async function activeChangeId(root: string): Promise<string | null> {
  try {
    const raw = await readFile(path.join(stateDir(root), STATE_FILE_NAME), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) {
      const active = (parsed as Record<string, unknown>).activeChange;
      if (typeof active === "string" && active !== "") {
        return active;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Atomically sets (or clears, with `null`) the active change in `state.json`. */
export async function setActiveChange(root: string, changeId: string | null): Promise<void> {
  await prepareStateDir(root);
  const filePath = path.join(stateDir(root), STATE_FILE_NAME);
  await writeTextAtomic(filePath, `${JSON.stringify({ activeChange: changeId })}\n`);
}

/**
 * Writes text through a sibling `<file>.tmp` file plus `rename`, so readers
 * never observe a partially written file. The temporary file is removed on
 * failure and is gone after a successful rename.
 */
export async function writeTextAtomic(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  try {
    await writeFile(tempPath, content, "utf8");
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Creates the state directory (and its internal `.gitignore`) when missing. */
export async function prepareStateDir(root: string): Promise<void> {
  await ensureStateDir(root);
}

function journalPath(root: string): string {
  return path.join(stateDir(root), JOURNAL_FILE_NAME);
}

function notesPath(root: string): string {
  return path.join(stateDir(root), NOTES_FILE_NAME);
}

function appendJsonLine(root: string, fileName: string, value: unknown): Promise<void> {
  const filePath = path.join(stateDir(root), fileName);
  const previous = appendChains.get(filePath);
  const next = (previous?.chain ?? Promise.resolve())
    .then(() => writeJsonLine(root, filePath, value))
    .catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[workspace-mcp] state write failed (${fileName}): ${detail}\n`);
    });
  appendChains.set(filePath, { chain: next });
  return next;
}

async function writeJsonLine(root: string, filePath: string, value: unknown): Promise<void> {
  await ensureStateDir(root);
  await rotateIfNeeded(filePath, maxStateBytes());
  await appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

async function ensureStateDir(root: string): Promise<void> {
  if (preparedRoots.has(root)) {
    return;
  }
  const dir = stateDir(root);
  await mkdir(dir, { recursive: true });
  const gitignore = path.join(dir, ".gitignore");
  try {
    await writeFile(gitignore, "*\n", { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }
  preparedRoots.add(root);
}

async function rotateIfNeeded(filePath: string, maxBytes: number): Promise<void> {
  let size: number;
  try {
    size = (await stat(filePath)).size;
  } catch {
    return;
  }
  if (size <= maxBytes) {
    return;
  }
  const rotated = rotatedFilePath(filePath);
  await rm(rotated, { force: true });
  await rename(filePath, rotated);
}

async function readLatestMatching<T>(
  root: string,
  fileName: string,
  limit: number,
  parse: (value: unknown) => T | undefined,
  matches: (value: T) => boolean,
): Promise<T[]> {
  const results: T[] = [];
  const files = [
    path.join(stateDir(root), fileName),
    path.join(stateDir(root), rotatedFileName(fileName)),
  ];

  for (const file of files) {
    if (results.length >= limit) {
      break;
    }
    const lines = await readTailLines(file, MAX_STATE_READ_BYTES);
    if (lines === undefined) {
      continue;
    }
    for (let index = lines.length - 1; index >= 0 && results.length < limit; index -= 1) {
      const parsed = parseLine(lines[index] as string, parse);
      if (parsed !== undefined && matches(parsed)) {
        results.push(parsed);
      }
    }
  }
  return results;
}

/** Reads at most the last `maxBytes` of a file and splits it into raw lines. */
async function readTailLines(filePath: string, maxBytes: number): Promise<string[] | undefined> {
  let handle;
  try {
    handle = await open(filePath, "r");
  } catch {
    return undefined;
  }
  try {
    const { size } = await handle.stat();
    const length = Math.min(maxBytes, size);
    const position = size - length;
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
      if (bytesRead === 0) {
        break;
      }
      offset += bytesRead;
    }
    return buffer.subarray(0, offset).toString("utf8").split("\n");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function parseLine<T>(line: string, parse: (value: unknown) => T | undefined): T | undefined {
  const trimmed = line.trim();
  if (trimmed === "") {
    return undefined;
  }
  try {
    return parse(JSON.parse(trimmed));
  } catch {
    return undefined;
  }
}

function parseJournalEntry(value: unknown): JournalEntry | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.ts !== "string" || typeof record.tool !== "string") {
    return undefined;
  }
  const entry: JournalEntry = { ts: record.ts, tool: record.tool };
  if (Array.isArray(record.paths) && record.paths.every((item) => typeof item === "string")) {
    entry.paths = record.paths as string[];
  }
  if (typeof record.detail === "string") {
    entry.detail = record.detail;
  }
  if (typeof record.result === "string") {
    entry.result = record.result;
  }
  if (typeof record.change === "string") {
    entry.change = record.change;
  }
  return entry;
}

function parseNote(value: unknown): NoteRecord | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.ts !== "string" || typeof record.text !== "string") {
    return undefined;
  }
  const tags = Array.isArray(record.tags)
    ? record.tags.filter((item): item is string => typeof item === "string")
    : [];
  return { ts: record.ts, text: record.text, tags };
}

function normalizeTags(tags: readonly string[]): string[] {
  const normalized: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim().slice(0, MAX_TAG_CHARS);
    if (tag === "" || normalized.includes(tag)) {
      continue;
    }
    normalized.push(tag);
    if (normalized.length >= MAX_NOTE_TAGS) {
      break;
    }
  }
  return normalized;
}

function truncateDetail(value: string): string {
  return value.length <= MAX_DETAIL_CHARS ? value : value.slice(0, MAX_DETAIL_CHARS);
}

function normalizeLimit(limit: number | undefined, fallback: number): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return fallback;
  }
  return Math.max(1, Math.trunc(limit));
}

function rotatedFileName(fileName: string): string {
  return fileName.endsWith(".jsonl") ? `${fileName.slice(0, -".jsonl".length)}.1.jsonl` : `${fileName}.1`;
}

function rotatedFilePath(filePath: string): string {
  return filePath.endsWith(".jsonl") ? `${filePath.slice(0, -".jsonl".length)}.1.jsonl` : `${filePath}.1`;
}
