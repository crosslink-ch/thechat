import { describe, it, expect, beforeEach } from "vitest";
import { usePermissionModeStore } from "./permission-mode";

beforeEach(() => {
  usePermissionModeStore.setState({ mode: "request" });
});

describe("permission-mode store", () => {
  it("defaults to request mode", () => {
    expect(usePermissionModeStore.getState().mode).toBe("request");
  });

  it("setMode updates the mode", () => {
    usePermissionModeStore.getState().setMode("allow-edits");
    expect(usePermissionModeStore.getState().mode).toBe("allow-edits");

    usePermissionModeStore.getState().setMode("bypass");
    expect(usePermissionModeStore.getState().mode).toBe("bypass");

    usePermissionModeStore.getState().setMode("request");
    expect(usePermissionModeStore.getState().mode).toBe("request");
  });
});
