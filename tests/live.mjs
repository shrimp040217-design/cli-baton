#!/usr/bin/env node
/**
 * cli-baton live smoke test — real CLI end-to-end checks over a real MCP stdio server.
 *
 * This test is NOT a unit test: it starts the actual MCP server, lets it launch the
 * real agy / codex CLIs, and therefore consumes real model quota. Run it manually:
 *
 *   node tests/live.mjs                 # both backends (agy, then codex)
 *   node tests/live.mjs --backend agy   # only agy
 *   node tests/live.mjs --backend codex # only codex
 *
 * Zero dependencies, Node ESM, builtins only. It does not import anything from src/.
 * Each case has a hard 180s deadline; resume-memory gets 2x180s because it makes two
 * sequential CLI invocations (each invocation itself stays bounded by RUN_TIMEOUT_S and
 * the per-invocation polling logic). A failure never aborts the remaining cases.
 * Exit code: 0 = all PASS, 1 = at least one FAIL, 2 = usage/setup error.
 *
 * Notes:
 * - The MCP server is launched with a throwaway temp CLI_BATON_HOME; the real env is
 *   inherited (proxy settings etc. are passed through). Environment values are never
 *   printed by this script.
 * - The first codex call can take ~100s (observed), so _wait is polled in generous
 *   slices and a timed_out wait simply continues polling within the case deadline.
 * - Every send passes timeout_s: 150, so a hung CLI (e.g. offline agy) is killed by
 *   the runner before the 180s case deadline; when a case fails, any runs it created
 *   are cancelled best-effort so CLI processes do not pile up.
 * - If a backend CLI cannot actually run (missing binary, offline/network-blocked agy),
 *   every case for that backend FAILs within the 180s case deadline instead of hanging
 *   the suite. Use --backend to test one backend at a time.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Constants / tiny utilities
// ---------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const SERVER_PATH = path.join(REPO_ROOT, "src", "server.mjs");

const PROTOCOL_VERSION = "2025-06-18";
const CASE_TIMEOUT_MS = 180_000; // hard per-case deadline
// resume-memory performs two sequential real CLI invocations (plant + recall), so it
// gets two per-invocation budgets; every other case keeps the single 180s deadline.
const TWO_RUN_CASE_TIMEOUT_MS = CASE_TIMEOUT_MS * 2;
const SERVER_NAMES = { agy: "agy-baton", codex: "codex-baton" };
const TERMINAL_STATES = new Set(["completed", "failed", "cancelled", "timed_out", "interrupted"]);

// Every send passes timeout_s: 150 so a hung CLI (e.g. offline agy) is killed by the
// runner at ~150s, before the 180s case deadline. Failure cleanup also cancels any
// runs the case created.
const RUN_TIMEOUT_S = 150;
const WAIT_SLICE_MAX_S = 150; // _wait timeout_s cap used while polling
const WAIT_SLICE_MARGIN_MS = 10_000; // stop polling this long before the case deadline
const CANCEL_DEADLINE_MS = 15_000; // "state cancelled within ~15s" after _cancel

// Every temp dir we create is registered here and removed at the end (best effort).
const CLEANUP_DIRS = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function truncate(value, max) {
  const text = String(value ?? "");
  return text.length <= max ? text : text.slice(0, max) + "…(" + text.length + " chars)";
}

// Mirrors the product redaction rules: never echo credentials, even if a backend or
// the server writes them to stderr accidentally.
function redact(value) {
  return String(value ?? "")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/\=-]{4,}/gi, "$1<redacted>")
    .replace(/sk-[A-Za-z0-9._-]{6,}/g, "sk-<redacted>")
    .replace(/((?:api[_-]?key|token|secret|password|passwd|credential)s?["']?\s*[=:]\s*)(["']?)[^\s"',;]+/gi, "$1$2<redacted>");
}

function formatDuration(ms) {
  return (ms / 1000).toFixed(1) + "s";
}

function usage() {
  return [
    "Usage: node tests/live.mjs [--backend agy|codex]",
    "",
    "  (no --backend)   run both backends, agy then codex",
    "  --backend agy    agy only",
    "  --backend codex  codex only",
    "  -h, --help       show this help",
    "",
    "Live test: consumes real model quota. Case deadline is " + CASE_TIMEOUT_MS / 1000 + "s.",
  ].join("\n");
}

function parseArgs(argv) {
  const backends = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") return { help: true, backends };
    if (arg === "--backend") {
      const value = argv[i + 1];
      if (!value) throw new Error("--backend requires a value (agy or codex)");
      i += 1;
      pushBackend(backends, value);
      continue;
    }
    if (arg.startsWith("--backend=")) {
      pushBackend(backends, arg.slice("--backend=".length));
      continue;
    }
    throw new Error("unknown argument: " + arg);
  }
  return { help: false, backends: backends.length > 0 ? unique(backends) : ["agy", "codex"] };
}

function pushBackend(backends, value) {
  if (value === "both") {
    backends.push("agy", "codex");
    return;
  }
  if (value !== "agy" && value !== "codex") {
    throw new Error("invalid --backend value " + JSON.stringify(value) + " (expected agy, codex, or both)");
  }
  backends.push(value);
}

function unique(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Minimal MCP stdio client (newline-delimited JSON-RPC)
// ---------------------------------------------------------------------------

class McpClient {
  constructor({ backend, env }) {
    this.backend = backend;
    this.env = env;
    this.child = null;
    this.pending = new Map();
    this._nextId = 1;
    this._stdoutBuf = "";
    this._stderr = "";
    this._closed = false;
    this._closePromise = null;
    this._exited = null;
  }

  start() {
    const child = spawn(process.execPath, [SERVER_PATH, "--backend", this.backend], {
      cwd: REPO_ROOT,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this._exited = new Promise((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this._onStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      this._stderr = (this._stderr + chunk).slice(-8000);
    });
    child.on("error", (err) => {
      this._closed = true;
      this._failAll(new Error("MCP server process error: " + err.message));
    });
    child.on("exit", (code, signal) => {
      this._closed = true;
      this._failAll(
        new Error(
          "MCP server exited (code=" + (code ?? "null") + ", signal=" + (signal ?? "null") + ")" + this._stderrTail(),
        ),
      );
    });
    // EPIPE surfaces through the pending request / exit handlers; don't crash on it.
    child.stdin.on("error", () => {});
  }

  get closed() {
    return this._closed;
  }

  _stderrTail() {
    const text = redact(this._stderr).trim();
    return text ? "; stderr tail: " + text.slice(-600) : "";
  }

  _onStdout(chunk) {
    this._stdoutBuf += chunk;
    let newline = this._stdoutBuf.indexOf("\n");
    while (newline !== -1) {
      const line = this._stdoutBuf.slice(0, newline).trim();
      this._stdoutBuf = this._stdoutBuf.slice(newline + 1);
      newline = this._stdoutBuf.indexOf("\n");
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue; // stdout should only carry JSON-RPC, but never crash the harness on noise
      }
      if (!message || typeof message !== "object" || message.id === undefined) continue;
      const waiter = this.pending.get(message.id);
      if (!waiter) continue;
      this.pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) {
        waiter.reject(
          new Error("JSON-RPC error " + (message.error.code ?? "?") + ": " + (message.error.message ?? JSON.stringify(message.error))),
        );
      } else {
        waiter.resolve(message.result);
      }
    }
  }

  _failAll(error) {
    for (const [id, waiter] of this.pending) {
      this.pending.delete(id);
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  request(method, params, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      if (this._closed || !this.child) {
        reject(new Error("MCP client is closed (cannot send " + method + ")"));
        return;
      }
      const id = this._nextId;
      this._nextId += 1;
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(method + " timed out after " + formatDuration(timeoutMs)));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new Error("failed to write " + method + ": " + err.message));
      }
    });
  }

  notify(method, params) {
    if (this._closed || !this.child) return;
    const message = { jsonrpc: "2.0", method };
    if (params !== undefined) message.params = params;
    try {
      this.child.stdin.write(JSON.stringify(message) + "\n");
    } catch {
      /* the request path will surface any real problem */
    }
  }

  async initialize() {
    const result = await this.request(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "cli-baton-live", version: "1.0.0" },
      },
      20_000,
    );
    assert(result && typeof result === "object", "initialize: empty result");
    assert(
      result.protocolVersion === PROTOCOL_VERSION,
      "initialize: protocolVersion=" + JSON.stringify(result.protocolVersion) + " expected " + JSON.stringify(PROTOCOL_VERSION),
    );
    const expectedName = SERVER_NAMES[this.backend];
    assert(
      result.serverInfo && result.serverInfo.name === expectedName,
      "initialize: serverInfo.name=" + JSON.stringify(result.serverInfo && result.serverInfo.name) + " expected " + JSON.stringify(expectedName),
    );
    this.notify("notifications/initialized");
    return result;
  }

  async callTool(name, args, timeoutMs = 30_000) {
    const result = await this.request("tools/call", { name, arguments: args }, timeoutMs);
    assert(result && typeof result === "object", "tools/call " + name + ": empty result");
    const content = Array.isArray(result.content) ? result.content : [];
    const textPart = content.find((part) => part && part.type === "text" && typeof part.text === "string");
    const text = textPart ? textPart.text : "";
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      throw new Error("tools/call " + name + ": result text is not JSON: " + truncate(redact(text), 300));
    }
    if (result.isError === true) {
      const message =
        data && typeof data === "object" && typeof data.message === "string" ? data.message : text || "unknown error";
      throw new Error("tools/call " + name + " returned isError: " + truncate(redact(message), 400));
    }
    assert(data && typeof data === "object", "tools/call " + name + ": result JSON is not an object");
    return data;
  }

  close() {
    if (this._closePromise) return this._closePromise;
    this._closePromise = (async () => {
      if (!this.child) return;
      this._closed = true;
      try {
        this.child.stdin.end();
      } catch {
        /* already gone */
      }
      if (this._exited) {
        const graceful = await Promise.race([this._exited.then(() => true), sleep(3000).then(() => false)]);
        if (!graceful) {
          try {
            this.child.kill("SIGKILL");
          } catch {
            /* already gone */
          }
          await Promise.race([this._exited, sleep(1500)]);
        }
      }
      this._failAll(new Error("MCP client closed"));
    })();
    return this._closePromise;
  }
}

// ---------------------------------------------------------------------------
// Shared run helpers
// ---------------------------------------------------------------------------

async function waitForTerminal(client, backend, runId, ctx) {
  let last = null;
  for (;;) {
    const remainingMs = ctx.remainingMs();
    if (remainingMs <= 12_000) {
      throw new Error(
        "case budget exhausted while waiting for run " + runId + " (last state=" + (last && last.state ? last.state : "unknown") + ")",
      );
    }
    const waitS = Math.max(5, Math.min(WAIT_SLICE_MAX_S, Math.floor((remainingMs - WAIT_SLICE_MARGIN_MS) / 1000)));
    last = await client.callTool(backend + "_wait", { run_id: runId, timeout_s: waitS }, (waitS + 25) * 1000);
    if (TERMINAL_STATES.has(last.state)) return last;
    await sleep(500); // non-terminal and not timed_out: poll again
  }
}

async function sendRun(client, backend, args, ctx) {
  const sent = await client.callTool(backend + "_send", args, 30_000);
  assert(typeof sent.run_id === "string" && sent.run_id.length > 0, "send: missing run_id: " + truncate(JSON.stringify(sent), 200));
  assert(sent.backend === backend, "send: backend=" + JSON.stringify(sent.backend) + " expected " + JSON.stringify(backend));
  assert(typeof sent.run_dir === "string" && sent.run_dir.length > 0, "send: missing run_dir");
  ctx.runDirs.push(sent.run_dir);
  if (typeof sent.run_id === "string") ctx.runIds.push(sent.run_id);
  return sent;
}

// Do not leak CLI processes when a case fails: ask the server to cancel every run the
// case created (cancel is bounded: SIGTERM, ~5s grace, SIGKILL). Best effort only.
async function cancelRunsBestEffort(clients, backend, runIds) {
  const client = clients[clients.length - 1];
  if (!client || client.closed) return;
  const pending = unique(runIds);
  if (pending.length === 0) return;
  const tasks = pending.map(async (runId) => {
    try {
      await client.callTool(backend + "_cancel", { run_id: runId }, 12_000);
    } catch {
      /* best effort: server may already be gone */
    }
  });
  await Promise.race([Promise.allSettled(tasks), sleep(10_000)]);
}

function assertCompleted(done, label) {
  assert(
    done.state === "completed",
    label + ": expected state=completed, got state=" + JSON.stringify(done.state) +
      (done.error ? " (error=" + truncate(redact(String(done.error)), 300) + ")" : ""),
  );
}

function replyText(done) {
  return typeof done.reply === "string" ? done.reply : "";
}

// ---------------------------------------------------------------------------
// Cases (one per required scenario; each runs for every backend)
// ---------------------------------------------------------------------------

async function caseSendWait(client, backend, ctx) {
  const cwd = ctx.makeWorkDir();
  const sent = await sendRun(
    client,
    backend,
    { message: "Reply with exactly: LIVE_OK", cwd, timeout_s: RUN_TIMEOUT_S },
    ctx,
  );
  assert(typeof sent.state === "string" && sent.state.length > 0, "send: missing state");
  const done = await waitForTerminal(client, backend, sent.run_id, ctx);
  assertCompleted(done, "send-wait");
  assert(
    replyText(done).includes("LIVE_OK"),
    "reply does not contain LIVE_OK: " + truncate(redact(replyText(done)), 300),
  );
  assert(typeof done.session_id === "string" && done.session_id.length > 0, "session_id is empty");
}

async function caseResumeMemory(client, backend, ctx) {
  const cwd = ctx.makeWorkDir();
  const first = await sendRun(
    client,
    backend,
    { message: "Remember the word BANANA. Reply OK.", cwd, timeout_s: RUN_TIMEOUT_S },
    ctx,
  );
  const firstDone = await waitForTerminal(client, backend, first.run_id, ctx);
  assertCompleted(firstDone, "resume-memory (first run)");
  assert(
    typeof firstDone.session_id === "string" && firstDone.session_id.length > 0,
    "first run: session_id is empty (cannot resume)",
  );

  const second = await sendRun(
    client,
    backend,
    {
      message: "What word did I ask you to remember? Answer with just that word.",
      cwd,
      session_id: firstDone.session_id,
      timeout_s: RUN_TIMEOUT_S,
    },
    ctx,
  );
  const secondDone = await waitForTerminal(client, backend, second.run_id, ctx);
  assertCompleted(secondDone, "resume-memory (second run)");
  assert(
    replyText(secondDone).includes("BANANA"),
    "resumed session reply does not contain BANANA: " + truncate(redact(replyText(secondDone)), 300),
  );
}

async function caseReadOnly(client, backend, ctx) {
  const cwd = ctx.makeWorkDir();
  const target = path.join(cwd, "readonly-check.txt");
  const sent = await sendRun(
    client,
    backend,
    {
      message: "Create a file named readonly-check.txt in the current directory containing the text X. Reply DONE when done.",
      cwd,
      access: "read-only",
      timeout_s: RUN_TIMEOUT_S,
    },
    ctx,
  );
  const done = await waitForTerminal(client, backend, sent.run_id, ctx);
  assertCompleted(done, "read-only");
  await sleep(1000); // give a stray write a moment to land before asserting
  assert(!existsSync(target), "read-only run created " + target + " (sandbox did not block writes)");
}

async function caseFull(client, backend, ctx) {
  const cwd = ctx.makeWorkDir();
  const target = path.join(cwd, "full-check.txt");
  const sent = await sendRun(
    client,
    backend,
    {
      message: "Create a file named full-check.txt in the current directory containing the text X. Reply DONE when done.",
      cwd,
      access: "full",
      timeout_s: RUN_TIMEOUT_S,
    },
    ctx,
  );
  const done = await waitForTerminal(client, backend, sent.run_id, ctx);
  assertCompleted(done, "full");
  assert(existsSync(target), "full run did not create " + target);
}

async function caseCancel(client, backend, ctx) {
  const cwd = ctx.makeWorkDir();
  const sent = await sendRun(
    client,
    backend,
    {
      message: "Run the shell command: sleep 120 - then reply DONE",
      cwd,
      access: "full",
      timeout_s: RUN_TIMEOUT_S,
    },
    ctx,
  );
  await sleep(5_000); // let the run actually start before cancelling

  const cancelStartedAt = Date.now();
  let state = await client.callTool(backend + "_cancel", { run_id: sent.run_id }, 30_000);
  while (!TERMINAL_STATES.has(state.state) && Date.now() - cancelStartedAt < CANCEL_DEADLINE_MS) {
    await sleep(500);
    state = await client.callTool(backend + "_status", { run_id: sent.run_id, tail: 5 }, 20_000);
  }
  assert(
    state.state === "cancelled",
    "expected state=cancelled, got state=" + JSON.stringify(state.state) + " after " + formatDuration(Date.now() - cancelStartedAt),
  );
}

async function caseLeadingDash(client, backend, ctx) {
  const cwd = ctx.makeWorkDir();
  const sent = await sendRun(
    client,
    backend,
    { message: "- reply with exactly DASH_OK", cwd, timeout_s: RUN_TIMEOUT_S },
    ctx,
  );
  const done = await waitForTerminal(client, backend, sent.run_id, ctx);
  assertCompleted(done, "leading-dash");
  assert(
    replyText(done).includes("DASH_OK"),
    "reply does not contain DASH_OK: " + truncate(redact(replyText(done)), 300),
  );
}

const CASES = [
  ["send-wait", caseSendWait],
  ["resume-memory", caseResumeMemory],
  ["read-only", caseReadOnly],
  ["full", caseFull],
  ["cancel", caseCancel],
  ["leading-dash", caseLeadingDash],
];

// ---------------------------------------------------------------------------
// Case runner
// ---------------------------------------------------------------------------

async function runCase(backend, name, fn, env) {
  const startedAt = Date.now();
  const caseDeadlineMs = name === "resume-memory" ? TWO_RUN_CASE_TIMEOUT_MS : CASE_TIMEOUT_MS;
  const clients = [];
  const runDirs = [];
  const ctx = {
    backend,
    startedAt,
    remainingMs: () => caseDeadlineMs - (Date.now() - startedAt),
    runDirs,
    runIds: [],
    makeWorkDir() {
      const dir = mkdtempSync(path.join(tmpdir(), "cli-baton-live-" + backend + "-"));
      CLEANUP_DIRS.push(dir);
      return dir;
    },
  };

  const work = (async () => {
    const client = new McpClient({ backend, env });
    clients.push(client);
    client.start();
    await client.initialize();
    await fn(client, backend, ctx);
  })();
  work.catch(() => {}); // never let a lost race become an unhandled rejection

  let failure = null;
  let hardTimer = null;
  try {
    await Promise.race([
      work,
      new Promise((_, reject) => {
        hardTimer = setTimeout(
          () => reject(new Error("case hard timeout after " + caseDeadlineMs / 1000 + "s")),
          caseDeadlineMs,
        );
      }),
    ]);
  } catch (err) {
    failure = err instanceof Error ? err : new Error(String(err));
  } finally {
    clearTimeout(hardTimer);
    if (failure) {
      // Never leave a hung/slow CLI behind after a failed case.
      await cancelRunsBestEffort(clients, backend, ctx.runIds).catch(() => {});
    }
    await Promise.all(clients.map((client) => client.close().catch(() => {})));
  }

  const durationMs = Date.now() - startedAt;
  const label = backend + " " + name;
  if (failure) {
    const reason = truncate(redact(failure.message || String(failure)), 700);
    console.log("FAIL " + label + " (" + formatDuration(durationMs) + "): " + reason);
    for (const runDir of unique(runDirs)) console.log("  run_dir: " + runDir);
  } else {
    console.log("PASS " + label + " (" + formatDuration(durationMs) + ")");
  }
  return { backend, name, ok: failure === null, durationMs };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function printSummary(results) {
  console.log("");
  console.log("=== summary ===");
  const labels = results.map((r) => r.backend + " " + r.name);
  const labelWidth = Math.max(4, ...labels.map((label) => label.length));
  console.log("CASE".padEnd(labelWidth) + "  RESULT  DURATION");
  console.log("-".repeat(labelWidth + 20));
  for (let i = 0; i < results.length; i += 1) {
    const result = results[i];
    console.log(
      labels[i].padEnd(labelWidth) + "  " + (result.ok ? "PASS" : "FAIL").padEnd(6) + "  " + formatDuration(result.durationMs),
    );
  }
  const failed = results.filter((result) => !result.ok);
  console.log("");
  console.log(results.length - failed.length + "/" + results.length + " passed, " + failed.length + " failed");
  return failed.length;
}

async function main() {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (!Number.isFinite(nodeMajor) || nodeMajor < 18) {
    console.error("ERROR: Node.js >= 18 is required (current: " + process.versions.node + ")");
    return 2;
  }

  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error("ERROR: " + err.message);
    console.error("");
    console.error(usage());
    return 2;
  }
  if (options.help) {
    console.log(usage());
    return 0;
  }

  if (!existsSync(SERVER_PATH)) {
    console.error("ERROR: MCP server entry not found: " + SERVER_PATH);
    return 2;
  }

  console.log("cli-baton live smoke test (real CLI + real MCP stdio server)");
  console.log("server:   " + SERVER_PATH);
  console.log("backends: " + options.backends.join(", "));
  console.log("case deadline: " + CASE_TIMEOUT_MS / 1000 + "s (resume-memory: " + TWO_RUN_CASE_TIMEOUT_MS / 1000 + "s for two sequential CLI calls) | this test consumes real model quota");
  console.log("note: the first codex call can take ~100s; _wait is polled in slices until the case deadline.");
  console.log("");

  const homeDir = mkdtempSync(path.join(tmpdir(), "cli-baton-live-home-"));
  CLEANUP_DIRS.push(homeDir);
  // Inherit the real environment (proxy, PATH, ...); only redirect storage.
  const env = {
  ...process.env,
  CLI_BATON_HOME: homeDir,
  // Manual smoke test: no Terminal windows, and no chat grace wait between turns.
  CLI_BATON_VIEWER: "0",
  CLI_BATON_CHAT_GRACE_S: "0",
};

  const results = [];
  try {
    for (const backend of options.backends) {
      for (const [name, fn] of CASES) {
        results.push(await runCase(backend, name, fn, env));
      }
    }
  } finally {
    for (const dir of CLEANUP_DIRS) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort: a detached runner may still be finishing */
      }
    }
  }

  return printSummary(results) === 0 ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error("ERROR: " + truncate(redact(err && err.stack ? err.stack : String(err)), 1000));
    process.exitCode = 2;
  });
