export type SearchMode = "jump" | "messages" | "commands";
export type DestinationKind = "all" | "dm" | "channel" | "task";

export function parseSearchQuery(input: string): {
  mode: SearchMode;
  kind: DestinationKind;
  q: string;
} {
  const query = input.trimStart();
  const prefix = query[0];
  const q = ["@", "#", "?", ">"].includes(prefix)
    ? query.slice(1).trim()
    : query.trim();
  return {
    mode: prefix === ">" ? "commands" : prefix === "?" ? "messages" : "jump",
    kind: prefix === "@" ? "dm" : prefix === "#" ? "channel" : "all",
    q,
  };
}

export function searchModeQuery(
  input: string,
  mode: SearchMode,
  kind: DestinationKind = "all",
) {
  const prefix =
    mode === "commands"
      ? "> "
      : mode === "messages"
        ? "? "
        : kind === "dm"
          ? "@ "
          : kind === "channel"
            ? "# "
            : "";
  return prefix + parseSearchQuery(input).q;
}

export function retainSelection(
  selected: string | null,
  items: { id: string }[],
) {
  return items.some((item) => item.id === selected)
    ? selected
    : (items[0]?.id ?? null);
}

function recentKey(server: string, user: string) {
  return `thechat:search-recents:${JSON.stringify([server, user])}`;
}
function readRecents(server: string, user: string): string[] {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(recentKey(server, user)) ?? "[]",
    );
    return Array.isArray(value)
      ? value.filter((id): id is string => typeof id === "string").slice(0, 30)
      : [];
  } catch {
    return [];
  }
}
export function rememberDestination(server: string, user: string, id: string) {
  try {
    localStorage.setItem(
      recentKey(server, user),
      JSON.stringify(
        [id, ...readRecents(server, user).filter((old) => old !== id)].slice(
          0,
          30,
        ),
      ),
    );
  } catch {
    /* Storage is optional. */
  }
}
/** Never hydrate cached labels or access: rank only this request's authorized results. */
export function recentDestinations<T extends { id: string }>(
  server: string,
  user: string,
  allowed: T[],
): T[] {
  const ids = readRecents(server, user);
  return [...allowed].sort((a, b) => {
    const ai = ids.indexOf(a.id),
      bi = ids.indexOf(b.id);
    return (ai < 0 ? ids.length : ai) - (bi < 0 ? ids.length : bi);
  });
}

/** Plain text only: never inject server content as highlighted HTML. */
export function messageSnippet(content: string, query: string, limit = 220) {
  const text = content.replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  const lower = text.toLowerCase();
  const term = query.trim().toLowerCase();
  let hit = term ? lower.indexOf(term) : 0;
  if (hit < 0)
    hit =
      term
        .split(/\s+/)
        .map((word) => lower.indexOf(word))
        .find((index) => index >= 0) ?? 0;
  const start = Math.max(0, hit - 60);
  const end = Math.min(text.length, start + limit);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

/** Only valid opaque server IDs leave storage; labels and old access never do. */
export function readRecentDestinationIds(
  server: string,
  user: string,
): string[] {
  return readRecents(server, user).filter((id) =>
    /^(dm|channel|task):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      id,
    ),
  );
}
