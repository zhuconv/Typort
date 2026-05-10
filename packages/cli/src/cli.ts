import { hostname } from "node:os";
import { isAbsolute, resolve } from "node:path";
import {
  AGENT_CONNECT_PATH,
  DEFAULT_HUB_HTTP,
  DEFAULT_HUB_WS,
  HEALTH_PATH,
  PROTOCOL_VERSION,
} from "@typort/protocol";
import { runAgent } from "./agent.js";

type Cmd = "open" | "doctor" | "tunnel-help" | "version" | "help";

interface OpenOptions {
  file: string;
  hubWs: string;
  hubHttp: string;
  token?: string | undefined;
  readonly: boolean;
  insecureNoTls: boolean;
}

const HELP_TEXT = `typort - remote markdown editor agent

USAGE
  typort open <file> [options]
  typort doctor
  typort tunnel-help
  typort --version

OPTIONS for "open"
  --readonly             open file as readonly (no save back)
  --hub <url>            hub HTTP URL (default ${DEFAULT_HUB_HTTP}, env TYPORT_HUB)
  --token <token>        auth token (default env TYPORT_TOKEN)
  --insecure-no-tls      do not require TLS even if hub URL is not localhost

ENV
  TYPORT_HUB             default hub URL
  TYPORT_TOKEN           default auth token
  TYPORT_DEV_INSECURE=1  permit unauthenticated connection (dev only)

EXAMPLES
  typort open ./README.md
  TYPORT_TOKEN=abc typort open /path/to/file.md
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
  const head = args[0];
  if (head === "--help" || head === "-h" || head === "help") {
    return { cmd: "help" };
  }
  if (head === "--version" || head === "-v" || head === "version") {
    return { cmd: "version" };
  }
  if (head === "doctor") return { cmd: "doctor" };
  if (head === "tunnel-help") return { cmd: "tunnel-help" };
  if (head !== "open") {
    throw new Error(`unknown command: ${head}`);
  }

  const rest = args.slice(1);
  let file: string | undefined;
  let readonly = false;
  let insecureNoTls = false;
  let hubHttp = process.env.TYPORT_HUB ?? DEFAULT_HUB_HTTP;
  let token = process.env.TYPORT_TOKEN;

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--readonly") {
      readonly = true;
    } else if (a === "--insecure-no-tls") {
      insecureNoTls = true;
    } else if (a === "--hub") {
      const v = rest[++i];
      if (!v) throw new Error("--hub requires a value");
      hubHttp = v;
    } else if (a === "--token") {
      const v = rest[++i];
      if (!v) throw new Error("--token requires a value");
      token = v;
    } else if (a.startsWith("--")) {
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
    open: { file: abs, hubWs, hubHttp, token, readonly, insecureNoTls },
  };
}

export function httpToWs(http: string): string {
  if (http.startsWith("https://")) return "wss://" + http.slice("https://".length);
  if (http.startsWith("http://")) return "ws://" + http.slice("http://".length);
  return http;
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
  const token = process.env.TYPORT_TOKEN;
  const dev = process.env.TYPORT_DEV_INSECURE === "1";

  console.log(`Hub URL:        ${hub}`);
  console.log(`Hub WS URL:     ${httpToWs(hub)}${AGENT_CONNECT_PATH}`);
  console.log(`Auth token:     ${token ? "configured" : "missing"}`);
  console.log(`Dev insecure:   ${dev ? "yes (TYPORT_DEV_INSECURE=1)" : "no"}`);
  console.log(`Protocol vsn:   ${PROTOCOL_VERSION}`);
  console.log(`Node version:   ${process.version}`);
  console.log(`Hostname:       ${hostname()}`);

  const url = `${hub}${HEALTH_PATH}`;
  try {
    const res = await fetch(url, {
      headers: token ? { authorization: `Bearer ${token}` } : undefined,
      signal: AbortSignal.timeout(2500),
    });
    console.log(`Hub reachable:  yes (HTTP ${res.status})`);
    return res.ok ? 0 : 1;
  } catch (err) {
    console.log(`Hub reachable:  no — ${(err as Error).message}`);
    console.log(
      "  Hint: is Typort Desktop running locally? Is the SSH reverse tunnel up?",
    );
    console.log("  Run 'typort tunnel-help' for setup instructions.");
    return 1;
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
    case "doctor":
      return doctor();
    case "open": {
      const o = parsed.open!;
      const dev = process.env.TYPORT_DEV_INSECURE === "1";
      if (!o.token && !dev) {
        process.stderr.write(
          "error: TYPORT_TOKEN is not set. Set it from Typort Desktop's status window or pass --token.\n" +
            "  (You can bypass this for local dev with TYPORT_DEV_INSECURE=1.)\n",
        );
        return 2;
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
