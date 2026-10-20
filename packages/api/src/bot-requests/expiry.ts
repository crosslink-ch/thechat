import { log } from "../logging";
import { expireDueBotRequests } from "../services/bot-requests";

const expiryLog = log.child({ component: "bot-request-expiry" });
const DEFAULT_SWEEP_INTERVAL_MS = 30_000;

let abortController: AbortController | null = null;
let sweepPromise: Promise<void> | null = null;

/**
 * Reads already expire overdue requests lazily. This sweep makes the
 * transition visible to open clients even when nobody reads the request.
 */
export function startBotRequestExpirySweep(
  intervalMs = Number.parseInt(process.env.BOT_REQUEST_EXPIRY_SWEEP_MS ?? "", 10) ||
    DEFAULT_SWEEP_INTERVAL_MS,
) {
  if (sweepPromise) return sweepPromise;
  abortController = new AbortController();
  sweepPromise = runSweep(abortController.signal, intervalMs);
  return sweepPromise;
}

export async function closeBotRequestExpirySweep() {
  abortController?.abort();
  await sweepPromise;
  abortController = null;
  sweepPromise = null;
}

async function runSweep(signal: AbortSignal, intervalMs: number) {
  while (!signal.aborted) {
    try {
      const expired = await expireDueBotRequests();
      if (expired.length > 0) {
        expiryLog.info({ count: expired.length }, "Expired unanswered bot requests");
      }
    } catch (error) {
      expiryLog.error({ err: error }, "Failed to expire bot requests");
    }
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(done, intervalMs);
      signal.addEventListener("abort", done, { once: true });
      function done() {
        clearTimeout(timeout);
        signal.removeEventListener("abort", done);
        resolve();
      }
    });
  }
}
