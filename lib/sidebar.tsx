// Voice section in the session sidebar (right pane): spoken replies on/off,
// speech language, microphone, service status, and record / last / stop
// buttons. Every control runs the same command as its keybind.
//
// .tsx because the TUI compiles plugin JSX at load time (OpenTUI's
// babel-preset-solid); the code itself is plain JavaScript. index.js imports
// this file lazily so `node --test` never has to load JSX.

import { createSignal, For, Show } from "solid-js";
import {
  TTS_LANGUAGES,
  buttonStates,
  headerState,
  healthUrl,
  activeVoice,
  micLabel,
  serviceLine,
  ttsLanguage,
  voiceLabel,
  voiceStatus,
} from "./status.js";

const HEALTH_MS = 15000;
const HEALTH_TIMEOUT_MS = 1500;

export function registerSidebar(context, { kv, commands, endpoint, voice = "" }) {
  const [status, setStatus] = createSignal(voiceStatus.get());
  const [now, setNow] = createSignal(Date.now());
  const [online, setOnline] = createSignal(null);
  const url = healthUrl(endpoint);
  const check = async () => {
    if (!url) return;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
      setOnline(response.ok);
    } catch {
      setOnline(false);
    }
  };
  const unsubscribe = voiceStatus.subscribe((next) => {
    // A started or stopped service: check health now, not in up to 15 s.
    if (next.service !== status().service) void check();
    setStatus(next);
    setNow(Date.now());
  });

  void check();
  const healthTimer = setInterval(check, HEALTH_MS);
  // Only the recording timer needs a ticking clock.
  const clock = setInterval(() => {
    if (voiceStatus.get().phase === "recording") setNow(Date.now());
  }, 1000);

  const run = (value) => commands.find((command) => command.value === value)?.onSelect();
  const stop = () => run(voiceStatus.get().phase === "recording" ? "stt.stop" : "tts.stop");

  const dispose = context.ui.slot({
    append: "sidebar.content",
    render: () => (
      <VoiceSection
        context={context}
        kv={kv}
        status={status}
        online={online}
        now={now}
        run={run}
        stop={stop}
        voiceOption={voice}
      />
    ),
  });

  return () => {
    unsubscribe();
    clearInterval(healthTimer);
    clearInterval(clock);
    dispose();
  };
}

function VoiceSection(props) {
  const theme = props.context.theme;
  const [view, updateView] = props.context.storage.store("sidebar", { initial: { open: true } });
  const color = (tone) =>
    tone === "muted"
      ? theme.text.muted
      : tone === "base"
        ? theme.text.base
        : theme.text.feedback[tone].base;

  const header = () => headerState(props.status(), props.online(), props.now());
  const buttons = () => buttonStates(props.status().phase, props.status().service);
  const service = () =>
    serviceLine(props.online(), props.status().firstAudioSeconds, props.status().service);
  const repliesOn = () => props.kv.get("tts.mode", "off") === "on";
  const language = () => ttsLanguage(props.kv.get("tts.language", "auto"));
  const mic = () => micLabel(props.kv.get("stt.mic", ""));
  const voice = () =>
    voiceLabel(activeVoice(props.kv.get("tts.api.voice", null), props.voiceOption));

  // Replies on/off is one toggle command; only run it when the click changes something.
  const setReplies = (on) => {
    if (on !== repliesOn()) props.run("tts.mode");
  };

  return (
    <box>
      <box
        flexDirection="row"
        gap={1}
        onMouseDown={() => {
          void updateView((draft) => {
            draft.open = !draft.open;
          }).catch(() => undefined);
        }}
      >
        <text fg={theme.text.muted}>{view.open ? "▼" : "▶"}</text>
        <text fg={theme.text.base}>
          <b>Voice</b>
        </text>
        {/* Folded with the service simply off, the switch below says it already. */}
        <Show when={view.open || props.status().service !== "stopped"}>
          <text fg={color(header().tone)}>{header().text}</text>
        </Show>
        {/* Folded: a quick replies on/off switch, so the section need not open. */}
        <Show when={!view.open}>
          <text
            fg={repliesOn() ? theme.text.feedback.success.base : theme.text.muted}
            // Keep the click from also folding/unfolding the section.
            onMouseDown={(event) => event.stopPropagation()}
            onMouseUp={() => props.run("tts.mode")}
          >
            {repliesOn() ? "[on]" : "[off]"}
          </text>
        </Show>
      </box>
      <Show when={view.open}>
        <Row theme={theme} label="replies">
          <Pill theme={theme} selected={repliesOn()} onClick={() => setReplies(true)}>
            on
          </Pill>
          <Pill theme={theme} selected={!repliesOn()} onClick={() => setReplies(false)}>
            off
          </Pill>
        </Row>
        <Row theme={theme} label="language">
          <For each={TTS_LANGUAGES}>
            {(key) => (
              <Pill
                theme={theme}
                selected={language() === key}
                onClick={() => props.kv.set("tts.language", key)}
              >
                {key}
              </Pill>
            )}
          </For>
        </Row>
        <Row theme={theme} label="voice">
          <text
            fg={theme.text.base}
            // Opens a dialog: act on release (see the mic row).
            onMouseDown={(event) => event.stopPropagation()}
            onMouseUp={() => props.run("tts.voice")}
          >
            {`${voice()} ›`}
          </text>
        </Row>
        <Row theme={theme} label="mic">
          <text
            fg={mic() ? theme.text.base : theme.text.feedback.warning.base}
            // Opens a dialog: act on release, or the release of the same
            // click lands on the dialog overlay and closes it again.
            onMouseDown={(event) => event.stopPropagation()}
            onMouseUp={() => props.run("stt.mic")}
          >
            {mic() ? `${mic()} ›` : "choose one ›"}
          </text>
        </Row>
        <Row theme={theme} label="service">
          <text fg={color(service().tone)}>{service().text}</text>
        </Row>
        <box flexDirection="row" gap={1}>
          <Button
            theme={theme}
            enabled={buttons().record}
            fg={theme.text.feedback.error.base}
            onClick={() => props.run("stt.record")}
          >
            {props.status().phase === "recording" ? "[■ done]" : "[● record]"}
          </Button>
          <Button
            theme={theme}
            enabled={buttons().last}
            fg={theme.text.feedback.info.base}
            onClick={() => props.run("tts.speak-last")}
          >
            [▶ last]
          </Button>
          <Button
            theme={theme}
            enabled={buttons().stop}
            fg={theme.text.feedback.error.base}
            onClick={props.stop}
          >
            [■ stop]
          </Button>
        </box>
      </Show>
    </box>
  );
}

function Row(props) {
  return (
    <box flexDirection="row" gap={1}>
      <box width={8}>
        <text fg={props.theme.text.muted}>{props.label}</text>
      </box>
      {props.children}
    </box>
  );
}

function Pill(props) {
  return (
    <box
      backgroundColor={props.selected ? props.theme.background.raised.base : undefined}
      onMouseDown={(event) => event.stopPropagation()}
      onMouseUp={() => props.onClick()}
    >
      <text fg={props.selected ? props.theme.text.base : props.theme.text.muted}>
        {` ${props.children} `}
      </text>
    </box>
  );
}

function Button(props) {
  return (
    <text
      fg={props.enabled ? props.fg : props.theme.text.muted}
      onMouseDown={(event) => event.stopPropagation()}
      onMouseUp={() => {
        if (props.enabled) props.onClick();
      }}
    >
      {props.children}
    </text>
  );
}
