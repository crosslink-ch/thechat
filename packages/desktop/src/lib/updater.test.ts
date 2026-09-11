import { afterEach, expect, it, vi } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { Update } from "@tauri-apps/plugin-updater";
import { installAndRelaunch } from "./updater";

vi.mock("@thechat/client/log", () => ({ info: vi.fn(), error: vi.fn(), formatError: String }));
afterEach(clearMocks);

it("retries relaunch without reinstalling an artifact already consumed by the native plugin", async () => {
  const calls: string[] = [];
  let restarts = 0;
  mockIPC((command) => {
    calls.push(command);
    if (command === "plugin:updater|download") return 2;
    if (command === "plugin:process|restart" && ++restarts === 1) throw new Error("Restart failed");
  });
  const update = new Update({ rid: 1, currentVersion: "1.0.0", version: "2.0.0", rawJson: {} });
  await update.download();
  await expect(installAndRelaunch(update)).rejects.toThrow("Restart failed");
  await expect(installAndRelaunch(update)).resolves.toBeUndefined();
  expect(calls.filter(command => command === "plugin:updater|install")).toHaveLength(1);
  expect(calls.filter(command => command === "plugin:process|restart")).toHaveLength(2);
});
