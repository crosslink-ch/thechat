import { expect, test } from "bun:test";
import { waitForWorkerStop } from "./worker-lifecycle";

test("worker stop rejects when the domain event runtime fails", async () => {
  const failure = new Error("domain event consumer crashed");
  const runtime = {
    async waitUntilFailed(): Promise<never> {
      throw failure;
    },
  };

  await expect(
    waitForWorkerStop(runtime, new Promise<void>(() => {})),
  ).rejects.toBe(failure);
});

test("worker stop resolves on a shutdown signal", async () => {
  const runtime = {
    waitUntilFailed(): Promise<never> {
      return new Promise<never>(() => {});
    },
  };

  await expect(waitForWorkerStop(runtime, Promise.resolve())).resolves.toBe(
    undefined,
  );
});
