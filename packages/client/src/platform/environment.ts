/** Explicit build selection; ordinary desktop/dev/test builds stay native. */
export const isWeb = typeof __WEB_BUILD__ !== "undefined" && __WEB_BUILD__;
