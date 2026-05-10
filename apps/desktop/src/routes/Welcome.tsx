import { useEffect, useState } from "react";
import { invoke, type AppStatus } from "../lib/tauriClient.js";

export function Welcome() {
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [tunnelHelp, setTunnelHelp] = useState<string>("");
  const [copied, setCopied] = useState<"token" | "tunnel" | null>(null);

  useEffect(() => {
    invoke<AppStatus>("get_app_status")
      .then(setStatus)
      .catch((e) => console.error("get_app_status failed", e));
    invoke<string>("copy_tunnel_help")
      .then(setTunnelHelp)
      .catch((e) => console.error("copy_tunnel_help failed", e));
  }, []);

  const onCopy = async (kind: "token" | "tunnel", text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // ignore — not all webviews allow clipboard
    }
    setCopied(kind);
    setTimeout(() => setCopied(null), 1500);
  };

  return (
    <div className="welcome">
      <h1>Typort</h1>
      <p className="sub">
        Local Markdown editor for remote files. Run <code>typort open file.md</code> on a
        remote SSH server and the file opens here.
      </p>

      <div className="card">
        <dl>
          <dt>Hub status</dt>
          <dd>
            {status === null
              ? "loading…"
              : status.hubBound
                ? `bound on ${status.hubAddress}`
                : `not bound (${status.hubAddress})`}
          </dd>

          <dt>Auth token</dt>
          <dd>
            {status === null
              ? "loading…"
              : status.tokenConfigured
                ? <>
                    configured{" "}
                    {status.token ? (
                      <button
                        onClick={() => onCopy("token", status.token!)}
                        title="Copy token to clipboard"
                      >
                        {copied === "token" ? "Copied" : "Copy token"}
                      </button>
                    ) : null}
                  </>
                : "missing"}
          </dd>

          <dt>Active sessions</dt>
          <dd>{status === null ? "—" : status.activeSessions}</dd>

          <dt>Protocol version</dt>
          <dd>{status === null ? "—" : status.protocolVersion}</dd>
        </dl>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>SSH reverse tunnel</h3>
        <p>
          On your <strong>local terminal</strong>, open a reverse tunnel into your remote
          server so the remote <code>typort</code> CLI can reach this app:
        </p>
        <pre className="tunnel">{tunnelHelp || "ssh -R 17887:127.0.0.1:17887 user@server"}</pre>
        <button
          onClick={() => onCopy("tunnel", tunnelHelp || "ssh -R 17887:127.0.0.1:17887 user@server")}
        >
          {copied === "tunnel" ? "Copied" : "Copy command"}
        </button>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>On the remote server</h3>
        <pre className="tunnel">{`export TYPORT_TOKEN=<paste-token-from-above>
typort open /path/to/file.md`}</pre>
      </div>
    </div>
  );
}
