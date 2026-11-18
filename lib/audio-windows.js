// Native Windows audio: ffmpeg (DirectShow) records, ffplay plays. sox on
// Windows cannot be stopped cleanly (there is no SIGINT, so the WAV header is
// never finalized); ffmpeg stops cleanly when it reads "q" on stdin.

import { spawn, spawnSync } from "node:child_process";

export const isWindows = process.platform === "win32";

// Parse `ffmpeg -list_devices true -f dshow -i dummy` stderr. Audio devices
// look like: [dshow @ 000001] "Microphone (USB Audio)" (audio)
export function parseDshowDevices(stderr) {
  const devices = [];
  for (const line of String(stderr || "").split(/\r?\n/)) {
    const match = line.match(/"([^"]+)"\s+\(audio\)\s*$/);
    if (match) devices.push({ name: match[1], label: match[1] });
  }
  return devices;
}

export function listDshowDevices() {
  const result = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"],
    {
      encoding: "utf-8",
      timeout: 5000,
      windowsHide: true,
    },
  );
  return parseDshowDevices(result.stderr);
}

export function buildFfmpegRecordArgs(mic, wavFile, trimSilence = true) {
  const filter = trimSilence ? ["-af", "silenceremove=start_periods=1:start_threshold=-50dB"] : [];
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "dshow",
    "-i",
    `audio=${mic}`,
    ...filter,
    "-ac",
    "1",
    "-ar",
    "16000",
    "-sample_fmt",
    "s16",
    "-y",
    wavFile,
  ];
}

export function spawnFfmpegRecorder(mic, wavFile, trimSilence) {
  return spawn("ffmpeg", buildFfmpegRecordArgs(mic, wavFile, trimSilence), {
    stdio: ["pipe", "ignore", "pipe"],
    windowsHide: true,
  });
}

// Ask ffmpeg to finish the file and exit.
export function stopFfmpegRecorder(proc) {
  if (proc?.stdin && !proc.stdin.destroyed) {
    proc.stdin.write("q");
    proc.stdin.end();
  }
}

// Play a complete WAV file from memory. Returns the child process; it emits
// "close" when playback ends or is killed.
export function spawnWavPlayer(wavBuffer) {
  const proc = spawn("ffplay", ["-nodisp", "-autoexit", "-loglevel", "error", "-i", "-"], {
    stdio: ["pipe", "ignore", "pipe"],
    windowsHide: true,
  });
  proc.stdin.on("error", () => {});
  proc.stdin.end(wavBuffer);
  return proc;
}
