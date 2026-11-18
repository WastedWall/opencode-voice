import assert from "node:assert/strict";
import test from "node:test";

import {
  buttonStates,
  createBridge,
  createStatus,
  sidebarBridge,
  formatElapsed,
  headerState,
  healthUrl,
  micLabel,
  serviceLine,
  ttsLanguage,
} from "../lib/status.js";
import { buildSpeechRequest } from "../lib/tts.js";

test("status notifies listeners and keeps the first audio time", () => {
  let clock = 1000;
  const status = createStatus(() => clock);
  const seen = [];
  const unsubscribe = status.subscribe((s) => seen.push(s.phase));

  status.set("recording");
  clock = 5000;
  status.set("speaking", { firstAudioSeconds: 2.5 });
  status.set("idle");
  unsubscribe();
  status.set("recording");

  assert.deepEqual(seen, ["recording", "speaking", "idle"]);
  assert.equal(status.get().firstAudioSeconds, 2.5);
  assert.equal(status.get().since, 5000);
});

test("header shows the phase, with the recording timer", () => {
  assert.deepEqual(headerState({ phase: "recording", since: 0 }, true, 64000), {
    text: "● rec 1:04",
    tone: "error",
  });
  assert.equal(headerState({ phase: "transcribing" }, true, 0).text, "⌛ transcribing");
  assert.equal(headerState({ phase: "generating" }, true, 0).text, "⌛ generating");
  assert.equal(headerState({ phase: "speaking" }, true, 0).tone, "info");
  assert.deepEqual(headerState({ phase: "idle" }, true, 0), { text: "● ready", tone: "success" });
  assert.deepEqual(headerState({ phase: "idle" }, false, 0), { text: "● offline", tone: "error" });
  // Not checked yet: do not claim offline.
  assert.equal(headerState({ phase: "idle" }, null, 0).text, "● ready");
});

test("buttons only offer what works in each phase", () => {
  assert.deepEqual(buttonStates("idle"), { record: true, last: true, stop: false });
  assert.deepEqual(buttonStates("recording"), { record: true, last: false, stop: true });
  assert.deepEqual(buttonStates("transcribing"), { record: false, last: false, stop: false });
  assert.deepEqual(buttonStates("generating"), { record: false, last: false, stop: true });
  assert.deepEqual(buttonStates("speaking"), { record: false, last: false, stop: true });
});

test("service line", () => {
  assert.deepEqual(serviceLine(null, null), { text: "not checked", tone: "muted" });
  assert.deepEqual(serviceLine(false, 1.2), { text: "offline", tone: "error" });
  assert.deepEqual(serviceLine(true, null), { text: "online", tone: "success" });
  assert.equal(serviceLine(true, 1.44).text, "online · first audio 1.4 s");
});

test("health URL sits next to /v1", () => {
  assert.equal(healthUrl("http://127.0.0.1:8787/v1"), "http://127.0.0.1:8787/health");
  assert.equal(healthUrl("http://127.0.0.1:8787/v1/"), "http://127.0.0.1:8787/health");
  assert.equal(healthUrl(undefined), null);
  assert.equal(healthUrl("not a url"), null);
});

test("mic label drops the Windows prefix and fits the sidebar", () => {
  assert.equal(
    micLabel("Microphone (4- Logitech PRO X Wireless Gaming Headset)"),
    "Logitech PRO X Wirele…",
  );
  assert.equal(micLabel("Microphone (NVIDIA Broadcast)"), "NVIDIA Broadcast");
  assert.equal(micLabel("alsa_input.usb-mic"), "alsa_input.usb-mic");
  assert.equal(micLabel(""), "");
});

test("speech language falls back to auto", () => {
  assert.equal(ttsLanguage("nl"), "nl");
  assert.equal(ttsLanguage("de"), "auto");
  assert.equal(ttsLanguage(undefined), "auto");
  const request = buildSpeechRequest("http://h/v1", { model: "m", input: "x", language: "en" });
  assert.equal(request.body.language, "en");
  assert.equal(buildSpeechRequest("http://h/v1", { model: "m", input: "x" }).body.language, "auto");
});

test("elapsed time format", () => {
  assert.equal(formatElapsed(0), "0:00");
  assert.equal(formatElapsed(-50), "0:00");
  assert.equal(formatElapsed(125000), "2:05");
});

test("a managed service that is not running shows as off and disables record", () => {
  const stopped = { phase: "idle", service: "stopped" };
  assert.deepEqual(headerState(stopped, false, 0), { text: "○ off", tone: "muted" });
  assert.equal(headerState({ phase: "idle", service: "starting" }, false, 0).text, "⌛ starting");
  assert.deepEqual(buttonStates("idle", "stopped"), { record: false, last: false, stop: false });
  assert.deepEqual(buttonStates("idle", "running"), { record: true, last: true, stop: false });
  assert.deepEqual(serviceLine(false, null, "stopped"), {
    text: "stopped · GPU free",
    tone: "muted",
  });
  assert.equal(serviceLine(false, null, "starting").text, "starting, about 30 s");
  // Not managed: unchanged behaviour.
  assert.deepEqual(buttonStates("idle"), { record: true, last: true, stop: false });
});

test("update changes fields without resetting the phase timer", () => {
  let clock = 1000;
  const status = createStatus(() => clock);
  status.set("recording");
  clock = 9000;
  status.update({ service: "running" });
  assert.equal(status.get().phase, "recording");
  assert.equal(status.get().since, 1000);
  assert.equal(status.get().service, "running");
});

test("sidebar bridge hands the controls to late subscribers and reports removal", () => {
  const bridge = createBridge();
  const seen = [];
  const unsubscribe = bridge.subscribe((value) => seen.push(value));
  const controls = { kv: {}, commands: [], endpoint: "http://h/v1" };
  bridge.set(controls);
  assert.equal(bridge.get(), controls);
  bridge.set(null);
  unsubscribe();
  bridge.set(controls);
  assert.deepEqual(seen, [controls, null]);
});

test("sidebar bridge is one shared object per global scope", () => {
  const scope = {};
  const first = sidebarBridge(scope);
  assert.equal(sidebarBridge(scope), first);
  assert.equal(scope[Symbol.for("opencode-voice.sidebar")], first);
  assert.notEqual(sidebarBridge({}), first);
});
