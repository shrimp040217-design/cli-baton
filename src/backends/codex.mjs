import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

export const name = "codex";
export const displayName = "Codex CLI (codex)";
export const envBinVar = "CODEX_BIN";
export const binaryName = "codex";
export const defaultAccess = "full";
// How this CLI receives the next conversation turn: agy keeps one process and
// reads stdin NDJSON; codex is one process per turn and resumes by thread id.
export const chatMode = "resume";

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
    return "Cannot find the codex executable: " + envBinVar + " is set to " + JSON.stringify(String(override)) + " but that is not an executable file.";
  }
  return "Cannot find the codex executable. Looked at " + envBinVar + ", PATH, ~/.local/bin, /opt/homebrew/bin and /usr/local/bin. Install codex or set " + envBinVar + " to its absolute path.";
}

/**
 * Build the argv for one codex exec run. Prompt always goes through stdin ("-"),
 * which avoids argv length limits and makes leading-dash prompts safe.
 * Note: "codex exec resume" has neither -C nor -s; cwd is set via the child
 * process cwd and sandbox settings go through -c overrides.
 */
export function buildInvocation({ prompt, cwd, sessionId, model, effort, access } = {}) {
  const accessMode = access || defaultAccess;
  const args = sessionId
    ? ["exec", "resume", "--json", "--skip-git-repo-check", sessionId]
    : ["exec", "--json", "--skip-git-repo-check", "-C", cwd];
  if (model) args.push("-m", model);
  if (effort) args.push("-c", 'model_reasoning_effort="' + effort + '"');
  if (accessMode === "read-only") {
    args.push("-c", 'sandbox_mode="read-only"', "-c", 'approval_policy="never"');
  } else {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  }
  args.push("-");
  return { args, stdin: "prompt" };
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function firstLine(text, limit = 400) {
  const line = String(text || "").split(/\r?\n/).find((entry) => entry.trim());
  return line ? line.trim().slice(0, limit) : "";
}

/**
 * Parse codex exec --json JSONL events.
 * Unknown events and non-JSON lines are tolerated. Top-level "error" events are
 * treated as transient warnings (codex emits them for reconnects) unless the turn
 * ultimately fails or produces no reply.
 */
export function parseOutput({ stdout, stderr, exitCode } = {}) {
  const events = [];
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const value = tryParseJson(trimmed);
    if (value && typeof value === "object" && !Array.isArray(value)) events.push(value);
  }

  let sessionId = null;
  let usage = null;
  let reply = "";
  let turnFailed = null;
  let lastError = null;
  let sawTurnCompleted = false;

  for (const event of events) {
    const type = event.type;
    if (type === "thread.started" && typeof event.thread_id === "string") {
      sessionId = event.thread_id;
    } else if (type === "item.completed" && event.item && typeof event.item === "object") {
      if (event.item.type === "agent_message" && typeof event.item.text === "string") {
        reply = event.item.text;
      } else if (event.item.type === "error" && event.item.message) {
        lastError = String(event.item.message);
      }
    } else if (type === "turn.completed") {
      sawTurnCompleted = true;
      if (event.usage && typeof event.usage === "object") usage = event.usage;
    } else if (type === "turn.failed") {
      const detail = event.error && (event.error.message || event.error.type);
      turnFailed = detail ? String(detail) : event.message ? String(event.message) : "turn failed";
    } else if (type === "error") {
      lastError = event.message ? String(event.message) : lastError;
    }
  }

  let state = "completed";
  let error = null;
  const nonZero = typeof exitCode === "number" && exitCode !== 0;

  if (nonZero) {
    state = "failed";
    error = turnFailed || firstLine(stderr) || "codex exited with code " + exitCode;
  } else if (turnFailed) {
    state = "failed";
    error = turnFailed;
  } else if (reply.trim() === "") {
    state = "failed";
    const suffix = lastError ? ": " + lastError : "";
    error = "codex produced an empty reply" + suffix;
  }

  return { state, reply, sessionId, usage, error, sawTurnCompleted };
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
  } else if (parsed && typeof parsed === "object" && Array.isArray(parsed.models)) {
    entries.push(...parsed.models);
  }
  const models = [];
  const seen = new Set();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const id = entry.slug || entry.id || entry.model;
    if (typeof id !== "string" || !id.trim()) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    const model = { id: id.trim() };
    const display = entry.display_name || entry.displayName;
    if (typeof display === "string" && display.trim()) model.display_name = display.trim();
    models.push(model);
  }
  return models;
}

export async function listModels({ execPath, env = process.env } = {}) {
  if (!execPath) throw new Error("codex executable path is required");
  const result = await runCapture(execPath, ["debug", "models"], env, 20000);
  const models = parseModelList(result.stdout);
  if (models.length > 0) return { models, source: "codex debug models" };
  if (result.signal === "TIMEOUT") {
    throw new Error("codex debug models timed out after 20s");
  }
  const detail = firstLine(result.stderr) ? ": " + firstLine(result.stderr) : result.code !== 0 ? " (exit code " + result.code + ")" : "";
  throw new Error("codex debug models returned no parseable model list" + detail);
}
