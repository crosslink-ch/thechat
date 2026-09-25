import { useEffect } from "react";
import { useFontSizeStore } from "../stores/font-size";

/**
 * Maps the native Ctrl+wheel zoom gesture to TheChat's persisted font-size levels.
 *
 * Trackpad pinches also arrive as wheel events with `ctrlKey` set (macOS and
 * precision touchpads), so zoom only while the Control key is really held.
 */
export function useCtrlWheelZoom() {
  useEffect(() => {
    let controlHeld = false;
    const trackControl = (event: KeyboardEvent) => {
      controlHeld = event.ctrlKey;
    };
    const releaseControl = () => {
      controlHeld = false;
    };

    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey || event.deltaY === 0) return;

      // Keep the webview's native page zoom from competing with our persisted UI zoom.
      event.preventDefault();
      if (!controlHeld) return; // A pinch, not Ctrl+wheel.

      if (event.deltaY < 0) {
        useFontSizeStore.getState().increase();
      } else {
        useFontSizeStore.getState().decrease();
      }
    };

    window.addEventListener("keydown", trackControl);
    window.addEventListener("keyup", trackControl);
    window.addEventListener("blur", releaseControl);
    window.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      window.removeEventListener("keydown", trackControl);
      window.removeEventListener("keyup", trackControl);
      window.removeEventListener("blur", releaseControl);
      window.removeEventListener("wheel", handleWheel);
    };
  }, []);
}
