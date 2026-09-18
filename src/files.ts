import { open, stat } from "node:fs/promises";

/** Raised for expected file-level failures; the message is client-safe. */
export class FileToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileToolError";
  }
}

/** Directory names skipped by traversal-based tools (grep, list_files). */
export const IGNORED_DIRS = new Set([".git", "node_modules", ".cache", ".workspace-mcp"]);

export const READ_MAX_LINES = 2000;
export const READ_MAX_SEGMENT_BYTES = 1024 * 1024;
export const MAX_LINE_CHARS = 2000;
export const BINARY_SNIFF_BYTES = 8192;
export const GREP_SCAN_BYTES = 1024 * 1024;
export const MAX_FILE_BYTES = 16 * 1024 * 1024;

/**
 * Binary detection: a NUL byte inside the first 8 KiB marks the buffer as
 * binary. This matches the heuristic used by common search tools.
 */
export function isBinaryBuffer(buffer: Buffer): boolean {
  const window = buffer.subarray(0, BINARY_SNIFF_BYTES);
  return window.includes(0);
}

/** Asserts that the path is a regular, readable-size file. Client-safe errors. */
export async function assertRegularFile(absolutePath: string, relativePath: string): Promise<void> {
  let info;
  try {
    info = await stat(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new FileToolError(`file not found: ${relativePath}`);
    }
    throw error;
  }
  if (info.isDirectory()) {
    throw new FileToolError(`path is a directory, not a file: ${relativePath}`);
  }
  if (!info.isFile()) {
    throw new FileToolError(`not a regular file: ${relativePath}`);
  }
  if (info.size > MAX_FILE_BYTES) {
    throw new FileToolError(
      `file too large to open (${info.size} bytes; limit ${MAX_FILE_BYTES}): ${relativePath}`,
    );
  }
}

/** Reads a UTF-8 text file, rejecting binary files. */
export async function readTextFile(absolutePath: string, relativePath: string): Promise<string> {
  await assertRegularFile(absolutePath, relativePath);

  const handle = await open(absolutePath, "r");
  try {
    const buffer = await handle.readFile();
    if (isBinaryBuffer(buffer)) {
      throw new FileToolError(`binary file cannot be read as text: ${relativePath}`);
    }
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * Best-effort text check used by listing: reads the first 8 KiB and reports
 * whether the file looks like text. Unreadable files are treated as text so
 * listings do not silently hide permission errors.
 */
export async function isTextFile(absolutePath: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(absolutePath, "r");
  } catch {
    return true;
  }
  try {
    const buffer = Buffer.alloc(BINARY_SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, BINARY_SNIFF_BYTES, 0);
    return !isBinaryBuffer(buffer.subarray(0, bytesRead));
  } catch {
    return true;
  } finally {
    await handle.close();
  }
}

/**
 * Reads up to 1 MiB of a file for content scanning. Returns `null` for binary
 * files and for files that cannot be read (they are skipped, not errors).
 */
export async function readForScan(absolutePath: string): Promise<string | null> {
  let handle;
  try {
    handle = await open(absolutePath, "r");
  } catch {
    return null;
  }
  try {
    const buffer = Buffer.alloc(GREP_SCAN_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, GREP_SCAN_BYTES, 0);
    const slice = buffer.subarray(0, bytesRead);
    if (isBinaryBuffer(slice)) {
      return null;
    }
    return slice.toString("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * Splits file content into lines. A trailing newline does not produce a
 * phantom empty final line.
 */
export function splitLines(content: string): string[] {
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

/**
 * Renders a line range as `N: <content>` (1-based) with a 2000-character cap
 * per line, a ~1 MiB cap per segment and a trailing truncation note.
 */
export function renderNumberedLines(content: string, offset: number, limit: number): string {
  const lines = splitLines(content);
  const total = lines.length;
  const first = Math.max(1, Math.trunc(offset));

  if (total === 0) {
    return "(file is empty)";
  }
  if (first > total) {
    return `... (offset ${first} is past the end of file; file has ${total} line${total === 1 ? "" : "s"})`;
  }

  const effectiveLimit = Math.min(Math.max(1, Math.trunc(limit)), READ_MAX_LINES);
  const rendered: string[] = [];
  let bytes = 0;
  let truncated = false;
  let lastLine = first - 1;

  for (let lineNumber = first; lineNumber <= total; lineNumber += 1) {
    if (rendered.length >= effectiveLimit) {
      truncated = true;
      break;
    }

    let line = (lines[lineNumber - 1] as string).replace(/\r$/, "");
    if (line.length > MAX_LINE_CHARS) {
      line = `${line.slice(0, MAX_LINE_CHARS)}... (line truncated)`;
    }

    const entry = `${lineNumber}: ${line}`;
    const entryBytes = Buffer.byteLength(entry, "utf8") + 1;
    if (rendered.length > 0 && bytes + entryBytes > READ_MAX_SEGMENT_BYTES) {
      truncated = true;
      break;
    }

    rendered.push(entry);
    bytes += entryBytes;
    lastLine = lineNumber;
  }

  if (lastLine < total) {
    truncated = true;
  }

  const text = rendered.join("\n");
  if (!truncated) {
    return text;
  }
  return `${text}\n... (truncated at line ${lastLine} of ${total})`;
}
