import { webcrypto } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("../platform/environment", () => ({ isWeb: true }));
vi.mock("./api", () => ({ api: { attachments: { post: vi.fn().mockResolvedValue({ data: null, error: null }) } } }));
import { api } from "./api";
import { uploadSharedAttachment } from "./shared-attachments";
import { resetPrivateSession } from "./session-boundary";
import { useHermesIndicatorsStore } from "../stores/hermes-indicators";
import { useHermesApprovalsStore } from "../stores/hermes-approvals";
afterEach(() => vi.unstubAllGlobals());
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
