# Typort

Tauri-based local Markdown editor for remote files. Run `typort open file.md` on a remote SSH server, and the file opens in a native editor on your local laptop, with safe atomic save-back through an SSH reverse tunnel.

```text
remote shell  ──► typort open file.md
                       │ (SSH reverse tunnel: -R 17887:127.0.0.1:17887)
                       ▼
local laptop  ──► Typort Desktop (Tauri) ──► native editor window (typora-web)
                                              │
                                              └─► atomic save back to remote path
```

## Repo layout

```text
apps/
  desktop/          # Tauri v2 desktop app (Rust backend + Vite/React frontend)
packages/
  protocol/         # Shared zod schemas + TS types for the JSON wire protocol
  file-session/     # Hash + atomic write helpers for the remote agent
  cli/              # `typort` remote CLI / agent
  editor-adapter/   # Thin wrapper around typora-web (used by the frontend)
```

## Quick start (dev, same machine)

```bash
# 1. install deps + build packages
pnpm install
pnpm build

# 2. run the desktop app (in one terminal)
pnpm tauri:dev

# 3. open a Markdown file (in another terminal)
echo "# scratch\n\nhello" > /tmp/scratch.md
pnpm cli -- open /tmp/scratch.md
```

The desktop app exposes a hub on `127.0.0.1:17887`. The CLI connects to it, sends the file content, and the desktop app opens an editor window with the file loaded.

## Quick start (over SSH)

The remote only needs **Node ≥18**. No `pnpm`, no `npm install`, no toolchain — `bin/typort` is a single-file bundled executable that's checked into the repo.

```bash
# === one-time: get the CLI on the remote ===
ssh user@server
git clone https://github.com/zhuconv/Typort.git ~/typort
ln -s ~/typort/bin/typort ~/.local/bin/typort   # or any dir on $PATH
exit

# === per-session ===
# 1. on local laptop: keep Typort Desktop running
pnpm tauri:dev

# 2. local terminal: open SSH reverse tunnel
ssh -R 17887:127.0.0.1:17887 user@server

# 3. on remote server: open the file
export TYPORT_TOKEN=<copy-from-Typort-status-window>
typort doctor                     # sanity-check tunnel + token
typort open /remote/path/notes.md
```

When the CLI source changes, the bundle is regenerated locally with `pnpm bundle:cli`; check in the updated `bin/typort` and `git pull` on the remote.

## Editor

The frontend uses [`typora-web`](https://github.com/Yuyz0112/typora-web) (the editor core that the plan refers to as `open-typora`).

## Status

This is an MVP implementation of [milestones 0–3 of the plan](./plan.md). See `plan.md` for the full design.

## Scripts

```bash
pnpm install              # install all workspace deps
pnpm build                # build TS packages (protocol, file-session, cli, editor-adapter)
pnpm test                 # run unit tests (protocol + file-session + cli integration)
pnpm typecheck            # tsc --noEmit on each package
pnpm tauri:dev            # run desktop app in dev mode
pnpm tauri:build          # build production desktop app
pnpm cli -- open file.md  # run CLI from the workspace
pnpm bundle:cli           # produce dist/typort.bundle.cjs (single file, scp to remote)
```
