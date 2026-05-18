<h1 align="center">
  <img src="apps/desktop/src-tauri/icons/icon-hero.png" width="120" alt="" /><br />
  Typort
</h1>

<p align="center"><strong>Read and edit remote files like they're local.</strong></p>

https://github.com/user-attachments/assets/4414bd97-ca09-43d0-8231-05d5fcbf98fa

`typort open <file>` — run it on any server you've SSH'd into, and the file opens
in a native editor on your own machine: Markdown as WYSIWYG, code in a real code
editor. Edits save straight back to the remote path; your shell prompt returns
immediately.

```bash
# on the server
$ typort open server.ts
opened: /home/you/server.ts
$
```

## Features

- **One command, any file** — `typort open <file>` on the server opens a native
  editor window on your local machine. No per-file setup.
- **Markdown → WYSIWYG** — headings, emphasis, lists, tables, task lists and code
  blocks render as you type, powered by
  [open-typora](https://github.com/zhuconv/open-typora).
- **Code → a real editor** — every other file opens in Monaco, the editor that
  powers VS Code: true syntax highlighting for ~35 languages (real TextMate
  grammars via Shiki), minimap, multi-cursor, find & replace.
- **Themes & font size** — GitHub and Vitesse themes in light and dark; the whole
  window follows the editor theme. Font size is adjustable and remembered.
- **Safe saves** — atomic write (`tmp + rename + fsync`), file mode and owner
  preserved, and a SHA-256 hash check before every write.
- **Conflict resolution** — if the remote file changed underneath you, Typort
  shows a side-by-side diff and lets you reload, keep your version as a separate
  file, or hand-merge with git-style markers — never a silent overwrite.
- **Localhost-bound** — the editor listens only on `127.0.0.1`; the remote agent
  reaches it through your SSH reverse tunnel. Nothing crosses the network beyond
  what `ssh` already carries.
- **Zero remote toolchain** — one ~265 KB Node script on the server; works on any
  host with Node ≥ 18.
- **Out of the way** — runs as a macOS menu-bar app; the Dock icon appears only
  while you're editing, and `typort open` returns your shell immediately.

## Quick start

**Local Mac (one time)** — build and install the app:

```bash
git clone https://github.com/zhuconv/Typort.git ~/typort && cd ~/typort
pnpm install && pnpm tauri:build && pnpm install:app
```

Typort lives in the menu bar; its Welcome window shows your auth token and the
SSH tunnel command.

**Remote server (one time)** — install the agent:

```bash
curl -fsSL https://raw.githubusercontent.com/zhuconv/Typort/main/install.sh | bash
echo 'export TYPORT_TOKEN=<paste-from-Welcome-window>' >> ~/.bashrc
```

**Per session:**

```bash
# local: open the SSH reverse tunnel
ssh -R 17887:127.0.0.1:17887 user@server

# remote: open any file
typort open path/to/file
```

## How it works

```text
remote shell  ──►  typort open file
                       │  SSH reverse tunnel: -R 17887:127.0.0.1:17887
                       ▼
local machine ──►  Typort.app  ──►  native editor window
                                          │
                                          ▼
                                  atomic save back to the remote path
```

The remote `typort` agent reads the file, computes a SHA-256, and connects to a
localhost WebSocket hub inside Typort.app. The hub opens an editor window and
routes saves back to the agent, which does the actual remote disk I/O — your
local app never reaches across the network beyond `127.0.0.1`.

Design rationale and threat model: [`plan.md`](./plan.md).

## Status

Works end-to-end on macOS. Linux and Windows desktop builds are planned.

## License

MIT.
