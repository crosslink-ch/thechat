import { useMemo, useRef, type RefObject } from "react";
import type { Command } from "../commands";
import { closePaletteAndRefocus } from "../CommandPalette";
import { useScopedCommands } from "./useScopedCommands";

const MESSAGE_SELECTOR = "[data-message-id]";
const REPEAT_ALIGNMENT_TOLERANCE_PX = 2;

export function scrollToPreviousMessageTop(
  scrollContainer: HTMLElement,
  beforeScroll: () => void,
  previousTarget: HTMLElement | null = null,
): HTMLElement | null {
  const currentScrollTop = scrollContainer.scrollTop;
  const containerContentTop =
    scrollContainer.getBoundingClientRect().top + scrollContainer.clientTop;
  const messages =
    scrollContainer.querySelectorAll<HTMLElement>(MESSAGE_SELECTOR);

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const messageTop =
      currentScrollTop +
      message.getBoundingClientRect().top -
      containerContentTop;
    if (
      message === previousTarget &&
      Math.abs(messageTop - currentScrollTop) <=
        REPEAT_ALIGNMENT_TOLERANCE_PX
    ) {
      continue;
    }
    if (messageTop >= currentScrollTop) continue;

    beforeScroll();
    scrollContainer.scrollTo({
      top: Math.max(0, messageTop),
      behavior: "instant" as ScrollBehavior,
    });
    return message;
  }

  return null;
}

export function useMessageTopCommand(
  scrollContainerRef: RefObject<HTMLElement | null>,
  enabled: boolean,
  pauseAutoScroll: () => void,
) {
  const lastTargetRef = useRef<HTMLElement | null>(null);
  const commands = useMemo<Command[]>(() => {
    if (!enabled) return [];

    return [
      {
        id: "chat.scroll-to-message-top",
        label: "Scroll to Message Top",
        shortcut: "C-x t",
        keybinding: { prefix: "C-x", key: "t" },
        priority: 80,
        execute: () => {
          closePaletteAndRefocus();
          const scrollContainer = scrollContainerRef.current;
          if (scrollContainer) {
            const target = scrollToPreviousMessageTop(
              scrollContainer,
              pauseAutoScroll,
              lastTargetRef.current,
            );
            if (target) lastTargetRef.current = target;
          }
        },
      },
    ];
  }, [enabled, pauseAutoScroll, scrollContainerRef]);

  useScopedCommands(commands);
}
