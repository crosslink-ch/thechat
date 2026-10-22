import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, it, expect, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { SECURE_INPUT_KINDS, type BotInvocationProgressEventPublic, type BotInvocationPublic, type SecureInputKind } from "@thechat/shared";
import { HermesProgressInline } from "./HermesProgressInline";
import { useAuthStore } from "../stores/auth";
let publicKeySpkiB64: string;
const invocation = { id: "run", botId: "bot", botUserId: "bot-user", botName: "Hermes", botKind: "hermes", conversationId: "conversation", threadId: null, status: "running" } as BotInvocationPublic;
function event(kind: SecureInputKind = "vault.code"): BotInvocationProgressEventPublic {
  return { id: "event", invocationId: "run", botId: "bot", conversationId: "conversation", threadId: null, sequence: 1, type: "secure.input.request", status: "waiting", toolCallId: null, toolName: null, label: "UNTRUSTED LABEL", preview: "UNTRUSTED PREVIEW", createdAt: new Date().toISOString(), occurredAt: new Date().toISOString(), payload: {
    version: 3, requestId: "11111111-1111-4111-a111-111111111111", sessionKey: "session", profileId: "profile", requesterUserId: "requester", promptKind: kind, fields: [...SECURE_INPUT_KINDS[kind].fields], target: kind === "onepassword.unlock" ? "1Password" : kind === "skill.secret" ? "TEST_SECRET" : "https://example.test", nonce: Buffer.alloc(32).toString("base64url"), expiresAt: Date.now() + 120000, algorithm: "RSA-OAEP-3072-SHA256+A256GCM", publicKeySpkiB64,
  } };
}
beforeAll(async () => {
  const keys = await webcrypto.subtle.generateKey({ name: "RSA-OAEP", modulusLength: 3072, publicExponent: new Uint8Array([1,0,1]), hash: "SHA-256" }, true, ["encrypt", "decrypt"]);
  publicKeySpkiB64 = Buffer.from(await webcrypto.subtle.exportKey("spki", keys.publicKey)).toString("base64");
});
beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  useAuthStore.setState({ user: { id: "requester", type: "human", name: "Requester", email: null, avatar: null } });
});
it.each(Object.keys(SECURE_INPUT_KINDS) as SecureInputKind[])("renders fixed %s fields, encrypts and clears before delivery", async kind => {
  const e = event(kind);
  const submit = vi.fn().mockRejectedValue(new Error("DO_NOT_REFLECT"));
  render(<HermesProgressInline invocations={[{ invocation, events: [e] }]} onSecureInput={submit} />);
  expect(screen.getByTestId("hermes-secure-input-request")).toHaveTextContent(SECURE_INPUT_KINDS[kind].title);
  expect(screen.queryByText("UNTRUSTED LABEL")).toBeNull();
  const inputs = [...document.querySelectorAll("input")];
  expect(inputs).toHaveLength(SECURE_INPUT_KINDS[kind].fields.length);
  inputs.forEach((input, i) => {
    expect(input.type).toBe(SECURE_INPUT_KINDS[kind].fields[i] === "identifier" ? "text" : "password");
    fireEvent.change(input, { target: { value: "  synthetic-ä-AB12  " } });
  });
  fireEvent.click(screen.getByRole("button", { name: "Send securely" }));
  inputs.forEach(input => expect(input.value).toBe(""));
  await waitFor(() => expect(submit).toHaveBeenCalledOnce());
  expect(submit.mock.calls[0][1]).toEqual({ version: 3, action: "submit", wrappedKeyB64: expect.any(String), ivB64: expect.any(String), ciphertextB64: expect.any(String) });
  await waitFor(() => expect(screen.getByRole("alert")).not.toHaveTextContent("DO_NOT_REFLECT"));
  expect(JSON.stringify(submit.mock.calls)).not.toContain("synthetic");
});
it.each(["cancel", "replacement", "resolution", "expiry", "viewer", "terminal", "unmount"])("clears both login fields on %s", async reason => {
  const e = event("vault.save_login");
  const submit = vi.fn().mockResolvedValue(undefined);
  const view = render(<HermesProgressInline invocations={[{ invocation, events: [e] }]} onSecureInput={submit} />);
  const inputs = [...document.querySelectorAll("input")];
  inputs.forEach(input => fireEvent.change(input, { target: { value: "synthetic-sensitive" } }));
  if (reason === "cancel") {
    vi.stubGlobal("crypto", undefined);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith(e, { version: 3, action: "cancel" }));
  } else if (reason === "replacement") {
    view.rerender(<HermesProgressInline invocations={[{ invocation, events: [{ ...e, payload: { ...e.payload, nonce: Buffer.alloc(32, 1).toString("base64url") } }] }]} onSecureInput={submit} />);
    [...document.querySelectorAll("input")].forEach(input => expect(input.value).toBe(""));
  } else if (reason === "resolution") {
    view.rerender(<HermesProgressInline invocations={[{ invocation, events: [e, { ...e, id: "resolved", sequence: 2, type: "secure.input.resolved", payload: { version: 3, requestId: e.payload!.requestId, sessionKey: e.payload!.sessionKey, outcome: "cancelled" } }] }]} onSecureInput={submit} />);
  } else if (reason === "expiry") {
    view.rerender(<HermesProgressInline invocations={[{ invocation, events: [{ ...e, payload: { ...e.payload, expiresAt: Date.now() - 1 } }] }]} onSecureInput={submit} />);
  } else if (reason === "viewer") {
    act(() => useAuthStore.setState({ user: { id: "other", type: "human", name: "Other", email: null, avatar: null } }));
  } else if (reason === "terminal") {
    view.rerender(<HermesProgressInline invocations={[{ invocation: { ...invocation, status: "completed" }, events: [e] }]} onSecureInput={submit} />);
  } else view.unmount();
  inputs.forEach(input => expect(input.value).toBe(""));
  if (reason !== "replacement") expect(document.querySelectorAll("input")).toHaveLength(0);
});
it("expires a mounted prompt without a parent update", () => {
  vi.useFakeTimers();
  try {
    const e = event();
    const view = render(<HermesProgressInline invocations={[{ invocation, events: [e] }]} onSecureInput={vi.fn()} />);
    const input = screen.getByLabelText("Verification or recovery code") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "abc-recovery" } });
    act(() => vi.advanceTimersByTime(120001));
    expect(input.value).toBe("");
    expect(screen.getByTestId("hermes-secure-input-resolved")).toHaveTextContent("expired");
    view.unmount();
  } finally { vi.useRealTimers(); }
});
it("discards stale in-flight encryption after replacement and never exposes values on crypto failure", async () => {
  const e = event();
  let finish!: () => void;
  const blocked = new Promise<void>(resolve => { finish = resolve; });
  const encrypt = vi.fn(webcrypto.subtle.encrypt.bind(webcrypto.subtle));
  vi.stubGlobal("crypto", { subtle: { importKey: (...args: unknown[]) => blocked.then(() => Reflect.apply(webcrypto.subtle.importKey, webcrypto.subtle, args)), encrypt }, getRandomValues: webcrypto.getRandomValues.bind(webcrypto) });
  const submit = vi.fn();
  const view = render(<HermesProgressInline invocations={[{ invocation, events: [e] }]} onSecureInput={submit} />);
  const input = screen.getByLabelText("Verification or recovery code") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "abc-recovery" } });
  fireEvent.click(screen.getByRole("button", { name: "Send securely" }));
  expect(input.value).toBe("");
  view.rerender(<HermesProgressInline invocations={[{ invocation, events: [{ ...e, payload: { ...e.payload, profileId: "replacement" } }] }]} onSecureInput={submit} />);
  await act(async () => { finish(); await blocked; });
  await waitFor(() => expect(encrypt).toHaveBeenCalledTimes(2));
  await act(async () => { await Promise.all(encrypt.mock.results.map(result => result.value)); });
  expect(submit).not.toHaveBeenCalled();
  expect(screen.queryByRole("alert")).toBeNull();
  vi.stubGlobal("crypto", undefined);
  fireEvent.change(screen.getByLabelText("Verification or recovery code"), { target: { value: "abc-recovery" } });
  fireEvent.click(screen.getByRole("button", { name: "Send securely" }));
  await waitFor(() => expect(screen.getByRole("alert")).not.toHaveTextContent("abc-recovery"));
  expect(submit).not.toHaveBeenCalled();
  expect((screen.getByLabelText("Verification or recovery code") as HTMLInputElement).value).toBe("");
});
it.each(["other", "owner", "bot"])("hides both request and resolution from %s", viewer => {
  const e = event();
  act(() => useAuthStore.setState({ user: { id: viewer === "bot" ? "requester" : viewer, type: viewer === "bot" ? "bot" : "human", name: "Other", email: null, avatar: null } }));
  render(<HermesProgressInline invocations={[{ invocation, events: [e, { ...e, id: "resolved", sequence: 2, type: "secure.input.resolved", payload: { version: 3, requestId: e.payload!.requestId, sessionKey: e.payload!.sessionKey, outcome: "submitted" } }] }]} onSecureInput={vi.fn()} />);
  expect(screen.queryByTestId("hermes-secure-input-request")).toBeNull();
  expect(screen.queryByTestId("hermes-secure-input-resolved")).toBeNull();
  expect(screen.queryByText("UNTRUSTED LABEL")).toBeNull();
});
