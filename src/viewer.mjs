#!/usr/bin/env node
/**
 * cli-baton live run viewer.
 *
 *   node src/viewer.mjs <run_dir>
 *
 * Follows `<run_dir>/stdout.jsonl` and `<run_dir>/stderr.log` as they grow and
 * renders the raw backend events (agy `stream-json` NDJSON, or codex `--json`
 * JSONL) as human-readable progress. It exits 0 by itself once the run reaches
 * a terminal state (completed / failed / cancelled / timed_out / interrupted).
 *
 * The runner opens this in a new Terminal window on macOS; it is also safe to
 * run by hand, at any time, on a run that is already finished (it replays the
 * stdout.jsonl events and then prints the final state).
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";

import * as runs from "./runs.mjs";
import * as chat from "./chat.mjs";

export const DEFAULT_POLL_MS = 500;
export const DEFAULT_IDLE_MS = 5000;
export const DEFAULT_INTERRUPT_GRACE_MS = 5000;
export const CLEAR_LINE = "\u001b[2K\r";

const ANSI = {
  reset: "\u001b[0m",
  dim: "\u001b[2m",
  bold: "\u001b[1m",
  red: "\u001b[31m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  cyan: "\u001b[36m",
};

const TERMINAL_STATES = runs.TERMINAL_STATES;

/* ------------------------------------------------------------------ *
 * formatting helpers
 * ------------------------------------------------------------------ */

export function formatClock(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds());
}

export function formatSeconds(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value >= 10 ? String(Math.round(value)) + "s" : value.toFixed(1) + "s";
}

export function summarizeValue(value, maxLength = 220) {
  let text;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  text = String(text === undefined || text === null ? "" : text)
    .replace(/\s+/g, " ")
    .trim();
  return text.length > maxLength ? text.slice(0, maxLength) + "…" : text;
}

export function shortId(value) {
  const text = String(value || "");
  return text.length > 12 ? text.slice(0, 8) + "…" : text;
}

/**
 * Normalize the usage object of either backend into "in=… out=… total=…".
 * Returns null when nothing usable is present.
 */
export function formatTokens(usage) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const num = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
  const input = num(usage.input_tokens) ?? num(usage.prompt_tokens) ?? num(usage.input);
  const output = num(usage.output_tokens) ?? num(usage.completion_tokens) ?? num(usage.output);
  const total = num(usage.total_tokens) ?? (input !== null || output !== null ? (input || 0) + (output || 0) : null);
  const parts = [];
  if (input !== null) parts.push("in=" + input);
  if (output !== null) parts.push("out=" + output);
  if (total !== null) parts.push("total=" + total);
  for (const [label, key] of [
    ["cached", "cached_input_tokens"],
    ["reasoning", "reasoning_output_tokens"],
  ]) {
    const value = num(usage[key]);
    if (value !== null && value !== 0) parts.push(label + "=" + value);
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ *
 * event rendering
 * ------------------------------------------------------------------ */

const TOOL_STEP_RE = /(tool|command|exec|shell|terminal|read|write|edit|patch|apply|search|browse|fetch|grep|glob)/i;
const TOOL_NAME_KEYS = ["tool_name", "toolName", "function_name", "name", "tool", "title"];

/** Best-effort tool name for an agy step_update (or any object). */
export function toolNameOf(step) {
  if (!step || typeof step !== "object") return null;
  for (const key of TOOL_NAME_KEYS) {
    const value = step[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if (typeof value.name === "string" && value.name.trim()) return value.name.trim();
    }
  }
  for (const [key, value] of Object.entries(step)) {
    if (!/tool|function/i.test(key)) continue;
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/**
 * Stateful renderer: feed it one raw line at a time, write whatever it returns
 * to the terminal. Delta text comes back without a trailing newline so the
 * streamed answer reads like normal prose; markers always start on their own
 * line.
 */
export function createRenderer({ color = false, now = () => new Date(), timestamp = true } = {}) {
  const stepSignatures = new Map();
  let atLineStart = true;

  const paint = (name, text) => (color && ANSI[name] ? ANSI[name] + text + ANSI.reset : text);

  const stamp = () => {
    if (!timestamp) return "";
    return paint("dim", "[" + formatClock(now()) + "]") + " ";
  };

  const marker = (kind, detail, colorName = "cyan") => {
    const prefix = atLineStart ? "" : "\n";
    atLineStart = true;
    let arrow = "";
    if (kind === "error" || kind === "turn.failed") arrow = "✗ ";
    else if (kind === "stderr") arrow = "! ";
    else if (kind === "raw" || kind === "json") arrow = "· ";
    else arrow = "→ ";
    return prefix + stamp() + paint(colorName, arrow + kind) + (detail ? " · " + detail : "") + "\n";
  };

  const prose = (text) => {
    if (!text) return "";
    atLineStart = /[\n\r]$/.test(text);
    return text;
  };

  function stepUpdate(step) {
    const index = Number.isInteger(step.step_index) ? step.step_index : null;
    const type = typeof step.step_type === "string" ? step.step_type : "step";
    const state = typeof step.state === "string" ? step.state : "";
    const toolName = toolNameOf(step);
    const delta = typeof step.text_delta === "string" ? step.text_delta : "";

    const key = index === null ? type : String(index);
    const signature = [state, type, toolName || ""].join("|");
    const changed = stepSignatures.get(key) !== signature;
    if (changed) stepSignatures.set(key, signature);

    const looksLikeTool = TOOL_STEP_RE.test(type) || Boolean(toolName);
    const starting = !state || /ACTIVE|RUNNING|STARTED|PENDING|IN_PROGRESS|QUEUED/i.test(state);
    const duration = typeof step.duration_seconds === "number" ? formatSeconds(step.duration_seconds) : null;

    const markerText = () => {
      if (looksLikeTool) {
        const parts = [toolName || type];
        if (toolName && type && type !== toolName) parts.push(type);
        if (state) parts.push(state);
        if (duration) parts.push(duration);
        return marker("tool", parts.join(" · "), "yellow");
      }
      const parts = [type];
      if (state) parts.push(state);
      if (duration) parts.push(duration);
      return marker(index === null ? "step" : "step " + index, parts.join(" · "), "cyan");
    };

    // A step that starts prints its marker before its text; a step that ends
    // prints the last delta first so the completion marker closes the prose.
    let text = "";
    if (changed && starting) text += markerText();
    if (delta) text += prose(delta);
    if (changed && !starting) text += markerText();
    return text;
  }

  function agyEvent(value) {
    const event = value.event;
    if (event === "init") {
      const init = value.init && typeof value.init === "object" && !Array.isArray(value.init) ? value.init : {};
      const parts = [];
      if (init.model) parts.push("model=" + init.model);
      if (init.cwd) parts.push("cwd=" + init.cwd);
      if (Array.isArray(init.tools)) parts.push("tools=" + init.tools.length);
      if (init.permission_mode) parts.push("permission=" + init.permission_mode);
      if (value.conversation_id) parts.push("conversation=" + shortId(value.conversation_id));
      return marker("init", parts.join(" · "));
    }
    if (event === "step_update") {
      const step = value.step_update;
      if (!step || typeof step !== "object" || Array.isArray(step)) return marker("step_update", summarizeValue(value));
      return stepUpdate(step);
    }
    if (event === "result") {
      const result = value.result && typeof value.result === "object" && !Array.isArray(value.result) ? value.result : {};
      const parts = [];
      if (result.status) parts.push("status=" + result.status);
      if (typeof result.duration_seconds === "number") parts.push("用时=" + formatSeconds(result.duration_seconds));
      const tokens = formatTokens(result.usage);
      if (tokens) parts.push("tokens " + tokens);
      if (typeof result.num_turns === "number") parts.push("turns=" + result.num_turns);
      if (result.error) parts.push("error=" + summarizeValue(result.error, 120));
      return marker("result", parts.join(" · "), "green");
    }
    if (event === "user_rejected") {
      return marker("已拒绝 · 轮数上限", summarizeValue(value.text, 200), "red");
    }
    if (event === "user_injected") {
      const source = value.source === "window" ? "窗口" : "调用方";
      return marker("插话 · " + source, summarizeValue(value.text, 200), "yellow");
    }
    if (event === "error") {
      return marker("error", summarizeValue(value.error || value.message || value, 200), "red");
    }
    return marker(String(event), summarizeValue(value, 200));
  }

  function codexEvent(value) {
    const type = value.type;
    if (type === "thread.started") return marker("session", shortId(value.thread_id));
    if (type === "turn.started") return marker("turn", "started");
    if (type === "turn.completed") {
      const tokens = formatTokens(value.usage);
      return marker("turn", "completed" + (tokens ? " · tokens " + tokens : ""), "green");
    }
    if (type === "turn.failed") {
      const detail = value.error && (value.error.message || value.error.type);
      return marker("turn.failed", summarizeValue(detail || value.message || "turn failed", 200), "red");
    }
    if (type === "error") return marker("warning", summarizeValue(value.message || value, 200), "yellow");
    if (type === "item.started" || type === "item.updated" || type === "item.completed") {
      const item = value.item && typeof value.item === "object" && !Array.isArray(value.item) ? value.item : {};
      const itemType = typeof item.type === "string" ? item.type : "item";
      if (itemType === "agent_message") {
        if (type !== "item.completed" || typeof item.text !== "string" || !item.text) return "";
        const prefix = atLineStart ? "" : "\n";
        return prefix + prose(item.text.endsWith("\n") ? item.text : item.text + "\n");
      }
      if (itemType === "reasoning" || itemType === "reasoning_content") {
        return marker("reasoning", summarizeValue(item.text || item.summary || item, 200), "dim");
      }
      if (itemType === "command_execution") {
        return marker("tool", summarizeValue(item.command || item.name || item, 200), "yellow");
      }
      if (itemType === "mcp_tool_call" || itemType === "tool_call" || itemType === "function_call") {
        const name = item.name || item.tool || item.server;
        return marker("tool", summarizeValue(name || item, 200), "yellow");
      }
      if (itemType === "file_change") {
        const files = Array.isArray(item.changes)
          ? item.changes.map((change) => (change && (change.path || change.file)) || "").filter(Boolean)
          : [];
        return marker("file", summarizeValue(files.length > 0 ? files.join(", ") : item, 200), "yellow");
      }
      if (itemType === "error") return marker("error", summarizeValue(item.message || item, 200), "red");
      return marker("item", itemType + " · " + summarizeValue(item, 180));
    }
    return marker("codex", type + " · " + summarizeValue(value, 180));
  }

  return {
    /** Render one raw line from stdout.jsonl. Returns text to write (maybe ""). */
    line(rawLine) {
      const raw = rawLine === undefined || rawLine === null ? "" : String(rawLine);
      if (!raw.trim()) return "";
      const value = tryParseJson(raw.trim());
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return marker("raw", summarizeValue(raw.trim(), 240));
      }
      if (typeof value.event === "string") return agyEvent(value);
      if (typeof value.type === "string") return codexEvent(value);
      return marker("json", summarizeValue(value, 200));
    },
    /** Render one raw line from stderr.log. */
    stderr(rawLine) {
      const raw = String(rawLine === undefined || rawLine === null ? "" : rawLine).trim();
      if (!raw) return "";
      return marker("stderr", summarizeValue(raw, 240), "red");
    },
    /** Close a dangling delta line (used before status/final lines). */
    flush() {
      if (atLineStart) return "";
      atLineStart = true;
      return "\n";
    },
    get atLineStart() {
      return atLineStart;
    },
  };
}

/** Header block shown once at startup: backend, model, effort, cwd, run id. */
export function renderHeader({ meta = {}, runDir = "", backend = null } = {}) {
  const lines = [];
  const effectiveBackend = meta.backend || backend || "?";
  const runId = meta.run_id || path.basename(String(runDir || ""));
  lines.push("cli-baton · " + effectiveBackend + " · run " + runId);
  const fields = [
    ["backend", effectiveBackend],
    ["model", meta.model || "(cli default)"],
    ["effort", meta.effort || "(cli default)"],
    ["access", meta.access || "(default)"],
    ["cwd", meta.cwd || "(unknown)"],
    ["state", meta.state || "queued"],
    ["run_dir", runDir || meta.run_dir || ""],
  ];
  for (const [key, value] of fields) lines.push("  " + key.padEnd(8) + " " + String(value));
  lines.push("─".repeat(64));
  return lines.join("\n") + "\n";
}

/**
 * Bottom status line, refreshed while the run is silent.
 * Example: 仍在运行，已 12s 无新输出，进程 pid 4242 存活（心跳 1s 前）
 */
export function formatStatusLine({ idleSeconds = 0, childPid = null, childAlive = false, heartbeatAgeSeconds = null, state = null } = {}) {
  const idle = Math.max(0, Math.round(Number(idleSeconds) || 0));
  const parts = ["仍在运行，已 " + idle + "s 无新输出"];
  if (Number.isInteger(childPid) && childPid > 0) {
    parts.push("进程 pid " + childPid + (childAlive ? " 存活" : " 已退出"));
  } else {
    parts.push(childAlive ? "进程存活" : "进程 pid 未知");
  }
  if (Number.isFinite(heartbeatAgeSeconds)) {
    parts.push("心跳 " + Math.max(0, Math.round(heartbeatAgeSeconds)) + "s 前");
  }
  if (state) parts.push("state=" + state);
  return parts.join("，");
}

/** Final line printed right before the viewer exits. */
export function formatFinalLine({ state, result = {}, meta = {} } = {}) {
  const parts = [String(state || meta.state || "unknown")];
  const duration = result.duration_s;
  if (typeof duration === "number") parts.push("用时 " + formatSeconds(duration));
  if (result.exit_code !== undefined && result.exit_code !== null) parts.push("exit=" + result.exit_code);
  const tokens = formatTokens(result.usage);
  if (tokens) parts.push("tokens " + tokens);
  const reply = typeof result.reply === "string" ? result.reply : "";
  parts.push("reply " + reply.length + " 字符");
  let text = "运行结束 · " + parts.join(" · ") + "\n";
  if (result.error) text += "error: " + summarizeValue(result.error, 500) + "\n";
  else if (state === "interrupted") text += "error: runner 已退出且没有 result.json（interrupted）\n";
  return text;
}

/** "已发送" vs "已排队（当前 turn 结束后执行）" vs "对话已收尾，未发送". */
export function formatInboxAck({ inflight = false, stdinClosed = false } = {}) {
  if (stdinClosed) return "对话已收尾，未发送（请新开一个 run）";
  return inflight ? "已排队（当前 turn 结束后执行）" : "已发送";
}

/** Whether this run should offer the interactive input line. */
export function shouldEnableInput({ isTTY = false, interactive = null, chat = false, maxTurnsReached = false } = {}) {
  if (!chat) return false;
  if (maxTurnsReached) return false; // at the cap the input box is disabled
  return interactive === null ? Boolean(isTTY) : Boolean(interactive);
}

/** Shown in place of the input box once the conversation used all its turns. */
export function formatMaxTurnsLine({ maxTurns = 2 } = {}) {
  return "本段对话已达 " + maxTurns + " 轮上限，请让 Claude 开新对话";
}

/**
 * Append one message to the run's inbox (what the viewer's input line does).
 * Returns { ok, ack, at } — never throws.
 */
export function submitInput({ runDir, text, inflight = false, stdinClosed = false, source = "window", at = null } = {}) {
  const value = String(text === undefined || text === null ? "" : text);
  if (!value.trim()) return { ok: false, ack: "内容为空，未发送", at: null };
  // The runner stops reading the inbox once stdin is closed; sending anyway would
  // look successful and silently drop the message.
  if (stdinClosed) return { ok: false, ack: formatInboxAck({ stdinClosed: true }), at: null };
  try {
    const entry = chat.appendInboxLine(runDir, { text: value, at: at || new Date().toISOString(), source });
    return { ok: true, ack: formatInboxAck({ inflight }), at: entry.at };
  } catch (error) {
    return { ok: false, ack: "发送失败：" + String((error && error.message) || error), at: null };
  }
}

/** What the readline callback does; exported so it can be tested without a TTY. */
export function handleViewerInput({ runDir, text, state = {} } = {}) {
  const value = String(text === undefined || text === null ? "" : text).trim();
  if (!value) return { ok: false, ack: "内容为空，未发送", at: null };
  return submitInput({
    runDir,
    text: value,
    inflight: state.inflight === true,
    stdinClosed: state.stdin_closed === true,
    source: "window",
  });
}

/** Countdown line shown while the run waits for the next message. */
export function formatGraceLine({ remainingS = 0 } = {}) {
  const seconds = Math.max(0, Math.ceil(Number(remainingS) || 0));
  return "完成；" + seconds + " 秒内输入可继续对话，否则自动关闭";
}

/* ------------------------------------------------------------------ *
 * tail reader
 * ------------------------------------------------------------------ */

/**
 * Incremental line reader for an append-only file. Returns only complete
 * lines; a trailing partial line is kept until its newline arrives.
 */
export function createTailReader(file) {
  let offset = 0;
  let buffer = "";
  return {
    read() {
      let fd;
      try {
        fd = fs.openSync(file, "r");
      } catch {
        return [];
      }
      try {
        const size = fs.fstatSync(fd).size;
        if (size < offset) {
          offset = 0;
          buffer = "";
        }
        if (size === offset) return [];
        const length = size - offset;
        const chunk = Buffer.allocUnsafe(length);
        const read = fs.readSync(fd, chunk, 0, length, offset);
        offset += read;
        buffer += chunk.toString("utf8", 0, read);
      } catch {
        return [];
      } finally {
        try {
          fs.closeSync(fd);
        } catch {
          // ignore
        }
      }
      const parts = buffer.split(/\r?\n/);
      buffer = parts.pop();
      return parts;
    },
    reset() {
      offset = 0;
      buffer = "";
    },
  };
}

/* ------------------------------------------------------------------ *
 * run state
 * ------------------------------------------------------------------ */

export function readRunViewState({ runDir, startedAt = Date.now(), interruptGraceMs = DEFAULT_INTERRUPT_GRACE_MS, now = () => Date.now() } = {}) {
  const paths = runs.runPaths(runDir);
  const meta = runs.readJson(paths.meta) || {};
  const result = runs.readJson(paths.result);
  if (result && typeof result.state === "string" && TERMINAL_STATES.has(result.state)) {
    return { state: result.state, meta, result, terminal: true };
  }
  if (meta.state && TERMINAL_STATES.has(meta.state)) {
    return { state: meta.state, meta, result, terminal: true };
  }
  const resolved = runs.resolveState({ meta, result, runDir });
  if (resolved === "interrupted") {
    const supervisorSeen = fs.existsSync(paths.supervisor);
    if (supervisorSeen || now() - startedAt >= interruptGraceMs) {
      return { state: "interrupted", meta, result, terminal: true };
    }
    return { state: meta.state || "queued", meta, result, terminal: false };
  }
  return { state: resolved, meta, result, terminal: false };
}

export function heartbeatInfo(runDir) {
  const heartbeat = runs.readJson(runs.runPaths(runDir).heartbeat) || {};
  const at = Number(heartbeat.at);
  return {
    ageSeconds: Number.isFinite(at) ? Math.max(0, (Date.now() - at) / 1000) : null,
    pid: Number.isInteger(heartbeat.child_pid) ? heartbeat.child_pid : null,
  };
}

/** The viewer records its own pid so the runner can stop it before closing the window. */
export function adoptViewerFile(runDir, pid = process.pid) {
  try {
    if (!fs.existsSync(runs.runPaths(runDir).viewer)) return null;
    return runs.mergeViewerInfo(runDir, {
      pid,
      // Start token lets the runner refuse to signal a reused pid when it stops
      // the viewer before closing the window.
      pid_start: runs.processStartToken(pid),
      viewer_started_at: new Date().toISOString(),
    });
  } catch {
    return null;
  }
}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ *
 * main loop
 * ------------------------------------------------------------------ */

/**
 * Follow one run until it reaches a terminal state.
 * Returns the process exit code (0 on terminal state, 1 on a non-run dir,
 * 2 on bad usage). Every dependency is injectable so tests can drive it
 * without spawning a process or waiting on wall-clock timers.
 */
export async function runViewer({
  runDir,
  out = process.stdout,
  err = process.stderr,
  env = process.env,
  color = null,
  pollMs = Number(env.CLI_BATON_VIEWER_POLL_MS) > 0 ? Number(env.CLI_BATON_VIEWER_POLL_MS) : DEFAULT_POLL_MS,
  idleMs = Number(env.CLI_BATON_VIEWER_IDLE_MS) > 0 ? Number(env.CLI_BATON_VIEWER_IDLE_MS) : DEFAULT_IDLE_MS,
  interruptGraceMs = DEFAULT_INTERRUPT_GRACE_MS,
  now = () => Date.now(),
  sleep = realSleep,
  maxPolls = Infinity,
  interactive = null,
  input = process.stdin,
} = {}) {
  if (!runDir) {
    err.write("用法: node src/viewer.mjs <run_dir>\n");
    return 2;
  }
  const resolvedDir = path.resolve(String(runDir));
  const paths = runs.runPaths(resolvedDir);
  const initialMeta = runs.readMeta(resolvedDir);
  if (!initialMeta) {
    err.write("cli-baton viewer: not a run directory (meta.json missing): " + resolvedDir + "\n");
    return 1;
  }

  const useColor = color === null ? Boolean(out.isTTY) && !env.NO_COLOR : Boolean(color);
  const startedAt = now();
  const viewerInfo = adoptViewerFile(resolvedDir);
  const backend = initialMeta.backend || (viewerInfo && viewerInfo.backend) || null;

  out.write(renderHeader({ meta: initialMeta, runDir: resolvedDir, backend }));

  const renderer = createRenderer({ color: useColor, now: () => new Date(now()) });
  const stdoutTail = createTailReader(paths.stdout);
  const stderrTail = createTailReader(paths.stderr);

  let lastOutputAt = now();
  let lastStatusAt = 0;
  let statusVisible = false;
  let lastGraceSecond = null;
  let capNoticeShown = false;

  /**
   * Bottom transient line. With a piped stdout we redraw in place (stable,
   * asserted by tests); with a live readline prompt we print it as its own line
   * and redraw the prompt, otherwise readline's prompt() would overwrite it.
   */
  const transientLine = (text) => {
    if (rl) {
      // Drop the drawn prompt first, otherwise it prefixes this line.
      out.write("\r" + CLEAR_LINE + text + "\n");
      rl.prompt(true);
      return;
    }
    out.write("\r" + CLEAR_LINE + text);
    statusVisible = true;
  };

  const rawWrite = (text) => {
    if (!text) return;
    out.write(text);
  };
  // Real run output: hides a stale status line first, and restarts the idle clock.
  const write = (text) => {
    if (!text) return;
    if (statusVisible) {
      out.write("\r" + CLEAR_LINE);
      statusVisible = false;
    }
    out.write(text);
    lastOutputAt = now();
    // Keep the interactive prompt at the bottom after complete lines only;
    // mid-line deltas would interleave badly with a redrawn "> " prompt.
    if (rl && /[\n\r]$/.test(text)) rl.prompt(true);
  };

  // Interactive input line: only on a TTY and only for a conversation run —
  // one-shot runs have nobody reading their inbox.
  const chatRun = initialMeta.chat === true || runs.readChatState(resolvedDir).chat === true;
  const wantsInput = shouldEnableInput({
    isTTY: Boolean(input && input.isTTY && input === process.stdin),
    interactive,
    chat: chatRun,
    maxTurnsReached: runs.readChatState(resolvedDir).max_turns_reached === true,
  });
  let rl = null;
  if (wantsInput) {
    rl = readline.createInterface({ input, output: out, terminal: true });
    rl.setPrompt("> ");
    rl.on("line", (line) => {
      const text = String(line || "").trim();
      if (!text) {
        rl.prompt();
        return;
      }
      const state = runs.readChatState(resolvedDir);
      if (state.max_turns_reached) {
        out.write("\n" + formatMaxTurnsLine({ maxTurns: state.max_turns || 2 }) + "\n");
        rl.prompt();
        return;
      }
      // A cancelled/timed-out run never publishes stdin_closed; its result.json
      // is the reliable "nobody is reading" signal.
      const finished = runs.readResult(resolvedDir) !== null;
      const result = handleViewerInput({ runDir: resolvedDir, text, state: { ...state, stdin_closed: state.stdin_closed || finished } });
      out.write("\n" + result.ack + "\n");
      rl.prompt();
    });
    rl.prompt();
  }


  let polls = 0;
  while (polls < maxPolls) {
    polls += 1;
    for (const line of stdoutTail.read()) write(renderer.line(line));
    for (const line of stderrTail.read()) write(renderer.stderr(line));

    const view = readRunViewState({ runDir: resolvedDir, startedAt, interruptGraceMs, now });
    if (view.terminal) {
      if (statusVisible) {
        out.write("\r" + CLEAR_LINE);
        statusVisible = false;
      }
      rawWrite(renderer.flush());
      out.write(formatFinalLine({ state: view.state, result: view.result || {}, meta: view.meta || {} }));
      if (rl) rl.close();
      return 0;
    }

    // Chat grace countdown replaces the idle line: the run is idle on purpose
    // and the user has a limited window to keep the conversation going.
    const chatState = runs.readChatState(resolvedDir);
    if (chatState.max_turns_reached && !capNoticeShown) {
      capNoticeShown = true;
      rawWrite(renderer.flush());
      transientLine(formatMaxTurnsLine({ maxTurns: chatState.max_turns || 2 }));
    }
    if (chatState.grace_until !== null) {
      const remaining = Math.max(0, (chatState.grace_until - now()) / 1000);
      const seconds = Math.ceil(remaining);
      lastStatusAt = now();
      if (seconds !== lastGraceSecond) {
        lastGraceSecond = seconds;
        rawWrite(renderer.flush());
        transientLine((useColor ? ANSI.yellow : "") + formatGraceLine({ remainingS: seconds }) + (useColor ? ANSI.reset : ""));
      }
      if (polls < maxPolls) await sleep(pollMs);
      continue;
    }
    if (lastGraceSecond !== null) {
      lastGraceSecond = null;
      if (statusVisible && !rl) {
        out.write("\r" + CLEAR_LINE);
        statusVisible = false;
      }
    }

    const idle = now() - lastOutputAt;
    if (idle >= idleMs && now() - lastStatusAt >= idleMs) {
      lastStatusAt = now();
      if (statusVisible) out.write("\r" + CLEAR_LINE);
      rawWrite(renderer.flush());
      const heartbeat = heartbeatInfo(resolvedDir);
      const meta = view.meta || {};
      const childPid = Number.isInteger(meta.child_pid) ? meta.child_pid : heartbeat.pid;
      const childAlive = Number.isInteger(childPid) ? runs.isPidAlive(childPid) : runs.isSupervisorAlive(resolvedDir);
      const line = formatStatusLine({
        idleSeconds: idle / 1000,
        childPid,
        childAlive,
        heartbeatAgeSeconds: heartbeat.ageSeconds,
        state: view.state,
      });
      transientLine((useColor ? ANSI.dim : "") + line + (useColor ? ANSI.reset : ""));
    }

    if (polls < maxPolls) await sleep(pollMs);
  }
  return 0;
}

/* ------------------------------------------------------------------ *
 * CLI entry
 * ------------------------------------------------------------------ */

export async function main(argv = process.argv.slice(2)) {
  const args = argv.filter((arg) => !arg.startsWith("--"));
  if (args.length === 0) {
    process.stderr.write("用法: node src/viewer.mjs <run_dir>\n");
    return 2;
  }
  const code = await runViewer({ runDir: args[0] });
  return code;
}

const invokedDirectly = (() => {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    return import.meta.url === pathToFileURL(path.resolve(entry)).href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      process.stderr.write("cli-baton viewer failed: " + String((error && error.stack) || error) + "\n");
      process.exit(1);
    });
}
