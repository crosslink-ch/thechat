import { beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ChatAttachment } from "@thechat/shared";
vi.mock("../platform/environment", () => ({ isWeb: true }));
vi.mock("../lib/shared-attachments", () => ({
  getAttachmentDownloadUrl: vi.fn(),
  openSharedAttachmentDownload: vi.fn(),
}));
import { SharedMessageAttachments } from "./SharedMessageAttachments";
import { getAttachmentDownloadUrl, openSharedAttachmentDownload } from "../lib/shared-attachments";
import { resetPrivateSession } from "../lib/session-boundary";
import { useAuthStore } from "../stores/auth";

const voice = {
  id: "voice-id", fileName: "voice.webm", name: "voice.webm",
  mediaType: "audio/webm", mimeType: "audio/webm", sizeBytes: 8570,
  kind: "file", contentPath: "/attachments/voice-id/content",
} satisfies ChatAttachment;
const capability = { url: "https://objects.example/voice", expiresAt: "later" };
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  useAuthStore.setState({ token: null, user: { id: "browser-user", name: "Browser", email: "browser@example.invalid", avatar: null, type: "human" } });
  vi.mocked(getAttachmentDownloadUrl).mockResolvedValue(capability);
  vi.mocked(openSharedAttachmentDownload).mockResolvedValue({ expiresAt: "later", transferredBytes: 8570 });
});

it("plays and downloads through cookie auth without requiring a bearer token", async () => {
  render(<SharedMessageAttachments attachments={[voice]} />);
  expect(getAttachmentDownloadUrl).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Load audio voice.webm" }));
  expect(await screen.findByLabelText("Audio: voice.webm")).toHaveAttribute("src", capability.url);
  expect(getAttachmentDownloadUrl).toHaveBeenCalledExactlyOnceWith("voice-id", null, "attachment");
  fireEvent.click(screen.getByRole("button", { name: "Download voice.webm" }));
  await screen.findByText("Saved to Downloads");
  expect(openSharedAttachmentDownload).toHaveBeenCalledExactlyOnceWith("voice-id", null, "attachment", "voice.webm");
});

it("removes a loaded capability and stops playback on a cookie session reset", async () => {
  render(<SharedMessageAttachments attachments={[voice]} />);
  fireEvent.click(screen.getByRole("button", { name: "Load audio voice.webm" }));
  const audio = await screen.findByLabelText("Audio: voice.webm");
  act(() => resetPrivateSession());
  expect(audio).not.toHaveAttribute("src");
  expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
  expect(screen.queryByLabelText("Audio: voice.webm")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Load audio voice.webm" })).toBeEnabled();
});

it("ignores late audio authorization even when successive cookie sessions both have null tokens", async () => {
  let finish!: (value: typeof capability) => void;
  vi.mocked(getAttachmentDownloadUrl).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  render(<SharedMessageAttachments attachments={[voice]} />);
  fireEvent.click(screen.getByRole("button", { name: "Load audio voice.webm" }));
  await act(async () => {
    resetPrivateSession();
    finish(capability);
  });
  expect(screen.queryByLabelText("Audio: voice.webm")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Load audio voice.webm" })).toBeEnabled();
});
