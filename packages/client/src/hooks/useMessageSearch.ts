import { useCallback, useEffect, useRef, useState } from "react";
import type { MessageSearchHit, MessageSearchPage } from "@thechat/shared";
import { fetchMessageSearch, type MessageSearchParams } from "../lib/search-api";
import { canSearchMessages } from "../lib/search";
import { wsEvents, type WsEvents } from "../lib/ws-events";

/** Wait this long after the last keystroke before asking the server. */
export const MESSAGE_SEARCH_DEBOUNCE_MS = 180;

const CACHE_LIMIT = 30;
const cache = new Map<string, MessageSearchPage>();

function remember(key: string, page: MessageSearchPage) {
  cache.delete(key);
  cache.set(key, page);
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
}

/** Forget cached results (tests, sign-out). */
export function clearMessageSearchCache() {
  cache.clear();
}

export function useDebouncedValue<T>(value: T, delayMs: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    if (Object.is(value, debounced)) return;
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs, debounced]);
  return debounced;
}

export interface MessageSearchState {
  results: MessageSearchHit[];
  /** True while the first page for the current query is on its way. */
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  error: string | null;
  /** The query the shown results belong to. */
  query: string | null;
  loadMore: () => void;
}

function isAbort(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

/**
 * Debounced, cancellable message search. Results for a query stay on screen
 * until the next query's results replace them, so the list never flashes
 * empty while typing. Recently seen queries are answered from memory.
 */
export function useMessageSearch(
  params: Omit<MessageSearchParams, "cursor"> | null,
  options: { debounceMs?: number } = {},
): MessageSearchState {
  const key = params && canSearchMessages(params.q) ? JSON.stringify(params) : null;
  const debouncedKey = useDebouncedValue(key, options.debounceMs ?? MESSAGE_SEARCH_DEBOUNCE_MS);
  const [state, setState] = useState<{
    key: string | null;
    results: MessageSearchHit[];
    nextCursor: string | null;
    loading: boolean;
    loadingMore: boolean;
    error: string | null;
  }>({ key: null, results: [], nextCursor: null, loading: false, loadingMore: false, error: null });
  const moreController = useRef<AbortController | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const onDeleted = ({ messageId }: WsEvents["ws:message_deleted"]) => {
      clearMessageSearchCache();
      moreController.current?.abort();
      setState((current) => ({ ...current, results: current.results.filter((hit) => hit.id !== messageId) }));
      setRevision((value) => value + 1);
    };
    wsEvents.on("ws:message_deleted", onDeleted);
    return () => wsEvents.off("ws:message_deleted", onDeleted);
  }, []);

  useEffect(() => {
    moreController.current?.abort();
    if (!debouncedKey) {
      setState({ key: null, results: [], nextCursor: null, loading: false, loadingMore: false, error: null });
      return;
    }
    const cached = cache.get(debouncedKey);
    if (cached) {
      setState({ key: debouncedKey, results: cached.results, nextCursor: cached.nextCursor, loading: false, loadingMore: false, error: null });
      return;
    }
    const controller = new AbortController();
    setState((current) => ({ ...current, loading: true, error: null }));
    fetchMessageSearch(JSON.parse(debouncedKey) as MessageSearchParams, controller.signal)
      .then((page) => {
        if (controller.signal.aborted) return;
        remember(debouncedKey, page);
        setState({ key: debouncedKey, results: page.results, nextCursor: page.nextCursor, loading: false, loadingMore: false, error: null });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isAbort(error)) return;
        setState((current) => ({
          ...current,
          loading: false,
          error: error instanceof Error ? error.message : "Search failed",
        }));
      });
    return () => controller.abort();
  }, [debouncedKey, revision]);

  // Read in loadMore without re-creating it; updaters must stay side-effect free.
  const stateRef = useRef(state);
  stateRef.current = state;

  const loadMore = useCallback(() => {
    const current = stateRef.current;
    if (!current.key || !current.nextCursor || current.loadingMore || current.loading) return;
    const requestKey = current.key;
    const controller = new AbortController();
    moreController.current?.abort();
    moreController.current = controller;
    setState((latest) => (latest.key === requestKey ? { ...latest, loadingMore: true, error: null } : latest));
    fetchMessageSearch(
      { ...(JSON.parse(requestKey) as MessageSearchParams), cursor: current.nextCursor },
      controller.signal,
    )
      .then((page) => {
        if (controller.signal.aborted) return;
        const latest = stateRef.current;
        if (latest.key !== requestKey) return;
        const seen = new Set(latest.results.map((hit) => hit.id));
        const results = [...latest.results, ...page.results.filter((hit) => !seen.has(hit.id))];
        remember(requestKey, { results, nextCursor: page.nextCursor });
        setState((now) =>
          now.key === requestKey ? { ...now, results, nextCursor: page.nextCursor, loadingMore: false } : now,
        );
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isAbort(error)) return;
        setState((now) =>
          now.key === requestKey
            ? { ...now, loadingMore: false, error: error instanceof Error ? error.message : "Search failed" }
            : now,
        );
      });
  }, []);

  useEffect(() => () => moreController.current?.abort(), []);

  const settled = state.key === key;
  return {
    results: key ? state.results : [],
    loading: Boolean(key) && (!settled || state.loading),
    loadingMore: state.loadingMore,
    hasMore: settled && Boolean(state.nextCursor),
    error: key ? state.error : null,
    query: key && state.key ? (JSON.parse(state.key) as MessageSearchParams).q : null,
    loadMore,
  };
}
