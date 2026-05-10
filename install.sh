#!/usr/bin/env bash
#
# Typort remote-agent installer.
#
#   curl -fsSL https://raw.githubusercontent.com/zhuconv/Typort/main/install.sh | bash
#
# Downloads the prebuilt CLI bundle from GitHub and symlinks it onto your
# $PATH. Idempotent: re-run to update.
#
# Honored env vars:
#   TYPORT_REF        git ref to install from   (default: main)
#   TYPORT_HOME       where bundle files live   (default: $HOME/.typort)
#   TYPORT_BIN_DIR    where the symlink lives   (default: $HOME/.local/bin)
#
set -euo pipefail

REPO="zhuconv/Typort"
REF="${TYPORT_REF:-main}"
TYPORT_HOME="${TYPORT_HOME:-$HOME/.typort}"
BIN_DIR="${TYPORT_BIN_DIR:-$HOME/.local/bin}"
RAW_URL="https://raw.githubusercontent.com/$REPO/$REF"

red()    { printf '\033[31m%s\033[0m' "$*"; }
green()  { printf '\033[32m%s\033[0m' "$*"; }
yellow() { printf '\033[33m%s\033[0m' "$*"; }
cyan()   { printf '\033[36m%s\033[0m' "$*"; }

err()  { printf '%s %s\n' "$(red error:)" "$*" >&2; exit 1; }
ok()   { printf '%s %s\n' "$(green '✓')" "$*"; }
note() { printf '%s %s\n' "$(yellow note:)" "$*"; }

# --- 1. require node ≥ 18 ----------------------------------------------------
command -v node >/dev/null || err "node not found in PATH. Install Node ≥18 first."

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
[ "$NODE_MAJOR" -ge 18 ] || err "Node $NODE_MAJOR is too old (need ≥18)."

# --- 2. download bundle + sibling package.json --------------------------------
fetch() {
  local url="$1" dest="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$dest"
  elif command -v wget >/dev/null 2>&1; then
    wget -q "$url" -O "$dest"
  else
    err "need curl or wget"
  fi
}

mkdir -p "$TYPORT_HOME/bin"

# tmp + atomic rename: never leave a half-written binary on $PATH
TMP_BIN=$(mktemp "$TYPORT_HOME/bin/typort.tmp.XXXXXX")
TMP_PJ=$(mktemp "$TYPORT_HOME/bin/package.json.tmp.XXXXXX")
trap 'rm -f "$TMP_BIN" "$TMP_PJ"' EXIT

fetch "$RAW_URL/bin/typort"       "$TMP_BIN"
fetch "$RAW_URL/bin/package.json" "$TMP_PJ"

# sanity: must start with shebang
head -c 20 "$TMP_BIN" | grep -q '^#!/usr/bin/env' \
  || err "downloaded bin/typort doesn't look like a Node script (HTTP error?)"

chmod +x "$TMP_BIN"
mv "$TMP_BIN" "$TYPORT_HOME/bin/typort"
mv "$TMP_PJ"  "$TYPORT_HOME/bin/package.json"
trap - EXIT

# --- 3. symlink into $PATH ----------------------------------------------------
mkdir -p "$BIN_DIR"
ln -sfn "$TYPORT_HOME/bin/typort" "$BIN_DIR/typort"

ok "installed $TYPORT_HOME/bin/typort"
ok "symlink   $BIN_DIR/typort"

# --- 4. verify ---------------------------------------------------------------
"$BIN_DIR/typort" --version

# --- 5. tell the user how to finish setup ------------------------------------
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    echo
    note "$BIN_DIR is not on \$PATH. Add to your shell rc:"
    printf '    %s\n' "$(cyan "export PATH=\"$BIN_DIR:\$PATH\"")"
    ;;
esac

cat <<'EOM'

Next steps:
  1. On your local laptop, copy the token from Typort Desktop's Welcome window.
  2. On this remote (and add to ~/.bashrc to persist):
       export TYPORT_TOKEN=<paste>
  3. From your local terminal, open the SSH reverse tunnel:
       ssh -R 17887:127.0.0.1:17887 user@server
  4. Verify and open a file:
       typort doctor
       typort open /path/to/notes.md
EOM
