# workspace-mcp

A Model Context Protocol (MCP) server that gives an agent in any MCP-capable chat client a small, safe filesystem toolkit scoped to **one or more named project workspaces**: read, write, edit, patch, grep and list. The point is to remove copy-paste: instead of asking the user to paste file contents into the chat, the agent reads, searches and edits files directly through typed tools with a containment boundary that rejects everything outside the selected workspace root. Since v1.5.0 one server process can serve several projects at once, and every path or state tool takes an optional `workspace` argument.

The tool set is modelled after [opencode](https://opencode.ai)'s built-in tools (`read`, `write`, `edit`, `patch`, `grep`, `glob`), plus an **opt-in** `run_command` tool for tests, linters and builds. Command execution is **off by default** and only registers when you ask for it with `--shell` (allowlist), `--shell-any` (unrestricted) or a [config file](#configuration-file) that sets `shell.mode`.

On top of that, the server keeps a small **workspace-local memory**: an automatic activity journal plus persistent notes (`work_log`, `remember`, `recall`), and read-only `git_status` / `git_diff` tools that work without the shell, so a new chat can recover context on its own.

- Runtime: Node.js >= 22, ESM only
- Transports: stdio (default) and Streamable HTTP at `/mcp`
- Zero runtime dependencies beyond `@modelcontextprotocol/sdk` and `zod`

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) - module map, request flow, state model and design decisions.
- [docs/SECURITY.md](docs/SECURITY.md) - trust model, path containment, command execution and HTTP exposure.
- [CHANGELOG.md](CHANGELOG.md) - release history.

## Requirements

- Node.js 22 or newer
- pnpm (or npm) for building from source

## Install, build, run

```bash
pnpm install
pnpm build

# stdio (default) - what MCP clients launch
node dist/index.js --root /absolute/path/to/project

# Streamable HTTP with bearer token
node dist/index.js --root /absolute/path/to/project --http --port 3333 --token "$MCP_TOKEN"
```

### CLI reference

| Option | Default | Description |
| --- | --- | --- |
| `--root <dir>` | `process.cwd()` | Primary workspace root, registered as the workspace named `default`. Resolved to an absolute, symlink-free path. All tool paths must stay inside the selected workspace. |
| `--workspace <name>=<path>` | | Register an additional named workspace. Repeatable. Names match `^[a-z0-9][a-z0-9_-]*$` and must be unique. Without `--root`, the first one is primary unless one is literally named `default`. A value without `=`, an invalid or duplicate name, or a non-existent path aborts startup. |
| `--config <path>` | discovery | Use an explicit JSON config file (see [Configuration file](#configuration-file)). The file must exist and be valid or the server exits `1`. Without this flag, `./workspace-mcp.config.json` and then the global path are tried. |
| `--http` | off | Serve Streamable HTTP at `/mcp` instead of stdio. |
| `--host <host>` | `127.0.0.1` | HTTP bind host. |
| `--port <n>` | `3333` | HTTP bind port. |
| `--token <t>` | `MCP_TOKEN` env | When set, every HTTP request must send `Authorization: Bearer <t>` or it gets `401`. |
| `--shell` | off | Enable `run_command` and the background job tools (`start_job`, `job_status`, `job_kill`) in allowlist mode (default allowlist: `pnpm`, `npm`, `npx`, `node`). |
| `--shell-any` | off | Enable the same tools in unrestricted mode (any executable). Implies `--shell` and prints a loud warning to stderr. |
| `--shell-allow <list>` | | Add executables to the allowlist. Comma-separated (`git,docker`) and/or repeated. Compared against `path.basename(command[0])`. Only used when the tool is enabled. |
| `-h`, `--help` | | Print usage. |
| `-v`, `--version` | | Print the version. |

Shell environment fallbacks (CLI flags take precedence): `WORKSPACE_MCP_SHELL=1` enables allowlist mode, `WORKSPACE_MCP_SHELL_MODE=allowlist|any` sets the mode (setting it also enables the tool), `WORKSPACE_MCP_SHELL_ALLOW=git,docker` extends the allowlist, `WORKSPACE_MCP_SHELL_DENY=docker` always rejects those executables.

Notes:

- In stdio mode the server **never writes to stdout** (that is the protocol stream). All diagnostics go to stderr.
- `SIGINT`/`SIGTERM` trigger a graceful shutdown (transports and HTTP server are closed).
- If `--http` is used without a token on a non-loopback host, the server prints a loud security warning to stderr.

## Configuration file

Since v1.6.0 one optional JSON file can supply defaults for workspaces, shell execution, transport and state. It is a **defaults layer, never a replacement**, and with no file present the behavior is identical to previous versions. Editor autocomplete is available through [`schemas/config.schema.json`](schemas/config.schema.json).

### Discovery (first match wins)

1. `--config <path>` — explicit. If the file is missing or invalid the server exits `1` with a clear message.
2. `./workspace-mcp.config.json` in the process working directory.
3. `$XDG_CONFIG_HOME/workspace-mcp/config.json`, or `~/.config/workspace-mcp/config.json` when `XDG_CONFIG_HOME` is unset.

A discovered file that exists but is invalid is a **startup error**, never silently ignored: a broken config must be loud. An explicit `--config` path wins even when a cwd or global file also exists.

### Full example

```json
{
  "$schema": "https://raw.githubusercontent.com/MarcoCaamal/workspace-mcp/main/schemas/config.schema.json",
  "workspaces": { "default": "/abs/path", "api": "/abs/other" },
  "shell": {
    "mode": "allowlist",
    "allow": ["pnpm", "npm", "node", "git"],
    "deny": ["docker"],
    "timeoutMs": 300000,
    "maxRuntimeMs": 3600000
  },
  "transport": { "type": "stdio", "host": "127.0.0.1", "port": 3333 },
  "state": { "journalMaxBytes": 10485760 }
}
```

Rules that apply to the whole file:

- `$schema` is accepted and ignored.
- **Unknown keys anywhere are rejected** (typo protection), and a `token` key anywhere is refused with `token must not be stored in the config file; use MCP_TOKEN or --token`. **Secrets never belong in this file.**
- `workspaces` is a map name → path. Names match `^[a-z0-9][a-z0-9_-]*$`; paths are resolved to absolute realpaths and must exist (relative paths resolve against the directory containing the config file). The workspace named `default` is primary when present, otherwise the first key.
- `shell.mode` is `"allowlist"` or `"any"`. **Its presence enables the shell tools**, as if `--shell` was passed.
- `shell.allow` / `shell.deny` are executable names (basenames are extracted; `"/usr/bin/docker"` means `docker`).
- `shell.timeoutMs` (1000–600000) becomes the default `run_command` timeout when the call omits `timeoutMs`; `shell.maxRuntimeMs` (1000–7200000) becomes the default `start_job` max runtime. Per-call arguments still win and are validated against the same caps.
- `transport.type`, `transport.host` and `transport.port` behave exactly like `--http`, `--host` and `--port`; `transport.type: "http"` starts the HTTP server.
- `state.journalMaxBytes` is applied as the default for `WORKSPACE_MCP_JOURNAL_MAX_BYTES`.

### Precedence

The same order applies everywhere: **CLI flags > environment variables > config file > built-in defaults**.

| Setting | CLI | Env | Config | Built-in default |
| --- | --- | --- | --- | --- |
| Workspaces | `--root`, `--workspace` (override same-name / add new) | — | `workspaces` | cwd as `default` |
| Shell on/off | `--shell`, `--shell-any` | `WORKSPACE_MCP_SHELL=1` | `shell.mode` present | off |
| Shell mode | `--shell-any` (any), `--shell` (allowlist) | `WORKSPACE_MCP_SHELL_MODE` | `shell.mode` | `allowlist` |
| Shell allow | `--shell-allow` | `WORKSPACE_MCP_SHELL_ALLOW` | `shell.allow` | `pnpm npm npx node` (union of layers) |
| Shell deny | — | `WORKSPACE_MCP_SHELL_DENY` | `shell.deny` | none |
| `run_command` timeout | `timeoutMs` argument | — | `shell.timeoutMs` | `120000` ms |
| `start_job` runtime | `maxRuntimeMs` argument | — | `shell.maxRuntimeMs` | `1800000` ms |
| Transport | `--http`, `--host`, `--port` | — | `transport.*` | stdio / `127.0.0.1` / `3333` |
| Journal rotation | — | `WORKSPACE_MCP_JOURNAL_MAX_BYTES` | `state.journalMaxBytes` | 5 MiB |
| HTTP bearer token | `--token` | `MCP_TOKEN` | **never** | none |

Notes on the merge:

- **Workspaces merge by name**: config entries come first, then `--workspace name=path` entries override same-name entries or add new ones, so a CLI workspace can extend the file's set without retyping it. `--root` maps to name `default` and overrides any config `default`.
- **Allowlists are a union** of the built-in defaults, config, env and CLI (all reduced to basenames), so `--shell-allow` never narrows anything. To restrict, use `shell.deny`.
- **Deny is a restriction**: it is checked **before** the allowlist in both `allowlist` and `any` mode, and no CLI flag can remove it. A denied command fails with `command denied by configuration: <name>`.
- The HTTP bearer token is deliberately **not** configurable through the file.

## Tools

Every tool that takes a `path`/`cwd` or reads or writes workspace state also accepts an optional `workspace` argument (see [Multiple workspaces](#multiple-workspaces)); it defaults to the primary workspace.

| Tool | Arguments | Behavior |
| --- | --- | --- |
| `read_file` | `path`, `offset?` (1-based, default 1), `limit?` (default/cap 2000) | Returns text with 1-based line numbers as `N: <content>`. Appends `... (truncated at line N of M)` when more lines exist. Rejects binary files. |
| `write_file` | `path`, `content` | Creates parent directories, overwrites existing files. Returns `Created <path> (N bytes)` or `Updated <path> (N bytes)`. |
| `edit_file` | `path`, `oldString`, `newString`, `replaceAll?` (default false) | Exact string replacement. Empty `oldString` is rejected; 0 matches is an error; more than one match without `replaceAll` is an error. Returns the replacement count. |
| `patch` | `edits[]` = `{ path, oldString, newString, replaceAll? }`, min 1 | All-or-nothing: validates every edit against the current (in-memory) file contents first. If any edit fails, **no file is written** and the failing index is reported as `edit[N] failed: <reason>`. |
| `work_log` | `limit?` (default 50, cap 500), `since?` (ISO 8601), `path?`, `change?` (exact change id) | **Read-only.** Newest-first automatic journal of the mutating operations (`write_file`, `edit_file`, `patch`, `run_command`, `start_job`, `job_kill`) plus the change-tracking operations, with timestamp, paths, detail and outcome. Entries written while a change was active carry a `change` tag. Read-only tools are never journaled. Empty: `no activity recorded yet`. |
| `workspace_list` | none | **Read-only.** Lists the configured workspaces: name, absolute root path, `(primary)` marker, whether `<root>/.workspace-mcp` exists, and the active change id when `state.json` exists. |
| `remember` | `text` (min 1), `tags?` (max 20) | Appends a persistent note under `.workspace-mcp/notes.jsonl` and returns `noted (#N total)`. Notes are append-only: nothing in this tool set edits or deletes them. |
| `recall` | `query?` (case-insensitive substring), `tag?` (case-insensitive exact), `limit?` (default 20, cap 100) | **Read-only.** Newest-first notes rendered as `YYYY-MM-DD  [#tag]  text`; no matches reports `no notes match`. |
| `grep` | `pattern` (regex), `path?`, `include?` (glob), `ignoreCase?`, `maxResults?` (default 100, cap 1000) | Returns `relative/path:LINE: <line text>` plus a count summary. Skips binary files and `.git`, `node_modules`, `.cache`, `.workspace-mcp`. Invalid regex is a clear error. |
| `list_files` | `path?`, `pattern?` (glob), `maxDepth?` (default 6, cap 12), `limit?` (default 500, cap 5000) | Sorted workspace-relative entries; directories carry a trailing `/`. Skips binary files, ignored directories and symbolic links. |
| `run_command` | `command` (non-empty argv array), `cwd?`, `timeoutMs?` (default 120000, max 600000) | **Opt-in.** Runs `command[0]` with `command.slice(1)` as arguments and **no shell**, inside the workspace root. Captures stdout+stderr merged, strips ANSI, truncates in the middle above ~256 KiB, and reports `exit code` (or `timed out after Nms`) plus duration. In allowlist mode only the configured executable names can run. |
| `start_job` | `command` (non-empty argv array), `cwd?`, `name?`, `maxRuntimeMs?` (default 1800000, max 7200000) | **Opt-in.** Starts the command detached and returns immediately with a `jobId`, `pid` and log path. stdout+stderr append to a log file and the work survives client timeouts and disconnects. Same allowlist, cwd confinement and no-shell rules as `run_command`. |
| `job_status` | `jobId?`, `tailBytes?` (default 8192, cap 262144) | **Read-only.** With `jobId`: status (`running`, `exited`, `killed`, `timed-out`, `failed-to-start`), exit code, duration, log size and the ANSI-stripped log tail. Without `jobId`: the 20 most recent jobs. Unknown id is a clear error. |
| `job_kill` | `jobId` | Sends `SIGTERM` to the job's whole process group, then `SIGKILL` after a 3 s grace period, and returns the final status. Killing a job that already finished is not an error. |
| `git_status` | `workspace?` | **Read-only, no shell required.** Runs `git status --porcelain=v1 -b` (LC_ALL=C, 10 s timeout) and returns a `branch: ...` header plus the porcelain lines as-is; a clean tree reports `working tree clean`. A non-repository root or a missing git binary is a clear error. |
| `git_diff` | `path?`, `staged?` (`--cached`), `stat?` (`--stat`) | **Read-only, no shell required.** Runs `git diff` (30 s timeout), with `path` resolved through the workspace containment check and passed after `--`. Empty diff reports `(no changes)`; output longer than 64 KiB keeps the first 32 KiB and the last 32 KiB. |
| `change_create` | `title` (min 1), `goal?` | Creates a tracked change: JSON record plus documents directory, id = kebab-case slug of the title (deduped with `-2`, `-3`, ...), and makes it the active change. Journals `change_create`. Returns the id, `.workspace-mcp/changes/<id>/` and the next step. |
| `change_activate` | `changeId` | Makes an existing change active. While active, every journal entry is tagged with its id and the other change tools default to it. Unknown id is a clear error. |
| `change_doc` | `changeId?` (default active), `stage` (`proposal`/`spec`/`design`/`notes`), `content` (min 1), `append?` (default false) | Writes `.workspace-mcp/changes/<id>/<stage>.md`; `append: true` adds the content after a blank line instead of replacing. Touches the change `updatedAt` and returns the relative path plus which stage docs exist. |
| `change_status` | `changeId?`, `all?` | **Read-only.** The single re-orientation call: full view of one change (docs present/missing with byte sizes, tasks grouped by status, constraints, the last 10 tagged journal entries, and a derived suggested next action) or, with `all: true` (or no active change), a newest-first list with done/total task counts and the `(active)` marker. |
| `task_add` | `changeId?`, `text` (min 1), `status?` (`pending`/`in_progress`/`done`/`blocked`, default `pending`) | Appends a task with a sequential id (`T1`, `T2`, ...) and returns the id plus counts. |
| `task_update` | `changeId?`, `updates[]` = `{ taskId, status, note? }`, min 1 | **All-or-nothing:** every task id and status is validated before anything is written; one bad entry changes nothing on disk and the error lists the bad ids. A `note` is appended to the task's notes. Writes one aggregate journal entry. |
| `constraint_add` | `changeId?`, `text` (min 1) | Appends a constraint to the change and returns the count plus the full list. Constraints are shown by `change_status`. |

All tools:

- accept workspace-relative paths (absolute paths inside the root also work) and **reject** anything that resolves outside the root;
- return workspace-relative paths;
- fail with `{ isError: true }` and exactly one short, actionable message - never a stack trace or raw `ENOENT` dump;
- annotate themselves for clients: `readOnlyHint: true` for `read_file`, `grep`, `list_files`, `work_log`, `recall`, `git_status`, `git_diff` and `change_status`; `destructiveHint: true` for `write_file`, `edit_file`, `patch`; `readOnlyHint: false, destructiveHint: true, openWorldHint: true` for the opt-in `run_command`, `start_job` and `job_kill`; `readOnlyHint: true, openWorldHint: false` for `job_status`; and `readOnlyHint: false` for `remember` and the six mutating change tools (`change_create`, `change_activate`, `change_doc`, `task_add`, `task_update`, `constraint_add`) - they append to state under `.workspace-mcp/` and change no workspace data.

Glob syntax (used by `grep.include` and `list_files.pattern`): `**`, `*`, `?`, `{a,b}` and `[abc]` character classes (including `[!abc]`). Patterns without a `/` match the file name at any depth, so `*.ts` matches `src/index.ts`.

## Client configuration

### Claude Desktop (Linux)

Config file: `~/.config/Claude/claude_desktop_config.json` (macOS and Windows use their own platform paths). Restart Claude Desktop after editing.

```json
{
  "mcpServers": {
    "workspace-mcp": {
      "command": "node",
      "args": ["/path/to/workspace-mcp/dist/index.js", "--root", "/path/to/project"]
    }
  }
}
```

### Cursor

Config file: `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (per project).

```json
{
  "mcpServers": {
    "workspace-mcp": {
      "command": "node",
      "args": ["/path/to/workspace-mcp/dist/index.js", "--root", "${workspaceFolder}"]
    }
  }
}
```

### opencode

`opencode.json` (or global `~/.config/opencode/opencode.json`) - local servers use the `mcp` key with `type: "local"`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "workspace-mcp": {
      "type": "local",
      "command": ["node", "/path/to/workspace-mcp/dist/index.js", "--root", "/path/to/project"],
      "enabled": true
    }
  }
}
```

For the HTTP transport, use a remote entry with a header:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "workspace-mcp": {
      "type": "remote",
      "url": "http://127.0.0.1:3333/mcp",
      "oauth": false,
      "headers": { "Authorization": "Bearer ${MCP_TOKEN}" }
    }
  }
}
```

### ChatGPT desktop app

Settings -> **MCP servers** -> **Add server** -> choose **STDIO**, then provide the name plus the command and arguments (`node /path/to/workspace-mcp/dist/index.js --root /path/to/project`), save and restart. The desktop app (and Codex CLI / IDE extension, which share the config in `~/.codex/config.toml`) also supports Streamable HTTP servers and bearer token authentication.

### Remote HTTP clients that support custom headers

Any client that can set headers may connect to the HTTP transport with `Authorization: Bearer <token>`:

```bash
node dist/index.js --root /srv/project --http --host 127.0.0.1 --port 3333 --token "$MCP_TOKEN"

curl -s -X POST http://127.0.0.1:3333/mcp \
  -H "Authorization: Bearer $MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

The endpoint is stateless: every POST creates a fresh server instance, so no session headers are needed. `GET`/`DELETE /mcp` return `405`, and a missing or wrong token returns `401` with `WWW-Authenticate: Bearer`.

### ChatGPT web and other hosted web clients - read this

Hosted web clients (ChatGPT web, claude.ai connectors, and similar) are a different story:

- They require a **publicly reachable HTTPS** Streamable HTTP endpoint. `localhost` is not reachable from them.
- ChatGPT custom connectors authenticate through **OAuth 2.1** (plus its own connector review flow). A static `Authorization: Bearer` header - which is all this server implements in v1 - is **not** an option there.
- Therefore **v1 HTTP mode targets local testing and clients that accept custom headers** (Cursor remote entries, opencode remote entries, Claude Code via `claude mcp add --transport http ... --header "Authorization: Bearer ..."`, API playgrounds, scripts). For ChatGPT web you would need to add an OAuth 2.1 layer around this server, which is out of scope for v1.

If you want to test with a public URL anyway, a tunnel works:

```bash
# WARNING: this publishes full read/write access to the --root directory on the
# public internet. The bearer token is the only thing protecting it. Use a long
# random token, a throwaway root, and shut the tunnel down when you are done.
cloudflared tunnel --url http://127.0.0.1:3333
```

Then point the client at `https://<random>.trycloudflare.com/mcp` with the bearer header.

## Multiple workspaces

Since v1.5.0 one server process can serve several projects at once. Each workspace is a named root with its own state under `<root>/.workspace-mcp/`:

```bash
node dist/index.js --root /path/to/project --workspace api=/path/to/other-project
```

- `--root <dir>` registers the primary workspace named `default`. `--root` alone behaves exactly as before (fully backward compatible).
- `--workspace <name>=<path>` is repeatable and registers another workspace. Names must match `^[a-z0-9][a-z0-9_-]*$`. A missing `=`, an invalid name, a duplicate name (including `--workspace default=...` next to `--root`) or a non-existent path aborts startup with a clear message.
- Workspaces can also be declared in the [config file](#configuration-file) `workspaces` map. CLI entries override same-name config entries and add new ones; `--root` overrides a config `default`.
- With only `--workspace` flags, the first one is primary unless one is literally named `default`. With no flags at all, the current working directory is the single primary workspace named `default`.
- Every path or state tool accepts an optional `workspace` argument, for example `read_file { "path": "src/index.ts", "workspace": "api" }`. Omitting it targets the primary workspace. An unknown name fails with `unknown workspace "X". Available: ...`.
- `workspace_list` (read-only) shows every workspace: name, absolute path, `(primary)` marker, whether `<root>/.workspace-mcp` exists, and the active change id when `state.json` exists.
- **Isolation is per root.** Paths are confined to the selected root, and the journal, notes and change tracking live under the selected root's `.workspace-mcp/`. A `../` escape is rejected relative to the selected workspace even when the same path would be valid in another one.
- **Shell tools follow the selection.** `run_command` and `start_job` resolve `cwd` against the selected workspace, and `git_status` / `git_diff` run `git -C <selected root>`.

### ChatGPT tunnel and Codex examples

Secure MCP Tunnel: `scripts/tunnel.sh` supports `--workspace <name>=<path>` (repeatable); the script regenerates the profile automatically when the configuration changes (reusing the stored `tunnel_id`):

```bash
scripts/tunnel.sh --shell \
  --root /path/to/project \
  --workspace api=/path/to/other-project

# or drive everything from a config file
scripts/tunnel.sh --config /path/to/workspace-mcp.config.json
```

If `--root` is omitted, the first `--workspace` becomes the primary. The script validates that the `--config` file exists before generating the tunnel profile. The profile's `mcp-command` is passed straight to the server, so you can also extend it by hand:

```yaml
# ~/.config/tunnel-client/workspace-mcp.yaml
mcp-command: "node /path/to/workspace-mcp/dist/index.js --root /path/to/project --workspace api=/path/to/other-project"
```

`~/.codex/config.toml` (shared by the ChatGPT desktop app, Codex CLI and IDE extension):

```toml
[mcp_servers.workspace-mcp]
command = "node"
args = [
  "/path/to/workspace-mcp/dist/index.js",
  "--root", "/path/to/project",
  "--workspace", "api=/path/to/other-project",
  "--shell"
]
```

## Security model

**Trust model.** The server runs as a normal child process with **your OS user's permissions**; it is not a sandbox. `--root` is the intended boundary: everything inside it is fair game (including deletion of content through overwrites and edits), everything outside is not reachable through these tools. Run it with an account that has no more filesystem access than you want the agent to have. A malicious or confused model with write access to a workspace can still destroy that workspace - version control and backups remain your safety net.

**Containment.** Every path argument goes through one implementation:

1. Absolute paths outside the root are rejected; relative paths resolve against the root.
2. Both the root and the target are canonicalized with `fs.realpath`. For a target that does not exist yet (a new file), the nearest existing ancestor is realpath-ed and the remaining segments are appended - so a symlinked ancestor that escapes is caught.
3. The final real path must equal the root or start with `root + path.sep`, otherwise the tool fails with `path outside workspace root: <input>`.

This blocks `../../etc/passwd`, absolute paths such as `/etc/passwd`, and symlinks inside the workspace that point outside it (for reads **and** writes).

Other deliberate restrictions:

- **No command execution unless you opt in.** With no `--shell`/`--shell-any` flag, no shell env vars and no config `shell.mode`, `run_command` is not registered and `tools/list` exposes exactly nineteen tools: the six filesystem tools plus `workspace_list`, `work_log`, `remember`, `recall`, `git_status`, `git_diff` and the seven change tools. When enabled, read the dedicated subsection below. A config `shell.deny` list is enforced in every mode.
- Binary files (NUL byte within the first 8 KiB) cannot be read or searched; `list_files` omits them.
- `.git`, `node_modules`, `.cache` and `.workspace-mcp` directories are skipped by `grep` and `list_files`.
- Symbolic links are never followed during directory traversal (prevents loops and escape).
- Tool errors are sanitized: one short sentence, no stack traces, no raw filesystem errors. Full details are logged to stderr only.
- HTTP mode: the bearer token is compared in constant time, and requests without it get `401`. The token never appears in logs.
- Known limitations: path checks and the subsequent file operation are not a single atomic operation (TOCTOU); `patch` writes files one by one after validating all edits, so a disk error mid-write can leave some files updated; there is no rate limiting, audit log or per-tool allowlist; the HTTP transport trusts the network beyond the token (put a TLS-terminating reverse proxy in front for anything non-local).

### Command execution (opt-in)

`run_command` exists so an agent can run tests, linters, builds and commands such as `git status` in the workspace. Be honest about what it is: an allowlist is a guardrail against casual or accidental execution, **NOT a sandbox**.

- **Off by default.** Without `--shell`, `--shell-any`, the `WORKSPACE_MCP_SHELL` env vars or a config `shell.mode`, the tool is not registered at all.
- **No shell parsing.** The command is an argv array executed with `spawn(..., { shell: false })`. Pipes (`|`), `&&`, redirection (`>`), `$VAR` expansion and globs are passed as literal arguments and are never interpreted - that is the whole point.
- **The allowlist is not containment.** In allowlist mode the executable name (`path.basename(command[0])`) must be in the allowlist (`pnpm`, `npm`, `npx`, `node` by default; extend with `--shell-allow`, `WORKSPACE_MCP_SHELL_ALLOW` or config `shell.allow`). But `node -e`, `npx` and package scripts can execute arbitrary code, so every allowlisted entry already implies arbitrary-code execution. `--shell-any` skips the check entirely and prints a loud warning to stderr.
- **Deny always wins.** A config `shell.deny` (or `WORKSPACE_MCP_SHELL_DENY`) list is checked before the allowlist in both modes, and no flag can remove it: the command fails with `command denied by configuration: <name>`.
- **Same OS permissions.** The child runs with your OS user's permissions. `cwd` is confined to the workspace root, but the process itself can reach anything your user can.
- **Environment scrubbing.** `CONTROL_PLANE_API_KEY`, `OPENAI_API_KEY`, `OPENAI_ADMIN_KEY` and `MCP_TOKEN` are removed from the child environment; `NO_COLOR=1` and `FORCE_COLOR=0` are set.
- **Timeouts kill the process group.** Default 120 s (config `shell.timeoutMs` changes the default), max 600 s. On timeout the whole group receives `SIGTERM`, then `SIGKILL` after a 3 s grace period.
- **Output is bounded.** stdout and stderr are merged (best effort, arrival order), ANSI escape codes are stripped, and above 256 KiB only the first 32 KiB and the last 32 KiB are kept - the tail is where test failures print.
- **ChatGPT asks for confirmation per call.** The tool is annotated `readOnlyHint: false`, `destructiveHint: true`, `openWorldHint: true`, so ChatGPT requests approval for every invocation; it cannot be made read-only because it is not.

How to enable:

- Local / ChatGPT desktop (Work) / Codex config (`~/.codex/config.toml`): append `--shell` (allowlist) or `--shell-any` (unrestricted) to the server args, e.g. `args = ["/path/to/workspace-mcp/dist/index.js", "--root", "/path/to/project", "--shell"]`.
- Config file: put `{ "shell": { "mode": "allowlist" } }` in `workspace-mcp.config.json` (or the global path) and start the server with no shell flags. See [Configuration file](#configuration-file).
- ChatGPT chat through Secure MCP Tunnel: `scripts/tunnel.sh --root /path --shell` or `--shell-any`, or point it at a config file with `scripts/tunnel.sh --config /path/to/workspace-mcp.config.json`. The script exports `WORKSPACE_MCP_SHELL=1` / `WORKSPACE_MCP_SHELL_MODE=any` before `exec tunnel-client run`, and the daemon child inherits them.

### Long-running commands (jobs)

`run_command` is synchronous: the client waits for the result. Test suites with testcontainers, docker pulls or server boots can outlive that wait - ChatGPT closes the call on timeout, the result never reaches the conversation, and the work done so far is unreachable even if the OS process is still running. `start_job` exists for exactly that case.

The workflow:

1. `start_job` with the same argv array, `cwd` and allowlist rules as `run_command`, plus an optional `name` label. It returns in milliseconds with a `jobId`, `pid`, `startedAt` and the log file path - it never waits for output.
2. Poll `job_status` with the `jobId`. It is **read-only** (`readOnlyHint: true`), so ChatGPT does not ask for confirmation and polling is cheap. It reports `running` / `exited` / `killed` / `timed-out` / `failed-to-start`, the exit code, duration, log size and the last `tailBytes` of output (ANSI-stripped; default 8 KiB, cap 256 KiB).
3. Call `job_kill` if the job must stop. `SIGTERM` goes to the whole process group, `SIGKILL` follows after 3 seconds. Killing an already finished job is not an error.

Details worth knowing:

- **Jobs survive client disconnects.** The process is spawned detached and the registry is process-global, so a timed-out call, a dropped transport or a fresh server instance in stateless HTTP mode can still read the job with `job_status`. This is the point of the feature.
- **Logs live outside the workspace**, at `$TMPDIR/workspace-mcp-jobs/<jobId>.log` (normally `/tmp/workspace-mcp-jobs/`), or under `$WORKSPACE_MCP_JOB_DIR` when that variable is set. stdout and stderr append there, so they never show up in `list_files` or `grep`.
- **The log is capped at 64 MiB per job.** Past the cap output is discarded; `job_status` then shows `log capped at 64 MiB`.
- **`maxRuntimeMs` bounds the job**: default 30 minutes, minimum 1 second, cap 2 hours. On expiry the process group is killed and the status becomes `timed-out`.
- **Restarting the daemon kills running jobs.** Jobs live in the server process; `SIGINT`/`SIGTERM` (or a stdio stdin close) terminates every running job's process group before exiting, so no orphans are left behind. There is no durable queue.
- **Same guardrails as `run_command`.** Allowlist mode applies before spawning (validation failures are synchronous errors and create no job), the environment is scrubbed, `cwd` is confined to the workspace root, and there is no shell. The child still runs with your OS user's permissions.

## Memory and tracking

The server keeps a small, workspace-local memory so a new chat can recover context without the user re-explaining anything. Every workspace has its own state, and everything lives under the selected workspace's `<workspace-root>/.workspace-mcp/`:

```txt
.workspace-mcp/
  .gitignore       # contains "*", so the directory stays invisible to git
  journal.jsonl    # automatic activity journal (mutating operations)
  journal.1.jsonl  # rotated previous journal, created when the size limit is exceeded
  notes.jsonl      # deliberate notes saved with remember
  notes.1.jsonl    # rotated previous notes
  state.json       # { "activeChange": "<id>" | null }
  changes/
    <id>.json      # change record: title, goal, constraints, tasks
    <id>/          # stage documents written on demand
      proposal.md
      spec.md
      design.md
      notes.md
```

The directory is created lazily on the first write, contains its own `.gitignore` with `*` (the repository's own `.gitignore` is never touched), and is part of the traversal ignore list, so `grep` and `list_files` never see it.

### What is journaled automatically

Every **mutating** tool appends one JSON line (`{ ts, tool, paths?, detail?, result? }`) after it completes, whether it succeeded or failed:

| Tool | `detail` | `result` |
| --- | --- | --- |
| `write_file` | `created N bytes` / `updated N bytes` | `ok` / `error: ...` |
| `edit_file` | `N replacement(s)` | `ok` / `error: ...` |
| `patch` | `N edit(s) across M file(s)` | `ok` / `error: ...` |
| `run_command` | the joined argv | `exit N (Xms)` / `timed out (Xms)` / `error: ...` |
| `start_job` | the joined argv | `started (<jobId>)` / `error: ...` |
| `job_kill` | the job id | final status / `error: ...` |

**What is NOT journaled:** every read-only tool (`read_file`, `grep`, `list_files`, `work_log`, `recall`, `git_status`, `git_diff`) and `job_status`. Journaling is best-effort: a state write failure is logged to stderr and never changes the tool's own result. Appends are serialized per file and written with `fs.appendFile`, which is atomic for small lines, so concurrent tools cannot interleave.

### Session-start and session-end convention

At the start of a session, call `work_log` (what happened recently) and `recall` (notes saved deliberately) to recover context. After finishing a chunk of work, call `remember` with what changed and what should happen next — for example:

```json
{
  "text": "Refactored auth middleware; next: add refresh-token rotation",
  "tags": ["auth", "todo"]
}
```

The server instructions sent to MCP clients carry this convention, so a cooperating model follows it without user prompting.

- `work_log` returns lines like `2026-09-18T07:50:12.000Z  edit_file  src/x.ts  — 2 replacements  [ok]`, newest first, with optional `since` (ISO 8601), `path` (substring on any recorded path) and `limit` (default 50, cap 500) filters. An empty result is `no activity recorded yet`.
- `recall` returns lines like `2026-09-18  [#auth]  Refactored auth middleware...`, newest first, filterable by `query` (case-insensitive substring on the text) and `tag` (case-insensitive exact). No matches reports `no notes match`.

### Rotation and size bounds

Both streams rotate at `WORKSPACE_MCP_JOURNAL_MAX_BYTES` (default 5 MiB): when the current file exceeds the limit it is renamed to `<name>.1.jsonl` (replacing any older `.1`) and a fresh file is started. Reads are bounded too: at most the last 1 MiB of the current file, then the last 1 MiB of the rotated file when more entries are needed; malformed lines are skipped. `detail` and `result` are truncated to 300 characters.

### Read-only git tools

`git_status` and `git_diff` are always registered — they do not need `--shell`. They spawn `git` argv-style (`shell: false`) with `LC_ALL=C` and a scrubbed environment, are annotated `readOnlyHint: true`, and only read the repository (nothing is fetched or written). `git_status` runs `git status --porcelain=v1 -b` with a 10 s timeout; `git_diff` runs `git diff` with a 30 s timeout, optional `--cached`/`--stat`, and a workspace-relative `path` resolved through the containment check and passed after `--`. `git_diff` output is capped at 64 KiB (first 32 KiB + last 32 KiB).

### Changes and tasks (SDD-lite)

A **change** is the unit of work. It is a JSON record at `.workspace-mcp/changes/<id>.json` plus a sibling directory `.workspace-mcp/changes/<id>/` holding stage documents written on demand (`proposal.md`, `spec.md`, `design.md`, `notes.md`). The record shape is:

```json
{
  "id": "my-change",
  "title": "My change",
  "goal": "optional outcome statement",
  "constraints": ["no new runtime dependencies"],
  "tasks": [
    { "id": "T1", "text": "wire the schema", "status": "pending", "notes": [], "createdAt": "...", "updatedAt": "..." }
  ],
  "createdAt": "...",
  "updatedAt": "..."
}
```

`.workspace-mcp/state.json` stores `{ "activeChange": "<id>" | null }`. Change JSON and `state.json` are written atomically (`<file>.tmp` + rename), so readers never observe a partial file and no `.tmp` remains after a successful write. Mutating change tools (`change_create`, `change_activate`, `change_doc`, `task_add`, `task_update`, `constraint_add`) are additionally serialized by an in-process mutex, so parallel tool calls from one client cannot interleave a read-modify-write and lose updates.

**Workflow:** `change_create` (creates the record and documents directory, becomes active) → `change_doc` for the proposal/spec/design documents, in any order and on demand → `task_add` to break the work down → `task_update` to move tasks (`pending` → `in_progress` → `done`, or `blocked`) with optional notes → `constraint_add` for rules the work must respect.

**Re-orient in one call:** `change_status` is read-only, needs no confirmation and never writes state. Without arguments it renders the active change in full; with `all: true` (or when no change is active) it lists every change newest-first with `done/total` task counts and an `(active)` marker. The only read-only change tool is `change_status`; all other change tools are marked `readOnlyHint: false` because they write state under `.workspace-mcp/`.

While a change is active, every journal entry written by a mutating operation is tagged with its id, and `work_log` accepts a `change` filter to scope the log to one change. The full view ends with a **derived suggested next action**, in priority order:

| Situation | Suggestion |
| --- | --- |
| no tasks and no proposal | write the proposal with `change_doc` |
| all tasks done | run the tests and save a summary with `remember` |
| any task `blocked` | unblock `T#` |
| any task `in_progress` | continue `T#` |
| any task `pending` | start `T#` |
| no tasks (but a proposal exists) | break the work into tasks with `task_add` |

The full view also shows each stage document present or missing with its byte size, all tasks grouped by status as `T1 [pending] text`, every constraint, and the last 10 journal entries tagged with the change.

## Limits

| Limit | Value |
| --- | --- |
| `read_file` lines per segment | 2000 (hard cap; `limit` is clamped) |
| `read_file` bytes per segment | ~1 MiB |
| `read_file` characters per rendered line | 2000, with `... (line truncated)` marker |
| File size that can be read or edited | 16 MiB |
| `grep` matches | default 100, cap 1000 |
| `grep` bytes scanned per file | first 1 MiB |
| `list_files` entries | default 500, cap 5000 |
| `list_files` depth | default 6, cap 12 |
| Binary detection window | first 8 KiB |
| Ignored directories | `.git`, `node_modules`, `.cache`, `.workspace-mcp` |
| `run_command` timeout | default 120000 ms (config `shell.timeoutMs` overrides), min 1000 ms, max 600000 ms |
| `run_command` captured output | 256 KiB before collapsing to first 32 KiB + last 32 KiB |
| `run_command` kill grace | 3 s between `SIGTERM` and `SIGKILL` |
| `start_job` max runtime | default 1800000 ms (config `shell.maxRuntimeMs` overrides), min 1000 ms, max 7200000 ms |
| `start_job` log per job | 64 MiB hard cap, then output is discarded and flagged |
| `job_status` tail | default 8192 bytes, cap 262144 bytes |
| `job_status` list without `jobId` | 20 most recent jobs |
| job kill grace | 3 s between `SIGTERM` and `SIGKILL` |
| State rotation | `WORKSPACE_MCP_JOURNAL_MAX_BYTES` per file, default 5 MiB (`journal.jsonl`, `notes.jsonl`) |
| State read bound | last 1 MiB of the current file, then last 1 MiB of `.1` |
| `work_log` entries | default 50, cap 500 |
| `recall` notes | default 20, cap 100 |
| `remember` tags | max 20 tags, 50 characters each |
| Journal `detail`/`result` | truncated to 300 characters |
| `git_status` timeout | 10 s |
| `git_diff` timeout | 30 s |
| `git_diff` output | 64 KiB (first 32 KiB + last 32 KiB) |

## Development

```bash
pnpm build        # tsc -> dist/
pnpm typecheck    # strict typecheck of src and test
pnpm test         # vitest (unit + end-to-end over InMemoryTransport)
pnpm dev          # tsc --watch
```

The test suite uses a real temporary workspace (`fs.mkdtemp`) and a real MCP `Client` over the SDK's `InMemoryTransport`; nothing about the filesystem is mocked. Coverage includes the handshake and tool listing, read/write/edit/patch semantics, all-or-nothing patching, path traversal and symlink escapes, grep include/ignore rules, listing depth and patterns, the glob matcher, opt-in command execution (registration on/off, allowlist rejection and extension, unrestricted mode, non-zero exits, timeouts, cwd confinement, env scrubbing, head+tail truncation and ANSI stripping), background jobs (immediate return, survival across client disconnects, allowlist/cwd rejection without job creation, `tailBytes`, `job_kill` with a dead-pid check, `maxRuntimeMs`, env scrubbing, ANSI stripping and shutdown hygiene), the activity journal and notes (instrumentation for every mutating tool, error entries, filters, persistence across server instances, lazy state creation, self-ignoring git directory, size rotation), the read-only git tools (porcelain status, staged/unstaged/stat/filtered diffs, non-repository and missing-git errors) and change tracking (slug ids and dedupe, atomic records, activation, document replace/append, sequential task ids, all-or-nothing task updates with notes, constraints, the derived suggestions across the lifecycle, journal tagging and the `change` filter, cross-instance persistence, registration counts and no leftover `.tmp` files), plus multi-workspace support (flag parsing, named roots, default resolution, per-workspace isolation and confinement, `workspace_list`, and per-workspace `git`/`run_command`).

## License

[MIT](LICENSE)
