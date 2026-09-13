# Voice recording regression fixture

`voice-without-duration.webm` is genuine Chromium 153 MediaRecorder output from a synthetic Web Audio oscillator on the task's Hetzner devbox. It contains no physical microphone recording, speech, or private conversation.

- Capture: `AudioContext.createOscillator()` connected to a media-stream destination, `audio/webm;codecs=opus`, 1-second MediaRecorder timeslices, approximately 1.3 seconds of capture.
- Original browser metadata reports `duration === Infinity`. The regression verifies that recording finalization inserts measured duration without transcoding the audio payload.
- SHA-256: `8db503ae39df16e79b0fd7956620ab7219c57d7f3344360f42940ffa94f299d1`.

The task's capture script is retained outside the repository at `/workspace/pr74-evidence/ui/capture-webm.cjs`; the committed regression consumes these exact fixture bytes and does not require microphone access.
