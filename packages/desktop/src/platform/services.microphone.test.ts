import { afterEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-log", () => ({}));

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); invoke.mockClear(); });

describe("Windows microphone service", () => {
  it.each(["MacIntel", "Linux x86_64", ""])("is absent on %s", async platform => {
    vi.stubGlobal("navigator", { platform });
    expect((await import("./services")).services.microphone).toBeUndefined();
  });
  it("offers only scoped no-payload microphone commands on Windows", async () => {
    vi.stubGlobal("navigator", { platform: "Win32" });
    const mic = (await import("./services")).services.microphone;
    expect(mic).toBeDefined();
    invoke.mockResolvedValueOnce("prompt");
    expect(await mic!.getPermissionState()).toBe("prompt");
    await mic!.prepareRecording();
    await mic!.cancelRecording();
    await mic!.openSettings();
    expect(invoke.mock.calls).toEqual([
      ["plugin:microphone|get_permission_state"],
      ["plugin:microphone|prepare_recording"],
      ["plugin:microphone|cancel_recording"],
      ["plugin:microphone|open_settings"],
    ]);
  });
});
