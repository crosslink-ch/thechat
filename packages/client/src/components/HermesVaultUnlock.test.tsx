import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, it, expect, vi } from "vitest";
import { webcrypto } from "node:crypto";
import type {
  BotInvocationProgressEventPublic,
  BotInvocationPublic,
} from "@thechat/shared";
import { HermesProgressInline } from "./HermesProgressInline";
import { useAuthStore } from "../stores/auth";
let event: BotInvocationProgressEventPublic;
const invocation = {
  id: "run",
  botId: "bot",
  botUserId: "bot-user",
  botName: "Hermes",
  botKind: "hermes",
  conversationId: "conversation",
  threadId: null,
  status: "running",
} as BotInvocationPublic;
beforeEach(async () => {
  vi.stubGlobal("crypto", webcrypto);
  useAuthStore.setState({
    user: {
      id: "requester",
      type: "human",
      name: "Requester",
      email: null,
      avatar: null,
    },
  });
  const keys = await webcrypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 3072,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"],
  );
  event = {
    id: "event",
    invocationId: "run",
    botId: "bot",
    conversationId: "conversation",
    threadId: null,
    sequence: 1,
    type: "vault.unlock.request",
    status: "waiting",
    toolCallId: null,
    toolName: null,
    label: "Unlock Bitwarden",
    preview: null,
    payload: {
      version: 2,
      requestId: "11111111-1111-4111-a111-111111111111",
      sessionKey: "session",
      profileId: "profile",
      backend: "bitwarden",
      requesterUserId: "requester",
      nonce: Buffer.alloc(32).toString("base64url"),
      expiresAt: Date.now() + 120000,
      algorithm: "RSA-OAEP-3072-SHA256+A256GCM",
      publicKeySpkiB64: Buffer.from(
        await webcrypto.subtle.exportKey("spki", keys.publicKey),
      ).toString("base64"),
    },
    createdAt: new Date().toISOString(),
    occurredAt: new Date().toISOString(),
  };
});
it("shows a nonowner requester their private prompt and shared-access disclosure, masking and clearing on submit", async () => {
  const submit = vi.fn().mockRejectedValue(new Error("DO_NOT_REFLECT"));
  render(
    <HermesProgressInline
      invocations={[{ invocation, events: [event] }]}
      onVaultUnlock={submit}
    />,
  );
  expect(screen.getByTestId("hermes-vault-unlock-request")).toHaveTextContent(
    /all users of this agent\/profile access to Bitwarden/,
  );
  const input = screen.getByLabelText("Master password") as HTMLInputElement;
  expect(input.type).toBe("password");
  fireEvent.change(input, { target: { value: "  päss🔒  " } });
  fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
  expect(input.value).toBe("");
  await waitFor(() => expect(submit).toHaveBeenCalledOnce());
  expect(submit.mock.calls[0][1]).toEqual({
    version: 2,
    action: "submit",
    wrappedKeyB64: expect.any(String),
    ivB64: expect.any(String),
    ciphertextB64: expect.any(String),
  });
  await waitFor(() =>
    expect(screen.getByRole("alert")).not.toHaveTextContent("DO_NOT_REFLECT"),
  );
  expect(JSON.stringify(submit.mock.calls)).not.toContain("päss");
});
it("clears on cancellation, request replacement, and unmount without requiring crypto", async () => {
  const submit = vi.fn().mockResolvedValue(undefined);
  const view = render(
    <HermesProgressInline
      invocations={[{ invocation, events: [event] }]}
      onVaultUnlock={submit}
    />,
  );
  let input = screen.getByLabelText("Master password") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "synthetic" } });
  view.rerender(
    <HermesProgressInline
      invocations={[
        {
          invocation,
          events: [
            {
              ...event,
              payload: {
                ...event.payload,
                nonce: Buffer.alloc(32, 1).toString("base64url"),
              },
            },
          ],
        },
      ]}
      onVaultUnlock={submit}
    />,
  );
  expect(input.value).toBe("");
  input = screen.getByLabelText("Master password") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "synthetic" } });
  view.unmount();
  expect(input.value).toBe("");
  vi.stubGlobal("crypto", undefined);
  render(
    <HermesProgressInline
      invocations={[{ invocation, events: [event] }]}
      onVaultUnlock={submit}
    />,
  );
  const cancelledInput = screen.getByLabelText(
    "Master password",
  ) as HTMLInputElement;
  fireEvent.change(cancelledInput, { target: { value: "synthetic" } });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    expect(submit).toHaveBeenCalledWith(event, {
      version: 2,
      action: "cancel",
    }),
  );
  expect(cancelledInput.value).toBe("");
});
it.each([
  { id: "owner", type: "human" as const },
  { id: "other", type: "human" as const },
  { id: "requester", type: "bot" as const },
])("does not expose request or resolution to $type $id", ({ id, type }) => {
  act(() =>
    useAuthStore.setState({
      user: {
        id,
        type,
        name: "Other",
        email: null,
        avatar: null,
      },
    }),
  );
  render(
    <HermesProgressInline
      invocations={[{ invocation, events: [event] }]}
      onVaultUnlock={vi.fn()}
    />,
  );
  expect(screen.queryByLabelText("Master password")).toBeNull();
  expect(screen.queryByText("Unlock Bitwarden")).toBeNull();
  expect(screen.queryByTestId("hermes-vault-unlock-resolved")).toBeNull();
  render(
    <HermesProgressInline invocations={[{ invocation, events: [event, {
      ...event, id: "resolved", sequence: 2, type: "vault.unlock.resolved",
      payload: { version: 2, requestId: event.payload!.requestId, sessionKey: event.payload!.sessionKey, outcome: "submitted" },
    }] }]} onVaultUnlock={vi.fn()} />,
  );
  expect(screen.queryByTestId("hermes-vault-unlock-resolved")).toBeNull();
});

it.each(["resolution", "expiry", "viewer change"])("clears the captured password input on %s", reason => {
  vi.useFakeTimers();
  try {
    const view = render(<HermesProgressInline invocations={[{ invocation, events: [event] }]} onVaultUnlock={vi.fn()} />);
    const input = screen.getByLabelText("Master password") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "synthetic-sensitive" } });
    if (reason === "resolution") {
      view.rerender(<HermesProgressInline invocations={[{ invocation, events: [event, {
        ...event, id: "resolved", sequence: 2, type: "vault.unlock.resolved",
        payload: { version: 2, requestId: event.payload!.requestId, sessionKey: event.payload!.sessionKey, outcome: "cancelled" },
      }] }]} onVaultUnlock={vi.fn()} />);
      expect(screen.getByTestId("hermes-vault-unlock-resolved")).toHaveTextContent("cancelled");
    } else if (reason === "expiry") {
      act(() => { vi.setSystemTime(Number(event.payload!.expiresAt) + 1); vi.advanceTimersByTime(1000); });
      expect(screen.getByTestId("hermes-vault-unlock-resolved")).toHaveTextContent("expired");
    } else {
      act(() => useAuthStore.setState({ user: { id: "owner", type: "human", name: "Owner", email: null, avatar: null } }));
      expect(screen.queryByTestId("hermes-vault-unlock-resolved")).toBeNull();
    }
    expect(input.value).toBe("");
    expect(screen.queryByLabelText("Master password")).toBeNull();
    view.unmount();
  } finally { vi.useRealTimers(); }
});

it("rejects legacy v1 prompts instead of reinterpreting their authenticated context", () => {
  render(<HermesProgressInline invocations={[{ invocation, events: [{ ...event, payload: { ...event.payload, version: 1, ownerUserId: "owner" } }] }]} onVaultUnlock={vi.fn()} />);
  expect(screen.queryByLabelText("Master password")).toBeNull();
  expect(screen.queryByText("Unlock Bitwarden")).toBeNull();
});
