/**
 * Task D: codex is a conversation too. The shared layer (inbox / queue / turns /
 * grace / say / viewer input) is exercised for codex, where each turn is a new
 * `codex exec resume … <thread_id>` process instead of one live stdin pipe.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import * as chat from "../src/chat.mjs";
import { handleViewerInput } from "../src/viewer.mjs";
import {
  FAKE_OSASCRIPT,
  McpClient,
  fakeEnv,
  isToolError,
  makeCwd,
  makeHome,
  makeTmpDir,
  readArgv,
  readRunDir,
  sleep,
  toolPayload,
  waitFor,
  waitForTerminal,
} from "./helpers.mjs";

const NL = String.fromCharCode(10);
const macOnly = process.platform === "darwin" ? false : "macOS only";

function makeEnv(options = {}) {
  const home = makeHome();
  const logDir = makeTmpDir("cli-baton-codex-chat-");
  const env = fakeEnv({ backend: "codex", home: home.path, logDir: logDir.path, ...options });
  return {
    home,
    logDir,
    env,
    cleanup() {
      home.remove();
      logDir.remove();
    },
  };
}

async function withRun(options, fn) {
  const dirs = makeEnv(options);
  const client = await McpClient.start({ backend: "codex", env: dirs.env });
  try {
    return await fn({ client, env: dirs.env, logDir: dirs.logDir.path });
  } finally {
    await client.close().catch(() => {});
    dirs.cleanup();
  }
}

function call(client, name, args = {}) {
  return client.callTool("codex_" + name, args).then((message) => {
    assert.equal(isToolError(message), false, JSON.stringify(toolPayload(message)));
    return toolPayload(message);
  });
}

function stdinTurns(logDir) {
  const file = path.join(logDir, "stdin.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split(NL)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("codex_say continues the conversation with a resumed exec turn", { timeout: 45000 }, async () => {
  await withRun({ mode: "echo", turnDelayMs: 200 }, async ({ client, logDir }) => {
    const sent = await call(client, "send", { message: "first", cwd: makeCwd().path, timeout_s: 60 });
    const said = await call(client, "say", { run_id: sent.run_id, text: "second" });
    assert.equal(said.say.queued, true);
    assert.equal(said.say.source, "caller");
    assert.equal(said.chat, true);

    const final = await waitForTerminal(client, "codex", sent.run_id, { timeoutMs: 30000 });
    assert.equal(final.state, "completed", JSON.stringify(final));
    assert.equal(final.chat, true);
    assert.equal(final.turns.length, 2, JSON.stringify(final.turns));
    assert.equal(final.turns[0].user_text, "first");
    assert.equal(final.turns[0].reply, "echo: first");
    assert.equal(final.turns[1].user_text, "second");
    assert.equal(final.turns[1].reply, "echo: second");
    assert.equal(final.reply, "echo: second");

    const invocations = stdinTurns(logDir);
    assert.equal(invocations.length, 2, "one CLI process per turn");
    assert.equal(invocations[0].resume, false, "the first turn is a fresh exec");
    assert.equal(invocations[1].resume, true, "later turns resume the thread");
    assert.equal(invocations[1].session, invocations[0].session, "the same thread id is reused");

    const argv = readArgv(logDir).argv;
    assert.equal(argv[0], "exec");
    assert.ok(argv.includes("resume"), "the last invocation was a resume: " + argv.join(" "));

    // Both turns appended to the same event log, with the same thread id.
    const events = fs
      .readFileSync(path.join(sent.run_dir, "stdout.jsonl"), "utf8")
      .split(NL)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const threads = events.filter((event) => event.type === "thread.started").map((event) => event.thread_id);
    assert.equal(threads.length, 2, "one thread.started per CLI process");
    assert.equal(new Set(threads).size, 1, "the resumed turn reuses the same thread");
  });
});

test("codex: an inbox message from the window becomes a resumed turn", { timeout: 45000 }, async () => {
  await withRun({ mode: "echo", turnDelayMs: 200 }, async ({ client }) => {
    const sent = await call(client, "send", { message: "from caller", cwd: makeCwd().path, timeout_s: 60 });
    // What the viewer's input line does on Enter.
    const submitted = handleViewerInput({ runDir: sent.run_dir, text: "typed in the window", state: { inflight: true } });
    assert.equal(submitted.ok, true);
    assert.match(submitted.ack, /已排队/);

    const final = await waitForTerminal(client, "codex", sent.run_id, { timeoutMs: 30000 });
    assert.equal(final.turns.length, 2, JSON.stringify(final.turns));
    assert.equal(final.turns[1].user_text, "typed in the window");
    assert.equal(final.turns[1].source, "window");
    assert.equal(final.reply, "echo: typed in the window");
    const stdout = fs.readFileSync(path.join(sent.run_dir, "stdout.jsonl"), "utf8");
    assert.match(stdout, /"event":"user_injected","text":"typed in the window"/);
  });
});

test("codex messages queue behind the running turn and keep their order", { timeout: 45000 }, async () => {
  await withRun({ mode: "echo", turnDelayMs: 400 }, async ({ client }) => {
    const sent = await call(client, "send", { message: "one", cwd: makeCwd().path, timeout_s: 60 });
    await call(client, "say", { run_id: sent.run_id, text: "two" });
    await call(client, "say", { run_id: sent.run_id, text: "three" });

    const final = await waitForTerminal(client, "codex", sent.run_id, { timeoutMs: 30000 });
    assert.equal(final.turns.length, 3, JSON.stringify(final.turns));
    assert.deepEqual(final.turns.map((turn) => turn.user_text), ["one", "two", "three"]);
    assert.deepEqual(final.turns.map((turn) => turn.reply), ["echo: one", "echo: two", "echo: three"]);
  });
});

test("codex: a send with session_id resumes that thread on the first turn", { timeout: 30000 }, async () => {
  await withRun({ mode: "echo" }, async ({ client, logDir }) => {
    const sent = await call(client, "send", {
      message: "continue it",
      cwd: makeCwd().path,
      session_id: "11111111-2222-3333-4444-555555555555",
      timeout_s: 60,
    });
    const final = await waitForTerminal(client, "codex", sent.run_id, { timeoutMs: 20000 });
    assert.equal(final.state, "completed", JSON.stringify(final));
    assert.equal(final.session_id, "11111111-2222-3333-4444-555555555555");
    const invocations = stdinTurns(logDir);
    assert.equal(invocations[0].resume, true, "the first turn already resumes the given thread");
    assert.equal(invocations[0].session, "11111111-2222-3333-4444-555555555555");
  });
});

test("codex without a window has no grace and finishes after its last turn", { timeout: 30000 }, async () => {
  await withRun({ mode: "echo" }, async ({ client }) => {
    const started = Date.now();
    const sent = await call(client, "send", { message: "solo", cwd: makeCwd().path, timeout_s: 60 });
    const final = await waitForTerminal(client, "codex", sent.run_id, { timeoutMs: 15000 });
    assert.equal(final.state, "completed");
    assert.equal(final.turns.length, 1);
    assert.equal(final.grace_until, null);
    assert.equal(final.stdin_closed, true);
    assert.ok(Date.now() - started < 15000);
  });
});

test("codex_say validates its input and refuses finished runs", { timeout: 30000 }, async () => {
  await withRun({ mode: "echo" }, async ({ client }) => {
    const sent = await call(client, "send", { message: "quick", cwd: makeCwd().path, timeout_s: 60 });
    const final = await waitForTerminal(client, "codex", sent.run_id, { timeoutMs: 15000 });
    assert.equal(final.state, "completed");

    const finished = await client.callTool("codex_say", { run_id: sent.run_id, text: "too late" });
    assert.equal(isToolError(finished), true);
    assert.match(String(toolPayload(finished).error), /already finished/);

    const missing = await client.callTool("codex_say", { run_id: "b".repeat(24), text: "x" });
    assert.equal(isToolError(missing), true);
    assert.match(String(toolPayload(missing).error), /Run not found/);

    const empty = await client.callTool("codex_say", { run_id: sent.run_id, text: "  " });
    assert.equal(isToolError(empty), true);
  });
});

/* ------------------------------------------------------------------ *
 * grace window (macOS: needs the viewer to be enabled)
 * ------------------------------------------------------------------ */

function graceEnv({ home, logDir, osascriptLog, graceS }) {
  return {
    ...fakeEnv({ backend: "codex", home, logDir, mode: "echo", graceS }),
    CLI_BATON_VIEWER: "1",
    CLI_BATON_OSASCRIPT_BIN: FAKE_OSASCRIPT,
    FAKE_OSASCRIPT_LOG: osascriptLog,
  };
}

test("codex grace window continues the conversation on a new message", { skip: macOnly, timeout: 60000 }, async () => {
  const home = makeHome();
  const logDir = makeTmpDir("cli-baton-codex-grace-");
  const osascriptLog = path.join(makeTmpDir("cli-baton-osascript-").path, "calls.jsonl");
  const env = graceEnv({ home: home.path, logDir: logDir.path, osascriptLog, graceS: 4 });
  const client = await McpClient.start({ backend: "codex", env });
  try {
    const sent = await call(client, "send", { message: "hello", cwd: makeCwd().path, timeout_s: 60 });
    const graceState = await waitFor(async () => {
      const status = await call(client, "status", { run_id: sent.run_id });
      return status.grace_remaining_s !== null && status.grace_remaining_s > 0 ? status : null;
    }, { timeoutMs: 15000, label: "codex grace window" });
    assert.equal(graceState.state, "running", "no process is alive, but the run keeps waiting for input");

    chat.appendInboxLine(sent.run_dir, { text: "still here", source: "window" });
    const afterInput = await waitFor(async () => {
      const status = await call(client, "status", { run_id: sent.run_id });
      return status.turns.length === 2 ? status : null;
    }, { timeoutMs: 15000, label: "resumed turn after the injected message" });
    assert.equal(afterInput.turns[1].source, "window");
    assert.equal(afterInput.turns[1].reply, "echo: still here");

    const final = await waitForTerminal(client, "codex", sent.run_id, { timeoutMs: 30000 });
    assert.equal(final.state, "completed");
    assert.equal(final.turns.length, 2);
    await waitFor(() => {
      const info = readRunDir(sent.run_dir).viewer;
      return info && info.closed_at ? info : null;
    }, { timeoutMs: 10000, label: "viewer window closed" });
  } finally {
    await client.close().catch(() => {});
    home.remove();
    logDir.remove();
  }
});

test("codex grace expiry completes the run and closes the window", { skip: macOnly, timeout: 45000 }, async () => {
  const home = makeHome();
  const logDir = makeTmpDir("cli-baton-codex-grace-");
  const osascriptLog = path.join(makeTmpDir("cli-baton-osascript-").path, "calls.jsonl");
  const env = graceEnv({ home: home.path, logDir: logDir.path, osascriptLog, graceS: 1 });
  const client = await McpClient.start({ backend: "codex", env });
  try {
    const started = Date.now();
    const sent = await call(client, "send", { message: "bye", cwd: makeCwd().path, timeout_s: 60 });
    const final = await waitForTerminal(client, "codex", sent.run_id, { timeoutMs: 20000 });
    const elapsed = Date.now() - started;
    assert.equal(final.state, "completed");
    assert.equal(final.turns.length, 1);
    assert.ok(elapsed >= 1000, "the grace window really waited (" + elapsed + "ms)");
    assert.ok(elapsed < 15000);
    const info = await waitFor(() => {
      const viewer = readRunDir(sent.run_dir).viewer;
      return viewer && viewer.closed_at ? viewer : null;
    }, { timeoutMs: 10000, label: "viewer window closed" });
    assert.equal(info.window_id, "4242");
  } finally {
    await client.close().catch(() => {});
    home.remove();
    logDir.remove();
  }
});

test("codex: cancel during the grace window (no live process) reports cancelled", { skip: macOnly, timeout: 45000 }, async () => {
  const home = makeHome();
  const logDir = makeTmpDir("cli-baton-codex-grace-");
  const osascriptLog = path.join(makeTmpDir("cli-baton-osascript-").path, "calls.jsonl");
  const env = graceEnv({ home: home.path, logDir: logDir.path, osascriptLog, graceS: 30 });
  const client = await McpClient.start({ backend: "codex", env });
  try {
    const sent = await call(client, "send", { message: "cancel me", cwd: makeCwd().path, timeout_s: 120 });
    await waitFor(async () => {
      const status = await call(client, "status", { run_id: sent.run_id });
      return status.turns.length === 1 && status.grace_remaining_s > 0 ? status : null;
    }, { timeoutMs: 15000, label: "run to reach its grace window" });

    const cancelled = await call(client, "cancel", { run_id: sent.run_id });
    assert.equal(cancelled.state, "cancelled");
    assert.equal(cancelled.reply, "", "cancelled runs do not report a reply (same as agy)");
    const info = await waitFor(() => {
      const viewer = readRunDir(sent.run_dir).viewer;
      return viewer && viewer.closed_at ? viewer : null;
    }, { timeoutMs: 10000, label: "viewer window closed on cancel" });
    assert.ok(info.window_id);
  } finally {
    await client.close().catch(() => {});
    home.remove();
    logDir.remove();
  }
});

test("codex: a run waiting in its grace window is not reported as stalled", { skip: macOnly, timeout: 45000 }, async () => {
  const home = makeHome();
  const logDir = makeTmpDir("cli-baton-codex-grace-stall-");
  const osascriptLog = path.join(makeTmpDir("cli-baton-osascript-").path, "calls.jsonl");
  const env = graceEnv({ home: home.path, logDir: logDir.path, osascriptLog, graceS: 30 });
  const client = await McpClient.start({ backend: "codex", env });
  try {
    const sent = await call(client, "send", { message: "waiting", cwd: makeCwd().path, timeout_s: 120, stall_s: 1 });
    await waitFor(async () => {
      const status = await call(client, "status", { run_id: sent.run_id });
      return status.grace_remaining_s !== null ? status : null;
    }, { timeoutMs: 15000, label: "codex grace window to open" });
    const waited = await call(client, "wait", { run_id: sent.run_id, timeout_s: 3, stall_s: 1 });
    assert.equal(waited.stalled, undefined, "waiting for input is not a stall: " + JSON.stringify(waited));
    assert.equal(waited.timed_out, true);
    await call(client, "cancel", { run_id: sent.run_id });
  } finally {
    await client.close().catch(() => {});
    home.remove();
    logDir.remove();
  }
});

test("codex: the run timeout applies inside the grace window (no process alive)", { skip: macOnly, timeout: 60000 }, async () => {
  const home = makeHome();
  const logDir = makeTmpDir("cli-baton-codex-grace-timeout-");
  const osascriptLog = path.join(makeTmpDir("cli-baton-osascript-").path, "calls.jsonl");
  const env = graceEnv({ home: home.path, logDir: logDir.path, osascriptLog, graceS: 30 });
  const client = await McpClient.start({ backend: "codex", env });
  try {
    const sent = await call(client, "send", { message: "timeout me", cwd: makeCwd().path, timeout_s: 10 });
    await waitFor(async () => {
      const status = await call(client, "status", { run_id: sent.run_id });
      return status.grace_remaining_s !== null ? status : null;
    }, { timeoutMs: 15000, label: "grace window" });
    const final = await waitForTerminal(client, "codex", sent.run_id, { timeoutMs: 40000 });
    assert.equal(final.state, "timed_out", JSON.stringify(final));
    assert.equal(final.reply, "");
    const info = await waitFor(() => {
      const viewer = readRunDir(sent.run_dir).viewer;
      return viewer && viewer.closed_at ? viewer : null;
    }, { timeoutMs: 15000, label: "viewer window closed after the timeout" });
    assert.ok(info.window_id);
  } finally {
    await client.close().catch(() => {});
    home.remove();
    logDir.remove();
  }
});

test("codex: the run timeout still applies and closes the window", { skip: macOnly, timeout: 60000 }, async () => {
  const home = makeHome();
  const logDir = makeTmpDir("cli-baton-codex-timeout-");
  const osascriptLog = path.join(makeTmpDir("cli-baton-osascript-").path, "calls.jsonl");
  const env = {
    ...fakeEnv({ backend: "codex", home: home.path, logDir: logDir.path, mode: "sleep", sleepMs: 120000, graceS: 0 }),
    CLI_BATON_VIEWER: "1",
    CLI_BATON_OSASCRIPT_BIN: FAKE_OSASCRIPT,
    FAKE_OSASCRIPT_LOG: osascriptLog,
  };
  const client = await McpClient.start({ backend: "codex", env });
  try {
    const sent = await call(client, "send", { message: "slow", cwd: makeCwd().path, timeout_s: 10 });
    const final = await waitForTerminal(client, "codex", sent.run_id, { timeoutMs: 40000 });
    assert.equal(final.state, "timed_out", JSON.stringify(final));
    const info = await waitFor(() => {
      const viewer = readRunDir(sent.run_dir).viewer;
      return viewer && viewer.closed_at ? viewer : null;
    }, { timeoutMs: 15000, label: "viewer window closed after the timeout" });
    assert.ok(info.window_id);
  } finally {
    await client.close().catch(() => {});
    home.remove();
    logDir.remove();
  }
});
