#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import * as runs from "./runs.mjs";
import { getBackend } from "./backends/index.mjs";

const HEARTBEAT_INTERVAL_MS = 2000;
const CANCEL_POLL_MS = 500;
const KILL_GRACE_MS = 5000;

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
  runs.writeHeartbeat(runDir, { phase: "starting" });
  const heartbeatTimer = setInterval(() => {
    try {
      runs.writeHeartbeat(runDir, { phase: "running", child_pid: meta.child_pid || null });
    } catch {
      // keep supervising even if heartbeat write fails
    }
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

  let child;
  try {
    child = spawnCli(meta.cli_path || backend.binaryName, invocation.args, {
      cwd: meta.cwd,
      env: childEnv(meta.cli_path || backend.binaryName),
      detached: process.platform !== "win32",
      stdio: [invocation.stdin === "prompt" ? "pipe" : "ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
    runs.writeFileAtomic(paths.reply, "", 0o600);
    finalize({
      state: "failed",
      reply: "",
      exit_code: null,
      error: "Failed to start CLI: " + (error && error.message),
      started_at: startedAt,
      ended_at: new Date().toISOString(),
    });
    return;
  }

  const childPid = Number(child.pid);
  const childPgid = process.platform === "win32" ? childPid : childPid;
  meta.child_pid = Number.isInteger(childPid) ? childPid : null;
  meta.child_pgid = Number.isInteger(childPgid) ? childPgid : null;
  meta.cli_command = invocation.args.map((argument) => (argument === prompt ? "<prompt>" : argument));
  runs.writeMeta(runDir, meta);
  runs.writeHeartbeat(runDir, { phase: "running", child_pid: meta.child_pid });

  let cancelled = false;
  let timedOut = false;
  let settled = false;

  const killGroup = (signal) => {
    if (meta.child_pgid) runs.signalProcessGroup(meta.child_pgid, signal);
    try {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    } catch {
      // already gone
    }
  };

  const beginTermination = (reason) => {
    if (reason === "cancel" && !cancelled) cancelled = true;
    if (reason === "timeout" && !timedOut) timedOut = true;
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
    if (!cancelPollTimer) {
      cancelPollTimer = setInterval(() => {
        if (settled) return;
        if (runs.hasCancelRequest(runDir) && !cancelled) {
          cancelled = true;
          killGroup("SIGTERM");
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

  if (invocation.stdin === "prompt") {
    // A CLI that exits before reading stdin raises EPIPE asynchronously; the exit
    // handler still records its failure, so the supervisor must survive this.
    child.stdin.on("error", () => {});
    try {
      child.stdin.end(prompt.endsWith("\n") ? prompt : prompt + "\n");
    } catch {
      // CLI may have exited already
    }
  }

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    try {
      fs.writeSync(stdoutFd, chunk);
    } catch {
      // ignore write errors
    }
  });
  child.stderr.on("data", (chunk) => {
    try {
      fs.writeSync(stderrFd, chunk);
    } catch {
      // ignore write errors
    }
  });

  const finish = async (exitCode, exitSignal, spawnError) => {
    if (settled) return;
    settled = true;
    clearInterval(heartbeatTimer);
    clearInterval(cancelPollTimer);
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (graceTimer) clearTimeout(graceTimer);
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
        reply: parsed.reply || "",
        exit_code: exitCode,
        error,
        session_id: parsed.sessionId || meta.session_id || null,
        usage: parsed.usage || null,
      };
    }

    runs.writeFileAtomic(paths.reply, patch.reply || "", 0o600);
    const stored = finalize({
      ...patch,
      started_at: meta.started_at || startedAt,
      ended_at: endedAt,
    });
    log("run " + runId + " finished: " + ((stored && stored.state) || patch.state));
  };

  child.on("error", (error) => {
    finish(null, null, error);
  });
  child.on("close", (code, signal) => {
    finish(code, signal, null);
  });
}

main().catch((error) => {
  log("runner crashed: " + (error && error.stack ? error.stack : error));
  process.exit(1);
});
