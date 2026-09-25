import { getCurrentWindow } from "@tauri-apps/api/window";
import { toggleSidebar, useSidebarState } from "@thechat/client/components/Sidebar";
import { MOBILE_NAV_QUERY, useMediaQuery } from "@thechat/client/components/ResponsiveShell";
import { Minus, PanelLeft, Square, X } from "lucide-react";

// Like iconButtonClass in @thechat/client/components/ui, one size smaller for the titlebar.
const titlebarButtonClass =
  "flex size-7 cursor-pointer items-center justify-center rounded-md border-none bg-transparent text-text-dimmed transition-colors duration-150 hover:bg-hover hover:text-text";

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
  const mobileNavigation = useMediaQuery(MOBILE_NAV_QUERY);
  const isMacOS = isMacOSRuntime();
  const railClassName = isMacOS ? "w-[144px]" : "w-[112px]";

  return (
    <div
      data-tauri-drag-region
      className={[
        "flex shrink-0 select-none items-center border-b border-border-subtle text-text-muted",
        "bg-surface/95 backdrop-blur-2xl backdrop-saturate-150",
        // Fixed pixels, not rem: macOS draws the traffic lights at a fixed
        // offset (trafficLightPosition y=21 in tauri.macos.conf.json centres
        // them ~19px from the top), so the bar and its sidebar toggle must not
        // scale with the UI zoom.
        isMacOS ? "h-[38px]" : "h-9",
      ].join(" ")}
      onDoubleClick={() => runWindowAction("maximize")}
    >
      {/* Every non-button part of the bar moves the window, so it stays
          draggable even when the centre title has no room left. */}
      <div
        data-tauri-drag-region
        className={[
          "flex h-full items-center gap-1 px-2",
          railClassName,
          isMacOS ? "justify-start pl-[76px]" : "justify-start",
        ].join(" ")}
      >
        {/* Drawer navigation is controlled by the chat header, not sidebar state. */}
        {!mobileNavigation && (
          <button
            aria-label={sidebarOpen ? "Collapse sidebar" : "Open sidebar"}
            title={sidebarOpen ? "Collapse sidebar" : "Open sidebar"}
            className={titlebarButtonClass}
            onClick={(event) => {
              event.stopPropagation();
              toggleSidebar();
            }}
            onDoubleClick={(event) => event.stopPropagation()}
          >
            <PanelLeft size={16} aria-hidden="true" />
          </button>
        )}
      </div>

      <div data-tauri-drag-region className="flex min-w-0 flex-1 items-center justify-center px-3">
        <span className="truncate text-[0.857rem] font-medium text-text-muted">
          TheChat
        </span>
      </div>

      <div
        data-tauri-drag-region
        className={["flex h-full items-center justify-end gap-1 px-2", railClassName].join(" ")}
      >
        {!isMacOS && (
          <>
            <button
              aria-label="Minimize window"
              title="Minimize"
              className={titlebarButtonClass}
              onClick={(event) => {
                event.stopPropagation();
                runWindowAction("minimize");
              }}
            >
              <Minus size={14} aria-hidden="true" />
            </button>
            <button
              aria-label="Maximize window"
              title="Maximize"
              className={titlebarButtonClass}
              onClick={(event) => {
                event.stopPropagation();
                runWindowAction("maximize");
              }}
            >
              <Square size={12} aria-hidden="true" />
            </button>
            <button
              aria-label="Close window"
              title="Close"
              className="flex size-7 cursor-pointer items-center justify-center rounded-md border-none bg-transparent text-text-dimmed transition-colors duration-150 hover:bg-danger-bg-hover hover:text-error-bright"
              onClick={(event) => {
                event.stopPropagation();
                runWindowAction("close");
              }}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
