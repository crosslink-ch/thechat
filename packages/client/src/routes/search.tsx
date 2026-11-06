import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type { MessageSearchHit } from "@thechat/shared";
import { LoaderCircle, MessageSquare, Search } from "lucide-react";
import { Highlighted, messageLocation } from "../CommandPalette";
import { buttonClass, inputClass } from "../components/ui";
import { useMessageSearch } from "../hooks/useMessageSearch";
import { canSearchMessages, formatSearchTime } from "../lib/search";
import { JumpSupersededError, openSearchMessage } from "../lib/search-navigation";
import { useWorkspacesStore } from "../stores/workspaces";

export interface SearchRouteSearch {
  q?: string;
  conversationId?: string;
  workspaceId?: string;
}

const ID = /^[A-Za-z0-9_-]{1,128}$/;

export function validateSearchRouteSearch(search: Record<string, unknown>): SearchRouteSearch {
  const id = (value: unknown) => (typeof value === "string" && ID.test(value) ? value : undefined);
  return {
    q: typeof search.q === "string" ? search.q.slice(0, 500) : undefined,
    conversationId: id(search.conversationId),
    workspaceId: id(search.workspaceId),
  };
}

/** Full message search: every page of results, with filters in the URL. */
export function SearchRoute() {
  const search = useSearch({ from: "/search" }) as SearchRouteSearch;
  const navigate = useNavigate();
  const workspaces = useWorkspacesStore((state) => state.workspaces);
  const [text, setText] = useState(search.q ?? "");
  const [openError, setOpenError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const sentinel = useRef<HTMLDivElement>(null);

  // Typing updates the URL (replace: no history entry per keystroke).
  useEffect(() => {
    if ((search.q ?? "") === text) return;
    const timer = setTimeout(() => {
      void navigate({ to: "/search", search: { ...search, q: text || undefined }, replace: true });
    }, 250);
    return () => clearTimeout(timer);
  }, [navigate, search, text]);

  const results = useMessageSearch(
    canSearchMessages(text)
      ? { q: text, conversationId: search.conversationId, workspaceId: search.workspaceId, limit: 30 }
      : null,
  );

  // Load the next page when the end of the list scrolls into view.
  useEffect(() => {
    const element = sentinel.current;
    if (!element || !results.hasMore || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) results.loadMore();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [results.hasMore, results.loadMore, results.results.length]);

  const open = async (hit: MessageSearchHit) => {
    setOpening(hit.id);
    setOpenError(null);
    try {
      await openSearchMessage(hit);
    } catch (error) {
      if (!(error instanceof JumpSupersededError)) {
        setOpenError(error instanceof Error ? error.message : "Could not open the message");
      }
    } finally {
      setOpening(null);
    }
  };

  const setWorkspace = (workspaceId: string) =>
    void navigate({
      to: "/search",
      search: { q: text || undefined, workspaceId: workspaceId || undefined, conversationId: undefined },
      replace: true,
    });

  return (
    <div className="flex h-full min-h-0 flex-col bg-base" data-testid="search-page">
      <div className="shrink-0 px-4 pt-6 pb-3 sm:px-8">
        <div className="mx-auto max-w-3xl">
          <h1 className="text-[1.429rem] font-semibold tracking-tight text-text">Search messages</h1>
          <div className="relative mt-3">
            <Search size={16} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-text-dimmed" aria-hidden="true" />
            <input
              className={`${inputClass} pl-9`}
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder='All words must match; "quote a phrase"'
              aria-label="Search messages"
              autoFocus
              spellCheck={false}
            />
            {results.loading && (
              <LoaderCircle size={16} className="absolute top-1/2 right-3 -translate-y-1/2 animate-spin text-text-dimmed" aria-hidden="true" />
            )}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[0.857rem] text-text-muted">
            {workspaces.length > 1 && (
              <select
                aria-label="Workspace"
                className="rounded-md border border-border-strong bg-base px-2 py-1 font-[inherit] text-[0.857rem] text-text"
                value={search.workspaceId ?? ""}
                onChange={(event) => setWorkspace(event.target.value)}
              >
                <option value="">All workspaces</option>
                {workspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>{workspace.name}</option>
                ))}
              </select>
            )}
            {search.conversationId && (
              <button
                type="button"
                className={buttonClass("ghost", "sm")}
                onClick={() => void navigate({ to: "/search", search: { ...search, conversationId: undefined }, replace: true })}
              >
                Only one conversation · clear
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-10 sm:px-8">
        <div className="mx-auto max-w-3xl">
          {(openError || results.error) && (
            <div role="alert" className="mb-3 rounded-lg border border-error-msg-border bg-error-msg-bg px-3 py-2 text-[0.929rem] text-error-bright">
              {openError ?? results.error}
            </div>
          )}
          {!canSearchMessages(text) ? (
            <p className="py-8 text-center text-[0.929rem] text-text-placeholder">Type at least 2 characters.</p>
          ) : results.results.length === 0 && !results.loading ? (
            <p className="py-8 text-center text-[0.929rem] text-text-placeholder">No messages found.</p>
          ) : (
            <ul className="divide-y divide-border-subtle" aria-label="Results">
              {results.results.map((hit) => (
                <li key={hit.id}>
                  <button
                    type="button"
                    data-testid="search-result"
                    className="flex w-full cursor-pointer items-start gap-3 rounded-lg border-none bg-transparent px-2 py-3 text-left font-[inherit] transition-colors duration-100 hover:bg-hover"
                    onClick={() => void open(hit)}
                    disabled={opening !== null}
                  >
                    <MessageSquare size={15} className="mt-1 shrink-0 text-text-dimmed" aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-baseline gap-1.5 text-[0.857rem] text-text-dimmed">
                        <span className="shrink-0 font-medium text-text-secondary">{hit.senderName}</span>
                        <span className="min-w-0 truncate">{messageLocation(hit)}</span>
                        {workspaces.length > 1 && <span className="min-w-0 shrink-[20] truncate">· {hit.workspaceName}</span>}
                        <span className="ml-auto shrink-0 pl-1">{formatSearchTime(hit.createdAt)}</span>
                      </span>
                      <span className="mt-1 block text-[0.929rem] leading-snug text-text-secondary">
                        <Highlighted text={hit.snippet} query={results.query ?? text} />
                      </span>
                    </span>
                    {opening === hit.id && <LoaderCircle size={14} className="mt-1 animate-spin text-text-dimmed" aria-hidden="true" />}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div ref={sentinel} />
          {results.hasMore && (
            <div className="py-4 text-center">
              <button type="button" className={buttonClass("secondary", "sm")} onClick={results.loadMore} disabled={results.loadingMore}>
                {results.loadingMore ? "Loading…" : "Load more"}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
