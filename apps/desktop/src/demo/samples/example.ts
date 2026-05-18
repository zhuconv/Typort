// TypeScript — generics, discriminated unions, and a little async.

type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

async function fetchJson<T>(url: string): Promise<Result<T>> {
  try {
    const res = await fetch(url);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, value: (await res.json()) as T };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

interface User {
  id: number;
  name: string;
  admin?: boolean;
}

const label = (u: User): string =>
  `#${u.id} ${u.name}${u.admin ? " (admin)" : ""}`;

const result = await fetchJson<User[]>("/api/users");
if (result.ok) {
  result.value.map(label).forEach((line) => console.log(line));
} else {
  console.error("failed:", result.error);
}
