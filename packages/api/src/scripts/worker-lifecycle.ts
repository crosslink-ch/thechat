export interface FailureAwareRuntime {
  waitUntilFailed(): Promise<never>;
}

export function waitForWorkerStop(
  runtime: FailureAwareRuntime,
  shutdownSignal: Promise<void> = waitForShutdownSignal(),
): Promise<void> {
  return Promise.race([shutdownSignal, runtime.waitUntilFailed()]);
}

function waitForShutdownSignal(): Promise<void> {
  return new Promise((resolve) => {
    const shutdown = () => resolve();
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}
