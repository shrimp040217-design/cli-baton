#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import * as runs from "./runs.mjs";
import * as chat from "./chat.mjs";
import { getBackend } from "./backends/index.mjs";
import { createViewerBridge, shouldOpenViewer } from "./viewer-window.mjs";

const HEARTBEAT_INTERVAL_MS = 2000;
// Progress summaries (last_output_at / stdout_bytes / event_count / last_event)
// are written at most once per second.
const PROGRESS_INTERVAL_MS = 1000;
const CANCEL_POLL_MS = 500;
const KILL_GRACE_MS = 5000;

/**
 * Live viewer window handle for this run (macOS). Set after the CLI child
 * process starts, closed on every terminal path. All viewer failures are
 * recorded in <run_dir>/viewer.log and never affect the run itself.
 */
let activeViewer = null;

async function closeActiveViewer() {
  if (!activeViewer) return;
  const viewer = activeViewer;
  activeViewer = null;
  try {
    await viewer.close();
  } catch (error) {
    log("viewer close failed (ignored): " + String((error && error.message) || error));
  }
}

// Last-resort cleanup: if the runner dies through an unexpected path after the
// window was opened, try to stop the viewer and close the window synchronously.
function cleanupViewerOnExit(signal) {
  if (!activeViewer) return;
  log("received " + signal + "; closing the viewer window before exiting");
  try {
    activeViewer.closeSync();
  } catch {
    // never let cleanup mask the exit
  }
  activeViewer = null;
}

process.on("SIGTERM", () => {
  cleanupViewerOnExit("SIGTERM");
  process.exit(143);
});
process.on("SIGINT", () => {
  cleanupViewerOnExit("SIGINT");
  process.exit(130);
});

process.on("exit", () => {
  if (!activeViewer) return;
  try {
    activeViewer.closeSync();
  } catch {
    // never let cleanup mask the exit
  }
  activeViewer = null;
});

function parseArgs(argv) {
  const parsed = { backend: null, runId: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--backend") parsed.backend = argv[++index];
    else if (arg.startsWith("--backend=")) parsed.backend = arg.slice("--backend=".length);
    else if (arg === "--run-id") parsed.runId = argv[++index];
    else if (arg.startsWith("--run-id=")) parsed.runId = arg.slice("--run-id=".length);
    else if (!arg.startsWith("-")) parsed.runId = parsed.runId || arg;
  }
  return parsed;
}

function log(message) {
  process.stderr.write("[cli-baton-runner] " + message + "\n");
}

// GUI-launched MCP clients often omit Homebrew from PATH, and an npm-installed
// CLI starts with `#!/usr/bin/env node`: keep this Node and the CLI's folder reachable.
function childEnv(cliPath) {
  const entries = [path.dirname(process.execPath)];
  if (path.isAbsolute(String(cliPath))) entries.push(path.dirname(cliPath));
  entries.push(...String(process.env.PATH || "").split(path.delimiter).filter(Boolean));
  return { ...process.env, PATH: [...new Set(entries)].join(path.delimiter) };
}

function quoteForCmd(value) {
  return '"' + String(value).replace(/"/g, '""') + '"';
}

function spawnCli(execPath, args, options) {
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(execPath)) {
    const commandLine = [execPath, ...args].map(quoteForCmd).join(" ");
    return spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", commandLine], options);
  }
  return spawn(execPath, args, options);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const backendName = args.backend;
  const runId = args.runId;
  const backend = getBackend(backendName);
  if (!backend) {
    log("missing or unknown --backend");
    process.exit(2);
  }
  if (!runs.isValidRunId(runId)) {
    log("missing or invalid --run-id");
    process.exit(2);
  }

  const root = runs.resolveRoot(process.env);
  const runDir = runs.runDirFor(root, backendName, runId);
  const paths = runs.runPaths(runDir);
  if (!fs.existsSync(paths.meta)) {
    log("run not found: " + runDir);
    process.exit(2);
  }
  if (runs.readResult(runDir)) {
    log("run already finalized: " + runId);
    process.exit(0);
  }

  const meta = runs.readMeta(runDir) || {};
  const startedAt = new Date().toISOString();

  // Publish supervisor identity early: protects liveness detection even if the
  // MCP server dies right after spawning us.
  runs.writeSupervisor(runDir, {
    pid: process.pid,
    pid_start: runs.processStartToken(process.pid),
    spawned_at: meta.runner_spawned_at || startedAt,
    backend: backendName,
    run_id: runId,
  });

  // --- progress / stall signals -------------------------------------------
  // The runner already forwards backend events to stdout.jsonl as they arrive;
  // it also keeps a cheap summary in heartbeat.json so a caller can tell
  // "still working" from "stuck". Writes are throttled to at most one per
  // second (a chatty CLI can emit thousands of deltas), and the last summary is
  // flushed when the run ends.
  const progress = {
    last_output_at: Date.now(),
    stdout_bytes: 0,
    event_count: 0,
    last_event: null,
    pending_line: "",
  };
  const progressThrottle = runs.createThrottle({ intervalMs: PROGRESS_INTERVAL_MS });
  let heartbeatPhase = "starting";
  // Chat-mode state published for tools/viewer (mutated in place so the plain
  // heartbeat writer can always read it, even before the child is spawned).
  const chatInfo = {
    enabled: false,
    inflight: false,
    graceUntil: null,
    turns: 0,
    closed: false,
    maxTurns: null,
    usedTurns: 0,
    remainingTurns: null,
    maxTurnsReached: false,
  };
  // Only the throttled path mutates what lands in heartbeat.json, so the four
  // progress fields never change faster than once per second even though the
  // plain liveness heartbeat keeps ticking every couple of seconds.
  let published = { ...progress };

  const writeHeartbeat = () => {
    try {
      runs.writeHeartbeat(runDir, {
        phase: heartbeatPhase,
        child_pid: meta.child_pid || null,
        last_output_at: published.last_output_at,
        stdout_bytes: published.stdout_bytes,
        event_count: published.event_count,
        last_event: published.last_event,
        chat: chatInfo.enabled,
        inflight: chatInfo.inflight,
        grace_until: chatInfo.graceUntil,
        turns: chatInfo.turns,
        stdin_closed: chatInfo.closed === true,
        max_turns: chatInfo.maxTurns,
        turns_used: chatInfo.usedTurns,
        turns_remaining: chatInfo.remainingTurns,
        max_turns_reached: chatInfo.maxTurnsReached === true,
      });
    } catch {
      // keep supervising even if heartbeat write fails
    }
  };

  const publishProgress = () => {
    published = {
      last_output_at: progress.last_output_at,
      stdout_bytes: progress.stdout_bytes,
      event_count: progress.event_count,
      last_event: progress.last_event,
    };
    writeHeartbeat();
  };

  // A trailing publish keeps the last values from being lost when output stops
  // right after a throttled update (e.g. a silent CLI that printed two lines).
  let trailingTimer = null;
  const scheduleTrailingPublish = () => {
    if (trailingTimer) return;
    const waitMs = Math.max(0, PROGRESS_INTERVAL_MS - (Date.now() - progressThrottle.lastAt));
    trailingTimer = setTimeout(() => {
      trailingTimer = null;
      progressThrottle.mark();
      publishProgress();
    }, waitMs);
    if (typeof trailingTimer.unref === "function") trailingTimer.unref();
  };

  const noteOutput = () => {
    progress.last_output_at = Date.now();
    if (!progressThrottle.ready()) {
      scheduleTrailingPublish();
      return;
    }
    progressThrottle.mark();
    publishProgress();
  };

  // Set once the chat block below runs; called for every `event:"result"` line.
  let onTurnResult = null;
  // Injected messages are printed into stdout.jsonl, but never in the middle of
  // a line the CLI is still writing (a big result can span several chunks).
  const deferredInjected = [];
  let writeInjectedRaw = null;

  const noteStdout = (chunk) => {
    const text = String(chunk);
    progress.stdout_bytes += Buffer.byteLength(text, "utf8");
    progress.pending_line += text;
    // A CLI that streams a huge single line would otherwise grow this buffer
    // without bound; stdout.jsonl remains the complete record.
    if (progress.pending_line.length > 1024 * 1024) {
      progress.pending_line = progress.pending_line.slice(-4096);
    }
    let index = progress.pending_line.indexOf("\n");
    while (index >= 0) {
      const line = progress.pending_line.slice(0, index).trim();
      progress.pending_line = progress.pending_line.slice(index + 1);
      index = progress.pending_line.indexOf("\n");
      if (!line) continue;
      let parsed = null;
      try {
        parsed = JSON.parse(line);
      } catch {
        parsed = null;
      }
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        progress.event_count += 1;
        progress.last_event =
          typeof parsed.event === "string" ? parsed.event : typeof parsed.type === "string" ? parsed.type : "json";
        if (parsed.event === "result" && onTurnResult) {
          try {
            onTurnResult(parsed.result && typeof parsed.result === "object" ? parsed.result : {});
          } catch {
            // turn bookkeeping must never break the run
          }
        }
      } else {
        progress.last_event = "raw";
      }
    }
    if (writeInjectedRaw && progress.pending_line === "" && deferredInjected.length > 0) {
      while (deferredInjected.length > 0) writeInjectedRaw(deferredInjected.shift());
    }
    noteOutput();
  };

  writeHeartbeat();
  const heartbeatTimer = setInterval(() => {
    writeHeartbeat();
  }, HEARTBEAT_INTERVAL_MS);

  let timeoutTimer = null;
  let graceTimer = null;
  let cancelPollTimer = null;

  const finalize = (patch) => {
    clearInterval(heartbeatTimer);
    if (cancelPollTimer) clearInterval(cancelPollTimer);
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (graceTimer) clearTimeout(graceTimer);
    try {
      return runs.finalizeRun({ runDir, patch });
    } catch (error) {
      log("failed to finalize run: " + (error && error.message));
      return null;
    }
  };

  if (runs.hasCancelRequest(runDir)) {
    runs.writeFileAtomic(paths.reply, "", 0o600);
    finalize({
      state: "cancelled",
      reply: "",
      exit_code: null,
      error: "cancelled by user",
      started_at: meta.started_at || startedAt,
      ended_at: new Date().toISOString(),
    });
    return;
  }

  const prompt = runs.readPrompt(runDir);
  let invocation;
  try {
    invocation = backend.buildInvocation({
      prompt,
      cwd: meta.cwd,
      sessionId: meta.session_id,
      model: meta.model,
      effort: meta.effort,
      access: meta.access,
    });
  } catch (error) {
    runs.writeFileAtomic(paths.reply, "", 0o600);
    finalize({
      state: "failed",
      reply: "",
      exit_code: null,
      error: "Failed to build CLI invocation: " + (error && error.message),
      started_at: startedAt,
      ended_at: new Date().toISOString(),
    });
    return;
  }

  meta.state = "running";
  meta.started_at = startedAt;
  runs.writeMeta(runDir, meta);

  runs.writeFileAtomic(paths.stdout, "", 0o600);
  runs.writeFileAtomic(paths.stderr, "", 0o600);
  const stdoutFd = fs.openSync(paths.stdout, "a", 0o600);
  const stderrFd = fs.openSync(paths.stderr, "a", 0o600);

  const accessMode = meta.access || backend.defaultAccess;
  log("starting " + backendName + " run " + runId + " in " + meta.cwd + " (access=" + accessMode + ")");

  // --- conversation layer (shared by both backends) -----------------------
  // The inbox / queue / turns / grace state machine lives in chat.mjs. Only
  // "how does the next message reach the CLI" differs:
  //   stdin  (agy)   — write another NDJSON user event into the live process
  //   resume (codex) — start `codex exec resume … <thread>` for that message
  const chatMode = backend.chatMode || null; // "stdin" | "resume" | null
  const chatEnabled = Boolean(chatMode);
  let child = null;
  let attemptBuffer = "";
  let attemptStartedAt = 0;
  let lastExitCode = null;
  let threadId = meta.session_id || null;
  let terminating = null;
  let settled = false;
  let cancelled = false;
  let timedOut = false;
  let session = null;
  let inboxTimer = null;

  const publishChatInfo = () => {
    if (!session) return;
    const info = session.info();
    chatInfo.enabled = info.chat;
    chatInfo.inflight = info.inflight;
    chatInfo.graceUntil = info.graceUntil;
    chatInfo.turns = info.turns;
    chatInfo.closed = info.closed;
    chatInfo.maxTurns = info.maxTurns;
    chatInfo.usedTurns = info.usedTurns;
    chatInfo.remainingTurns = info.remainingTurns;
    chatInfo.maxTurnsReached = info.maxTurnsReached;
    writeHeartbeat();
  };

  const maxTurns = chat.maxTurnsFor(backendName, process.env);
  const initialUsedTurns = meta.session_id ? 1 : 0; // resumed sessions already spent a turn
  session = chat.createChatSession({
    enabled: chatEnabled,
    maxTurns,
    initialUsedTurns,
    policy: chat.chatPolicy({
      env: process.env,
      platform: process.platform,
      viewerEnabled: shouldOpenViewer({ env: process.env, platform: process.platform }),
    }),
    send: (entry) => sendTurn(entry),
    onDone: (reason) => doneConversation(reason),
    onTurn: (turn, turns) => {
      chatInfo.turns = turns.length;
      try {
        runs.writeTurns(runDir, turns);
      } catch {
        // keep going even if the turn log cannot be written
      }
      log("turn " + turns.length + " finished: " + (turn.status || "unknown"));
    },
    onChange: publishChatInfo,
    log,
  });
  chatInfo.enabled = chatEnabled;

  writeInjectedRaw = (line) => {
    try {
      fs.writeSync(stdoutFd, line);
    } catch {
      // ignore write errors
    }
    try {
      progress.stdout_bytes += Buffer.byteLength(line, "utf8");
      progress.event_count += 1;
      progress.last_event = "user_injected";
      noteOutput();
    } catch {
      // ignore accounting errors
    }
  };

  // agy ends a turn with an `event:"result"` line on the live process; codex
  // ends one when its per-turn process exits (see onAttemptExit).
  if (chatEnabled && chatMode === "stdin") {
    onTurnResult = (result) => {
      session.completeTurn({
        reply: typeof result.response === "string" ? result.response : "",
        status: typeof result.status === "string" ? result.status : null,
        duration_s: typeof result.duration_seconds === "number" ? result.duration_seconds : null,
        usage: result.usage && typeof result.usage === "object" ? result.usage : null,
      });
    };
  }

  const writeChatEvent = (line) => {
    // Mid-line: keep it queued until the CLI's line is terminated.
    if (progress.pending_line !== "") {
      deferredInjected.push(line);
      return;
    }
    writeInjectedRaw(line);
  };

  const writeInjectedEvent = (entry) => writeChatEvent(chat.formatInjectedEvent(entry));

  const writeRejectedEvent = (entry, reason) => {
    writeChatEvent(
      JSON.stringify({
        event: "user_rejected",
        text: entry.text,
        at: entry.at,
        source: entry.source,
        reason,
      }) + "\n",
    );
  };

  const killGroup = (signal) => {
    if (!child) return;
    if (meta.child_pgid) runs.signalProcessGroup(meta.child_pgid, signal);
    try {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    } catch {
      // already gone
    }
  };

  /** Attach the shared event plumbing to one CLI process (agy: one, codex: one per turn). */
  const wireAttempt = (proc, invocationArgs, promptText) => {
    child = proc;
    attemptBuffer = "";
    attemptStartedAt = Date.now();
    const pid = Number(proc.pid);
    meta.child_pid = Number.isInteger(pid) ? pid : null;
    meta.child_pgid = Number.isInteger(pid) ? pid : null;
    meta.child_start = Number.isInteger(pid) ? runs.processStartToken(pid) : null;
    meta.cli_command = invocationArgs.map((argument) => (argument === promptText ? "<prompt>" : argument));
    try {
      runs.writeMeta(runDir, meta);
    } catch {
      // ignore
    }
    proc.stdin.on("error", () => {});
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => {
      try {
        fs.writeSync(stdoutFd, chunk);
      } catch {
        // ignore write errors
      }
      attemptBuffer += chunk;
      try {
        noteStdout(chunk);
      } catch {
        // progress accounting must never break the run
      }
    });
    proc.stderr.on("data", (chunk) => {
      try {
        fs.writeSync(stderrFd, chunk);
      } catch {
        // ignore write errors
      }
      noteOutput();
    });
    proc.on("error", (error) => onAttemptExit(proc, null, null, error));
    proc.on("close", (code, signal) => onAttemptExit(proc, code, signal, null));
    heartbeatPhase = "running";
    progressThrottle.force();
    publishProgress();
  };

  /** Spawn one CLI process. `feed` ends stdin with the prompt (codex); agy keeps it open. */
  const launch = (promptText, feed) => {
    let invocation;
    try {
      invocation = backend.buildInvocation({
        prompt: promptText,
        cwd: meta.cwd,
        sessionId: threadId,
        model: meta.model,
        effort: meta.effort,
        access: meta.access,
      });
    } catch (error) {
      failConversation("Failed to build CLI invocation: " + String((error && error.message) || error));
      return null;
    }
    let proc;
    try {
      proc = spawnCli(meta.cli_path || backend.binaryName, invocation.args, {
        cwd: meta.cwd,
        env: childEnv(meta.cli_path || backend.binaryName),
        detached: process.platform !== "win32",
        stdio: [invocation.stdin === "ignore" ? "ignore" : "pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      failConversation("Failed to start CLI: " + String((error && error.message) || error));
      return null;
    }
    wireAttempt(proc, invocation.args, promptText);
    if (feed) {
      try {
        proc.stdin.end(promptText.endsWith("\n") ? promptText : promptText + "\n");
      } catch {
        // CLI may have exited already
      }
    }
    return proc;
  };

  /** Deliver one queued message to the backend. */
  const sendTurn = (entry) => {
    if (!chatEnabled || settled) return;
    if (chatMode === "stdin") {
      try {
        child.stdin.write(chat.buildUserMessage(entry.text));
      } catch {
        // EPIPE: the process is gone, its exit handler takes over
      }
      return;
    }
    launch(entry.text, true);
  };

  const finalizeConversation = async (state, error, extra = {}) => {
    if (settled) return;
    settled = true;
    if (inboxTimer) {
      clearInterval(inboxTimer);
      inboxTimer = null;
    }
    if (session && !session.closed) session.close("run finalized");
    if (graceTimer) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }
    if (session) session.clearGrace();
    try {
      fs.closeSync(stdoutFd);
    } catch {
      // ignore
    }
    try {
      fs.closeSync(stderrFd);
    } catch {
      // ignore
    }
    const turns = session ? session.turns : [];
    const lastTurn = turns.length > 0 ? turns[turns.length - 1] : null;
    // Match the child-exit path: cancelled/timed_out runs do not report a reply.
    const reply =
      state === "cancelled" || state === "timed_out"
        ? ""
        : lastTurn && typeof lastTurn.reply === "string"
          ? lastTurn.reply
          : "";
    runs.writeFileAtomic(paths.reply, reply, 0o600);
    const stored = finalize({
      state,
      reply,
      exit_code: extra.exit_code === undefined ? null : extra.exit_code,
      error: error || null,
      session_id: threadId || meta.session_id || null,
      usage: lastTurn && lastTurn.usage ? lastTurn.usage : null,
      turns,
      chat: chatEnabled,
      started_at: meta.started_at || startedAt,
      ended_at: new Date().toISOString(),
    });
    log("run " + runId + " finished: " + ((stored && stored.state) || state));
    await closeActiveViewer();
  };

  const failConversation = (error, extra = {}) => {
    if (settled) return;
    log("conversation failed: " + error);
    void finalizeConversation("failed", error, extra);
  };

  const doneConversation = (reason) => {
    if (terminating || settled) return;
    log("conversation finished: " + reason);
    if (chatMode === "stdin") {
      // agy: closing stdin lets the process exit; the close handler finalizes
      // (and maps the last result's status into the run state).
      try {
        child.stdin.end();
      } catch {
        // child may already be gone
      }
      return;
    }
    // codex: no process is alive between turns, so finalize here. A failed last
    // turn means the run failed, even though the process exit code says nothing.
    const turns = session.turns;
    const last = turns.length > 0 ? turns[turns.length - 1] : null;
    if (last && last.status && last.status !== "SUCCESS") {
      void finalizeConversation("failed", last.error || "the last turn failed", { exit_code: lastExitCode });
      return;
    }
    void finalizeConversation("completed", null, { exit_code: lastExitCode });
  };

  const onAttemptExit = (proc, code, signal, spawnError) => {
    if (proc !== child) return; // a stale attempt (never expected, but harmless)
    if (settled) return;
    if (chatMode !== "resume") {
      finish(code, signal, spawnError);
      return;
    }
    if (spawnError) {
      failConversation("Failed to start CLI: " + String((spawnError && spawnError.message) || spawnError));
      return;
    }
    lastExitCode = code;
    // A cancel request may reach the CLI before this runner's poll loop notices
    // it; record the terminal state instead of turning it into a failed turn.
    if (terminating || cancelled || timedOut || runs.hasCancelRequest(runDir)) {
      if (!terminating) terminating = runs.hasCancelRequest(runDir) ? "cancel" : "terminate";
      finish(code, signal, null);
      return;
    }
    const parsed = backend.parseOutput({
      stdout: attemptBuffer,
      stderr: runs.readText(paths.stderr) || "",
      exitCode: code === null ? 1 : code,
    });
    if (parsed.sessionId) threadId = parsed.sessionId;
    session.completeTurn({
      reply: parsed.reply || "",
      status: parsed.state === "completed" ? "SUCCESS" : "FAILED",
      duration_s: Math.round((Date.now() - attemptStartedAt) / 10) / 100,
      usage: parsed.usage || null,
      error: parsed.error || null,
    });
  };

  const startInboxFollower = () => {
    try {
      // Create only when missing: <p>_say / the viewer may have queued a message
      // between run creation and this process starting.
      if (!fs.existsSync(paths.inbox)) runs.writeFileAtomic(paths.inbox, "", 0o600);
    } catch {
      // an append-only inbox that cannot be created just means no injected input
    }
    const follower = chat.createLineFollower(paths.inbox);
    const drain = () => {
      for (const line of follower.read()) {
        if (session.closed) break; // no receiver left; never claim it was delivered
        const entry = chat.parseInboxLine(line);
        if (!entry) continue;
        if (!session.canAccept()) {
          // The window disables its input at the cap; a direct append (or a race)
          // is refused here instead of being written to the CLI.
          writeRejectedEvent(entry, "max_turns_reached");
          log("rejected " + entry.source + " message: max turns reached");
          break;
        }
        writeInjectedEvent(entry);
        if (!session.enqueue(entry)) break;
        log("queued " + entry.source + " message (" + entry.text.length + " chars)");
      }
    };
    drain();
    const timer = setInterval(drain, chat.INBOX_POLL_MS);
    if (timer.unref) timer.unref();
    return timer;
  };

  const beginTermination = (reason) => {
    if (reason === "cancel" && !cancelled) cancelled = true;
    if (reason === "timeout" && !timedOut) timedOut = true;
    terminating = terminating || reason;
    if (session && !session.closed) session.close(reason === "cancel" ? "cancelled by user" : "timed out");
    if (session) session.clearGrace();
    if (child && child.exitCode === null && child.signalCode === null) {
      killGroup("SIGTERM");
      if (!graceTimer) {
        graceTimer = setTimeout(() => {
          graceTimer = null;
          try {
            killGroup("SIGKILL");
          } catch {
            // ignore
          }
        }, KILL_GRACE_MS);
      }
    } else if (!settled) {
      // No live process (codex between turns): there is nothing to kill.
      void finalizeConversation(
        reason === "cancel" ? "cancelled" : "timed_out",
        reason === "cancel" ? "cancelled by user" : "Timed out after " + timeoutSeconds + "s",
      );
    }
    if (!cancelPollTimer) {
      cancelPollTimer = setInterval(() => {
        if (settled) return;
        if (runs.hasCancelRequest(runDir) && !cancelled) {
          cancelled = true;
          terminating = terminating || "cancel";
          if (child && runs.isChildStillOurs(meta)) killGroup("SIGTERM");
        }
      }, CANCEL_POLL_MS);
    }
  };

  const timeoutSeconds = Number(meta.timeout_s) || 3600;
  timeoutTimer = setTimeout(() => {
    timeoutTimer = null;
    if (settled) return;
    log("run " + runId + " exceeded timeout of " + timeoutSeconds + "s");
    beginTermination("timeout");
  }, timeoutSeconds * 1000);

  cancelPollTimer = setInterval(() => {
    if (settled) return;
    if (runs.hasCancelRequest(runDir) && !cancelled) beginTermination("cancel");
  }, CANCEL_POLL_MS);

  // --- start the conversation ---------------------------------------------
  if (chatMode === "stdin") {
    // agy: one long-lived process; the prompt is the first stdin message.
    child = launch("", false);
  }
  if (chatEnabled) {
    session.enqueue({ text: prompt, at: new Date().toISOString(), source: "caller" });
    inboxTimer = startInboxFollower();
  } else {
    child = launch(prompt, true);
  }

  const finish = async (exitCode, exitSignal, spawnError) => {
    if (settled) return;
    settled = true;
    if (inboxTimer) clearInterval(inboxTimer);
    clearInterval(heartbeatTimer);
    clearInterval(cancelPollTimer);
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (graceTimer) clearTimeout(graceTimer);
    if (session) session.clearGrace();
    // The CLI is gone: a half-written line can no longer be completed, so make
    // sure pending injection records still reach stdout.jsonl (on their own line).
    if (deferredInjected.length > 0 && writeInjectedRaw) {
      try {
        if (progress.pending_line !== "") {
          fs.writeSync(stdoutFd, "\n");
          progress.pending_line = "";
        }
        while (deferredInjected.length > 0) writeInjectedRaw(deferredInjected.shift());
      } catch {
        // best effort
      }
    }
    try {
      fs.closeSync(stdoutFd);
    } catch {
      // ignore
    }
    try {
      fs.closeSync(stderrFd);
    } catch {
      // ignore
    }

    const stdout = runs.readText(paths.stdout) || "";
    const stderr = runs.readText(paths.stderr) || "";
    const endedAt = new Date().toISOString();
    const cancelRequested = cancelled || runs.hasCancelRequest(runDir);
    const turns = session ? session.turns : [];
    const lastTurn = turns.length > 0 ? turns[turns.length - 1] : null;

    let patch;
    if (spawnError) {
      patch = {
        state: "failed",
        reply: "",
        exit_code: null,
        error: "Failed to start CLI: " + String((spawnError && spawnError.message) || spawnError),
      };
    } else if (cancelRequested) {
      patch = { state: "cancelled", reply: "", exit_code: exitCode, error: "cancelled by user" };
    } else if (timedOut) {
      patch = {
        state: "timed_out",
        reply: "",
        exit_code: exitCode,
        error: "Timed out after " + timeoutSeconds + "s",
      };
    } else {
      const parsed = backend.parseOutput({ stdout, stderr, exitCode: exitCode === null ? 1 : exitCode });
      let state = parsed.state;
      let error = parsed.error || null;
      if (exitSignal && (!error || state === "completed")) {
        state = "failed";
        error = error || "CLI terminated by signal " + exitSignal;
      }
      patch = {
        state,
        reply: lastTurn ? lastTurn.reply : parsed.reply || "",
        exit_code: exitCode,
        error,
        session_id: parsed.sessionId || threadId || meta.session_id || null,
        usage: (lastTurn && lastTurn.usage) || parsed.usage || null,
      };
    }

    patch.turns = turns;
    patch.chat = chatEnabled;

    // Final progress flush so a completed run reports its last stdout stats.
    if (trailingTimer) {
      clearTimeout(trailingTimer);
      trailingTimer = null;
    }
    progressThrottle.force();
    publishProgress();
    runs.writeFileAtomic(paths.reply, patch.reply || "", 0o600);
    const stored = finalize({
      ...patch,
      started_at: meta.started_at || startedAt,
      ended_at: endedAt,
    });
    log("run " + runId + " finished: " + ((stored && stored.state) || patch.state));
    // Terminal state is already on disk, so the viewer will exit by itself; wait
    // for it (max ~3s) and only then close its window. Best effort throughout.
    await closeActiveViewer();
  };

  // Live viewer window (macOS only, CLI_BATON_VIEWER=0 disables it). Opened only
  // after the exit handlers are wired: a CLI that dies while osascript is
  // starting would otherwise emit "close" before anyone listens and the run
  // would never be finalized. Strictly best effort: viewer failures cannot fail
  // or change the run.
  try {
    const viewer = createViewerBridge({
      runDir,
      backend: backendName,
      runId,
      env: process.env,
    });
    activeViewer = viewer;
    const opened = await viewer.open();
    // Nobody can type into a window that never appeared: do not make the run sit
    // through the chat grace period waiting for input.
    if (chatEnabled && (!opened || opened.opened !== true) && session.policy.enabled) {
      log("viewer unavailable (" + ((opened && opened.reason) || "unknown") + "); chat grace disabled");
      session.setPolicy({ ...session.policy, enabled: false });
    }
  } catch (error) {
    log("viewer open failed (ignored): " + String((error && error.message) || error));
    activeViewer = null;
    if (chatEnabled && session.policy.enabled) session.setPolicy({ ...session.policy, enabled: false });
  }
  // The run may have finished while the window was opening: never leave an
  // orphan window behind for a run that is already terminal.
  if (settled) await closeActiveViewer();
}

main().catch(async (error) => {
  log("runner crashed: " + (error && error.stack ? error.stack : error));
  await closeActiveViewer();
  process.exit(1);
});
