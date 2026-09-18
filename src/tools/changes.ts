import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  CHANGE_STAGES,
  type ChangeDocInfo,
  type ChangeRecord,
  type TaskCounts,
  type TaskRecord,
  TASK_STATUSES,
  type TaskStatus,
  changeDirRelativePath,
  changeDocRelativePath,
  countTasks,
  createChange,
  inspectChangeDocs,
  listChanges,
  nextTaskId,
  readChange,
  saveChange,
  withChangeLock,
  writeChangeDoc,
} from "../changes.js";
import { activeChangeId, appendJournal, readJournal, setActiveChange } from "../state.js";
import type { WorkspaceRegistry } from "../workspaces.js";
import { describeError, errorResult, renderJournalEntry, textResult, workspaceArg } from "./shared.js";

const stageSchema = z.enum(CHANGE_STAGES);
const statusSchema = z.enum(TASK_STATUSES);
const changeIdSchema = z
  .string()
  .min(1)
  .optional()
  .describe("Change id. Defaults to the active change; an unknown id is a clean error.");

type ChangeResolution = { ok: true; change: ChangeRecord } | { ok: false; error: string };

export function registerChangeTools(server: McpServer, registry: WorkspaceRegistry): void {
  registerChangeCreate(server, registry);
  registerChangeActivate(server, registry);
  registerChangeDoc(server, registry);
  registerChangeStatus(server, registry);
  registerTaskAdd(server, registry);
  registerTaskUpdate(server, registry);
  registerConstraintAdd(server, registry);
}

function registerChangeCreate(server: McpServer, registry: WorkspaceRegistry): void {
  server.registerTool(
    "change_create",
    {
      title: "Create change",
      description:
        "Create a tracked change (the unit of work) and make it the active change. " +
        "A change is a JSON record plus a directory that holds its stage documents (proposal.md, spec.md, design.md, notes.md) written on demand with change_doc. " +
        "Use it to track multi-step work so any future chat can re-orient with a single change_status call. " +
        "The id is a kebab-case slug of the title, deduplicated with -2, -3, ... on collision. " +
        "Next step: write the proposal with change_doc, then break the work into tasks with task_add.",
      inputSchema: {
        title: z.string().min(1).describe("Short human-readable title of the change; it becomes the kebab-case id."),
        goal: z.string().min(1).optional().describe("Optional one-sentence goal or outcome statement."),
        workspace: workspaceArg(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ title, goal, workspace }) => {
      const { root } = registry.resolve(workspace);
      try {
        return await withChangeLock(async () => {
          const change = await createChange(root, title, goal);
          await setActiveChange(root, change.id);
          await appendJournal(root, { tool: "change_create", change: change.id, detail: change.id, result: "active" });
          return textResult(
            [
              `created change ${change.id}: ${change.title}`,
              `dir: ${changeDirRelativePath(change.id)}`,
              "next: write the proposal with change_doc (stage proposal)",
            ].join("\n"),
          );
        });
      } catch (error) {
        return errorResult(describeError(error));
      }
    },
  );
}

function registerChangeActivate(server: McpServer, registry: WorkspaceRegistry): void {
  server.registerTool(
    "change_activate",
    {
      title: "Activate change",
      description:
        "Make an existing change the active one. While a change is active, every journal entry written by mutating operations is tagged with its id, " +
        "and the change tools default to it. Returns a short summary of the change.",
      inputSchema: {
        changeId: z.string().min(1).describe("Id of the change to activate, as returned by change_create."),
        workspace: workspaceArg(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ changeId, workspace }) => {
      const { root } = registry.resolve(workspace);
      try {
        return await withChangeLock(async () => {
          const change = await readChange(root, changeId);
          if (change === null) {
            return errorResult(`change not found: ${changeId}`);
          }
          await setActiveChange(root, change.id);
          await appendJournal(root, { tool: "change_activate", change: change.id, detail: change.id, result: "active" });
          const counts = countTasks(change.tasks);
          return textResult(
            `active change: ${change.id} — ${change.title} (${counts.done}/${counts.total} tasks done, updated ${change.updatedAt})`,
          );
        });
      } catch (error) {
        return errorResult(describeError(error));
      }
    },
  );
}

function registerChangeDoc(server: McpServer, registry: WorkspaceRegistry): void {
  server.registerTool(
    "change_doc",
    {
      title: "Write change document",
      description:
        "Write one stage document of a change: proposal, spec, design or notes. " +
        "By default the document is replaced; with append: true the new content is appended after a blank line. " +
        "Documents live under <workspace>/.workspace-mcp/changes/<id>/<stage>.md and can be written in any order, on demand. " +
        "Returns the workspace-relative path and which stage documents exist.",
      inputSchema: {
        changeId: changeIdSchema,
        stage: stageSchema.describe("Document stage: proposal (why/scope), spec (requirements), design (how), or notes (scratchpad)."),
        content: z.string().min(1).describe("Markdown content to store."),
        append: z.boolean().optional().describe("Append after a blank line instead of replacing the document. Defaults to false."),
        workspace: workspaceArg(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ changeId, stage, content, append, workspace }) => {
      const { root } = registry.resolve(workspace);
      try {
        return await withChangeLock(async () => {
          const resolved = await resolveChange(root, changeId);
          if (!resolved.ok) {
            return errorResult(resolved.error);
          }
          const change = resolved.change;
          const bytes = await writeChangeDoc(root, change.id, stage, content, append === true);
          await saveChange(root, change);
          const docs = await inspectChangeDocs(root, change.id);
          await appendJournal(root, {
            tool: "change_doc",
            change: change.id,
            detail: `${stage}.md (${bytes} bytes)`,
            result: "ok",
          });
          return textResult(
            [
              `${append === true ? "appended" : "wrote"} ${changeDocRelativePath(change.id, stage)} (${bytes} bytes)`,
              `docs present: ${renderDocPresence(docs)}`,
            ].join("\n"),
          );
        });
      } catch (error) {
        return errorResult(describeError(error));
      }
    },
  );
}

function registerChangeStatus(server: McpServer, registry: WorkspaceRegistry): void {
  server.registerTool(
    "change_status",
    {
      title: "Change status",
      description:
        "Read-only orientation call: the single way to re-orient on tracked work at the start of any chat. " +
        "Without arguments it renders the active change in full: title, goal, stage documents present or missing, tasks grouped by status, constraints, " +
        "the last ten journal entries tagged with the change, and a derived suggested next action. " +
        "With all: true (or with no active change) it lists every change newest-first with done/total task counts. " +
        "Never writes state and is never journaled.",
      inputSchema: {
        changeId: changeIdSchema,
        all: z.boolean().optional().describe("List every change instead of rendering one in full. Defaults to false."),
        workspace: workspaceArg(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ changeId, all, workspace }) => {
      const { root } = registry.resolve(workspace);
      try {
        const active = await activeChangeId(root);
        if (all === true || (changeId === undefined && active === null)) {
          const changes = await listChanges(root);
          if (changes.length === 0) {
            return textResult("no changes yet");
          }
          const lines = changes.map((change) => {
            const counts = countTasks(change.tasks);
            const marker = change.id === active ? "  (active)" : "";
            return `- ${change.id}  ${change.title}  ${counts.done}/${counts.total} tasks  updated ${change.updatedAt}${marker}`;
          });
          return textResult(`Changes (newest first, ${changes.length}):\n\n${lines.join("\n")}`);
        }

        const id = changeId ?? active;
        const change = id !== null ? await readChange(root, id) : null;
        if (change === null) {
          return errorResult(`change not found: ${id ?? "(none)"}`);
        }
        const docs = await inspectChangeDocs(root, change.id);
        const journal = await readJournal(root, { change: change.id, limit: 10 });
        return textResult(renderChangeStatus(change, active, docs, journal.map(renderJournalEntry)));
      } catch (error) {
        return errorResult(describeError(error));
      }
    },
  );
}

function registerTaskAdd(server: McpServer, registry: WorkspaceRegistry): void {
  server.registerTool(
    "task_add",
    {
      title: "Add task",
      description:
        "Append one task to a change. Task ids are sequential (T1, T2, ...). The task starts as pending unless another status is given. " +
        "Use task_update to move a task between statuses.",
      inputSchema: {
        changeId: changeIdSchema,
        text: z.string().min(1).describe("What the task is; one imperative sentence."),
        status: statusSchema.optional().describe("Initial status. Defaults to pending."),
        workspace: workspaceArg(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ changeId, text, status, workspace }) => {
      const { root } = registry.resolve(workspace);
      try {
        return await withChangeLock(async () => {
          const resolved = await resolveChange(root, changeId);
          if (!resolved.ok) {
            return errorResult(resolved.error);
          }
          const change = resolved.change;
          const now = new Date().toISOString();
          const task: TaskRecord = {
            id: nextTaskId(change.tasks),
            text: text.trim(),
            status: status ?? "pending",
            notes: [],
            createdAt: now,
            updatedAt: now,
          };
          change.tasks.push(task);
          await saveChange(root, change);
          await appendJournal(root, {
            tool: "task_add",
            change: change.id,
            detail: `${task.id}: ${task.text}`,
            result: "ok",
          });
          const counts = countTasks(change.tasks);
          return textResult(`added ${task.id} [${task.status}] ${task.text}\ncounts: ${renderCounts(counts)}`);
        });
      } catch (error) {
        return errorResult(describeError(error));
      }
    },
  );
}

function registerTaskUpdate(server: McpServer, registry: WorkspaceRegistry): void {
  server.registerTool(
    "task_update",
    {
      title: "Update tasks",
      description:
        "Update the status of one or more tasks in a single all-or-nothing write: every taskId is validated before anything is stored, " +
        "so one unknown id leaves the change untouched and the error lists the bad entries. " +
        "An optional note is appended to the task's notes. One aggregate journal entry is written.",
      inputSchema: {
        changeId: changeIdSchema,
        updates: z
          .array(
            z.object({
              taskId: z.string().min(1).describe("Task id, for example T1."),
              status: statusSchema.describe("New status: pending, in_progress, done or blocked."),
              note: z.string().min(1).optional().describe("Optional note appended to the task's notes."),
            }),
          )
          .min(1)
          .max(100)
          .describe("Task updates to apply together; all are validated before any write."),
        workspace: workspaceArg(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ changeId, updates, workspace }) => {
      const { root } = registry.resolve(workspace);
      try {
        return await withChangeLock(async () => {
          const resolved = await resolveChange(root, changeId);
          if (!resolved.ok) {
            return errorResult(resolved.error);
          }
          const change = resolved.change;
          const unknown = updates.filter((update) => !change.tasks.some((task) => task.id === update.taskId));
          if (unknown.length > 0) {
            return errorResult(`unknown task id(s): ${unknown.map((update) => update.taskId).join(", ")}`);
          }

          const now = new Date().toISOString();
          const results: string[] = [];
          for (const update of updates) {
            const task = change.tasks.find((candidate) => candidate.id === update.taskId);
            if (task === undefined) {
              continue;
            }
            const previous = task.status;
            task.status = update.status;
            task.updatedAt = now;
            if (update.note !== undefined) {
              task.notes.push(update.note.trim());
            }
            results.push(`${task.id}: ${previous} → ${update.status}`);
          }
          await saveChange(root, change);
          await appendJournal(root, {
            tool: "task_update",
            change: change.id,
            detail: updates.map((update) => `${update.taskId}→${update.status}`).join(", "),
            result: "ok",
          });
          const counts = countTasks(change.tasks);
          return textResult(`${results.join("\n")}\ncounts: ${renderCounts(counts)}`);
        });
      } catch (error) {
        return errorResult(describeError(error));
      }
    },
  );
}

function registerConstraintAdd(server: McpServer, registry: WorkspaceRegistry): void {
  server.registerTool(
    "constraint_add",
    {
      title: "Add constraint",
      description:
        "Append one constraint to a change: a rule, limit or requirement that the work must respect (for example 'no new runtime dependencies'). " +
        "Constraints are shown by change_status so later chats do not have to re-ask.",
      inputSchema: {
        changeId: changeIdSchema,
        text: z.string().min(1).describe("The constraint, phrased as a short rule."),
        workspace: workspaceArg(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ changeId, text, workspace }) => {
      const { root } = registry.resolve(workspace);
      try {
        return await withChangeLock(async () => {
          const resolved = await resolveChange(root, changeId);
          if (!resolved.ok) {
            return errorResult(resolved.error);
          }
          const change = resolved.change;
          const constraint = text.trim();
          change.constraints.push(constraint);
          await saveChange(root, change);
          await appendJournal(root, { tool: "constraint_add", change: change.id, detail: constraint, result: "ok" });
          const lines = change.constraints.map((item) => `- ${item}`);
          return textResult(`constraint added (${change.constraints.length} total):\n${lines.join("\n")}`);
        });
      } catch (error) {
        return errorResult(describeError(error));
      }
    },
  );
}

async function resolveChange(root: string, changeId: string | undefined): Promise<ChangeResolution> {
  const id = changeId ?? (await activeChangeId(root));
  if (id === null || id === "") {
    return { ok: false, error: "no active change: pass changeId or create one with change_create" };
  }
  const change = await readChange(root, id);
  if (change === null) {
    return { ok: false, error: `change not found: ${id}` };
  }
  return { ok: true, change };
}

function renderChangeStatus(
  change: ChangeRecord,
  active: string | null,
  docs: readonly ChangeDocInfo[],
  journal: readonly string[],
): string {
  const counts = countTasks(change.tasks);
  const pending = change.tasks.filter((task) => task.status === "pending");
  const inProgress = change.tasks.filter((task) => task.status === "in_progress");
  const blocked = change.tasks.filter((task) => task.status === "blocked");
  const done = change.tasks.filter((task) => task.status === "done");

  const lines: string[] = [
    `Change ${change.id}: ${change.title}`,
    change.goal !== undefined ? `goal: ${change.goal}` : "goal: (none)",
    `active: ${change.id === active ? "yes" : "no"}`,
    `updated: ${change.updatedAt}`,
    "docs:",
    ...docs.map((doc) => `  ${doc.present ? `${doc.stage}.md (${doc.bytes} bytes)` : `${doc.stage}.md (missing)`}`),
    `tasks (${counts.done}/${counts.total} done):`,
  ];

  if (change.tasks.length === 0) {
    lines.push("  (none yet)");
  }
  for (const [label, group] of [
    ["pending", pending],
    ["in_progress", inProgress],
    ["done", done],
    ["blocked", blocked],
  ] as const) {
    for (const task of group) {
      lines.push(`  ${task.id} [${label}] ${task.text}`);
    }
  }

  if (change.constraints.length === 0) {
    lines.push("constraints: none");
  } else {
    lines.push(`constraints (${change.constraints.length}):`);
    for (const constraint of change.constraints) {
      lines.push(`  - ${constraint}`);
    }
  }

  if (journal.length === 0) {
    lines.push("recent activity: none");
  } else {
    lines.push(`recent activity (${journal.length}, newest first):`);
    for (const line of journal) {
      lines.push(`  ${line}`);
    }
  }

  lines.push(`suggested next action: ${suggestNextAction(change, docs)}`);
  return lines.join("\n");
}

/**
 * Derived next action, in priority order: no tasks and no proposal -> write the
 * proposal; all tasks done -> verify; blocked -> unblock; in_progress ->
 * continue; pending -> start; otherwise break the work into tasks.
 */
function suggestNextAction(change: ChangeRecord, docs: readonly ChangeDocInfo[]): string {
  const hasProposal = docs.some((doc) => doc.stage === "proposal" && doc.present);
  if (change.tasks.length === 0 && !hasProposal) {
    return "write the proposal with change_doc (stage proposal)";
  }
  if (change.tasks.length > 0 && change.tasks.every((task) => task.status === "done")) {
    return "run the tests and save a summary with remember";
  }
  const blocked = change.tasks.find((task) => task.status === "blocked");
  if (blocked !== undefined) {
    return `unblock ${blocked.id}`;
  }
  const inProgress = change.tasks.find((task) => task.status === "in_progress");
  if (inProgress !== undefined) {
    return `continue ${inProgress.id}`;
  }
  const pending = change.tasks.find((task) => task.status === "pending");
  if (pending !== undefined) {
    return `start ${pending.id}`;
  }
  return "break the work into tasks with task_add";
}

function renderDocPresence(docs: readonly ChangeDocInfo[]): string {
  const present = docs.filter((doc) => doc.present);
  if (present.length === 0) {
    return "none";
  }
  return present.map((doc) => `${doc.stage}.md (${doc.bytes} bytes)`).join(", ");
}

function renderCounts(counts: TaskCounts): string {
  return `${counts.done}/${counts.total} done, ${counts.pending} pending, ${counts.in_progress} in progress, ${counts.blocked} blocked`;
}
