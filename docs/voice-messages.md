# Voice messages

Voice recording is available in shared conversation composers, including channels and DMs/Hermes tasks with an established conversation. Local Agent Chat does not support audio attachments and does not show the microphone action.

## Send a recording

1. Select **Record voice message** and allow microphone access when prompted.
2. Select **Stop recording**. Recording stops automatically at five minutes; the existing 25 MiB attachment limit also applies.
3. Listen to the local preview. Choose **Discard recording** to delete it, or **Attach recording** to upload it through the existing attachment pipeline.
4. Wait for the attachment to be ready, then use **Send message**. An audio-only message is valid; existing draft text is preserved.

Recording and preview never send a message automatically. Preview audio stays local until **Attach recording**. Cancel, permission/device errors, leaving the composer, or changing accounts stop capture. Once attached, the normal attachment upload, retry, and draft lifecycle applies.

Received audio offers **Load audio** followed by native playback controls, plus the existing save-only **Download** action. Playback is not automatic. If authorization expires or the browser cannot decode the audio, reload it or download the file.

## Compatibility and security

- Recording requires a secure context and a runtime supporting `getUserMedia` and `MediaRecorder`. The recorder negotiates WebM/Opus, Ogg/Opus, or MP4; unsupported/denied capture produces a visible error.
- macOS builds include `NSMicrophoneUsageDescription` and the audio-input entitlement. Permission metadata requires rebuilding the native application, not only refreshing frontend assets.
- Native WebView support depends on the operating system and installed media stack, especially on Linux. Browser tests do not establish packaged WebView or physical-microphone support.
- Audio uses the existing authenticated reservation, size/quota/checksum checks, private object storage, worker validation, and message binding. No new storage service, transcription provider, or schema migration is required.
- WebM/MP4 container detection does not identify audio-only tracks. For a matching detected container, the server preserves the declared audio subtype as descriptive metadata. This does not grant inline download permission: files remain `kind: file`, stored/downloaded as `application/octet-stream` with attachment disposition.
- The audio player uses an explicit set of audio MIME types, never filenames or an iframe/OS opener. Signed download capabilities are requested only on user action and removed from the player when its account or attachment changes.

## Regression tests

Install workspace dependencies first. The API tests require the development `DATABASE_URL` from the normal ignored root `.env` or the command environment; never point test runs at production.

```sh
pnpm --filter @thechat/desktop vitest run \
  src/lib/voice-recording.test.ts \
  src/components/InputBar.voice.test.tsx \
  src/components/VoiceMessagePlayer.test.tsx \
  src/components/SharedMessageAttachments.test.tsx

(cd packages/api && bun test --isolate --env-file ../../.env \
  src/attachments/file-validation.test.ts \
  src/attachments/voice-validation.test.ts)

python3 scripts/test_tauri_flavors.py
```

The committed WebM fixture was captured with a real Chromium `getUserMedia`/`MediaRecorder` pipeline using Chromium's synthetic microphone. Its fixture README documents provenance and digest.

Before shipping a native release, check a real microphone in each supported packaged OS build: permission prompt, audible recording, preview, cancel/discard, audio-only send, playback after reload, and microphone release when switching conversations or accounts. Automated Chromium acceptance uses the actual React route and real API/PostgreSQL/Redis/worker/S3 lifecycle, but stubs Tauri IPC and cannot replace that native-device check.
