import assert from "node:assert/strict";
import test from "node:test";

import { buildFfmpegRecordArgs, parseDshowDevices } from "../lib/audio-windows.js";
import { buildMultipartTranscriptionRequest } from "../lib/stt.js";
import { buildSpeechRequest } from "../lib/tts.js";

test("parses DirectShow audio devices and skips video devices", () => {
  const stderr = [
    '[dshow @ 0000020f] "Integrated Camera" (video)',
    '[dshow @ 0000020f]   Alternative name "@device_pnp_\\\\?\\usb#vid"',
    '[dshow @ 0000020f] "Microphone (USB Audio Device)" (audio)',
    '[dshow @ 0000020f]   Alternative name "@device_cm_{33D9A762}\\wave_{ABC}"',
    '[dshow @ 0000020f] "Headset Microphone (Realtek(R) Audio)" (audio)\r',
    "dummy: Immediate exit requested",
  ].join("\n");

  assert.deepEqual(parseDshowDevices(stderr), [
    { name: "Microphone (USB Audio Device)", label: "Microphone (USB Audio Device)" },
    {
      name: "Headset Microphone (Realtek(R) Audio)",
      label: "Headset Microphone (Realtek(R) Audio)",
    },
  ]);
  assert.deepEqual(parseDshowDevices(""), []);
  assert.deepEqual(parseDshowDevices(undefined), []);
});

test("builds ffmpeg record args for 16 kHz mono 16-bit WAV", () => {
  const args = buildFfmpegRecordArgs("Microphone (USB)", "C:\\tmp\\opencode-stt.wav", false);
  assert.deepEqual(args.slice(-8), [
    "-ac",
    "1",
    "-ar",
    "16000",
    "-sample_fmt",
    "s16",
    "-y",
    "C:\\tmp\\opencode-stt.wav",
  ]);
  assert.ok(args.includes("audio=Microphone (USB)"));
  assert.ok(!args.includes("-af"));

  const trimmed = buildFfmpegRecordArgs("Mic", "out.wav", true);
  assert.equal(
    trimmed[trimmed.indexOf("-af") + 1],
    "silenceremove=start_periods=1:start_threshold=-50dB",
  );
});

test("sends the transcription language only when it is not auto", () => {
  const audio = Buffer.from("RIFF");
  const withLang = buildMultipartTranscriptionRequest("whisper", audio, null, "nl");
  assert.equal(withLang.body.get("language"), "nl");
  assert.equal(withLang.headers.Authorization, undefined);

  const auto = buildMultipartTranscriptionRequest("whisper", audio, "key", "auto");
  assert.equal(auto.body.get("language"), null);
  assert.equal(auto.headers.Authorization, "Bearer key");
});

test("builds speech API requests with WAV output and language detection", () => {
  const request = buildSpeechRequest("http://127.0.0.1:8787/v1/", {
    model: "chatterbox-multilingual",
    voice: null,
    input: "Klaar.",
  });
  assert.equal(request.url, "http://127.0.0.1:8787/v1/audio/speech");
  assert.deepEqual(request.body, {
    model: "chatterbox-multilingual",
    input: "Klaar.",
    response_format: "wav",
    language: "auto",
  });

  const withVoice = buildSpeechRequest("http://host/v1", {
    model: "m",
    voice: "elder",
    input: "x",
  });
  assert.equal(withVoice.url, "http://host/v1/audio/speech");
  assert.equal(withVoice.body.voice, "elder");
});
