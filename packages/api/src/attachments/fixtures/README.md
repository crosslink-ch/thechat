# Chromium MediaRecorder audio fixture

`chromium-voice.webm` is a real Chromium MediaRecorder capture from a synthetic fake audio device, not a physical microphone recording. Captured by the voice feature acceptance harness on 2026-09-06 using Playwright Chromium and `--use-fake-device-for-media-stream` / `--use-fake-ui-for-media-stream`. The capture proof is retained with the devbox acceptance evidence.

- Size: 8570 bytes
- SHA-256: `27c57d03f8282c0fadf788c0a1499b7a61f11827644ea4329374f9fc62695534`
- Recorder: `audio/webm;codecs=opus`
- file-type 21.3.4: `video/webm` (container-level detection)

This regression proves metadata normalization for downstream audio consumers while preserving opaque storage/delivery and the non-image file kind. It does not prove microphone permissions on macOS, Windows, or native WebKit.
