import { beforeEach, describe, expect, it, vi } from "vitest";
import { fileFromNativeDrop } from "./native-file-drop";

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauriMocks.invoke,
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: vi.fn(),
}));

beforeEach(() => {
  tauriMocks.invoke.mockReset();
});

describe("fileFromNativeDrop", () => {
  it("creates an image File from a Windows native drop path", async () => {
    tauriMocks.invoke.mockResolvedValue(
      new Uint8Array([137, 80, 78, 71]).buffer,
    );

    const file = await fileFromNativeDrop(
      "C:\\Users\\Bruno\\Pictures\\diagram.PNG",
    );

    expect(tauriMocks.invoke).toHaveBeenCalledWith("read_dropped_file", {
      filePath: "C:\\Users\\Bruno\\Pictures\\diagram.PNG",
    });
    expect(file.name).toBe("diagram.PNG");
    expect(file.type).toBe("image/png");
    expect(file.size).toBe(4);
  });
});
