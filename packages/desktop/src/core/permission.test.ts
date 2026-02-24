import { describe, it, expect, vi, beforeEach } from "vitest";

// The module has mutable state (listener, nextId), so we reset modules between tests

let requestPermission: typeof import("./permission").requestPermission;
let onPermissionRequest: typeof import("./permission").onPermissionRequest;
let usePermissionModeStore: typeof import("../stores/permission-mode").usePermissionModeStore;

beforeEach(async () => {
  vi.resetModules();
  const store = await import("../stores/permission-mode");
  usePermissionModeStore = store.usePermissionModeStore;
  usePermissionModeStore.setState({ mode: "request" });
  const mod = await import("./permission");
  requestPermission = mod.requestPermission;
  onPermissionRequest = mod.onPermissionRequest;
});

describe("permission bridge", () => {
  it("resolves when the listener calls resolve", async () => {
    onPermissionRequest((req) => {
      req.resolve();
    });

    await expect(
      requestPermission({ command: "echo hi", description: "test" }),
    ).resolves.toBeUndefined();
  });

  it("rejects when the listener calls reject", async () => {
    onPermissionRequest((req) => {
      req.reject("denied");
    });

    await expect(
      requestPermission({ command: "rm -rf /", description: "danger" }),
    ).rejects.toThrow("denied");
  });

  it("rejects if no listener is registered", async () => {
    await expect(
      requestPermission({ command: "ls", description: "list files" }),
    ).rejects.toThrow("No permission handler registered");
  });

  it("unsubscribe removes the listener", async () => {
    const unsub = onPermissionRequest((req) => {
      req.resolve();
    });
    unsub();

    await expect(
      requestPermission({ command: "ls", description: "list" }),
    ).rejects.toThrow("No permission handler registered");
  });

  it("handles multiple sequential permission requests", async () => {
    const commands: string[] = [];
    onPermissionRequest((req) => {
      commands.push(req.command);
      req.resolve();
    });

    await requestPermission({ command: "echo 1", description: "first" });
    await requestPermission({ command: "echo 2", description: "second" });

    expect(commands).toEqual(["echo 1", "echo 2"]);
  });

  it("provides unique ids for each request", async () => {
    const ids: string[] = [];
    onPermissionRequest((req) => {
      ids.push(req.id);
      req.resolve();
    });

    await requestPermission({ command: "a", description: "a" });
    await requestPermission({ command: "b", description: "b" });

    expect(ids[0]).not.toBe(ids[1]);
  });
});

describe("permission modes", () => {
  it("bypass mode auto-allows all requests", async () => {
    usePermissionModeStore.setState({ mode: "bypass" });
    // No listener registered — would reject normally, but bypass skips it
    await expect(
      requestPermission({ command: "shell rm -rf /", description: "danger" }),
    ).resolves.toBeUndefined();
  });

  it("allow-edits mode auto-allows write commands", async () => {
    usePermissionModeStore.setState({ mode: "allow-edits" });
    await expect(
      requestPermission({ command: "write /tmp/foo.txt", description: "write file" }),
    ).resolves.toBeUndefined();
  });

  it("allow-edits mode auto-allows edit commands", async () => {
    usePermissionModeStore.setState({ mode: "allow-edits" });
    await expect(
      requestPermission({ command: "edit /tmp/foo.txt", description: "edit file" }),
    ).resolves.toBeUndefined();
  });

  it("allow-edits mode auto-allows multiedit commands", async () => {
    usePermissionModeStore.setState({ mode: "allow-edits" });
    await expect(
      requestPermission({ command: "multiedit /tmp/foo.txt", description: "multiedit file" }),
    ).resolves.toBeUndefined();
  });

  it("allow-edits mode still prompts for shell commands", async () => {
    usePermissionModeStore.setState({ mode: "allow-edits" });
    const commands: string[] = [];
    onPermissionRequest((req) => {
      commands.push(req.command);
      req.resolve();
    });

    await requestPermission({ command: "ls -la", description: "list files" });
    expect(commands).toEqual(["ls -la"]);
  });

  it("allow-edits mode still prompts for get_credential", async () => {
    usePermissionModeStore.setState({ mode: "allow-edits" });
    const commands: string[] = [];
    onPermissionRequest((req) => {
      commands.push(req.command);
      req.resolve();
    });

    await requestPermission({ command: "get_credential: API_KEY", description: "get key" });
    expect(commands).toEqual(["get_credential: API_KEY"]);
  });

  it("request mode prompts for everything", async () => {
    usePermissionModeStore.setState({ mode: "request" });
    const commands: string[] = [];
    onPermissionRequest((req) => {
      commands.push(req.command);
      req.resolve();
    });

    await requestPermission({ command: "write /tmp/foo.txt", description: "write file" });
    await requestPermission({ command: "ls", description: "list" });
    expect(commands).toEqual(["write /tmp/foo.txt", "ls"]);
  });
});
