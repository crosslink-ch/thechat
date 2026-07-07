import { getCurrentWindow } from "@tauri-apps/api/window";
import { toggleSidebar, useSidebarState } from "./Sidebar";

function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function isMacOSRuntime() {
  if (typeof navigator === "undefined") return false;

  const platform = navigator.platform?.toLowerCase() ?? "";
  const userAgent = navigator.userAgent?.toLowerCase() ?? "";

  return platform.includes("mac") || userAgent.includes("mac os x");
}

function runWindowAction(action: "minimize" | "maximize" | "close") {
  if (!isTauriRuntime()) return;

  const appWindow = getCurrentWindow();

  const promise =
    action === "minimize"
      ? appWindow.minimize()
      : action === "maximize"
        ? appWindow.toggleMaximize()
        : appWindow.close();

  void promise.catch((error) => {
    console.error(`Window ${action} failed`, error);
  });
}

export function WindowTitlebar() {
  const sidebarOpen = useSidebarState((s) => s.open);
  const isMacOS = isMacOSRuntime();
  const railClassName = isMacOS ? "w-[144px]" : "w-[112px]";

  return (
    <div
      data-tauri-drag-region
      className={[
        "flex shrink-0 select-none items-center border-b border-border-subtle text-text-muted",
        "bg-surface/95 shadow-[0_1px_0_rgba(255,255,255,0.03)_inset] backdrop-blur-xl",
        isMacOS ? "h-10" : "h-9",
      ].join(" ")}
      onDoubleClick={() => runWindowAction("maximize")}
    >
      <div
        className={[
          "flex h-full items-center gap-1 px-2",
          railClassName,
          isMacOS ? "justify-start pl-[76px]" : "justify-start",
        ].join(" ")}
      >
        <button
          aria-label={sidebarOpen ? "Collapse sidebar" : "Open sidebar"}
          title={sidebarOpen ? "Collapse sidebar" : "Open sidebar"}
          className="flex size-7 cursor-pointer items-center justify-center rounded-md border-none bg-transparent text-text-dimmed transition-colors duration-150 hover:bg-hover hover:text-text"
          onClick={(event) => {
            event.stopPropagation();
            toggleSidebar();
          }}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="1.5" y="2" width="11" height="10" rx="1.5" />
            <path d="M5 2V12" />
          </svg>
        </button>
      </div>

      <div data-tauri-drag-region className="flex min-w-0 flex-1 items-center justify-center px-3">
        <span className="truncate text-[0.786rem] font-semibold tracking-wide text-text-secondary">
          TheChat
        </span>
      </div>

      <div className={["flex h-full items-center justify-end gap-1 px-2", railClassName].join(" ")}>
        {!isMacOS && (
          <>
            <button
              aria-label="Minimize window"
              title="Minimize"
              className="group flex size-7 cursor-pointer items-center justify-center rounded-md border-none bg-transparent transition-colors duration-150 hover:bg-hover"
              onClick={(event) => {
                event.stopPropagation();
                runWindowAction("minimize");
              }}
            >
              <span className="h-0.5 w-3 rounded-full bg-text-dimmed transition-colors duration-150 group-hover:bg-text" />
            </button>
            <button
              aria-label="Maximize window"
              title="Maximize"
              className="group flex size-7 cursor-pointer items-center justify-center rounded-md border-none bg-transparent transition-colors duration-150 hover:bg-hover"
              onClick={(event) => {
                event.stopPropagation();
                runWindowAction("maximize");
              }}
            >
              <span className="size-3 rounded-[3px] border border-text-dimmed transition-colors duration-150 group-hover:border-text" />
            </button>
            <button
              aria-label="Close window"
              title="Close"
              className="group flex size-7 cursor-pointer items-center justify-center rounded-md border-none bg-transparent transition-colors duration-150 hover:bg-danger-bg-hover"
              onClick={(event) => {
                event.stopPropagation();
                runWindowAction("close");
              }}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" className="text-text-dimmed transition-colors duration-150 group-hover:text-error-bright">
                <path d="M3 3L9 9" />
                <path d="M9 3L3 9" />
              </svg>
            </button>
          </>
        )}
      </div>
    </div>
  );
}
