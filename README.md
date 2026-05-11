<h1 align="center">
  <img src="apps/desktop/src-tauri/icons/icon-hero.png" width="120" alt="" /><br />
  Typort
</h1>


<p align="center"><strong>Edit remote markdown files like they're local.</strong></p>


You SSH into a server. You want to update a README, capture meeting notes, draft a paper section. You open `vim`… and immediately remember how unfun markdown is without a real editor. Headings stay flat. Lists don't auto-format. Bold and italic stay as `**` and `*`. Tables render as ASCII art.

Typort fixes that.

```bash
# on the server
$ typort open notes.md
opened: /home/you/notes.md
$
```

A native editor window pops open on your laptop with `notes.md` already loaded — full WYSIWYG markdown. Headings render at heading size. Italic *closes* into italic the second you type the closing asterisk. Lists nest the way they look in the rendered output. You type. Saves go back to the remote file, atomically, hash-checked. Your terminal prompt comes right back; the editor session lives in the background until you close it.

One command. Native editing. No per-file setup.

## Who is this for

You edit markdown on remote servers and your current options aren't great.

- **Researchers** drafting papers on a GPU box
- **Engineers** maintaining READMEs / runbooks / configs on production servers
- **Anyone** who SSHs more than they'd like and writes more than `git commit -m`

If your current stack is `vim`-and-tears, VSCode Remote-SSH waiting 12 seconds to reconnect, or the eternal `scp` ↔ edit ↔ `scp` shuffle — this is for you.

## How it compares

|                                | **Typort** | vim/nano | VSCode Remote | sshfs |
| ------------------------------ | :--------: | :------: | :-----------: | :---: |
| WYSIWYG markdown               |     ✅     |    ❌    |    preview pane    | depends |
| Per-file setup                 |  one command  |  ok  | open folder + handshake | mount tree |
| Handles concurrent remote edits | diff view + 3-way merge | overwrites | depends | overwrites |
| Atomic save                    |     ✅     |    ✅    |       ✅      |  fs-dep |
| Remote install footprint       |  265 KB, no toolchain  | already there | server-side VSCode (~500 MB) | sshfs binary |
| Terminal stays free after open |     ✅     |    ❌    |      n/a      |  n/a  |

## Quick start

**Local Mac (one time):**

```bash
git clone https://github.com/zhuconv/Typort.git ~/typort && cd ~/typort
pnpm install && pnpm tauri:build && pnpm install:app
```

Typort lives in the menu bar — no Dock clutter when idle. The Welcome window shows your auth token and the SSH tunnel command to copy.

**Remote server (one time):**

```bash
curl -fsSL https://raw.githubusercontent.com/zhuconv/Typort/main/install.sh | bash
echo 'export TYPORT_TOKEN=<paste-from-Welcome-window>' >> ~/.bashrc
```

**Per session:**

```bash
# local: open the SSH reverse tunnel
ssh -R 17887:127.0.0.1:17887 user@server

# remote: open any markdown file
typort open path/to/file.md
```

The editor pops up. You type. The terminal prompt is already back. When you close the window, the remote agent exits cleanly.

## What you get

- **WYSIWYG markdown** powered by [typora-web](https://github.com/Yuyz0112/typora-web) — headings, emphasis, code, links, lists, tables, task lists, footnotes, all rendered as you type
- **Safe-by-default writes** — atomic `tmp + rename + fsync`, mode/owner preserved, base-hash check before every save so a concurrent remote edit can never be silently clobbered
- **Three-way conflict resolution** — when remote diverges, you see a side-by-side diff and pick: *Reload remote*, *Keep mine as `.conflict.md`*, or *Edit & merge* with git-style conflict markers
- **Daemon-style lifecycle on macOS** — the app sits in the menu bar; the Dock icon only appears while you're actually editing
- **Zero remote toolchain** — one 265 KB Node script ships everything; works on any server with Node ≥18
- **Localhost-bound hub** — the editor process listens only on `127.0.0.1`. The remote agent reaches it through your SSH reverse tunnel. Nothing crosses the network beyond what `ssh` already authenticated.

## How it works

```text
remote shell  ──►  typort open file.md
                       │  SSH reverse tunnel: -R 17887:127.0.0.1:17887
                       ▼
local laptop  ──►  Typort.app  ──►  native WYSIWYG editor window
                                          │
                                          ▼
                                  atomic save back to remote path
```

The remote `typort` agent reads the file, computes a SHA-256, and connects to a localhost WebSocket hub that lives inside Typort.app on your Mac. The hub creates an editor window, streams the contents in, and routes save requests back through the same WebSocket. The agent handles the actual disk I/O on the remote side — your local app never reaches across the network beyond `127.0.0.1`.

For the design rationale, threat model, and what's intentionally out of scope, see [`plan.md`](./plan.md).

## Status

Working end-to-end on macOS. The full happy path — open, edit, save, conflict-resolve over a real SSH tunnel — is the standard development workflow.

Roadmap (not promises, just direction):

- Code-signing so the `.app` distributes without `xattr -c`
- Linux desktop bundle
- Tray menu with "Open recent files"
- A real `.dmg` installer page

If something breaks or feels slow on a long-RTT tunnel, please [open an issue](https://github.com/zhuconv/Typort/issues) — I want to know.

## License

MIT.
