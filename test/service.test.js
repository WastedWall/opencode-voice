import assert from "node:assert/strict";
import test from "node:test";

import {
  IDLE_SHUTDOWN_SECONDS,
  createServiceControl,
  parseServiceCommand,
  serviceUrls,
} from "../lib/service.js";

test("service URLs sit next to /v1", () => {
  assert.deepEqual(serviceUrls("http://127.0.0.1:8787/v1"), {
    health: "http://127.0.0.1:8787/health",
    keepalive: "http://127.0.0.1:8787/keepalive",
    shutdown: "http://127.0.0.1:8787/admin/shutdown",
  });
  assert.equal(serviceUrls("nope"), null);
});

test("service command must be a non-empty array of strings", () => {
  assert.deepEqual(parseServiceCommand(["powershell", "-File", "start.ps1"]), {
    command: "powershell",
    args: ["-File", "start.ps1"],
  });
  assert.equal(parseServiceCommand("powershell start.ps1"), null);
  assert.equal(parseServiceCommand([]), null);
  assert.equal(parseServiceCommand(["ok", ""]), null);
});

// A fake world: a clock, a service that comes up `bootMs` after launch, and
// fetch/spawn that act on it.
function fakeWorld({ upAtStart = false, bootMs = 6000, exitDelayMs = 0 } = {}) {
  const world = {
    clock: 0,
    up: upAtStart,
    bootAt: null,
    launches: 0,
    shutdowns: 0,
    states: [],
    // The process outlives its port by `exitDelayMs` after a shutdown.
    exitAt: null,
  };
  const tick = () => {
    if (world.bootAt !== null && world.clock >= world.bootAt) {
      world.up = true;
      world.bootAt = null;
    }
  };
  const control = createServiceControl({
    command: ["start-service"],
    endpoint: "http://127.0.0.1:8787/v1",
    onState: (state) => world.states.push(state),
    now: () => world.clock,
    processAlive: (pid) => pid === 4242 && world.exitAt !== null && world.clock < world.exitAt,
    sleep: async (ms) => {
      world.clock += ms;
      tick();
    },
    spawnImpl: () => {
      world.launches += 1;
      world.bootAt = world.clock + bootMs;
      return { on() {}, unref() {} };
    },
    fetchImpl: async (url) => {
      tick();
      if (url.endsWith("/admin/shutdown") && world.up) {
        world.shutdowns += 1;
        world.up = false;
        world.exitAt = world.clock + exitDelayMs;
        return { ok: true };
      }
      if (!world.up) throw new Error("connection refused");
      return { ok: true, json: async () => ({ status: "ok", pid: 4242 }) };
    },
  });
  return { world, control };
}

test("start launches once and reports running when healthy", async () => {
  const { world, control } = fakeWorld();
  assert.equal(await control.start(), true);
  assert.equal(world.launches, 1);
  assert.deepEqual(world.states, ["starting", "running"]);
});

test("start does not launch when the service already runs", async () => {
  const { world, control } = fakeWorld({ upAtStart: true });
  assert.equal(await control.start(), true);
  assert.equal(world.launches, 0);
  assert.deepEqual(world.states, ["running"]);
});

test("stop shuts the service down and waits until it is gone", async () => {
  const { world, control } = fakeWorld({ upAtStart: true });
  await control.stop();
  assert.equal(world.shutdowns, 1);
  assert.equal(world.up, false);
  assert.deepEqual(world.states, ["stopping", "stopped"]);
});

test("stop during startup waits for the boot, then shuts it down", async () => {
  const { world, control } = fakeWorld({ bootMs: 10000 });
  const starting = control.start();
  const stopping = control.stop();
  assert.equal(await starting, false);
  await stopping;
  assert.equal(world.launches, 1);
  assert.equal(world.shutdowns, 1);
  assert.equal(world.up, false);
  assert.equal(world.states.at(-1), "stopped");
});

test("on, off, on during startup does not launch twice", async () => {
  const { world, control } = fakeWorld({ bootMs: 10000 });
  const first = control.start();
  const stopping = control.stop();
  const second = control.start();
  await Promise.all([first, stopping]);
  assert.equal(await second, true);
  assert.equal(world.launches, 1);
  assert.equal(world.up, true);
  assert.equal(world.states.at(-1), "running");
});

test("no command or bad endpoint means no control", () => {
  assert.equal(createServiceControl({ command: undefined, endpoint: "http://h/v1" }), null);
  assert.equal(createServiceControl({ command: ["x"], endpoint: "bad" }), null);
});

test("stop waits for the process to exit after its port closes", async () => {
  const { world, control } = fakeWorld({ upAtStart: true, exitDelayMs: 3000 });
  await control.stop();
  assert.ok(world.clock >= 3000, `stopped at ${world.clock} ms, process exits at 3000 ms`);
  assert.equal(world.states.at(-1), "stopped");
});

test("the launched service gets the idle shutdown setting", async () => {
  let env = null;
  const control = createServiceControl({
    command: ["start-service"],
    endpoint: "http://127.0.0.1:8787/v1",
    now: (() => {
      let t = 0;
      return () => (t += 1000);
    })(),
    sleep: async () => {},
    spawnImpl: (command, args, options) => {
      env = options.env;
      return { on() {}, unref() {} };
    },
    fetchImpl: async () => {
      throw new Error("down");
    },
  });
  await control.start();
  control.dispose();
  assert.equal(env.VOICE_IDLE_SHUTDOWN, String(IDLE_SHUTDOWN_SECONDS));
  assert.ok(env.PATH || env.Path, "keeps the rest of the environment");
});
