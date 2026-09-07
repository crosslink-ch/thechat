import { webcrypto } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("../platform/environment", () => ({ isWeb: true }));
const download = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("./api", () => ({ api: { attachments: Object.assign(vi.fn(() => ({ download })), { post: vi.fn().mockResolvedValue({ data: null, error: null }) }) } }));
import { api } from "./api";
import { openSharedAttachmentDownload, uploadSharedAttachment } from "./shared-attachments";
import { resetPrivateSession } from "./session-boundary";
import { useHermesIndicatorsStore } from "../stores/hermes-indicators";
import { useHermesApprovalsStore } from "../stores/hermes-approvals";
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it("aborts and never hands off an earlier account's delayed download", async () => {
  const createObjectURL = vi.fn(() => "blob:old-account");
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL = createObjectURL;
    static revokeObjectURL = vi.fn();
  });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  let finish!: (blob: Blob) => void;
  const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, blob: () => new Promise<Blob>(resolve => { finish = resolve; }) });
  vi.stubGlobal("fetch", fetchImpl);
  download.get.mockResolvedValue({ data: { url: "https://objects.example.invalid/private", expiresAt: "later" }, error: null });
  const result = openSharedAttachmentDownload("old", null, "attachment", "private.txt").catch(error => error);
  await vi.waitFor(() => expect(finish).toBeDefined());
  resetPrivateSession();
  finish(new Blob(["private"]));
  const outcome = await result;
  expect(createObjectURL).not.toHaveBeenCalled();
  expect(outcome).toMatchObject({ name: "AbortError" });
  expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(true);
});
it("does not reserve or cancel an old account's file using a new account's cookie", async () => {
  vi.stubGlobal("crypto", webcrypto);
  let finish!: (value: ArrayBuffer) => void;
  const file = new File(["private"], "private.txt");
  file.arrayBuffer = () => new Promise(resolve => { finish = resolve; });
  const operation = uploadSharedAttachment({ file, token: null, conversationId: "alice-private", signal: new AbortController().signal }, vi.fn());
  await vi.waitFor(() => expect(finish).toBeDefined());
  resetPrivateSession(); finish(new ArrayBuffer(4));
  await expect(operation).rejects.toThrow("Session changed");
  expect(api.attachments.post).not.toHaveBeenCalled();
});
it("resets Hermes transient indicators and approval decisions at the account boundary", () => {
  useHermesIndicatorsStore.setState({ unreadScopes: { secret: {} } } as never);
  useHermesApprovalsStore.setState({ decisions: { secret: {} } } as never);
  resetPrivateSession();
  expect(useHermesIndicatorsStore.getState()).toMatchObject(useHermesIndicatorsStore.getInitialState());
  expect(useHermesApprovalsStore.getState().decisions).toEqual({});
});
