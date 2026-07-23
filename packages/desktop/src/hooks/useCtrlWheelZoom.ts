import { useEffect } from "react";
import { useFontSizeStore } from "../stores/font-size";

/**
 * Maps the native Ctrl+wheel zoom gesture to TheChat's persisted font-size levels.
 */
export function useCtrlWheelZoom() {
  useEffect(() => {
    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey || event.deltaY === 0) return;

      // Keep the webview's native page zoom from competing with our persisted UI zoom.
      event.preventDefault();

      if (event.deltaY < 0) {
        useFontSizeStore.getState().increase();
      } else {
        useFontSizeStore.getState().decrease();
      }
    };

    window.addEventListener("wheel", handleWheel, { passive: false });
    return () => window.removeEventListener("wheel", handleWheel);
  }, []);
}
