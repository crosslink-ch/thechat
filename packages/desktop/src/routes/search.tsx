import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type { SearchMessageResult } from "@thechat/shared";
import { useAuthStore } from "../stores/auth";
import { sessionGeneration } from "../lib/session-boundary";
import { messageSnippet } from "../lib/search";
import { searchMessages } from "../lib/search-api";
import { useSearchNavigation } from "../hooks/useSearchNavigation";

export function SearchRoute() {
  const { q } = useSearch({ from: "/search" });
  const userId = useAuthStore((s) => s.user?.id);
  const token = useAuthStore((s) => s.token);
  return (
    <MessageResults
      key={JSON.stringify([q, userId, token])}
      q={q}
      token={token}
    />
  );
}
function MessageResults({ q, token }: { q: string; token: string | null }) {
  const navigate = useNavigate();
  const openDestination = useSearchNavigation();
  const [input, setInput] = useState(q);
  const [items, setItems] = useState<SearchMessageResult[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const offset = useRef(0);
  const busy = useRef(false);
  const alive = useRef(true);
  const generation = sessionGeneration();
  const current = () => alive.current && generation === sessionGeneration();
  async function load() {
    if (busy.current || !q.trim()) return;
    busy.current = true;
    setLoading(true);
    setError(null);
    try {
      const data = await searchMessages(
        { q, limit: 20, offset: offset.current },
        token,
      );
      if (!current()) return;
      offset.current += data.items.length;
      setItems((previous) => [
        ...new Map(
          [...previous, ...data.items].map((item) => [item.id, item]),
        ).values(),
      ]);
      setHasMore(data.hasMore);
      setTruncated(data.truncated ?? false);
    } catch (cause) {
      if (current())
        setError(cause instanceof Error ? cause.message : "Search failed");
    } finally {
      if (current()) {
        busy.current = false;
        setLoading(false);
      }
    }
  }
  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
    // The keyed component owns exactly one query and identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  async function open(item: SearchMessageResult) {
    if (opening) return;
    setOpening(true);
    setError(null);
    try {
      await openDestination(item, current);
    } catch (cause) {
      if (current())
        setError(
          cause instanceof Error ? cause.message : "Could not open result",
        );
    } finally {
      if (current()) setOpening(false);
    }
  }
  return (
    <section
      className="flex min-h-0 min-w-0 flex-1 flex-col text-text"
      aria-label="Message search results"
    >
      <div className="shrink-0 border-b border-border px-4 py-4">
        <h1 className="text-lg font-semibold">Search messages</h1>
        <p className="mb-3 text-sm text-text-muted">
          Across all your current workspaces
        </p>
        <form
          role="search"
          className="flex min-w-0 gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void navigate({ to: "/search", search: { q: input.trim() } });
          }}
        >
          <input
            type="search"
            aria-label="Search messages"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            className="min-w-0 flex-1 rounded border border-border bg-surface px-3 py-2 text-base"
          />
          <button
            type="submit"
            className="shrink-0 rounded bg-elevated px-3 py-2 text-sm hover:bg-hover"
          >
            Search
          </button>
        </form>
      </div>
      <div
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4"
        aria-busy={loading}
      >
        <div className="mx-auto max-w-3xl">
          {error && (
            <div role="alert" className="mb-3 text-sm text-error-bright">
              {error}
              <button onClick={() => void load()} className="ml-3 underline">
                Retry search
              </button>
            </div>
          )}
          <ul className="space-y-2">
            {items.map((item) => (
              <li key={item.id}>
                <button
                  disabled={opening}
                  onClick={() => void open(item)}
                  className="block w-full min-w-0 rounded-lg border border-border bg-surface p-4 text-left hover:bg-hover disabled:opacity-60"
                >
                  <span className="block break-words text-sm font-medium">
                    {item.workspaceName} ·{" "}
                    {item.conversationType === "group" ? "# " : ""}
                    {item.conversationName}
                    {item.threadTitle ? ` · ${item.threadTitle}` : ""}
                  </span>
                  <span className="mt-1 block text-xs text-text-dimmed">
                    {item.senderName} ·{" "}
                    <time dateTime={item.createdAt}>
                      {new Date(item.createdAt).toLocaleString()}
                    </time>
                  </span>
                  <span className="mt-2 line-clamp-4 block break-words text-sm text-text-muted">
                    {messageSnippet(item.content, q) || "Attachment"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {loading && (
            <p
              role="status"
              className="py-5 text-center text-sm text-text-muted"
            >
              Searching...
            </p>
          )}
          {!loading && !items.length && !error && (
            <p className="py-8 text-center text-text-muted">
              {q.trim()
                ? "No matching messages"
                : "Type a message to search for"}
            </p>
          )}
          {truncated && (
            <p role="status" className="py-5 text-center text-sm text-text-muted">
              Result limit reached. Refine your search.
            </p>
          )}
          {hasMore && !truncated && (
            <button
              disabled={loading}
              onClick={() => void load()}
              className="mx-auto mt-4 block rounded border border-border px-4 py-2 text-sm disabled:opacity-60"
            >
              Load more results
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
