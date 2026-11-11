/**
 * agy conversation-mode tests (task C): stdin conversation protocol, inbox
 * injection (window / caller), turn bookkeeping, grace window lifecycle and the
 * agy_say tool.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import * as chat from "../src/chat.mjs";
import * as runs from "../src/runs.mjs";
import { callTool } from "../src/tools.mjs";
import {
  FAKE_OSASCRIPT,
  makeRunDir,
  McpClient,
  fakeEnv,
  isToolError,
  makeCwd,
  makeHome,
  makeTmpDir,
  readRunDir,
  sleep,
  toolPayload,
  waitFor,
  waitForTerminal,
} from "./helpers.mjs";

const NL = String.fromCharCode(10);
const macOnly = process.platform === "darwin" ? false : "macOS only";

/* ------------------------------------------------------------------ *
 * unit: protocol helpers
 * ------------------------------------------------------------------ */

test("chatPolicy: grace is armed only when a window can show it", () => {
  assert.deepEqual(chat.chatPolicy({ env: {}, viewerEnabled: true, platform: "darwin" }), {
    enabled: true,
    grace_s: 20,
    grace_ms: 20000,
  });
  assert.equal(chat.chatPolicy({ env: { CLI_BATON_CHAT_GRACE_S: "5" }, viewerEnabled: true }).grace_ms, 5000);
  assert.equal(chat.chatPolicy({ env: { CLI_BATON_CHAT_GRACE_S: "0" }, viewerEnabled: true }).enabled, false);
  // Negative means "never wait", not "fall back to 20s".
  assert.equal(chat.graceSeconds({ CLI_BATON_CHAT_GRACE_S: "-3" }), 0);
  assert.equal(chat.chatPolicy({ env: { CLI_BATON_CHAT_GRACE_S: "-3" }, viewerEnabled: true, platform: "darwin" }).enabled, false);
  assert.equal(chat.chatPolicy({ env: {}, viewerEnabled: true, platform: "linux" }).enabled, false, "non-macOS never waits");
  assert.equal(chat.chatPolicy({ env: {}, viewerEnabled: false }).enabled, false, "no window → no grace");
  assert.equal(chat.graceSeconds({ CLI_BATON_CHAT_GRACE_S: "abc" }), chat.DEFAULT_GRACE_S);
  assert.equal(chat.graceSeconds({ CLI_BATON_CHAT_GRACE_S: "99999" }), chat.MAX_GRACE_S);
});

test("chat protocol helpers: stdin message, inbox line and injected event", () => {
  assert.deepEqual(JSON.parse(chat.buildUserMessage("hello")), {
    event: "user",
    message: { content: [{ type: "text", text: "hello" }] },
  });

  const parsed = chat.parseInboxLine(JSON.stringify({ text: "hi", at: "2026-01-01T00:00:00.000Z", source: "window" }));
  assert.deepEqual(parsed, { text: "hi", at: "2026-01-01T00:00:00.000Z", source: "window" });
  assert.equal(chat.parseInboxLine('{"text":"x"}').source, "caller", "source defaults to caller");
  assert.equal(chat.parseInboxLine("not json"), null);
  assert.equal(chat.parseInboxLine('{"text":"   "}'), null, "blank text is ignored");
  assert.equal(chat.parseInboxLine(""), null);

  const event = JSON.parse(chat.formatInjectedEvent({ text: "hey", at: "t", source: "window" }));
  assert.deepEqual(event, { event: "user_injected", text: "hey", at: "t", source: "window" });
});

test("createLineFollower yields only complete inbox lines", () => {
  const tmp = makeTmpDir("cli-baton-inbox-");
  try {
    const file = path.join(tmp.path, "inbox.jsonl");
    fs.writeFileSync(file, '{"text":"a"}\n{"text":');
    const follower = chat.createLineFollower(file);
    assert.deepEqual(follower.read(), ['{"text":"a"}']);
    fs.appendFileSync(file, '"b"}\n');
    assert.deepEqual(follower.read(), ['{"text":"b"}']);
    assert.deepEqual(follower.read(), []);
  } finally {
    tmp.remove();
  }
});

/* ------------------------------------------------------------------ *
 * integration helpers
 * ------------------------------------------------------------------ */

function makeEnv(options = {}) {
  const home = makeHome();
  const logDir = makeTmpDir("cli-baton-chat-log-");
  const env = fakeEnv({ backend: "agy", home: home.path, logDir: logDir.path, ...options });
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
  const client = await McpClient.start({ backend: "agy", env: dirs.env });
  try {
    return await fn({ client, env: dirs.env, logDir: dirs.logDir.path });
  } finally {
    await client.close().catch(() => {});
    dirs.cleanup();
  }
}

function call(client, name, args = {}) {
  return client.callTool("agy_" + name, args).then((message) => {
    assert.equal(isToolError(message), false, JSON.stringify(toolPayload(message)));
    return toolPayload(message);
  });
}

/* ------------------------------------------------------------------ *
 * multi-turn conversations (window-independent)
 * ------------------------------------------------------------------ */

test("agy_say adds a second turn and reply is the last turn's answer", { timeout: 45000 }, async () => {
  await withRun({ mode: "echo", turnDelayMs: 300 }, async ({ client }) => {
    const sent = await call(client, "send", { message: "first", cwd: makeCwd().path, timeout_s: 60 });
    const said = await call(client, "say", { run_id: sent.run_id, text: "second" });
    assert.equal(said.say.queued, true);
    assert.equal(said.say.source, "caller");

    const final = await waitForTerminal(client, "agy", sent.run_id, { timeoutMs: 30000 });
    assert.equal(final.state, "completed", JSON.stringify(final));
    assert.equal(final.chat, true);
    assert.equal(final.turns.length, 2, JSON.stringify(final.turns));
    assert.equal(final.turns[0].user_text, "first");
    assert.equal(final.turns[0].reply, "echo: first");
    assert.equal(final.turns[0].source, "caller");
    assert.equal(final.turns[0].status, "SUCCESS");
    assert.equal(typeof final.turns[0].duration_s, "number");
    assert.ok(final.turns[0].at);
    assert.equal(final.turns[1].user_text, "second");
    assert.equal(final.turns[1].reply, "echo: second");
    assert.equal(final.reply, "echo: second", "reply mirrors the last turn");

    const stdout = fs.readFileSync(path.join(sent.run_dir, "stdout.jsonl"), "utf8");
    const injected = stdout.split(NL).filter(Boolean).map((line) => JSON.parse(line)).filter((event) => event.event === "user_injected");
    assert.equal(injected.length, 1, "the injected message is recorded in stdout.jsonl");
    assert.equal(injected[0].text, "second");
    assert.equal(injected[0].source, "caller");

    const onDisk = runs.readTurns(sent.run_dir);
    assert.equal(onDisk.length, 2, "turns.json keeps the full conversation for the viewer/tools");
    assert.equal(onDisk[1].reply, "echo: second");
  });
});

test("a message appended to inbox.jsonl (the window path) becomes a window turn", { timeout: 45000 }, async () => {
  await withRun({ mode: "echo", turnDelayMs: 300 }, async ({ client }) => {
    const sent = await call(client, "send", { message: "from caller", cwd: makeCwd().path, timeout_s: 60 });
    chat.appendInboxLine(sent.run_dir, { text: "typed in the window", source: "window" });

    const final = await waitForTerminal(client, "agy", sent.run_id, { timeoutMs: 30000 });
    assert.equal(final.turns.length, 2, JSON.stringify(final.turns));
    assert.equal(final.turns[1].user_text, "typed in the window");
    assert.equal(final.turns[1].source, "window");
    assert.equal(final.reply, "echo: typed in the window");

    const stdout = fs.readFileSync(path.join(sent.run_dir, "stdout.jsonl"), "utf8");
    const injected = stdout
      .split(NL)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((event) => event.event === "user_injected");
    assert.equal(injected.length, 1);
    assert.equal(injected[0].text, "typed in the window");
    assert.equal(injected[0].source, "window");
  });
});

test("an injected message never splices into a half-written CLI line", { timeout: 45000 }, async () => {
  await withRun({ mode: "half-line", halfLineMs: 2500, text: "HALF_OK" }, async ({ client }) => {
    const sent = await call(client, "send", { message: "first", cwd: makeCwd().path, timeout_s: 60 });
    // Land inside the pause while the fake CLI's stdout line is still open.
    await sleep(300);
    chat.appendInboxLine(sent.run_dir, { text: "during the half line", source: "window" });

    const final = await waitForTerminal(client, "agy", sent.run_id, { timeoutMs: 30000 });
    assert.equal(final.state, "completed", JSON.stringify(final));
    assert.equal(final.turns.length, 2, JSON.stringify(final.turns));

    const lines = fs.readFileSync(path.join(sent.run_dir, "stdout.jsonl"), "utf8").split(NL).filter(Boolean);
    const events = [];
    for (const line of lines) {
      try {
        events.push(JSON.parse(line));
      } catch {
        assert.fail("stdout.jsonl contains a spliced/corrupted line: " + JSON.stringify(line.slice(0, 160)));
      }
    }
    const injected = events.filter((event) => event.event === "user_injected");
    assert.equal(injected.length, 1, "the injected record must survive the half-written line");
    assert.equal(injected[0].text, "during the half line");
    assert.equal(injected[0].source, "window");
    assert.equal(events.some((event) => event.step_update && event.step_update.text_delta === "HALF-"), true);
  });
});

test("a message queued while the CLI dies mid-line is still recorded on its own line", { timeout: 45000 }, async () => {
  await withRun({ mode: "die-half-line", halfLineMs: 1500 }, async ({ client }) => {
    const sent = await call(client, "send", { message: "first", cwd: makeCwd().path, timeout_s: 60 });
    await sleep(300);
    chat.appendInboxLine(sent.run_dir, { text: "queued before the crash", source: "window" });

    const final = await waitForTerminal(client, "agy", sent.run_id, { timeoutMs: 20000 });
    assert.equal(final.state, "failed", JSON.stringify(final));

    const lines = fs.readFileSync(path.join(sent.run_dir, "stdout.jsonl"), "utf8").split(NL).filter(Boolean);
    const last = JSON.parse(lines[lines.length - 1]);
    assert.equal(last.event, "user_injected", "the audit record is flushed after the truncated CLI line");
    assert.equal(last.text, "queued before the crash");
    assert.equal(last.source, "window");
  });
});

test("agy_say refuses a run whose stdin is already closed", async () => {
  const run = makeRunDir({ backend: "agy", runId: "d".repeat(24) });
  try {
    runs.writeSupervisor(run.runDir, { pid: process.pid, pid_start: runs.processStartToken(process.pid) });
    runs.writeHeartbeat(run.runDir, { chat: true, inflight: false, turns: 1, stdin_closed: true });
    const result = await callTool({
      backendName: "agy",
      name: "agy_say",
      args: { run_id: "d".repeat(24), text: "too late" },
      env: { CLI_BATON_HOME: run.home },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /stdin already closed/);
    const inbox = path.join(run.runDir, "inbox.jsonl");
    assert.equal(fs.existsSync(inbox) ? fs.readFileSync(inbox, "utf8") : "", "", "nothing may be queued");
  } finally {
    run.remove();
  }
});

test("messages queue behind the running turn and keep their order", { timeout: 45000 }, async () => {
  // Above agy's default 2-turn cap on purpose: this test is about queueing.
  await withRun({ mode: "echo", turnDelayMs: 400, extra: { CLI_BATON_AGY_MAX_TURNS: "10" } }, async ({ client }) => {
    const sent = await call(client, "send", { message: "one", cwd: makeCwd().path, timeout_s: 60 });
    await call(client, "say", { run_id: sent.run_id, text: "two" });
    await call(client, "say", { run_id: sent.run_id, text: "three" });

    const status = await waitFor(async () => {
      const current = await call(client, "status", { run_id: sent.run_id });
      return current.inflight === true ? current : null;
    }, { timeoutMs: 10000, label: "a turn to be in flight" });
    assert.equal(status.state, "running");
    assert.ok(status.turns.length <= 1, "the queued messages must not be answered yet");

    const final = await waitForTerminal(client, "agy", sent.run_id, { timeoutMs: 30000 });
    assert.equal(final.turns.length, 3, JSON.stringify(final.turns));
    assert.deepEqual(final.turns.map((turn) => turn.user_text), ["one", "two", "three"]);
    assert.deepEqual(final.turns.map((turn) => turn.reply), ["echo: one", "echo: two", "echo: three"]);
    assert.equal(final.turns.every((turn) => turn.source === "caller"), true);
  });
});

test("without a window there is no grace: the run finishes right after its last turn", { timeout: 30000 }, async () => {
  await withRun({ mode: "echo" }, async ({ client }) => {
    const started = Date.now();
    const sent = await call(client, "send", { message: "solo", cwd: makeCwd().path, timeout_s: 60 });
    const final = await waitForTerminal(client, "agy", sent.run_id, { timeoutMs: 15000 });
    const elapsed = Date.now() - started;
    assert.equal(final.state, "completed");
    assert.equal(final.turns.length, 1);
    assert.equal(final.grace_until, null, "no grace window when the viewer is off");
    assert.equal(final.grace_remaining_s, null);
    assert.ok(elapsed < 15000, "finished without waiting out the 20s grace period (took " + elapsed + "ms)");
  });
});

/* ------------------------------------------------------------------ *
 * agy_say edge cases
 * ------------------------------------------------------------------ */

test("agy_say validates its input and refuses finished runs", { timeout: 30000 }, async () => {
  await withRun({ mode: "echo" }, async ({ client }) => {
    const sent = await call(client, "send", { message: "done soon", cwd: makeCwd().path, timeout_s: 60 });
    const final = await waitForTerminal(client, "agy", sent.run_id, { timeoutMs: 15000 });
    assert.equal(final.state, "completed");

    const finished = await client.callTool("agy_say", { run_id: sent.run_id, text: "too late" });
    assert.equal(isToolError(finished), true);
    assert.match(String(toolPayload(finished).error), /already finished/);

    const missing = await client.callTool("agy_say", { run_id: "b".repeat(24), text: "x" });
    assert.equal(isToolError(missing), true);

    const empty = await client.callTool("agy_say", { run_id: sent.run_id, text: "   " });
    assert.equal(isToolError(empty), true);

    const badId = await client.callTool("agy_say", { run_id: "../../etc/passwd", text: "x" });
    assert.equal(isToolError(badId), true);
  });

  // codex exposes say too (both backends are conversations); unknown runs error out.
  const home = makeHome();
  const logDir = makeTmpDir("cli-baton-chat-codex-");
  const env = fakeEnv({ backend: "codex", home: home.path, logDir: logDir.path });
  const client = await McpClient.start({ backend: "codex", env });
  try {
    const message = await client.callTool("codex_say", { run_id: "a".repeat(24), text: "x" });
    assert.equal(isToolError(message), true);
    assert.match(String(toolPayload(message).error), /Run not found/);
  } finally {
    await client.close().catch(() => {});
    home.remove();
    logDir.remove();
  }
});

/* ------------------------------------------------------------------ *
 * grace window (macOS: needs the viewer to be enabled)
 * ------------------------------------------------------------------ */

function graceEnv({ home, logDir, osascriptLog, graceS, extra = {} }) {
  return {
    ...fakeEnv({ backend: "agy", home, logDir, mode: "echo", graceS }),
    CLI_BATON_VIEWER: "1",
    CLI_BATON_OSASCRIPT_BIN: FAKE_OSASCRIPT,
    FAKE_OSASCRIPT_LOG: osascriptLog,
    ...extra,
  };
}

test("grace window keeps the run alive and a new message continues the conversation", { skip: macOnly, timeout: 60000 }, async () => {
  const home = makeHome();
  const logDir = makeTmpDir("cli-baton-chat-grace-");
  const osascriptLog = path.join(makeTmpDir("cli-baton-osascript-").path, "calls.jsonl");
  const env = graceEnv({ home: home.path, logDir: logDir.path, osascriptLog, graceS: 4 });
  const client = await McpClient.start({ backend: "agy", env });
  try {
    const sent = await call(client, "send", { message: "hello", cwd: makeCwd().path, timeout_s: 60 });
    const graceState = await waitFor(async () => {
      const status = await call(client, "status", { run_id: sent.run_id });
      return status.grace_remaining_s !== null && status.grace_remaining_s > 0 ? status : null;
    }, { timeoutMs: 15000, label: "grace window to open" });
    assert.equal(graceState.state, "running", "the run stays running during the grace window");
    assert.ok(graceState.grace_until, "grace_until is exposed to callers");

    chat.appendInboxLine(sent.run_dir, { text: "still here", source: "window" });
    const afterInput = await waitFor(async () => {
      const status = await call(client, "status", { run_id: sent.run_id });
      return status.turns.length === 2 ? status : null;
    }, { timeoutMs: 15000, label: "second turn after the injected message" });
    assert.equal(afterInput.turns[1].source, "window");
    assert.equal(afterInput.turns[1].reply, "echo: still here");
    assert.ok(
      afterInput.grace_remaining_s === null || afterInput.grace_remaining_s > 0,
      "the grace window restarts after the injected turn: " + afterInput.grace_remaining_s,
    );

    const final = await waitForTerminal(client, "agy", sent.run_id, { timeoutMs: 30000 });
    assert.equal(final.state, "completed");
    assert.equal(final.turns.length, 2);
    assert.equal(final.reply, "echo: still here");
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

test("grace expiry ends the run and closes the window", { skip: macOnly, timeout: 45000 }, async () => {
  const home = makeHome();
  const logDir = makeTmpDir("cli-baton-chat-grace-");
  const osascriptLog = path.join(makeTmpDir("cli-baton-osascript-").path, "calls.jsonl");
  const env = graceEnv({ home: home.path, logDir: logDir.path, osascriptLog, graceS: 1 });
  const client = await McpClient.start({ backend: "agy", env });
  try {
    const started = Date.now();
    const sent = await call(client, "send", { message: "bye", cwd: makeCwd().path, timeout_s: 60 });
    const final = await waitForTerminal(client, "agy", sent.run_id, { timeoutMs: 20000 });
    const elapsed = Date.now() - started;
    assert.equal(final.state, "completed");
    assert.equal(final.turns.length, 1);
    assert.ok(elapsed >= 1000, "the grace window really waited (took " + elapsed + "ms)");
    assert.ok(elapsed < 15000, "and then closed stdin instead of hanging (took " + elapsed + "ms)");

    const info = await waitFor(() => {
      const viewer = readRunDir(sent.run_dir).viewer;
      return viewer && viewer.closed_at ? viewer : null;
    }, { timeoutMs: 10000, label: "viewer window closed after the grace expiry" });
    assert.equal(info.window_id, "4242");
  } finally {
    await client.close().catch(() => {});
    home.remove();
    logDir.remove();
  }
});

test("cancel during the grace window reports cancelled and closes the window", { skip: macOnly, timeout: 45000 }, async () => {
  const home = makeHome();
  const logDir = makeTmpDir("cli-baton-chat-grace-");
  const osascriptLog = path.join(makeTmpDir("cli-baton-osascript-").path, "calls.jsonl");
  const env = graceEnv({ home: home.path, logDir: logDir.path, osascriptLog, graceS: 30 });
  const client = await McpClient.start({ backend: "agy", env });
  try {
    const sent = await call(client, "send", { message: "cancel me", cwd: makeCwd().path, timeout_s: 120 });
    await waitFor(async () => {
      const status = await call(client, "status", { run_id: sent.run_id });
      return status.turns.length === 1 && status.grace_remaining_s > 0 ? status : null;
    }, { timeoutMs: 15000, label: "run to reach its grace window" });

    const cancelled = await call(client, "cancel", { run_id: sent.run_id });
    assert.equal(cancelled.state, "cancelled");
    const info = await waitFor(() => {
      const viewer = readRunDir(sent.run_dir).viewer;
      return viewer && viewer.closed_at ? viewer : null;
    }, { timeoutMs: 10000, label: "viewer window closed on cancel" });
    assert.equal(info.close_result !== "error", true);
  } finally {
    await client.close().catch(() => {});
    home.remove();
    logDir.remove();
  }
});

test("snapshot exposes stdin_closed so callers stop pretending a message was queued", () => {
  const run = makeRunDir({ backend: "agy", runId: "c".repeat(24) });
  try {
    runs.writeHeartbeat(run.runDir, { chat: true, inflight: false, turns: 2, grace_until: null, stdin_closed: true });
    const snapshot = runs.getRunSnapshot({ root: run.home, backend: "agy", runId: "c".repeat(24) });
    assert.equal(snapshot.stdin_closed, true);
    assert.equal(runs.formatToolPayload(snapshot).stdin_closed, true);
    runs.writeHeartbeat(run.runDir, { chat: true, inflight: true, turns: 2, grace_until: null, stdin_closed: false });
    const open = runs.getRunSnapshot({ root: run.home, backend: "agy", runId: "c".repeat(24) });
    assert.equal(open.stdin_closed, false);
  } finally {
    run.remove();
  }
});

test("a viewer that cannot open does not make the run wait out the grace period", { skip: macOnly, timeout: 45000 }, async () => {
  const home = makeHome();
  const logDir = makeTmpDir("cli-baton-chat-noopen-");
  const osascriptLog = path.join(makeTmpDir("cli-baton-osascript-").path, "calls.jsonl");
  const env = {
    ...fakeEnv({ backend: "agy", home: home.path, logDir: logDir.path, mode: "echo", graceS: 20 }),
    CLI_BATON_VIEWER: "1",
    CLI_BATON_OSASCRIPT_BIN: FAKE_OSASCRIPT,
    FAKE_OSASCRIPT_LOG: osascriptLog,
    FAKE_OSASCRIPT_MODE: "fail",
  };
  const client = await McpClient.start({ backend: "agy", env });
  try {
    const started = Date.now();
    const sent = await call(client, "send", { message: "no window", cwd: makeCwd().path, timeout_s: 60 });
    const final = await waitForTerminal(client, "agy", sent.run_id, { timeoutMs: 30000 });
    const elapsed = Date.now() - started;
    assert.equal(final.state, "completed");
    assert.equal(final.turns.length, 1);
    assert.ok(elapsed < 15000, "no window → no 20s wait (took " + elapsed + "ms)");
    assert.match(String(readRunDir(sent.run_dir).viewerLog), /failed to open viewer window/);
    assert.equal(final.stdin_closed, true, "stdin was closed to finish the run");
  } finally {
    await client.close().catch(() => {});
    home.remove();
    logDir.remove();
  }
});

test("the run timeout still applies in chat mode and closes the window", { skip: macOnly, timeout: 60000 }, async () => {
  const home = makeHome();
  const logDir = makeTmpDir("cli-baton-chat-timeout-");
  const osascriptLog = path.join(makeTmpDir("cli-baton-osascript-").path, "calls.jsonl");
  const env = {
    ...fakeEnv({ backend: "agy", home: home.path, logDir: logDir.path, mode: "silent", silenceMs: 120000, graceS: 0 }),
    CLI_BATON_VIEWER: "1",
    CLI_BATON_OSASCRIPT_BIN: FAKE_OSASCRIPT,
    FAKE_OSASCRIPT_LOG: osascriptLog,
  };
  const client = await McpClient.start({ backend: "agy", env });
  try {
    const sent = await call(client, "send", { message: "slow turn", cwd: makeCwd().path, timeout_s: 10 });
    const final = await waitForTerminal(client, "agy", sent.run_id, { timeoutMs: 40000 });
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

test("a chat run waiting in its grace window is not reported as stalled", { skip: macOnly, timeout: 45000 }, async () => {
  const home = makeHome();
  const logDir = makeTmpDir("cli-baton-chat-grace-stall-");
  const osascriptLog = path.join(makeTmpDir("cli-baton-osascript-").path, "calls.jsonl");
  const env = graceEnv({ home: home.path, logDir: logDir.path, osascriptLog, graceS: 30 });
  const client = await McpClient.start({ backend: "agy", env });
  try {
    const sent = await call(client, "send", { message: "waiting", cwd: makeCwd().path, timeout_s: 120, stall_s: 1 });
    await waitFor(async () => {
      const status = await call(client, "status", { run_id: sent.run_id });
      return status.grace_remaining_s !== null ? status : null;
    }, { timeoutMs: 15000, label: "grace window to open" });
    const waited = await call(client, "wait", { run_id: sent.run_id, timeout_s: 3, stall_s: 1 });
    assert.equal(waited.stalled, undefined, "a deliberate wait for input is not a stall: " + JSON.stringify(waited));
    assert.equal(waited.timed_out, true);
    await call(client, "cancel", { run_id: sent.run_id });
  } finally {
    await client.close().catch(() => {});
    home.remove();
    logDir.remove();
  }
});

test("a turn that never answers still ends the run when stdin closes", { timeout: 30000 }, async () => {
  // Guard against a conversation hanging forever if the CLI never sends result:
  // the run timeout path stays intact in chat mode.
  await withRun({ mode: "silent", silenceMs: 60000 }, async ({ client }) => {
    const sent = await call(client, "send", { message: "hang", cwd: makeCwd().path, timeout_s: 10 });
    const final = await waitForTerminal(client, "agy", sent.run_id, { timeoutMs: 30000 });
    assert.equal(final.state, "timed_out", JSON.stringify(final));
    assert.equal(final.turns.length, 0);
  });
});
