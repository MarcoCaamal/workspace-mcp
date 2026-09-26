#!/usr/bin/env bash
# tunnel.sh - expose workspace-mcp to ChatGPT chat via OpenAI Secure MCP Tunnel.
#
# Prompts for your OpenAI API key (hidden input) and, when needed, your
# tunnel_id from:
#   https://platform.openai.com/settings/organization/tunnels
#
# The key can be saved once to ~/.config/tunnel-client/api-key (chmod 600);
# after that this script never asks for it again.
#
# Usage: scripts/tunnel.sh [--root PATH] [--workspace NAME=PATH] [--config PATH] [--preset chatgpt] [--name NAME] [--ui-port N] [--reinit] [--shell|--shell-any]
#   --root PATH       Primary workspace root (required unless --workspace or --config is given,
#                     or a global config exists at ~/.config/workspace-mcp/config.json)
#   --workspace N=P   Extra named workspace served by the SAME server (repeatable).
#                     If --root is omitted, the first --workspace becomes the primary.
#                     Example: --workspace api=/path/to/other-project
#   --config PATH     JSON config file passed through as --config PATH. Supplies
#                     workspace, shell, transport and state defaults; CLI flags win.
#   --preset chatgpt  Pinned ChatGPT first-run preset: exactly one primary workspace
#                     (a single --root, one --workspace, or --config). Shell stays
#                     DISABLED unless --shell/--shell-any is passed explicitly, and
#                     the tunnel_id remains transport routing only, never identity.
#   --name NAME       Optional second daemon profile (workspace-mcp-NAME, own UI port).
#                     Not needed for multiple workspaces - use --workspace instead.
#   --ui-port N       Local status UI port (default: 8080 without --name, auto-picked otherwise)
#   --reinit          Recreate the tunnel-client profile even if it already exists
#   --preset chatgpt  Pinned ChatGPT first-run preset (single primary workspace;
#                     shell stays disabled unless --shell/--shell-any is passed)
#   --shell           Enable run_command in allowlist mode (WORKSPACE_MCP_SHELL=1)
#   --shell-any       Enable run_command unrestricted (WORKSPACE_MCP_SHELL_MODE=any)
#
# Env overrides: WORKSPACE_MCP_NODE (absolute path to node; defaults to the one
# in PATH) and WORKSPACE_MCP_SERVER (absolute path to dist/index.js; defaults to
# ../dist/index.js relative to this script).
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
NODE="${WORKSPACE_MCP_NODE:-$(command -v node || true)}"
SERVER="${WORKSPACE_MCP_SERVER:-$SCRIPT_DIR/../dist/index.js}"
KEY_FILE="$HOME/.config/tunnel-client/api-key"

usage() {
  cat <<'EOF'
Usage: tunnel.sh [--root PATH] [--workspace NAME=PATH] [--config PATH] [--name NAME] [--ui-port N] [--reinit] [--shell|--shell-any]

  --root PATH       Primary workspace root (required unless --workspace or --config is given,
                    or a global config exists at ~/.config/workspace-mcp/config.json)
  --workspace N=P   Extra named workspace served by the SAME server (repeatable).
                    If --root is omitted, the first --workspace becomes the primary.
                    Each workspace keeps its own journal/changes state.
  --config PATH     JSON config file passed through as --config PATH. Supplies
                    workspace, shell, transport and state defaults; CLI flags win.
                    The file must exist.
  --name NAME       Optional second daemon profile (workspace-mcp-NAME, own UI port).
                    Not needed for multiple workspaces - use --workspace instead.
  --ui-port N       Local status UI port (default 8080; auto-picked per --name)
  --reinit          Recreate the tunnel-client profile even if it already exists
  --shell           Enable run_command in allowlist mode (exports WORKSPACE_MCP_SHELL=1)
  --shell-any       Enable run_command in unrestricted mode (any executable; exports
                    WORKSPACE_MCP_SHELL=1 and WORKSPACE_MCP_SHELL_MODE=any)

Asks for your OpenAI API key the first time and offers to save it to
~/.config/tunnel-client/api-key (chmod 600). Delete that file to be asked
again. On first run it also asks for your tunnel_id.

node is resolved from PATH; set WORKSPACE_MCP_NODE to override it. The server
bundle defaults to ../dist/index.js relative to this script; set
WORKSPACE_MCP_SERVER to override it.
EOF
}

ROOT=""
ROOT_EXPLICIT=0
WORKSPACES=()
CONFIG_FILE=""
PRESET=""
NAME=""
UI_PORT=""
REINIT=0
SHELL_MODE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --root)
      [[ $# -ge 2 ]] || { echo "ERROR: --root needs a value" >&2; exit 2; }
      ROOT="$2"; ROOT_EXPLICIT=1; shift 2 ;;
    --workspace)
      [[ $# -ge 2 ]] || { echo "ERROR: --workspace needs a value (<name>=<path>)" >&2; exit 2; }
      WORKSPACES+=("$2"); shift 2 ;;
    --config)
      [[ $# -ge 2 ]] || { echo "ERROR: --config needs a value (path to a JSON config file)" >&2; exit 2; }
      CONFIG_FILE="$2"; shift 2 ;;
    --preset)
      [[ $# -ge 2 ]] || { echo "ERROR: --preset needs a value (only 'chatgpt' exists)" >&2; exit 2; }
      PRESET="$2"; shift 2 ;;
    --name)
      [[ $# -ge 2 ]] || { echo "ERROR: --name needs a value" >&2; exit 2; }
      NAME="$2"; shift 2 ;;
    --ui-port)
      [[ $# -ge 2 ]] || { echo "ERROR: --ui-port needs a value" >&2; exit 2; }
      UI_PORT="$2"; shift 2 ;;
    --reinit) REINIT=1; shift ;;
    --shell) SHELL_MODE="allowlist"; shift ;;
    --shell-any) SHELL_MODE="any"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ERROR: unknown option '$1' (use --help)" >&2; exit 2 ;;
  esac
done

# Workspace validation (name=path, lowercase name).
for w in "${WORKSPACES[@]}"; do
  if [[ ! "$w" =~ ^[a-z0-9][a-z0-9_-]*= ]]; then
    echo "ERROR: --workspace must be <name>=<path> with a lowercase name (e.g. api=/path/to/repo): $w" >&2
    exit 2
  fi
done

# ChatGPT first-run preset: exactly one primary workspace, shell disabled by
# default (explicit opt-in only), tunnel_id never treated as identity.
if [[ -n "$PRESET" && "$PRESET" != "chatgpt" ]]; then
  echo "ERROR: unknown preset '$PRESET' (only --preset chatgpt exists)" >&2
  exit 2
fi
if [[ "$PRESET" == "chatgpt" && ${#WORKSPACES[@]} -gt 1 ]]; then
  echo "ERROR: --preset chatgpt accepts exactly one workspace: pass a single --root, one --workspace, or --config" >&2
  exit 2
fi

if [[ $ROOT_EXPLICIT -eq 0 && ${#WORKSPACES[@]} -gt 0 ]]; then
  ROOT=""            # server: the first --workspace becomes the primary
elif [[ "$PRESET" == "chatgpt" ]]; then
  echo "ERROR: --preset chatgpt needs a primary workspace: pass --root <path>, one --workspace <name>=<path>, or --config <path>" >&2
  exit 2
elif [[ $ROOT_EXPLICIT -eq 0 && -z "$CONFIG_FILE" ]]; then
  GLOBAL_CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/workspace-mcp/config.json"
  if [[ -f "$GLOBAL_CONFIG" ]]; then
    CONFIG_FILE="$GLOBAL_CONFIG"
    echo "Using global config: $CONFIG_FILE"
  else
    echo "ERROR: pass --root <path>, --workspace <name>=<path> or --config <path>" >&2
    exit 2
  fi
fi

# Exact mcp-command for this configuration (also used to detect profile drift).
# tunnel-client parses this string into argv (it does not run a shell). Leave
# simple arguments unchanged; quote and escape only those needing protection.
command_arg() {
  local arg="$1"
  if [[ "$arg" == *[[:space:]]* || "$arg" == *"'"* || "$arg" == *\"* || "$arg" == *\\* ]]; then
    arg="${arg//\\/\\\\}"
    arg="${arg//\"/\\\"}"
    printf '"%s"' "$arg"
  else
    printf '%s' "$arg"
  fi
}
MCP_CMD="$(command_arg "$NODE") $(command_arg "$SERVER")"
if [[ -n "$ROOT" ]]; then
  MCP_CMD+=" --root $(command_arg "$ROOT")"
fi
for w in "${WORKSPACES[@]}"; do
  MCP_CMD+=" --workspace $(command_arg "$w")"
done
if [[ -n "$CONFIG_FILE" ]]; then
  MCP_CMD+=" --config $(command_arg "$CONFIG_FILE")"
fi
# The existing profile reader captures the inside of a YAML double-quoted
# scalar, so compare against its escaped representation rather than raw argv.
PROFILE_CMD="${MCP_CMD//\\/\\\\}"
PROFILE_CMD="${PROFILE_CMD//\"/\\\"}"

if [[ -n "$NAME" && ! "$NAME" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo "ERROR: --name must be lowercase letters, numbers and dashes (e.g. dev)" >&2
  exit 2
fi
if [[ -n "$UI_PORT" && ! "$UI_PORT" =~ ^[0-9]+$ ]]; then
  echo "ERROR: --ui-port must be a number" >&2; exit 2
fi
if [[ -n "$UI_PORT" ]] && (( UI_PORT < 1024 || UI_PORT > 65535 )); then
  echo "ERROR: --ui-port must be between 1024 and 65535" >&2; exit 2
fi

PROFILE="workspace-mcp"
if [[ -n "$NAME" ]]; then
  PROFILE="workspace-mcp-$NAME"
fi
PROFILE_FILE="$HOME/.config/tunnel-client/${PROFILE}.yaml"

# Stable per-profile UI port: 8081-8179 derived from the name, bumped while busy.
find_free_port() {
  local port="$1" i=0
  if ! command -v ss >/dev/null 2>&1; then
    printf '%s' "$port"; return 0
  fi
  while [[ $i -lt 100 && -n "$(ss -tlnH "sport = :$port" 2>/dev/null)" ]]; do
    port=$((port + 1)); i=$((i + 1))
  done
  printf '%s' "$port"
}
if [[ -z "$UI_PORT" ]]; then
  if [[ -z "$NAME" ]]; then
    UI_PORT=8080
  else
    UI_PORT=$(( 8081 + $(printf '%s' "$NAME" | cksum | cut -d' ' -f1) % 99 ))
  fi
fi
UI_PORT="$(find_free_port "$UI_PORT")"

# --- sanity checks -----------------------------------------------------------
command -v tunnel-client >/dev/null 2>&1 || {
  echo "ERROR: tunnel-client not found in PATH" >&2; exit 1; }
if [[ -z "$NODE" || ! -x "$NODE" ]]; then
  echo "ERROR: node not found in PATH; set WORKSPACE_MCP_NODE to an absolute path" >&2
  exit 1
fi
[[ -f "$SERVER" ]] || {
  echo "ERROR: $SERVER is missing. Run 'pnpm build' in the repository root first." >&2
  exit 1; }
if [[ -n "$CONFIG_FILE" ]]; then
  [[ -f "$CONFIG_FILE" ]] || { echo "ERROR: config file does not exist: $CONFIG_FILE" >&2; exit 1; }
fi
if [[ -n "$ROOT" ]]; then
  [[ -d "$ROOT" ]] || { echo "ERROR: workspace root does not exist: $ROOT" >&2; exit 1; }
fi
for w in "${WORKSPACES[@]}"; do
  ws_path="${w#*=}"
  [[ -d "$ws_path" ]] || { echo "ERROR: workspace path does not exist: $ws_path" >&2; exit 1; }
done

# --- 1. API key: env var -> saved file -> prompt (+ optional save) -----------
if [[ -z "${CONTROL_PLANE_API_KEY:-}" && -f "$KEY_FILE" ]]; then
  CONTROL_PLANE_API_KEY="$(< "$KEY_FILE")"
fi
if [[ -z "${CONTROL_PLANE_API_KEY:-}" ]]; then
  read -rsp "Paste your OpenAI API key (hidden): " CONTROL_PLANE_API_KEY || true
  echo
  SAVE_KEY=""
  read -rp "Save it to $KEY_FILE (chmod 600) for next runs? [y/N] " SAVE_KEY || true
  if [[ "$SAVE_KEY" =~ ^[Yy] ]]; then
    umask 077
    mkdir -p "$(dirname "$KEY_FILE")"
    printf '%s\n' "$CONTROL_PLANE_API_KEY" > "$KEY_FILE"
    echo "Saved: $KEY_FILE (delete it anytime to be asked again)"
  fi
fi
[[ -n "${CONTROL_PLANE_API_KEY:-}" ]] || { echo "ERROR: empty API key" >&2; exit 1; }
export CONTROL_PLANE_API_KEY

# --- 2. tunnel-client profile ------------------------------------------------
CURRENT_CMD=""
if [[ -f "$PROFILE_FILE" ]]; then
  CURRENT_CMD="$(sed -n 's/^[[:space:]]*command:[[:space:]]*"\(.*\)"[[:space:]]*$/\1/p' "$PROFILE_FILE" | head -n1)"
fi
if [[ -f "$PROFILE_FILE" && $REINIT -eq 0 && -n "$CURRENT_CMD" && "$CURRENT_CMD" == "$PROFILE_CMD" ]]; then
  echo "Profile '$PROFILE' already exists and matches this configuration."
else
  TUNNEL_ID=""
  if [[ -f "$PROFILE_FILE" ]]; then
    TUNNEL_ID="$(sed -n 's/.*tunnel_id:[[:space:]]*"\([^"]*\)".*/\1/p' "$PROFILE_FILE" | head -n1)"
  fi
  if [[ -z "$TUNNEL_ID" ]]; then
    read -rp "Paste your tunnel_id (tunnel_...): " TUNNEL_ID || true
  else
    echo "Reusing tunnel_id from existing profile: $TUNNEL_ID"
  fi
  [[ -n "$TUNNEL_ID" ]] || { echo "ERROR: empty tunnel_id" >&2; exit 1; }

  rm -f "$PROFILE_FILE"
  echo "Creating tunnel-client profile '$PROFILE'"
  tunnel-client init --sample sample_mcp_stdio_local --profile "$PROFILE" \
    --tunnel-id "$TUNNEL_ID" \
    --mcp-command "$MCP_CMD"
fi

# Keep the profile's health listener in sync with the chosen UI port so doctor
# and run agree (required to run several daemons side by side).
sed -i -E "s/^([[:space:]]*listen_addr:[[:space:]]*)\"[^\"]*\"/\1\"127.0.0.1:${UI_PORT}\"/" "$PROFILE_FILE"

# --- 3. validate and run -----------------------------------------------------
tunnel-client doctor --profile "$PROFILE" --explain

# --- 4. optional run_command ---------------------------------------------
# Exported here so the daemon (and the stdio server it launches) inherit them.
if [[ "$SHELL_MODE" == "any" ]]; then
  export WORKSPACE_MCP_SHELL=1
  export WORKSPACE_MCP_SHELL_MODE=any
  echo "WARNING: run_command enabled in UNRESTRICTED mode (--shell-any): any executable can run with your OS user's permissions." >&2
elif [[ "$SHELL_MODE" == "allowlist" ]]; then
  export WORKSPACE_MCP_SHELL=1
  echo "run_command enabled in allowlist mode (default allowlist; extend with WORKSPACE_MCP_SHELL_ALLOW)."
fi

echo
echo "Starting tunnel daemon [$PROFILE]"
if [[ "$PRESET" == "chatgpt" ]]; then
  echo "Preset: chatgpt single-workspace first run (tunnel_id is transport routing only, never session identity)."
  if [[ -z "$SHELL_MODE" ]]; then
    echo "run_command stays DISABLED (default). Pass --shell to opt in explicitly."
  fi
fi
if [[ -n "$ROOT" ]]; then
  echo "  primary root: $ROOT"
fi
if [[ -n "$CONFIG_FILE" ]]; then
  echo "  config file: $CONFIG_FILE"
fi
for w in "${WORKSPACES[@]}"; do
  echo "  workspace: $w"
done
echo "Local status UI: http://127.0.0.1:$UI_PORT/ui   (Ctrl+C to stop)"
exec tunnel-client run --profile "$PROFILE" --health.listen-addr "127.0.0.1:$UI_PORT"
