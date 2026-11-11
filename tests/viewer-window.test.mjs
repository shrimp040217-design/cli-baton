/**
 * macOS viewer-window tests: the open/close bridge is driven with an injected
 * execFile so we can assert call timing, viewer.json contents, quoting and
 * failure isolation without ever touching a real Terminal window.
 *
 * The last three tests go through the real detached runner with a fake
 * `osascript` binary (CLI_BATON_OSASCRIPT_BIN) on macOS only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import {
  buildCloseScript,
  buildOpenScript,
  buildViewerCommand,
  buildWindowTitle,
  createViewerBridge,
  shouldOpenViewer,
  shellQuote,
  viewerDisabled,
} from "../src/viewer-window.mjs";
import {
  FAKE_OSASCRIPT,
  McpClient,
  VIEWER_PATH,
  fakeEnv,
  isProcessAlive,
  makeCwd,
  makeHome,
  makeRunDir,
  makeTmpDir,
  readRunDir,
  sleep,
  toolPayload,
  waitFor,
  waitForTerminal,
} from "./helpers.mjs";

/** Fake osascript: records every call and answers like the real scripts do. */
function makeOsascriptFake({ windowId = "4242", closeResult = "closed", failOpen = false, failClose = false } = {}) {
  const calls = [];
  const impl = (file, args, options, callback) => {
    const index = args.indexOf("-e");
    const script = index >= 0 ? String(args[index + 1] || "") : "";
    const kind = /beforeIDs/.test(script) ? "open" : "close";
    calls.push({ file, args, options, script, kind });
    if ((kind === "open" && failOpen) || (kind === "close" && failClose)) {
      const error = new Error("osascript: simulated failure");
      error.stderr = "not scriptable";
      callback(error, "", "not scriptable");
      return;
    }
    callback(null, (kind === "open" ? windowId : closeResult) + "\n", "");
  };
  return { impl, calls };
}

test("shouldOpenViewer: macOS only, CLI_BATON_VIEWER=0 disables it", () => {
  assert.equal(shouldOpenViewer({ env: {}, platform: "darwin" }), true);
  assert.equal(shouldOpenViewer({ env: { CLI_BATON_VIEWER: "1" }, platform: "darwin" }), true);
  for (const off of ["0", "false", "off", "no", " 0 "]) {
    assert.equal(shouldOpenViewer({ env: { CLI_BATON_VIEWER: off }, platform: "darwin" }), false, off);
    assert.equal(viewerDisabled({ CLI_BATON_VIEWER: off }), true, off);
  }
  assert.equal(viewerDisabled({}), false);
  for (const platform of ["linux", "win32", "freebsd"]) {
    assert.equal(shouldOpenViewer({ env: {}, platform }), false, platform);
  }
});

test("buildViewerCommand quotes the node path, the viewer script and the run dir", () => {
  const command = buildViewerCommand({
    runDir: "/Users/me/My Runs/agy/runs/" + "a".repeat(24),
    nodePath: "/Applications/Node JS/bin/node",
    viewerScript: "/Users/me/cli baton/src/viewer.mjs",
  });
  assert.equal(
    command,
    "'/Applications/Node JS/bin/node' '/Users/me/cli baton/src/viewer.mjs' '/Users/me/My Runs/agy/runs/" + "a".repeat(24) + "'",
  );
  assert.equal(shellQuote("it's"), "'it'\\''s'");
  assert.equal(buildWindowTitle({ backend: "agy", runId: "0123456789abcdef01234567" }), "cli-baton · agy · 01234567");
});

test("AppleScript builders: new window without activate, close by window id", () => {
  const open = buildOpenScript({ command: "'/usr/bin/node' '/x/viewer.mjs' '/run dir'", title: "cli-baton · agy · 01234567" });
  assert.match(open, /tell application "Terminal"/);
  assert.match(open, /do script "'\/usr\/bin\/node' '\/x\/viewer\.mjs' '\/run dir'"/);
  assert.match(open, /set custom title of newTab to "cli-baton · agy · 01234567"/);
  assert.match(open, /return newID as text/);
  assert.ok(!/\bactivate\b/.test(open), "opening must not activate Terminal");
  // The id is diffed from a flat list of integers: iterating window references
  // breaks ("invalid index") as soon as do script mutates the window list,
  // which would lose the id and orphan the window.
  assert.match(open, /set beforeIDs to id of every window/);
  assert.match(open, /set afterIDs to id of every window/);
  assert.ok(!/repeat with w in windows/.test(open));
  // Guessing "window 1" could record one of the user's own windows and close it
  // when the run ends, so a failed diff must yield no id at all.
  assert.ok(!/id of window 1/.test(open), "no front-window fallback");

  const close = buildCloseScript({ windowId: "4242" });
  assert.match(close, /set targetID to "4242"/);
  assert.match(close, /set targetWindow to \(first window whose id is targetID\)/);
  // The tab is waited on first: only a tab that is still busy is told to exit,
  // so closing can never raise the "terminate running processes" sheet (and an
  // idle tab never gets the `exit` that leaves a ghost window behind).
  assert.match(close, /repeat 20 times[\s\S]*busy of tab 1 of targetWindow/);
  assert.match(close, /if tabBusy then[\s\S]*do script "exit" in \(tab 1 of targetWindow\)/);
  assert.ok(
    close.indexOf("do script \"exit\"") < close.indexOf("close targetWindow saving no"),
    "the shell must be told to exit before the window is closed",
  );
  assert.match(close, /close targetWindow saving no/);
  assert.match(close, /return "missing"/);
  assert.match(close, /return "still-open"/);
  // The window is re-resolved by id after the window list changes; a captured
  // "item N of every window" reference goes stale and leaves the window open.
  assert.ok(!/repeat with w in windows/.test(close));
});

test("bridge.open writes viewer.json with window_id and opened_at, without activating", async () => {
  const run = makeRunDir();
  const fake = makeOsascriptFake({ windowId: "9911" });
  try {
    const bridge = createViewerBridge({
      runDir: run.runDir,
      backend: "agy",
      runId: "0123456789abcdef01234567",
      env: { CLI_BATON_VIEWER: "1" },
      platform: "darwin",
      execFileImpl: fake.impl,
    });
    const result = await bridge.open();
    assert.equal(result.opened, true);
    assert.equal(result.window_id, "9911");
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].kind, "open");
    assert.equal(fake.calls[0].file, "osascript");
    assert.ok(fake.calls[0].script.includes(VIEWER_PATH), "the window must run src/viewer.mjs");
    assert.ok(fake.calls[0].script.includes(run.runDir), "the window must receive the quoted run dir");
    assert.ok(!/\bactivate\b/.test(fake.calls[0].script));

    const info = readRunDir(run.runDir).viewer;
    assert.equal(info.window_id, "9911");
    assert.ok(info.opened_at && !Number.isNaN(Date.parse(info.opened_at)));
    assert.equal(info.backend, "agy");
    assert.equal(info.run_id, "0123456789abcdef01234567");
  } finally {
    run.remove();
  }
});

test("bridge.open is skipped when the viewer is disabled or the platform is not macOS", async () => {
  const disabled = makeRunDir();
  const other = makeRunDir();
  const fakeDisabled = makeOsascriptFake();
  const fakeOther = makeOsascriptFake();
  try {
    const bridgeDisabled = createViewerBridge({
      runDir: disabled.runDir,
      backend: "agy",
      runId: "a".repeat(24),
      env: { CLI_BATON_VIEWER: "0" },
      platform: "darwin",
      execFileImpl: fakeDisabled.impl,
    });
    assert.deepEqual(await bridgeDisabled.open(), { opened: false, reason: "disabled" });
    assert.equal(fakeDisabled.calls.length, 0);
    assert.equal(readRunDir(disabled.runDir).viewer, null, "no viewer.json when disabled");

    const bridgeOther = createViewerBridge({
      runDir: other.runDir,
      backend: "agy",
      runId: "a".repeat(24),
      env: {},
      platform: "linux",
      execFileImpl: fakeOther.impl,
    });
    assert.equal((await bridgeOther.open()).opened, false);
    assert.equal(fakeOther.calls.length, 0);
    assert.equal(readRunDir(other.runDir).viewer, null);
  } finally {
    disabled.remove();
    other.remove();
  }
});

test("bridge.open failures are swallowed and logged to viewer.log", async () => {
  const run = makeRunDir();
  const fake = makeOsascriptFake({ failOpen: true });
  try {
    const bridge = createViewerBridge({
      runDir: run.runDir,
      backend: "agy",
      runId: "a".repeat(24),
      env: {},
      platform: "darwin",
      execFileImpl: fake.impl,
    });
    const result = await bridge.open();
    assert.equal(result.opened, false);
    assert.equal(result.reason, "osascript-failed");
    const runFiles = readRunDir(run.runDir);
    assert.match(String(runFiles.viewerLog), /failed to open viewer window/);
    assert.equal(runFiles.viewer.window_id, null);
    assert.ok(runFiles.viewer.open_error);
  } finally {
    run.remove();
  }
});

test("bridge.close stops the viewer pid first, then closes the window by id", async () => {
  const run = makeRunDir();
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  const fake = makeOsascriptFake({ closeResult: "closed" });
  try {
    run.writeViewer({
      window_id: "31337",
      opened_at: new Date().toISOString(),
      pid: child.pid,
    });
    const bridge = createViewerBridge({
      runDir: run.runDir,
      backend: "agy",
      runId: "a".repeat(24),
      env: {},
      platform: "darwin",
      execFileImpl: fake.impl,
      closePidWaitMs: 200,
    });
    const result = await bridge.close();
    assert.equal(result.closed, true);
    assert.equal(result.window_id, "31337");
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].kind, "close");
    assert.ok(fake.calls[0].script.includes('"31337"'));
    assert.equal(isProcessAlive(child.pid), false, "the viewer process must be gone before the window closes");
    const info = readRunDir(run.runDir).viewer;
    assert.ok(info.closed_at);
    assert.equal(info.close_result, "closed");

    // Idempotent: a second close does not touch osascript again.
    assert.equal((await bridge.close()).reason, "already-closed");
    assert.equal(fake.calls.length, 1);
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
    run.remove();
  }
});

test("bridge.close lets a viewer that exits by itself finish undisturbed", async () => {
  const run = makeRunDir();
  const tmp = makeTmpDir("cli-baton-viewer-selfexit-");
  const marker = path.join(tmp.path, "sigterm.txt");
  // Exits on its own after ~300ms; records a marker only if it is signalled.
  const child = spawn(
    process.execPath,
    [
      "-e",
      "process.on('SIGTERM', () => { require('node:fs').writeFileSync(process.env.MARKER, 'TERM'); process.exit(1); });" +
        "setTimeout(() => process.exit(0), 300);",
    ],
    { stdio: "ignore", env: { ...process.env, MARKER: marker } },
  );
  const fake = makeOsascriptFake();
  try {
    run.writeViewer({ window_id: "7007", opened_at: new Date().toISOString(), pid: child.pid });
    const bridge = createViewerBridge({
      runDir: run.runDir,
      backend: "agy",
      runId: "a".repeat(24),
      env: {},
      platform: "darwin",
      execFileImpl: fake.impl,
      closePidWaitMs: 3000,
    });
    const result = await bridge.close();
    assert.equal(result.closed, true);
    assert.equal(fs.existsSync(marker), false, "the viewer must not be signalled when it exits by itself");
    assert.match(String(readRunDir(run.runDir).viewerLog), /exited by itself/);
    assert.equal(fake.calls.length, 1, "the window is still closed afterwards");
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
    tmp.remove();
    run.remove();
  }
});

test("bridge.close escalates to SIGKILL when the viewer ignores SIGTERM", async () => {
  const run = makeRunDir();
  const child = spawn(
    process.execPath,
    ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
    { stdio: "ignore" },
  );
  const fake = makeOsascriptFake();
  try {
    run.writeViewer({ window_id: "555", opened_at: new Date().toISOString(), pid: child.pid });
    await sleep(100);
    const bridge = createViewerBridge({
      runDir: run.runDir,
      backend: "agy",
      runId: "a".repeat(24),
      env: {},
      platform: "darwin",
      execFileImpl: fake.impl,
      closePidWaitMs: 300,
    });
    await bridge.close();
    await waitFor(() => !isProcessAlive(child.pid), { timeoutMs: 3000, label: "SIGKILLed viewer" });
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
    run.remove();
  }
});

test("bridge.close refuses to signal a reused pid (start token mismatch)", async () => {
  const run = makeRunDir();
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  const fake = makeOsascriptFake();
  try {
    run.writeViewer({
      window_id: "1212",
      opened_at: new Date().toISOString(),
      pid: child.pid,
      pid_start: "Mon Jan  1 00:00:00 2001", // not this process
    });
    const bridge = createViewerBridge({
      runDir: run.runDir,
      backend: "agy",
      runId: "a".repeat(24),
      env: {},
      platform: "darwin",
      execFileImpl: fake.impl,
      closePidWaitMs: 100,
    });
    const result = await bridge.close();
    assert.equal(result.window_id, "1212");
    assert.equal(isProcessAlive(child.pid), true, "a mismatched start token must never be signalled");
    assert.match(String(readRunDir(run.runDir).viewerLog), /start token mismatch/);
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
    run.remove();
  }
});

test("bridge.close tolerates a user-closed window and missing viewer.json", async () => {
  const run = makeRunDir();
  const empty = makeRunDir();
  const fake = makeOsascriptFake({ closeResult: "missing" });
  try {
    run.writeViewer({ window_id: "8080", opened_at: new Date().toISOString(), pid: null });
    const bridge = createViewerBridge({
      runDir: run.runDir,
      backend: "agy",
      runId: "a".repeat(24),
      env: {},
      platform: "darwin",
      execFileImpl: fake.impl,
      closePidWaitMs: 100,
    });
    const result = await bridge.close();
    assert.equal(result.closed, false);
    assert.equal(result.result, "missing");
    assert.equal(fake.calls.length, 1);

    const emptyFake = makeOsascriptFake();
    const emptyBridge = createViewerBridge({
      runDir: empty.runDir,
      backend: "agy",
      runId: "a".repeat(24),
      env: {},
      platform: "darwin",
      execFileImpl: emptyFake.impl,
    });
    assert.equal((await emptyBridge.close()).reason, "no-viewer");
    assert.equal(emptyFake.calls.length, 0);
  } finally {
    run.remove();
    empty.remove();
  }
});

test("bridge.close reports (and logs) a window Terminal refused to close", async () => {
  const run = makeRunDir();
  const fake = makeOsascriptFake({ closeResult: "still-open" });
  try {
    run.writeViewer({ window_id: "6060", opened_at: new Date().toISOString(), pid: null });
    const bridge = createViewerBridge({
      runDir: run.runDir,
      backend: "agy",
      runId: "a".repeat(24),
      env: {},
      platform: "darwin",
      execFileImpl: fake.impl,
      closePidWaitMs: 100,
    });
    const result = await bridge.close();
    assert.equal(result.closed, false);
    assert.equal(result.result, "still-open");
    const runFiles = readRunDir(run.runDir);
    assert.equal(runFiles.viewer.close_result, "still-open");
    assert.match(String(runFiles.viewerLog), /WARNING: window 6060 is still open/);
  } finally {
    run.remove();
  }
});

test("bridge.close failure is logged and never thrown", async () => {
  const run = makeRunDir();
  const fake = makeOsascriptFake({ failClose: true });
  try {
    run.writeViewer({ window_id: "1234", opened_at: new Date().toISOString(), pid: null });
    const bridge = createViewerBridge({
      runDir: run.runDir,
      backend: "agy",
      runId: "a".repeat(24),
      env: {},
      platform: "darwin",
      execFileImpl: fake.impl,
      closePidWaitMs: 100,
    });
    const result = await bridge.close();
    assert.equal(result.closed, false);
    assert.equal(result.reason, "osascript-failed");
    const runFiles = readRunDir(run.runDir);
    assert.match(String(runFiles.viewerLog), /failed to close viewer window/);
    assert.equal(runFiles.viewer.close_result, "error");
  } finally {
    run.remove();
  }
});

test("bridge.closeSync stops the viewer and closes the window (runner cleanup path)", async () => {
  const run = makeRunDir();
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  const calls = [];
  try {
    run.writeViewer({ window_id: "9090", opened_at: new Date().toISOString(), pid: child.pid });
    const bridge = createViewerBridge({
      runDir: run.runDir,
      backend: "agy",
      runId: "a".repeat(24),
      env: {},
      platform: "darwin",
      execFileImpl: makeOsascriptFake().impl,
      spawnSyncImpl: (file, args, options) => {
        calls.push({ file, args, options });
        return { status: 0, stdout: "closed" };
      },
    });
    const result = bridge.closeSync();
    assert.equal(result.closed, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, "osascript");
    assert.ok(calls[0].args.includes("-e"));
    assert.match(String(calls[0].args[1]), /"9090"/);
    await waitFor(() => !isProcessAlive(child.pid), { timeoutMs: 3000, label: "viewer killed by closeSync" });
    assert.equal(bridge.closeSync().reason, "already-closed", "cleanup must be idempotent");
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
    run.remove();
  }
});

test("bridge.closeSync skips everything when there is no viewer.json", () => {
  const run = makeRunDir();
  const calls = [];
  try {
    const bridge = createViewerBridge({
      runDir: run.runDir,
      backend: "agy",
      runId: "a".repeat(24),
      env: {},
      platform: "darwin",
      execFileImpl: makeOsascriptFake().impl,
      spawnSyncImpl: (...args) => {
        calls.push(args);
        return { status: 0 };
      },
    });
    assert.equal(bridge.closeSync().reason, "no-viewer");
    assert.equal(calls.length, 0);
  } finally {
    run.remove();
  }
});

/* ------------------------------------------------------------------ *
 * end-to-end through the real detached runner (macOS only)
 * ------------------------------------------------------------------ */

function runnerEnv({ home, logDir, osascriptLog, extra = {} }) {
  return {
    ...fakeEnv({ backend: "agy", home, logDir, mode: "sleep", sleepMs: 600, text: "VIEWER_RUN_OK" }),
    CLI_BATON_VIEWER: "1",
    CLI_BATON_OSASCRIPT_BIN: FAKE_OSASCRIPT,
    FAKE_OSASCRIPT_LOG: osascriptLog,
    // Redundant with fakeEnv, but the runner inherits the server env through a
    // detached spawn: keep the fake CLI's runtime explicit so this test cannot
    // accidentally wait out the fixture's 60s default sleep.
    FAKE_MODE: "sleep",
    FAKE_SLEEP_MS: "600",
    FAKE_TEXT: "VIEWER_RUN_OK",
    CLI_BATON_CHAT_GRACE_S: "1",
    ...extra,
  };
}

const macOnly = process.platform === "darwin" ? false : "macOS only";

test("runner opens the viewer window at start and closes it when the run ends", { skip: macOnly, timeout: 45000 }, async () => {
  const home = makeHome();
  const logDir = makeTmpDir("cli-baton-viewer-log-");
  const osascriptLog = path.join(makeTmpDir("cli-baton-osascript-").path, "calls.jsonl");
  const env = runnerEnv({ home: home.path, logDir: logDir.path, osascriptLog });
  const client = await McpClient.start({ backend: "agy", env });
  try {
    const sent = toolPayload(await client.callTool("agy_send", { message: "viewer e2e", cwd: makeCwd().path, timeout_s: 30 }));
    const final = await waitForTerminal(client, "agy", sent.run_id, { timeoutMs: 20000 });
    assert.equal(final.state, "completed", JSON.stringify(final));
    assert.equal(final.reply, "VIEWER_RUN_OK");

    const info = await waitFor(() => {
      const run = readRunDir(sent.run_dir);
      return run.viewer && run.viewer.window_id && run.viewer.closed_at ? run.viewer : null;
    }, { timeoutMs: 10000, label: "viewer.json with window_id and closed_at" });
    assert.equal(info.window_id, "4242");
    assert.equal(info.backend, "agy");
    assert.ok(info.opened_at);
    assert.ok(info.closed_at);

    const calls = fs
      .readFileSync(osascriptLog, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.equal(calls.length, 2, "expected exactly one open and one close call: " + JSON.stringify(calls));
    assert.equal(calls[0].kind, "open");
    assert.ok(calls[0].script.includes(VIEWER_PATH), "open script must launch the viewer script");
    assert.ok(calls[0].script.includes(sent.run_dir), "open script must pass the run dir");
    assert.ok(calls[0].script.includes("cli-baton · agy · " + sent.run_id.slice(0, 8)), calls[0].script);
    assert.equal(calls[1].kind, "other");
    assert.ok(calls[1].script.includes('"4242"'), "close script must use the recorded window id");
  } finally {
    await client.close().catch(() => {});
    home.remove();
    logDir.remove();
  }
});

test("CLI_BATON_VIEWER=0 never calls osascript during a real run", { skip: macOnly, timeout: 45000 }, async () => {
  const home = makeHome();
  const logDir = makeTmpDir("cli-baton-viewer-log-");
  const osascriptLog = path.join(makeTmpDir("cli-baton-osascript-").path, "calls.jsonl");
  const env = {
    ...fakeEnv({ backend: "agy", home: home.path, logDir: logDir.path }),
    CLI_BATON_VIEWER: "0",
    CLI_BATON_OSASCRIPT_BIN: FAKE_OSASCRIPT,
    FAKE_OSASCRIPT_LOG: osascriptLog,
  };
  const client = await McpClient.start({ backend: "agy", env });
  try {
    const sent = toolPayload(await client.callTool("agy_send", { message: "no window", cwd: makeCwd().path }));
    const final = await waitForTerminal(client, "agy", sent.run_id, { timeoutMs: 20000 });
    assert.equal(final.state, "completed");
    assert.equal(fs.existsSync(osascriptLog), false, "osascript must not run with CLI_BATON_VIEWER=0");
    assert.equal(fs.existsSync(path.join(sent.run_dir, "viewer.json")), false);
  } finally {
    await client.close().catch(() => {});
    home.remove();
    logDir.remove();
  }
});

test("a CLI that exits instantly still finalizes and never leaves an orphan window", { skip: macOnly, timeout: 45000 }, async () => {
  const home = makeHome();
  const logDir = makeTmpDir("cli-baton-viewer-log-");
  const osascriptLog = path.join(makeTmpDir("cli-baton-osascript-").path, "calls.jsonl");
  const env = {
    ...fakeEnv({ backend: "agy", home: home.path, logDir: logDir.path, mode: "success", text: "FAST_OK" }),
    CLI_BATON_VIEWER: "1",
    CLI_BATON_CHAT_GRACE_S: "0",
    CLI_BATON_OSASCRIPT_BIN: FAKE_OSASCRIPT,
    FAKE_OSASCRIPT_LOG: osascriptLog,
  };
  const client = await McpClient.start({ backend: "agy", env });
  try {
    const sent = toolPayload(await client.callTool("agy_send", { message: "instant exit", cwd: makeCwd().path }));
    const final = await waitForTerminal(client, "agy", sent.run_id, { timeoutMs: 20000 });
    assert.equal(final.state, "completed", JSON.stringify(final));
    assert.equal(final.reply, "FAST_OK");
    const info = await waitFor(() => {
      const run = readRunDir(sent.run_dir);
      return run.viewer && run.viewer.closed_at ? run.viewer : null;
    }, { timeoutMs: 10000, label: "viewer.json closed for an already-finished run" });
    assert.ok(info.window_id, "the window must be recorded so it can be closed");
    assert.ok(info.closed_at);
  } finally {
    await client.close().catch(() => {});
    home.remove();
    logDir.remove();
  }
});

test("SIGTERM to the runner still closes the viewer window (sync cleanup path)", { skip: macOnly, timeout: 45000 }, async () => {
  const home = makeHome();
  const logDir = makeTmpDir("cli-baton-viewer-log-");
  const osascriptLog = path.join(makeTmpDir("cli-baton-osascript-").path, "calls.jsonl");
  const env = {
    ...fakeEnv({ backend: "agy", home: home.path, logDir: logDir.path, mode: "sleep", sleepMs: 30000 }),
    CLI_BATON_VIEWER: "1",
    CLI_BATON_OSASCRIPT_BIN: FAKE_OSASCRIPT,
    FAKE_OSASCRIPT_LOG: osascriptLog,
  };
  const client = await McpClient.start({ backend: "agy", env });
  try {
    const sent = toolPayload(await client.callTool("agy_send", { message: "sigterm cleanup", cwd: makeCwd().path, timeout_s: 120 }));
    const viewerInfoPath = path.join(sent.run_dir, "viewer.json");
    await waitFor(() => {
      try {
        const info = JSON.parse(fs.readFileSync(viewerInfoPath, "utf8"));
        return info.window_id ? info : null;
      } catch {
        return null;
      }
    }, { timeoutMs: 10000, label: "viewer.json with window_id" });
    const supervisor = JSON.parse(fs.readFileSync(path.join(sent.run_dir, "supervisor.json"), "utf8"));
    process.kill(supervisor.pid, "SIGTERM");

    const info = await waitFor(() => {
      const current = readRunDir(sent.run_dir).viewer;
      return current && current.closed_at ? current : null;
    }, { timeoutMs: 10000, label: "viewer.json closed by the SIGTERM cleanup" });
    assert.equal(info.close_result, "sync");
    const calls = fs.readFileSync(osascriptLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.ok(calls.some((call) => /"4242"/.test(call.script)), "the sync cleanup must close the recorded window");
  } finally {
    await client.close().catch(() => {});
    home.remove();
    logDir.remove();
  }
});

test("osascript failures never change the run result", { skip: macOnly, timeout: 45000 }, async () => {
  const home = makeHome();
  const logDir = makeTmpDir("cli-baton-viewer-log-");
  const osascriptLog = path.join(makeTmpDir("cli-baton-osascript-").path, "calls.jsonl");
  const env = runnerEnv({ home: home.path, logDir: logDir.path, osascriptLog, extra: { FAKE_OSASCRIPT_MODE: "fail" } });
  const client = await McpClient.start({ backend: "agy", env });
  try {
    const sent = toolPayload(await client.callTool("agy_send", { message: "failing osascript", cwd: makeCwd().path }));
    const final = await waitForTerminal(client, "agy", sent.run_id, { timeoutMs: 20000 });
    assert.equal(final.state, "completed", JSON.stringify(final));
    assert.equal(final.reply, "VIEWER_RUN_OK");
    const viewerLog = await waitFor(() => {
      const text = readRunDir(sent.run_dir).viewerLog;
      return text && text.includes("failed to open viewer window") ? text : null;
    }, { timeoutMs: 10000, label: "viewer.log to record the osascript failure" });
    assert.match(viewerLog, /\[viewer-window\] failed to open viewer window/);
  } finally {
    await client.close().catch(() => {});
    home.remove();
    logDir.remove();
  }
});
