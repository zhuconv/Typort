# Typort

Open a remote Markdown file from an SSH shell and edit it natively on your local machine. Saves go back to the original remote path, atomically and hash-checked.

```text
remote shell  ─►  typort open file.md
                       │  (SSH reverse tunnel: -R 17887:127.0.0.1:17887)
                       ▼
local laptop  ─►  Typort Desktop (Tauri)  ─►  native editor (typora-web)
                                                      │
                                                      ▼
                                             atomic save back to remote
```

## Layout

```text
apps/desktop/        Tauri v2 app (Rust hub + Vite/React frontend)
packages/protocol/   zod schemas for the WS wire protocol
packages/file-session/  hash + atomic write + polling watcher (used by the agent)
packages/cli/        `typort` CLI / agent
bin/typort           pre-built single-file CLI bundle (committed; ~265 KB)
```

## Quick start (over SSH)

The remote only needs **Node ≥18**. No `pnpm`, no `npm install`, no clone.

```bash
# === one-time, on the remote ===
curl -fsSL https://raw.githubusercontent.com/zhuconv/Typort/main/install.sh | bash

# === per-session ===
# 1. local: keep Typort Desktop running (token visible in its Welcome window)
pnpm install && pnpm tauri:dev

# 2. local: open the SSH reverse tunnel
ssh -R 17887:127.0.0.1:17887 user@server

# 3. remote
export TYPORT_TOKEN=<paste-from-Welcome-window>   # add to ~/.bashrc to persist
typort doctor                                     # expect "Hub reachable: yes"
typort open /home/user/notes.md
```

`install.sh` downloads `bin/typort` into `~/.typort/bin/` and symlinks it to `~/.local/bin/typort`. Re-run it to update. The TYPORT_TOKEN above is generated once by Typort Desktop and persists at `~/Library/Application Support/dev.typort.desktop/config.json`.

## App lifecycle on macOS

Typort Desktop runs as a menu-bar/accessory app: **no Dock icon while idle**. The Dock icon appears only when at least one editor session is open (`typort open …` from a remote), and disappears when the last session window closes.

- Closing the Welcome window with the red ✕ **hides** it; the hub keeps running so remote `typort open` still works.
- Subsequent `pnpm tauri:dev` (or `open Typort.app` in production) brings the Welcome window back via single-instance handoff — no second daemon is started.
- Cmd+Q quits for real.

## Conflict handling

When the remote file changes between open and save, the editor refuses silent overwrite and shows three options:

- **Reload remote** — discard local edits, load the new remote version
- **Keep mine as `.conflict.md`** — atomically write your draft to a sibling `<file>.typort-conflict-<ts>.md` next to the original; reload the remote into the editor
- **Edit & merge** — open a textarea pre-filled with `<<<<<<<` / `=======` / `>>>>>>>` markers; Save is gated on all markers being removed

## Scripts

```bash
pnpm install         # install workspace deps
pnpm build           # tsc all packages
pnpm test            # 53 unit tests (protocol, file-session, cli, diff)
pnpm test:cli-integration  # 6 mock-hub round-trip tests
pnpm tauri:dev       # run desktop app in dev mode
pnpm bundle:cli      # rebuild bin/typort (after CLI source changes)
```

After editing CLI source, regenerate the committed bundle:
```bash
pnpm bundle:cli && git add bin/typort && git commit -m "..." && git push
```

## Status

MVP covering plan milestones 0–4. See [`plan.md`](./plan.md) for the full design and what's intentionally out of scope.
