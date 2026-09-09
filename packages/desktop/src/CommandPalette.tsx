import { useState, useRef, useEffect, useId } from "react";
import { create } from "zustand";
import { useNavigate } from "@tanstack/react-router";
import type { SearchDestination, SearchMessageResult } from "@thechat/shared";
import { useCommandsStore } from "./commands";
import { requestInputBarFocus } from "./stores/input-focus";
import { useAuthStore } from "./stores/auth";
import { useWorkspacesStore } from "./stores/workspaces";
import { API_URL } from "./lib/api";
import { onSessionReset, sessionGeneration } from "./lib/session-boundary";
import {
  parseSearchQuery,
  searchModeQuery,
  retainSelection,
  recentDestinations,
  rememberDestination,
  readRecentDestinationIds,
  messageSnippet,
  type SearchMode,
  type DestinationKind,
} from "./lib/search";
import { searchJump, searchMessages } from "./lib/search-api";
import { useSearchNavigation } from "./hooks/useSearchNavigation";

const usePaletteState = create(() => ({
  open: false,
  initialQuery: "",
  revision: 0,
}));
let returnFocus: HTMLElement | null = null;
function openPalette(initialQuery: string) {
  if (!usePaletteState.getState().open)
    returnFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
  usePaletteState.setState((s) => ({
    open: true,
    initialQuery,
    revision: s.revision + 1,
  }));
}
export const togglePalette = () =>
  usePaletteState.getState().open ? dismissPalette() : openPalette("");
export const closePalette = () =>
  usePaletteState.setState({ open: false, initialQuery: "" });
function dismissPalette() {
  closePalette();
  if (returnFocus?.isConnected) returnFocus.focus();
}
export function closePaletteAndRefocus() {
  closePalette();
  requestInputBarFocus();
}
export const openPaletteInCommandMode = () => openPalette(">");
onSessionReset(closePalette);

export function CommandPalette() {
  const { open, revision } = usePaletteState();
  const userId = useAuthStore((s) => s.user?.id);
  const token = useAuthStore((s) => s.token);
  if (!open) return null;
  return <CommandPaletteInner key={`${revision}:${userId}:${token}`} />;
}

type Row = {
  id: string;
  label: string;
  detail?: string;
  snippet?: string;
  shortcut?: string | null;
  execute: () => void;
};
function CommandPaletteInner() {
  const commands = useCommandsStore((s) => s.commands);
  const initialQuery = usePaletteState((s) => s.initialQuery);
  const token = useAuthStore((s) => s.token);
  const userId = useAuthStore((s) => s.user?.id);
  const workspaceId = useWorkspacesStore((s) => s.activeWorkspace?.id);
  const [query, setQuery] = useState(initialQuery);
  const [taskOnly, setTaskOnly] = useState(false);
  const parsed = parseSearchQuery(query);
  const { mode, q } = parsed;
  const kind: DestinationKind =
    mode === "jump" && parsed.kind === "all" && taskOnly ? "task" : parsed.kind;
  const [selected, setSelected] = useState<string | null>(null);
  const [result, setResult] = useState<{
    key: string;
    items: (SearchDestination | SearchMessageResult)[];
    hasMore: boolean;
    truncated?: boolean;
    offset: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const pageRequest = useRef<symbol | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  const composing = useRef(false);
  const listId = useId();
  const navigate = useNavigate();
  const openDestination = useSearchNavigation();
  const recentIds =
    !q && userId
      ? readRecentDestinationIds(API_URL, userId).join(",") || undefined
      : undefined;
  const requestKey = JSON.stringify([
    mode,
    kind,
    q,
    userId,
    token,
    workspaceId,
    recentIds,
  ]);
  const currentRequestKey = useRef(requestKey);
  currentRequestKey.current = requestKey;
  // Switching workspace changes the ranking hint, not the selected navigation intent.
  const intentKey = JSON.stringify([mode, kind, q, userId, token]);
  const currentKey = useRef(intentKey);
  currentKey.current = intentKey;
  const generation = sessionGeneration();
  const current = () =>
    alive.current &&
    usePaletteState.getState().open &&
    generation === sessionGeneration() &&
    useAuthStore.getState().user?.id === userId &&
    useAuthStore.getState().token === token;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    // A composer can mount after navigation resolves, and Tiptap focuses on a
    // later animation frame. The modal owns focus until it closes, including
    // programmatic focus changes, not just Tab key navigation.
    let lastInside: HTMLElement | null = inputRef.current;
    const containFocus = (event: FocusEvent) => {
      if (!alive.current || !usePaletteState.getState().open) return;
      if (
        event.target instanceof HTMLElement &&
        panelRef.current?.contains(event.target)
      ) {
        lastInside = event.target;
      } else {
        (lastInside?.isConnected ? lastInside : inputRef.current)?.focus({
          preventScroll: true,
        });
      }
    };
    document.addEventListener("focusin", containFocus);
    return () => document.removeEventListener("focusin", containFocus);
  }, []);

  useEffect(() => {
    let cancelled = false;
    pageRequest.current = null;
    setLoadingMore(false);
    setError(null);
    if (mode === "commands" || (mode === "messages" && !q) || !userId) {
      setResult({ key: requestKey, items: [], hasMore: false, offset: 0 });
      return;
    }
    const debounce = window.setTimeout(() => {
      const request =
        mode === "jump"
          ? searchJump(
              {
                q,
                kind,
                workspaceId,
                limit: 30,
                offset: 0,
                ...(recentIds ? { recentIds } : {}),
              },
              token,
            )
          : searchMessages({ q, limit: 5, offset: 0 }, token);
      request
        .then((data) => {
          if (cancelled || generation !== sessionGeneration()) return;
          const received: (SearchDestination | SearchMessageResult)[] =
            data.items;
          const items =
            mode === "jump" && !q
              ? recentDestinations(API_URL, userId, received)
              : received;
          setResult({
            key: requestKey,
            items,
            hasMore: data.hasMore,
            truncated: data.truncated,
            offset: data.items.length,
          });
        })
        .catch((cause: unknown) => {
          if (cancelled || generation !== sessionGeneration()) return;
          setError(
            cause instanceof Error
              ? cause.message
              : "Search failed. Try again.",
          );
          setResult({ key: requestKey, items: [], hasMore: false, offset: 0 });
        });
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(debounce);
    };
  }, [
    requestKey,
    mode,
    kind,
    q,
    userId,
    token,
    workspaceId,
    generation,
    recentIds,
  ]);

  async function selectDestination(
    item: SearchDestination | SearchMessageResult,
  ) {
    if (busy) return;
    const key = intentKey;
    setBusy(true);
    setError(null);
    try {
      if (
        await openDestination(
          item,
          () => current() && currentKey.current === key,
        )
      ) {
        if ("kind" in item && userId)
          rememberDestination(API_URL, userId, item.id);
        closePalette();
      }
    } catch (cause) {
      if (current() && currentKey.current === key)
        setError(
          cause instanceof Error ? cause.message : "Could not open result",
        );
    } finally {
      if (current()) setBusy(false);
    }
  }
  async function loadMoreDestinations() {
    if (pageRequest.current || result?.key !== requestKey || !result.hasMore || result.truncated)
      return;
    const attempt = Symbol("destination-page");
    pageRequest.current = attempt;
    setLoadingMore(true);
    setError(null);
    try {
      const data = await searchJump(
        {
          q,
          kind,
          workspaceId,
          limit: 30,
          offset: result.offset,
          ...(recentIds ? { recentIds } : {}),
        },
        token,
      );
      if (!current() || currentRequestKey.current !== requestKey) return;
      setResult((previous) =>
        previous?.key === requestKey
          ? {
              key: requestKey,
              items: [
                ...new Map(
                  [...previous.items, ...data.items].map((item) => [
                    item.id,
                    item,
                  ]),
                ).values(),
              ],
              offset: previous.offset + data.items.length,
              hasMore: data.hasMore,
              truncated: data.truncated,
            }
          : previous,
      );
    } catch (cause) {
      if (current() && currentRequestKey.current === requestKey)
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not load more destinations",
        );
    } finally {
      if (pageRequest.current === attempt) {
        pageRequest.current = null;
        if (current()) setLoadingMore(false);
      }
    }
  }
  const rows: Row[] =
    mode === "commands"
      ? commands
          .filter(
            (cmd) =>
              !cmd.hidden && cmd.label.toLowerCase().includes(q.toLowerCase()),
          )
          .map((cmd) => ({ ...cmd, execute: cmd.execute }))
      : (result?.key === requestKey ? result.items : []).map((item) => ({
          id: item.id,
          label: "kind" in item ? item.title : item.senderName,
          detail:
            "kind" in item
              ? `${item.workspaceName} · ${item.kind === "task" ? `Task in ${item.conversationName}` : item.kind === "dm" ? (item.participantType === "bot" ? "Bot DM" : "DM") : "Channel"}`
              : `${item.workspaceName} · ${item.conversationName}${item.threadTitle ? ` · ${item.threadTitle}` : ""} · ${new Date(item.createdAt).toLocaleString()}`,
          snippet:
            "content" in item ? messageSnippet(item.content, q) : undefined,
          execute: () => {
            void selectDestination(item);
          },
        }));
  if (mode === "jump" && result?.key === requestKey && result.hasMore && !result.truncated)
    rows.push({
      id: "load-more",
      label: loadingMore ? "Loading destinations..." : "Load more destinations",
      execute: () => {
        void loadMoreDestinations();
      },
    });
  if (mode === "messages" && q)
    rows.push({
      id: "view-all",
      label: "View all results",
      execute: () => {
        void navigate({ to: "/search", search: { q } });
        closePalette();
      },
    });
  const selectedId = retainSelection(selected, rows);
  const index = rows.findIndex((row) => row.id === selectedId);
  const optionId = (id: string) => `${listId}-${encodeURIComponent(id)}`;
  useEffect(() => {
    if (selectedId)
      document
        .getElementById(optionId(selectedId))
        ?.scrollIntoView({ block: "nearest" });
  }, [selectedId, listId]);

  function changeQuery(value: string) {
    setQuery(value);
    setSelected(null);
    const next = parseSearchQuery(value);
    if (next.mode !== "jump" || next.kind !== "all") setTaskOnly(false);
  }
  function changeMode(next: SearchMode, filter: DestinationKind = "all") {
    setTaskOnly(next === "jump" && filter === "task");
    changeQuery(searchModeQuery(query, next, filter));
    inputRef.current?.focus();
  }
  function onKeyDown(e: React.KeyboardEvent) {
    if (e.nativeEvent.isComposing || composing.current || e.keyCode === 229)
      return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      dismissPalette();
    } else if (
      ["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key) &&
      e.target === inputRef.current
    ) {
      e.preventDefault();
      const next =
        e.key === "Home"
          ? 0
          : e.key === "End"
            ? rows.length - 1
            : Math.max(
                0,
                Math.min(
                  rows.length - 1,
                  index + (e.key === "ArrowDown" ? 1 : -1),
                ),
              );
      setSelected(rows[next]?.id ?? null);
    } else if (e.key === "Enter" && e.target === inputRef.current) {
      e.preventDefault();
      if (!busy) rows[index]?.execute();
    } else if (e.key === "Tab") {
      const focusable = Array.from(
        panelRef.current?.querySelectorAll<HTMLElement>(
          'input, button:not([disabled]):not([tabindex="-1"])',
        ) ?? [],
      );
      if (e.shiftKey && document.activeElement === focusable[0]) {
        e.preventDefault();
        focusable.at(-1)?.focus();
      } else if (!e.shiftKey && document.activeElement === focusable.at(-1)) {
        e.preventDefault();
        focusable[0]?.focus();
      }
    }
  }
  const loading = mode !== "commands" && result?.key !== requestKey;
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-overlay p-3 pt-[max(12px,8dvh)] backdrop-blur-[2px]"
      onClick={dismissPalette}
      style={{
        height: "var(--app-viewport-height, 100dvh)",
        top: "var(--app-viewport-top, 0px)",
      }}
    >
      <div
        style={{ maxHeight: "100%", overflow: "hidden" }}
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Search and navigate"
        data-testid="palette-panel"
        className="flex w-full min-w-0 max-w-[620px] flex-col overflow-hidden rounded-xl border border-border-strong bg-surface text-text shadow-card"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="flex shrink-0 items-center border-b border-border">
          <input
            ref={inputRef}
            role="combobox"
            aria-label="Search"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={
              selectedId ? optionId(selectedId) : undefined
            }
            className="min-w-0 flex-1 bg-transparent px-4 py-3 text-base text-text outline-none placeholder:text-text-placeholder"
            placeholder={
              mode === "commands"
                ? "Type a command..."
                : mode === "messages"
                  ? "Search messages..."
                  : "Jump to a DM, channel, or task..."
            }
            autoFocus
            value={query}
            onChange={(e) => changeQuery(e.target.value)}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
          />
          <button
            type="button"
            aria-label="Close search"
            onClick={dismissPalette}
            className="m-1 shrink-0 rounded px-3 py-2 text-text-muted hover:bg-hover"
          >
            ✕
          </button>
        </div>
        <div
          className="flex shrink-0 flex-wrap gap-1 border-b border-border p-2"
          aria-label="Search modes"
        >
          {(
            [
              ["jump", "Jump to"],
              ["messages", "Messages"],
              ["commands", "Commands"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={mode === value}
              onClick={() => changeMode(value)}
              className={`rounded px-3 py-2 text-sm ${mode === value ? "bg-elevated text-text" : "text-text-muted hover:bg-hover"}`}
            >
              {label}
            </button>
          ))}
        </div>
        {mode === "jump" && (
          <div
            className="flex shrink-0 flex-wrap gap-1 px-2 pt-2"
            aria-label="Destination filters"
          >
            {(
              [
                ["all", "All"],
                ["dm", "DMs"],
                ["channel", "Channels"],
                ["task", "Tasks"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={kind === value}
                onClick={() => changeMode("jump", value)}
                className={`rounded px-3 py-1.5 text-xs ${kind === value ? "bg-elevated" : "text-text-muted hover:bg-hover"}`}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        <div className="px-4 py-2 text-xs text-text-dimmed">
          {mode === "jump"
            ? `${q ? "Destinations" : "Recent destinations"} · All workspaces`
            : mode === "messages"
              ? "Messages · All workspaces"
              : "Commands"}
        </div>
        {mode !== "commands" && result?.key === requestKey && result.truncated && (
          <p role="status" className="px-4 py-2 text-sm text-text-muted">
            Result limit reached. Refine your search.
          </p>
        )}
        {error && (
          <p role="alert" className="px-4 py-2 text-sm text-error-bright">
            {error}
          </p>
        )}
        <div
          id={listId}
          role="listbox"
          aria-label="Search results"
          aria-busy={loading || loadingMore || busy}
          className="min-h-0 overflow-y-auto overscroll-contain"
        >
          {rows.map((row) => (
            <button
              key={row.id}
              id={optionId(row.id)}
              role="option"
              aria-selected={row.id === selectedId}
              tabIndex={-1}
              disabled={busy}
              data-testid="palette-item"
              className={`flex w-full min-w-0 items-center gap-2 px-4 py-3 text-left text-sm ${row.id === selectedId ? "bg-elevated text-text" : "text-text-muted hover:bg-hover"}`}
              onClick={row.execute}
              onMouseEnter={() => setSelected(row.id)}
            >
              <span className="min-w-0 flex-1">
                <span className="block break-words">{row.label}</span>
                {row.detail && (
                  <span className="mt-0.5 block break-words text-xs text-text-dimmed">
                    {row.detail}
                  </span>
                )}
                {row.snippet && (
                  <span className="mt-1 line-clamp-2 break-words text-sm text-text-muted">
                    {row.snippet}
                  </span>
                )}
              </span>
              {row.shortcut && (
                <kbd className="shrink-0 rounded border border-border bg-base px-1.5 py-0.5 text-xs text-text-dimmed">
                  {row.shortcut}
                </kbd>
              )}
            </button>
          ))}
          {loading && (
            <p
              role="status"
              className="px-4 py-5 text-center text-sm text-text-muted"
            >
              Searching...
            </p>
          )}
          {!loading &&
            !error &&
            mode === "messages" &&
            q &&
            result?.items.length === 0 && (
              <p className="px-4 py-5 text-center text-sm text-text-muted">
                No matching messages
              </p>
            )}
          {!loading && rows.length === 0 && (
            <p className="px-4 py-5 text-center text-sm text-text-muted">
              {mode === "commands"
                ? "No matching commands"
                : mode === "messages" && !q
                  ? "Type a message to search for"
                  : "No matching destinations"}
            </p>
          )}
        </div>
        <div className="shrink-0 border-t border-border px-4 py-2 text-xs text-text-dimmed">
          ↑ ↓ to navigate · Enter to open · Esc to close
        </div>
      </div>
    </div>
  );
}
