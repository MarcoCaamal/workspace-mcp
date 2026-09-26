# Architecture

## Purpose

`workspace-mcp` is a Model Context Protocol (MCP) server that gives an agent in
any MCP-capable client a bounded filesystem toolkit over one or more named
project roots, plus a small workspace-local memory (activity journal, notes,
changes and tasks). It exists to remove copy-paste between the user and the
chat: the agent reads, searches and edits files directly through typed tools,
under a containment boundary that rejects everything outside the selected
workspace root.

Two properties shape the whole design:

- **Shell execution is opt-in.** Without an explicit flag or environment
  variable, no command-execution tool is registered.
- **State is files, not a database.** Journal, notes and change tracking live
  under `<root>/.workspace-mcp/` as JSON lines and JSON files that can be
  inspected, rotated and deleted with ordinary tools.

## Runtime and transports

| Property | Value |
| --- | --- |
| Runtime | Node.js >= 22, ESM only |
| Default transport | stdio (what MCP clients launch) |
| Optional transport | Streamable HTTP at `POST /mcp` |
| Runtime dependencies | `@modelcontextprotocol/sdk`, `zod` |
| Tool count | 19 without shell, 23 with shell |

## Module map

| Module | Responsibility |
| --- | --- |
| `src/index.ts` | Process entry point. Parses CLI flags, loads the optional config file, merges CLI > env > file > defaults, resolves workspace roots, selects the transport (stdio or Streamable HTTP), starts the server and installs `SIGINT`/`SIGTERM` shutdown handling. |
| `src/config.ts` | Optional JSON config file: discovery (explicit `--config` -> cwd file -> global path), strict validation (unknown keys rejected, secrets refused) and the pure merge that implements the precedence rules. |
| `src/server.ts` | Builds the `McpServer`, registers the enabled tool groups, and sets the instructions sent to clients (including the session-start / session-end convention). |
| `src/workspaces.ts` | Workspace registry. Registers the primary root (`default`) and named roots, validates names, resolves the optional `workspace` argument on tools and produces the `workspace_list` output. |
| `src/paths.ts` | The single containment implementation (`resolveSafe`). Canonicalizes the root and target with `fs.realpath`, walks to the nearest existing ancestor for targets that do not exist yet, and rejects anything that does not resolve inside the selected root. |
| `src/files.ts` | Filesystem primitives: bounded reads with line numbers, write, exact-string edit, all-or-nothing patch, binary detection (NUL byte in the first 8 KiB) and size limits. |
| `src/glob.ts` | Glob-to-regex matcher used by `grep.include` and `list_files.pattern` (`**`, `*`, `?`, `{a,b}`, `[abc]`, `[!abc]`). Patterns without `/` match the file name at any depth. |
| `src/shell.ts` | The opt-in `run_command` engine: allowlist check, environment scrubbing, `spawn` with `shell: false`, timeout and process-group kill, ANSI stripping, merged output and head+tail truncation. |
| `src/jobs.ts` | Process-global job registry: detached spawn, per-job log files, status transitions, `maxRuntimeMs` enforcement and shutdown cleanup. |
| `src/state.ts` | Workspace-local state: `journal.jsonl`, `notes.jsonl` and `state.json`. Lazy creation, rotation, bounded reads, atomic JSON writes, per-file write serialization and the active-change helper. |
| `src/changes.ts` | Change records and tasks: create/activate, stage documents, task and constraint updates, status summaries and the derived next-action suggestion. |
| `src/tools/*` | One module per tool group: `shared`, `read`, `write`, `edit`, `patch`, `list`, `grep`, `run`, `jobs`, `work-log`, `remember`, `recall`, `git`, `changes`, `workspaces`. Each defines the tool schema, annotations and handler. |

## Request flow

```txt
MCP client (ChatGPT, Codex, Cursor, Claude Desktop, ...)
  |  JSON-RPC over stdio or POST /mcp (Streamable HTTP)
  v
transport (src/index.ts)
  v
McpServer + tool registry (src/server.ts, src/tools/*)
  v
tool handler
  |- resolve workspace        (src/workspaces.ts)  optional `workspace` argument
  |- containment check        (src/paths.ts)       resolveSafe on every path/cwd
  |- operation
  |    files        src/files.ts, src/glob.ts
  |    state        src/state.ts
  |    changes      src/changes.ts
  |    git          argv `git -C <selected root>`, no shell
  |    shell/jobs   src/shell.ts, src/jobs.ts
  `- best-effort journal append on mutations (src/state.ts)
  v
text result, or exactly one short actionable error message
```

Tools return workspace-relative paths and fail with `{ isError: true }` plus a
sanitized message; stack traces and raw filesystem errors go to stderr only.
Read-only tools are never journaled.

## State model

All state is per workspace root, under `<root>/.workspace-mcp/`:

```txt
.workspace-mcp/
  .gitignore          # contains "*", so the directory is invisible to git
  journal.jsonl       # automatic activity journal (mutating operations)
  journal.1.jsonl     # rotated previous journal
  notes.jsonl         # deliberate notes saved with `remember`
  notes.1.jsonl       # rotated previous notes
  state.json          # { "activeChange": "<id>" | null }
  changes/
    <id>.json         # change record: title, goal, constraints, tasks
    <id>/             # stage documents written on demand
      proposal.md
      spec.md
      design.md
      notes.md
```

The directory is created lazily on the first write and contains its own
`.gitignore` with `*`; the repository's own `.gitignore` is never touched. It is
also part of the traversal ignore list, so `grep` and `list_files` never see it.

### Write and read rules

- **Journal and notes** are appended with `fs.appendFile` after every mutation
  (success or failure). Appends of small lines are atomic, so concurrent tools
  cannot interleave. Journaling is best-effort: a state write failure is logged
  to stderr and never changes the tool's result.
- **JSON records** (`state.json`, `changes/<id>.json`) are written atomically
  with a temporary file plus rename, so readers never observe a partial file and
  no `.tmp` remains after a successful write.
- **Rotation** happens at `WORKSPACE_MCP_JOURNAL_MAX_BYTES` (default 5 MiB) per
  stream: the current file is renamed to `<name>.1.jsonl` and a fresh file is
  started.
- **Reads are bounded**: at most the last 1 MiB of the current file, then the
  last 1 MiB of the rotated file when more entries are needed. Malformed lines
  are skipped, and `detail`/`result` are truncated to 300 characters.

### Journal entry shape

One JSON object per line. `change` is present when a change was active (or was
the active change at append time):

```json
{
  "ts": "2026-09-18T07:50:12.000Z",
  "tool": "edit_file",
  "paths": ["src/x.ts"],
  "detail": "2 replacement(s)",
  "result": "ok",
  "change": "my-change"
}
```

### Note record shape

One JSON object per line:

```json
{ "ts": "2026-09-18T07:50:12.000Z", "text": "Refactored auth middleware", "tags": ["auth"] }
```

### Change record shape

```json
{
  "id": "my-change",
  "title": "My change",
  "goal": "optional outcome statement",
  "constraints": ["no new runtime dependencies"],
  "tasks": [
    {
      "id": "T1",
      "text": "wire the schema",
      "status": "pending",
      "notes": [],
      "createdAt": "...",
      "updatedAt": "..."
    }
  ],
  "createdAt": "...",
  "updatedAt": "..."
}
```

Task `status` is one of `pending`, `in_progress`, `done`, `blocked`. Stage docs
are plain Markdown written on demand; `change_status` derives the suggested next
action from the record instead of enforcing order (see the decision log).

## Jobs engine lifecycle

`start_job`, `job_status` and `job_kill` exist so long-running work survives
client timeouts and disconnects. There is no durable queue.

1. **Validate.** The allowlist check, `cwd` containment and argv validation run
   before spawning; a failure is a synchronous error and creates no job.
2. **Spawn detached.** The command runs with `spawn(argv, { shell: false,
   detached: true })` in its own process group. stdout and stderr append to
   `<jobDir>/<jobId>.log` with a 64 MiB cap.
3. **Register.** The job is stored in a process-global registry and
   `start_job` returns immediately with `jobId`, `pid`, `startedAt` and the log
   path.
4. **Observe.** `job_status` is read-only and reports `running`, `exited`,
   `killed`, `timed-out` or `failed-to-start`, plus exit code, duration, log
   size and the ANSI-stripped log tail.
5. **Bound.** `maxRuntimeMs` defaults to 30 minutes, minimum 1 second, cap
   2 hours. On expiry the process group is killed and the status becomes
   `timed-out`.
6. **Kill.** `job_kill` sends `SIGTERM` to the whole process group and `SIGKILL`
   after a 3-second grace period. Killing an already finished job is not an
   error.
7. **Shutdown.** `SIGINT`/`SIGTERM` (or a stdio stdin close) kills every running
   job's process group before the server exits, so no orphans are left behind.

Logs go to `os.tmpdir()/workspace-mcp-jobs` by default, or under
`WORKSPACE_MCP_JOB_DIR` when set; they never appear in `list_files` or `grep`.

## Multi-workspace registry

Since v1.5.0 one process serves several named roots:

- `--root <dir>` registers the primary workspace named `default`.
- `--workspace <name>=<path>` is repeatable and registers another workspace.
  Names match `^[a-z0-9][a-z0-9_-]*$` and must be unique. A missing `=`, an
  invalid or duplicate name, or a non-existent path aborts startup.
- With only `--workspace` flags, the first one is primary unless one is named
  `default`. With no flags at all, the current working directory is the single
  primary workspace.
- Every path or state tool accepts an optional `workspace` argument; omitting it
  targets the primary workspace. An unknown name is a clear error.
- **Isolation is per root.** Containment is evaluated against the selected
  root, and journal, notes, changes and `state.json` live under that root.
  A `../` escape is rejected relative to the selected workspace even when the
  same path would be valid in another one.
- Shell tools follow the selection: `cwd` resolves against the selected root,
  and `git_status`/`git_diff` run `git -C <selected root>`.

## Harness sessions (stateful SDD flow)

Slice 2 adds server-issued session/work identity plus stage/task writes with
explicit resume, backed from day one by a single outside-repo SQLite+FTS5
store. It requires Node `>=22.13`: the store uses the built-in `node:sqlite`
module (`DatabaseSync`), available unflagged from Node 22.13 but still
experimental in the 22.x line. All SQL lives behind the single import site in
`src/session-store.ts`, the schema is additive (`IF NOT EXISTS`) only, and no
new runtime dependency is added.

| Property | Value |
| --- | --- |
| Tools | `session_start`, `session_end`, `work_start`, `session_resume`, `stage_write`, `task_write`, `checkpoint`, `harness_status` in `src/tools/session.ts` (thin handlers; logic in `src/session-store.ts`); scoped `harness_recall` in `src/tools/session.ts` with rendering in `src/tools/recall.ts` |
| Gate | Config `harness.session` (default off); flag-off restores the 19-tool pre-harness surface. Scoped recall is separately gated by `harness.recall` (default off); the legacy `recall` path stays byte-compatible either way |
| Stages | `explore → propose → spec → design → tasks → apply → verify`; `harness_status` derives the next action from the external store |
| Store | `$XDG_CONFIG_HOME/workspace-mcp/harness.db` (fallback `~/.config/...`), overridable by `harness.dbPath` or `WORKSPACE_MCP_HARNESS_DB` |
| Recall | `checkpoint_fts` + `stage_artifact_fts` (FTS5, `bm25` ranking, `limit` clamped to 1–50); session required, work/workspace narrow; tokenless queries rejected |
| Retention | Ended sessions retained 90 days, then removed by explicit purge only; over-cap bodies/summaries rejected, never truncated |

### Identity and resume contract

- `session_start` returns an opaque unguessable token (`crypto.randomUUID()`)
  bound to one canonical workspace; `work_start` returns a work token bound to
  its parent session. Every session-scoped call presents the tokens
  explicitly; `session_resume` restores the work context plus the latest
  checkpoint summary and derived next action across stateless turns and
  restarts.
- Token parentage is validated on every call (`work.sessionId == session`):
  cross-session work tokens are rejected, never re-parented. A tokenless
  session-scoped call is rejected and attaches to nothing; closed sessions
  report closed and are never revived.
- The tunnel, connection, and profile identifiers are never consulted for
  identity. The single shared HTTP bearer gates transport access only.
- Token-possession limits (stated honestly, not as a stronger claim): within
  an authenticated tunnel, possession of a session/work token controls that
  session. There is no per-caller identity, so no per-conversation isolation
  beyond token possession is claimed.

### Workspace binding and storage rules

- Every record (session, work, stage artifact, task list, checkpoint) pins its
  canonical (`realpath`) registered workspace; `changeId` is qualified by the
  composite `(workspace, changeId)`. Cross-workspace use within one session is
  permitted; each record pins the workspace it was created in.
- New harness state — records and bodies alike — lives only in the
  outside-repo store; checkpoints reference the stage artifact by its external
  stored artifact id, never by repo-local path. The new flow never imports or
  invokes the legacy repo writers (`src/state.ts`, `src/changes.ts`,
  `src/tools/changes.ts`).
- The resolved store path is canonicalized (realpath + longest-existing-prefix
  per the `src/paths.ts` pattern) and dual-validated at open: outside every
  configured root AND outside ANY Git repository (canonical-parent `.git`
  dir-or-file walk, covering worktrees and submodules). A violation aborts
  startup. Every write kind maps request-time persistence failure to an
  explicit `store-unavailable` error with no repo-local fallback.
- Primary-workspace first run: the guided entry binds the configured primary
  (`chatgpt.primary`, defaulting to the default workspace); an explicit
  `workspace` argument overrides the default for that call, and disabling the
  preset leaves explicit selection untouched. `docs/CODE_STANDARDS.md` (basic
  mode, flat layout, thin handlers) is unchanged by this change.

### Scoped recall and hardening (Slice 3)

- `harness_recall` searches stage bodies and checkpoint summaries within one
  explicitly presented session (and optionally one work item), intersected
  with the caller's registered-workspace scope. A tokenless query is
  rejected; rows from other sessions, sibling works, or out-of-scope
  workspaces are never returned. The legacy `recall`/`readNotes` path is
  unchanged and never mixed into harness results.
- Engram and the independent `obsidian-mcp` stay optional: startup never
  requires them, recall answers from the local store first, and every
  unreachable source is reported with an explicit `degraded:` marker.
  Enrichment lines pass through the same session/work scope filter before
  return.
- Retention and caps (behind `harness.recall`): ended sessions are retained
  90 days, then removed only by an explicit purge (live sessions never
  purged); checkpoint summaries are model-authored and capped at 8000 chars,
  stage/task bodies at 100000 chars — over-cap writes are rejected with a
  typed error, never silently truncated; recall orders by FTS5 `bm25` with
  `limit` clamped to 1–50.

### Request flow (stateful turn)

```txt
ChatGPT turn (stateless POST, fresh McpServer; bearer gates transport only)
  |  session_start / {session, work} + action
  v
src/index.ts handleRequest --> createServer(...) --> registerSessionTools
  |  (shared store opened once at startup; tunnel ID never identity)
  v
src/tools/session.ts handler
  |  validate (zod) -> registry.resolve + canonicalize(workspace)
  |  -> validate token parentage + registered scope -> store call by token
  |  -> NEVER calls change_create/change_doc/task_add/work_log/remember
  v
harness.db (OUTSIDE ALL repos, any-repo validated)
  v
text result: ids, canonical binding, artifact IDs, checkpoint summary, next action
```

## Configuration

Since v1.6.0 an optional JSON config file (`workspace-mcp.config.json`)
supplies defaults for workspaces, shell execution, transport and state. It is a
defaults layer, never a replacement: with no file present, behavior is
identical to previous versions.

- **Discovery, first match wins:** `--config <path>` (error when missing or
  invalid), then `./workspace-mcp.config.json` in the process cwd, then
  `$XDG_CONFIG_HOME/workspace-mcp/config.json` (or `~/.config/...`). A
  discovered file that exists but is invalid is a startup error - a broken
  config must be loud.
- **Validation is strict and hand-written** (`validateConfig`): only known keys
  are accepted anywhere (typos fail loudly), `$schema` is accepted and
  ignored, and a `token` key anywhere is refused because secrets must come from
  `MCP_TOKEN` or `--token`. Workspace paths are resolved to absolute realpaths
  and must exist. Bounds mirror the tool schemas (`shell.timeoutMs` 1000-600000,
  `shell.maxRuntimeMs` 1000-7200000, `transport.port` 1-65535,
  `state.journalMaxBytes` positive).
- **One precedence rule everywhere:** CLI flags > environment variables >
  config file > built-in defaults. `mergeConfig` is pure (no filesystem
  access, no env mutation) so the whole matrix is unit-testable.
- **Workspace merge:** file entries first, then `--workspace name=path`
  overrides same-name entries or appends. `--root` maps to the name `default`
  and overrides a config `default`. Primary is `default` when present, else the
  first entry.
- **Shell merge:** the tools are enabled by any CLI flag, `WORKSPACE_MCP_SHELL=1`
  or config `shell.mode`; mode is CLI > env > file > `"allowlist"`; `allow` is
  the union of built-in defaults, file, env and CLI (all basenames), while
  `deny` only comes from file/env and is checked before the allowlist in both
  modes, so no flag can remove a restriction.
- **Timeouts:** `shell.timeoutMs` and `shell.maxRuntimeMs` become the defaults
  for `run_command`/`start_job` when the per-call argument is omitted; per-call
  arguments still win and keep their existing zod validation.
- **State:** `state.journalMaxBytes` is applied as the default for
  `WORKSPACE_MCP_JOURNAL_MAX_BYTES` only when that env var is unset, so the
  env var wins and `src/state.ts` stays unchanged.

**Why JSON and not TOML/YAML?** JSON is parsed natively by Node with zero new
dependencies, is machine-checkable against a published JSON Schema for editor
autocomplete (`schemas/config.schema.json`), and the existing tooling already
speaks JSON. The tradeoffs are the lack of comments and trailing commas; the
strict unknown-key rejection compensates by making mistakes visible.

## Security architecture

The server runs with the user's OS permissions and is not a sandbox; the root
flag is the intended boundary. The implementation summary:

- Every path argument goes through one containment function: absolute paths
  outside the root are rejected, the root and target are canonicalized with
  `fs.realpath` (nearest existing ancestor for targets that do not exist yet),
  and the result must equal the root or start with `root + path.sep`.
- Command execution has no shell parsing (`spawn` with `shell: false`), an
  allowlist that is an accident guardrail rather than containment, environment
  scrubbing and process-group kills.
- HTTP mode uses a bearer token compared in constant time and returns `401`
  otherwise; it binds to loopback by default.

Full trust model, risks and reporting instructions: [SECURITY.md](SECURITY.md).

## Decision log

| Decision | Rationale | Tradeoff |
| --- | --- | --- |
| **No shell parsing.** Commands are argv arrays executed with `shell: false`. | Pipes, `&&`, redirection, `$VAR` expansion and globs are never interpreted, so user input cannot become shell syntax. | Callers must compose argv arrays explicitly; convenience shell one-liners are not available. |
| **Allowlist is a guardrail, not a sandbox.** Only `path.basename(command[0])` is checked. | Prevents casual or accidental execution of arbitrary binaries. | `node -e`, `npx` and package scripts already execute arbitrary code, so the allowlist does not contain a malicious model. `--shell-any` skips the check entirely. |
| **Files over SQLite.** Journal, notes and changes are JSON lines and JSON files. | Zero runtime dependencies, human-readable, trivially inspectable and backup-able, self-ignoring under git, atomic appends for log streams. | No queries or indexes; reads are linear and must be bounded (last 1 MiB, newest-first limits). |
| **JSON config as a defaults layer.** One optional file fills in workspaces, shell, transport and state defaults. | Node parses JSON natively (zero dependencies), a published JSON Schema gives editors autocomplete, and precedence CLI > env > file > defaults keeps every existing invocation working unchanged. | No comments or trailing commas; strict validation rejects unknown keys and any `token` key, so a typo aborts startup instead of being ignored. |
| **Derived next-action instead of hard gates.** `change_status` suggests the next step from the record. | The workflow stays flexible: documents can be written in any order and the agent is never blocked by a state machine. | Nothing enforces the suggested order; an agent can skip stages and the server will not object. |
| **Process-global job registry.** Jobs live in the server process. | Jobs survive client timeouts, dropped transports and stateless HTTP requests, which is the point of the feature. | Restarting the server kills running jobs; there is no durable queue and no cross-process recovery. |
| **Bounded reads + head/tail truncation.** Journal reads are capped at ~1 MiB, command output above 256 KiB keeps the first and last 32 KiB, `git_diff` keeps first/last 32 KiB of 64 KiB, job logs cap at 64 MiB. | Predictable memory and response sizes; the tail is where failures usually print. | Middle output can be lost; callers must raise limits explicitly when they need more. |
| **Mutex for parallel tool calls.** Change and state read-modify-write operations are serialized per file. | Parallel tool calls from one client cannot interleave and lose updates (fixed in 1.4.1). | Slightly reduces concurrency on state writes. |
| **Realpath containment before every operation.** One implementation in `src/paths.ts`. | Blocks `../` traversal, absolute paths outside the root and symlink escapes for reads and writes. | The check and the subsequent operation are not one atomic step (TOCTOU); see SECURITY.md. |

## Related documents

- [SECURITY.md](SECURITY.md) - trust model, containment details, command-execution risks, exposure guidance.
- [../README.md](../README.md) - install, CLI reference, complete tool reference and limits.
- [../CHANGELOG.md](../CHANGELOG.md) - release history.
