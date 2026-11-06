import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { MessageSearchHit, SearchDestination } from "@thechat/shared";
import { ArrowUpRight, Hash, ListTodo, LoaderCircle, MessageSquare, Search, TerminalSquare } from "lucide-react";
import { useCommandsStore, type Command } from "./commands";
import { requestInputBarFocus } from "./stores/input-focus";
import { useWorkspacesStore } from "./stores/workspaces";
import { useRecentLocationsStore } from "./stores/recent-locations";
import { useSearchDirectoryStore } from "./stores/search-directory";
import { useDmHeaderStore } from "./stores/chat-header";
import { dialogSurfaceClass, menuItemBaseClass } from "./components/ui";
import { Avatar } from "./components/Avatar";
import { useDebouncedValue, useMessageSearch } from "./hooks/useMessageSearch";
import { fetchDestinations } from "./lib/search-api";
import {
  canSearchMessages,
  destinationKey,
  destinationName,
  formatSearchTime,
  highlightParts,
  listDestinations,
  parsePaletteQuery,
  rankDestinations,
  type DestinationKind,
  type PaletteMode,
} from "./lib/search";
import {
  JumpSupersededError,
  openSearchDestination,
  openSearchMessage,
  searchNavigate,
} from "./lib/search-navigation";
import { openPalette, usePaletteState } from "./lib/palette-state";

export { usePaletteState } from "./lib/palette-state";

/** Ctrl+K / Ctrl+P: open the quick switcher, or close it when open. */
export const togglePalette = () => {
  if (usePaletteState.getState().open) closePalette();
  else openPalette("all");
};

export const closePalette = () => usePaletteState.setState({ open: false, initialQuery: "" });

/** Close the palette and request the active message input to re-focus. */
export function closePaletteAndRefocus() {
  closePalette();
  requestInputBarFocus();
}

/** Ctrl+Shift+P: commands only. */
export const openPaletteInCommandMode = () => openPalette("commands");

/** Ctrl+Shift+F: search message text. */
export const openMessageSearch = (initialQuery = "") => openPalette("messages", initialQuery);

export function CommandPalette() {
  const open = usePaletteState((state) => state.open);
  const session = usePaletteState((state) => state.session);
  if (!open) return null;
  return <CommandPaletteInner key={session} />;
}

const MODES: { mode: PaletteMode; label: string }[] = [
  { mode: "all", label: "All" },
  { mode: "people", label: "People" },
  { mode: "channels", label: "Channels" },
  { mode: "tasks", label: "Tasks" },
  { mode: "messages", label: "Messages" },
  { mode: "commands", label: "Commands" },
];

const MODE_KINDS: Partial<Record<PaletteMode, ReadonlySet<DestinationKind>>> = {
  people: new Set(["person"]),
  channels: new Set(["channel"]),
  tasks: new Set(["task"]),
};

const PLACEHOLDERS: Record<PaletteMode, string> = {
  all: "Jump to a channel, person or task, or search messages…",
  people: "Find a person or bot…",
  channels: "Find a channel…",
  tasks: "Find a task by title…",
  messages: "Search message text…",
  commands: "Type a command...",
};

type PaletteItem =
  | { type: "destination"; key: string; destination: SearchDestination }
  | { type: "message"; key: string; hit: MessageSearchHit }
  | { type: "all-messages"; key: string; query: string }
  | { type: "load-more"; key: string }
  | { type: "command"; key: string; command: Command };

interface Section {
  title: string | null;
  items: PaletteItem[];
}

const ALL_MODE_MESSAGE_PREVIEWS = 4;
const SERVER_TASK_LOOKUP_DEBOUNCE_MS = 150;

function matchCommands(commands: Command[], text: string) {
  const query = text.toLowerCase();
  return commands.filter((command) => !command.hidden && command.label.toLowerCase().includes(query));
}

/** Tasks older than the cached directory holds, looked up by title on the server. */
function useServerTaskLookup(text: string, enabled: boolean) {
  const debounced = useDebouncedValue(enabled && text.length >= 2 ? text : "", SERVER_TASK_LOOKUP_DEBOUNCE_MS);
  const [found, setFound] = useState<{ text: string; tasks: SearchDestination[] }>({ text: "", tasks: [] });
  useEffect(() => {
    if (!debounced) return;
    const controller = new AbortController();
    fetchDestinations({ q: debounced, kinds: ["task"], limit: 10 }, controller.signal)
      .then((tasks) => {
        if (!controller.signal.aborted) setFound({ text: debounced, tasks });
      })
      .catch(() => {});
    return () => controller.abort();
  }, [debounced]);
  return enabled && found.text && text.startsWith(found.text) ? found.tasks : [];
}

/** The conversation on screen, for "only in this conversation" search. */
function useCurrentConversation() {
  const current = useRecentLocationsStore((state) => state.current);
  const channelName = useWorkspacesStore((state) =>
    current?.type === "group"
      ? state.activeWorkspace?.channels.find((channel) => channel.id === current.conversationId)?.name ?? null
      : null,
  );
  const dmTitle = useDmHeaderStore((state) =>
    current?.type === "direct" && state.identity?.conversationId === current.conversationId
      ? state.identity.title
      : null,
  );
  if (!current) return null;
  return {
    conversationId: current.conversationId,
    label: current.type === "group" ? (channelName ? `#${channelName}` : "this channel") : dmTitle || "this conversation",
  };
}

function CommandPaletteInner() {
  const commands = useCommandsStore((state) => state.commands);
  const initialQuery = usePaletteState((state) => state.initialQuery);
  const initialMode = usePaletteState((state) => state.mode);
  const directory = useSearchDirectoryStore((state) => state.destinations);
  const directoryLoaded = useSearchDirectoryStore((state) => state.loaded);
  const directoryError = useSearchDirectoryStore((state) => state.error);
  const recent = useRecentLocationsStore((state) => state.keys);
  const activeWorkspaceId = useWorkspacesStore((state) => state.activeWorkspace?.id ?? null);
  const multipleWorkspaces = useWorkspacesStore((state) => state.workspaces.length > 1);
  const currentConversation = useCurrentConversation();

  const [query, setQuery] = useState(initialQuery);
  const [chipMode, setChipMode] = useState<PaletteMode>(initialMode);
  const [onlyHere, setOnlyHere] = useState(false);
  const [highlightKey, setHighlightKey] = useState<string | null>(null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // Enter pressed before the list of places arrived: run it once it has.
  const [enterQueued, setEnterQueued] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void useSearchDirectoryStore.getState().ensure();
  }, []);

  const parsed = parsePaletteQuery(query);
  const mode = parsed.mode === "all" ? chipMode : parsed.mode;
  const text = parsed.text;
  const scopeConversationId = onlyHere && currentConversation ? currentConversation.conversationId : undefined;

  const wantsMessages = (mode === "all" || mode === "messages") && canSearchMessages(text);
  const messageSearch = useMessageSearch(
    wantsMessages
      ? { q: text, conversationId: scopeConversationId, limit: mode === "messages" ? 20 : ALL_MODE_MESSAGE_PREVIEWS }
      : null,
  );
  const serverTasks = useServerTaskLookup(text, mode === "all" || mode === "tasks");

  const sections = useMemo<Section[]>(() => {
    const pool = (() => {
      if (serverTasks.length === 0) return directory;
      const keys = new Set(directory.map(destinationKey));
      return [...directory, ...serverTasks.filter((task) => !keys.has(destinationKey(task)))];
    })();
    const destinationItems = (list: SearchDestination[]): PaletteItem[] =>
      list.map((destination) => ({ type: "destination", key: destinationKey(destination), destination }));
    const commandItems = (list: Command[]): PaletteItem[] =>
      list.map((command) => ({ type: "command", key: `command:${command.id}`, command }));
    const rankOptions = { recent, activeWorkspaceId };

    if (mode === "commands") return [{ title: null, items: commandItems(matchCommands(commands, text)) }];

    if (mode === "messages") {
      const items: PaletteItem[] = messageSearch.results.map((hit) => ({ type: "message", key: `message:${hit.id}`, hit }));
      if (messageSearch.hasMore) items.push({ type: "load-more", key: "load-more" });
      return [{ title: null, items }];
    }

    const kinds = MODE_KINDS[mode];
    if (kinds) {
      const list = text
        ? rankDestinations(pool, text, { ...rankOptions, kinds, limit: 30 })
        : listDestinations(pool, { ...rankOptions, kinds, limit: 50 });
      return [{ title: null, items: destinationItems(list) }];
    }

    // All: places, then commands, then message previews (which arrive last,
    // below everything else, so they never move the highlighted row).
    if (!text) {
      const recentPlaces = rankDestinations(pool, "", { ...rankOptions, limit: 8 });
      if (recentPlaces.length > 0) return [{ title: "Recent", items: destinationItems(recentPlaces) }];
      const here = pool.filter((destination) => destination.workspaceId === activeWorkspaceId && destination.kind !== "task");
      return [{ title: "Go to", items: destinationItems(listDestinations(here, { ...rankOptions, limit: 8 })) }];
    }
    const result: Section[] = [
      { title: "Go to", items: destinationItems(rankDestinations(pool, text, { ...rankOptions, limit: 8 })) },
      { title: "Commands", items: commandItems(matchCommands(commands, text).slice(0, 4)) },
    ];
    if (canSearchMessages(text)) {
      result.push({
        title: "Messages",
        items: [
          ...messageSearch.results
            .slice(0, ALL_MODE_MESSAGE_PREVIEWS)
            .map((hit): PaletteItem => ({ type: "message", key: `message:${hit.id}`, hit })),
          { type: "all-messages", key: "all-messages", query: text },
        ],
      });
    }
    return result.filter((section) => section.items.length > 0);
  }, [activeWorkspaceId, commands, directory, messageSearch.hasMore, messageSearch.results, mode, recent, serverTasks, text]);

  const items = useMemo(() => sections.flatMap((section) => section.items), [sections]);

  // The highlight follows a row by identity, so late results never move it.
  const highlighted = items.find((item) => item.key === highlightKey) ?? items[0] ?? null;
  const highlightIndex = highlighted ? items.indexOf(highlighted) : -1;

  // Typing starts over at the best match.
  useEffect(() => {
    setHighlightKey(null);
  }, [text, mode]);

  useEffect(() => {
    if (!highlighted) return;
    const rows = listRef.current?.querySelectorAll<HTMLElement>("[data-palette-key]") ?? [];
    for (const row of rows) {
      if (row.dataset.paletteKey === highlighted.key) {
        row.scrollIntoView({ block: "nearest" });
        break;
      }
    }
  }, [highlighted]);

  useEffect(() => {
    if (!enterQueued || (!directoryLoaded && !directoryError)) return;
    setEnterQueued(false);
    if (highlighted) void run(highlighted);
    // Runs once, when the places arrive; `highlighted` is then the best match.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enterQueued, directoryLoaded, directoryError]);

  // Typing again cancels a queued Enter.
  useEffect(() => {
    setEnterQueued(false);
  }, [query]);

  const setMode = (next: PaletteMode) => {
    setChipMode(next);
    // A typed prefix would override the chosen filter: drop it.
    if (parsed.mode !== "all") setQuery(text);
    setActionError(null);
    inputRef.current?.focus();
  };

  const run = async (item: PaletteItem) => {
    if (pendingKey) return;
    setActionError(null);
    if (item.type === "command") {
      item.command.execute();
      return;
    }
    if (item.type === "load-more") {
      messageSearch.loadMore();
      return;
    }
    setPendingKey(item.key);
    try {
      if (item.type === "destination") await openSearchDestination(item.destination);
      else if (item.type === "message") await openSearchMessage(item.hit);
      else await searchNavigate({ to: "/search", search: { q: item.query, conversationId: scopeConversationId } });
      closePalette();
    } catch (error) {
      if (error instanceof JumpSupersededError) return;
      setActionError(error instanceof Error ? error.message : "Could not open that");
    } finally {
      setPendingKey(null);
    }
  };

  const move = (delta: number) => {
    if (items.length === 0) return;
    const next = Math.min(Math.max(highlightIndex + delta, 0), items.length - 1);
    setHighlightKey(items[next]!.key);
    if (mode === "messages" && next >= items.length - 2 && messageSearch.hasMore) messageSearch.loadMore();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || (event.key === "n" && event.ctrlKey)) {
      event.preventDefault();
      move(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
    } else if (event.key === "PageDown") {
      event.preventDefault();
      move(8);
    } else if (event.key === "PageUp") {
      event.preventDefault();
      move(-8);
    } else if (event.key === "Enter") {
      event.preventDefault();
      // Never let a name typed straight after sign-in fall through to
      // message search just because the places are still loading.
      if (!directoryLoaded && !directoryError && text && mode !== "messages" && mode !== "commands") {
        setEnterQueued(true);
        return;
      }
      if (highlighted) void run(highlighted);
    } else if (event.key === "Tab") {
      event.preventDefault();
      const index = MODES.findIndex((entry) => entry.mode === mode);
      setMode(MODES[(index + (event.shiftKey ? MODES.length - 1 : 1)) % MODES.length]!.mode);
    } else if (event.key === "Backspace" && query === "" && chipMode !== "all") {
      event.preventDefault();
      setMode("all");
    } else if (event.key === "Escape") {
      event.preventDefault();
      closePaletteAndRefocus();
    }
  };

  const searching = wantsMessages && messageSearch.loading;
  const emptyText =
    mode === "commands"
      ? "No matching commands"
      : mode === "messages"
        ? !canSearchMessages(text)
          ? "Type at least 2 characters to search messages"
          : searching
            ? "Searching…"
            : messageSearch.error ?? "No messages found"
        : !directoryLoaded && !directoryError
          ? "Loading…"
          : directoryError ?? "Nothing found";

  return (
    <div
      className="fixed inset-0 z-20 flex items-start justify-center bg-overlay px-3 pt-[8vh] backdrop-blur-[2px] animate-overlay-in sm:px-4 sm:pt-[14vh]"
      onClick={closePaletteAndRefocus}
    >
      <div
        data-testid="palette-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Quick switcher"
        className={`flex max-h-[80vh] w-full max-w-[640px] flex-col overflow-hidden animate-dialog-in ${dialogSurfaceClass}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="relative shrink-0">
          <Search size={16} className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-text-dimmed" aria-hidden="true" />
          <input
            ref={inputRef}
            className="h-[52px] w-full border-b border-border bg-transparent pr-10 pl-11 font-[inherit] text-[1.071rem] text-text outline-none placeholder:text-text-placeholder"
            placeholder={PLACEHOLDERS[mode]}
            aria-label="Search TheChat"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
          />
          {(pendingKey || searching || enterQueued) && (
            <LoaderCircle
              size={16}
              data-testid="palette-busy"
              className="absolute top-1/2 right-4 -translate-y-1/2 animate-spin text-text-dimmed"
              aria-hidden="true"
            />
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border-subtle px-2 py-1.5" role="toolbar" aria-label="Search filters">
          {MODES.map((entry) => (
            <button
              key={entry.mode}
              type="button"
              aria-pressed={mode === entry.mode}
              className={`shrink-0 cursor-pointer rounded-md border-none px-2 py-1 font-[inherit] text-[0.786rem] transition-colors duration-100 ${
                mode === entry.mode ? "bg-elevated text-text" : "bg-transparent text-text-dimmed hover:bg-hover hover:text-text"
              }`}
              onClick={() => setMode(entry.mode)}
            >
              {entry.label}
            </button>
          ))}
          {(mode === "messages" || mode === "all") && currentConversation && (
            <button
              type="button"
              aria-pressed={onlyHere}
              title="Search only the conversation you have open"
              className={`ml-auto max-w-[45%] shrink-0 cursor-pointer truncate rounded-md border px-2 py-0.5 font-[inherit] text-[0.786rem] ${
                onlyHere ? "border-accent/50 bg-accent/10 text-text" : "border-border-subtle bg-transparent text-text-dimmed hover:text-text"
              }`}
              onClick={() => {
                setOnlyHere((value) => !value);
                inputRef.current?.focus();
              }}
            >
              {onlyHere ? `✓ Only in ${currentConversation.label}` : `Limit to ${currentConversation.label}`}
            </button>
          )}
        </div>

        {actionError && (
          <div role="alert" className="shrink-0 border-b border-error-msg-border bg-error-msg-bg px-4 py-2 text-[0.857rem] text-error-bright">
            {actionError}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto p-1.5" ref={listRef} data-testid="palette-results">
          {sections.map((section, sectionIndex) =>
            section.items.length === 0 ? null : (
              <div key={section.title ?? sectionIndex} role="group" aria-label={section.title ?? undefined}>
                {section.title && (
                  <div className="px-2.5 pt-2 pb-1 text-[0.714rem] font-semibold uppercase tracking-wide text-text-dimmed">{section.title}</div>
                )}
                {section.items.map((item) => (
                  <PaletteRow
                    key={item.key}
                    item={item}
                    query={text}
                    active={item === highlighted}
                    pending={pendingKey === item.key}
                    showWorkspace={multipleWorkspaces}
                    loadingMore={messageSearch.loadingMore}
                    onSelect={() => void run(item)}
                    onHover={() => setHighlightKey(item.key)}
                  />
                ))}
              </div>
            ),
          )}
          {items.length === 0 && <div className="px-4 py-5 text-center text-[0.929rem] text-text-placeholder">{emptyText}</div>}
          {mode === "all" && messageSearch.error && wantsMessages && (
            <div className="px-3 py-2 text-[0.857rem] text-error-bright">{messageSearch.error}</div>
          )}
        </div>

        <div className="hidden shrink-0 items-center gap-3 border-t border-border-subtle px-3 py-1.5 text-[0.714rem] text-text-dimmed sm:flex">
          <span><Kbd>↑</Kbd><Kbd>↓</Kbd> move</span>
          <span><Kbd>Enter</Kbd> open</span>
          <span><Kbd>Tab</Kbd> filter</span>
          <span className="ml-auto">
            <Kbd>@</Kbd> people <Kbd>#</Kbd> channels <Kbd>?</Kbd> messages <Kbd>&gt;</Kbd> commands
          </span>
        </div>
      </div>
    </div>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="mr-0.5 rounded bg-white/[0.06] px-1 py-px font-mono text-[0.643rem] text-text-dimmed">{children}</kbd>;
}

export function Highlighted({ text, query }: { text: string; query: string }) {
  return (
    <>
      {highlightParts(text, query).map((part, index) =>
        part.match ? (
          <mark key={index} className="rounded-sm bg-accent/25 px-px text-text">{part.text}</mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
}

function destinationLabel(destination: SearchDestination, showWorkspace: boolean) {
  const kind =
    destination.kind === "channel"
      ? "channel"
      : destination.kind === "task"
        ? `task in ${destination.conversationName}`
        : destination.userType === "bot"
          ? destination.botKind === "hermes" ? "Hermes agent" : "bot"
          : "person";
  return [destinationName(destination), kind, showWorkspace ? destination.workspaceName : null].filter(Boolean).join(", ");
}

/** "#general", "Koda › Invoice cleanup", or the other person's name. */
export function messageLocation(hit: Pick<MessageSearchHit, "conversationType" | "conversationName" | "threadTitle">) {
  const base = hit.conversationType === "group" ? `#${hit.conversationName}` : hit.conversationName;
  return hit.threadTitle ? `${base} › ${hit.threadTitle}` : base;
}

function PaletteRow({
  item,
  query,
  active,
  pending,
  showWorkspace,
  loadingMore,
  onSelect,
  onHover,
}: {
  item: PaletteItem;
  query: string;
  active: boolean;
  pending: boolean;
  showWorkspace: boolean;
  loadingMore: boolean;
  onSelect: () => void;
  onHover: () => void;
}) {
  const base = `${menuItemBaseClass} py-2 ${active ? "bg-hover text-text" : "text-text-secondary"}`;
  const common = {
    type: "button" as const,
    "data-testid": "palette-item",
    "data-palette-key": item.key,
    "data-active": active ? "true" : undefined,
    onClick: onSelect,
    onMouseMove: active ? undefined : onHover,
  };
  const workspace = (name: string) =>
    showWorkspace ? <span className="ml-2 shrink-0 truncate text-[0.786rem] text-text-dimmed">{name}</span> : null;
  const spinner = pending ? <LoaderCircle size={14} className="ml-2 shrink-0 animate-spin text-text-dimmed" aria-hidden="true" /> : null;

  switch (item.type) {
    case "command":
      return (
        <button {...common} className={base} aria-label={item.command.label}>
          <TerminalSquare size={15} className="shrink-0 text-text-dimmed" aria-hidden="true" />
          <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{item.command.label}</span>
          {item.command.shortcut && (
            <kbd className="ml-auto rounded-md bg-white/[0.06] px-1.5 py-0.5 font-mono text-[0.714rem] text-text-dimmed">{item.command.shortcut}</kbd>
          )}
        </button>
      );
    case "destination": {
      const destination = item.destination;
      return (
        <button {...common} className={base} aria-label={destinationLabel(destination, showWorkspace)}>
          {destination.kind === "channel" ? (
            <Hash size={15} className="shrink-0 text-text-dimmed" aria-hidden="true" />
          ) : destination.kind === "task" ? (
            <ListTodo size={15} className="shrink-0 text-text-dimmed" aria-hidden="true" />
          ) : (
            <Avatar
              name={destination.name}
              colorKey={destination.userId}
              bot={destination.userType === "bot"}
              botAvatar={destination.botAvatar}
              size={18}
              className="size-[18px] text-[0.571rem]"
            />
          )}
          <span className="min-w-0 flex-1 truncate">
            <Highlighted text={destinationName(destination)} query={query} />
            {destination.kind === "task" && <span className="ml-2 text-[0.786rem] text-text-dimmed">in {destination.conversationName}</span>}
            {destination.kind === "person" && destination.userType === "bot" && (
              <span className="ml-2 rounded bg-white/[0.06] px-1 py-px text-[0.643rem] uppercase tracking-wide text-text-dimmed">
                {destination.botKind === "hermes" ? "Agent" : "Bot"}
              </span>
            )}
          </span>
          {workspace(destination.workspaceName)}
          {spinner}
        </button>
      );
    }
    case "message": {
      const hit = item.hit;
      return (
        <button {...common} className={`${base} items-start`} aria-label={`Message from ${hit.senderName} in ${messageLocation(hit)}: ${hit.snippet}`}>
          <MessageSquare size={15} className="mt-0.5 shrink-0 text-text-dimmed" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-baseline gap-1.5 text-[0.786rem] text-text-dimmed">
              <span className="shrink-0 font-medium text-text-secondary">{hit.senderName}</span>
              {/* The workspace gives way first: the conversation name must stay readable. */}
              <span className="min-w-0 truncate">{messageLocation(hit)}</span>
              {showWorkspace && <span className="min-w-0 shrink-[20] truncate">· {hit.workspaceName}</span>}
              <span className="ml-auto shrink-0 pl-1">{formatSearchTime(hit.createdAt)}</span>
            </span>
            <span className="mt-0.5 line-clamp-2 block text-[0.857rem] leading-snug text-text-secondary">
              <Highlighted text={hit.snippet} query={query} />
            </span>
          </span>
          {spinner}
        </button>
      );
    }
    case "all-messages":
      return (
        <button {...common} className={base} aria-label={`Search all messages for ${item.query}`}>
          <Search size={15} className="shrink-0 text-text-dimmed" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">
            Search all messages for <span className="text-text">“{item.query}”</span>
          </span>
          <ArrowUpRight size={14} className="shrink-0 text-text-dimmed" aria-hidden="true" />
          {spinner}
        </button>
      );
    case "load-more":
      return (
        <button {...common} className={`${base} justify-center text-[0.857rem]`} aria-label="Load more results">
          {loadingMore ? "Loading…" : "Load more results"}
        </button>
      );
  }
}
