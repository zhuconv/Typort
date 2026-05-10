# Typort Plan: Tauri-First Local Markdown Editor for Remote Files

## 0. Goal

Build **Typort**, a Tauri-based local Markdown editor that lets the user open and edit a remote server file from a shell command:

```bash
# on remote server, inside an SSH session
$ typort open /path/to/file.md
```

Expected behavior:

1. **Typort Desktop**, a Tauri v2 app, is running on the user's local laptop/desktop, preferably as a tray/menu-bar app.
2. The remote server reaches the local app through an SSH reverse tunnel.
3. `typort open file.md` runs a lightweight remote file-session agent.
4. The local Tauri app receives the session and opens/focuses a native Typort editor window.
5. The editor loads the remote Markdown content using `zhuconv/open-typora` as the editor core.
6. Edits autosave back to the original remote file path.
7. Saves are safe: hash-checked, conflict-aware, and atomic.

The core product is **not** a web upload editor. It is:

```text
remote file path -> remote session agent -> SSH reverse tunnel -> local Tauri app -> native editor window -> safe save back to remote path
```

---

## 1. Repository Strategy

Create a new repository:

```text
zhuconv/typort
```

Keep `open-typora` separate:

```text
zhuconv/open-typora   = editor core / Typora-style Markdown engine
zhuconv/typort        = Tauri desktop app + remote CLI + file session protocol
```

Do **not** turn `open-typora` into the full app. Only modify `open-typora` for clean editor-library improvements, such as better `createEditor`, `getMarkdown`, `setMarkdown`, `onChange`, styling, or round-trip bug fixes.

Recommended monorepo layout:

```text
typort/
  README.md
  plan.md
  package.json
  pnpm-workspace.yaml
  tsconfig.base.json

  apps/
    desktop/                    # Tauri v2 desktop app
      package.json
      index.html
      src/                       # React/Vite/Svelte/etc. frontend; use open-typora here
        main.tsx
        routes/
          SessionEditor.tsx
          Welcome.tsx
        lib/
          editorAdapter.ts
          tauriSessionClient.ts
      src-tauri/                 # Rust backend
        Cargo.toml
        tauri.conf.json
        capabilities/
          default.json
        src/
          main.rs
          hub.rs                 # localhost WebSocket/HTTP hub for remote agents
          session.rs             # in-memory session registry
          protocol.rs            # Rust serde mirror of JSON protocol
          window.rs              # create/focus editor windows
          config.rs              # token/config paths

  packages/
    cli/                         # Node/TypeScript remote CLI: `typort open`, `doctor`, `tunnel-help`
    protocol/                    # Shared JSON protocol schemas; zod + generated JSON schema
    file-session/                # Remote read/hash/watch/atomic-write helpers for CLI
    editor-adapter/              # Thin wrapper around open-typora createEditor API
```

### Language split

Use the right language for each side:

```text
Local desktop app: Tauri v2, Rust backend + web frontend
Remote CLI/agent: TypeScript/Node first, because `npx` installation is convenient on servers
Protocol: JSON messages with zod validation on Node side and serde validation on Rust side
```

Do not force everything into Rust at MVP stage. The desktop app should be Tauri/Rust-native, while the remote CLI can remain Node/TypeScript for easy installation.

---

## 2. Why Tauri

Use Tauri as the primary app framework because Typort needs:

- a real local desktop app/window, not just a browser tab;
- a local backend that can listen on `127.0.0.1`;
- native window creation/focus when a remote session arrives;
- tray/menu-bar behavior later;
- a stronger frontend/backend permission boundary than an arbitrary local web server;
- small packaging footprint compared with bundling a full browser runtime.

Tauri's model is exactly suitable here:

```text
Tauri frontend webview  <->  Tauri Rust backend  <->  local hub / session registry / native windows
```

Official docs to consult during implementation:

- Tauri architecture: https://v2.tauri.app/concept/architecture/
- Tauri start/project setup: https://v2.tauri.app/start/
- Tauri capabilities: https://v2.tauri.app/security/capabilities/
- Tauri permissions: https://v2.tauri.app/security/permissions/
- Tauri sidecars, if needed later: https://v2.tauri.app/develop/sidecar/

---

## 3. Core Architecture

### 3.1 Runtime Diagram

```text
Remote server shell
  typort open /remote/path/README.md
        |
        | starts remote file-session agent inside remote shell
        v
Remote Typort CLI/Agent, Node/TS
  - resolves path
  - reads file
  - computes hash/mtime
  - watches or polls file
  - receives save commands
  - atomic-writes original path
        |
        | WebSocket to ws://127.0.0.1:17887/agent/connect
        | over SSH reverse tunnel
        v
Local Typort Desktop, Tauri app
  Rust backend:
    - local hub on 127.0.0.1:17887
    - auth token check
    - session registry
    - message router
    - native editor window creation/focus
  Webview frontend:
    - open-typora editor core
    - save status UI
    - conflict UI
        |
        v
Native Typort editor window
  - loads session by sessionId from Tauri backend
  - edits Markdown
  - sends save requests via Tauri invoke/event to Rust backend
  - backend forwards save request to remote agent
```

### 3.2 Important Design Point

A request reaching a port does **not** automatically launch a local app if no process is listening.

Therefore MVP assumes:

```bash
# local machine
$ typort-desktop   # or open Typort.app manually; it keeps a tray/background hub alive
```

Then the remote command can trigger the already-running Tauri app to open an editor window.

Later, add:

```text
1. tray/menu-bar app behavior
2. login item / autostart
3. custom URL scheme `typort://...` for manual fallback
4. optional platform helper/socket activation if full wake-on-request is desired
```

Do not overbuild auto-launch for MVP.

---

## 4. Initial Transport: SSH Reverse Tunnel

MVP should use SSH reverse forwarding, not a cloud relay.

Local machine runs Typort Desktop, whose Rust backend listens on:

```text
127.0.0.1:17887
```

The user SSHs into the server with reverse tunnel:

```bash
ssh -R 17887:127.0.0.1:17887 user@server
```

Then on the remote server:

```bash
typort open README.md
```

On the remote server, `http://127.0.0.1:17887` points back to the local Typort Desktop backend through SSH reverse forwarding.

### Later Convenience

Add helper commands later:

```bash
typort tunnel-help
typort doctor
typort ssh user@server      # optional wrapper around ssh -R
```

For MVP, do not wrap SSH. Print exact instructions instead.

---

## 5. MVP Scope

The MVP should support this exact workflow:

```bash
# local laptop/desktop
open Typort.app
# or during dev
pnpm --filter @typort/desktop tauri dev

# local terminal
ssh -R 17887:127.0.0.1:17887 user@server

# remote server shell
typort open /path/to/file.md
```

Then:

1. The running local Tauri app receives the remote session.
2. It opens a native Typort editor window, not just an external browser tab.
3. The editor loads the remote Markdown file.
4. Editing triggers debounced autosave.
5. The remote file content is updated safely.
6. The UI shows `Saving...`, `Saved`, `Conflict`, or `Disconnected`.
7. Closing the editor closes the remote agent session.

MVP should be Tauri-native from the beginning. Do **not** implement a separate browser-only hub first unless used only for temporary debugging.

---

## 6. Non-Goals for MVP

Do **not** implement these in the first version:

- Cloud relay.
- End-to-end encrypted relay.
- Full file tree browser.
- Multi-user collaboration.
- CRDT/OT collaborative editing.
- Git auto-commit.
- Arbitrary remote shell execution.
- Editing binary files.
- Editing huge files over 5-10 MB.
- Full auto-launch helper/socket activation.
- Marketplace/plugin system.
- Full Typora feature parity beyond what `open-typora` already provides.
- Broad local filesystem permissions from the Tauri frontend.
- Tauri shell plugin access unless a very specific sidecar use case is added later.

Keep MVP narrow: open one Markdown file from a remote shell and save it back safely through the Tauri app.

---

## 7. Tauri Desktop App Design

### 7.1 App responsibilities

`apps/desktop` is the primary app.

Tauri Rust backend responsibilities:

```text
- start local hub on 127.0.0.1:17887
- verify auth token from remote agent
- accept WebSocket agent sessions
- maintain in-memory session registry
- create/focus Tauri editor windows
- route save/reload/close messages between editor windows and remote agents
- emit status/conflict/remoteChanged events to frontend windows
- manage config/token storage
```

Tauri frontend responsibilities:

```text
- render welcome/status screen
- render editor session windows
- integrate open-typora
- show remote path and save status
- debounce edits and request saves
- display conflict UI
- expose minimal buttons: Save Now, Reload, Close
```

### 7.2 Window model

Use one Tauri window per open remote file session.

Window labels:

```text
main                        # welcome/status/tray-visible window
session-<sessionId>          # editor window for one file session
```

When `agent.hello` arrives:

```text
1. register session in Rust state
2. create or focus `session-<sessionId>` window
3. load frontend route: index.html#/session/<sessionId>
4. emit `session.created` event
```

The frontend route then calls a Tauri command:

```ts
const session = await invoke<SessionSnapshot>("get_session", { sessionId });
```

### 7.3 Tauri commands

Expose only narrow commands to the frontend:

```rust
get_session(session_id) -> SessionSnapshot
save_session(session_id, content, reason) -> SaveResult
reload_session(session_id) -> ReloadResult
close_session(session_id) -> CloseResult
list_sessions() -> Vec<SessionSummary>
get_app_status() -> AppStatus
copy_tunnel_help() -> String
```

Do **not** expose generic filesystem commands to the frontend.

The frontend should not directly read or write arbitrary local files. All file operations happen on the remote agent for the already-opened path.

### 7.4 Tauri events

Backend emits events to the relevant session window:

```text
session.status          # Saving / Saved / Conflict / Disconnected
session.remoteChanged   # remote disk changed outside Typort
session.conflict        # save rejected due to stale base hash
session.closed
```

Frontend sends saves via `invoke("save_session", ...)`, not by calling the remote agent directly.

### 7.5 Capabilities and permissions

Use Tauri capabilities/permissions deliberately:

```text
- allow only the custom commands required by Typort
- avoid broad fs permissions
- avoid shell plugin permissions in MVP
- avoid opening arbitrary URLs from untrusted remote messages
- separate main/status window and session windows if useful later
```

Remote-provided strings such as filename, server, cwd, and path are untrusted display data. Escape/sanitize them in the frontend.

---

## 8. Editor Integration

Use `zhuconv/open-typora` as the editor engine.

The Tauri session window should mount the editor roughly like this:

```ts
import { createEditor } from "open-typora";
import "open-typora/widgets.css";
import "open-typora/theme-typora.css";

const editor = createEditor(hostEl, {
  initialContent: session.initialContent,
  onChange: debounce((md) => {
    requestSave(md, "autosave");
  }, 800),
});
```

Create a thin adapter:

```ts
type TyportEditor = {
  getMarkdown(): string;
  setMarkdown(md: string): void;
  focus(): void;
  destroy(): void;
};
```

The editor layer should not know about SSH, remote paths, tokens, or file hashes.

### Required UI Elements

Every editor window should show:

```text
server:path/to/file.md
status: Saved / Saving... / Unsaved / Conflict / Disconnected
buttons: Reload, Save Now, Close
```

For conflict MVP, a simple modal is enough:

```text
Remote file changed since this editor session opened.
[Reload remote version] [Keep mine as .conflict.md] [Cancel]
```

---

## 9. Protocol

Create `packages/protocol` with shared message types and runtime validation.

Use zod on the Node/TypeScript side. Mirror the same shapes with serde structs/enums on the Rust side.

### 9.1 Agent-to-Tauri-Hub: Open Session

Remote agent connects to local Tauri backend via WebSocket:

```text
ws://127.0.0.1:17887/agent/connect?token=<token>
```

First message:

```json
{
  "type": "agent.hello",
  "protocolVersion": 1,
  "sessionId": "uuid",
  "server": "server-hostname",
  "cwd": "/remote/current/dir",
  "path": "/remote/current/dir/README.md",
  "displayName": "server:/remote/current/dir/README.md",
  "content": "# Markdown...",
  "hash": "sha256:...",
  "mtimeMs": 1770000000000,
  "sizeBytes": 12345,
  "readonly": false
}
```

Tauri hub replies:

```json
{
  "type": "hub.accept",
  "sessionId": "uuid"
}
```

Then Rust creates/focuses the session editor window.

### 9.2 Editor-to-Agent: Save

Frontend calls:

```ts
invoke("save_session", {
  sessionId,
  content,
  reason: "autosave"
})
```

Rust hub forwards to the remote agent:

```json
{
  "type": "file.save",
  "sessionId": "uuid",
  "seq": 12,
  "baseHash": "sha256:old...",
  "content": "# New Markdown...",
  "reason": "autosave"
}
```

Agent replies:

```json
{
  "type": "file.save.ok",
  "sessionId": "uuid",
  "seq": 12,
  "hash": "sha256:new...",
  "mtimeMs": 1770000001000,
  "sizeBytes": 13000
}
```

If conflict:

```json
{
  "type": "file.save.conflict",
  "sessionId": "uuid",
  "seq": 12,
  "baseHash": "sha256:old...",
  "currentHash": "sha256:remoteChanged...",
  "currentContent": "# Remote changed content...",
  "mtimeMs": 1770000002000
}
```

### 9.3 Agent-to-Hub: Remote File Changed

If the file changes externally, agent notifies hub:

```json
{
  "type": "file.remoteChanged",
  "sessionId": "uuid",
  "hash": "sha256:changed...",
  "mtimeMs": 1770000003000,
  "sizeBytes": 14000
}
```

The editor should show a warning but should not automatically overwrite local unsaved edits.

### 9.4 Session Close

```json
{
  "type": "session.close",
  "sessionId": "uuid",
  "reason": "editorClosed"
}
```

---

## 10. Remote CLI / Agent

### 10.1 Package

Implement remote CLI in:

```text
packages/cli
```

Package name:

```text
@typort/cli
```

Binary command:

```text
typort
```

Initial distribution can support:

```bash
npx -y github:zhuconv/typort typort open README.md
```

or after publishing:

```bash
npx -y @typort/cli open README.md
```

### 10.2 `typort open <file>`

Runs on remote server.

Behavior:

1. Resolve path to absolute path.
2. Ensure file exists and is a regular text/Markdown file.
3. Refuse huge files by default, e.g. >10 MB.
4. Read content.
5. Compute SHA-256, mtime, size.
6. Connect to hub URL from `TYPORT_HUB` or default `http://127.0.0.1:17887`.
7. Authenticate with `TYPORT_TOKEN` or `--token`.
8. Create WebSocket session.
9. Send `agent.hello`.
10. Stay alive to receive save/reload/close messages.
11. Watch/poll file for external changes.
12. Exit when session closes.

Flags:

```bash
typort open README.md
typort open README.md --readonly
typort open README.md --wait
typort open README.md --hub http://127.0.0.1:17887
typort open README.md --token <token>
```

For MVP, `typort open` may remain in foreground until the editor is closed. This is acceptable and simpler than daemonizing.

### 10.3 `typort doctor`

Checks remote-side setup:

```text
Hub URL: http://127.0.0.1:17887
Hub reachable: yes/no
Auth token: configured/missing
SSH reverse tunnel: likely yes/no
Node version: ...
```

### 10.4 `typort tunnel-help`

Prints:

```bash
ssh -R 17887:127.0.0.1:17887 user@server
```

Also print token setup instructions.

---

## 11. File Safety Rules

All writes happen on the remote agent side and must go through a safe write path.

### 11.1 Hash Check

When the file is opened, compute:

```text
baseHash = sha256(file content)
```

Before saving:

```text
if sha256(current disk content) != baseHash:
    reject save as conflict
else:
    perform atomic write
```

After successful save:

```text
baseHash = sha256(new content)
```

### 11.2 Atomic Write

Do not directly overwrite the file.

Use:

```text
1. write content to .<filename>.typort-tmp-<pid>-<random>
2. fsync tmp file if feasible
3. preserve mode/ownership when feasible
4. rename tmp file over original
5. fsync parent directory when feasible
```

Node implementation should be best-effort cross-platform. On Linux/macOS, implement fsync where possible. If fsync is unavailable on a platform, document the limitation.

### 11.3 Backup and Conflict File

For MVP, add a conservative conflict path:

```text
README.md.typort-conflict-YYYYMMDD-HHMMSS.md
```

Do not overwrite remote changes silently.

---

## 12. Auth and Security

### 12.1 MVP Security Baseline

- Tauri backend listens only on `127.0.0.1` by default.
- Remote access should happen through SSH reverse tunnel.
- Hub requires a token unless `TYPORT_DEV_INSECURE=1` is set.
- Token is passed as WebSocket query or Authorization header.
- Never execute arbitrary shell commands from the hub.
- Hub can only ask the remote agent to save/reload/close the already-opened session path.
- Remote agent should not expose a generic filesystem API in MVP.
- Frontend should not receive broad filesystem or shell permissions.
- Remote-provided paths should be treated as untrusted text for display.

### 12.2 Token Plan

On first Tauri app launch, Rust backend creates or loads a token in the user's app config directory:

```text
Typort config dir/token
```

The main Typort window should show:

```text
1. Hub status
2. Port
3. Token configured yes/no
4. Copy token button
5. SSH reverse tunnel command
6. Remote command examples
```

MVP remote setup:

```bash
export TYPORT_TOKEN=<copied-token>
ssh -R 17887:127.0.0.1:17887 user@server
# on remote
typort open README.md
```

Dev mode only:

```bash
TYPORT_DEV_INSECURE=1 pnpm tauri dev
```

Do not make insecure mode the default.

### 12.3 Later Improvements

- `typort ssh` wrapper that passes a short-lived token.
- One-time pairing code.
- Per-session token.
- Tray/menu-bar app with autostart.
- Custom protocol scheme `typort://...`.
- Self-hosted relay with E2E encryption.

---

## 13. Tauri Implementation Details

### 13.1 Backend local hub

Implement the local hub inside `src-tauri/src/hub.rs`.

Recommended Rust stack:

```text
axum or hyper       # local HTTP/WebSocket server
serde               # JSON protocol
uuid                # session IDs
sha2 not needed locally for remote files, but useful in tests
parking_lot/tokio sync primitives
```

Start the server during Tauri setup:

```rust
tauri::Builder::default()
  .setup(|app| {
    // load config/token
    // create shared AppState
    // spawn local hub server on 127.0.0.1:17887
    Ok(())
  })
```

The hub exposes only:

```text
GET /health
WS  /agent/connect
```

Do not serve the editor UI from the hub. The editor UI is the Tauri frontend asset.

### 13.2 Session registry

Store sessions in Rust state:

```rust
struct SessionState {
    session_id: String,
    server: String,
    cwd: String,
    path: String,
    display_name: String,
    initial_content: String,
    current_base_hash: String,
    mtime_ms: u64,
    size_bytes: u64,
    readonly: bool,
    agent_tx: AgentSender,
    status: SessionStatus,
}
```

The frontend receives a sanitized snapshot:

```rust
struct SessionSnapshot {
    session_id: String,
    display_name: String,
    server: String,
    path: String,
    initial_content: String,
    base_hash: String,
    readonly: bool,
    status: String,
}
```

### 13.3 Save request flow

```text
open-typora onChange
  -> frontend debounce
  -> invoke("save_session", { sessionId, content, reason })
  -> Rust validates session exists and not readonly
  -> Rust assigns seq and marks Saving
  -> Rust forwards file.save to remote agent WebSocket
  -> remote agent writes or rejects conflict
  -> Rust updates session state
  -> Rust emits status/conflict event
  -> frontend updates UI
```

### 13.4 Window creation

When agent hello arrives:

```text
create/focus window label: session-<sessionId>
route: index.html#/session/<sessionId>
title: Typort - <server>:<basename>
```

The window should be independently closable. On close:

```text
frontend or backend emits session.close
Rust forwards session.close to remote agent
agent exits
```

### 13.5 Tray/menu-bar later

MVP can be a normal desktop app window. After MVP:

```text
- add tray icon
- keep hub alive when main window closes
- menu items:
  - Open Typort
  - Copy SSH tunnel command
  - Copy token
  - Quit Typort
```

---

## 14. Implementation Milestones

### Milestone 0: Repo Bootstrap

Create:

```text
package manager: pnpm
frontend: Vite + React or Svelte
app framework: Tauri v2
backend: Rust
remote CLI: TypeScript/Node >= 20
validation: zod + serde
```

Commands:

```bash
pnpm install
pnpm build
pnpm test
pnpm --filter @typort/desktop tauri dev
```

Deliverables:

- Monorepo structure.
- Tauri app boots.
- Main window shows Typort status page.
- Basic CLI package builds.
- Root README with MVP workflow.

### Milestone 1: Tauri Editor Window with Mock Session

Build a mock session inside Tauri:

- Create route `#/session/mock`.
- Load `open-typora`.
- Use mock `initialContent`.
- Debounce `onChange`.
- Show status bar.
- Save calls mocked Tauri command.

Acceptance:

```bash
pnpm --filter @typort/desktop tauri dev
```

Then open a mock editor window and verify debounced save events are logged.

### Milestone 2: Tauri Local Hub

Implement Rust local hub:

```text
GET /health
WS  /agent/connect
```

Responsibilities:

- Bind only to `127.0.0.1:17887`.
- Validate token.
- Accept `agent.hello`.
- Register session.
- Create/focus Tauri session window.
- Provide `get_session` command to frontend.

Acceptance:

- Typort Desktop starts local hub.
- A test WebSocket client can send `agent.hello`.
- A Tauri editor window opens with the session content.

### Milestone 3: Remote CLI / `typort open`

Implement `typort open <file>`.

Responsibilities:

- Resolve/read/hash file.
- Connect to Tauri hub WebSocket.
- Send `agent.hello`.
- Keep process alive.
- Handle `file.save`.
- Atomic write on successful hash check.
- Return conflict on hash mismatch.

Acceptance, same machine:

```bash
# terminal 1
pnpm --filter @typort/desktop tauri dev

# terminal 2
pnpm --filter @typort/cli typort open /tmp/test.md
```

Tauri window opens; edits save back to `/tmp/test.md`.

### Milestone 4: SSH Reverse Tunnel Smoke Test

Test on a real remote server:

```bash
# local
open Typort.app
ssh -R 17887:127.0.0.1:17887 user@server

# remote
export TYPORT_TOKEN=<token>
typort open /path/to/README.md
```

Acceptance:

- Local Tauri app opens an editor window automatically.
- File content is loaded from remote server.
- Editing the local editor updates remote file.
- `git diff` on remote server shows the change.

### Milestone 5: Conflict Detection

Implement:

- External change detection via polling first, file watcher later.
- Conflict response when current remote hash differs from editor base hash.
- UI conflict banner/modal.
- Optional save-as-conflict file.

Acceptance:

1. Open file in Typort.
2. Modify same file remotely with `vim` or `echo`.
3. Continue editing in Typort.
4. Typort refuses to overwrite silently and shows conflict UI.

### Milestone 6: Tauri Polish

Add:

- normal app menu
- tray/menu-bar mode
- copy token
- copy SSH command
- status window showing active sessions
- `typort doctor`
- `typort tunnel-help`
- readonly mode
- large file guard
- path with spaces tests
- Markdown-only warning for non-`.md` files

### Milestone 7: Packaging

Package local app:

```text
macOS .app / .dmg first
Linux AppImage/deb later
Windows later if desired
```

Package remote CLI separately:

```text
npm package / npx usage
```

Do not require the remote server to install the desktop app.

---

## 15. Testing Plan

### Unit Tests

For `packages/file-session`:

- SHA-256 hash calculation.
- Atomic write success.
- Conflict detection.
- Preserve file permissions best-effort.
- Path with spaces.
- Readonly file behavior.

For `packages/protocol`:

- Validate `agent.hello`.
- Validate `file.save`.
- Reject malformed messages.

For Tauri Rust backend:

- Token validation.
- Session registry add/remove.
- Save forwarding state machine.
- Status transitions.

### Integration Tests

Spawn the Tauri hub logic or a test instance of it:

1. Create temp markdown file.
2. Start local hub on random port.
3. Start remote agent for temp file.
4. Simulate editor save through Tauri command or backend API.
5. Verify disk content changed.
6. Modify disk externally.
7. Verify conflict on stale save.

### Manual Tests

```bash
# same-machine smoke
open Typort.app
typort open ./README.md

# remote smoke
open Typort.app
ssh -R 17887:127.0.0.1:17887 server
typort open ./README.md
```

---

## 16. Acceptance Criteria for MVP

MVP is complete when all of this works:

- Typort Desktop is a Tauri app.
- Typort Desktop starts a local hub on `127.0.0.1:17887`.
- `typort open file.md` connects to the hub and opens a native Tauri editor window.
- Editor uses `open-typora` and displays the Markdown file.
- Edits autosave back to the original remote file path.
- Save uses hash check and atomic write.
- External remote modifications trigger conflict instead of silent overwrite.
- Works over SSH reverse tunnel.
- Hub listens on localhost only by default.
- Tauri frontend has narrow command permissions only.
- No arbitrary shell command execution exists.
- Basic tests pass with `pnpm test`.

---

## 17. Suggested First Coding Task for Codex / Claude Code

Implement only Milestones 0-3 first.

Do not implement cloud relay, desktop autostart, tray polish, or advanced conflict UI yet.

Concrete task:

```text
Create the Typort monorepo with a Tauri v2 desktop app and a Node/TypeScript remote CLI.

Implement:
1. Tauri app boots and shows a Typort status page.
2. Tauri Rust backend starts a localhost hub on 127.0.0.1:17887.
3. Hub accepts a WebSocket remote agent connection and validates a token.
4. `typort open <file>` reads a local/remote file, computes SHA-256, and sends `agent.hello`.
5. Tauri backend creates a native session editor window for the file.
6. Session editor uses `open-typora` with `initialContent` and debounced `onChange`.
7. Save requests go frontend -> Tauri command -> Rust hub -> remote agent -> atomic write.
8. Integration test proves open -> edit -> save -> disk update, and stale save -> conflict.
```

Keep the protocol simple and typed. Prefer correctness over UI polish.

---

## 18. Notes for Coding Agents

- Do not rename the app. The app name is **Typort** and the CLI command is `typort`.
- Use **Tauri v2** for the local desktop app.
- Do not implement Electron.
- Do not put remote-agent, tunnel, or filesystem code into `open-typora`.
- Treat `open-typora` as a dependency/editor library.
- Keep the first implementation minimal and testable.
- Avoid background daemon complexity in MVP.
- Avoid cloud relay in MVP.
- Use full-content saves first. Do not implement patches/diffs yet.
- Never silently overwrite remote changes.
- Do not add arbitrary remote shell execution.
- Do not give the Tauri frontend broad filesystem or shell permissions.
- Prefer narrow Tauri commands, clear TypeScript interfaces, zod schemas, and serde structs.
