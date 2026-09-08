import { expect, it, vi } from "vitest";
vi.mock("./platform/environment", () => ({ isWeb: true }));
vi.mock("@tauri-apps/plugin-log", () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), trace: vi.fn() }));
import * as nativeLog from "@tauri-apps/plugin-log";
import { info } from "./log";
it("writes browser diagnostics without attempting native IPC", () => {
  const consoleLog = vi.spyOn(console, "info").mockImplementation(() => {});
  info("Browser startup");
  expect(consoleLog).toHaveBeenCalled();
  expect(nativeLog.info).not.toHaveBeenCalled();
  consoleLog.mockRestore();
});
