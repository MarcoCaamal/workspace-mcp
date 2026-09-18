# Security

## Trust model

`workspace-mcp` is a normal child process started by your MCP client. It runs
with **the permissions of the OS user that launched it** and is **not a
sandbox**. The `--root` flag is the intended boundary: everything inside the
selected workspace is fair game (including destruction through overwrites and
edits), and anything outside should not be reachable through these tools.

Run the server with an OS account that has no more filesystem access than you
want the agent to have. A malicious or confused model with write access to a
workspace can still destroy that workspace; version control and backups remain
the safety net.

## Path containment

Every path argument - `path`, `cwd`, `git_diff.path` - goes through a single
implementation (`src/paths.ts`):

1. Absolute paths outside the root are rejected; relative paths resolve against
   the selected workspace root.
2. The root and the target are canonicalized with `fs.realpath`. For a target
   that does not exist yet (a new file), the nearest existing ancestor is
   realpath-ed and the remaining segments are appended, so a symlinked ancestor
   that escapes is caught.
3. The final real path must equal the root or start with `root + path.sep`, or
   the tool fails with `path outside workspace root: <input>`.

This blocks `../../etc/passwd`, absolute paths such as `/etc/passwd`, and
symlinks inside the workspace that point outside it - for reads **and** writes.
Directory traversal never follows symbolic links, and containment is evaluated
against the selected workspace, so switching workspaces never widens the
boundary.

The check and the subsequent file operation are **not a single atomic
operation** (TOCTOU). A process with concurrent write access to the workspace
could replace a path between the check and the operation. This is a documented
limitation, not a sandbox guarantee.

## Command execution (opt-in)

`run_command`, `start_job`, `job_status` and `job_kill` are only registered when
you ask for them with `--shell` (allowlist), `--shell-any` (unrestricted) or the
`WORKSPACE_MCP_SHELL` / `WORKSPACE_MCP_SHELL_MODE` environment variables.

**The allowlist is not a sandbox.** It only checks
`path.basename(command[0])` against a list (`pnpm`, `npm`, `npx`, `node` by
default). Every entry on that list can already execute arbitrary code:

- `node -e "..."` runs any JavaScript with the process's permissions.
- `npx <package>` downloads and runs arbitrary packages.
- Package scripts (`pnpm test`, npm lifecycle hooks) execute repository-defined
  code.

So the allowlist is a guardrail against casual or accidental execution, nothing
more. `--shell-any` skips even that check and prints a loud warning to stderr.
The child process runs with your OS user's permissions and, although its `cwd`
is confined to the workspace, the process itself can reach anything your user
can.

What is enforced:

- **No shell parsing.** Commands are argv arrays executed with
  `spawn(..., { shell: false })`. Pipes, `&&`, redirection, `$VAR` expansion and
  globs are passed as literal arguments and are never interpreted.
- **Timeouts and kills target the whole process group.** `SIGTERM` first, then
  `SIGKILL` after a 3-second grace period.
- **Environment scrubbing.** `CONTROL_PLANE_API_KEY`, `OPENAI_API_KEY`,
  `OPENAI_ADMIN_KEY` and `MCP_TOKEN` are removed from the child environment;
  `NO_COLOR=1` and `FORCE_COLOR=0` are set.
- **Output caps.** Command output is ANSI-stripped and truncated (first and last
  32 KiB above 256 KiB); job logs are capped at 64 MiB.
- **Annotations.** The tools are marked `readOnlyHint: false`,
  `destructiveHint: true`, `openWorldHint: true`, so compliant clients ask for
  approval on every call.

**Prompt injection.** This server exists so a model can read untrusted content
(repository files, test output, logs) and act on it. Any of that content can
contain instructions aimed at the model. The containment boundary limits where
those instructions can point, but it does not limit what an allowlisted command
can do once it runs. Treat the client's per-call confirmation for shell tools as
the last line of defense, and keep it enabled.

## HTTP and tunnel exposure

- **stdio is the default transport** and keeps the server on the client's
  stdin/stdout; nothing listens on the network.
- **HTTP mode** (`--http`) serves Streamable HTTP at `/mcp`, binds to
  `127.0.0.1` by default, and - when a token is configured - compares it in
  constant time and returns `401` with `WWW-Authenticate: Bearer` otherwise. The
  token never appears in logs.
- **Non-loopback binding without a token** prints a loud security warning to
  stderr. Do not ignore it.
- **Public tunnels.** Publishing the port with a tool such as `cloudflared`
  exposes full read/write access to the root directory on the public internet.
  The bearer token is the only protection. Use a long random token, point the
  server at a throwaway root, and shut the tunnel down when you are done.
- The HTTP transport trusts the network beyond the token; put a
  TLS-terminating reverse proxy in front of anything that is not strictly
  local.

## Secrets handling

- The tunnel helper script stores the OpenAI API key in
  `~/.config/tunnel-client/api-key` only if you accept the prompt, and creates it
  with `chmod 600` (`umask 077`). Delete the file to be asked again.
- Environment variables that commonly hold credentials
  (`CONTROL_PLANE_API_KEY`, `OPENAI_API_KEY`, `OPENAI_ADMIN_KEY`, `MCP_TOKEN`)
  are removed from child processes spawned by `run_command` and `start_job`.
- The HTTP bearer token is read from the CLI flag or `MCP_TOKEN` and is never
  written to the journal or logs.
- The journal records commands and paths (argv joined for shell tools), so do
  not pass secrets as command-line arguments where the workspace journal can
  capture them.

## Known limitations

- TOCTOU between the containment check and the file operation (see above).
- `patch` validates all edits before writing, but writes files one by one; a
  disk error mid-write can leave some files updated.
- There is no rate limiting, no audit log beyond the workspace journal, and no
  per-tool permission model.
- Job logs are written to the system temporary directory by default and are
  readable by the same user; set `WORKSPACE_MCP_JOB_DIR` to a private location
  if that matters.

## Reporting vulnerabilities

Please report security issues privately through GitHub's private vulnerability
reporting on this repository:

<https://github.com/MarcoCaamal/workspace-mcp/security/advisories/new>

Do not open a public issue for a security problem. Include reproduction steps,
the affected version, and any relevant configuration. You will get an
acknowledgement as soon as possible.
