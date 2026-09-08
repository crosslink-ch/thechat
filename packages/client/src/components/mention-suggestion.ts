import { ReactRenderer } from "@tiptap/react";
import type { SuggestionOptions } from "@tiptap/suggestion";
import { MentionList, type MentionUser } from "./MentionList";

export function createMentionSuggestion(
  getMentions: () => MentionUser[]
): Omit<SuggestionOptions<MentionUser>, "editor"> {
  return {
    char: "@",
    items: ({ query }) => {
      const q = query.toLowerCase();
      return getMentions().filter((m) =>
        m.label.toLowerCase().includes(q)
      );
    },
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
          popup.style.position = "absolute";
          popup.style.zIndex = "50";
          popup.appendChild(component.element);
          document.body.appendChild(popup);

          updatePosition(popup, props.clientRect);
        },

        onUpdate: (props) => {
          component?.updateProps(props);
          if (popup) updatePosition(popup, props.clientRect);
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

function updatePosition(
  popup: HTMLDivElement,
  clientRect: (() => DOMRect | null) | null | undefined
) {
  const rect = clientRect?.();
  if (!rect) return;

  popup.style.left = `${rect.left}px`;
  popup.style.top = `${rect.top - 4}px`;
  popup.style.transform = "translateY(-100%)";
}
