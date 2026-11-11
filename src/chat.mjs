/**
 * Conversation helpers shared by both backends.
 *
 * agy runs as a long-lived conversation:
 *
 *   agy --input-format stream-json --output-format stream-json ... -p=
 *
 * It reads one NDJSON message per turn from stdin and stays alive while stdin
 * is open. codex is one process per turn and resumes by thread id. Both are fed
 * from the run's inbox (`inbox.jsonl`), which the viewer and `<p>_say` append to.
 */
import fs from "node:fs";
import path from "node:path";

import * as runs from "./runs.mjs";

export const DEFAULT_GRACE_S = 20;
export const MAX_GRACE_S = 3600;
export const INBOX_POLL_MS = 200;
export const CHAT_SOURCES = ["caller", "window"];

export const DEFAULT_MAX_TURNS = { agy: 2, codex: Infinity };
export const AGY_MAX_TURNS_ENV = "CLI_BATON_AGY_MAX_TURNS";

/**
 * How many turns one conversation may use. agy defaults to 2 (initial message +
 * one follow-up); codex is unlimited. `0`, `unlimited` or `inf` disable the cap.
 * The count includes the caller prompt, the turns a resumed session already
 * used (counted as 1) and every pay/window message.
 */
export function maxTurnsFor(backendName, env = process.env) {
  if (backendName !== "agy") return Infinity;
  const raw = String(env && env[AGY_MAX_TURNS_ENV] !== undefined ? env[AGY_MAX_TURNS_ENV] : "").trim();
  if (!raw) return DEFAULT_MAX_TURNS.agy;
  if (/^(inf|infinity|unlimited|0)$/i.test(raw)) return Infinity;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_MAX_TURNS.agy;
  return Math.floor(value);
}

/** CLI_BATON_CHAT_GRACE_S: seconds to wait for another message after a turn. */
export function graceSeconds(env = process.env) {
  const raw = String(env && env.CLI_BATON_CHAT_GRACE_S !== undefined ? env.CLI_BATON_CHAT_GRACE_S : "").trim();
  if (!raw) return DEFAULT_GRACE_S;
  const value = Number(raw);
  if (!Number.isFinite(value)) return DEFAULT_GRACE_S;
  // Negative means "never wait" (same as 0) rather than silently reverting to 20s.
  return Math.min(MAX_GRACE_S, Math.max(0, Math.round(value * 1000) / 1000));
}

/**
 * Grace is only armed when a window exists (macOS + CLI_BATON_VIEWER not 0):
 * an unattended run must finish as soon as its last turn ends, exactly like
 * before chat mode existed.
 */
export function chatPolicy({ env = process.env, platform = process.platform, viewerEnabled = false } = {}) {
  const seconds = graceSeconds(env);
  // A grace window only makes sense where a window can exist at all.
  const enabled = platform === "darwin" && Boolean(viewerEnabled) && seconds > 0;
  return { enabled, grace_s: seconds, grace_ms: Math.round(seconds * 1000) };
}

export function normalizeSource(value) {
  return value === "window" ? "window" : "caller";
}

/** One stdin message for agy's stream-json input format. */
export function buildUserMessage(text) {
  return (
    JSON.stringify({
      event: "user",
      message: { content: [{ type: "text", text: String(text) }] },
    }) + "\n"
  );
}

/** Parse one inbox.jsonl line; returns null for blank/invalid/empty entries. */
export function parseInboxLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed) return null;
  let value;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (typeof value.text !== "string" || !value.text.trim()) return null;
  let at = typeof value.at === "string" && value.at ? value.at : null;
  if (!at) at = new Date().toISOString();
  return { text: value.text, at, source: normalizeSource(value.source) };
}

/** The stdout.jsonl event that records an injected message. */
export function formatInjectedEvent(entry) {
  return (
    JSON.stringify({
      event: "user_injected",
      text: entry.text,
      at: entry.at,
      source: normalizeSource(entry.source),
    }) + "\n"
  );
}

/**
 * Backend-agnostic conversation state machine shared by agy and codex.
 *
 * It owns the inbox queue, the turn list, and the grace window. The only
 * backend-specific part is `send(entry)`: agy writes to the live process's
 * stdin, codex starts a new `exec resume` process. `onDone(reason)` closes the
 * conversation (agy: end stdin; codex: finalize the run).
 */
export function createChatSession({
  enabled = false,
  maxTurns = Infinity,
  initialUsedTurns = 0,
  policy = { enabled: false, grace_s: 0, grace_ms: 0 },
  send = () => {},
  onDone = () => {},
  onTurn = () => {},
  onChange = () => {},
  log = () => {},
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let currentPolicy = policy;
  const turnCap = Number.isFinite(maxTurns) && maxTurns > 0 ? Math.floor(maxTurns) : Infinity;
  let usedTurns = Math.max(0, Math.floor(Number(initialUsedTurns) || 0));
  const maxTurnsReached = () => usedTurns >= turnCap;
  const state = {
    inflight: null,
    pending: [],
    turns: [],
    graceUntil: null,
    graceTimer: null,
    closed: false,
  };

  const info = () => ({
    chat: enabled,
    inflight: Boolean(state.inflight),
    graceUntil: state.graceUntil,
    turns: state.turns.length,
    closed: state.closed,
    maxTurns: Number.isFinite(turnCap) ? turnCap : null,
    usedTurns,
    remainingTurns: Number.isFinite(turnCap) ? Math.max(0, turnCap - usedTurns) : null,
    maxTurnsReached: maxTurnsReached(),
  });

  const clearGrace = () => {
    if (state.graceTimer) {
      clearTimer(state.graceTimer);
      state.graceTimer = null;
    }
    if (state.graceUntil !== null) {
      state.graceUntil = null;
      onChange(info());
    }
  };

  const close = (reason) => {
    if (state.closed) return;
    state.closed = true;
    clearGrace();
    onChange(info());
    log("conversation closed: " + reason);
    onDone(reason, info());
  };

  const startGrace = () => {
    if (!enabled || state.closed || state.graceUntil !== null) return;
    // At the cap the conversation is finished: no grace, no more input.
    if (maxTurnsReached()) {
      close("max turns reached");
      return;
    }
    if (!currentPolicy.enabled) {
      close("chat grace disabled");
      return;
    }
    const graceMs = currentPolicy.grace_ms;
    state.graceTimer = setTimer(() => {
      state.graceTimer = null;
      state.graceUntil = null;
      onChange(info());
      close("grace expired after " + graceMs / 1000 + "s");
    }, graceMs);
    if (state.graceTimer && typeof state.graceTimer.unref === "function") state.graceTimer.unref();
    state.graceUntil = now() + graceMs;
    onChange(info());
    log("waiting " + graceMs / 1000 + "s for the next message");
  };

  const pump = () => {
    if (!enabled || state.closed || state.inflight) return;
    const next = state.pending.shift();
    if (next) {
      state.inflight = next;
      clearGrace();
      onChange(info());
      send(next);
      return;
    }
    if (state.turns.length === 0) return;
    if (maxTurnsReached()) {
      close("max turns reached");
      return;
    }
    startGrace();
  };

  return {
    enabled,
    get closed() {
      return state.closed;
    },
    get turns() {
      return state.turns;
    },
    get pending() {
      return state.pending;
    },
    get inflight() {
      return state.inflight;
    },
    get policy() {
      return currentPolicy;
    },
    info,
    /** Queue one message and try to deliver it. False when closed or at the turn cap. */
    enqueue(entry) {
      if (!enabled || state.closed) return false;
      if (maxTurnsReached()) return false;
      usedTurns += 1;
      state.pending.push(entry);
      onChange(info());
      pump();
      return true;
    },
    canAccept() {
      return enabled && !state.closed && !maxTurnsReached();
    },
    get maxTurnsReached() {
      return maxTurnsReached();
    },
    get maxTurns() {
      return Number.isFinite(turnCap) ? turnCap : Infinity;
    },
    get usedTurns() {
      return usedTurns;
    },
    /** Record the turn that just finished (reply from the backend). */
    completeTurn({ reply = "", status = null, duration_s = null, usage = null, error = null } = {}) {
      const inflight = state.inflight;
      const turn = {
        user_text: inflight ? inflight.text : "",
        source: inflight ? inflight.source : "caller",
        reply,
        status,
        duration_s,
        usage,
        error: error || null,
        at: new Date(now()).toISOString(),
      };
      state.inflight = null;
      state.turns.push(turn);
      onTurn(turn, state.turns);
      onChange(info());
      pump();
      return turn;
    },
    clearGrace,
    close,
    /** Drop an armed grace window (e.g. the viewer window failed to open). */
    setPolicy(next) {
      currentPolicy = next;
      if (!currentPolicy.enabled) {
        clearGrace();
        pump();
      }
    },
  };
}

/** Append one message to <run_dir>/inbox.jsonl (0600). Callers may race; O_APPEND keeps lines whole. */
export function appendInboxLine(runDir, { text, at, source } = {}) {
  const entry = {
    text: String(text === undefined ? "" : text),
    at: at || new Date().toISOString(),
    source: normalizeSource(source),
  };
  const file = runs.runPaths(runDir).inbox;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, JSON.stringify(entry) + "\n", { mode: 0o600 });
  return entry;
}

/**
 * Incremental line reader for an append-only file: only complete lines are
 * returned, a trailing partial line waits for its newline.
 */
export function createLineFollower(file) {
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
