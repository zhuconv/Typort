import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, openSync, readFileSync, statSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  AGENT_CONNECT_PATH,
  DEFAULT_HUB_HTTP,
  DEFAULT_HUB_WS,
  HEALTH_PATH,
  PROTOCOL_VERSION,
} from "@typort/protocol";
import { runAgent } from "./agent.js";

type Cmd = "open" | "doctor" | "tunnel-help" | "welcome" | "version" | "help";

const SUBCOMMANDS = new Set([
  "open",
  "doctor",
  "tunnel-help",
  "welcome",
  "version",
  "help",
]);

interface OpenOptions {
  file: string;
  hubWs: string;
  hubHttp: string;
  token?: string | undefined;
  readonly: boolean;
  insecureNoTls: boolean;
  foreground: boolean;
}

const HELP_TEXT = `typort - remote markdown editor agent

USAGE
  typort <file> [options]            # shortcut for 'typort open <file>'
  typort open <file> [options]
  typort doctor
  typort tunnel-help
  typort welcome                     # (local Mac) bring Welcome window forward
  typort --version

OPTIONS for "open"
  -f, --foreground       stay attached to the terminal (default: detach to
                         background and return immediately; logs to
                         ~/.typort/typort.log)
  --readonly             open file as readonly (no save back)
  --hub <url>            hub HTTP URL (default ${DEFAULT_HUB_HTTP}, env TYPORT_HUB)
  --token <token>        auth token (default: env TYPORT_TOKEN; for a local
                         hub, falls back to Typort Desktop's saved token)
  --insecure-no-tls      do not require TLS even if hub URL is not localhost

ENV
  TYPORT_HUB             default hub URL
  TYPORT_TOKEN           default auth token
  TYPORT_DEV_INSECURE=1  permit unauthenticated connection (dev only)

EXAMPLES
  typort ./README.md                 # shortcut, opens with default settings
  typort open /path/to/file.md
  TYPORT_TOKEN=abc typort /path/to/file.md
  typort tunnel-help
`;

export function parseArgs(argv: readonly string[]): {
  cmd: Cmd;
  open?: OpenOptions;
} {
  const args = argv.slice(2);
  if (args.length === 0) {
    return { cmd: "help" };
  }
  const head = args[0]!;
  if (head === "--help" || head === "-h" || head === "help") {
    return { cmd: "help" };
  }
  if (head === "--version" || head === "-v" || head === "version") {
    return { cmd: "version" };
  }
  if (head === "doctor") return { cmd: "doctor" };
  if (head === "tunnel-help") return { cmd: "tunnel-help" };
  if (head === "welcome") return { cmd: "welcome" };

  // If the head is a known subcommand keyword, dispatch to that subcommand;
  // otherwise treat the whole argv (including head) as `open` arguments so
  // `typort foo.md` is shorthand for `typort open foo.md`. Unknown long
  // flags as the first arg are still rejected (otherwise typos like
  // `--bogos` would silently be treated as a filename).
  const rest = SUBCOMMANDS.has(head) ? args.slice(1) : args;
  if (!SUBCOMMANDS.has(head) && head.startsWith("--") && head !== "--readonly"
      && head !== "--insecure-no-tls" && head !== "--foreground"
      && head !== "--hub" && head !== "--token") {
    throw new Error(`unknown command: ${head}`);
  }

  let file: string | undefined;
  let readonly = false;
  let insecureNoTls = false;
  let foreground = false;
  let hubHttp = process.env.TYPORT_HUB ?? DEFAULT_HUB_HTTP;
  let token = process.env.TYPORT_TOKEN;

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--readonly") {
      readonly = true;
    } else if (a === "--insecure-no-tls") {
      insecureNoTls = true;
    } else if (a === "--foreground" || a === "-f") {
      foreground = true;
    } else if (a === "--hub") {
      const v = rest[++i];
      if (!v) throw new Error("--hub requires a value");
      hubHttp = v;
    } else if (a === "--token") {
      const v = rest[++i];
      if (!v) throw new Error("--token requires a value");
      token = v;
    } else if (a.startsWith("--") || (a.startsWith("-") && a.length > 1 && !a.match(/^-?\d/))) {
      throw new Error(`unknown flag: ${a}`);
    } else if (!file) {
      file = a;
    } else {
      throw new Error(`unexpected positional argument: ${a}`);
    }
  }

  if (!file) throw new Error("'open' requires a <file> argument");
  const abs = isAbsolute(file) ? file : resolve(process.cwd(), file);

  const hubWs = httpToWs(hubHttp);
  return {
    cmd: "open",
    open: { file: abs, hubWs, hubHttp, token, readonly, insecureNoTls, foreground },
  };
}

export function httpToWs(http: string): string {
  if (http.startsWith("https://")) return "wss://" + http.slice("https://".length);
  if (http.startsWith("http://")) return "ws://" + http.slice("http://".length);
  return http;
}

/**
 * True when the hub URL points at this machine. Only then is it safe to
 * auto-load Typort Desktop's saved token — it must never reach a remote hub.
 */
function isLocalHub(hubHttp: string): boolean {
  let host: string;
  try {
    host = new URL(hubHttp).hostname;
  } catch {
    return false;
  }
  // URL() returns IPv6 hosts bracketed, e.g. "[::1]".
  return (
    host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]"
  );
}

/**
 * Read the auth token from Typort Desktop's config file. The desktop app
 * (see config.rs) writes a random token there on first launch; on the same
 * machine the CLI reuses it instead of requiring TYPORT_TOKEN. Returns
 * undefined when the file is missing or unreadable — the caller then falls
 * back to the usual "token not set" error.
 */
function readDesktopToken(): string | undefined {
  const path = desktopConfigPath();
  if (!path) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { token?: unknown };
    return typeof parsed.token === "string" && parsed.token.length > 0
      ? parsed.token
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Location of Typort Desktop's config.json, matching where the Tauri app
 * (bundle identifier `dev.typort.desktop`) writes it via app_config_dir().
 */
function desktopConfigPath(): string | undefined {
  const APP_ID = "dev.typort.desktop"; // tauri.conf.json "identifier"
  const home = homedir();
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", APP_ID, "config.json");
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    return appData ? join(appData, APP_ID, "config.json") : undefined;
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  return join(xdg || join(home, ".config"), APP_ID, "config.json");
}

function tunnelHelpText(token: string | undefined): string {
  const tokenLine = token
    ? `export TYPORT_TOKEN=${token}\n`
    : `# (set TYPORT_TOKEN to the token shown in the Typort Desktop status window)\nexport TYPORT_TOKEN=...\n`;
  return [
    "1) On your local laptop, run Typort Desktop.",
    "",
    "2) From your local terminal, open the SSH reverse tunnel:",
    "",
    `   ssh -R 17887:127.0.0.1:17887 user@server`,
    "",
    "3) On the remote server, set the token and open a file:",
    "",
    "   " + tokenLine.split("\n").join("\n   "),
    `   typort open /path/to/file.md`,
    "",
  ].join("\n");
}

async function doctor(): Promise<number> {
  const hub = process.env.TYPORT_HUB ?? DEFAULT_HUB_HTTP;
  const envToken = process.env.TYPORT_TOKEN;
  const localToken =
    !envToken && isLocalHub(hub) ? readDesktopToken() : undefined;
  const dev = process.env.TYPORT_DEV_INSECURE === "1";

  console.log(`Hub URL:        ${hub}`);
  console.log(`Hub WS URL:     ${httpToWs(hub)}${AGENT_CONNECT_PATH}`);
  console.log(
    `Auth token:     ${
      envToken
        ? "configured (TYPORT_TOKEN)"
        : localToken
          ? "configured (Typort Desktop config)"
          : "missing"
    }`,
  );
  console.log(`Dev insecure:   ${dev ? "yes (TYPORT_DEV_INSECURE=1)" : "no"}`);
  console.log(`Protocol vsn:   ${PROTOCOL_VERSION}`);
  console.log(`Node version:   ${process.version}`);
  console.log(`Hostname:       ${hostname()}`);

  const probe = await hubReachable(hub);
  if (probe.ok) {
    console.log(`Hub reachable:  yes (${probe.reason})`);
    return 0;
  }
  console.log(`Hub reachable:  no — ${probe.reason}`);
  console.log(
    "  Hint: is Typort Desktop running locally? Is the SSH reverse tunnel up?",
  );
  console.log("  Run 'typort tunnel-help' for setup instructions.");
  return 1;
}

/**
 * Probe the hub's /health endpoint. Used both by `typort doctor` (for the
 * user-facing report) and by `typort open` as a pre-flight before forking
 * the detached child, so we don't print "opened: ..." for a hub that isn't
 * actually there.
 */
async function hubReachable(
  hubHttp: string,
): Promise<{ ok: boolean; reason: string }> {
  const url = hubHttp.replace(/\/$/, "") + HEALTH_PATH;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
    if (res.ok) return { ok: true, reason: `HTTP ${res.status}` };
    return { ok: false, reason: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

export async function main(argv: readonly string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n\n`);
    process.stderr.write(HELP_TEXT);
    return 2;
  }

  switch (parsed.cmd) {
    case "help":
      process.stdout.write(HELP_TEXT);
      return 0;
    case "version":
      process.stdout.write(`typort 0.1.0 (protocol ${PROTOCOL_VERSION})\n`);
      return 0;
    case "tunnel-help":
      process.stdout.write(tunnelHelpText(process.env.TYPORT_TOKEN));
      return 0;
    case "welcome":
      return welcomeCommand();
    case "doctor":
      return doctor();
    case "open": {
      const o = parsed.open!;
      const dev = process.env.TYPORT_DEV_INSECURE === "1";
      // Local fallback: when no token was supplied and the hub is on this
      // machine, read it straight from Typort Desktop's config file, so
      // `typort open <file>` works locally with zero setup. The TYPORT_TOKEN
      // dance only exists for remote agents, which can't see that file.
      if (!o.token && isLocalHub(o.hubHttp)) {
        o.token = readDesktopToken();
      }
      if (!o.token && !dev) {
        process.stderr.write(
          "error: TYPORT_TOKEN is not set. Set it from Typort Desktop's status window or pass --token.\n" +
            "  (You can bypass this for local dev with TYPORT_DEV_INSECURE=1.)\n",
        );
        return 2;
      }
      // Validate the file BEFORE forking. Otherwise the parent prints
      // "opened: ..." while the child silently fails and writes the error
      // to ~/.typort/typort.log — the user sees a success message for a
      // file that doesn't exist.
      const validation = validateFileForOpen(o.file);
      if (validation) {
        process.stderr.write(`error: ${validation}\n`);
        return 1;
      }
      // Default: detach to background so the terminal returns immediately.
      // The detached child re-enters this same code path with
      // TYPORT_DAEMON_CHILD=1 set, which makes it skip the fork and run
      // the agent in-process.
      if (!o.foreground && process.env.TYPORT_DAEMON_CHILD !== "1") {
        // Pre-flight reachability check. Without this the parent reports
        // "opened: ..." even when the hub is down or the SSH tunnel is
        // missing — the child fails with ECONNREFUSED/ECONNRESET silently
        // into the log file. Probe /health (unauth, always 200 when hub is
        // up) so the user sees the actual problem on stderr.
        const probe = await hubReachable(o.hubHttp);
        if (!probe.ok) {
          process.stderr.write(
            `error: Typort hub not reachable at ${o.hubHttp} (${probe.reason}).\n` +
              "  Is Typort Desktop running on your local machine, and is the SSH reverse tunnel up?\n" +
              "  Run `typort doctor` for more detail, or `typort tunnel-help` for setup instructions.\n",
          );
          return 1;
        }
        return spawnDetached(o);
      }
      return runAgent({
        file: o.file,
        hubWs: o.hubWs,
        token: o.token,
        readonly: o.readonly,
        insecureNoTls: o.insecureNoTls,
      });
    }
  }
}

/**
 * Bring Typort Desktop's Welcome window to the front. macOS-only — relies on
 * `open /Applications/Typort.app`, which (with our single-instance plugin)
 * routes to the running daemon and triggers it to show + focus Welcome.
 */
function welcomeCommand(): number {
  if (process.platform !== "darwin") {
    process.stderr.write(
      "error: `typort welcome` only works on macOS where Typort.app is installed.\n",
    );
    return 1;
  }
  const appPath = "/Applications/Typort.app";
  try {
    statSync(appPath);
  } catch {
    process.stderr.write(
      `error: ${appPath} not found.\n` +
        "  Install: build with \`pnpm tauri:build && pnpm install:app\` from the Typort repo.\n",
    );
    return 1;
  }
  const r = spawnSync("open", [appPath], { stdio: "inherit" });
  return r.status ?? 1;
}

const MAX_FILE_BYTES = 10 * 1024 * 1024;

/**
 * Cheap pre-flight checks that mirror what file-session/readSnapshot does.
 * Returns an error message string on failure, or null if the file is
 * acceptable to open. Run in the parent so the user sees the error on stderr
 * instead of having to grep ~/.typort/typort.log.
 */
function validateFileForOpen(absPath: string): string | null {
  let stat;
  try {
    stat = statSync(absPath);
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return `file not found: ${absPath}`;
    if (e.code === "EACCES") return `permission denied: ${absPath}`;
    return `cannot stat ${absPath}: ${e.message}`;
  }
  if (!stat.isFile()) return `not a regular file: ${absPath}`;
  if (stat.size > MAX_FILE_BYTES) {
    return `file is ${stat.size} bytes; limit is ${MAX_FILE_BYTES} bytes (${absPath})`;
  }
  return null;
}

function spawnDetached(o: OpenOptions): number {
  const logDir = join(homedir(), ".typort");
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, "typort.log");
  const logFd = openSync(logPath, "a");

  const child = spawn(
    process.execPath,
    [process.argv[1]!, ...process.argv.slice(2)],
    {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: { ...process.env, TYPORT_DAEMON_CHILD: "1" },
    },
  );
  child.unref();

  process.stdout.write(`opened: ${o.file}\n`);
  process.stdout.write(`  logs: ${logPath}\n`);
  return 0;
}
