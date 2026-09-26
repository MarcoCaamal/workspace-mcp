import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Outside-repo harness store (change chatgpt-workspace-harness, tasks 2.4–2.10,
 * 2.16, 2.18, 4.2, 4.5).
 *
 * Single `node:sqlite` import site for all harness persistence. Sessions,
 * works, stage artifacts, task lists, and checkpoints live in one database
 * file located outside all repositories; artifact bodies are stored as bytes
 * in SQLite, never as repo-path references. This module has no MCP imports
 * and never imports the legacy repo writers (`src/state.ts`,
 * `src/changes.ts`, `src/tools/changes.ts`).
 *
 * Trust boundary (Units 3–4): the database path is canonicalized (realpath +
 * longest-existing-prefix) and dual-validated at open — outside the
 * configured roots AND outside ANY Git repository (canonical-parent `.git`
 * dir-or-file walk, covering worktrees and submodules). Every store call
 * validates token parentage (`work.sessionId == session`, never re-parented)
 * and registered workspace scope; reads additionally enforce record
 * ownership by the presented session. Checkpoints carry the EXTERNAL stored
 * stage-artifact ID: repo-local paths are rejected as `artifactId` and the
 * referenced artifact must exist in the same (session, work).
 *
 * Status and failure honesty (Unit 6): `harnessStatus()` derives the current
 * stage and next action solely from the external store — a stage artifact
 * written without a following checkpoint is reported as an unverified
 * transition (honest, never a gate), and an out-of-order checkpoint is
 * permitted with the bypass recorded in the harness DB. Every public
 * mutation and scoped read maps request-time persistence failures to an
 * explicit `store-unavailable` error with no repo-local fallback, so session,
 * work, stage-artifact, task-list, checkpoint, and summary writes all fail
 * the same explicit way when the database is unreachable.
 *
 * Scoped recall and hardening (Slice 3, Units 8–9): `searchCheckpoints()` and
 * `searchStageArtifacts()` query the `checkpoint_fts` / `stage_artifact_fts`
 * indexes with the session token REQUIRED server-side, optional work and
 * workspace narrowing, `bm25` ranking, and a hard result-size cap beyond
 * `limit`. FTS rows stay in sync with their content tables through triggers
 * (created additively on every open, so pre-Slice-3 databases gain them too)
 * plus a backfill pass on open.
 *
 * Retention/hardening decision record (task 4.5, behind `harness.recall`):
 * - Session retention: ended sessions are retained for 90 days
 *   (`SESSION_RETENTION_DAYS`), then removed by an explicit
 *   `purgeExpiredSessions()` call — never by automatic deletion on read.
 *   Live sessions are never purged. Purge cascades to the session's works,
 *   stage artifacts, task lists, and checkpoints (FTS rows follow through
 *   the delete triggers).
 * - Authorship and caps: checkpoint summaries are model-authored and capped
 *   at 8000 chars; stage/task bodies at 100000 chars. Over-cap writes are
 *   REJECTED with a typed `too-large` error, never silently truncated, so a
 *   caller always knows its bytes were not stored.
 * - FTS ranking and result-size caps: recall orders by `bm25()` and clamps
 *   `limit` to 1–50 (`MAX_RECALL_LIMIT`); an empty query returns the latest
 *   in-scope rows instead of a global scan.
 */

/** Ordered SDD stages ChatGPT can execute in-server. */
export const HARNESS_STAGES = [
  "explore",
  "propose",
  "spec",
  "design",
  "tasks",
  "apply",
  "verify",
] as const;

export type HarnessStage = (typeof HARNESS_STAGES)[number];

/** Recall/hardening bounds (Slice 3, task 4.5 decision record). */
export const MAX_STAGE_BODY_CHARS = 100000;
export const MAX_TASK_BODY_CHARS = 100000;
export const MAX_CHECKPOINT_SUMMARY_CHARS = 8000;
export const DEFAULT_RECALL_LIMIT = 20;
export const MAX_RECALL_LIMIT = 50;
/** Ended sessions older than this are eligible for explicit purge. */
export const SESSION_RETENTION_DAYS = 90;

export type HarnessStoreErrorCode =
  | "unknown-session"
  | "closed-session"
  | "unknown-work"
  | "session-mismatch"
  | "unknown-workspace"
  | "unknown-stage"
  | "unknown-artifact"
  | "too-large"
  | "invalid-db-path"
  | "store-unavailable"
  | "not-open";

/** Client-safe store failure. Messages are short and carry no secrets. */
export class HarnessStoreError extends Error {
  readonly code: HarnessStoreErrorCode;

  constructor(code: HarnessStoreErrorCode, message: string) {
    super(message);
    this.name = "HarnessStoreError";
    this.code = code;
  }
}

export interface HarnessStoreOptions {
  /** Absolute DB path for the outside-repo database file. */
  dbPath: string;
  /** Registered workspace roots, canonicalized; used for scope validation. */
  workspaceRoots: readonly string[];
}

export interface SessionRecord {
  /** Opaque token, `crypto.randomUUID()`. */
  id: string;
  createdAt: string;
  endedAt: string | null;
  /** Canonical (realpath) registered workspace bound at start. */
  primaryWorkspace: string;
}

export interface WorkRecord {
  /** Opaque token bound to one session. */
  id: string;
  /** Parent session; validated on every use. */
  sessionId: string;
  /** Canonical registered workspace this work belongs to. */
  workspace: string;
  /** References (not replaces) the SDD-lite change within `workspace`. */
  changeId: string | null;
  createdAt: string;
}

export interface StageArtifactRecord {
  /** External stored artifact ID; checkpoints reference this. */
  id: string;
  sessionId: string;
  workId: string;
  /** Canonical registered workspace pinned at write time. */
  workspace: string;
  changeId: string | null;
  /** One of {@link HARNESS_STAGES}. */
  stage: string;
  /** Full stage body bytes; stored in SQLite, never a repo-path reference. */
  body: string;
  createdAt: string;
}

export interface HarnessTaskRecord {
  /** External stored task-list ID. */
  id: string;
  sessionId: string;
  workId: string;
  /** Canonical registered workspace pinned at write time. */
  workspace: string;
  changeId: string | null;
  /** Full task-list body bytes; stored in SQLite. */
  body: string;
  /** ID of the list this one supersedes, if any. */
  supersedes: string | null;
  createdAt: string;
}

export interface CheckpointRecord {
  seq: number;
  sessionId: string;
  workId: string;
  /** Canonical registered workspace pinned at checkpoint time. */
  workspace: string;
  changeId: string | null;
  completedStage: string;
  /** External stored stage-artifact ID. Never a repo-local path. */
  artifactId: string;
  /** Semantic summary, model-authored. */
  summary: string;
  createdAt: string;
}

export interface HarnessStatusResult {
  /** Latest checkpointed stage in scope, or null when nothing checkpointed yet. */
  currentStage: string | null;
  /** Derived next stage (`explore` first, `complete` after `verify`). */
  next: string;
  /** Human-readable reason; names bypasses and unverified transitions. */
  reason: string;
  /** Latest checkpoint in scope, or null when nothing checkpointed yet. */
  latestCheckpoint: CheckpointRecord | null;
  /**
   * True when a stage artifact in scope advances beyond the latest
   * checkpoint: the transition is reported honestly and never gates progress.
   */
  unverified: boolean;
}

export interface RecallScope {
  /** Explicit session token; REQUIRED on every harness FTS query. */
  sessionId: string;
  /** Optional narrowing work token; must belong to `sessionId`. */
  workId?: string;
  /** Optional narrowing workspace; must be a registered root. */
  workspace?: string;
  /** Max rows; clamped to 1–50 server-side. Defaults to 20. */
  limit: number;
}

export interface HarnessStore {
  open(): void;
  close(): void;
  startSession(primaryWorkspace: string): SessionRecord;
  endSession(sessionId: string): void;
  startWork(sessionId: string, workspace: string, changeId?: string): WorkRecord;
  resume(
    sessionId: string,
    workId?: string,
  ): {
    session: SessionRecord;
    work: WorkRecord | null;
    latestCheckpoint: CheckpointRecord | null;
  };
  writeStageArtifact(input: Omit<StageArtifactRecord, "id" | "createdAt">): StageArtifactRecord;
  readStageArtifact(
    artifactId: string,
    opts: { sessionId: string; workId?: string },
  ): StageArtifactRecord;
  writeTaskList(input: Omit<HarnessTaskRecord, "id" | "createdAt">): HarnessTaskRecord;
  readTaskList(taskId: string, opts: { sessionId: string; workId?: string }): HarnessTaskRecord;
  checkpoint(input: Omit<CheckpointRecord, "seq" | "createdAt">): CheckpointRecord;
  harnessStatus(sessionId: string, workId?: string): HarnessStatusResult;
  /** Scoped recall: session required; work/workspace narrow; never global. */
  searchCheckpoints(query: string, opts: RecallScope): CheckpointRecord[];
  searchStageArtifacts(query: string, opts: RecallScope): StageArtifactRecord[];
  /**
   * Removes ended sessions whose `ended_at` predates `nowIso` minus
   * `SESSION_RETENTION_DAYS`, cascading to their scoped rows. Live sessions
   * are never touched. Returns the purged session ids.
   */
  purgeExpiredSessions(nowIso: string): string[];
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions(
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL,
  ended_at TEXT, primary_workspace TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS works(
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
  workspace TEXT NOT NULL, change_id TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS stage_artifacts(
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, work_id TEXT NOT NULL,
  workspace TEXT NOT NULL, change_id TEXT, stage TEXT NOT NULL,
  body TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS harness_tasks(
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, work_id TEXT NOT NULL,
  workspace TEXT NOT NULL, change_id TEXT, body TEXT NOT NULL,
  supersedes TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS checkpoints(
  seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
  work_id TEXT NOT NULL, workspace TEXT NOT NULL, change_id TEXT,
  completed_stage TEXT NOT NULL, artifact_id TEXT NOT NULL,
  summary TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS checkpoint_fts
  USING fts5(summary, completed_stage,
             content='checkpoints', content_rowid='seq');
CREATE VIRTUAL TABLE IF NOT EXISTS stage_artifact_fts
  USING fts5(body, stage, content='stage_artifacts', content_rowid='rowid');
CREATE TRIGGER IF NOT EXISTS checkpoint_fts_insert AFTER INSERT ON checkpoints BEGIN
  INSERT INTO checkpoint_fts(rowid, summary, completed_stage)
    VALUES (new.seq, new.summary, new.completed_stage);
END;
CREATE TRIGGER IF NOT EXISTS checkpoint_fts_delete AFTER DELETE ON checkpoints BEGIN
  DELETE FROM checkpoint_fts WHERE rowid = old.seq;
END;
CREATE TRIGGER IF NOT EXISTS stage_artifact_fts_insert AFTER INSERT ON stage_artifacts BEGIN
  INSERT INTO stage_artifact_fts(rowid, body, stage)
    VALUES (new.rowid, new.body, new.stage);
END;
CREATE TRIGGER IF NOT EXISTS stage_artifact_fts_delete AFTER DELETE ON stage_artifacts BEGIN
  DELETE FROM stage_artifact_fts WHERE rowid = old.rowid;
END;
`;

/**
 * Dual-validates the database candidate: it must sit outside every
 * configured workspace root AND outside ANY Git repository. Violations abort
 * startup with an explicit error; there is no repo-local fallback.
 */
function validateDbPath(dbPath: string, canonicalRoots: readonly string[]): void {
  const canonical = canonicalizeDbPath(dbPath);
  for (const root of canonicalRoots) {
    if (isInsideDir(root, canonical)) {
      throw new HarnessStoreError(
        "invalid-db-path",
        "harness database path must live outside all workspaces",
      );
    }
  }
  if (isInsideAnyGitRepo(canonical)) {
    throw new HarnessStoreError(
      "invalid-db-path",
      "harness database path must live outside any Git repository",
    );
  }
}

function now(): string {
  return new Date().toISOString();
}

/**
 * Canonicalizes a database candidate with the `src/paths.ts` longest-existing-
 * prefix pattern: realpath the longest existing ancestor (resolving symlinked
 * ancestors that would otherwise hide a repo escape), then re-append the
 * not-yet-existing segments.
 */
function canonicalizeDbPath(dbPath: string): string {
  const absolute = path.resolve(dbPath);
  const missing: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      const real = realpathSync(current);
      return missing.length === 0 ? real : path.join(real, ...missing.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return absolute;
      }
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

/** True when `candidate` is `root` itself or lives inside it. */
function isInsideDir(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

/**
 * True when a checkpoint `artifactId` looks like a repo-local path rather
 * than an external stored stage-artifact ID. Stored IDs are opaque UUIDs and
 * never contain a path separator; anything absolute or containing `/` or `\`
 * is a path reference and must be rejected.
 */
function isRepoPathArtifactId(artifactId: string): boolean {
  return (
    artifactId.includes("/") || artifactId.includes("\\") || path.isAbsolute(artifactId)
  );
}

/**
 * Maps unexpected persistence failures (raw SQLite I/O errors) to the
 * explicit request-time `store-unavailable` error. Typed
 * {@link HarnessStoreError} validation failures pass through unchanged.
 */
function asStoreUnavailable(error: unknown): HarnessStoreError {
  if (error instanceof HarnessStoreError) {
    return error;
  }
  return new HarnessStoreError("store-unavailable", "harness store is unavailable");
}

interface CheckpointRow {
  seq: number;
  session_id: string;
  work_id: string;
  workspace: string;
  change_id: string | null;
  completed_stage: string;
  artifact_id: string;
  summary: string;
  created_at: string;
}

interface StageArtifactRow {
  id: string;
  session_id: string;
  work_id: string;
  workspace: string;
  change_id: string | null;
  stage: string;
  body: string;
  created_at: string;
}

function toStageArtifactRecord(row: StageArtifactRow): StageArtifactRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    workId: row.work_id,
    workspace: row.workspace,
    changeId: row.change_id,
    stage: row.stage,
    body: row.body,
    createdAt: row.created_at,
  };
}

/** Clamps a recall limit to the 1–50 server-side bound (default 20). */
function clampRecallLimit(limit: number): number {
  if (!Number.isFinite(limit)) {
    return DEFAULT_RECALL_LIMIT;
  }
  return Math.min(MAX_RECALL_LIMIT, Math.max(1, Math.floor(limit)));
}

/**
 * Escapes free text into a safe FTS5 query: each whitespace-separated token
 * becomes a quoted phrase (embedded quotes doubled), joined with implicit
 * AND. Quoting keeps user punctuation from becoming FTS5 syntax.
 */
function toFtsQuery(query: string): string {
  const tokens = query
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  return tokens.map((token) => `"${token.replace(/"/g, `""`)}"`).join(" ");
}

/** Rejects over-cap bodies/summaries; never truncates silently. */
function requireWithinCap(kind: string, value: string, max: number): void {
  if (value.length > max) {
    throw new HarnessStoreError(
      "too-large",
      `${kind} exceeds the ${max}-character cap and was not stored`,
    );
  }
}

function toCheckpointRecord(row: CheckpointRow): CheckpointRecord {
  return {
    seq: row.seq,
    sessionId: row.session_id,
    workId: row.work_id,
    workspace: row.workspace,
    changeId: row.change_id,
    completedStage: row.completed_stage,
    artifactId: row.artifact_id,
    summary: row.summary,
    createdAt: row.created_at,
  };
}

/**
 * Next-action derivation over the ordered stage list. A missing checkpoint
 * starts at `explore`; the final `verify` stage reports complete. Unknown
 * completed stages restart from `explore` rather than gating progress.
 */
function deriveNextStage(completedStage: string | null): { next: string; reason: string } {
  if (completedStage === null) {
    return { next: "explore", reason: "no checkpoint yet; start with explore" };
  }
  const index = (HARNESS_STAGES as readonly string[]).indexOf(completedStage);
  if (index === -1) {
    return {
      next: "explore",
      reason: `unknown completed stage ${completedStage}; restart from explore`,
    };
  }
  const next = HARNESS_STAGES[index + 1];
  if (next === undefined) {
    return { next: "complete", reason: "verify checkpointed; work is complete" };
  }
  return { next, reason: `${completedStage} checkpointed; continue with ${next}` };
}

/**
 * Detects membership in ANY Git repository: walks the canonical candidate and
 * its parents up to the filesystem root looking for a `.git` marker as a
 * directory (plain repo, submodule) or a file (linked worktree).
 */
function isInsideAnyGitRepo(canonicalCandidate: string): boolean {
  let current = canonicalCandidate;
  for (;;) {
    if (existsSync(path.join(current, ".git"))) {
      return true;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return false;
    }
    current = parent;
  }
}

export function openHarnessStore(options: HarnessStoreOptions): HarnessStore {
  let db: DatabaseSync | null = null;
  let roots: string[] = [];

  function requireOpen(): DatabaseSync {
    if (db === null) {
      throw new HarnessStoreError("store-unavailable", "harness store is unavailable");
    }
    return db;
  }

  /** Canonicalizes a workspace to a registered root; rejects anything else. */
  function canonicalWorkspace(workspace: string): string {
    let canonical: string;
    try {
      canonical = realpathSync(path.resolve(workspace));
    } catch {
      throw new HarnessStoreError(
        "unknown-workspace",
        `workspace is not registered: ${workspace}`,
      );
    }
    if (!roots.includes(canonical)) {
      throw new HarnessStoreError(
        "unknown-workspace",
        `workspace is not registered: ${workspace}`,
      );
    }
    return canonical;
  }

  function readSession(sessionId: string): SessionRecord {
    const row = requireOpen()
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(sessionId) as
      | {
          id: string;
          created_at: string;
          ended_at: string | null;
          primary_workspace: string;
        }
      | undefined;
    if (row === undefined) {
      throw new HarnessStoreError("unknown-session", "unknown session");
    }
    return {
      id: row.id,
      createdAt: row.created_at,
      endedAt: row.ended_at,
      primaryWorkspace: row.primary_workspace,
    };
  }

  function requireLiveSession(sessionId: string): SessionRecord {
    const session = readSession(sessionId);
    if (session.endedAt !== null) {
      throw new HarnessStoreError("closed-session", "session is closed");
    }
    return session;
  }

  function readWork(workId: string): WorkRecord {
    const row = requireOpen()
      .prepare("SELECT * FROM works WHERE id = ?")
      .get(workId) as
      | {
          id: string;
          session_id: string;
          workspace: string;
          change_id: string | null;
          created_at: string;
        }
      | undefined;
    if (row === undefined) {
      throw new HarnessStoreError("unknown-work", "unknown work");
    }
    return {
      id: row.id,
      sessionId: row.session_id,
      workspace: row.workspace,
      changeId: row.change_id,
      createdAt: row.created_at,
    };
  }

  /**
   * Token parentage: the presented work token must belong to the presented
   * session. Cross-session work tokens are rejected, never re-parented.
   */
  function requireWorkInSession(workId: string, sessionId: string): WorkRecord {
    const work = readWork(workId);
    if (work.sessionId !== sessionId) {
      throw new HarnessStoreError(
        "session-mismatch",
        "work does not belong to the presented session",
      );
    }
    return work;
  }

  return {
    open(): void {
      if (db !== null) {
        return;
      }
      roots = options.workspaceRoots.map((root) => {
        try {
          return realpathSync(path.resolve(root));
        } catch {
          throw new HarnessStoreError(
            "unknown-workspace",
            `registered workspace does not exist: ${root}`,
          );
        }
      });
      validateDbPath(options.dbPath, roots);
      mkdirSync(path.dirname(path.resolve(options.dbPath)), { recursive: true });
      db = new DatabaseSync(path.resolve(options.dbPath));
      db.exec(SCHEMA);
      // Backfill FTS rows for databases written before the Slice 3 triggers
      // existed; the triggers keep every later write in sync.
      db.exec(`
        INSERT INTO checkpoint_fts(rowid, summary, completed_stage)
          SELECT seq, summary, completed_stage FROM checkpoints
          WHERE seq NOT IN (SELECT rowid FROM checkpoint_fts);
        INSERT INTO stage_artifact_fts(rowid, body, stage)
          SELECT rowid, body, stage FROM stage_artifacts
          WHERE rowid NOT IN (SELECT rowid FROM stage_artifact_fts);
      `);
    },

    close(): void {
      db?.close();
      db = null;
    },

    startSession(primaryWorkspace: string): SessionRecord {
      try {
        const canonical = canonicalWorkspace(primaryWorkspace);
        const record: SessionRecord = {
          id: randomUUID(),
          createdAt: now(),
          endedAt: null,
          primaryWorkspace: canonical,
        };
        requireOpen()
          .prepare(
            "INSERT INTO sessions(id, created_at, ended_at, primary_workspace) VALUES (?, ?, ?, ?)",
          )
          .run(record.id, record.createdAt, record.endedAt, record.primaryWorkspace);
        return record;
      } catch (error) {
        throw asStoreUnavailable(error);
      }
    },

    endSession(sessionId: string): void {
      try {
        const session = readSession(sessionId);
        if (session.endedAt !== null) {
          throw new HarnessStoreError("closed-session", "session is already closed");
        }
        requireOpen()
          .prepare("UPDATE sessions SET ended_at = ? WHERE id = ?")
          .run(now(), sessionId);
      } catch (error) {
        throw asStoreUnavailable(error);
      }
    },

    startWork(sessionId: string, workspace: string, changeId?: string): WorkRecord {
      try {
        requireLiveSession(sessionId);
        const canonical = canonicalWorkspace(workspace);
        const record: WorkRecord = {
          id: randomUUID(),
          sessionId,
          workspace: canonical,
          changeId: changeId ?? null,
          createdAt: now(),
        };
        requireOpen()
          .prepare(
            "INSERT INTO works(id, session_id, workspace, change_id, created_at) VALUES (?, ?, ?, ?, ?)",
          )
          .run(record.id, record.sessionId, record.workspace, record.changeId, record.createdAt);
        return record;
      } catch (error) {
        throw asStoreUnavailable(error);
      }
    },

    resume(sessionId: string, workId?: string) {
      try {
        const session = readSession(sessionId);
        if (session.endedAt !== null) {
          throw new HarnessStoreError("closed-session", "session is closed");
        }
        let work: WorkRecord | null = null;
        if (workId !== undefined) {
          work = requireWorkInSession(workId, sessionId);
        }
        // Resume depth: a presented work item scopes the latest checkpoint to
        // that work; session scope keeps the latest checkpoint across works.
        const checkpointRow = (
          workId === undefined
            ? requireOpen()
                .prepare(
                  "SELECT * FROM checkpoints WHERE session_id = ? ORDER BY seq DESC LIMIT 1",
                )
                .get(sessionId)
            : requireOpen()
                .prepare(
                  "SELECT * FROM checkpoints WHERE session_id = ? AND work_id = ? ORDER BY seq DESC LIMIT 1",
                )
                .get(sessionId, workId)
        ) as CheckpointRow | undefined;
        return {
          session,
          work,
          latestCheckpoint:
            checkpointRow === undefined ? null : toCheckpointRecord(checkpointRow),
        };
      } catch (error) {
        throw asStoreUnavailable(error);
      }
    },

    harnessStatus(sessionId: string, workId?: string): HarnessStatusResult {
      try {
        const session = readSession(sessionId);
        if (session.endedAt !== null) {
          throw new HarnessStoreError("closed-session", "session is closed");
        }
        if (workId !== undefined) {
          requireWorkInSession(workId, sessionId);
        }
        const scope = workId === undefined ? [sessionId] : [sessionId, workId];
        const workFilter = workId === undefined ? "" : "AND work_id = ?";
        const latestRow = requireOpen()
          .prepare(
            `SELECT * FROM checkpoints WHERE session_id = ? ${workFilter} ORDER BY seq DESC LIMIT 1`,
          )
          .get(...scope) as CheckpointRow | undefined;
        const latestCheckpoint =
          latestRow === undefined ? null : toCheckpointRecord(latestRow);
        const currentStage = latestCheckpoint?.completedStage ?? null;

        // Unverified transition: a stage artifact in scope advances beyond
        // the latest checkpoint. Reported honestly; never gates progress.
        const currentIndex =
          currentStage === null
            ? -1
            : (HARNESS_STAGES as readonly string[]).indexOf(currentStage);
        const artifactStages = requireOpen()
          .prepare(
            `SELECT stage FROM stage_artifacts WHERE session_id = ? ${workFilter}`,
          )
          .all(...scope) as Array<{ stage: string }>;
        const unverified = artifactStages.some(
          (row) => (HARNESS_STAGES as readonly string[]).indexOf(row.stage) > currentIndex,
        );

        // Bypass record: the checkpoint rows themselves are the record in the
        // harness DB. When the latest checkpoint skips the recommended
        // successor of its predecessor, the reason names the bypass.
        const previousRows = requireOpen()
          .prepare(
            `SELECT completed_stage FROM checkpoints WHERE session_id = ? ${workFilter} ORDER BY seq DESC LIMIT 2`,
          )
          .all(...scope) as Array<{ completed_stage: string }>;
        let bypassed = false;
        if (previousRows.length === 2) {
          const previousIndex = (HARNESS_STAGES as readonly string[]).indexOf(
            previousRows[1]?.completed_stage ?? "",
          );
          const latestIndex = (HARNESS_STAGES as readonly string[]).indexOf(
            previousRows[0]?.completed_stage ?? "",
          );
          bypassed =
            previousIndex !== -1 && latestIndex !== -1 && latestIndex !== previousIndex + 1;
        }

        const { next, reason } = deriveNextStage(currentStage);
        const reasons = [reason];
        if (bypassed) {
          reasons.push(
            `recommended order was bypassed (recorded in the harness store)`,
          );
        }
        if (unverified) {
          reasons.push(
            `unverified transition: a later stage artifact has no checkpoint yet`,
          );
        }
        return {
          currentStage,
          next,
          reason: reasons.join("; "),
          latestCheckpoint,
          unverified,
        };
      } catch (error) {
        throw asStoreUnavailable(error);
      }
    },

    writeStageArtifact(input): StageArtifactRecord {
      try {
        requireLiveSession(input.sessionId);
        requireWorkInSession(input.workId, input.sessionId);
        const canonical = canonicalWorkspace(input.workspace);
        if (!(HARNESS_STAGES as readonly string[]).includes(input.stage)) {
          throw new HarnessStoreError(
            "unknown-stage",
            `unknown stage: ${input.stage} (valid: ${HARNESS_STAGES.join(", ")})`,
          );
        }
        requireWithinCap("stage body", input.body, MAX_STAGE_BODY_CHARS);
        const record: StageArtifactRecord = {
          id: randomUUID(),
          sessionId: input.sessionId,
          workId: input.workId,
          workspace: canonical,
          changeId: input.changeId,
          stage: input.stage,
          body: input.body,
          createdAt: now(),
        };
        requireOpen()
          .prepare(
            "INSERT INTO stage_artifacts(id, session_id, work_id, workspace, change_id, stage, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            record.id,
            record.sessionId,
            record.workId,
            record.workspace,
            record.changeId,
            record.stage,
            record.body,
            record.createdAt,
          );
        return record;
      } catch (error) {
        throw asStoreUnavailable(error);
      }
    },

    readStageArtifact(
      artifactId: string,
      opts: { sessionId: string; workId?: string },
    ): StageArtifactRecord {
      try {
        readSession(opts.sessionId);
        const row = requireOpen()
          .prepare("SELECT * FROM stage_artifacts WHERE id = ?")
          .get(artifactId) as
          | {
              id: string;
              session_id: string;
              work_id: string;
              workspace: string;
              change_id: string | null;
              stage: string;
              body: string;
              created_at: string;
            }
          | undefined;
        if (row === undefined) {
          throw new HarnessStoreError("unknown-artifact", "unknown stage artifact");
        }
        if (row.session_id !== opts.sessionId) {
          throw new HarnessStoreError(
            "session-mismatch",
            "stage artifact does not belong to the presented session",
          );
        }
        if (opts.workId !== undefined && row.work_id !== opts.workId) {
          throw new HarnessStoreError(
            "session-mismatch",
            "stage artifact does not belong to the presented work",
          );
        }
        return {
          id: row.id,
          sessionId: row.session_id,
          workId: row.work_id,
          workspace: row.workspace,
          changeId: row.change_id,
          stage: row.stage,
          body: row.body,
          createdAt: row.created_at,
        };
      } catch (error) {
        throw asStoreUnavailable(error);
      }
    },

    writeTaskList(input): HarnessTaskRecord {
      try {
        requireLiveSession(input.sessionId);
        requireWorkInSession(input.workId, input.sessionId);
        const canonical = canonicalWorkspace(input.workspace);
        requireWithinCap("task body", input.body, MAX_TASK_BODY_CHARS);
        const record: HarnessTaskRecord = {
          id: randomUUID(),
          sessionId: input.sessionId,
          workId: input.workId,
          workspace: canonical,
          changeId: input.changeId,
          body: input.body,
          supersedes: input.supersedes,
          createdAt: now(),
        };
        requireOpen()
          .prepare(
            "INSERT INTO harness_tasks(id, session_id, work_id, workspace, change_id, body, supersedes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            record.id,
            record.sessionId,
            record.workId,
            record.workspace,
            record.changeId,
            record.body,
            record.supersedes,
            record.createdAt,
          );
        return record;
      } catch (error) {
        throw asStoreUnavailable(error);
      }
    },

    readTaskList(
      taskId: string,
      opts: { sessionId: string; workId?: string },
    ): HarnessTaskRecord {
      try {
        readSession(opts.sessionId);
        const row = requireOpen()
          .prepare("SELECT * FROM harness_tasks WHERE id = ?")
          .get(taskId) as
          | {
              id: string;
              session_id: string;
              work_id: string;
              workspace: string;
              change_id: string | null;
              body: string;
              supersedes: string | null;
              created_at: string;
            }
          | undefined;
        if (row === undefined) {
          throw new HarnessStoreError("unknown-artifact", "unknown task list");
        }
        if (row.session_id !== opts.sessionId) {
          throw new HarnessStoreError(
            "session-mismatch",
            "task list does not belong to the presented session",
          );
        }
        if (opts.workId !== undefined && row.work_id !== opts.workId) {
          throw new HarnessStoreError(
            "session-mismatch",
            "task list does not belong to the presented work",
          );
        }
        return {
          id: row.id,
          sessionId: row.session_id,
          workId: row.work_id,
          workspace: row.workspace,
          changeId: row.change_id,
          body: row.body,
          supersedes: row.supersedes,
          createdAt: row.created_at,
        };
      } catch (error) {
        throw asStoreUnavailable(error);
      }
    },

    checkpoint(input): CheckpointRecord {
      try {
        requireLiveSession(input.sessionId);
        requireWorkInSession(input.workId, input.sessionId);
        const canonical = canonicalWorkspace(input.workspace);
        requireWithinCap("checkpoint summary", input.summary, MAX_CHECKPOINT_SUMMARY_CHARS);
        // Checkpoints carry the EXTERNAL stored stage-artifact ID, never a
        // repo-local path. Path-like references are rejected before any
        // lookup, and the referenced artifact must exist in the same
        // (session, work) that the checkpoint is recorded for.
        if (isRepoPathArtifactId(input.artifactId)) {
          throw new HarnessStoreError(
            "unknown-artifact",
            "checkpoint artifact reference must be a stored stage-artifact id, never a repo-local path",
          );
        }
        const artifactRow = requireOpen()
          .prepare("SELECT session_id, work_id FROM stage_artifacts WHERE id = ?")
          .get(input.artifactId) as
          | { session_id: string; work_id: string }
          | undefined;
        if (artifactRow === undefined) {
          throw new HarnessStoreError(
            "unknown-artifact",
            "checkpoint references an unknown stage artifact",
          );
        }
        if (
          artifactRow.session_id !== input.sessionId ||
          artifactRow.work_id !== input.workId
        ) {
          throw new HarnessStoreError(
            "session-mismatch",
            "checkpoint artifact does not belong to the presented session and work",
          );
        }
        const createdAt = now();
        const result = requireOpen()
          .prepare(
            "INSERT INTO checkpoints(session_id, work_id, workspace, change_id, completed_stage, artifact_id, summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            input.sessionId,
            input.workId,
            canonical,
            input.changeId,
            input.completedStage,
            input.artifactId,
            input.summary,
            createdAt,
          );
        return {
          seq: Number(result.lastInsertRowid),
          sessionId: input.sessionId,
          workId: input.workId,
          workspace: canonical,
          changeId: input.changeId,
          completedStage: input.completedStage,
          artifactId: input.artifactId,
          summary: input.summary,
          createdAt,
        };
      } catch (error) {
        throw asStoreUnavailable(error);
      }
    },

    searchCheckpoints(query: string, opts: RecallScope): CheckpointRecord[] {
      try {
        // Session required server-side: unknown sessions throw before any row
        // is touched. Reads require existence, not liveness, so closed
        // sessions stay recallable for audit.
        readSession(opts.sessionId);
        if (opts.workId !== undefined) {
          requireWorkInSession(opts.workId, opts.sessionId);
        }
        const workspace =
          opts.workspace === undefined ? undefined : canonicalWorkspace(opts.workspace);
        const limit = clampRecallLimit(opts.limit);
        const db = requireOpen();
        const scope: Array<string | number> = [opts.sessionId];
        let predicate = "c.session_id = ?";
        if (opts.workId !== undefined) {
          predicate += " AND c.work_id = ?";
          scope.push(opts.workId);
        }
        if (workspace !== undefined) {
          predicate += " AND c.workspace = ?";
          scope.push(workspace);
        }
        const fts = toFtsQuery(query);
        if (fts === "") {
          const rows = db
            .prepare(
              `SELECT c.* FROM checkpoints c WHERE ${predicate} ORDER BY c.seq DESC LIMIT ?`,
            )
            .all(...scope, limit) as unknown as CheckpointRow[];
          return rows.map(toCheckpointRecord);
        }
        const rows = db
          .prepare(
            `SELECT c.* FROM checkpoints c
               JOIN checkpoint_fts f ON f.rowid = c.seq
              WHERE checkpoint_fts MATCH ? AND ${predicate}
              ORDER BY bm25(checkpoint_fts) LIMIT ?`,
          )
          .all(fts, ...scope, limit) as unknown as CheckpointRow[];
        return rows.map(toCheckpointRecord);
      } catch (error) {
        throw asStoreUnavailable(error);
      }
    },

    searchStageArtifacts(query: string, opts: RecallScope): StageArtifactRecord[] {
      try {
        readSession(opts.sessionId);
        if (opts.workId !== undefined) {
          requireWorkInSession(opts.workId, opts.sessionId);
        }
        const workspace =
          opts.workspace === undefined ? undefined : canonicalWorkspace(opts.workspace);
        const limit = clampRecallLimit(opts.limit);
        const db = requireOpen();
        const scope: Array<string | number> = [opts.sessionId];
        let predicate = "s.session_id = ?";
        if (opts.workId !== undefined) {
          predicate += " AND s.work_id = ?";
          scope.push(opts.workId);
        }
        if (workspace !== undefined) {
          predicate += " AND s.workspace = ?";
          scope.push(workspace);
        }
        const fts = toFtsQuery(query);
        if (fts === "") {
          const rows = db
            .prepare(
              `SELECT s.* FROM stage_artifacts s WHERE ${predicate} ORDER BY s.rowid DESC LIMIT ?`,
            )
            .all(...scope, limit) as unknown as StageArtifactRow[];
          return rows.map(toStageArtifactRecord);
        }
        const rows = db
          .prepare(
            `SELECT s.* FROM stage_artifacts s
               JOIN stage_artifact_fts f ON f.rowid = s.rowid
              WHERE stage_artifact_fts MATCH ? AND ${predicate}
              ORDER BY bm25(stage_artifact_fts) LIMIT ?`,
          )
          .all(fts, ...scope, limit) as unknown as StageArtifactRow[];
        return rows.map(toStageArtifactRecord);
      } catch (error) {
        throw asStoreUnavailable(error);
      }
    },

    purgeExpiredSessions(nowIso: string): string[] {
      try {
        const db = requireOpen();
        const cutoff = new Date(nowIso).getTime() - SESSION_RETENTION_DAYS * 86400000;
        const ended = db
          .prepare("SELECT id, ended_at FROM sessions WHERE ended_at IS NOT NULL")
          .all() as Array<{ id: string; ended_at: string }>;
        const purged: string[] = [];
        for (const row of ended) {
          if (new Date(row.ended_at).getTime() < cutoff) {
            purged.push(row.id);
          }
        }
        for (const id of purged) {
          // Scoped cascade; FTS rows follow through the delete triggers.
          const works = db
            .prepare("SELECT id FROM works WHERE session_id = ?")
            .all(id) as Array<{ id: string }>;
          const workIds = works.map((work) => work.id);
          db.prepare("DELETE FROM checkpoints WHERE session_id = ?").run(id);
          db.prepare("DELETE FROM stage_artifacts WHERE session_id = ?").run(id);
          db.prepare("DELETE FROM harness_tasks WHERE session_id = ?").run(id);
          for (const workId of workIds) {
            db.prepare("DELETE FROM works WHERE id = ?").run(workId);
          }
          db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
        }
        return purged;
      } catch (error) {
        throw asStoreUnavailable(error);
      }
    },
  };
}
