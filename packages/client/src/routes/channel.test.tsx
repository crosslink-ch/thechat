import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { webcrypto } from "node:crypto";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { SECURE_INPUT_KINDS, type BotInvocationProgressEventPublic, type BotInvocationPublic, type BotRuntimeSnapshot, type SecureInputKind, type SecureInputRequest } from "@thechat/shared";
import { ChannelRoute } from "./channel";
import { api } from "../lib/api";
import { useAuthStore } from "../stores/auth";
import { useConversationsStore } from "../stores/conversations";
import { createTestQueryClient } from "../test-utils/query";
import { secureInputContext } from "../lib/hermes-secure-input";
import { wsEvents } from "../lib/ws-events";
import { botRuntimeQueryKey } from "../hooks/useBotRuntime";

// Keep the real route, view, runtime hooks/cache, progress forms, and WebCrypto.
// Only the transport boundary and unrelated chat data/composer are fixtures.
vi.mock("../lib/api", () => ({ API_URL: "http://localhost:23000", api: { "bot-runtime": { conversations: vi.fn(), invocations: vi.fn() } } }));
vi.mock("../hooks/usePersistConversationRead", () => ({ usePersistConversationRead: vi.fn() }));
vi.mock("../hooks/useChannelChat", () => {
  const chat = { messages: [], loading: false, loadingOlder: false, hasOlderMessages: false, sendError: null, sendMessage: vi.fn(), addMessage: vi.fn(), loadOlderMessages: vi.fn(), setReaction: vi.fn() };
  return { useChannelChat: () => chat };
});
vi.mock("../components/InputBar", () => ({ InputBar: () => <textarea aria-label="Ordinary channel composer" /> }));

let keys: webcrypto.CryptoKeyPair;
let publicKeySpkiB64: string;
let snapshots: Map<string, BotRuntimeSnapshot>;
const post = vi.fn();
const vaultPost = vi.fn();
const interactions = vi.fn();
const get = vi.fn();
const clients: ReturnType<typeof createTestQueryClient>[] = [];
function invocation(conversationId = "channel-1", id = "run"): BotInvocationPublic {
  return { id, botId: "bot", botUserId: "bot-user", botName: "Hermes", botKind: "hermes", conversationId, threadId: null, status: "running", createdAt: new Date().toISOString(), startedAt: new Date().toISOString() } as BotInvocationPublic;
}
function event(kind: SecureInputKind = "vault.code", run = invocation()): BotInvocationProgressEventPublic {
  return { id: `event-${run.id}`, invocationId: run.id, botId: run.botId, conversationId: run.conversationId, threadId: run.threadId, sequence: 1, type: "secure.input.request", status: "waiting", toolCallId: null, toolName: null, label: "UNTRUSTED LABEL", preview: "UNTRUSTED PREVIEW", createdAt: new Date().toISOString(), occurredAt: new Date().toISOString(), payload: {
    version: 3, requestId: "11111111-1111-4111-a111-111111111111", sessionKey: "session", profileId: "profile", requesterUserId: "requester", promptKind: kind, fields: [...SECURE_INPUT_KINDS[kind].fields], target: kind === "onepassword.unlock" ? "1Password" : kind === "skill.secret" ? "TEST_SECRET" : "https://example.test", nonce: Buffer.alloc(32).toString("base64url"), expiresAt: Date.now() + 120000, algorithm: "RSA-OAEP-3072-SHA256+A256GCM", publicKeySpkiB64,
  } };
}
function seed(e = event(), run = invocation()) {
  snapshots.set(run.conversationId, { invocations: [run], events: [e] } as BotRuntimeSnapshot);
  return e;
}
async function mount() {
  const root = createRootRoute();
  const route = createRoute({ getParentRoute: () => root, path: "/channel/$id", component: ChannelRoute });
  const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: ["/channel/channel-1"] }) });
  const client = createTestQueryClient();
  clients.push(client);
  const view = render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
  await screen.findByTestId("channel-chat-scroll");
  return { ...view, client, router };
}
beforeAll(async () => {
  keys = await webcrypto.subtle.generateKey({ name: "RSA-OAEP", modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["encrypt", "decrypt"]);
  publicKeySpkiB64 = Buffer.from(await webcrypto.subtle.exportKey("spki", keys.publicKey)).toString("base64");
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("crypto", webcrypto);
  snapshots = new Map();
  useAuthStore.setState({ token: "test-token", user: { id: "requester", type: "human", name: "Requester", email: null, avatar: null } });
  useConversationsStore.setState({ markChannelRead: vi.fn() });
  get.mockImplementation((conversationId: string) => Promise.resolve({ data: snapshots.get(conversationId) ?? { invocations: [], events: [] }, error: null }));
  vi.mocked(api["bot-runtime"].conversations).mockImplementation(({ conversationId }) => ({ get: (...args: unknown[]) => get(conversationId, ...args) }) as any);
  post.mockResolvedValue({ data: { ok: true, duplicate: false }, error: null });
  vaultPost.mockResolvedValue({ data: { ok: true, duplicate: false }, error: null });
  interactions.mockReturnValue({ "secure-input": { post }, "vault-unlock": { post: vaultPost } });
  vi.mocked(api["bot-runtime"].invocations).mockReturnValue({ interactions } as any);
});
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.unstubAllGlobals(); });

it.each(Object.keys(SECURE_INPUT_KINDS) as SecureInputKind[])("renders channel snapshot and encrypts exact %s fields through Eden", async (kind) => {
  const e = seed(event(kind));
  const { client } = await mount();
  const form = await screen.findByTestId("hermes-secure-input-request");
  expect(form).toHaveTextContent(SECURE_INPUT_KINDS[kind].title);
  const inputs = [...form.querySelectorAll("input")];
  const values = Object.fromEntries(SECURE_INPUT_KINDS[kind].fields.map(field => [field, `  synthetic-ä-${field}  `]));
  inputs.forEach((input, index) => {
    const field = SECURE_INPUT_KINDS[kind].fields[index];
    expect(input.type).toBe(field === "identifier" ? "text" : "password");
    fireEvent.change(input, { target: { value: values[field] } });
  });
  fireEvent.click(screen.getByRole("button", { name: "Send securely" }));
  inputs.forEach(input => expect(input.value).toBe(""));
  await waitFor(() => expect(post).toHaveBeenCalledOnce());
  expect(api["bot-runtime"].invocations).toHaveBeenCalledWith({ invocationId: e.invocationId });
  expect(interactions).toHaveBeenCalledWith({ eventId: e.id });
  const [response, options] = post.mock.calls[0];
  expect(options).toEqual({ headers: { authorization: "Bearer test-token" } });
  expect(response).toEqual({ version: 3, action: "submit", wrappedKeyB64: expect.any(String), ivB64: expect.any(String), ciphertextB64: expect.any(String) });
  const context = new Uint8Array(new TextEncoder().encode(secureInputContext(e, e.payload as unknown as SecureInputRequest)));
  const raw = await webcrypto.subtle.decrypt({ name: "RSA-OAEP", label: context }, keys.privateKey, Buffer.from(response.wrappedKeyB64, "base64"));
  const aes = await webcrypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
  const plaintext = await webcrypto.subtle.decrypt({ name: "AES-GCM", additionalData: context, iv: Buffer.from(response.ivB64, "base64"), tagLength: 128 }, aes, Buffer.from(response.ciphertextB64, "base64"));
  expect(JSON.parse(new TextDecoder().decode(plaintext))).toEqual(values);
  expect(JSON.stringify(client.getQueryCache().getAll().map(q => q.state.data))).not.toContain("synthetic-ä");
  expect(JSON.stringify(client.getQueryCache().getAll().map(q => q.state.data))).not.toContain(response.ciphertextB64);
  expect(screen.getByLabelText("Ordinary channel composer")).toHaveValue("");
  await waitFor(() => expect(get.mock.calls.length).toBeGreaterThan(1));
});

it("accepts only matching channel realtime context, cancels privately and clears terminal prompts", async () => {
  const { client } = await mount();
  await waitFor(() => expect(get).toHaveBeenCalled());
  const run = invocation();
  const e = event();
  const push = (value: typeof e, envelope = run.conversationId, inv = run) => wsEvents.emit("ws:bot_invocation_progress", { conversationId: envelope, invocationId: value.invocationId, event: value, invocation: inv });
  act(() => {
    push(e, "other-channel");
    push({ ...e, conversationId: "other-channel" });
    push(e, run.conversationId, { ...run, conversationId: "other-channel" });
    push({ ...e, botId: "other-bot" });
    push({ ...e, threadId: "other-thread" });
    wsEvents.emit("ws:bot_invocation_updated", { conversationId: run.conversationId, invocation: { ...run, conversationId: "other-channel" } });
  });
  expect(client.getQueryData(botRuntimeQueryKey("channel-1"))).toMatchObject({ invocations: [], events: [] });
  act(() => push(e));
  const input = await screen.findByLabelText("Verification or recovery code") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "synthetic-cancel" } });
  vi.stubGlobal("crypto", undefined);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(input.value).toBe("");
  await waitFor(() => expect(post).toHaveBeenCalledWith({ version: 3, action: "cancel" }, { headers: { authorization: "Bearer test-token" } }));
  await waitFor(() => expect(get.mock.calls.length).toBeGreaterThan(1));
  act(() => push(e));
  const nextInput = await screen.findByLabelText("Verification or recovery code") as HTMLInputElement;
  fireEvent.change(nextInput, { target: { value: "synthetic-finalize" } });
  act(() => wsEvents.emit("ws:bot_invocation_updated", { conversationId: run.conversationId, invocation: { ...run, status: "completed" } }));
  await waitFor(() => expect(screen.queryByLabelText("Verification or recovery code")).toBeNull());
  expect(nextInput.value).toBe("");
});

it("offers a jump for new private progress without pulling an ordinary reader to the bottom", async () => {
  await mount();
  await waitFor(() => expect(get).toHaveBeenCalled());
  const scroller = screen.getByTestId("channel-chat-scroll");
  Object.defineProperties(scroller, { scrollHeight: { configurable: true, value: 1600 }, clientHeight: { configurable: true, value: 300 }, scrollTop: { configurable: true, writable: true, value: 200 } });
  fireEvent.wheel(scroller, { deltaY: -80 });
  fireEvent.scroll(scroller);
  const run = invocation();
  act(() => wsEvents.emit("ws:bot_invocation_progress", { conversationId: run.conversationId, invocationId: run.id, invocation: run, event: event() }));
  await screen.findByLabelText("Verification or recovery code");
  expect(scroller.scrollTop).toBe(200);
  fireEvent.click(screen.getByRole("button", { name: "Jump to bottom" }));
  expect(scroller.scrollTop).toBe(1600);
});

it("ignores snapshot events outside the current conversation or invocation context", async () => {
  const run = invocation();
  const foreignRun = invocation("other-channel", "other-run");
  snapshots.set("channel-1", { invocations: [run, foreignRun], events: [event("vault.code", foreignRun), { ...event(), id: "wrong-bot", botId: "wrong-bot" }, { ...event(), id: "wrong-thread", threadId: "wrong-thread" }] } as BotRuntimeSnapshot);
  await mount();
  await waitFor(() => expect(get).toHaveBeenCalled());
  expect(screen.queryByTestId("hermes-secure-input-request")).toBeNull();
});

it.each(["observer", "bot"])("hides requester metadata from %s, including cached snapshots and live resolutions", async viewer => {
  const e = seed();
  useAuthStore.setState({ user: { id: viewer === "bot" ? "requester" : viewer, type: viewer === "bot" ? "bot" : "human", name: "Observer", email: null, avatar: null } });
  const { client } = await mount();
  act(() => {
    client.setQueryData(botRuntimeQueryKey("channel-1"), snapshots.get("channel-1"));
    wsEvents.emit("ws:bot_invocation_progress", { conversationId: "channel-1", invocationId: "run", invocation: invocation(), event: { ...e, id: "resolved", sequence: 2, type: "secure.input.resolved", payload: { version: 3, requestId: e.payload!.requestId, sessionKey: e.payload!.sessionKey, outcome: "cancelled" } } });
  });
  await waitFor(() => expect(screen.queryByTestId("hermes-secure-input-request")).toBeNull());
  expect(screen.queryByTestId("hermes-secure-input-resolved")).toBeNull();
  expect(screen.queryByText("https://example.test")).toBeNull();
  expect(post).not.toHaveBeenCalled();
});

it("clears filled fields and subscriptions on channel switches, ignores old events, and recovers on reconnect", async () => {
  const e = seed();
  const second = invocation("channel-2", "second-run");
  seed(event("vault.save_login", second), second);
  const baseline = wsEvents.all.get("ws:bot_invocation_progress")?.length ?? 0;
  const { router, client, unmount } = await mount();
  const input = await screen.findByLabelText("Verification or recovery code") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "synthetic-leave" } });
  await act(async () => { await router.navigate({ to: "/channel/$id", params: { id: "channel-2" } }); });
  await screen.findByTestId("hermes-secure-input-request");
  expect(input.value).toBe("");
  expect(screen.queryByLabelText("Verification or recovery code")).toBeNull();
  expect(wsEvents.all.get("ws:bot_invocation_progress")).toHaveLength(baseline + 1);
  const previous = client.getQueryData(botRuntimeQueryKey("channel-1"));
  act(() => wsEvents.emit("ws:bot_invocation_progress", { conversationId: "channel-1", invocationId: "run", invocation: invocation(), event: { ...e, id: "late", sequence: 2 } }));
  expect(client.getQueryData(botRuntimeQueryKey("channel-1"))).toBe(previous);
  const fields = [...screen.getByTestId("hermes-secure-input-request").querySelectorAll("input")];
  fields.forEach(field => fireEvent.change(field, { target: { value: "synthetic-leave" } }));
  const fetches = get.mock.calls.length;
  snapshots.set("channel-2", { invocations: [], events: [] } as unknown as BotRuntimeSnapshot);
  act(() => wsEvents.emit("ws:authenticated", {}));
  await waitFor(() => expect(screen.queryByTestId("hermes-secure-input-request")).toBeNull());
  expect(get.mock.calls.length).toBeGreaterThan(fetches);
  fields.forEach(field => expect(field.value).toBe(""));
  // The old channel resolved while this route was not subscribed to it.
  snapshots.set("channel-1", { invocations: [], events: [] } as unknown as BotRuntimeSnapshot);
  await act(async () => { await router.navigate({ to: "/channel/$id", params: { id: "channel-1" } }); });
  await waitFor(() => expect(screen.queryByTestId("hermes-secure-input-request")).toBeNull());
  unmount();
  expect(wsEvents.all.get("ws:bot_invocation_progress") ?? []).toHaveLength(baseline);
  expect(post).not.toHaveBeenCalled();
});

it("drops in-flight encryption when navigating to another channel", async () => {
  seed();
  let finish!: () => void;
  const blocked = new Promise<void>(resolve => { finish = resolve; });
  const encrypt = vi.fn(webcrypto.subtle.encrypt.bind(webcrypto.subtle));
  vi.stubGlobal("crypto", { subtle: { importKey: (...args: unknown[]) => blocked.then(() => Reflect.apply(webcrypto.subtle.importKey, webcrypto.subtle, args)), encrypt }, getRandomValues: webcrypto.getRandomValues.bind(webcrypto) });
  const { router } = await mount();
  const input = await screen.findByLabelText("Verification or recovery code") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "synthetic-in-flight" } });
  fireEvent.click(screen.getByRole("button", { name: "Send securely" }));
  expect(input.value).toBe("");
  await act(async () => { await router.navigate({ to: "/channel/$id", params: { id: "channel-2" } }); });
  await act(async () => { finish(); await blocked; });
  await waitFor(() => expect(encrypt).toHaveBeenCalledTimes(2));
  await act(async () => { await Promise.all(encrypt.mock.results.map(result => result.value)); });
  expect(post).not.toHaveBeenCalled();
});

it.each(["submit", "cancel"])("wires the retained Bitwarden v2 %s callback in the real channel", async action => {
  const e = event();
  const { promptKind: _kind, fields: _fields, target: _target, ...base } = e.payload!;
  seed({ ...e, type: "vault.unlock.request", payload: { ...base, version: 2, backend: "bitwarden" } });
  await mount();
  const input = await screen.findByLabelText("Master password") as HTMLInputElement;
  expect(screen.getByText(/all users of this agent\/profile/)).toBeInTheDocument();
  fireEvent.change(input, { target: { value: "synthetic-v2" } });
  fireEvent.click(screen.getByRole("button", { name: action === "submit" ? "Unlock" : "Cancel" }));
  expect(input.value).toBe("");
  await waitFor(() => expect(vaultPost).toHaveBeenCalledOnce());
  expect(vaultPost.mock.calls[0][0]).toMatchObject({ version: 2, action });
  expect(JSON.stringify(vaultPost.mock.calls)).not.toContain("synthetic-v2");
  expect(post).not.toHaveBeenCalled();
  expect(interactions).toHaveBeenCalledWith({ eventId: e.id });
});
