import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const RUN_ID_RE = /^[0-9a-f]{24}$/;
export const STATE_VALUES = ["queued", "running", "completed", "failed", "cancelled", "timed_out", "interrupted"];
export const TERMINAL_STATES = new Set(["completed", "failed", "cancelled", "timed_out", "interrupted"]);
export const ACTIVE_STATES = new Set(["queued", "running"]);
export const TOOL_REPLY_LIMIT = 100000;
export const HEARTBEAT_STALE_MS = 20000;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function resolveRoot(env = process.env) {
  const configured = env.CLI_BATON_HOME;
  if (configured && String(configured).trim()) return path.resolve(String(configured).trim());
  return path.join(os.homedir(), ".cli-baton");
}

export function backendRoot(root, backend) {
  return path.join(root, backend);
}

export function runsRoot(root, backend) {
  return path.join(backendRoot(root, backend), "runs");
}

export function isValidRunId(runId) {
  return typeof runId === "string" && RUN_ID_RE.test(runId);
}

export function runDirFor(root, backend, runId) {
  if (!isValidRunId(runId)) {
    const error = new Error("Invalid run_id: expected 24 lowercase hex characters");
    error.code = "INVALID_RUN_ID";
    throw error;
  }
  return path.join(runsRoot(root, backend), runId);
}

export function runPaths(runDir) {
  return {
    runDir,
    meta: path.join(runDir, "meta.json"),
    prompt: path.join(runDir, "prompt.txt"),
    stdout: path.join(runDir, "stdout.jsonl"),
    stderr: path.join(runDir, "stderr.log"),
    reply: path.join(runDir, "reply.txt"),
    result: path.join(runDir, "result.json"),
    supervisor: path.join(runDir, "supervisor.json"),
    heartbeat: path.join(runDir, "heartbeat.json"),
    cancel: path.join(runDir, "cancel.json"),
    viewer: path.join(runDir, "viewer.json"),
    viewerLog: path.join(runDir, "viewer.log"),
    inbox: path.join(runDir, "inbox.jsonl"),
    turns: path.join(runDir, "turns.json"),
  };
}

/**
 * Merge a patch into <run_dir>/viewer.json (created when absent). Used by both
 * the runner (window_id) and the viewer process itself (pid), which may race,
 * so every write re-reads the file first.
 */
export function mergeViewerInfo(runDir, patch) {
  const file = runPaths(runDir).viewer;
  const existing = readJson(file) || {};
  const merged = { ...existing, ...patch };
  writeJsonAtomic(file, merged);
  return merged;
}

export function readViewerInfo(runDir) {
  return readJson(runPaths(runDir).viewer);
}

/** Conversation turns recorded so far (chat mode); [] for one-shot runs. */
export function readTurns(runDir) {
  const value = readJson(runPaths(runDir).turns);
  return Array.isArray(value) ? value : [];
}

export function writeTurns(runDir, turns) {
  writeJsonAtomic(runPaths(runDir).turns, Array.isArray(turns) ? turns : []);
}

/**
 * Chat state published by the runner in heartbeat.json: whether the run is a
 * conversation, whether a turn is in flight, and when the grace window closes.
 */
export function readChatState(runDir) {
  const heartbeat = readJson(runPaths(runDir).heartbeat) || {};
  const graceUntil = Number(heartbeat.grace_until);
  return {
    chat: heartbeat.chat === true,
    inflight: heartbeat.inflight === true,
    grace_until: Number.isFinite(graceUntil) && graceUntil > 0 ? graceUntil : null,
    turns: Number.isFinite(Number(heartbeat.turns)) ? Number(heartbeat.turns) : 0,
    stdin_closed: heartbeat.stdin_closed === true,
    max_turns:
      typeof heartbeat.max_turns === "number" && Number.isFinite(heartbeat.max_turns) && heartbeat.max_turns > 0
        ? heartbeat.max_turns
        : null,
    turns_used: typeof heartbeat.turns_used === "number" && Number.isFinite(heartbeat.turns_used) ? heartbeat.turns_used : 0,
    turns_remaining:
      typeof heartbeat.turns_remaining === "number" && Number.isFinite(heartbeat.turns_remaining)
        ? heartbeat.turns_remaining
        : null,
    max_turns_reached: heartbeat.max_turns_reached === true,
  };
}

/** Append one line to <run_dir>/viewer.log; never throws (best effort). */
export function appendViewerLog(runDir, message) {
  try {
    const file = runPaths(runDir).viewerLog;
    ensureDir(path.dirname(file), 0o700);
    fs.appendFileSync(file, new Date().toISOString() + " " + String(message) + "\n", { mode: 0o600 });
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // best effort
    }
  } catch {
    // viewer logging must never break a run
  }
}

export function generateRunId() {
  return crypto.randomBytes(12).toString("hex");
}

export function ensureDir(dir, mode = 0o700) {
  fs.mkdirSync(dir, { recursive: true, mode });
  try {
    fs.chmodSync(dir, mode);
  } catch {
    // best effort (e.g. Windows)
  }
}

export function writeFileAtomic(file, data, mode = 0o600) {
  ensureDir(path.dirname(file), 0o700);
  const tmp = file + ".tmp." + process.pid + "." + crypto.randomBytes(4).toString("hex");
  try {
    fs.writeFileSync(tmp, data, { mode });
    try {
      fs.chmodSync(tmp, mode);
    } catch {
      // best effort
    }
    fs.renameSync(tmp, file);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore
    }
    throw error;
  }
  try {
    fs.chmodSync(file, mode);
  } catch {
    // best effort
  }
}

export function writeJsonAtomic(file, value, mode = 0o600) {
  writeFileAtomic(file, JSON.stringify(value, null, 2) + "\n", mode);
}

/**
 * Atomically create a JSON file only if it does not exist yet (hard link is an
 * exclusive operation, so the first writer wins). Returns the stored value.
 */
export function writeJsonIfAbsent(file, value, mode = 0o600) {
  ensureDir(path.dirname(file), 0o700);
  const tmp = file + ".tmp." + process.pid + "." + crypto.randomBytes(4).toString("hex");
  const data = JSON.stringify(value, null, 2) + "\n";
  fs.writeFileSync(tmp, data, { mode });
  try {
    try {
      fs.chmodSync(tmp, mode);
    } catch {
      // best effort
    }
    fs.linkSync(tmp, file);
    fs.unlinkSync(tmp);
    return value;
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore
    }
    if (error.code === "EEXIST") {
      const existing = readJson(file);
      return existing || value;
    }
    if (error.code === "EPERM" || error.code === "ENOTSUP") {
      // Filesystems without hard links (rare, e.g. some Windows setups).
      if (!fs.existsSync(file)) writeJsonAtomic(file, value, mode);
      return readJson(file) || value;
    }
    throw error;
  }
}

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

export function readJsonIfPresent(file) {
  return fs.existsSync(file) ? readJson(file) : null;
}

export function createRun({ root, backend, runId, prompt, meta }) {
  const runDir = runDirFor(root, backend, runId);
  ensureDir(runDir, 0o700);
  const paths = runPaths(runDir);
  writeFileAtomic(paths.prompt, String(prompt), 0o600);
  const createdAt = new Date().toISOString();
  const fullMeta = {
    run_id: runId,
    backend,
    state: "queued",
    created_at: createdAt,
    updated_at: createdAt,
    prompt_placeholder: "<prompt>",
    ...meta,
  };
  writeJsonAtomic(paths.meta, fullMeta);
  return { runId, runDir, meta: fullMeta };
}

export function readMeta(runDir) {
  return readJson(runPaths(runDir).meta);
}

export function writeMeta(runDir, meta) {
  meta.updated_at = new Date().toISOString();
  writeJsonAtomic(runPaths(runDir).meta, meta);
}

export function readResult(runDir) {
  return readJson(runPaths(runDir).result);
}

export function readPrompt(runDir) {
  return readText(runPaths(runDir).prompt) || "";
}

export function readSupervisor(runDir) {
  return readJson(runPaths(runDir).supervisor);
}

export function processStartToken(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === "win32") return null;
  try {
    // Force the C locale: `ps -o lstart=` is localized (e.g. "三 11月/11 …"
    // under LANG=zh_CN), so the token would never match a token written by a
    // process running with a different locale — which is exactly what happens
    // when Terminal.app launches the viewer with the user's shell locale.
    const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2000,
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
    });
    if (!result || result.status !== 0) return null;
    const token = String(result.stdout || "").replace(/\s+/g, " ").trim();
    return token || null;
  } catch {
    return null;
  }
}

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

export function heartbeatAgeMs(runDir) {
  const heartbeat = readJson(runPaths(runDir).heartbeat);
  const at = heartbeat && Number(heartbeat.at);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Date.now() - at);
}

/**
 * Progress fields the runner records in heartbeat.json at most once per second:
 * when the CLI last produced output, how many bytes reached stdout.jsonl, how
 * many JSON events were seen and what the last one was. Tools turn these into
 * `idle_s` so a caller can tell "still thinking" from "stuck".
 */
export function readProgress(runDir) {
  const heartbeat = readJson(runPaths(runDir).heartbeat) || {};
  const lastOutputAt = Number(heartbeat.last_output_at);
  const stdoutBytes = Number(heartbeat.stdout_bytes);
  const eventCount = Number(heartbeat.event_count);
  return {
    last_output_at: Number.isFinite(lastOutputAt) && lastOutputAt > 0 ? lastOutputAt : null,
    stdout_bytes: Number.isFinite(stdoutBytes) && stdoutBytes >= 0 ? stdoutBytes : 0,
    event_count: Number.isFinite(eventCount) && eventCount >= 0 ? eventCount : 0,
    last_event: typeof heartbeat.last_event === "string" && heartbeat.last_event ? heartbeat.last_event : null,
  };
}

/**
 * Explicit clock so "update at most once per second" is testable without
 * waiting on wall time.
 */
export function createThrottle({ intervalMs = 1000, now = () => Date.now() } = {}) {
  let last = Number.NEGATIVE_INFINITY;
  return {
    ready() {
      return now() - last >= intervalMs;
    },
    mark() {
      last = now();
      return last;
    },
    force() {
      last = Number.NEGATIVE_INFINITY;
    },
    get lastAt() {
      return last;
    },
  };
}

/**
 * Liveness of the detached supervisor (runner) process, guarded against pid
 * reuse by comparing the recorded process start token. Falls back to the
 * heartbeat file when ps is unavailable.
 */
export function isSupervisorAlive(runDir) {
  const supervisor = readSupervisor(runDir);
  if (!supervisor || !Number.isInteger(supervisor.pid)) return false;
  if (supervisor.pid === process.pid) return true;
  if (!isPidAlive(supervisor.pid)) return false;
  if (supervisor.pid_start) {
    const current = processStartToken(supervisor.pid);
    if (current) return current === supervisor.pid_start;
  }
  const age = heartbeatAgeMs(runDir);
  if (age !== null) return age < HEARTBEAT_STALE_MS;
  const spawnedAt = Date.parse(supervisor.spawned_at || "");
  if (Number.isFinite(spawnedAt)) return Date.now() - spawnedAt < HEARTBEAT_STALE_MS;
  return true;
}

export function resolveState({ meta, result, runDir }) {
  if (result && typeof result.state === "string" && STATE_VALUES.includes(result.state)) return result.state;
  if (!meta) return "interrupted";
  const base = meta.state === "queued" ? "queued" : "running";
  if (isSupervisorAlive(runDir)) return base;
  return "interrupted";
}

function computeDuration(startedAt, endedAt) {
  const start = Date.parse(startedAt || "");
  if (!Number.isFinite(start)) return 0;
  const end = endedAt ? Date.parse(endedAt) : Date.now();
  if (!Number.isFinite(end)) return 0;
  return Math.max(0, Math.round(((end - start) / 1000) * 1000) / 1000);
}

export function readTailLines(file, count) {
  const limit = Math.max(0, Math.floor(Number(count) || 0));
  if (limit === 0) return [];
  const text = readText(file);
  if (!text) return [];
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.trim() !== "");
  return lines.slice(-limit);
}

export function tailText(file, maxChars = 4000) {
  const text = readText(file);
  if (!text) return "";
  return text.length <= maxChars ? text : text.slice(-maxChars);
}

const BEARER_RE = /(Bearer\s+)[A-Za-z0-9._~+\/=-]+/gi;
const SK_RE = /\bsk-[A-Za-z0-9_-]{3,}/g;
const KV_RE = /\b(api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|key)\b(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi;

export function redact(value) {
  if (value === null || value === undefined) return value;
  let text = String(value);
  text = text.replace(BEARER_RE, "$1[REDACTED]");
  text = text.replace(SK_RE, "sk-[REDACTED]");
  text = text.replace(KV_RE, (match, key, separator) => key + separator + "[REDACTED]");
  return text;
}

export function truncateReply(reply) {
  const text = reply === null || reply === undefined ? "" : String(reply);
  if (text.length <= TOOL_REPLY_LIMIT) return { reply: text, reply_truncated: false };
  return { reply: text.slice(0, TOOL_REPLY_LIMIT), reply_truncated: true };
}

/**
 * Build the backend-agnostic snapshot used by wait/status/cancel/list tools.
 * includeReply=false is used for list_runs (no full replies there).
 */
export function getRunSnapshot({ root, backend, runId, includeReply = true, tail = null }) {
  if (!isValidRunId(runId)) return null;
  const runDir = runDirFor(root, backend, runId);
  if (!fs.existsSync(runDir)) return null;
  const meta = readMeta(runDir);
  if (!meta) return null;
  const result = readResult(runDir);
  const state = resolveState({ meta, result, runDir });
  const startedAt = (result && result.started_at) || meta.started_at || null;
  const endedAt = (result && result.ended_at) || meta.ended_at || null;
  const reply = includeReply
    ? String(result && result.reply !== undefined && result.reply !== null ? result.reply : readText(runPaths(runDir).reply) || "")
    : "";
  const progress = readProgress(runDir);
  const chat = readChatState(runDir);
  const turns = Array.isArray(result && result.turns) && result.turns.length > 0 ? result.turns : readTurns(runDir);
  const idleMs = progress.last_output_at === null ? null : Math.max(0, Date.now() - progress.last_output_at);
  const graceRemainingMs = chat.grace_until === null ? null : Math.max(0, chat.grace_until - Date.now());
  const snapshot = {
    run_id: runId,
    backend,
    state,
    session_id: (result && result.session_id) || meta.session_id || null,
    reply,
    exit_code: result && Object.prototype.hasOwnProperty.call(result, "exit_code") ? result.exit_code : null,
    error: result && result.error ? redact(String(result.error)) : null,
    model: meta.model || null,
    effort: meta.effort || null,
    access: meta.access || null,
    cwd: meta.cwd || null,
    created_at: meta.created_at || null,
    started_at: startedAt,
    ended_at: endedAt,
    duration_s: computeDuration(startedAt, endedAt),
    usage: (result && result.usage) || null,
    run_dir: runDir,
    stderr_tail: redact(tailText(runPaths(runDir).stderr, 4000)),
    // Stall-detection fields (runner-maintained, throttled to <= 1 write/s).
    last_output_at: progress.last_output_at === null ? null : new Date(progress.last_output_at).toISOString(),
    stdout_bytes: progress.stdout_bytes,
    event_count: progress.event_count,
    last_event: progress.last_event,
    idle_s: idleMs === null ? null : Math.round(idleMs / 100) / 10,
    stall_s: Number.isFinite(Number(meta.stall_s)) && Number(meta.stall_s) > 0 ? Number(meta.stall_s) : null,
    // Chat mode (both backends): conversation turns + grace window state.
    chat: chat.chat || meta.chat === true,
    inflight: chat.inflight,
    turns,
    grace_until: chat.grace_until === null ? null : new Date(chat.grace_until).toISOString(),
    grace_remaining_s: graceRemainingMs === null ? null : Math.round(graceRemainingMs / 100) / 10,
    stdin_closed: chat.stdin_closed,
    max_turns: chat.max_turns,
    turns_used: chat.turns_used,
    turns_remaining: chat.turns_remaining,
    max_turns_reached: chat.max_turns_reached,
  };
  if (tail !== null) snapshot.tail = readTailLines(runPaths(runDir).stdout, tail).map((line) => redact(line));
  return snapshot;
}

export const TURN_REPLY_LIMIT = 20000;

/** One conversation turn as returned by tools (reply capped, disk copy is complete). */
export function formatTurn(turn) {
  if (!turn || typeof turn !== "object") return turn;
  const reply = typeof turn.reply === "string" ? turn.reply : "";
  const out = {
    user_text: typeof turn.user_text === "string" ? turn.user_text : "",
    source: turn.source === "window" ? "window" : "caller",
    status: typeof turn.status === "string" ? turn.status : null,
    duration_s: typeof turn.duration_s === "number" ? turn.duration_s : null,
    at: typeof turn.at === "string" ? turn.at : null,
    reply,
  };
  if (reply.length > TURN_REPLY_LIMIT) {
    out.reply = reply.slice(0, TURN_REPLY_LIMIT);
    out.reply_truncated = true;
  }
  return out;
}

export function formatToolPayload(snapshot) {
  if (!snapshot) return null;
  const { reply, reply_truncated } = truncateReply(snapshot.reply);
  const payload = {
    run_id: snapshot.run_id,
    backend: snapshot.backend,
    state: snapshot.state,
    session_id: snapshot.session_id || null,
    reply,
    exit_code: snapshot.exit_code === undefined ? null : snapshot.exit_code,
    error: snapshot.error || null,
    model: snapshot.model || null,
    effort: snapshot.effort || null,
    access: snapshot.access || null,
    cwd: snapshot.cwd || null,
    started_at: snapshot.started_at || null,
    ended_at: snapshot.ended_at || null,
    duration_s: snapshot.duration_s,
    usage: snapshot.usage || null,
    run_dir: snapshot.run_dir,
    stderr_tail: snapshot.stderr_tail || "",
    reply_truncated,
    last_output_at: snapshot.last_output_at === undefined ? null : snapshot.last_output_at,
    stdout_bytes: snapshot.stdout_bytes === undefined ? 0 : snapshot.stdout_bytes,
    event_count: snapshot.event_count === undefined ? 0 : snapshot.event_count,
    last_event: snapshot.last_event === undefined ? null : snapshot.last_event,
    idle_s: snapshot.idle_s === undefined ? null : snapshot.idle_s,
    stall_s: snapshot.stall_s === undefined ? null : snapshot.stall_s,
    chat: snapshot.chat === true,
    inflight: snapshot.inflight === true,
    turns: (snapshot.turns || []).map((turn) => formatTurn(turn)),
    grace_until: snapshot.grace_until === undefined ? null : snapshot.grace_until,
    grace_remaining_s: snapshot.grace_remaining_s === undefined ? null : snapshot.grace_remaining_s,
    stdin_closed: snapshot.stdin_closed === true,
    max_turns: snapshot.max_turns === undefined ? null : snapshot.max_turns,
    turns_used: snapshot.turns_used === undefined ? 0 : snapshot.turns_used,
    turns_remaining: snapshot.turns_remaining === undefined ? null : snapshot.turns_remaining,
    max_turns_reached: snapshot.max_turns_reached === true,
  };
  if (snapshot.created_at) payload.created_at = snapshot.created_at;
  if (Array.isArray(snapshot.tail)) payload.tail = snapshot.tail;
  return payload;
}

function listFields(snapshot) {
  return {
    run_id: snapshot.run_id,
    backend: snapshot.backend,
    state: snapshot.state,
    session_id: snapshot.session_id || null,
    exit_code: snapshot.exit_code === undefined ? null : snapshot.exit_code,
    error: snapshot.error || null,
    model: snapshot.model || null,
    effort: snapshot.effort || null,
    access: snapshot.access || null,
    cwd: snapshot.cwd || null,
    created_at: snapshot.created_at || null,
    started_at: snapshot.started_at || null,
    ended_at: snapshot.ended_at || null,
    duration_s: snapshot.duration_s,
    run_dir: snapshot.run_dir,
  };
}

export function listRuns({ root, backend, limit = 20, state = null }) {
  let entries = [];
  try {
    entries = fs.readdirSync(runsRoot(root, backend), { withFileTypes: true });
  } catch {
    entries = [];
  }
  const collected = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isValidRunId(entry.name)) continue;
    const snapshot = getRunSnapshot({ root, backend, runId: entry.name, includeReply: false, tail: null });
    if (!snapshot) continue;
    if (state && snapshot.state !== state) continue;
    collected.push(listFields(snapshot));
  }
  collected.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
  const runs = collected.slice(0, limit);
  return { runs, count: runs.length, total: collected.length };
}

export function findActiveRunBySession({ root, backend, sessionId }) {
  if (!sessionId) return null;
  const listing = listRuns({ root, backend, limit: 1000 });
  for (const entry of listing.runs) {
    if (entry.session_id !== sessionId) continue;
    if (!ACTIVE_STATES.has(entry.state)) continue;
    return { run_id: entry.run_id, state: entry.state, run_dir: entry.run_dir };
  }
  return null;
}

export function writeSupervisor(runDir, supervisor) {
  writeJsonAtomic(runPaths(runDir).supervisor, supervisor);
}

export function writeHeartbeat(runDir, extra = {}) {
  writeJsonAtomic(runPaths(runDir).heartbeat, { at: Date.now(), pid: process.pid, ...extra });
}

export function hasCancelRequest(runDir) {
  return fs.existsSync(runPaths(runDir).cancel);
}

export function writeCancelRequest(runDir, extra = {}) {
  writeJsonAtomic(runPaths(runDir).cancel, { requested_at: new Date().toISOString(), requested_by_pid: process.pid, ...extra });
}

export function signalProcessGroup(pgid, signal) {
  if (!Number.isInteger(pgid) || pgid <= 0) return false;
  try {
    if (process.platform === "win32") {
      if (signal === "SIGKILL" || signal === "SIGTERM") {
        spawnSync("taskkill", ["/pid", String(pgid), "/T", "/F"], { stdio: "ignore", timeout: 5000 });
        return true;
      }
      return false;
    }
    process.kill(-pgid, signal);
    return true;
  } catch {
    try {
      process.kill(pgid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Finalize a run exactly once. The first writer (runner or cancel fallback)
 * wins thanks to the exclusive hard-link create.
 */
export function finalizeRun({ runDir, patch }) {
  const paths = runPaths(runDir);
  const existing = readResult(runDir);
  if (existing) return existing;
  const meta = readMeta(runDir) || {};
  const endedAt = patch.ended_at || new Date().toISOString();
  const startedAt = patch.started_at || meta.started_at || null;
  const result = {
    run_id: meta.run_id || null,
    backend: meta.backend || null,
    state: patch.state,
    session_id: patch.session_id !== undefined ? patch.session_id : meta.session_id || null,
    reply: patch.reply === undefined || patch.reply === null ? "" : String(patch.reply),
    exit_code: patch.exit_code === undefined ? null : patch.exit_code,
    error: patch.error === undefined || patch.error === null ? null : redact(String(patch.error)),
    usage: patch.usage === undefined ? null : patch.usage,
    turns: Array.isArray(patch.turns) ? patch.turns : undefined,
    chat: patch.chat === true ? true : undefined,
    started_at: startedAt,
    ended_at: endedAt,
    duration_s: computeDuration(startedAt, endedAt),
    created_at: meta.created_at || null,
  };
  const stored = writeJsonIfAbsent(paths.result, result);
  if (meta && Object.keys(meta).length > 0) {
    meta.state = (stored && stored.state) || result.state;
    meta.ended_at = endedAt;
    if (stored && stored.session_id) meta.session_id = stored.session_id;
    writeJsonAtomic(paths.meta, meta);
  }
  return stored || result;
}

/**
 * Cancel semantics: write intent, SIGTERM the CLI process group, wait up to
 * waitMs, then SIGKILL. Already-terminal runs are returned untouched.
 */
/**
 * True when the recorded CLI process is still alive *and* is the same process
 * we started (start token match). Conversations can spend time between turns
 * with no process at all, so callers must check before signalling.
 */
export function isChildStillOurs(meta) {
  const pid = Number(meta && meta.child_pid);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (!isPidAlive(pid)) return false;
  const recorded = typeof meta.child_start === "string" && meta.child_start ? meta.child_start : null;
  if (!recorded) return true;
  const current = processStartToken(pid);
  return !current || current === recorded;
}

export async function cancelRun({ root, backend, runId, waitMs = 6000 }) {
  if (!isValidRunId(runId)) return { found: false, invalid: true };
  const runDir = runDirFor(root, backend, runId);
  if (!fs.existsSync(runDir)) return { found: false };
  let snapshot = getRunSnapshot({ root, backend, runId, includeReply: true });
  if (!snapshot) return { found: false };
  if (TERMINAL_STATES.has(snapshot.state)) return { found: true, snapshot, alreadyTerminal: true };

  writeCancelRequest(runDir, { reason: "cancel tool" });
  const meta = readMeta(runDir) || {};
  const pgid = Number(meta.child_pgid);
  const pid = Number(meta.child_pid);
  // A conversation keeps the run alive between turns (codex has no process in
  // that window); never signal a pid that already exited or was reused.
  const childAlive = isChildStillOurs(meta);
  if (childAlive && Number.isInteger(pgid) && pgid > 0) {
    signalProcessGroup(pgid, "SIGTERM");
  } else if (childAlive && Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // ignore
    }
  }

  const deadline = Date.now() + Math.max(0, waitMs);
  while (Date.now() < deadline) {
    if (readResult(runDir)) {
      return { found: true, snapshot: getRunSnapshot({ root, backend, runId, includeReply: true }) };
    }
    await delay(200);
  }

  if (isChildStillOurs(meta) && Number.isInteger(pgid) && pgid > 0) signalProcessGroup(pgid, "SIGKILL");
  if (isChildStillOurs(meta) && Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // ignore
    }
  }
  await delay(400);

  if (!readResult(runDir)) {
    finalizeRun({
      runDir,
      patch: {
        state: "cancelled",
        reply: "",
        exit_code: null,
        error: "cancelled by user",
        started_at: meta.started_at || null,
        ended_at: new Date().toISOString(),
      },
    });
  }
  return { found: true, snapshot: getRunSnapshot({ root, backend, runId, includeReply: true }) };
}
