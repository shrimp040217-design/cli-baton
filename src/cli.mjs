#!/usr/bin/env node
/**
 * Command-line helper for cli-baton.
 *
 *   node src/cli.mjs wait --backend <agy|codex|claude> <run_id> [--timeout <sec>] [--stall <sec>] [--home <dir>] [--poll-ms <ms>]
 *   node src/cli.mjs status --backend <agy|codex|claude> <run_id> [--tail <n>] [--home <dir>]
 *
 * `wait` blocks until the run reaches a terminal state (or triggers stall
 * detection), prints the result JSON to stdout, and exits. Clients that wake
 * the model when a background shell command exits (such as Claude Code via
 * Bash `run_in_background: true`, or Antigravity via `run_command` with a short
 * `WaitMsBeforeAsync`) run this command in the background instead of polling.
 *
 * Exit codes for `wait`:
 *   0  completed
 *   1  failed / cancelled / timed_out (run) / interrupted / usage error
 *   2  stalled (run is still active, idle_s > stall_s)
 *   3  wait --timeout elapsed before the run finished
 */
import * as runs from "./runs.mjs";
import { BACKEND_NAMES, getBackend } from "./backends/index.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const USAGE =
  "Usage:\n" +
  "  cli-baton wait --backend <" +
  BACKEND_NAMES.join("|") +
  "> <run_id> [--timeout <sec>] [--stall <sec>] [--home <dir>] [--poll-ms <ms>]\n" +
  "  cli-baton status --backend <" +
  BACKEND_NAMES.join("|") +
  "> <run_id> [--tail <n>] [--home <dir>]\n";

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      flags.help = true;
    } else if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq >= 0) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        flags[arg.slice(2)] = argv[++i];
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

function printJson(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function fail(message, code = 1) {
  printJson({ error: message });
  process.exitCode = code;
}

function resolveEnv(flags) {
  if (flags.home && String(flags.home).trim()) {
    return { ...process.env, CLI_BATON_HOME: String(flags.home).trim() };
  }
  return process.env;
}

function parsePositiveNumber(raw, name) {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("Invalid --" + name + ": expected a positive number");
  }
  return value;
}

async function cmdWait(flags, positional) {
  const backendName = flags.backend;
  if (!backendName || !getBackend(backendName)) {
    return fail("Missing or unknown --backend (expected one of: " + BACKEND_NAMES.join(", ") + ")");
  }
  const runId = flags["run-id"] || positional[0];
  if (!runs.isValidRunId(runId)) {
    return fail("Invalid or missing run_id: expected 24 lowercase hex characters");
  }

  let explicitTimeoutS;
  let explicitStallS;
  let pollMs;
  try {
    explicitTimeoutS = parsePositiveNumber(flags.timeout, "timeout");
    explicitStallS = parsePositiveNumber(flags.stall, "stall");
    pollMs = parsePositiveNumber(flags["poll-ms"], "poll-ms");
  } catch (error) {
    return fail(error.message);
  }
  const intervalMs = pollMs === undefined ? 1000 : Math.max(50, Math.min(10000, Math.round(pollMs)));

  const env = resolveEnv(flags);
  const root = runs.resolveRoot(env);
  let snapshot = runs.getRunSnapshot({ root, backend: backendName, runId, includeReply: false });
  if (!snapshot) {
    return fail("Run not found: " + runId);
  }

  const meta = runs.readMeta(snapshot.run_dir) || {};
  const runTimeoutS = Number(meta.timeout_s) || 3600;
  const waitTimeoutS = explicitTimeoutS !== undefined ? explicitTimeoutS : Math.max(runTimeoutS + 120, 86400);
  const stallS = explicitStallS !== undefined ? explicitStallS : snapshot.stall_s || null;
  const deadline = Date.now() + waitTimeoutS * 1000;

  while (true) {
    if (runs.TERMINAL_STATES.has(snapshot.state)) {
      const full = runs.getRunSnapshot({ root, backend: backendName, runId, includeReply: true }) || snapshot;
      printJson(runs.formatToolPayload(full));
      process.exitCode = full.state === "completed" ? 0 : 1;
      return;
    }

    const waitingForInput = snapshot.grace_remaining_s !== null && snapshot.inflight !== true;
    if (stallS && snapshot.state === "running" && !waitingForInput && Number.isFinite(snapshot.idle_s) && snapshot.idle_s > stallS) {
      const payload = runs.formatToolPayload(snapshot);
      payload.stalled = true;
      payload.stall_s = stallS;
      payload.idle_s = snapshot.idle_s;
      printJson(payload);
      process.exitCode = 2;
      return;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const payload = runs.formatToolPayload(snapshot);
      payload.timed_out = true;
      printJson(payload);
      process.exitCode = 3;
      return;
    }

    await sleep(Math.min(intervalMs, remaining));
    snapshot = runs.getRunSnapshot({ root, backend: backendName, runId, includeReply: false });
    if (!snapshot) {
      return fail("Run disappeared while waiting: " + runId);
    }
  }
}

async function cmdStatus(flags, positional) {
  const backendName = flags.backend;
  if (!backendName || !getBackend(backendName)) {
    return fail("Missing or unknown --backend (expected one of: " + BACKEND_NAMES.join(", ") + ")");
  }
  const runId = flags["run-id"] || positional[0];
  if (!runs.isValidRunId(runId)) {
    return fail("Invalid or missing run_id: expected 24 lowercase hex characters");
  }
  let tail = 5;
  if (flags.tail !== undefined) {
    const parsed = Number(flags.tail);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 50) {
      return fail("Invalid --tail: expected integer between 0 and 50");
    }
    tail = parsed;
  }
  const env = resolveEnv(flags);
  const root = runs.resolveRoot(env);
  const snapshot = runs.getRunSnapshot({ root, backend: backendName, runId, includeReply: true, tail });
  if (!snapshot) {
    return fail("Run not found: " + runId);
  }
  printJson(runs.formatToolPayload(snapshot));
  process.exitCode = 0;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { flags, positional } = parseArgs(rest);
  if (!command || command === "--help" || command === "-h" || flags.help) {
    process.stdout.write(USAGE);
    process.exitCode = 0;
    return;
  }
  if (command === "wait") return cmdWait(flags, positional);
  if (command === "status") return cmdStatus(flags, positional);
  process.stderr.write("Unknown command: " + command + "\n" + USAGE);
  process.exitCode = 1;
}

main().catch((error) => {
  fail(String((error && error.message) || error));
});
