import { ReactRenderer } from "@tiptap/react";
import type { SuggestionProps, SuggestionKeyDownProps } from "@tiptap/suggestion";
import type { ComponentType } from "react";

type KeyHandler = { onKeyDown: (props: { event: KeyboardEvent }) => boolean };

/** Per editor, the menus on screen with at least one entry. */
const visibleMenus = new WeakMap<object, Set<object>>();

/**
 * Whether an @, # or : menu is on screen with entries, so it owns Enter.
 * A suggestion that matches nothing shows no menu and leaves Enter alone.
 */
export function suggestionMenuVisible(editor: object) {
  return (visibleMenus.get(editor)?.size ?? 0) > 0;
}

/**
 * The popup lifecycle shared by the @, # and : menus: a fixed element on
 * <body> that renders `component`, sits above the composer and follows the
 * caret.
 */
export function suggestionPopup<I, P extends object>(
  component: ComponentType<P>,
  props: (suggestion: SuggestionProps<I>) => P,
) {
  return () => {
    let renderer: ReactRenderer<KeyHandler, P> | null = null;
    let popup: HTMLDivElement | null = null;
    let owner: object | null = null;
    const token = {};
    const track = (visible: boolean) => {
      if (!owner) return;
      const menus = visibleMenus.get(owner) ?? new Set<object>();
      if (visible) menus.add(token);
      else menus.delete(token);
      visibleMenus.set(owner, menus);
    };
    const close = () => {
      track(false);
      popup?.remove();
      renderer?.destroy();
      popup = null;
      renderer = null;
    };
    return {
      onStart: (suggestion: SuggestionProps<I>) => {
        owner = suggestion.editor;
        renderer = new ReactRenderer(component as ComponentType<P>, {
          props: props(suggestion),
          editor: suggestion.editor,
        }) as ReactRenderer<KeyHandler, P>;
        popup = document.createElement("div");
        popup.style.position = "fixed";
        popup.style.zIndex = "50";
        popup.appendChild(renderer.element);
        document.body.appendChild(popup);
        updatePosition(popup, suggestion.clientRect, suggestion.editor.view.dom);
        track(suggestion.items.length > 0);
      },
      onUpdate: (suggestion: SuggestionProps<I>) => {
        if (!renderer) return;
        renderer.updateProps(props(suggestion));
        if (popup) updatePosition(popup, suggestion.clientRect, suggestion.editor.view.dom);
        track(suggestion.items.length > 0);
      },
      onKeyDown: ({ event }: SuggestionKeyDownProps) => {
        if (event.key === "Escape") {
          close();
          return true;
        }
        return renderer?.ref?.onKeyDown({ event }) ?? false;
      },
      onExit: close,
    };
  };
}

const VIEWPORT_MARGIN = 8;
const GAP = 6;

/**
 * Open above the composer (not just the caret, which sits inside its padding),
 * or below the caret when there is no room above; keep the menu inside the
 * viewport horizontally (phones).
 */
export function updatePosition(
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
