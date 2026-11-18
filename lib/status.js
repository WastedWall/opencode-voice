// Voice status shared by the STT and TTS modules and shown in the sidebar.
// Pure logic: no OpenCode or Solid imports, so it is testable with node --test.

// Phases: idle, recording, transcribing (STT), generating (waiting for the
// speech API), speaking (audio playing). `service` is the state of a voice
// service the plugin starts and stops itself (lib/service.js): null when it
// does not manage one, else starting, running, stopping or stopped.
export function createStatus(now = () => Date.now()) {
  let state = { phase: "idle", since: now(), firstAudioSeconds: null, service: null };
  const listeners = new Set();

  return {
    get: () => state,
    set(phase, extra = {}) {
      state = { ...state, ...extra, phase, since: now() };
      for (const listener of listeners) listener(state);
    },
    // Change other fields without touching the phase or its timer.
    update(extra) {
      state = { ...state, ...extra };
      for (const listener of listeners) listener(state);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const voiceStatus = createStatus();

// Lets a separate folder plugin (sidebar-plugin/) draw the Voice section from
// its own place in the plugin load order. The voice plugin publishes
// { register(context) } here; the folder plugin calls it with its context.
// The bridge lives on a global Symbol.for key, not in module state: the folder
// plugin is loaded through a link and cannot import this file, and the two
// plugins may get separate copies of a module.
export const SIDEBAR_BRIDGE_KEY = Symbol.for("opencode-voice.sidebar");

export function createBridge() {
  let value = null;
  const listeners = new Set();
  return {
    get: () => value,
    set(next) {
      value = next;
      for (const listener of listeners) listener(next);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

// sidebar-plugin/tui.tsx repeats this (it cannot import it); keep them alike.
export function sidebarBridge(scope = globalThis) {
  scope[SIDEBAR_BRIDGE_KEY] ??= createBridge();
  return scope[SIDEBAR_BRIDGE_KEY];
}

// Speech languages the sidebar can force; "auto" lets the service detect.
export const TTS_LANGUAGES = ["auto", "nl", "en"];

export function ttsLanguage(value) {
  return TTS_LANGUAGES.includes(value) ? value : "auto";
}

// The service's /health sits next to /v1: http://host:8787/v1 -> http://host:8787/health.
export function healthUrl(endpoint) {
  if (!endpoint) return null;
  try {
    return new URL("/health", endpoint).toString();
  } catch {
    return null;
  }
}

// Short microphone name for the narrow sidebar:
// "Microphone (4- Logitech PRO X Wireless Gaming Headset)" -> "Logitech PRO X Wireless…".
export function micLabel(name, max = 22) {
  if (!name) return "";
  let label = name.replace(/^Microphone \((.*)\)$/, "$1").replace(/^\d+- /, "");
  if (label.length > max) label = `${label.slice(0, max - 1).trimEnd()}…`;
  return label;
}

export function formatElapsed(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

// Header text and tone for the sidebar section. `online` is true, false, or
// null when the service has not been checked (or no endpoint is configured).
export function headerState(status, online, now) {
  switch (status.phase) {
    case "recording":
      return { text: `● rec ${formatElapsed(now - status.since)}`, tone: "error" };
    case "transcribing":
      return { text: "⌛ transcribing", tone: "warning" };
    case "generating":
      return { text: "⌛ generating", tone: "warning" };
    case "speaking":
      return { text: "▶ speaking", tone: "info" };
    default:
      if (status.service === "starting") return { text: "⌛ starting", tone: "warning" };
      if (status.service === "stopping") return { text: "⌛ stopping", tone: "muted" };
      if (status.service === "stopped") return { text: "○ off", tone: "muted" };
      if (online === false) return { text: "● offline", tone: "error" };
      return { text: "● ready", tone: "success" };
  }
}

// Which buttons can do something right now. Transcription cannot be
// cancelled (the request is already on its way), so stop is off then.
// A managed service that is not running cannot transcribe or speak.
export function buttonStates(phase, service = null) {
  const available = service === null || service === "running";
  return {
    record: available && (phase === "idle" || phase === "recording"),
    last: available && phase === "idle",
    stop: phase === "recording" || phase === "generating" || phase === "speaking",
  };
}

export function serviceLine(online, firstAudioSeconds, service = null) {
  if (service === "starting") return { text: "starting, about 30 s", tone: "warning" };
  if (service === "stopping") return { text: "stopping", tone: "muted" };
  if (service === "stopped") return { text: "stopped · GPU free", tone: "muted" };
  if (online === null) return { text: "not checked", tone: "muted" };
  if (!online) return { text: "offline", tone: "error" };
  const suffix =
    firstAudioSeconds == null ? "" : ` · first audio ${firstAudioSeconds.toFixed(1)} s`;
  return { text: `online${suffix}`, tone: "success" };
}
