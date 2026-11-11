import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

export const name = "agy";
export const displayName = "Antigravity CLI (agy)";
export const envBinVar = "AGY_BIN";
export const binaryName = "agy";
export const defaultAccess = "full";
// How this CLI receives the next conversation turn: agy keeps one process and
// reads stdin NDJSON; codex is one process per turn and resumes by thread id.
export const chatMode = "stdin";

const SEARCH_DIRS = [
  ["home-local-bin", "~/.local/bin"],
  ["opt-homebrew-bin", "/opt/homebrew/bin"],
  ["usr-local-bin", "/usr/local/bin"],
];

function isExecutableFile(candidate) {
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) return false;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function homeDir(env) {
  return env.HOME || env.USERPROFILE || os.homedir();
}

function pathDirs(env) {
  return String(env.PATH || env.Path || "")
    .split(path.delimiter)
    .filter(Boolean);
}

function expandHome(value, env) {
  if (value === "~") return homeDir(env);
  if (value.startsWith("~/")) return path.join(homeDir(env), value.slice(2));
  return value;
}

function executableNames() {
  if (process.platform !== "win32") return [binaryName];
  return [binaryName + ".exe", binaryName + ".cmd", binaryName + ".bat", binaryName];
}

export function findExecutable(env = process.env) {
  const override = env[envBinVar];
  if (override && String(override).trim()) {
    const candidate = String(override).trim();
    if (!isExecutableFile(candidate)) return null;
    return { path: path.resolve(candidate), source: "env" };
  }
  for (const dir of pathDirs(env)) {
    for (const file of executableNames()) {
      const candidate = path.join(dir, file);
      if (isExecutableFile(candidate)) return { path: candidate, source: "path" };
    }
  }
  for (const [source, raw] of SEARCH_DIRS) {
    for (const file of executableNames()) {
      const candidate = path.join(expandHome(raw, env), file);
      if (isExecutableFile(candidate)) return { path: candidate, source };
    }
  }
  return null;
}

export function executableNotFoundMessage(env = process.env) {
  const override = env[envBinVar];
  if (override && String(override).trim()) {
    return "Cannot find the agy executable: " + envBinVar + " is set to " + JSON.stringify(String(override)) + " but that is not an executable file.";
  }
  return "Cannot find the agy executable. Looked at " + envBinVar + ", PATH, ~/.local/bin, /opt/homebrew/bin and /usr/local/bin. Install agy or set " + envBinVar + " to its absolute path.";
}

/**
 * Build the argv for one agy run in conversation mode.
 *
 *   agy --input-format stream-json --output-format stream-json [--model m]
 *       [--effort e] [--conversation id] [--mode plan | --dangerously-skip-permissions] -p=
 *
 * agy then reads one NDJSON message per turn from stdin and stays alive while
 * stdin is open; each turn ends with an `event:"result"` line. `-p=` must be a
 * single empty-value token: a bare `-p` would swallow the next argument.
 *
 * Returns { args, stdin: "chat" }: the runner keeps stdin open and writes the
 * prompt (and every later message) as a user event.
 */
export function buildInvocation({ prompt, cwd, sessionId, model, effort, access } = {}) {
  const accessMode = access || defaultAccess;
  const args = ["--input-format", "stream-json", "--output-format", "stream-json"];
  if (sessionId) args.push("--conversation", sessionId);
  if (model) args.push("--model", model);
  if (effort) args.push("--effort", effort);
  if (accessMode === "read-only") {
    args.push("--mode", "plan");
  } else {
    args.push("--dangerously-skip-permissions");
  }
  args.push("-p=");
  return { args, stdin: "chat", prompt };
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function looksLikeResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return "status" in value || "response" in value || "conversation_id" in value || "error" in value;
}

export function extractJsonResult(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return null;
  const whole = tryParseJson(text);
  if (looksLikeResult(whole)) return whole;
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const value = tryParseJson(lines[index]);
    if (looksLikeResult(value)) return value;
  }
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) {
    const value = tryParseJson(text.slice(first, last + 1));
    if (looksLikeResult(value)) return value;
  }
  return null;
}

function firstLine(text, limit = 400) {
  const line = String(text || "").split(/\r?\n/).find((entry) => entry.trim());
  return line ? line.trim().slice(0, limit) : "";
}

/**
 * Parse agy `--output-format stream-json` output: one JSON event per line.
 *
 *   {"event":"init","conversation_id":"…","init":{…}}
 *   {"event":"step_update","step_update":{"step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"…"}}
 *   {"event":"result","result":{… same shape as --output-format json …}}
 *
 * Returns the last `result` payload (if any), every text_delta concatenated,
 * and whether any stream event was seen at all. Non-JSON lines and objects
 * without an `event` field are ignored so a mixed/legacy stdout still works.
 */
export function parseStreamEvents(stdout) {
  let sawStream = false;
  let resultObject = null;
  let deltas = "";
  let deltaCount = 0;
  let eventCount = 0;
  const steps = [];
  for (const rawLine of String(stdout || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const value = tryParseJson(line);
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const event = typeof value.event === "string" ? value.event : null;
    if (!event) continue;
    sawStream = true;
    eventCount += 1;
    if (event === "result") {
      const inner = value.result;
      if (inner && typeof inner === "object" && !Array.isArray(inner)) resultObject = inner;
    } else if (event === "step_update") {
      const step = value.step_update;
      if (!step || typeof step !== "object" || Array.isArray(step)) continue;
      steps.push(step);
      if (typeof step.text_delta === "string" && step.text_delta) {
        deltas += step.text_delta;
        deltaCount += 1;
      }
    }
  }
  return { sawStream, resultObject, deltas, deltaCount, steps, eventCount };
}

/**
 * Map agy stdout/stderr/exit code to a normalized parser result.
 * state is "completed" or "failed"; the runner overrides for cancel/timeout.
 *
 * Accepts both agy output formats:
 *  - NDJSON stream (`--output-format stream-json`): the last `event:"result"`
 *    payload is mapped exactly like the legacy single JSON object.
 *  - legacy single JSON object (`--output-format json`), kept for older agy
 *    builds and for test fixtures.
 * A stream that ends without a `result` event falls back to the concatenated
 * text_delta output and reports an explicit error.
 */
export function parseOutput({ stdout, stderr, exitCode } = {}) {
  const stream = parseStreamEvents(stdout);
  // A detected stream is authoritative: only its `result` event is the reply
  // source. Falling back to the legacy scanner here would mis-read the `init`
  // event (it also carries conversation_id) as a result object.
  const parsed = stream.sawStream ? stream.resultObject : extractJsonResult(stdout);
  const streamWithoutResult = stream.sawStream && !stream.resultObject;

  let sessionId = null;
  let usage = null;
  let reply = "";
  let status = null;
  let backendError = null;
  if (parsed) {
    if (typeof parsed.conversation_id === "string") sessionId = parsed.conversation_id;
    else if (typeof parsed.session_id === "string") sessionId = parsed.session_id;
    if (parsed.usage && typeof parsed.usage === "object") usage = parsed.usage;
    if (typeof parsed.response === "string") reply = parsed.response;
    else if (typeof parsed.result === "string") reply = parsed.result;
    if (typeof parsed.status === "string") status = parsed.status;
    if (parsed.error !== undefined && parsed.error !== null) backendError = String(parsed.error);
  }
  if (!parsed && streamWithoutResult && stream.deltas) reply = stream.deltas;

  let state = "completed";
  let error = null;
  const nonZero = typeof exitCode === "number" && exitCode !== 0;
  const emptyReply = reply.trim() === "";

  if (nonZero) {
    state = "failed";
    error = backendError || firstLine(stderr) || "agy exited with code " + exitCode;
  } else if (status && status.toUpperCase() !== "SUCCESS") {
    state = "failed";
    error = backendError || "agy reported status " + status;
  } else if (!parsed && !streamWithoutResult) {
    state = "failed";
    error = "Could not parse agy JSON output" + (firstLine(stderr) ? ": " + firstLine(stderr) : "");
  } else if (streamWithoutResult) {
    state = "failed";
    error =
      "agy stream ended without a result event" +
      (stream.deltaCount > 0 ? " (reply recovered from " + stream.deltaCount + " text_delta step(s))" : "") +
      (firstLine(stderr) ? ": " + firstLine(stderr) : "");
  } else if (emptyReply) {
    state = "failed";
    error = "agy returned an empty reply" + (backendError ? ": " + backendError : "");
  }

  return {
    state,
    reply,
    sessionId,
    usage,
    error,
    status,
    stream: stream.sawStream,
    delta_count: stream.deltaCount,
  };
}

function killTree(child) {
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
}

function runCapture(execPath, args, env, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(execPath, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env,
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    } catch (error) {
      resolve({ code: null, signal: null, stdout: "", stderr: String(error && error.message) });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    let settled = false;
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killTree(child);
      resolve({ code: null, signal: "TIMEOUT", stdout, stderr });
    }, timeoutMs);
    child.on("close", finish);
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, signal: null, stdout, stderr: stderr + String(error && error.message) });
    });
  });
}

export function parseModelList(stdout) {
  const text = String(stdout || "").trim();
  const parsed = tryParseJson(text);
  const entries = [];
  if (Array.isArray(parsed)) {
    entries.push(...parsed);
  } else if (parsed && typeof parsed === "object") {
    for (const key of ["models", "data", "items", "available_models", "availableModels"]) {
      if (Array.isArray(parsed[key])) entries.push(...parsed[key]);
    }
  } else {
    const logLine = /^(fetching|loading|warning|error|info|hint|using|reading|updated|authenticat)/i;
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || logLine.test(trimmed)) continue;
      entries.push(trimmed);
    }
  }
  const models = [];
  const seen = new Set();
  for (const entry of entries) {
    let id;
    let display;
    if (typeof entry === "string") {
      id = entry.split(/\s+/)[0];
    } else if (entry && typeof entry === "object") {
      id = entry.id || entry.slug || entry.model || entry.name;
      display = entry.display_name || entry.displayName || entry.name || entry.title;
    }
    if (typeof id !== "string") continue;
    id = id.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/.test(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    const model = { id };
    if (typeof display === "string" && display.trim() && display.trim() !== id) {
      model.display_name = display.trim();
    }
    models.push(model);
  }
  return models;
}

export async function listModels({ execPath, env = process.env } = {}) {
  if (!execPath) throw new Error("agy executable path is required");
  const result = await runCapture(execPath, ["models"], env, 30000);
  const models = parseModelList(result.stdout);
  if (models.length > 0) return { models, source: "agy models" };
  if (result.signal === "TIMEOUT") {
    throw new Error("agy models timed out after 30s (it may require network access or proxy environment variables)");
  }
  const detail = firstLine(result.stderr) ? ": " + firstLine(result.stderr) : result.code !== 0 ? " (exit code " + result.code + ")" : "";
  throw new Error("agy models returned no parseable model list" + detail);
}
