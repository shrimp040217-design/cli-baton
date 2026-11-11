import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = path.resolve(HERE, "..");
export const SERVER_PATH = path.join(REPO_ROOT, "src", "server.mjs");
export const VIEWER_PATH = path.join(REPO_ROOT, "src", "viewer.mjs");
export const FIXTURES_DIR = path.join(HERE, "fixtures");
export const FAKE_AGY = path.join(FIXTURES_DIR, "fake-agy.mjs");
export const FAKE_CODEX = path.join(FIXTURES_DIR, "fake-codex.mjs");
export const FAKE_OSASCRIPT = path.join(FIXTURES_DIR, "fake-osascript.mjs");

export const TERMINAL_STATES = new Set(["completed", "failed", "cancelled", "timed_out", "interrupted"]);
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

for (const fixture of [FAKE_AGY, FAKE_CODEX, FAKE_OSASCRIPT]) {
  try {
    fs.chmodSync(fixture, 0o755);
  } catch {
    // ignore
  }
}

export function makeTmpDir(prefix = "cli-baton-test-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { path: dir, remove: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

export function makeHome() {
  return makeTmpDir("cli-baton-home-");
}

export function makeCwd() {
  return makeTmpDir("cli-baton-cwd-");
}

/**
 * Build an env object for running the MCP server against fake CLIs.
 * backend: "agy" | "codex"
 */
export function fakeEnv({
  backend,
  home,
  logDir,
  mode = "success",
  text,
  sessionId,
  sleepMs,
  replyChars,
  stderr,
  exitCode,
  usage,
  silenceMs,
  chunks,
  chunkMs,
  turnDelayMs,
  halfLineMs,
  graceS,
  extra = {},
}) {
  // Tests never pop up Terminal windows: CLI_BATON_VIEWER=0 is the documented
  // off switch, and individual tests override it to exercise the open path.
  const env = { ...process.env, CLI_BATON_HOME: home, FAKE_LOG_DIR: logDir, FAKE_MODE: mode, CLI_BATON_VIEWER: "0" };
  if (backend === "agy") {
    env.AGY_BIN = FAKE_AGY;
  } else if (backend === "codex") {
    env.CODEX_BIN = FAKE_CODEX;
  } else {
    throw new Error("unsupported backend: " + backend);
  }
  if (text !== undefined) env.FAKE_TEXT = String(text);
  if (sessionId !== undefined) env.FAKE_SESSION_ID = String(sessionId);
  if (sleepMs !== undefined) env.FAKE_SLEEP_MS = String(sleepMs);
  if (replyChars !== undefined) env.FAKE_REPLY_CHARS = String(replyChars);
  if (stderr !== undefined) env.FAKE_STDERR = String(stderr);
  if (exitCode !== undefined) env.FAKE_EXIT_CODE = String(exitCode);
  if (usage !== undefined) env.FAKE_USAGE = JSON.stringify(usage);
  if (silenceMs !== undefined) env.FAKE_SILENCE_MS = String(silenceMs);
  if (chunks !== undefined) env.FAKE_CHUNKS = String(chunks);
  if (chunkMs !== undefined) env.FAKE_CHUNK_MS = String(chunkMs);
  if (turnDelayMs !== undefined) env.FAKE_TURN_DELAY_MS = String(turnDelayMs);
  if (halfLineMs !== undefined) env.FAKE_HALF_LINE_MS = String(halfLineMs);
  if (graceS !== undefined) env.CLI_BATON_CHAT_GRACE_S = String(graceS);
  return Object.assign(env, extra);
}

export class McpRpcError extends Error {
  constructor(message, code, data) {
    super(message);
    this.name = "McpRpcError";
    this.code = code;
    this.data = data;
  }
}

export class McpClient {
  constructor({ backend, env, cwd } = {}) {
    this.backend = backend;
    this.env = env;
    this.cwd = cwd;
    this.pending = new Map();
    this.nextId = 1;
    this.notifications = [];
    this.rawLines = [];
    this.stderrText = "";
    this.exit = null;
    this.buffer = "";
    this.proc = spawn(process.execPath, [SERVER_PATH, "--backend", backend], {
      env,
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.exited = new Promise((resolve) => {
      this.proc.on("exit", (code, signal) => {
        this.exit = { code, signal };
        for (const [, p] of this.pending) {
          p.reject(new Error("server exited before reply (code=" + code + ", signal=" + signal + ")"));
        }
        this.pending.clear();
        resolve(this.exit);
      });
    });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk) => this._onStdout(chunk));
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (chunk) => {
      this.stderrText += chunk;
    });
  }

  static async start(opts) {
    const client = new McpClient(opts);
    await client.initialize();
    return client;
  }

  _onStdout(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      this._onLine(line);
    }
  }

  _onLine(line) {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.rawLines.push({ raw: line, parseError: true });
      return;
    }
    this.rawLines.push(message);
    if (message.id !== undefined && message.id !== null && this.pending.has(message.id)) {
      const entry = this.pending.get(message.id);
      this.pending.delete(message.id);
      entry.resolve(message);
    } else if (message.id === undefined || message.id === null) {
      this.notifications.push(message);
    }
  }

  requestRaw(method, params, timeoutMs = 60000) {
    const id = this.nextId++;
    const payload = { jsonrpc: "2.0", id, method };
    if (params !== undefined) payload.params = params;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("timeout waiting for " + method + " (id=" + id + ")"));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.proc.stdin.write(JSON.stringify(payload) + "\n");
    });
  }

  async request(method, params, timeoutMs) {
    const message = await this.requestRaw(method, params, timeoutMs);
    if (message.error) {
      throw new McpRpcError(message.error.message, message.error.code, message.error.data);
    }
    return message.result;
  }

  sendRaw(text) {
    this.proc.stdin.write(text);
  }

  notify(method, params) {
    const payload = { jsonrpc: "2.0", method };
    if (params !== undefined) payload.params = params;
    this.proc.stdin.write(JSON.stringify(payload) + "\n");
  }

  async initialize(protocolVersion = "2025-06-18") {
    const result = await this.request("initialize", {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: "cli-baton-tests", version: "0.0.0" },
    });
    this.notify("notifications/initialized", {});
    return result;
  }

  callTool(name, args = {}, timeoutMs) {
    return this.requestRaw("tools/call", { name, arguments: args }, timeoutMs);
  }

  async close({ signal = "SIGTERM", timeoutMs = 10000 } = {}) {
    if (this.exit) return this.exit;
    try {
      this.proc.stdin.end();
    } catch {
      // ignore
    }
    try {
      this.proc.kill(signal);
    } catch {
      // ignore
    }
    const timer = setTimeout(() => {
      try {
        this.proc.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, timeoutMs);
    const result = await this.exited;
    clearTimeout(timer);
    return result;
  }

  async kill(signal = "SIGKILL") {
    try {
      this.proc.kill(signal);
    } catch {
      // ignore
    }
    return this.exited;
  }

  waitExit(timeoutMs = 10000) {
    return Promise.race([this.exited, sleep(timeoutMs).then(() => null)]);
  }
}

export function toolPayload(message) {
  if (!message) throw new Error("missing JSON-RPC message");
  if (message.error) throw new McpRpcError(message.error.message, message.error.code, message.error.data);
  const result = message.result;
  if (!result) throw new Error("missing result: " + JSON.stringify(message));
  const content = result.content || [];
  const text = content[0] && content[0].text;
  if (typeof text !== "string") throw new Error("missing text content: " + JSON.stringify(result));
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export function isToolError(message) {
  return Boolean(message && message.result && message.result.isError === true);
}

export async function waitForTerminal(client, prefix, runId, { timeoutMs = 60000, perCallS = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const remainingS = Math.max(1, Math.min(540, Math.ceil((deadline - Date.now()) / 1000)));
    const message = await client.callTool(prefix + "_wait", {
      run_id: runId,
      timeout_s: Math.min(perCallS, remainingS),
    });
    const payload = toolPayload(message);
    if (isToolError(message)) throw new Error("wait tool error: " + JSON.stringify(payload));
    last = payload;
    if (TERMINAL_STATES.has(payload.state)) return payload;
  }
  return last;
}

export async function sendWait(client, options) {
  const {
    prefix,
    message,
    cwd,
    session_id,
    access,
    model,
    effort,
    timeout_s,
    waitTimeoutMs = 90000,
  } = options;
  const args = { message, cwd };
  if (session_id) args.session_id = session_id;
  if (access) args.access = access;
  if (model) args.model = model;
  if (effort) args.effort = effort;
  if (timeout_s) args.timeout_s = timeout_s;
  const sendMessage = await client.callTool(prefix + "_send", args);
  if (isToolError(sendMessage)) throw new Error("send tool error: " + JSON.stringify(toolPayload(sendMessage)));
  const sent = toolPayload(sendMessage);
  const final = await waitForTerminal(client, prefix, sent.run_id, { timeoutMs: waitTimeoutMs });
  return { sent, final };
}

export function readArgv(logDir) {
  const file = path.join(logDir, "argv.json");
  if (!fs.existsSync(file)) throw new Error("fake CLI did not record argv.json in " + logDir);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function readStdin(logDir) {
  const file = path.join(logDir, "stdin.txt");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
}

export function readJsonIfExists(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function readRunDir(runDir) {
  const read = (name) => (fs.existsSync(path.join(runDir, name)) ? fs.readFileSync(path.join(runDir, name), "utf8") : null);
  return {
    runDir,
    meta: readJsonIfExists(path.join(runDir, "meta.json")),
    result: readJsonIfExists(path.join(runDir, "result.json")),
    supervisor: readJsonIfExists(path.join(runDir, "supervisor.json")),
    viewer: readJsonIfExists(path.join(runDir, "viewer.json")),
    viewerLog: read("viewer.log"),
    prompt: read("prompt.txt"),
    stdout: read("stdout.jsonl"),
    stderr: read("stderr.log"),
    reply: read("reply.txt"),
    files: fs.existsSync(runDir) ? fs.readdirSync(runDir) : [],
  };
}

/** Build a synthetic run directory (no runner) for viewer tests. */
export function makeRunDir({ backend = "agy", runId = "a".repeat(24), meta = {}, state = "running" } = {}) {
  const home = makeHome();
  const dir = path.join(home.path, backend, "runs", runId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const body = {
    run_id: runId,
    backend,
    state,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    cwd: "/tmp/cli-baton-viewer-test",
    model: "test-model",
    effort: "high",
    access: "full",
    child_pid: null,
    ...meta,
  };
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(body, null, 2) + "\n");
  fs.writeFileSync(path.join(dir, "stdout.jsonl"), "");
  fs.writeFileSync(path.join(dir, "stderr.log"), "");
  return {
    home: home.path,
    runDir: dir,
    writeMeta(patch = {}, nextState = body.state) {
      const merged = { ...body, ...patch, state: nextState, updated_at: new Date().toISOString() };
      fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(merged, null, 2) + "\n");
      return merged;
    },
    writeResult(result) {
      fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify(result, null, 2) + "\n");
    },
    appendStdout(text) {
      fs.appendFileSync(path.join(dir, "stdout.jsonl"), text);
    },
    appendStderr(text) {
      fs.appendFileSync(path.join(dir, "stderr.log"), text);
    },
    writeViewer(info) {
      fs.writeFileSync(path.join(dir, "viewer.json"), JSON.stringify(info, null, 2) + "\n");
    },
    remove() {
      home.remove();
    },
  };
}

export function fileMode(file) {
  return (fs.statSync(file).mode & 0o777).toString(8);
}

export function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

export async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 50, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error("timed out waiting for " + label + (lastError ? ": " + lastError.message : ""));
}

/**
 * Spawn the MCP server with arbitrary args and wait for it to exit (used for
 * startup-validation tests). Collects stdout/stderr.
 */
export function runServerToExit({ args, env, timeoutMs = 10000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVER_PATH, ...args], {
      env: env || { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      resolve({ code: null, signal: "TIMEOUT", stdout, stderr });
    }, timeoutMs);
    child.on("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}
