import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { ChatMessage } from "@thechat/shared";

/** Older history pages (20 messages each) a jump loads, at most, to reach its message. */
export const JUMP_MAX_OLDER_PAGES = 25;
/** How long the message a jump landed on stays highlighted. */
export const JUMP_HIGHLIGHT_MS = 5000;
const JUMP_WAIT_MS = 100;
const JUMP_MAX_WAITS = 50;

export interface MessageJumpRequest {
  messageId: string;
  /** Identifies one request: a new key jumps again, even to the same message. */
  key: string;
}

interface MessageJumpOptions {
  containerRef: RefObject<HTMLElement | null>;
  jump: MessageJumpRequest | undefined;
  messages: ChatMessage[];
  loading: boolean;
  loadingOlder: boolean;
  hasOlderMessages: boolean;
  /** Starts loading one older page; null when none could be started. */
  requestOlderMessages: () => Promise<void> | null;
  /** Stops following new messages, so the view stays on the message. */
  pauseAutoScroll: () => void;
  /** The jump is over: the message is shown (true) or out of reach (false). */
  onDone?: (found: boolean) => void;
}

/**
 * Opens the live chat at one message, the way Slack and Discord do: loads
 * older pages until the message is there, centres it and highlights it for a
 * moment. Returns the highlighted message ID. A message further back than
 * JUMP_MAX_OLDER_PAGES leaves the chat on its latest messages.
 *
 * Call it after the view's own scroll-to-bottom effects, so the jump is the
 * last scroll of the commit that renders the message.
 */
export function useMessageJump({
  containerRef,
  jump,
  messages,
  loading,
  loadingOlder,
  hasOlderMessages,
  requestOlderMessages,
  pauseAutoScroll,
  onDone,
}: MessageJumpOptions): string | null {
  const [highlighted, setHighlighted] = useState<string | null>(null);
  // Bumped when a page this hook asked for settles, to look again.
  const [settledLoads, setSettledLoads] = useState(0);
  const progress = useRef<{ key: string; pages: number; waits: number; done: boolean } | null>(null);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const messageId = jump?.messageId;
  const key = jump ? `${jump.key}\n${jump.messageId}` : null;

  useLayoutEffect(() => {
    if (!key || !messageId || loading) return;
    if (progress.current?.key !== key) progress.current = { key, pages: 0, waits: 0, done: false };
    const state = progress.current;
    const container = containerRef.current;
    if (state.done || !container) return;

    if (messages.some((message) => message.id === messageId)) {
      const row = findMessageRow(container, messageId);
      if (!row) return;
      state.done = true;
      if (revealRow(container, row)) pauseAutoScroll();
      setHighlighted(messageId);
      onDoneRef.current?.(true);
      return;
    }
    if (loadingOlder) return;
    if (
      !hasOlderMessages ||
      state.pages >= JUMP_MAX_OLDER_PAGES ||
      state.waits >= JUMP_MAX_WAITS
    ) {
      state.done = true;
      onDoneRef.current?.(false);
      return;
    }
    const load = requestOlderMessages();
    if (!load) {
      // A load started elsewhere (scrolling) is still settling: look again shortly.
      state.waits += 1;
      const retry = setTimeout(() => setSettledLoads((count) => count + 1), JUMP_WAIT_MS);
      return () => clearTimeout(retry);
    }
    state.pages += 1;
    void load.then(() => setSettledLoads((count) => count + 1));
  }, [
    containerRef,
    hasOlderMessages,
    key,
    loading,
    loadingOlder,
    messageId,
    messages,
    pauseAutoScroll,
    requestOlderMessages,
    settledLoads,
  ]);

  useEffect(() => {
    if (!highlighted) return;
    const timer = setTimeout(() => setHighlighted(null), JUMP_HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [highlighted]);

  return highlighted;
}

function findMessageRow(container: HTMLElement, messageId: string) {
  for (const row of container.querySelectorAll<HTMLElement>("[data-message-id]")) {
    if (row.dataset.messageId === messageId) return row;
  }
  return null;
}

/**
 * Centres a row in its own scroller (a row taller than the view shows its
 * top). Never scrollIntoView: on phones that also scrolls the page. Returns
 * false when that lands on the very end, where the chat keeps following new
 * messages.
 */
function revealRow(container: HTMLElement, row: HTMLElement) {
  const rowBox = row.getBoundingClientRect();
  const rowTop = rowBox.top - container.getBoundingClientRect().top + container.scrollTop;
  const centred =
    rowBox.height >= container.clientHeight
      ? rowTop
      : rowTop - (container.clientHeight - rowBox.height) / 2;
  const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
  const top = Math.min(Math.max(0, centred), maxTop);
  container.scrollTo({ top, behavior: "instant" });
  return top < maxTop - 1;
}
