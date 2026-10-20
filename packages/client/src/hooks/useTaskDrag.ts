import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

/** `data-task-drop-target` value of the "No project" group. */
export const NO_PROJECT_DROP_TARGET = "none";
const DRAG_THRESHOLD_PX = 5;

export interface TaskDrag {
  threadId: string;
  title: string;
  x: number;
  y: number;
  /** Drop target under the pointer: a project id, "none", or null. */
  targetId: string | null;
}

interface PendingDrag {
  threadId: string;
  title: string;
  startX: number;
  startY: number;
  pointerId: number;
}

function dropTargetAt(x: number, y: number) {
  const element = document.elementFromPoint?.(x, y);
  const target = element?.closest?.("[data-task-drop-target]");
  return target?.getAttribute("data-task-drop-target") ?? null;
}

/**
 * Pointer-based task dragging. HTML5 drag and drop is not used because the
 * desktop app keeps native file drops enabled, which disables it in WebView2.
 * Touch input is left to scrolling; phones use the Move to project dialog.
 */
export function useTaskDrag(
  onDrop: (threadId: string, projectId: string | null) => void,
) {
  const [drag, setDrag] = useState<TaskDrag | null>(null);
  const pendingRef = useRef<PendingDrag | null>(null);
  const draggingRef = useRef(false);
  const suppressClickRef = useRef(false);
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;

  const reset = useCallback(() => {
    pendingRef.current = null;
    if (draggingRef.current) {
      draggingRef.current = false;
      document.body.style.removeProperty("user-select");
      document.body.style.removeProperty("cursor");
    }
    setDrag(null);
  }, []);

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const pending = pendingRef.current;
      if (!pending || event.pointerId !== pending.pointerId) return;
      if (!draggingRef.current) {
        const distance = Math.hypot(
          event.clientX - pending.startX,
          event.clientY - pending.startY,
        );
        if (distance < DRAG_THRESHOLD_PX) return;
        draggingRef.current = true;
        document.body.style.setProperty("user-select", "none");
        document.body.style.setProperty("cursor", "grabbing");
        window.getSelection?.()?.removeAllRanges();
      }
      event.preventDefault();
      setDrag({
        threadId: pending.threadId,
        title: pending.title,
        x: event.clientX,
        y: event.clientY,
        targetId: dropTargetAt(event.clientX, event.clientY),
      });
    };
    const onPointerUp = (event: PointerEvent) => {
      const pending = pendingRef.current;
      if (!pending || event.pointerId !== pending.pointerId) return;
      if (draggingRef.current) {
        // The click that follows a drag must not also select the task.
        suppressClickRef.current = true;
        window.setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
        const target = dropTargetAt(event.clientX, event.clientY);
        if (target) {
          onDropRef.current(
            pending.threadId,
            target === NO_PROJECT_DROP_TARGET ? null : target,
          );
        }
      }
      reset();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && pendingRef.current) reset();
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", reset);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", reset);
      window.removeEventListener("keydown", onKeyDown);
      reset();
    };
  }, [reset]);

  /** Props for the element a task is dragged by. */
  const dragSourceProps = useCallback(
    (threadId: string, title: string) => ({
      onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
        if (event.button !== 0 || event.pointerType === "touch") return;
        // Buttons inside a row (rename, menus) keep their own click behaviour.
        if ((event.target as Element | null)?.closest?.("[data-no-task-drag]")) return;
        pendingRef.current = {
          threadId,
          title,
          startX: event.clientX,
          startY: event.clientY,
          pointerId: event.pointerId,
        };
      },
      onClickCapture: (event: ReactMouseEvent<HTMLElement>) => {
        if (!suppressClickRef.current) return;
        suppressClickRef.current = false;
        event.preventDefault();
        event.stopPropagation();
      },
    }),
    [],
  );

  return { drag, dragSourceProps };
}
