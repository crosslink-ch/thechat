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

function getQueue(convId = CONV_ID) {
  return usePermissionStore.getState().pending[convId] ?? [];
}

describe("permission store", () => {
  it("resolves when the UI calls resolve", async () => {
    const promise = requestPermission({ command: "echo hi", description: "test", convId: CONV_ID });

    const queue = getQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0].command).toBe("echo hi");
    queue[0].resolve();

    await expect(promise).resolves.toBeUndefined();
    expect(getQueue()).toHaveLength(0);
  });

  it("rejects when the UI calls reject", async () => {
    const promise = requestPermission({ command: "rm -rf /", description: "danger", convId: CONV_ID });

    const queue = getQueue();
    queue[0].reject("denied");

    await expect(promise).rejects.toThrow("denied");
    expect(getQueue()).toHaveLength(0);
  });

  it("scopes pending requests by conversation ID", async () => {
    const p1 = requestPermission({ command: "echo 1", description: "first", convId: "conv-a" });
    const p2 = requestPermission({ command: "echo 2", description: "second", convId: "conv-b" });

    const state = usePermissionStore.getState().pending;
    expect(state["conv-a"]?.[0]?.command).toBe("echo 1");
    expect(state["conv-b"]?.[0]?.command).toBe("echo 2");

    // Resolving one doesn't affect the other
    state["conv-a"][0].resolve();
    await p1;
    expect(usePermissionStore.getState().pending["conv-a"]).toBeUndefined();
    expect(usePermissionStore.getState().pending["conv-b"]).toHaveLength(1);

    state["conv-b"][0].resolve();
    await p2;
  });

  it("handles multiple sequential permission requests", async () => {
    const commands: string[] = [];

    const p1 = requestPermission({ command: "echo 1", description: "first", convId: CONV_ID });
    commands.push(getQueue()[0].command);
    getQueue()[0].resolve();
    await p1;

    const p2 = requestPermission({ command: "echo 2", description: "second", convId: CONV_ID });
    commands.push(getQueue()[0].command);
    getQueue()[0].resolve();
    await p2;

    expect(commands).toEqual(["echo 1", "echo 2"]);
  });

  it("queues multiple concurrent requests for the same conversation", async () => {
    const p1 = requestPermission({ command: "cmd 1", description: "first", convId: CONV_ID });
    const p2 = requestPermission({ command: "cmd 2", description: "second", convId: CONV_ID });
    const p3 = requestPermission({ command: "cmd 3", description: "third", convId: CONV_ID });

    // All three are queued
    expect(getQueue()).toHaveLength(3);
    expect(getQueue()[0].command).toBe("cmd 1");
    expect(getQueue()[1].command).toBe("cmd 2");
    expect(getQueue()[2].command).toBe("cmd 3");

    // Resolve first — queue shrinks, second is now first
    getQueue()[0].resolve();
    await p1;
    expect(getQueue()).toHaveLength(2);
    expect(getQueue()[0].command).toBe("cmd 2");

    // Reject second
    getQueue()[0].reject("denied");
    await expect(p2).rejects.toThrow("denied");
    expect(getQueue()).toHaveLength(1);
    expect(getQueue()[0].command).toBe("cmd 3");

    // Resolve third
    getQueue()[0].resolve();
    await p3;
    expect(getQueue()).toHaveLength(0);
  });

  it("provides unique ids for each request", async () => {
    const ids: string[] = [];

    const p1 = requestPermission({ command: "a", description: "a", convId: CONV_ID });
    ids.push(getQueue()[0].id);
    getQueue()[0].resolve();
    await p1;

    const p2 = requestPermission({ command: "b", description: "b", convId: CONV_ID });
    ids.push(getQueue()[0].id);
    getQueue()[0].resolve();
    await p2;

    expect(ids[0]).not.toBe(ids[1]);
  });

  it("uses _default key when no convId provided", async () => {
    const promise = requestPermission({ command: "ls", description: "list" });

    expect(usePermissionStore.getState().pending["_default"]).toHaveLength(1);
    usePermissionStore.getState().pending["_default"][0].resolve();
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
    expect(getQueue()).toHaveLength(0);
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

    const queue = getQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0].command).toBe("ls -la");
    queue[0].resolve();
    await promise;
  });

  it("allow-edits mode still prompts for get_credential", async () => {
    usePermissionModeStore.setState({ mode: "allow-edits" });
    const promise = requestPermission({ command: "get_credential: API_KEY", description: "get key", convId: CONV_ID });

    const queue = getQueue();
    expect(queue[0].command).toBe("get_credential: API_KEY");
    queue[0].resolve();
    await promise;
  });

  it("request mode prompts for everything", async () => {
    usePermissionModeStore.setState({ mode: "request" });
    const commands: string[] = [];

    const p1 = requestPermission({ command: "write /tmp/foo.txt", description: "write file", convId: CONV_ID });
    commands.push(getQueue()[0].command);
    getQueue()[0].resolve();
    await p1;

    const p2 = requestPermission({ command: "ls", description: "list", convId: CONV_ID });
    commands.push(getQueue()[0].command);
    getQueue()[0].resolve();
    await p2;

    expect(commands).toEqual(["write /tmp/foo.txt", "ls"]);
  });
});
