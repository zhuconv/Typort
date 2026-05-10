import { useEffect, useState } from "react";
import { Welcome } from "./routes/Welcome.js";
import { SessionEditor } from "./routes/SessionEditor.js";

type Route =
  | { kind: "welcome" }
  | { kind: "session"; sessionId: string };

function parseRoute(): Route {
  // We use plain hash routing: index.html#/session/<id>
  const hash = window.location.hash.replace(/^#/, "");
  const m = hash.match(/^\/session\/([^/?#]+)/);
  if (m) return { kind: "session", sessionId: decodeURIComponent(m[1]!) };
  return { kind: "welcome" };
}

export function App() {
  const [route, setRoute] = useState<Route>(parseRoute());

  useEffect(() => {
    const onHash = () => setRoute(parseRoute());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  if (route.kind === "session") {
    return <SessionEditor sessionId={route.sessionId} />;
  }
  return <Welcome />;
}
