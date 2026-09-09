import { services } from "#platform-services";
import type { NativeFileDropHandlers } from "../platform/contracts";
export function isTauriRuntime() { return services.nativeFiles?.available() ?? false; }
export function listenForNativeFileDrops(handlers: NativeFileDropHandlers) {
  if (!services.nativeFiles) throw new Error("Native file drops are unavailable");
  return services.nativeFiles.listen(handlers);
}
