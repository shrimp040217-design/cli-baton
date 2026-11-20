import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

export const name = "claude";
export const displayName = "Claude Code CLI (claude)";
export const envBinVar = "CLAUDE_BIN";
export const binaryName = "claude";
export const defaultAccess = "full";
// Claude Code stays alive on a single process when invoked with
// `--input-format stream-json --output-format stream-json` and reads one JSON
// user message per turn from stdin, emitting a `type:"result"` line per turn.
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
    return "Cannot find the claude executable: " + envBinVar + " is set to " + JSON.stringify(String(override)) + " but that is not an executable file.";
  }
  return "Cannot find the claude executable. Looked at " + envBinVar + ", PATH, ~/.local/bin, /opt/homebrew/bin and /usr/local/bin. Install Claude Code CLI or set " + envBinVar + " to its absolute path.";
}

/**
 * Strip nested-session environment guards so spawning `claude` from any host
 * environment succeeds cleanly.
 */
export function sanitizeEnv(env = process.env) {
  const next = { ...env };
  delete next.CLAUDECODE;
  return next;
}

/**
 * Build the argv for one Claude Code CLI run in stream-json conversation mode.
 *
 *   claude -p --input-format stream-json --output-format stream-json
 *          --verbose --include-partial-messages
 *          [--resume <session_id>] [--model <m>] [--effort <e>]
 *          [--permission-mode plan | --dangerously-skip-permissions]
 *
 * Prompts arrive as NDJSON user messages on stdin, avoiding argv length limits
 * and leading-dash ambiguity. Each turn finishes with a `type:"result"` event.
 */
export function buildInvocation({ prompt, cwd, sessionId, model, effort, access } = {}) {
  const accessMode = access || defaultAccess;
  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
  ];
  if (sessionId) args.push("--resume", sessionId);
  if (model) args.push("--model", model);
  if (effort) args.push("--effort", effort);
  if (accessMode === "read-only") {
    args.push("--permission-mode", "plan");
  } else {
    args.push("--dangerously-skip-permissions");
  }
  return { args, stdin: "chat", prompt };
}

/** One stdin NDJSON user message for Claude Code's `--input-format stream-json`. */
export function buildUserMessage(text) {
  return (
    JSON.stringify({
      type: "user",
      message: { role: "user", content: String(text) },
    }) + "\n"
  );
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

function extractResultError(resultObj) {
  if (!resultObj || typeof resultObj !== "object") return null;
  if (Array.isArray(resultObj.errors) && resultObj.errors.length > 0) {
    const first = resultObj.errors.find((entry) => typeof entry === "string" && entry.trim());
    if (first) return first.trim();
  }
  if (typeof resultObj.error === "string" && resultObj.error.trim()) return resultObj.error.trim();
  if (resultObj.error && typeof resultObj.error === "object" && typeof resultObj.error.message === "string") {
    return resultObj.error.message.trim();
  }
  if (resultObj.is_error === true && typeof resultObj.result === "string" && resultObj.result.trim()) {
    return resultObj.result.trim();
  }
  if (typeof resultObj.subtype === "string" && resultObj.subtype && resultObj.subtype !== "success") {
    return "claude reported subtype " + resultObj.subtype;
  }
  return null;
}

/**
 * Inspect one parsed stdout NDJSON object; return normalized turn completion
 * metadata when this line marks the end of a Claude turn, or null otherwise.
 */
export function extractTurnResult(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (parsed.type !== "result") return null;
  const subtype = typeof parsed.subtype === "string" ? parsed.subtype : null;
  const isError = parsed.is_error === true || (subtype !== null && subtype !== "success");
  const rawReply = typeof parsed.result === "string" ? parsed.result : "";
  const error = isError ? extractResultError(parsed) || "claude reported an error" : null;
  return {
    reply: isError ? "" : rawReply,
    status: isError ? String(subtype || "ERROR").toUpperCase() : "SUCCESS",
    duration_s: typeof parsed.duration_ms === "number" && Number.isFinite(parsed.duration_ms) ? Math.round(parsed.duration_ms) / 1000 : null,
    usage: parsed.usage && typeof parsed.usage === "object" ? parsed.usage : null,
    sessionId: typeof parsed.session_id === "string" ? parsed.session_id : null,
    error,
  };
}

function assistantTextOf(event) {
  const content = event && event.message && Array.isArray(event.message.content) ? event.message.content : [];
  const parts = [];
  for (const block of content) {
    if (block && block.type === "text" && typeof block.text === "string" && block.text) {
      parts.push(block.text);
    }
  }
  return parts.join("");
}

/**
 * Parse Claude Code `--output-format stream-json --verbose` NDJSON events.
 */
export function parseStreamEvents(stdout) {
  let sawStream = false;
  let resultObject = null;
  let sessionId = null;
  let deltas = "";
  let deltaCount = 0;
  let lastAssistantText = "";
  let eventCount = 0;

  for (const rawLine of String(stdout || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const value = tryParseJson(line);
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const type = typeof value.type === "string" ? value.type : null;
    if (!type) continue;
    if (
      type !== "system" &&
      type !== "stream_event" &&
      type !== "assistant" &&
      type !== "user" &&
      type !== "result" &&
      type !== "rate_limit_event"
    ) {
      continue;
    }
    sawStream = true;
    eventCount += 1;
    if (typeof value.session_id === "string" && value.session_id) sessionId = value.session_id;

    if (type === "result") {
      resultObject = value;
    } else if (type === "stream_event") {
      const inner = value.event;
      if (
        inner &&
        typeof inner === "object" &&
        inner.type === "content_block_delta" &&
        inner.delta &&
        inner.delta.type === "text_delta" &&
        typeof inner.delta.text === "string" &&
        inner.delta.text
      ) {
        deltas += inner.delta.text;
        deltaCount += 1;
      }
    } else if (type === "assistant") {
      const text = assistantTextOf(value);
      if (text) lastAssistantText = text;
    }
  }

  return { sawStream, resultObject, sessionId, deltas, deltaCount, lastAssistantText, eventCount };
}

/**
 * Map Claude Code stdout/stderr/exit code to a normalized parser result.
 */
export function parseOutput({ stdout, stderr, exitCode } = {}) {
  const stream = parseStreamEvents(stdout);
  const parsed = stream.resultObject;
  const streamWithoutResult = stream.sawStream && !parsed;

  let sessionId = stream.sessionId || null;
  let usage = null;
  let reply = "";
  let status = null;
  let backendError = null;
  let isErrorResult = false;

  if (parsed) {
    if (typeof parsed.session_id === "string" && parsed.session_id) sessionId = parsed.session_id;
    if (parsed.usage && typeof parsed.usage === "object") usage = parsed.usage;
    if (typeof parsed.subtype === "string") status = parsed.subtype;
    isErrorResult = parsed.is_error === true || (status !== null && status !== "success");
    if (isErrorResult) {
      backendError = extractResultError(parsed);
    } else if (typeof parsed.result === "string") {
      reply = parsed.result;
    }
  }

  if (!parsed && streamWithoutResult) {
    reply = stream.lastAssistantText || stream.deltas || "";
  } else if (parsed && !isErrorResult && !reply && (stream.lastAssistantText || stream.deltas)) {
    reply = stream.lastAssistantText || stream.deltas;
  }

  let state = "completed";
  let error = null;
  const nonZero = typeof exitCode === "number" && exitCode !== 0;
  const emptyReply = reply.trim() === "";

  if (nonZero) {
    state = "failed";
    error = backendError || firstLine(stderr) || "claude exited with code " + exitCode;
  } else if (isErrorResult) {
    state = "failed";
    error = backendError || "claude reported status " + (status || "error");
  } else if (!parsed && !streamWithoutResult) {
    state = "failed";
    error = "Could not parse claude JSON output" + (firstLine(stderr) ? ": " + firstLine(stderr) : "");
  } else if (streamWithoutResult) {
    state = "failed";
    error =
      "claude stream ended without a result event" +
      (stream.deltaCount > 0 ? " (reply recovered from " + stream.deltaCount + " text_delta chunk(s))" : "") +
      (firstLine(stderr) ? ": " + firstLine(stderr) : "");
  } else if (emptyReply) {
    state = "failed";
    error = "claude returned an empty reply" + (backendError ? ": " + backendError : "");
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
        env: sanitizeEnv(env),
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

/**
 * Parse model aliases advertised by `claude --help` under the `--model` flag
 * (or JSON if a CLI/fixture emits structured models).
 */
export function parseModelList(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return [];
  const parsed = tryParseJson(text);
  const models = [];
  const seen = new Set();
  const pushModel = (id, display) => {
    if (typeof id !== "string") return;
    const trimmed = id.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/.test(trimmed)) return;
    if (seen.has(trimmed)) return;
    seen.add(trimmed);
    const entry = { id: trimmed };
    if (typeof display === "string" && display.trim() && display.trim() !== trimmed) {
      entry.display_name = display.trim();
    }
    models.push(entry);
  };

  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      if (typeof item === "string") pushModel(item);
      else if (item && typeof item === "object") pushModel(item.id || item.slug || item.model || item.name, item.display_name || item.displayName);
    }
    return models;
  }
  if (parsed && typeof parsed === "object") {
    for (const key of ["models", "data", "items", "aliases"]) {
      if (Array.isArray(parsed[key])) {
        for (const item of parsed[key]) {
          if (typeof item === "string") pushModel(item);
          else if (item && typeof item === "object") pushModel(item.id || item.slug || item.model || item.name, item.display_name || item.displayName);
        }
      }
    }
    if (models.length > 0) return models;
  }

  // Extract the `--model <model>` description block from `claude --help`.
  const lines = text.split(/\r?\n/);
  const block = [];
  let inModelOption = false;
  for (const line of lines) {
    if (!inModelOption) {
      if (/^\s*--model\b/.test(line)) {
        inModelOption = true;
        block.push(line);
      }
      continue;
    }
    // Next option or top-level section ends the `--model` description block.
    if (/^\s{0,4}-/.test(line) || /^[A-Z][A-Za-z ]+:\s*$/.test(line) || line.trim() === "") break;
    block.push(line);
  }
  if (block.length > 0) {
    const joined = block.join(" ");
    const matches = joined.matchAll(/['"]([A-Za-z0-9][A-Za-z0-9._:/@-]*)['"]/g);
    for (const match of matches) pushModel(match[1]);
  }
  return models;
}

export async function listModels({ execPath, env = process.env } = {}) {
  if (!execPath) throw new Error("claude executable path is required");
  const result = await runCapture(execPath, ["--help"], env, 15000);
  const models = parseModelList(result.stdout);
  if (models.length > 0) return { models, source: "claude --help" };
  if (result.signal === "TIMEOUT") {
    throw new Error("claude --help timed out after 15s");
  }
  const detail = firstLine(result.stderr) ? ": " + firstLine(result.stderr) : result.code !== 0 ? " (exit code " + result.code + ")" : "";
  throw new Error("claude --help did not advertise any parseable --model aliases" + detail);
}
