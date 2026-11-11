/**
 * macOS "pop up / close the live viewer window" bridge.
 *
 * The runner calls createViewerBridge(...).open() right after the backend child
 * process starts, and .close() when the run reaches a terminal state (or the
 * runner is about to exit). Everything here is best effort: osascript failures
 * are appended to <run_dir>/viewer.log and never change a run's outcome.
 *
 * Env switches:
 *   CLI_BATON_VIEWER=0        disable the window entirely
 *   CLI_BATON_OSASCRIPT_BIN   override the osascript binary (tests / debugging)
 */
import fs from "node:fs";
import path from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import * as runs from "./runs.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const VIEWER_SCRIPT = path.join(HERE, "viewer.mjs");
export const OSASCRIPT_TIMEOUT_MS = 8000;
export const CLOSE_PID_WAIT_MS = 3000;
export const TERM_GRACE_MS = 1000;
export const WINDOW_TITLE_PREFIX = "cli-baton";

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** CLI_BATON_VIEWER=0 (or false/off/no) turns the live window off. */
export function viewerDisabled(env = process.env) {
  const raw = String(env && env.CLI_BATON_VIEWER !== undefined ? env.CLI_BATON_VIEWER : "")
    .trim()
    .toLowerCase();
  return raw === "0" || raw === "false" || raw === "off" || raw === "no";
}

/** Only macOS, and only when not disabled. Non-darwin platforms never pop up. */
export function shouldOpenViewer({ env = process.env, platform = process.platform } = {}) {
  if (platform !== "darwin") return false;
  return !viewerDisabled(env);
}

/** POSIX single-quote escaping: safe for paths with spaces or quotes. */
export function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

/** Escape a value for an AppleScript string literal. */
export function applescriptString(value) {
  return '"' + String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

export function osascriptPath(env = process.env) {
  const override = String((env && env.CLI_BATON_OSASCRIPT_BIN) || "").trim();
  return override || "osascript";
}

export function buildViewerCommand({ runDir, nodePath = process.execPath, viewerScript = VIEWER_SCRIPT } = {}) {
  return shellQuote(nodePath) + " " + shellQuote(viewerScript) + " " + shellQuote(runDir);
}

export function buildWindowTitle({ backend, runId } = {}) {
  return WINDOW_TITLE_PREFIX + " · " + String(backend || "?") + " · " + String(runId || "").slice(0, 8);
}

/**
 * AppleScript that opens a NEW Terminal window running the viewer and returns
 * its window id. `activate` is intentionally never called so the new window
 * does not steal the user's focus.
 *
 * The id is found by diffing `id of every window` (a flat list of integers)
 * before and after `do script`. Iterating window *references* (`repeat with w in
 * windows`) breaks as soon as `do script` mutates the window list — AppleScript
 * then fails with "invalid index" and the id is lost.
 */
export function buildOpenScript({ command, title }) {
  return [
    'tell application "Terminal"',
    "  set beforeIDs to id of every window",
    "  set newTab to do script " + applescriptString(command),
    "  try",
    "    set custom title of newTab to " + applescriptString(title),
    "  end try",
    "  set afterIDs to id of every window",
    "  set newID to missing value",
    "  repeat with candidateID in afterIDs",
    "    if beforeIDs does not contain (candidateID as integer) then set newID to candidateID as integer",
    "  end repeat",
    "  -- No front-window fallback on purpose: guessing could record one of the",
    "  -- user's own windows and close it when the run ends. Without a confirmed id",
    "  -- we simply do not track a window.",
    "  try",
    "    if newID is not missing value then set title displays custom title of (first window whose id is newID) to true",
    "  end try",
    "  if newID is missing value then return \"\"",
    "  return newID as text",
    'end tell',
  ].join("\n");
}

/**
 * AppleScript that closes the viewer window by id, without a "terminate running
 * processes?" sheet. Three things matter here:
 *
 *  - The runner stops the viewer first, so the tab is normally idle; the script
 *    still waits briefly for it to become idle before touching anything.
 *  - If a foreground process is still running in that tab, the shell is told to
 *    exit first, so closing cannot raise the "terminate running processes"
 *    confirmation sheet. (Sending `exit` to an *idle* tab would leave an empty
 *    "ghost" window behind on recent macOS versions, hence the busy check.)
 *  - The window is resolved by id at every step: a reference captured from
 *    `every window` (e.g. "item 2 of every window") goes stale as soon as the
 *    window list changes and silently leaves the window open. Terminal removes
 *    the window asynchronously, so the script polls before reporting.
 *
 * Returns "closed", "missing" (user closed it already) or "still-open".
 */
export function buildCloseScript({ windowId }) {
  return [
    'tell application "Terminal"',
    "  set targetID to " + applescriptString(String(windowId)),
    "  set targetWindow to missing value",
    "  try",
    "    set targetWindow to (first window whose id is targetID)",
    "  end try",
    "  if targetWindow is missing value then return \"missing\"",
    "  set tabBusy to false",
    "  repeat 20 times",
    "    set tabBusy to false",
    "    try",
    "      set tabBusy to busy of tab 1 of targetWindow",
    "    end try",
    "    if tabBusy is false then exit repeat",
    "    delay 0.1",
    "    set targetWindow to missing value",
    "    try",
    "      set targetWindow to (first window whose id is targetID)",
    "    end try",
    "    if targetWindow is missing value then return \"closed\"",
    "  end repeat",
    "  if tabBusy then",
    "    try",
    "      do script \"exit\" in (tab 1 of targetWindow)",
    "    end try",
    "    delay 0.3",
    "  end if",
    "  set targetWindow to missing value",
    "  try",
    "    set targetWindow to (first window whose id is targetID)",
    "  end try",
    "  if targetWindow is missing value then return \"closed\"",
    "  try",
    "    close targetWindow saving no",
    "  end try",
    "  repeat 50 times",
    "    delay 0.1",
    "    set targetWindow to missing value",
    "    try",
    "      set targetWindow to (first window whose id is targetID)",
    "    end try",
    "    if targetWindow is missing value then return \"closed\"",
    "  end repeat",
    "  return \"still-open\"",
    'end tell',
  ].join("\n");
}

function runOsascript(execFileImpl, script, env) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (error, stdout, stderr) => {
      if (settled) return;
      settled = true;
      if (error) {
        const wrapped = new Error(String((error && error.message) || error));
        wrapped.stderr = String(stderr || "");
        reject(wrapped);
        return;
      }
      resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") });
    };
    try {
      execFileImpl(
        osascriptPath(env),
        ["-e", script],
        { env, timeout: OSASCRIPT_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true },
        done,
      );
    } catch (error) {
      done(error, "", "");
    }
  });
}

function describeError(error) {
  if (!error) return "unknown error";
  const stderr = String(error.stderr || "").trim();
  return String(error.message || error) + (stderr ? " | stderr: " + stderr.replace(/\s+/g, " ").slice(0, 300) : "");
}

/**
 * Viewer window controller for one run. All methods swallow their own errors.
 *
 * @param {object} options
 * @param {string} options.runDir   run directory (viewer.json / viewer.log live here)
 * @param {string} options.backend  backend name (used for the window title)
 * @param {string} options.runId    run id (title uses the first 8 chars)
 * @param {object} [options.env]
 * @param {string} [options.platform] override process.platform (tests)
 * @param {function} [options.execFileImpl] injectable execFile (tests)
 * @param {function} [options.spawnSyncImpl] injectable spawnSync (tests)
 */
export function createViewerBridge({
  runDir,
  backend = null,
  runId = null,
  env = process.env,
  platform = process.platform,
  execFileImpl = execFile,
  spawnSyncImpl = spawnSync,
  viewerScript = VIEWER_SCRIPT,
  nodePath = process.execPath,
  closePidWaitMs = CLOSE_PID_WAIT_MS,
  sleep = realSleep,
  now = () => new Date(),
} = {}) {
  const state = { opened: false, closed: false, windowId: null, disabled: false, openTask: null };

  const log = (message) => {
    if (!runDir) return;
    runs.appendViewerLog(runDir, "[viewer-window] " + message);
  };

  const merge = (patch) => {
    try {
      return runs.mergeViewerInfo(runDir, patch);
    } catch (error) {
      log("failed to write viewer.json: " + describeError(error));
      return null;
    }
  };

  async function openImpl() {
    if (state.opened) return { opened: false, reason: "already-open", window_id: state.windowId };
    if (!shouldOpenViewer({ env, platform })) {
      state.disabled = true;
      log(
        "not opening: " +
          (platform !== "darwin" ? "platform is " + platform + " (macOS only)" : "CLI_BATON_VIEWER=" + String(env.CLI_BATON_VIEWER)),
      );
      return { opened: false, reason: "disabled" };
    }
    if (!fs.existsSync(viewerScript)) {
      log("not opening: viewer script missing at " + viewerScript);
      return { opened: false, reason: "missing-viewer-script" };
    }
    state.opened = true;
    const title = buildWindowTitle({ backend, runId });
    const command = buildViewerCommand({ runDir, nodePath, viewerScript });
    // Written before the window exists so the run dir records the attempt even
    // if osascript fails; the viewer process merges its own pid in later.
    merge({
      window_id: null,
      opened_at: now().toISOString(),
      backend,
      run_id: runId,
      title,
      command,
      opening: true,
    });
    let windowId = null;
    try {
      const result = await runOsascript(execFileImpl, buildOpenScript({ command, title }), env);
      windowId = String(result.stdout || "").trim() || null;
    } catch (error) {
      log("failed to open viewer window: " + describeError(error));
      merge({ window_id: null, open_failed_at: now().toISOString(), open_error: describeError(error) });
      return { opened: false, reason: "osascript-failed" };
    }
    state.windowId = windowId;
    merge({ window_id: windowId, opened_at: now().toISOString(), title, command, opening: false });
    log("opened viewer window " + (windowId || "(unknown id)") + " for run " + String(runId));
    return { opened: true, window_id: windowId };
  }

  async function stopViewerProcess(info) {
    const pid = Number(info && info.pid);
    if (!Number.isInteger(pid) || pid <= 0) {
      // The viewer may not have started yet; give it a beat to register its pid.
      await sleep(150);
      const again = runs.readViewerInfo(runDir) || {};
      const againPid = Number(again.pid);
      if (Number.isInteger(againPid) && againPid > 0) return stopPid(againPid, again);
      return { stopped: false, reason: "no-pid" };
    }
    return stopPid(pid, info);
  }

  /** Refuse to signal a pid whose recorded start token does not match. */
  function pidMatches(pid, info) {
    const recorded = info && typeof info.pid_start === "string" ? info.pid_start : null;
    if (!recorded) return true; // legacy viewer.json without a token
    const current = runs.processStartToken(pid);
    return !current || current === recorded;
  }

  async function stopPid(pid, info) {
    if (!runs.isPidAlive(pid)) return { stopped: false, reason: "already-exited", pid };
    if (!pidMatches(pid, info)) {
      log("not signalling pid " + pid + ": start token mismatch (pid was reused)");
      return { stopped: false, reason: "pid-reused", pid };
    }
    // The viewer notices the terminal state by itself and exits 0 — wait up to
    // closePidWaitMs for that, and only then terminate it.
    const selfExitDeadline = Date.now() + closePidWaitMs;
    while (Date.now() < selfExitDeadline) {
      if (!runs.isPidAlive(pid)) return { stopped: false, reason: "self-exited", pid };
      await sleep(100);
    }
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      log("failed to SIGTERM viewer pid " + pid + ": " + describeError(error));
    }
    const termDeadline = Date.now() + TERM_GRACE_MS;
    while (Date.now() < termDeadline) {
      if (!runs.isPidAlive(pid)) return { stopped: true, pid, signal: "SIGTERM" };
      await sleep(100);
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      log("failed to SIGKILL viewer pid " + pid + ": " + describeError(error));
    }
    return { stopped: true, pid, signal: "SIGKILL" };
  }

  async function close() {
    if (state.closed) return { closed: false, reason: "already-closed" };
    state.closed = true;
    if (state.openTask) {
      // Never close while the window is still being opened: the id would be lost
      // and the window would be orphaned. open() itself never rejects.
      try {
        await state.openTask;
      } catch {
        // ignore
      }
    }
    if (state.disabled) return { closed: false, reason: "disabled" };
    if (!runDir) return { closed: false, reason: "no-run-dir" };
    const info = runs.readViewerInfo(runDir);
    if (!info) {
      log("nothing to close: viewer.json missing");
      return { closed: false, reason: "no-viewer" };
    }
    const stopped = await stopViewerProcess(info);
    if (stopped.stopped) log("stopped viewer pid " + stopped.pid + " (" + stopped.signal + ")");
    else if (stopped.reason === "self-exited") log("viewer pid " + stopped.pid + " exited by itself");
    const windowId = info.window_id || state.windowId;
    if (!windowId) {
      log("nothing to close: viewer.json has no window_id");
      merge({ closed_at: now().toISOString(), close_result: "no-window" });
      return { closed: false, reason: "no-window-id" };
    }
    let result = null;
    try {
      const response = await runOsascript(execFileImpl, buildCloseScript({ windowId }), env);
      result = String(response.stdout || "").trim() || null;
      if (result === "still-open") {
        log("WARNING: window " + windowId + " is still open after close (Terminal refused; user must close it)");
      } else {
        log("close window " + windowId + " -> " + (result || "(no output)"));
      }
    } catch (error) {
      log("failed to close viewer window " + windowId + ": " + describeError(error));
      merge({ closed_at: now().toISOString(), close_result: "error", close_error: describeError(error) });
      return { closed: false, reason: "osascript-failed", window_id: windowId };
    }
    merge({ closed_at: now().toISOString(), close_result: result || "unknown" });
    return { closed: result === "closed", window_id: windowId, result };
  }

  /** Synchronous best-effort variant used from process "exit" handlers. */
  function closeSync() {
    if (state.closed) return { closed: false, reason: "already-closed" };
    state.closed = true;
    if (state.disabled || !runDir) return { closed: false, reason: "disabled" };
    let info = null;
    try {
      info = runs.readViewerInfo(runDir);
    } catch {
      info = null;
    }
    if (!info) return { closed: false, reason: "no-viewer" };
    const pid = Number(info.pid);
    if (Number.isInteger(pid) && pid > 0 && runs.isPidAlive(pid) && pidMatches(pid, info)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // ignore
      }
    }
    const windowId = info.window_id || state.windowId;
    if (!windowId) return { closed: false, reason: "no-window-id" };
    try {
      spawnSyncImpl(osascriptPath(env), ["-e", buildCloseScript({ windowId })], {
        env,
        timeout: OSASCRIPT_TIMEOUT_MS,
        stdio: "ignore",
        windowsHide: true,
      });
      try {
        runs.mergeViewerInfo(runDir, { closed_at: now().toISOString(), close_result: "sync" });
      } catch {
        // ignore
      }
    } catch (error) {
      log("failed to close viewer window (sync) " + windowId + ": " + describeError(error));
    }
    return { closed: true, window_id: windowId };
  }

  return {
    open() {
      if (!state.openTask) state.openTask = openImpl();
      return state.openTask;
    },
    close,
    closeSync,
    get opened() {
      return state.opened;
    },
    get windowId() {
      return state.windowId;
    },
    get disabled() {
      return state.disabled;
    },
  };
}
