import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { uploadSharedAttachment } from "../lib/shared-attachments";

const mocks = vi.hoisted(() => ({
  createThread: vi.fn(), renameThread: vi.fn(), touchThread: vi.fn(),
  addOptimisticSentMessage: vi.fn(() => "client-message-1"),
  sendChannelMessage: vi.fn(), sendChannelMessageToThread: vi.fn(async () => true),
  wsSendMessage: vi.fn(), sendTyping: vi.fn(),
  threads: [] as any[],
}));
vi.mock("../stores/auth", () => ({
  useAuthStore: (selector: (state: unknown) => unknown) => selector({ token: "token-1", user: { id: "user-1", name: "Human", type: "human" } }),
}));
vi.mock("../stores/workspaces", () => {
  const state = { activeWorkspace: { members: [] } };
  const store = (selector: (value: typeof state) => unknown) => selector(state);
  store.getState = () => ({ touchThread: mocks.touchThread });
  return { useWorkspacesStore: store };
});
vi.mock("../stores/websocket", () => ({
  useWebSocketStore: (selector: (state: unknown) => unknown) => selector({ sendMessage: mocks.wsSendMessage, sendTyping: mocks.sendTyping }),
}));
vi.mock("../hooks/useConversationDetail", () => ({
  useConversationDetail: () => ({
    data: { id: "dm-1", type: "direct", participants: [
      { userId: "user-1", user: { id: "user-1", name: "Human", type: "human" } },
      { userId: "bot-user-1", user: { id: "bot-user-1", name: "Hermes", type: "bot" }, bot: { id: "bot-1", kind: "hermes", commands: [] } },
    ] }, isLoading: false, error: null,
  }),
}));
vi.mock("../hooks/useConversationThreads", () => ({
  useConversationThreads: () => ({ threads: mocks.threads, loading: false, loadingMore: false, hasMore: false, loadMore: vi.fn(), createThread: mocks.createThread, renameThread: mocks.renameThread, touchThread: mocks.touchThread }),
}));
vi.mock("../hooks/useBotRuntime", () => ({
  useBotRuntime: () => ({ data: { invocations: [], events: [] }, isLoading: false }),
  useBotRuntimeCache: () => ({ mergeInvocationUpdate: vi.fn(), mergeProgressEvent: vi.fn(), invalidate: vi.fn() }),
  submitHermesInteraction: vi.fn(),
}));
vi.mock("../hooks/useChannelChat", () => ({
  useChannelChat: () => ({ messages: [], loading: false, loadingOlder: false, hasOlderMessages: false, sendError: null,
    sendMessage: mocks.sendChannelMessage, sendMessageToThread: mocks.sendChannelMessageToThread,
    sendTyping: mocks.sendTyping, addMessage: vi.fn(), addOptimisticSentMessage: mocks.addOptimisticSentMessage, loadOlderMessages: vi.fn(),
  }),
}));
vi.mock("../hooks/useScopedCommands", () => ({ useScopedCommands: vi.fn() }));
vi.mock("../stores/hermes-indicators", () => {
  const state = { pendingApprovals: [], pendingClarifications: [], unreadScopes: {}, setVisibleScope: vi.fn(), seedFromSnapshot: vi.fn() };
  const store = (selector: (value: typeof state) => unknown) => selector(state);
  store.getState = () => state;
  return { hermesScopeKey: (id: string, thread: string | null) => `${id}:${thread ?? "general"}`, useHermesIndicatorsStore: store };
});
vi.mock("../stores/hermes-approvals", () => {
  const state = { decisions: {} };
  const store = (selector: (value: typeof state) => unknown) => selector(state);
  store.getState = () => state;
  return { recordApprovalDecision: vi.fn(), useHermesApprovalsStore: store };
});
vi.mock("../CommandPalette", () => ({ closePaletteAndRefocus: vi.fn() }));
vi.mock("../components/ChannelChatView", () => ({ ChannelChatView: () => <div /> }));
vi.mock("../components/HermesRuntimePanel", () => ({
  HermesRuntimePanel: ({ onCreateThread, draftTaskActive, onSelectThread, threads }: any) => <aside>
    <button onClick={onCreateThread}>New task</button>
    <button onClick={() => onSelectThread(null)}>General</button>
    {threads.map((t: any) => <button key={t.id} onClick={() => onSelectThread(t.id)}>{t.title}</button>)}
    {draftTaskActive && <div data-testid="local-task-draft">New task draft</div>}
  </aside>,
}));
vi.mock("../lib/shared-attachments", async (original) => ({
  ...await original<typeof import("../lib/shared-attachments")>(),
  uploadSharedAttachment: vi.fn(), cancelSharedAttachment: vi.fn(async () => {}),
}));
// DmRoute, HermesDmChatView, InputBar and VoiceRecorder remain real.
import { DmRoute } from "./dm";
import { useComposerDraftsStore } from "../stores/composer-drafts";

const persistedThread = { id: "thread-1", title: "Existing task", conversationId: "dm-1", botId: "bot-1", status: "open", createdAt: "2026-07-27T00:00:00.000Z", updatedAt: "2026-07-27T00:00:00.000Z", lastActivityAt: "2026-07-27T00:00:00.000Z" };
async function renderRoute(initialEntry = "/dm/dm-1") {
  const rootRoute = createRootRoute();
  const dmRoute = createRoute({ getParentRoute: () => rootRoute, path: "/dm/$id", validateSearch: (s: Record<string, unknown>) => ({ threadId: typeof s.threadId === "string" ? s.threadId : undefined }), component: DmRoute });
  const router = createRouter({ routeTree: rootRoute.addChildren([dmRoute]), history: createMemoryHistory({ initialEntries: [initialEntry] }) });
  await act(async () => { render(<RouterProvider router={router as any} />); });
}
class IncidentRecorder {
  static isTypeSupported = (type: string) => type === "audio/webm;codecs=opus";
  static current: IncidentRecorder;
  mimeType = "audio/webm;codecs=opus"; state = "inactive";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null; onerror: (() => void) | null = null;
  constructor() { IncidentRecorder.current = this; }
  start() { this.state = "recording"; }
  stop() { this.state = "inactive"; }
  finish() { this.ondataavailable?.({ data: new Blob(["voice"], { type: this.mimeType }) }); return this.onstop?.(); }
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.threads = [];
  mocks.createThread.mockResolvedValue(persistedThread);
  mocks.addOptimisticSentMessage.mockReturnValue("client-message-1");
  useComposerDraftsStore.setState({ drafts: {}, revisions: {}, imageDrafts: {}, attachmentDrafts: {}, sendingAttachments: {} });
  vi.stubGlobal("MediaRecorder", IncidentRecorder);
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })) } });
  Element.prototype.scrollIntoView = vi.fn();
  URL.createObjectURL = vi.fn(() => "blob:voice-preview"); URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  vi.mocked(uploadSharedAttachment).mockImplementation(async ({ file }, update) => {
    const attachment = { id: "voice-id", fileName: file.name, name: file.name, mediaType: file.type, mimeType: file.type, sizeBytes: file.size, kind: "file" as const, width: null, height: null, status: "ready" as const, contentPath: "/attachments/voice-id/content" };
    update({ phase: "ready", progress: 100, attachment }); return attachment;
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function incidentPreview() {
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Record voice message" })));
  fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));
  await act(async () => { await IncidentRecorder.current.finish(); });
}
it("creates a new task from a voice-only first message", async () => {
  await renderRoute();
  fireEvent.click(screen.getByRole("button", { name: "New task" }));
  await incidentPreview();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Send voice message" })));

  expect(uploadSharedAttachment).toHaveBeenCalledOnce();
  expect(mocks.createThread).toHaveBeenCalledExactlyOnceWith({ botId: "bot-1", title: "New task" });
  expect(mocks.wsSendMessage).toHaveBeenCalledExactlyOnceWith("dm-1", "", "thread-1", "client-message-1", ["voice-id"]);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByLabelText("Voice message preview")).toBeNull();
});

it("retries voice-only task creation without uploading the recording again", async () => {
  mocks.createThread.mockResolvedValueOnce(null);
  await renderRoute();
  fireEvent.click(screen.getByRole("button", { name: "New task" }));
  await incidentPreview();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Send voice message" })));

  expect(mocks.createThread).toHaveBeenCalledOnce();
  expect(mocks.wsSendMessage).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Voice message preview")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Send voice message" })).toHaveTextContent("Retry");

  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Send voice message" })));
  expect(uploadSharedAttachment).toHaveBeenCalledOnce();
  expect(mocks.createThread).toHaveBeenCalledTimes(2);
  expect(mocks.wsSendMessage).toHaveBeenCalledExactlyOnceWith("dm-1", "", "thread-1", "client-message-1", ["voice-id"]);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByLabelText("Voice message preview")).toBeNull();
});

it.each(["general", "existing"])("sends a voice-only message to %s without creating another task", async (target) => {
  mocks.threads = [persistedThread];
  await renderRoute(target === "existing" ? "/dm/dm-1?threadId=thread-1" : "/dm/dm-1");
  await incidentPreview();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Send voice message" })));
  expect(mocks.createThread).not.toHaveBeenCalled();
  expect(mocks.sendChannelMessageToThread).toHaveBeenCalledWith("", target === "existing" ? "thread-1" : null, ["voice-id"]);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByLabelText("Voice message preview")).toBeNull();
});
