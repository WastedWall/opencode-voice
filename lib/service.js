// Start and stop the local voice service, so its GPU memory is only taken
// while spoken replies are on. Configured with the `serviceCommand` option
// (the command that starts the service, as an array); without it the plugin
// never starts or stops anything.
//
// Stopping posts /admin/shutdown: the service can outlive the TUI that
// started it, and killing the launcher would not reach the Python process
// behind it on Windows.

import fs from "node:fs";
import path from "node:path";
import { spawn as nodeSpawn } from "node:child_process";

const READY_TIMEOUT_MS = 180000;
// While the plugin wants the service it posts /keepalive this often. The service
// it starts exits after IDLE_SHUTDOWN_SECONDS without a request, so it also
// goes away when OpenCode closes or crashes and the pings stop.
const HEARTBEAT_MS = 15000;
export const IDLE_SHUTDOWN_SECONDS = 60;
const POLL_MS = 2000;
const REQUEST_TIMEOUT_MS = 1500;

// Service URLs next to the API base: http://host:8787/v1 -> http://host:8787/health.
export function serviceUrls(endpoint) {
  try {
    return {
      health: new URL("/health", endpoint).toString(),
      keepalive: new URL("/keepalive", endpoint).toString(),
      shutdown: new URL("/admin/shutdown", endpoint).toString(),
    };
  } catch {
    return null;
  }
}

export function parseServiceCommand(value) {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (!value.every((part) => typeof part === "string" && part.length > 0)) return null;
  return { command: value[0], args: value.slice(1) };
}

export function createServiceControl({
  command,
  endpoint,
  logFile,
  onState = () => {},
  // Called when a running service disappears on its own (idle shutdown after
  // the PC slept, a crash), so the caller can turn spoken replies off.
  onLost = () => {},
  logger,
  fetchImpl = fetch,
  spawnImpl = nodeSpawn,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
  processAlive = defaultProcessAlive,
}) {
  const urls = serviceUrls(endpoint);
  const parsed = parseServiceCommand(command);
  if (!urls || !parsed) return null;

  // Bumped by every start/stop, so a slow start that was overtaken by a stop
  // does not report "running" afterwards.
  let generation = 0;
  // Set while a launched service is still loading its models: it is not up
  // yet, but a stop must still wait for it and shut it down.
  let bootDeadline = 0;
  let heartbeat = null;

  function stopHeartbeat() {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
  }

  function startHeartbeat(gen) {
    stopHeartbeat();
    heartbeat = setInterval(async () => {
      if (gen !== generation) return stopHeartbeat();
      if (await keepalive()) return;
      if (gen !== generation) return;
      stopHeartbeat();
      logger?.log?.("service", "Service stopped responding", "warn");
      onState("stopped");
      onLost();
    }, HEARTBEAT_MS);
    heartbeat.unref?.();
  }

  async function isUp() {
    try {
      const response = await fetchImpl(urls.health, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  function launch() {
    let stdio = "ignore";
    if (logFile) {
      try {
        fs.mkdirSync(path.dirname(logFile), { recursive: true });
        const fd = fs.openSync(logFile, "a");
        stdio = ["ignore", fd, fd];
      } catch (err) {
        logger?.log?.("service", `Cannot open log ${logFile}: ${err.message}`, "warn");
      }
    }
    const child = spawnImpl(parsed.command, parsed.args, {
      env: { ...process.env, VOICE_IDLE_SHUTDOWN: String(IDLE_SHUTDOWN_SECONDS) },
      // On Windows a detached child loses the log file handles and the
      // launch dies silently; a plain child already outlives its parent there.
      detached: process.platform !== "win32",
      stdio,
      windowsHide: true,
    });
    child.on?.("error", (err) => logger?.log?.("service", `Start failed: ${err.message}`, "error"));
    child.unref?.();
  }

  async function start() {
    const gen = ++generation;
    if (await isUp()) {
      onState("running");
      startHeartbeat(gen);
      return true;
    }
    onState("starting");
    // Toggled off and on again while the first launch is still loading:
    // wait for that one instead of loading the models a second time.
    if (now() >= bootDeadline) {
      logger?.log?.("service", `Starting: ${parsed.command} ${parsed.args.join(" ")}`, "debug");
      launch();
      bootDeadline = now() + READY_TIMEOUT_MS;
    }
    while (now() < bootDeadline) {
      await sleep(POLL_MS);
      if (gen !== generation) return false;
      if (await isUp()) {
        bootDeadline = 0;
        onState("running");
        startHeartbeat(gen);
        return true;
      }
    }
    bootDeadline = 0;
    logger?.log?.("service", "Service did not become ready in time", "error");
    onState("stopped");
    return false;
  }

  async function stop() {
    const gen = ++generation;
    stopHeartbeat();
    onState("stopping");
    // A service we just launched cannot be shut down before it listens.
    while (!(await isUp())) {
      if (now() >= bootDeadline) {
        if (gen === generation) onState("stopped");
        return;
      }
      await sleep(POLL_MS);
      if (gen !== generation) return;
    }
    bootDeadline = 0;
    const pid = await servicePid();
    try {
      await fetchImpl(urls.shutdown, {
        method: "POST",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      logger?.log?.("service", `Shutdown request failed: ${err.message}`, "warn");
    }
    // Wait until the process is really gone, so the GPU is free when this
    // says stopped: the port closes a moment before CUDA lets go.
    const deadline = now() + 30000;
    while (now() < deadline && ((await isUp()) || (pid && processAlive(pid)))) await sleep(500);
    if (gen === generation) onState("stopped");
  }

  // /health does not count as activity (the sidebar polls it); this does.
  async function keepalive() {
    try {
      const response = await fetchImpl(urls.keepalive, {
        method: "POST",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async function servicePid() {
    try {
      const response = await fetchImpl(urls.health, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const body = await response.json();
      return Number.isInteger(body?.pid) ? body.pid : null;
    } catch {
      return null;
    }
  }

  // Plugin unload: stop pinging. The service then exits on its own after
  // IDLE_SHUTDOWN_SECONDS unless another OpenCode window keeps it alive.
  function dispose() {
    ++generation;
    stopHeartbeat();
  }

  return { start, stop, isUp, dispose };
}

// Signal 0 checks that a process exists without touching it.
function defaultProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}
