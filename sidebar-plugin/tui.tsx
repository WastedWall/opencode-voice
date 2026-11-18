// Folder plugin that only draws the Voice sidebar section, so its position can
// be chosen with the folder name: plugins in ~/.config/opencode/plugins load
// in name order, before plugins from cli.json, and sidebar sections appear in
// load order. Link this folder there (for example as "a-0-voice", which sorts
// before "a-ai-server") and set "sidebar": false on the voice plugin itself.
//
// It imports nothing from this repository: through the link, "../lib" would
// point into the plugins folder. The voice plugin publishes { register } on a
// global bridge instead (sidebarBridge in lib/status.js; keep this copy alike).

import { Plugin } from "@opencode/plugin/tui";

const KEY = Symbol.for("opencode-voice.sidebar");

function bridge() {
  if (!globalThis[KEY]) {
    let value = null;
    const listeners = new Set();
    globalThis[KEY] = {
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
  return globalThis[KEY];
}

export default Plugin.define({
  id: "opencode-voice.sidebar",
  setup(context) {
    let dispose = null;
    // This plugin loads before the voice plugin, so the register function
    // usually arrives after setup; a reload of the voice plugin replaces it.
    const attach = (published) => {
      dispose?.();
      dispose = published ? published.register(context) : null;
    };
    const shared = bridge();
    attach(shared.get());
    const unsubscribe = shared.subscribe(attach);
    return () => {
      unsubscribe();
      dispose?.();
    };
  },
});
