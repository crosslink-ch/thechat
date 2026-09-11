# Voice messages

Voice recording is available in web and desktop shared conversations, including channels and DMs/Hermes tasks with an established conversation. Local Agent Chat remains image-only.

## Record, review, send

1. Select **Record voice message**. Microphone access is requested only after an explicit action, never at startup or login.
2. Record your note using the in-composer controls. **Cancel recording** discards it; **Stop recording** opens a local review. Recording stops automatically at five minutes and the existing 25 MiB limit applies.
3. Listen using the voice-note player. **Discard recording** deletes the local recording.
4. Select **Send voice message**. This one action uploads and sends the note, with progress and retry feedback. There is no separate attachment-confirmation step.

A voice-note send is standalone: text and other attachment drafts remain available for a separate message. Recording, stopping, and previewing never send or upload automatically. Local audio is retained for retry if upload or message submission fails. Cancel, device failure, leaving the composer, and changing accounts release capture; late permission responses cannot start recording in another conversation.

Received notes have a compact custom player rather than a filename/native-control file card. **Play voice message** both authorizes and starts playback in one click. The player offers play/pause, an accessible seek timeline, elapsed/total time when available, playback speed, and a separate save-only download action. Audio never starts simply because a message becomes visible. Starting another note stops the previous one. Failed or expired sources can be retried without weakening attachment authorization.

## Microphone permissions

- **Windows desktop:** TheChat owns the first-use explanation and explicit microphone consent. The native adapter handles only trusted main-window microphone requests tied to a short-lived recording action. It does not grant camera/iframe access or change Windows privacy settings. Existing saved denials are respected. Recovery opens the fixed Windows microphone privacy page only when requested by the user.
- **Browser:** normal browser permissions remain authoritative. Denied/unavailable microphones have an in-composer explanation and can be retried after access is restored.
- **macOS:** native builds include `NSMicrophoneUsageDescription` and the audio-input entitlement. macOS consent remains required.
- **Linux:** capture depends on the installed WebView/media stack. Chromium tests are not evidence of Linux WebKit microphone support.

Native permission changes require rebuilding the desktop binary, not merely refreshing the frontend. A legacy saved WebView microphone denial is preserved and identified separately from OS/device failure: Windows privacy settings cannot reset that app-specific choice, and this version has no in-app saved-permission reset. The UI states that limitation rather than directing the user to the wrong settings page. Do not claim Windows first-use consent works from browser mocks or Linux tests alone.

## Compatibility and security

- Capture requires a secure context and `getUserMedia`/`MediaRecorder`; recording negotiates WebM/Opus, Ogg/Opus, or MP4.
- The browser uses its existing HttpOnly session cookie, not a JavaScript bearer token. Session reset releases capture/previews and clears loaded audio capabilities. Production serves same-origin microphone policy while camera/geolocation remain disabled.
- Audio reuses the existing authenticated reservation, quota/size/checksum validation, private object store, worker validation, and message binding. There is no new transcription provider or schema migration.
- Matching WebM/MP4 audio declarations remain descriptive metadata only. Files stay opaque `application/octet-stream` downloads with attachment disposition; they are not granted generic inline delivery or passed to an OS opener.
- Signed sources are requested only on user action and cleared on account/attachment changes. Playback/download errors remain recoverable.
- Newly captured WebM needs real duration metadata for useful seeking. Duration handling must be tested with real MediaRecorder output, not only finite-duration mocks.

## Regression tests

Install workspace dependencies first. API tests require a disposable development `DATABASE_URL`; never aim test runs at production.

```sh
pnpm --filter @thechat/client vitest run \
  src/lib/voice-recording.test.ts \
  src/lib/voice-recording.webm.test.ts \
  src/components/InputBar.voice.test.tsx \
  src/components/VoiceAudioPlayer.test.tsx \
  src/components/VoiceMessagePlayer.test.tsx \
  src/components/VoiceMessagePlayer.browser.test.tsx \
  src/components/SharedMessageAttachments.test.tsx

(cd packages/api && bun test --isolate --env-file ../../.env \
  src/attachments/file-validation.test.ts \
  src/attachments/voice-validation.test.ts)

python3 scripts/test_tauri_flavors.py
```

For browser acceptance, start the isolated loopback API, worker, compiled frontend, Postgres/Redis and versioned S3 stack described in `docs/web.md`, then configure `THECHAT_WEB_E2E_URL` / `THECHAT_WEB_E2E_API_URL`:

```sh
pnpm exec playwright test -c scripts/e2e/web/playwright.config.ts \
  voice.spec.ts voice-permission.spec.ts \
  --project=chromium-desktop --project=chromium-phone
```

The permission spec intentionally uses headed Chromium. On display-less Linux, prefix the command with `xvfb-run -a`; do not add the fake-permission-UI flag to make it pass.

The voice journey uses Chromium's synthetic microphone with real `getUserMedia`, `MediaRecorder`, decoding, cookie authentication, actual channel/DM routes and backend/storage lifecycle. It asserts cancellation, local preview, one-action send, preserved text drafts, reload, lazy one-click playback, finite duration/keyboard seeking, exact downloaded bytes, and narrow layout containment. The separate permission journey controls real Chromium permission state without the fake-permission-UI flag. Neither is physical microphone or Windows WebView2 permission evidence.

## Packaged release checklist

Use an isolated native profile and a real microphone on each supported OS:

- First consent, subsequent recording, restart, and existing saved allow/deny states.
- Windows OS microphone privacy disabled/enabled; missing device; useful recovery.
- Audible recording, stop/cancel, local preview, one Send, failed upload/send retry.
- Playback after reload, seeking/speed, download, and only one playing note.
- Capture and signed-source cleanup after account/conversation changes and delayed permission responses.
- Windows adapter origin/frame/gesture policy in both development and packaged builds. Older WebView2 runtimes missing required interfaces must fail safely.

The committed WebM fixture is genuine synthetic-device Chromium capture; see its fixture README for provenance. Browser and cross-compilation results do not replace this native-device checklist.
