import { log } from "../logging";
import { loadAttachmentConfig } from "./config";
import { requestExpiredAttachmentCleanup } from "./service";

const cleanupLog = log.child({ component: "attachment-cleanup" });

let abortController: AbortController | null = null;
let cleanupPromise: Promise<void> | null = null;

export function startAttachmentCleanup() {
  if (cleanupPromise) return cleanupPromise;
  abortController = new AbortController();
  cleanupPromise = runCleanup(abortController.signal);
  return cleanupPromise;
}

export async function closeAttachmentCleanup() {
  abortController?.abort();
  await cleanupPromise;
  abortController = null;
  cleanupPromise = null;
}

async function runCleanup(signal: AbortSignal) {
  const config = loadAttachmentConfig();
  while (!signal.aborted) {
    try {
      const requested = await requestExpiredAttachmentCleanup(
        config.cleanupBatchSize,
      );
      if (requested > 0) {
        cleanupLog.info(
          { count: requested },
          "Requested deletion for expired attachment drafts",
        );
      }
    } catch (error) {
      cleanupLog.error(
        { err: error },
        "Failed to request expired attachment cleanup",
      );
    }
    await waitForAbort(signal, config.cleanupIntervalMs);
  }
}

function waitForAbort(signal: AbortSignal, timeoutMs: number) {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timeout = setTimeout(done, timeoutMs);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timeout);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}
