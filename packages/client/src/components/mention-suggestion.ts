import { ReactRenderer } from "@tiptap/react";
import type { SuggestionOptions } from "@tiptap/suggestion";
import { MentionList, type MentionUser } from "./MentionList";
import { rankMentionCandidates } from "./mention-ranking";

export function createMentionSuggestion(
  getMentions: () => MentionUser[]
): Omit<SuggestionOptions<MentionUser>, "editor"> {
  return {
    char: "@",
    items: ({ query }) => rankMentionCandidates(getMentions(), query),
    render: () => {
      let component: ReactRenderer<
        { onKeyDown: (props: { event: KeyboardEvent }) => boolean }
      > | null = null;
      let popup: HTMLDivElement | null = null;

      return {
        onStart: (props) => {
          component = new ReactRenderer(MentionList, {
            props,
            editor: props.editor,
          });

          popup = document.createElement("div");
          popup.style.position = "fixed";
          popup.style.zIndex = "50";
          popup.appendChild(component.element);
          document.body.appendChild(popup);

          updatePosition(popup, props.clientRect, props.editor.view.dom);
        },

        onUpdate: (props) => {
          component?.updateProps(props);
          if (popup) updatePosition(popup, props.clientRect, props.editor.view.dom);
        },

        onKeyDown: (props) => {
          if (props.event.key === "Escape") {
            popup?.remove();
            component?.destroy();
            popup = null;
            component = null;
            return true;
          }
          return component?.ref?.onKeyDown(props) ?? false;
        },

        onExit: () => {
          popup?.remove();
          component?.destroy();
          popup = null;
          component = null;
        },
      };
    },
  };
}

const VIEWPORT_MARGIN = 8;
const GAP = 6;

/**
 * Open above the composer (not just the caret, which sits inside its padding),
 * or below the caret when there is no room above; keep the menu inside the
 * viewport horizontally (phones).
 */
function updatePosition(
  popup: HTMLDivElement,
  clientRect: (() => DOMRect | null) | null | undefined,
  anchor?: Element | null,
) {
  const rect = clientRect?.();
  if (!rect) return;

  const width = popup.offsetWidth || 300;
  const height = popup.offsetHeight || 0;
  const maxLeft = window.innerWidth - width - VIEWPORT_MARGIN;
  popup.style.left = `${Math.max(VIEWPORT_MARGIN, Math.min(rect.left, maxLeft))}px`;
  const composerTop = anchor?.closest("[data-composer]")?.getBoundingClientRect().top;
  const above = Math.min(rect.top, composerTop ?? rect.top) - GAP;
  if (height > 0 && above - height < VIEWPORT_MARGIN) {
    popup.style.top = `${rect.bottom + GAP}px`;
    popup.style.transform = "none";
  } else {
    popup.style.top = `${above}px`;
    popup.style.transform = "translateY(-100%)";
  }
}
