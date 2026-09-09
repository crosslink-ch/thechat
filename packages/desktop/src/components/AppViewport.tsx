import { useLayoutEffect, type HTMLAttributes } from "react";
import { MOBILE_NAV_QUERY, useMediaQuery } from "./ResponsiveShell";

/** Mount once around the root, including auth. Portalled dialogs share the same viewport variables. */
export function AppViewport({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  const mobile = useMediaQuery(MOBILE_NAV_QUERY);
  useLayoutEffect(() => {
    const viewport = window.visualViewport;
    if (!mobile || !viewport) return;
    const style = document.documentElement.style;
    const names = ["--app-viewport-height", "--app-viewport-top"] as const;
    const previous = names.map((name) => style.getPropertyValue(name));
    const update = () => {
      // A keyboard resizes the visual viewport; pinch zoom must not relayout the app.
      if (viewport.scale !== 1) return;
      style.setProperty(names[0], `${viewport.height}px`);
      style.setProperty(names[1], `${Math.max(0, viewport.offsetTop)}px`);
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      names.forEach((name, index) => previous[index] ? style.setProperty(name, previous[index]) : style.removeProperty(name));
    };
  }, [mobile]);
  return <div {...props} className={`app-viewport ${className}`} />;
}
