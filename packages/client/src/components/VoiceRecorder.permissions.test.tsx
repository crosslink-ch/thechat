import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { VoiceRecorder } from "./VoiceRecorder";
import { resetPrivateSession } from "../lib/session-boundary";

const native = vi.hoisted(() => ({
  getPermissionState: vi.fn(), prepareRecording: vi.fn(), cancelRecording: vi.fn(), openSettings: vi.fn(),
}));
vi.mock("#platform-services", () => ({ services: { microphone: native } }));
vi.mock("../lib/shared-attachments", () => ({ SHARED_ATTACHMENT_MAX_BYTES: 25 * 1024 * 1024, uploadSharedAttachment: vi.fn(), cancelSharedAttachment: vi.fn() }));
const getUserMedia = vi.fn();
const stop = vi.fn();
const props = { scope: { conversationId: "chat", token: "token" }, disabled: false, onBusyChange: vi.fn(), onSend: vi.fn() };
beforeEach(() => {
  vi.clearAllMocks();
  native.getPermissionState.mockResolvedValue("prompt");
  native.prepareRecording.mockResolvedValue(undefined);
  native.cancelRecording.mockResolvedValue(undefined);
  native.openSettings.mockResolvedValue(undefined);
  getUserMedia.mockResolvedValue({ getTracks: () => [{ stop }] });
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
  vi.stubGlobal("MediaRecorder", class {
    static isTypeSupported = () => true;
    state = "inactive";
    start() { this.state = "recording"; }
    stop() { this.state = "inactive"; }
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it.each(["app", "device"])("offers calm recovery for %s denial without bypassing consent", async (denial) => {
  native.getPermissionState.mockResolvedValue(denial === "app" ? "denied" : "granted");
  if (denial === "device") getUserMedia.mockRejectedValueOnce(new DOMException("Denied", "NotAllowedError"));
  render(<VoiceRecorder {...props} />);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Record voice message" })));
  expect(screen.getByRole("alert")).toHaveTextContent(/microphone/i);
  expect(screen.getByRole("alert").className).not.toContain("text-error");
  if (denial === "app") {
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(native.prepareRecording).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/saved microphone block/i);
    expect(screen.getByRole("alert")).toHaveTextContent(/Windows settings cannot reset/i);
    expect(screen.queryByRole("button", { name: "Open microphone settings" })).toBeNull();
  } else {
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Open microphone settings" })));
    expect(native.openSettings).toHaveBeenCalledOnce();
  }
  fireEvent.click(screen.getByRole("button", { name: "Not now" }));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("button", { name: "Record voice message" })).toBeInTheDocument();
});

it.each(["not now", "disabled", "session", "unmount"])("fences a pending native permission lookup after %s", async (change) => {
  let finish!: (value: string) => void;
  native.getPermissionState.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const view = render(<VoiceRecorder {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Record voice message" }));
  if (change === "not now") fireEvent.click(screen.getByRole("button", { name: "Not now" }));
  if (change === "disabled") view.rerender(<VoiceRecorder {...props} disabled />);
  if (change === "session") act(() => resetPrivateSession());
  if (change === "unmount") view.unmount();
  await act(async () => finish("granted"));
  expect(getUserMedia).not.toHaveBeenCalled();
  expect(native.prepareRecording).not.toHaveBeenCalled();
  expect(native.cancelRecording).toHaveBeenCalled();
});

it("asks for native app consent before granting the one-shot capture lease", async () => {
  const view = render(<VoiceRecorder {...props} />);
  expect(native.getPermissionState).not.toHaveBeenCalled();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Record voice message" })));
  expect(getUserMedia).not.toHaveBeenCalled();
  expect(native.prepareRecording).not.toHaveBeenCalled();
  expect(screen.getByText("Your voice, when you choose")).toBeInTheDocument();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Allow microphone and record" })));
  expect(native.prepareRecording).toHaveBeenCalledOnce();
  expect(getUserMedia).toHaveBeenCalledExactlyOnceWith({ audio: true });
  expect(native.prepareRecording.mock.invocationCallOrder[0]).toBeLessThan(getUserMedia.mock.invocationCallOrder[0]);
  expect(screen.getByRole("button", { name: "Stop recording" })).toBeInTheDocument();
  view.unmount();
  expect(native.cancelRecording).toHaveBeenCalled();
  expect(stop).toHaveBeenCalled();
});
