// Text-to-speech: LLM normalization, Piper synthesis, sox playback.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { isWindows, spawnRawPlayer } from "./audio-windows.js";
import { TTS_LANGUAGES, ttsLanguage, voiceStatus } from "./status.js";
import { getSessionTitle } from "./session.js";

const VOICES_DIR = path.join(os.homedir(), ".local", "share", "piper-voices");

const TTS_VOICES = {
  ryan: { label: "Ryan (high)", file: "en_US-ryan-high.onnx" },
  bryce: { label: "Bryce (medium)", file: "en_US-bryce-medium.onnx" },
};
const DEFAULT_TTS_VOICE = "ryan";

const PIPER_RATE = 22050;
const PIPER_BITS = 16;
const PIPER_CHANNELS = 1;

// ---- System prompts ----

const SYSTEM_AUTO = `You are a text-to-speech narrator for a coding assistant CLI. Your job is to convert the assistant's markdown output into natural spoken text that is useful and pleasant to listen to.

You have three modes depending on the content complexity:

1. NARRATE - For simple explanations, short answers, and conversational responses. Convert to natural spoken text, normalizing code references for speech.
   - camelCase/PascalCase identifiers: split into words (parseConfig -> "parse config")
   - File paths: use just the filename (src/utils/helpers.ts -> "helpers dot ts")
   - Short code snippets in backticks: read them naturally
   - Keep the narrative flow intact

2. SUMMARIZE - For responses with significant code blocks, multiple file changes, or complex technical details. Provide a brief spoken summary of what was done and tell the user to check the screen.
   - Mention what was changed and why
   - Do not try to describe code blocks verbatim
   - End with something like "check the details on your screen" or "take a look at the output for the specifics"

3. NOTIFY - For very short confirmations, status updates, or acknowledgments. Keep it to one brief sentence.

Keep it short and easy to say: SUMMARIZE in two or three sentences, NOTIFY in one, and keep every sentence under about 15 words. Split long sentences instead of joining clauses with commas. Do not read out titles, branch names, commit messages or long identifiers in full; describe them briefly instead ("a pull request for the scout cleanup").

Choose the appropriate mode based on the content. Most responses with code blocks should use SUMMARIZE mode. Simple Q&A or short explanations use NARRATE. Build results, "done", confirmations use NOTIFY.

Write the spoken text in the same language as the assistant's output. Never translate.

Output ONLY the spoken text. Nothing else. No mode labels. No commentary.`;

const SYSTEM_MANUAL = `You are a text-to-speech reader for a coding assistant. The user has explicitly requested this text be read aloud. Read the prose content faithfully and in detail.

Rules:
- Read all prose text naturally and completely
- Code identifiers: split camelCase/PascalCase/snake_case into words (parseConfig -> "parse config", my_variable -> "my variable")
- File paths: read just the filename with extension (src/utils/helpers.ts -> "helpers dot ts")
- Line references: keep as is ("line 42")
- URLs: say "a link" or just the domain name
- Code blocks: skip entirely, just say "code block" or "code snippet"
- Error codes: expand naturally (ECONNREFUSED -> "connection refused")
- Shell commands: read them naturally (npm test -> "npm test")
- List items: read each item
- Remove markdown formatting but preserve all the informational content
- Do NOT summarize. Do NOT say "check the screen". Read everything that is prose.
- Keep the language of the text. Never translate.
- Output ONLY the spoken text`;

// ---- Session helpers ----

async function getTurnAssistantText(api) {
  const route = api.route.current;
  if (route.name !== "session") return null;

  const sessionID = route.params.sessionID;
  const messages = api.state.session.messages(sessionID);
  if (!messages || messages.length === 0) return null;

  // Collect the assistant messages of the current turn (since the last user
  // message). V2 messages carry their full projected content.
  const assistant = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].type === "user") break;
    if (messages[i].type === "assistant") assistant.unshift(messages[i]);
  }
  if (assistant.length === 0) return null;

  const allText = [];
  for (const message of assistant) {
    const text = (message.content || [])
      .filter((part) => part.type === "text")
      .map((part) => part.text || "")
      .join("\n\n")
      .trim();
    if (text) allText.push(text);
  }

  if (allText.length === 0) return null;

  return {
    lastMessageID: assistant[assistant.length - 1].id,
    text: allText.join("\n\n"),
  };
}

// ---- Speech API (OpenAI-compatible /audio/speech) ----

export function buildSpeechRequest(endpoint, { model, voice, input, language = "auto" }) {
  const base = endpoint.endsWith("/") ? endpoint.slice(0, -1) : endpoint;
  // "pcm" streams sentence by sentence; playback starts after the first one.
  const body = { model, input, response_format: "pcm", language: ttsLanguage(language) };
  if (voice) body.voice = voice;
  return { url: `${base}/audio/speech`, body };
}

// Chatterbox's rate; the service sends the real one in X-Sample-Rate.
const DEFAULT_SPEECH_RATE = 24000;

// ---- Public API for TUI plugin ----

// `service` (optional, lib/service.js) is started when spoken replies are
// turned on and stopped when they are turned off, to free the GPU.
export function registerTTS(api, kv, complete, prompts, logger, opts, service = null) {
  const speechApi = opts?.ttsEndpoint
    ? {
        endpoint: opts.ttsEndpoint,
        model: opts.ttsModel || "chatterbox-multilingual",
        voice: opts.ttsVoice || null,
      }
    : null;
  const client = api.client;
  const systemAuto = prompts?.ttsAuto || SYSTEM_AUTO;
  const systemManual = prompts?.ttsManual || SYSTEM_MANUAL;

  function toast(message, variant = "info") {
    api.ui.toast({ message, variant, duration: 3000 });
  }

  function getVoiceModel() {
    const voice = kv.get("tts.voice", DEFAULT_TTS_VOICE);
    const entry = TTS_VOICES[voice] || TTS_VOICES[DEFAULT_TTS_VOICE];
    return path.join(VOICES_DIR, entry.file);
  }

  function piperOnPath() {
    const pathDirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
    const binary = isWindows ? "piper.exe" : "piper";
    return pathDirs.some((dir) => fs.existsSync(path.join(dir, binary)));
  }

  async function normalizeForSpeech(text, systemPrompt) {
    logger?.log?.("TTS", `Normalizing speech chars=${text.length}`, "debug");
    return complete({
      system: systemPrompt,
      prompt: `Convert for text-to-speech:\n\n${text}`,
      config: { maxTokens: 4096 },
    });
  }

  // ---- Audio pipeline ----

  let piperProc = null;
  let playProc = null;
  let speechRequest = null;
  // Bumped per speak() call: a killed, older playback must not reset the
  // status of the one that replaced it when its close event arrives.
  let generation = 0;
  const settle = (gen) => {
    if (gen === generation) voiceStatus.set("idle");
  };

  function killProcs() {
    if (speechRequest) {
      speechRequest.abort();
      speechRequest = null;
    }
    if (piperProc) {
      try {
        piperProc.kill("SIGKILL");
      } catch {}
      piperProc = null;
    }
    if (playProc) {
      try {
        playProc.kill("SIGKILL");
      } catch {}
      playProc = null;
    }
    const { phase } = voiceStatus.get();
    if (phase === "generating" || phase === "speaking") voiceStatus.set("idle");
  }

  function speak(text) {
    if (!text) return Promise.resolve();
    const line = text.replace(/\n/g, " ").trim();
    if (!line) return Promise.resolve();

    killProcs();
    const gen = ++generation;
    if (speechApi) return speakViaApi(line, gen);

    const voiceModel = getVoiceModel();
    logger?.log?.("TTS", `Speak requested chars=${line.length} voice=${voiceModel}`, "debug");
    if (!piperOnPath()) {
      logger?.log?.("TTS", `Piper binary not found on PATH`, "warn");
      toast(`Piper binary not found on PATH`, "warning");
      return Promise.resolve();
    }
    if (!fs.existsSync(voiceModel)) {
      logger?.log?.("TTS", `Voice model not found: ${voiceModel}`, "warn");
      toast(`Voice model not found: ${voiceModel}`, "warning");
      return Promise.resolve();
    }

    voiceStatus.set("speaking");
    return new Promise((resolve) => {
      let piperStderr = "";
      let playStderr = "";
      playProc = spawn(
        "play",
        [
          "-t",
          "raw",
          "-r",
          String(PIPER_RATE),
          "-e",
          "signed",
          "-b",
          String(PIPER_BITS),
          "-c",
          String(PIPER_CHANNELS),
          "-q",
          "-",
        ],
        { stdio: ["pipe", "ignore", "pipe"] },
      );

      piperProc = spawn("piper", ["-m", voiceModel, "--output_raw"], {
        stdio: ["pipe", "pipe", "pipe"],
      });

      piperProc.stderr.on("data", (chunk) => {
        piperStderr += chunk.toString();
      });
      playProc.stderr.on("data", (chunk) => {
        playStderr += chunk.toString();
      });

      piperProc.stdout.on("data", (chunk) => {
        if (playProc?.stdin && !playProc.stdin.destroyed) {
          playProc.stdin.write(chunk);
        }
      });

      piperProc.on("close", (code) => {
        if (code !== 0 && code !== null) {
          logger?.log?.("TTS", `piper exited code=${code} stderr=${piperStderr.trim()}`, "error");
        }
        if (playProc?.stdin && !playProc.stdin.destroyed) {
          playProc.stdin.end();
        }
      });

      playProc.on("close", (code) => {
        if (code !== 0 && code !== null) {
          logger?.log?.("TTS", `play exited code=${code} stderr=${playStderr.trim()}`, "error");
        } else {
          logger?.log?.("TTS", "playback finished", "debug");
        }
        piperProc = null;
        playProc = null;
        settle(gen);
        resolve();
      });

      piperProc.on("error", (err) => {
        logger?.log?.("TTS", `piper error: ${err.message}`, "error");
        killProcs();
        resolve();
      });
      playProc.on("error", (err) => {
        logger?.log?.("TTS", `play error: ${err.message}`, "error");
        killProcs();
        resolve();
      });

      if (piperProc?.stdin && !piperProc.stdin.destroyed) {
        piperProc.stdin.write(line + "\n");
        piperProc.stdin.end();
      }
    });
  }

  async function speakViaApi(line, gen) {
    const { url, body } = buildSpeechRequest(speechApi.endpoint, {
      ...speechApi,
      input: line,
      language: kv.get("tts.language", "auto"),
    });
    logger?.log?.("TTS", `Speech API request chars=${line.length} url=${url}`, "debug");
    const controller = new AbortController();
    speechRequest = controller;
    const started = Date.now();
    voiceStatus.set("generating");

    let player = null;
    let playStderr = "";
    // Resolves when the player exits (end of audio, or killed by stop).
    let playerClosed = Promise.resolve();
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(300000)]),
      });
      if (!resp.ok) {
        const detail = await resp.text();
        logger?.log?.("TTS", `Speech API error ${resp.status}: ${detail}`, "error");
        toast(`Speech API error ${resp.status}`, "error");
        settle(gen);
        return;
      }
      const rate = Number(resp.headers.get("x-sample-rate")) || DEFAULT_SPEECH_RATE;
      logger?.log?.(
        "TTS",
        `Speech API streaming language=${resp.headers.get("x-language")}`,
        "debug",
      );

      for await (const chunk of resp.body) {
        if (!player) {
          // Start the player on the first sentence, not before: the status
          // switches to speaking exactly when sound starts.
          player = spawnRawPlayer(rate);
          playProc = player;
          playerClosed = new Promise((resolve) => {
            player.on("error", (err) => {
              logger?.log?.("TTS", `player error: ${err.message}`, "error");
              toast(`Audio player failed: ${err.message}`, "error");
              resolve();
            });
            player.on("close", (code) => {
              if (code !== 0 && code !== null) {
                logger?.log?.(
                  "TTS",
                  `player exited code=${code} stderr=${playStderr.trim()}`,
                  "error",
                );
              }
              resolve();
            });
          });
          player.stderr?.on("data", (data) => {
            playStderr += data.toString();
          });
          voiceStatus.set("speaking", { firstAudioSeconds: (Date.now() - started) / 1000 });
        }
        if (player.stdin.destroyed) break;
        if (!player.stdin.write(chunk)) {
          await new Promise((resolve) => player.stdin.once("drain", resolve));
        }
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      logger?.log?.("TTS", `Speech API request failed: ${err.message}`, "error");
      toast(`Speech API failed: ${err.message}`, "error");
    } finally {
      if (speechRequest === controller) speechRequest = null;
    }

    // Let the player finish what it has, then report idle.
    if (player && !player.stdin.destroyed) player.stdin.end();
    await playerClosed;
    if (playProc === player) playProc = null;
    settle(gen);
  }

  // ---- Session-prefixed announcements ----

  async function speakWithSessionPrefix(sessionID, message, suffix) {
    const sessionTitle = await getSessionTitle(client, sessionID);
    const parts = [];
    if (sessionTitle) parts.push(`Session: ${sessionTitle}.`);
    parts.push(message);
    if (suffix) parts.push(suffix);
    await speak(parts.join(" "));
  }

  function stopSpeech() {
    const wasPlaying = piperProc !== null || playProc !== null || speechRequest !== null;
    killProcs();
    return wasPlaying;
  }

  // ---- Auto mode ----

  // V2 never emits the V1 `session.status`/`session.idle` pair; the live
  // signals are `session.execution.started` and
  // `session.execution.succeeded`/`interrupted`/`failed`. Busy state is
  // tracked per session, and only the session this TUI is currently showing
  // is ever spoken: on the shared server every instance receives every
  // event, and without the gate each TUI would speak every completion,
  // permission, and question.
  let lastSpokenMessageID = null;
  const busySessions = new Set();

  function showingSession(sessionID) {
    const route = api.route.current;
    // Not looking at a session: keep V1's fall-through so single-window
    // setups still hear attention events from anywhere.
    if (route.name !== "session") return true;
    return route.params.sessionID === sessionID;
  }

  // Permission prompts and forms from subagent sessions are displayed under
  // their parent in the session view, so they must announce while the parent
  // (or any ancestor) is shown, not only when the subagent itself is open.
  function showingSessionFamily(sessionID) {
    const route = api.route.current;
    if (route.name !== "session") return true;
    if (!sessionID) return false;
    if (route.params.sessionID === sessionID) return true;
    const root = api.state.session.root;
    if (!root) return false;
    return root(sessionID) === root(route.params.sessionID);
  }

  async function speakTurnCompletion(sessionID) {
    if (kv.get("tts.mode", "off") !== "on") return;
    if (!busySessions.delete(sessionID)) return;
    if (!showingSession(sessionID)) return;

    const result = await getTurnAssistantText(api);
    if (!result || !result.text) return;

    if (result.lastMessageID === lastSpokenMessageID) return;
    lastSpokenMessageID = result.lastMessageID;

    toast("Normalizing response...");
    const llmResult = await normalizeForSpeech(result.text, systemAuto);
    if (!llmResult.text) {
      logger?.log?.("TTS", `Auto normalization failed: ${llmResult.error}`, "warn");
      toast(`TTS normalization failed: ${llmResult.error}`, "warning");
      return;
    }

    logger?.log?.("TTS", `Auto normalization succeeded chars=${llmResult.text.length}`, "debug");
    await speakWithSessionPrefix(sessionID, llmResult.text, "Ready for your input.");
  }

  api.event.on("session.execution.started", (event) => {
    const sessionID = event.properties?.sessionID;
    if (sessionID) busySessions.add(sessionID);
  });

  api.event.on("session.execution.succeeded", (event) => {
    void speakTurnCompletion(event.properties?.sessionID);
  });

  api.event.on("session.execution.interrupted", (event) => {
    void speakTurnCompletion(event.properties?.sessionID);
  });

  api.event.on("session.execution.failed", (event) => {
    // A failed execution ends the busy cycle without an announcement.
    busySessions.delete(event.properties?.sessionID);
  });

  api.event.on("permission.asked", async (event) => {
    if (kv.get("tts.mode", "off") !== "on") return;
    if (!showingSessionFamily(event.properties?.sessionID)) return;
    await speakWithSessionPrefix(
      event.properties?.sessionID,
      "Permission requested. Please check your screen.",
    );
  });

  api.event.on("question.asked", async (event) => {
    if (kv.get("tts.mode", "off") !== "on") return;
    if (!showingSessionFamily(event.properties?.sessionID)) return;
    await speakWithSessionPrefix(
      event.properties?.sessionID,
      "A question needs your answer. Please check your screen.",
    );
  });

  // ---- Manual mode ----

  async function speakLastResponse() {
    const result = await getTurnAssistantText(api);
    if (!result || !result.text) {
      toast("No assistant response to speak", "warning");
      return;
    }

    toast("Normalizing response...");
    const llmResult = await normalizeForSpeech(result.text, systemManual);
    if (!llmResult.text) {
      logger?.log?.("TTS", `Manual normalization failed: ${llmResult.error}`, "warn");
      toast(`TTS normalization failed: ${llmResult.error}`, "warning");
      return;
    }

    logger?.log?.("TTS", `Manual normalization succeeded chars=${llmResult.text.length}`, "debug");
    toast("Speaking last response");
    await speak(llmResult.text);
  }

  // ---- Commands ----

  return [
    {
      title: "TTS: speak last response",
      value: "tts.speak-last",
      description: "Read the last assistant response aloud (detailed)",
      keybind: "<leader>s",
      slash: { name: "tts-speak" },
      onSelect() {
        speakLastResponse();
      },
    },
    {
      title: "TTS: toggle",
      value: "tts.mode",
      description: "Toggle auto text-to-speech on/off",
      keybind: "<leader>v",
      slash: { name: "tts-mode" },
      onSelect() {
        const current = kv.get("tts.mode", "off");
        const next = current === "on" ? "off" : "on";
        kv.set("tts.mode", next);
        if (next === "off") stopSpeech();
        if (service) {
          if (next === "on") {
            void service.start().then((ok) => {
              if (!ok && kv.get("tts.mode", "off") === "on") {
                toast("Voice service did not start, see voice-service.log", "error");
              }
            });
          } else {
            void service.stop();
          }
        }
        const label = speechApi
          ? `API: ${speechApi.voice || "default voice"}`
          : (TTS_VOICES[kv.get("tts.voice", DEFAULT_TTS_VOICE)] || TTS_VOICES[DEFAULT_TTS_VOICE])
              .label;
        toast(next === "on" ? `TTS on (${label})` : "TTS off");
      },
    },
    {
      title: "TTS: stop playback",
      value: "tts.stop",
      description: "Stop current TTS playback",
      keybind: "escape",
      slash: { name: "tts-stop" },
      onSelect() {
        // Returning false when nothing is playing lets Escape fall through to
        // the next handler (session interrupt) instead of being swallowed by
        // a global layer that owns the key at all times.
        if (!stopSpeech()) return false;
        toast("TTS stopped");
      },
    },
    {
      title: "TTS: select language",
      value: "tts.language",
      description: "Speak replies in a fixed language, or detect it (speech API only)",
      slash: { name: "tts-language" },
      onSelect() {
        const labels = { auto: "Auto-detect", nl: "Dutch", en: "English" };
        api.ui.dialog.replace(() =>
          api.ui.DialogSelect({
            title: "Select speech language",
            current: ttsLanguage(kv.get("tts.language", "auto")),
            options: TTS_LANGUAGES.map((key) => ({
              title: labels[key],
              value: key,
              onSelect() {
                kv.set("tts.language", key);
                toast(`Speech language: ${labels[key]}`);
                api.ui.dialog.clear();
              },
            })),
          }),
        );
      },
    },
    {
      title: "TTS: select voice",
      value: "tts.voice",
      description: "Choose TTS voice",
      slash: { name: "tts-voice" },
      onSelect() {
        if (speechApi) {
          toast("Speech API in use: set the voice with the ttsVoice option in cli.json");
          return;
        }
        const current = kv.get("tts.voice", DEFAULT_TTS_VOICE);
        api.ui.dialog.replace(() =>
          api.ui.DialogSelect({
            title: "Select voice",
            current,
            options: Object.entries(TTS_VOICES).map(([key, v]) => ({
              title: v.label,
              value: key,
              onSelect() {
                kv.set("tts.voice", key);
                toast(`Voice: ${v.label}`);
                api.ui.dialog.clear();
              },
            })),
          }),
        );
      },
    },
  ];
}
