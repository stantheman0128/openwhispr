const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { EventEmitter } = require("node:events");
const childProcess = require("node:child_process");

const fakeClipboard = {
  text: "",
  html: "",
  rtf: "",
  image: null,
  formats: ["text/plain"],
  availableFormats() {
    return this.formats;
  },
  readText() {
    return this.text;
  },
  writeText(text) {
    this.text = text;
  },
  readHTML() {
    return this.html;
  },
  readRTF() {
    return this.rtf;
  },
  write() {},
  readImage() {
    return { isEmpty: () => true };
  },
  writeImage() {},
};

const clipboardModulePath = require.resolve("../../src/helpers/clipboard");
const originalLoad = Module._load;

function loadClipboardManager({ spawn } = {}) {
  delete require.cache[clipboardModulePath];

  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "electron") {
      return {
        clipboard: fakeClipboard,
        systemPreferences: {
          isTrustedAccessibilityClient: () => true,
        },
      };
    }
    if (request === "child_process" && spawn) {
      return { ...childProcess, spawn };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return require("../../src/helpers/clipboard");
  } finally {
    Module._load = originalLoad;
  }
}

function withGnomeWaylandEnv(fn) {
  const prev = {
    XDG_SESSION_TYPE: process.env.XDG_SESSION_TYPE,
    WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY,
    XDG_CURRENT_DESKTOP: process.env.XDG_CURRENT_DESKTOP,
    XDG_SESSION_DESKTOP: process.env.XDG_SESSION_DESKTOP,
    DESKTOP_SESSION: process.env.DESKTOP_SESSION,
    DISPLAY: process.env.DISPLAY,
  };

  process.env.XDG_SESSION_TYPE = "wayland";
  process.env.WAYLAND_DISPLAY = "wayland-0";
  process.env.XDG_CURRENT_DESKTOP = "GNOME";
  delete process.env.XDG_SESSION_DESKTOP;
  delete process.env.DESKTOP_SESSION;
  delete process.env.DISPLAY;

  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of Object.entries(prev)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

function createSpawnTracker(handler) {
  const spawnCalls = [];
  const spawn = (command, args = []) => {
    spawnCalls.push({ command, args: [...args] });
    const proc = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdout = new EventEmitter();
    process.nextTick(() => handler(proc, command, args));
    return proc;
  };
  return { spawnCalls, spawn };
}

test("GNOME Wayland tries portal before uinput (#956)", async () => {
  await withGnomeWaylandEnv(async () => {
    const { spawnCalls, spawn } = createSpawnTracker((proc, _command, args) => {
      if (args.includes("--portal")) {
        proc.stdout.emit("data", Buffer.from("portal-token-1\n"));
      }
      proc.emit("close", 0);
    });

    const TestClipboardManager = loadClipboardManager({ spawn });
    const manager = new TestClipboardManager();
    manager.resolveLinuxFastPasteBinary = () => "/tmp/linux-fast-paste";
    manager.commandExists = () => false;
    manager._isYdotoolDaemonRunning = () => false;
    manager._readPortalToken = () => null;
    manager._savePortalToken = () => {};
    manager._restoreClipboardAfterDelay = () => Promise.resolve();

    const result = await manager.pasteLinux(
      { type: "text", data: "previous" },
      { expectedClipboardText: "dictated" }
    );

    assert.equal(result.method, "portal");
    assert.equal(spawnCalls.length, 1);
    assert.equal(spawnCalls[0].command, "/tmp/linux-fast-paste");
    assert.ok(spawnCalls[0].args.includes("--portal"));
    assert.ok(!spawnCalls.some((call) => call.args.includes("--uinput")));
  });
});

test("GNOME Wayland skips ephemeral uinput when ydotoold is running (#956)", async () => {
  await withGnomeWaylandEnv(async () => {
    const { spawnCalls, spawn } = createSpawnTracker((proc, command, args) => {
      if (args.includes("--portal")) {
        proc.emit("close", 3); // user denied portal
        return;
      }
      if (command === "ydotool") {
        proc.emit("close", 0);
        return;
      }
      proc.emit("close", 1);
    });

    const TestClipboardManager = loadClipboardManager({ spawn });
    const manager = new TestClipboardManager();
    manager.resolveLinuxFastPasteBinary = () => "/tmp/linux-fast-paste";
    manager.commandExists = (cmd) => cmd === "ydotool";
    manager._isYdotoolDaemonRunning = () => true;
    manager._isYdotoolLegacy = () => false;
    manager._readPortalToken = () => null;
    manager._savePortalToken = () => {};
    manager._restoreClipboardAfterDelay = () => Promise.resolve();

    const result = await manager.pasteLinux(
      { type: "text", data: "previous" },
      { expectedClipboardText: "dictated" }
    );

    assert.equal(result.method, "ydotool");
    assert.ok(spawnCalls.some((call) => call.args.includes("--portal")));
    assert.ok(!spawnCalls.some((call) => call.args.includes("--uinput")));
    assert.ok(spawnCalls.some((call) => call.command === "ydotool"));
  });
});
