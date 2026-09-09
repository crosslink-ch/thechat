import { createContext, useContext, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

const HeaderActionsContext = createContext<{
  target: HTMLDivElement | null;
  setTarget: (target: HTMLDivElement | null) => void;
} | null>(null);

export function HeaderActionsProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  return <HeaderActionsContext.Provider value={{ target, setTarget }}>{children}</HeaderActionsContext.Provider>;
}

export function HeaderActionsSlot() {
  const context = useContext(HeaderActionsContext);
  return <div ref={context?.setTarget} className="flex shrink-0 items-center gap-2 empty:hidden" />;
}

/** A portal preserves the action's originating Dialog.Root and focus handling. */
export function HeaderAction({ children }: { children: ReactNode }) {
  const context = useContext(HeaderActionsContext);
  // Standalone component previews have no shell; keep their action usable.
  if (!context) return children;
  return context.target ? createPortal(children, context.target) : null;
}
