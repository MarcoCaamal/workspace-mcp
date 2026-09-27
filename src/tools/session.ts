import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HARNESS_STAGES, HarnessStoreError, buildContinuationEnvelope, deriveSessionState, type HarnessStore } from "../session-store.js";
import type { WorkspaceRegistry } from "../workspaces.js";
import {
  ENDED_SESSION_REOPEN_GUIDANCE,
  filterEnrichedLines,
  renderBootstrapBlock,
  renderCheckpointLines,
  renderContinuationLines,
  renderHarnessRecall,
  type RecallEnricher,
  type RecallEnrichedLine,
  type RecallEnrichmentSource,
} from "./recall.js";
import { describeError, errorResult, textResult, workspaceArg } from "./shared.js";

/**
 * Harness session/work/stage handlers (change chatgpt-workspace-harness,
 * tasks 2.12/2.14, 2.16).
 *
 * Thin handlers only: validate via zod, resolve the workspace through the
 * registry, validate token parentage/scope inside the store call, and format
 * with `textResult`/`errorResult`. All persistence lives in the outside-repo
 * SQLite+FTS5 store (`src/session-store.ts`); bodies included, never
 * repo-path references.
 *
 * This module NEVER imports or invokes the legacy repo-backed writers
 * (`src/state.ts`, `src/changes.ts`, `src/tools/changes.ts`): the new
 * no-artifacts flow persists only to the external store. Transport identity
 * is never consulted here — continuity is by explicit session/work token
 * only; tunnel, connection, and profile identifiers are never identity.
 */

const sessionTokenSchema = z
  .string()
  .min(1)
  .max(200)
  .describe("Opaque session token returned by session_start.");
const workTokenSchema = z
  .string()
  .min(1)
  .max(200)
  .describe("Opaque work token returned by work_start.");
const optionalWorkTokenSchema = workTokenSchema
  .optional()
  .describe("Opaque work token returned by work_start. Omitted means session scope.");
const changeIdSchema = z
  .string()
  .min(1)
  .max(200)
  .optional()
  .describe("Change id reference (qualified by workspace). Omitted means unbound.");
const stageNameSchema = z
  .string()
  .min(1)
  .max(64)
  .describe(`SDD stage name (one of ${HARNESS_STAGES.join(", ")}).`);
const bodySchema = z
  .string()
  .min(1)
  .max(100000)
  .describe("Full artifact body bytes stored in the outside-repo store.");
const summarySchema = z
  .string()
  .min(1)
  .max(8000)
  .describe("Semantic summary of the completed stage (model-authored).");
const artifactIdSchema = z
  .string()
  .min(1)
  .max(200)
  .describe("External stored stage-artifact id returned by stage_write. Never a repo-local path.");

/**
 * Slice C continuation (change harness-operability): opt-in output shape for
 * `harness_status` and `session_resume`. The default `text` path renders
 * byte-identical output to pre-change behavior; explicit `"json"` returns the
 * versioned capped envelope built from the single `store.harnessStatus()`
 * derivation — never a second or third derivation path.
 */
const continuationFormatSchema = z
  .enum(["text", "json"])
  .default("text")
  .describe(
    'Output shape: "text" renders the default human-readable lines, "json" returns the versioned continuation envelope.',
  );

function harnessErrorText(error: unknown): string {
  if (error instanceof HarnessStoreError) {
    return `${error.code}: ${error.message}`;
  }
  return describeError(error);
}

/**
 * Registers the nine harness session tools. The caller gates this on the
 * `harness.session` flag; flag-off restores pre-harness behavior (the 19
 * legacy tools only). The store is shared across stateless turns so explicit
 * tokens resume across fresh server instances.
 */
export function registerSessionTools(
  server: McpServer,
  registry: WorkspaceRegistry,
  store: HarnessStore,
): void {
  server.registerTool(
    "session_start",
    {
      title: "Start harness session",
      description:
        "Start a new harness session bound to one workspace and receive an opaque session token. " +
        "Use the token explicitly on every later harness call; tunnel or connection identifiers are never identity. " +
        "Writes only to the outside-repo store; creates no repo-local files.",
      inputSchema: {
        workspace: workspaceArg(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ workspace }) => {
      try {
        const { root } = registry.resolve(workspace);
        const session = store.startSession(root);
        // Slice D bootstrap (change harness-operability): a fresh session has
        // no works and no checkpoint, so the block renders untruncated with
        // the initial next action. Appended after the token line so the first
        // line stays the opaque session token.
        const block = renderBootstrapBlock({
          sessionId: session.id,
          primaryWorkspace: session.primaryWorkspace,
          works: [],
          latestSummary: null,
          next: "explore",
        });
        return textResult(
          [
            session.id,
            `primaryWorkspace: ${session.primaryWorkspace}`,
            `binding: session ${session.id} bound to ${session.primaryWorkspace}`,
            block,
          ].join("\n"),
        );
      } catch (error) {
        return errorResult(harnessErrorText(error));
      }
    },
  );

  server.registerTool(
    "session_end",
    {
      title: "End harness session",
      description:
        "Close a harness session explicitly. Writes with the token are rejected as ended while status and resume serve read-only snapshots; only session_reopen revives it. " +
        "No repo-local files are touched.",
      inputSchema: {
        session: sessionTokenSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ session }) => {
      try {
        store.endSession(session);
        return textResult(`closed session ${session}`);
      } catch (error) {
        return errorResult(harnessErrorText(error));
      }
    },
  );

  server.registerTool(
    "session_reopen",
    {
      title: "Reopen harness session",
      description:
        "Reopen an ended harness session by explicit token — the only path that revives one. " +
        "Returns an explicit ended-then-reopened notice and records the reopening so the session stays distinguishable from never-closed ones. " +
        "Resume without reopening never revives; a tokenless call is rejected and attaches to nothing.",
      inputSchema: {
        session: sessionTokenSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ session }) => {
      try {
        const { notice } = store.reopenSession(session);
        return textResult(notice);
      } catch (error) {
        return errorResult(harnessErrorText(error));
      }
    },
  );

  server.registerTool(
    "work_start",
    {
      title: "Start harness work",
      description:
        "Start one unit of work under a live session and receive an opaque work token bound to that session. " +
        "The work references (never replaces) the change model via the workspace-qualified change id. " +
        "Cross-session work tokens are rejected, never re-parented. External store only; no repo-local writes.",
      inputSchema: {
        session: sessionTokenSchema,
        workspace: workspaceArg(),
        changeId: changeIdSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ session, workspace, changeId }) => {
      try {
        let root: string;
        if (workspace !== undefined) {
          root = registry.resolve(workspace).root;
        } else {
          root = store.resume(session).session.primaryWorkspace;
        }
        const work = store.startWork(session, root, changeId);
        return textResult(
          [
            work.id,
            `session: ${work.sessionId}`,
            `workspace: ${work.workspace}`,
            `changeId: ${work.changeId ?? "(unbound)"}`,
          ].join("\n"),
        );
      } catch (error) {
        return errorResult(harnessErrorText(error));
      }
    },
  );

  server.registerTool(
    "session_resume",
    {
      title: "Resume harness session",
      description:
        "Resume a session (and optionally one work item) by explicit token across stateless turns. " +
        "Unknown tokens are reported; ended sessions return a read-only snapshot with reopen guidance and are never revived implicitly — use session_reopen. " +
        "A tokenless call is rejected and attaches to nothing. " +
        "Returns the work context plus the latest checkpoint summary and derived next action from the external store.",
      inputSchema: {
        session: sessionTokenSchema,
        work: optionalWorkTokenSchema,
        format: continuationFormatSchema,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ session, work, format }) => {
      try {
        const resumed = store.resume(session, work);
        // Single derivation: the store owns next/reason for both text and
        // json, so resume can never diverge from status for the same state.
        const status = store.harnessStatus(session, work);
        // Slice E lifecycle v2: ended sessions serve a read-only snapshot —
        // state, latest checkpoint, derived next, reopen guidance — and the
        // session stays ended (no live-context bootstrap block, no revive).
        const state = deriveSessionState(resumed.session);
        if (state !== "live") {
          if (format === "json") {
            return textResult(
              JSON.stringify(
                { state, ...buildContinuationEnvelope(status), reopen: ENDED_SESSION_REOPEN_GUIDANCE },
                null,
                2,
              ),
            );
          }
          const lines = [
            `session: ${resumed.session.id}`,
            `primaryWorkspace: ${resumed.session.primaryWorkspace}`,
            `work: ${resumed.work?.id ?? "(none)"}`,
            `state: ${state}`,
            ...renderCheckpointLines(resumed.latestCheckpoint),
            `next: ${status.next}`,
            `reopen: ${ENDED_SESSION_REOPEN_GUIDANCE}`,
          ];
          return textResult(lines.join("\n"));
        }
        if (format === "json") {
          return textResult(JSON.stringify(buildContinuationEnvelope(status), null, 2));
        }
        const lines = [
          `session: ${resumed.session.id}`,
          `primaryWorkspace: ${resumed.session.primaryWorkspace}`,
          `work: ${resumed.work?.id ?? "(none)"}`,
        ];
        if (resumed.work !== null) {
          lines.push(
            `workWorkspace: ${resumed.work.workspace}`,
            `changeId: ${resumed.work.changeId ?? "(unbound)"}`,
          );
        }
        lines.push(...renderCheckpointLines(resumed.latestCheckpoint));
        if (resumed.latestCheckpoint !== null) {
          lines.push(`next: ${status.next}`);
        } else {
          lines.push("next: explore");
        }
        // Slice D bootstrap (change harness-operability): append the capped
        // block carrying every work in the session plus the latest summary
        // and the derived next action. The JSON continuation above is
        // unaffected; `next` here reuses the single store derivation.
        lines.push(
          renderBootstrapBlock({
            sessionId: resumed.session.id,
            primaryWorkspace: resumed.session.primaryWorkspace,
            works: store.listWorks(session),
            latestSummary: resumed.latestCheckpoint?.summary ?? null,
            next: status.next,
          }),
        );
        return textResult(lines.join("\n"));
      } catch (error) {
        return errorResult(harnessErrorText(error));
      }
    },
  );

  server.registerTool(
    "stage_write",
    {
      title: "Write harness stage artifact",
      description:
        "Persist one logical stage artifact body to the outside-repo store for a session/work pair. " +
        "Unknown stage names are rejected with the valid list. Never calls legacy repo writers; writes no repo-local files.",
      inputSchema: {
        session: sessionTokenSchema,
        work: workTokenSchema,
        stage: stageNameSchema,
        body: bodySchema,
        workspace: workspaceArg(),
        changeId: changeIdSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ session, work, stage, body, workspace, changeId }) => {
      try {
        const root = resolveWriteWorkspace(registry, store, session, work, workspace);
        const artifact = store.writeStageArtifact({
          sessionId: session,
          workId: work,
          workspace: root,
          changeId: changeId ?? null,
          stage,
          body,
        });
        return textResult([artifact.id, `stage: ${artifact.stage}`].join("\n"));
      } catch (error) {
        return errorResult(harnessErrorText(error));
      }
    },
  );

  server.registerTool(
    "task_write",
    {
      title: "Write harness task list",
      description:
        "Persist a task-list body to the outside-repo store for a session/work pair. " +
        "Each write is a new stored list; supersede chains are retained, never edited in place. " +
        "Never calls legacy repo writers; writes no repo-local files.",
      inputSchema: {
        session: sessionTokenSchema,
        work: workTokenSchema,
        body: bodySchema,
        workspace: workspaceArg(),
        changeId: changeIdSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ session, work, body, workspace, changeId }) => {
      try {
        const root = resolveWriteWorkspace(registry, store, session, work, workspace);
        const tasks = store.writeTaskList({
          sessionId: session,
          workId: work,
          workspace: root,
          changeId: changeId ?? null,
          body,
          supersedes: null,
        });
        return textResult([tasks.id, `supersedes: ${tasks.supersedes ?? "(none)"}`].join("\n"));
      } catch (error) {
        return errorResult(harnessErrorText(error));
      }
    },
  );

  server.registerTool(
    "checkpoint",
    {
      title: "Record harness checkpoint",
      description:
        "Record a stage-transition checkpoint carrying the external stored stage-artifact id (never a repo-local path). " +
        "The referenced artifact must exist in the same session/work pair. External store only; no repo-local fallback.",
      inputSchema: {
        session: sessionTokenSchema,
        work: workTokenSchema,
        completedStage: stageNameSchema,
        artifactId: artifactIdSchema,
        summary: summarySchema,
        workspace: workspaceArg(),
        changeId: changeIdSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ session, work, completedStage, artifactId, summary, workspace, changeId }) => {
      try {
        const root = resolveWriteWorkspace(registry, store, session, work, workspace);
        const record = store.checkpoint({
          sessionId: session,
          workId: work,
          workspace: root,
          changeId: changeId ?? null,
          completedStage,
          artifactId,
          summary,
        });
        return textResult(
          [
            `checkpoint ${record.seq}`,
            `artifact: ${record.artifactId}`,
            `completedStage: ${record.completedStage}`,
            `summary: ${record.summary}`,
          ].join("\n"),
        );
      } catch (error) {
        return errorResult(harnessErrorText(error));
      }
    },
  );

  server.registerTool(
    "harness_status",
    {
      title: "Harness status",
      description:
        "Report harness status derived solely from the outside-repo store: current stage, next action with reason, " +
        "unverified-transition honesty for stage artifacts without a checkpoint, and the latest checkpoint. " +
        "Out-of-order checkpoints are permitted with the bypass recorded in the harness store. " +
        "A session token is required; tokenless calls are rejected. This surface never reads legacy state.",
      inputSchema: {
        session: sessionTokenSchema,
        work: optionalWorkTokenSchema,
        format: continuationFormatSchema,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ session, work, format }) => {
      try {
        const status = store.harnessStatus(session, work);
        // Slice E lifecycle v2: ended sessions serve a read-only snapshot
        // instead of throwing — state, derived lines, latest checkpoint,
        // reopen guidance. Nothing here marks the session live.
        if (status.state !== "live") {
          if (format === "json") {
            return textResult(
              JSON.stringify(
                { state: status.state, ...buildContinuationEnvelope(status), reopen: ENDED_SESSION_REOPEN_GUIDANCE },
                null,
                2,
              ),
            );
          }
          const lines = [
            `session: ${session}`,
            `state: ${status.state}`,
            ...renderContinuationLines(status),
            ...renderCheckpointLines(status.latestCheckpoint),
            `reopen: ${ENDED_SESSION_REOPEN_GUIDANCE}`,
          ];
          return textResult(lines.join("\n"));
        }
        if (format === "json") {
          return textResult(JSON.stringify(buildContinuationEnvelope(status), null, 2));
        }
        const lines = [
          `session: ${session}`,
          ...renderContinuationLines(status),
          `unverified: ${status.unverified}`,
          ...renderCheckpointLines(status.latestCheckpoint),
        ];
        return textResult(lines.join("\n"));
      } catch (error) {
        return errorResult(harnessErrorText(error));
      }
    },
  );
}

/**
 * Resolves the workspace path for a write: an explicit workspace name wins;
 * otherwise the parent work's pinned workspace is reused so omitted arguments
 * never drift across workspaces. A single `resume` call serves both the
 * work-pinned and the session-primary fallbacks.
 */function resolveWriteWorkspace(
  registry: WorkspaceRegistry,
  store: HarnessStore,
  sessionId: string,
  workId: string,
  workspace: string | undefined,
): string {
  if (workspace !== undefined) {
    return registry.resolve(workspace).root;
  }
  const resumed = store.resume(sessionId, workId);
  return resumed.work?.workspace ?? resumed.session.primaryWorkspace;
}

const recallQuerySchema = z
  .string()
  .min(1)
  .max(500)
  .optional()
  .describe("Free-text query over stage bodies and checkpoint summaries. Omitted means latest in scope.");
const recallLimitSchema = z
  .number()
  .int()
  .min(1)
  .max(100)
  .optional()
  .describe("Maximum rows to return. Defaults to 20 and is capped at 50 server-side.");

/**
 * Registers the scoped `harness_recall` tool (change
 * chatgpt-workspace-harness, tasks 4.2/4.4).
 *
 * The caller gates this on the `harness.recall` flag plus a shared
 * outside-repo store; flag-off leaves recall to the legacy byte-compatible
 * path. `session` is optional at the zod layer only so a tokenless call
 * reaches the handler and is rejected explicitly instead of searching
 * globally. Enrichment is best-effort: each optional source that is absent
 * or throws contributes an explicit `degraded:` marker, and enriched lines
 * pass through the same session/work scope filter as local results.
 */
export function registerHarnessRecallTool(
  server: McpServer,
  registry: WorkspaceRegistry,
  store: HarnessStore,
  enrichers: Partial<Record<RecallEnrichmentSource, RecallEnricher>> = {},
): void {
  server.registerTool(
    "harness_recall",
    {
      title: "Recall harness context",
      description:
        "Search harness stage bodies and checkpoint summaries within one session (and optionally one work item). " +
        "A session token is required; tokenless queries are rejected and cross-session rows are never returned. " +
        "Optional Engram/obsidian enrichment is best-effort and marked degraded when unavailable. " +
        "The legacy recall path is unchanged.",
      inputSchema: {
        session: sessionTokenSchema
          .optional()
          .describe("Opaque session token returned by session_start. Required; omitted calls are rejected."),
        work: optionalWorkTokenSchema,
        workspace: workspaceArg(),
        query: recallQuerySchema,
        limit: recallLimitSchema,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ session, work, workspace, query, limit }) => {
      try {
        if (session === undefined || session.trim() === "") {
          return errorResult("unknown-session: harness recall requires an explicit session token");
        }
        let canonical: string | undefined;
        if (workspace !== undefined) {
          canonical = registry.resolve(workspace).root;
        }
        const stages = store.searchStageArtifacts(query ?? "", {
          sessionId: session,
          workId: work,
          workspace: canonical,
          limit: limit ?? 20,
        });
        const checkpoints = store.searchCheckpoints(query ?? "", {
          sessionId: session,
          workId: work,
          workspace: canonical,
          limit: limit ?? 20,
        });
        const scope = { sessionId: session, workId: work };
        const enriched: RecallEnrichedLine[] = [];
        const degraded: RecallEnrichmentSource[] = [];
        for (const source of ["engram", "obsidian"] as const) {
          const enricher = enrichers[source];
          if (enricher === undefined) {
            degraded.push(source);
            continue;
          }
          try {
            const result = await enricher(query ?? "", scope);
            if (result.ok) {
              enriched.push(...filterEnrichedLines(result.lines, scope));
            } else {
              degraded.push(source);
            }
          } catch {
            degraded.push(source);
          }
        }
        return textResult(
          renderHarnessRecall({ stages, checkpoints, enriched, degraded }),
        );
      } catch (error) {
        return errorResult(harnessErrorText(error));
      }
    },
  );
}
