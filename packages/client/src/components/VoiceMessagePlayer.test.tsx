import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ChatAttachment } from "@thechat/shared";
import { SharedMessageAttachments } from "./SharedMessageAttachments";
import { getAttachmentDownloadUrl, openSharedAttachmentDownload } from "../lib/shared-attachments";
import { useAuthStore } from "../stores/auth";

vi.mock("../lib/shared-attachments", () => ({
  getAttachmentDownloadUrl: vi.fn(),
  openSharedAttachmentDownload: vi.fn(),
}));
const voice = {
  id: "voice-id", fileName: "voice-message.webm", name: "voice-message.webm",
  mediaType: "audio/webm", mimeType: "audio/webm", sizeBytes: 8570,
  kind: "file", contentPath: "/attachments/voice-id/content",
} satisfies ChatAttachment;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  useAuthStore.setState({ token: "voice-token" });
  vi.mocked(getAttachmentDownloadUrl).mockResolvedValue({
    url: "https://objects.example/authorized-audio",
    expiresAt: new Date(Date.now() + 90_000).toISOString(),
  });
  vi.mocked(openSharedAttachmentDownload).mockResolvedValue({
    expiresAt: new Date(Date.now() + 90_000).toISOString(), transferredBytes: 8570,
  });
});

describe("voice message playback", () => {
  it.each(["audio/ogg", "audio/mp4", "audio/mpeg", "audio/wav", "audio/flac", "audio/aac", "audio/x-m4a", "audio/opus", " AUDIO/WEBM;codecs=opus "])("offers a constrained audio player for %s", (mediaType) => {
    render(<SharedMessageAttachments attachments={[{...voice,mediaType,mimeType:mediaType}]} />);
    expect(screen.getByRole("button", {name:"Play voice message"})).toBeInTheDocument();
    expect(getAttachmentDownloadUrl).not.toHaveBeenCalled();
  });

  it.each(["text/html", "image/svg+xml", "application/octet-stream", "audio/html", "video/webm"])("keeps %s download-only even with a voice filename", (mediaType) => {
    render(<SharedMessageAttachments attachments={[{...voice,mediaType,mimeType:mediaType}]} />);
    expect(screen.queryByRole("button", {name:"Play voice message"})).not.toBeInTheDocument();
    expect(screen.getByTitle("Download voice-message.webm")).toBeInTheDocument();
    expect(getAttachmentDownloadUrl).not.toHaveBeenCalled();
  });

  it("authorizes and plays on the first explicit Play with custom controls and no autoplay", async () => {
    render(<SharedMessageAttachments attachments={[voice]} />);
    expect(getAttachmentDownloadUrl).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Play voice message" }));
    const audio = await screen.findByLabelText("Audio: voice-message.webm");
    expect(getAttachmentDownloadUrl).toHaveBeenCalledExactlyOnceWith("voice-id", "voice-token", "attachment");
    expect(audio.tagName).toBe("AUDIO");
    expect(audio).toHaveAttribute("src", "https://objects.example/authorized-audio");
    expect(audio).not.toHaveAttribute("controls");
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledOnce();
    expect(audio).toHaveAttribute("preload", "none");
    expect(audio).not.toHaveAttribute("autoplay");
  });

  it("discards late authorization from a previous signed-in account", async () => {
    let complete!: (value: Awaited<ReturnType<typeof getAttachmentDownloadUrl>>) => void;
    vi.mocked(getAttachmentDownloadUrl).mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
    render(<SharedMessageAttachments attachments={[voice]} />);
    fireEvent.click(screen.getByRole("button", { name: "Play voice message" }));
    act(() => useAuthStore.setState({ token: "different-account-token" }));
    await act(async () => complete({url: "https://objects.example/old-account", expiresAt: new Date().toISOString()}));
    expect(screen.queryByLabelText("Audio: voice-message.webm")).not.toBeInTheDocument();
    expect(screen.getByRole("button", {name:"Play voice message"})).toBeEnabled();
  });

  it("stops playback and removes the signed URL when authentication changes", async () => {
    render(<SharedMessageAttachments attachments={[voice]} />);
    fireEvent.click(screen.getByRole("button", {name:"Play voice message"}));
    const audio = await screen.findByLabelText("Audio: voice-message.webm");
    act(() => useAuthStore.setState({token:null}));
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
    expect(audio).not.toHaveAttribute("src");
    expect(HTMLMediaElement.prototype.load).toHaveBeenCalled();
    expect(screen.queryByLabelText("Audio: voice-message.webm")).not.toBeInTheDocument();
  });

  it("serializes authorization and allows retry after a failed request", async () => {
    let reject!: (error: Error) => void;
    vi.mocked(getAttachmentDownloadUrl).mockReturnValueOnce(new Promise((_, fail) => {reject=fail;}));
    render(<SharedMessageAttachments attachments={[voice]} />);
    const load = screen.getByRole("button", {name:"Play voice message"});
    fireEvent.click(load);
    expect(load).toBeDisabled();
    fireEvent.click(load);
    expect(getAttachmentDownloadUrl).toHaveBeenCalledTimes(1);
    await act(async () => reject(new Error("Permission expired")));
    expect(await screen.findByRole("alert")).toHaveTextContent("Permission expired");
    expect(load).toBeEnabled();
    fireEvent.click(load);
    await screen.findByLabelText("Audio: voice-message.webm");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("re-authorizes after a decoder or expired-media-URL error", async () => {
    render(<SharedMessageAttachments attachments={[voice]} />);
    fireEvent.click(screen.getByRole("button", {name:"Play voice message"}));
    const audio = await screen.findByLabelText("Audio: voice-message.webm");
    fireEvent.error(audio);
    expect(await screen.findByRole("alert")).toHaveTextContent("Audio could not be played");
    expect(audio).not.toHaveAttribute("src");
    vi.mocked(getAttachmentDownloadUrl).mockResolvedValueOnce({url:"https://objects.example/refreshed",expiresAt:new Date().toISOString()});
    fireEvent.click(screen.getByRole("button", {name:"Play voice message"}));
    expect(await screen.findByLabelText("Audio: voice-message.webm")).toHaveAttribute("src","https://objects.example/refreshed");
    expect(getAttachmentDownloadUrl).toHaveBeenCalledTimes(2);
  });

  it("keeps a save-only download fallback without loading playback", async () => {
    render(<SharedMessageAttachments attachments={[voice]} />);
    fireEvent.click(screen.getByRole("button", {name:"Download voice-message.webm"}));
    expect(openSharedAttachmentDownload).toHaveBeenCalledExactlyOnceWith("voice-id","voice-token","attachment","voice-message.webm");
    expect(await screen.findByText("Saved to Downloads")).toBeInTheDocument();
    expect(getAttachmentDownloadUrl).not.toHaveBeenCalled();
  });

  it("keeps playback available after a failed native download and allows retry", async () => {
    let reject!: (error: unknown) => void;
    vi.mocked(openSharedAttachmentDownload).mockReturnValueOnce(new Promise((_, fail) => {reject=fail;}));
    render(<SharedMessageAttachments attachments={[voice]} />);
    fireEvent.click(screen.getByRole("button", {name:"Play voice message"}));
    const audio = await screen.findByLabelText("Audio: voice-message.webm");
    const download=screen.getByRole("button", {name:"Download voice-message.webm"});
    fireEvent.click(download);
    expect(download).toBeDisabled();
    fireEvent.click(download);
    expect(openSharedAttachmentDownload).toHaveBeenCalledTimes(1);
    await act(async () => reject("Disk full"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Disk full");
    expect(audio).toHaveAttribute("src","https://objects.example/authorized-audio");
    expect(download).toBeEnabled();
    fireEvent.click(download);
    await screen.findByText("Saved to Downloads");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
