import { Reply } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { MessageQuoteDraft } from "@thechat/shared";
import { quoteFromSelection } from "../lib/message-quote";

const EDGE_GAP = 8;
const BUTTON_CLEARANCE = 40;
/** Matches the button's `h-8`. */
const BUTTON_HEIGHT = 32;

interface ReplyTarget {
  quote: MessageQuoteDraft;
  top: number;
  left: number;
  placement: "above" | "below";
}

/**
 * Floats a Reply button over text selected inside one message of the
 * transcript. Choosing it hands the selection to `onReply` as a quote.
 */
export function SelectionReplyButton({
  scrollContainerRef,
  onReply,
}: {
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  onReply: (quote: MessageQuoteDraft) => void;
}) {
  const [target, setTarget] = useState<ReplyTarget | null>(null);
  const pointerDownRef = useRef(false);
  const frameRef = useRef<number | null>(null);

  const measure = useCallback(() => {
    frameRef.current = null;
    const container = scrollContainerRef.current;
    const anchor = container?.parentElement;
    if (!container || !anchor || pointerDownRef.current) {
      setTarget(null);
      return;
    }
    const quote = quoteFromSelection(window.getSelection(), container);
    if (!quote) {
      setTarget(null);
      return;
    }
    const selection = quote.range.getBoundingClientRect();
    const visible = container.getBoundingClientRect();
    if (selection.bottom < visible.top || selection.top > visible.bottom) {
      setTarget(null);
      return;
    }
    const frame = anchor.getBoundingClientRect();
    const roomAbove = selection.top - Math.max(frame.top, visible.top);
    const placement = roomAbove >= BUTTON_CLEARANCE ? "above" : "below";
    const centre = (selection.left + selection.right) / 2 - frame.left;
    setTarget({
      quote: { text: quote.text, messageId: quote.messageId },
      placement,
      // Below a selection that runs past the transcript, the button stays
      // inside the transcript instead of covering the composer.
      top:
        placement === "above"
          ? selection.top - frame.top - EDGE_GAP
          : Math.min(
              selection.bottom - frame.top + EDGE_GAP,
              visible.bottom - frame.top - EDGE_GAP - BUTTON_HEIGHT,
            ),
      left: Math.min(
        Math.max(centre, BUTTON_CLEARANCE + EDGE_GAP),
        frame.width - BUTTON_CLEARANCE - EDGE_GAP,
      ),
    });
  }, [scrollContainerRef]);

  const schedule = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(measure);
  }, [measure]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    const onPointerDown = (event: PointerEvent) => {
      // Mouse selections are measured once the drag ends; touch selections
      // are driven by the platform's handles and arrive as selectionchange.
      // Only the primary button selects text: a right-click opens a context
      // menu that may swallow the matching pointerup.
      if (event.pointerType !== "mouse" || event.button !== 0) return;
      if (!container?.contains(event.target as Node)) return;
      pointerDownRef.current = true;
      setTarget(null);
    };
    const onPointerUp = () => {
      if (!pointerDownRef.current) return;
      pointerDownRef.current = false;
      schedule();
    };
    document.addEventListener("selectionchange", schedule);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("pointerup", onPointerUp);
    // A drag can end without a pointerup reaching the page.
    document.addEventListener("pointercancel", onPointerUp);
    document.addEventListener("contextmenu", onPointerUp);
    window.addEventListener("blur", onPointerUp);
    window.addEventListener("resize", schedule);
    container?.addEventListener("scroll", schedule, { passive: true });
    return () => {
      document.removeEventListener("selectionchange", schedule);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("pointerup", onPointerUp);
      document.removeEventListener("pointercancel", onPointerUp);
      document.removeEventListener("contextmenu", onPointerUp);
      window.removeEventListener("blur", onPointerUp);
      window.removeEventListener("resize", schedule);
      container?.removeEventListener("scroll", schedule);
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, [schedule, scrollContainerRef]);

  if (!target) return null;
  const reply = () => {
    onReply(target.quote);
    window.getSelection()?.removeAllRanges();
    setTarget(null);
  };
  return (
    <button
      type="button"
      data-testid="selection-reply"
      // Keep the selection alive: a default mousedown would collapse it.
      onMouseDown={(event) => event.preventDefault()}
      // A tap can clear the native selection, and with it this button, before
      // the click arrives, so touch and pen reply as soon as they press.
      onPointerDown={(event) => {
        if (event.pointerType === "mouse") return;
        event.preventDefault();
        reply();
      }}
      onClick={reply}
      style={{ top: target.top, left: target.left }}
      className={`absolute z-20 flex h-8 -translate-x-1/2 cursor-pointer items-center gap-1.5 rounded-lg border border-border-strong bg-surface px-2.5 font-[inherit] text-[0.857rem] font-medium text-text shadow-card transition-colors duration-100 hover:bg-elevated animate-fade-in ${
        target.placement === "above" ? "-translate-y-full" : ""
      }`}
    >
      Reply
      <Reply size={14} aria-hidden="true" />
    </button>
  );
}
