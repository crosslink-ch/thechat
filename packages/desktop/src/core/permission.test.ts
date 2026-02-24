import { describe, it, expect, vi, beforeEach } from "vitest";

let requestPermission: typeof import("./permission").requestPermission;
let usePermissionStore: typeof import("./permission").usePermissionStore;
let usePermissionModeStore: typeof import("../stores/permission-mode").usePermissionModeStore;

beforeEach(async () => {
  vi.resetModules();
  const store = await import("../stores/permission-mode");
  usePermissionModeStore = store.usePermissionModeStore;
  usePermissionModeStore.setState({ mode: "request" });
  const mod = await import("./permission");
  requestPermission = mod.requestPermission;
  usePermissionStore = mod.usePermissionStore;
  usePermissionStore.setState({ pending: {} });
});

const CONV_ID = "conv-1";

describe("permission store", () => {
  it("resolves when the UI calls resolve", async () => {
    const promise = requestPermission({ command: "echo hi", description: "test", convId: CONV_ID });

    const pending = usePermissionStore.getState().pending[CONV_ID];
    expect(pending).toBeDefined();
    expect(pending.command).toBe("echo hi");
    pending.resolve();

    await expect(promise).resolves.toBeUndefined();
    expect(usePermissionStore.getState().pending[CONV_ID]).toBeUndefined();
  });

  it("rejects when the UI calls reject", async () => {
    const promise = requestPermission({ command: "rm -rf /", description: "danger", convId: CONV_ID });

    const pending = usePermissionStore.getState().pending[CONV_ID];
    pending.reject("denied");

    await expect(promise).rejects.toThrow("denied");
    expect(usePermissionStore.getState().pending[CONV_ID]).toBeUndefined();
  });

  it("scopes pending requests by conversation ID", async () => {
    const p1 = requestPermission({ command: "echo 1", description: "first", convId: "conv-a" });
    const p2 = requestPermission({ command: "echo 2", description: "second", convId: "conv-b" });

    const state = usePermissionStore.getState().pending;
    expect(state["conv-a"]?.command).toBe("echo 1");
    expect(state["conv-b"]?.command).toBe("echo 2");

    // Resolving one doesn't affect the other
    state["conv-a"].resolve();
    await p1;
    expect(usePermissionStore.getState().pending["conv-a"]).toBeUndefined();
    expect(usePermissionStore.getState().pending["conv-b"]).toBeDefined();

    state["conv-b"].resolve();
    await p2;
  });

  it("handles multiple sequential permission requests", async () => {
    const commands: string[] = [];

    const p1 = requestPermission({ command: "echo 1", description: "first", convId: CONV_ID });
    let pending = usePermissionStore.getState().pending[CONV_ID];
    commands.push(pending.command);
    pending.resolve();
    await p1;

    const p2 = requestPermission({ command: "echo 2", description: "second", convId: CONV_ID });
    pending = usePermissionStore.getState().pending[CONV_ID];
    commands.push(pending.command);
    pending.resolve();
    await p2;

    expect(commands).toEqual(["echo 1", "echo 2"]);
  });

  it("provides unique ids for each request", async () => {
    const ids: string[] = [];

    const p1 = requestPermission({ command: "a", description: "a", convId: CONV_ID });
    ids.push(usePermissionStore.getState().pending[CONV_ID].id);
    usePermissionStore.getState().pending[CONV_ID].resolve();
    await p1;

    const p2 = requestPermission({ command: "b", description: "b", convId: CONV_ID });
    ids.push(usePermissionStore.getState().pending[CONV_ID].id);
    usePermissionStore.getState().pending[CONV_ID].resolve();
    await p2;

    expect(ids[0]).not.toBe(ids[1]);
  });

  it("uses _default key when no convId provided", async () => {
    const promise = requestPermission({ command: "ls", description: "list" });

    expect(usePermissionStore.getState().pending["_default"]).toBeDefined();
    usePermissionStore.getState().pending["_default"].resolve();
    await promise;
  });
});

describe("permission modes", () => {
  it("bypass mode auto-allows all requests", async () => {
    usePermissionModeStore.setState({ mode: "bypass" });
    await expect(
      requestPermission({ command: "shell rm -rf /", description: "danger", convId: CONV_ID }),
    ).resolves.toBeUndefined();
    // No pending request created
    expect(usePermissionStore.getState().pending[CONV_ID]).toBeUndefined();
  });

  it("allow-edits mode auto-allows write commands", async () => {
    usePermissionModeStore.setState({ mode: "allow-edits" });
    await expect(
      requestPermission({ command: "write /tmp/foo.txt", description: "write file", convId: CONV_ID }),
    ).resolves.toBeUndefined();
  });

  it("allow-edits mode auto-allows edit commands", async () => {
    usePermissionModeStore.setState({ mode: "allow-edits" });
    await expect(
      requestPermission({ command: "edit /tmp/foo.txt", description: "edit file", convId: CONV_ID }),
    ).resolves.toBeUndefined();
  });

  it("allow-edits mode auto-allows multiedit commands", async () => {
    usePermissionModeStore.setState({ mode: "allow-edits" });
    await expect(
      requestPermission({ command: "multiedit /tmp/foo.txt", description: "multiedit file", convId: CONV_ID }),
    ).resolves.toBeUndefined();
  });

  it("allow-edits mode still prompts for shell commands", async () => {
    usePermissionModeStore.setState({ mode: "allow-edits" });
    const promise = requestPermission({ command: "ls -la", description: "list files", convId: CONV_ID });

    const pending = usePermissionStore.getState().pending[CONV_ID];
    expect(pending).toBeDefined();
    expect(pending.command).toBe("ls -la");
    pending.resolve();
    await promise;
  });

  it("allow-edits mode still prompts for get_credential", async () => {
    usePermissionModeStore.setState({ mode: "allow-edits" });
    const promise = requestPermission({ command: "get_credential: API_KEY", description: "get key", convId: CONV_ID });

    const pending = usePermissionStore.getState().pending[CONV_ID];
    expect(pending.command).toBe("get_credential: API_KEY");
    pending.resolve();
    await promise;
  });

  it("request mode prompts for everything", async () => {
    usePermissionModeStore.setState({ mode: "request" });
    const commands: string[] = [];

    const p1 = requestPermission({ command: "write /tmp/foo.txt", description: "write file", convId: CONV_ID });
    commands.push(usePermissionStore.getState().pending[CONV_ID].command);
    usePermissionStore.getState().pending[CONV_ID].resolve();
    await p1;

    const p2 = requestPermission({ command: "ls", description: "list", convId: CONV_ID });
    commands.push(usePermissionStore.getState().pending[CONV_ID].command);
    usePermissionStore.getState().pending[CONV_ID].resolve();
    await p2;

    expect(commands).toEqual(["write /tmp/foo.txt", "ls"]);
  });
});
