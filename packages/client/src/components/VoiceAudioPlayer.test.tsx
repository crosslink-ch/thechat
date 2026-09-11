import { StrictMode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { VoiceAudioPlayer } from "./VoiceAudioPlayer";

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
});

it("commits a newly authorized source only once before starting playback", async () => {
  const view = render(<VoiceAudioPlayer audioLabel="Remote" loadSource={async () => "https://example.invalid/audio"} />);
  const audio = view.container.querySelector("audio")!;
  const mutations: MutationRecord[] = [];
  const observer = new MutationObserver(records => mutations.push(...records));
  observer.observe(audio, { attributes: true, attributeFilter: ["src"] });
  try {
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Play voice message" })));
    mutations.push(...observer.takeRecords());
    expect(mutations).toHaveLength(1);
    expect(audio).toHaveAttribute("src", "https://example.invalid/audio");
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledOnce();
  } finally { observer.disconnect(); }
});

it("keeps a local preview source through StrictMode effect replay without autoplay", () => {
  const view = render(<StrictMode><VoiceAudioPlayer audioLabel="Preview" source="blob:local" /></StrictMode>);
  const audio = screen.getByLabelText("Preview");
  expect(audio).toHaveAttribute("src", "blob:local");
  expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  view.unmount();
  expect(audio).not.toHaveAttribute("src");
});

it.each(["playing", "authorizing"])("only the most recently requested message can play when another is %s", async (phase) => {
  let authorize!: (url: string) => void;
  const loadSource = vi.fn(() => phase === "authorizing" ? new Promise<string>(resolve => { authorize = resolve; }) : Promise.resolve("blob:first"));
  render(<><VoiceAudioPlayer audioLabel="First" label="first" loadSource={loadSource} /><VoiceAudioPlayer audioLabel="Second" label="second" source="blob:second" /></>);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Play first" })));
  const beforeSecond = vi.mocked(HTMLMediaElement.prototype.pause).mock.calls.length;
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Play second" })));
  if (phase === "authorizing") await act(async () => authorize("blob:first"));
  expect(screen.getByRole("button", { name: "Play first" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Pause second" })).toBeInTheDocument();
  if (phase === "playing") expect(vi.mocked(HTMLMediaElement.prototype.pause).mock.calls.length).toBeGreaterThan(beforeSecond);
  else expect(HTMLMediaElement.prototype.play).toHaveBeenCalledOnce();
});

it("returns to Play at the end, replays from the start, and releases media on unmount", async () => {
  const view = render(<VoiceAudioPlayer audioLabel="Preview" source="blob:local" />);
  const audio = screen.getByLabelText("Preview") as HTMLAudioElement;
  Object.defineProperty(audio, "duration", { value: 10 });
  fireEvent.loadedMetadata(audio);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Play voice message" })));
  audio.currentTime = 10;
  fireEvent.timeUpdate(audio);
  fireEvent.ended(audio);
  expect(screen.getByRole("button", { name: "Play voice message" })).toBeEnabled();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Play voice message" })));
  expect(audio.currentTime).toBe(0);
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2);
  view.unmount();
  expect(audio).not.toHaveAttribute("src");
  expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
  expect(HTMLMediaElement.prototype.load).toHaveBeenCalled();
});

it("shows measured local capture duration before Play without loading media", () => {
  render(<VoiceAudioPlayer audioLabel="Preview" source="blob:local" durationSeconds={83} />);
  expect(screen.getByText("1:23")).toBeInTheDocument();
  expect(screen.getByRole("slider")).toBeDisabled();
  expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  expect(HTMLMediaElement.prototype.load).not.toHaveBeenCalled();
});

it("cycles playback speed without implicitly starting audio", () => {
  render(<VoiceAudioPlayer audioLabel="Preview" source="blob:local" />);
  const audio = screen.getByLabelText("Preview") as HTMLAudioElement;
  for (const rate of [1.5, 2, 1]) {
    fireEvent.click(screen.getByRole("button", { name: /Playback speed/ }));
    expect(audio.playbackRate).toBe(rate);
    expect(audio.defaultPlaybackRate).toBe(rate);
    expect(screen.getByRole("button", { name: `Playback speed ${rate}×` })).toBeInTheDocument();
  }
  expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
});

it("shows real media duration and allows accessible seeking without starting playback", () => {
  render(<VoiceAudioPlayer audioLabel="Voice message preview" label="voice message preview" source="blob:local" />);
  const audio = screen.getByLabelText("Voice message preview") as HTMLAudioElement;
  expect(screen.getByRole("slider", { name: "Seek voice message preview" })).toBeDisabled();
  Object.defineProperty(audio, "duration", { configurable: true, value: 83 });
  fireEvent.loadedMetadata(audio);
  const seek = screen.getByRole("slider", { name: "Seek voice message preview" });
  expect(seek).toHaveAttribute("max", "83");
  expect(screen.getByText("1:23")).toBeInTheDocument();
  fireEvent.change(seek, { target: { value: "42" } });
  expect(audio.currentTime).toBe(42);
  expect(seek).toHaveAttribute("aria-valuetext", "0:42 of 1:23");
  audio.currentTime = 44;
  fireEvent.timeUpdate(audio);
  expect(seek).toHaveValue("44");
  expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
});
