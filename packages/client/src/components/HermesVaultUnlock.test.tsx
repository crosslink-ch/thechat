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
      id: "owner",
      type: "human",
      name: "Owner",
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
      version: 1,
      requestId: "11111111-1111-4111-a111-111111111111",
      sessionKey: "session",
      profileId: "profile",
      backend: "bitwarden",
      ownerUserId: "owner",
      requesterUserId: "owner",
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
it("masks and clears the secret before encrypted submission, keeping errors fixed", async () => {
  const submit = vi.fn().mockRejectedValue(new Error("DO_NOT_REFLECT"));
  render(
    <HermesProgressInline
      invocations={[{ invocation, events: [event] }]}
      onVaultUnlock={submit}
    />,
  );
  expect(screen.getByTestId("hermes-vault-unlock-request")).toHaveTextContent(
    /owner vault/,
  );
  const input = screen.getByLabelText("Master password") as HTMLInputElement;
  expect(input.type).toBe("password");
  fireEvent.change(input, { target: { value: "  päss🔒  " } });
  fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
  expect(input.value).toBe("");
  await waitFor(() => expect(submit).toHaveBeenCalledOnce());
  expect(submit.mock.calls[0][1]).toEqual({
    version: 1,
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
      version: 1,
      action: "cancel",
    }),
  );
  expect(cancelledInput.value).toBe("");
});
it("does not expose an actionable vault prompt to other users or bots", () => {
  act(() =>
    useAuthStore.setState({
      user: {
        id: "other",
        type: "human",
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
});
