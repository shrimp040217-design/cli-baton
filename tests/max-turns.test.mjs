/**
 * Revision to tasks C/D: agy conversations allow at most 2 turns by default
 * (initial message + one follow-up; override with CLI_BATON_AGY_MAX_TURNS),
 * codex is unlimited. The cap counts the caller prompt, the turn a resumed
 * session already used, tool messages and window input.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import * as chat from "../src/chat.mjs";
import * as runs from "../src/runs.mjs";
import {
  createRenderer,
  formatMaxTurnsLine,
  runViewer,
  shouldEnableInput,
} from "../src/viewer.mjs";
import {
  FAKE_OSASCRIPT,
  McpClient,
  fakeEnv,
  isToolError,
  makeCwd,
  makeHome,
  makeRunDir,
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
 * policy + session unit tests
 * ------------------------------------------------------------------ */

test("maxTurnsFor: agy defaults to 2, codex is unlimited, env overrides", () => {
  assert.equal(chat.maxTurnsFor("agy", {}), 2);
  assert.equal(chat.maxTurnsFor("agy", { CLI_BATON_AGY_MAX_TURNS: "3" }), 3);
  assert.equal(chat.maxTurnsFor("agy", { CLI_BATON_AGY_MAX_TURNS: "1" }), 1);
  assert.equal(chat.maxTurnsFor("agy", { CLI_BATON_AGY_MAX_TURNS: "0" }), Infinity);
  assert.equal(chat.maxTurnsFor("agy", { CLI_BATON_AGY_MAX_TURNS: "unlimited" }), Infinity);
  assert.equal(chat.maxTurnsFor("agy", { CLI_BATON_AGY_MAX_TURNS: "inf" }), Infinity);
  assert.equal(chat.maxTurnsFor("agy", { CLI_BATON_AGY_MAX_TURNS: "abc" }), 2);
  assert.equal(chat.maxTurnsFor("agy", { CLI_BATON_AGY_MAX_TURNS: "-1" }), 2);
  assert.equal(chat.maxTurnsFor("codex", {}), Infinity);
  assert.equal(chat.maxTurnsFor("codex", { CLI_BATON_AGY_MAX_TURNS: "1" }), Infinity, "the env var is agy-only");
});

test("createChatSession counts turns including the prompt and a resumed session", () => {
  const sent = [];
  const closed = [];
  const make = (options = {}) =>
    chat.createChatSession({
      enabled: true,
      policy: { enabled: true, grace_s: 20, grace_ms: 20000 },
      send: (entry) => sent.push(entry.text),
      onDone: (reason) => closed.push(reason),
      setTimer: () => null,
      clearTimer: () => {},
      ...options,
    });

  const fresh = make({ maxTurns: 2 });
  assert.equal(fresh.canAccept(), true);
  assert.equal(fresh.enqueue({ text: "prompt", source: "caller" }), true);
  assert.equal(fresh.info().usedTurns, 1);
  assert.equal(fresh.info().remainingTurns, 1);
  assert.equal(fresh.enqueue({ text: "follow-up", source: "window" }), true);
  assert.equal(fresh.info().maxTurnsReached, true);
  assert.equal(fresh.enqueue({ text: "third", source: "caller" }), false, "the third message is refused");
  assert.deepEqual(sent, ["prompt"], "the follow-up is queued behind the running turn");

  // A resumed session already spent one turn: only the prompt fits under a cap of 2.
  const resumed = make({ maxTurns: 2, initialUsedTurns: 1 });
  assert.equal(resumed.info().usedTurns, 1);
  assert.equal(resumed.enqueue({ text: "prompt", source: "caller" }), true);
  assert.equal(resumed.info().maxTurnsReached, true);
  assert.equal(resumed.enqueue({ text: "extra", source: "caller" }), false);

  // No cap: codex keeps accepting turns.
  const unlimited = make({ maxTurns: Infinity });
  for (let index = 0; index < 6; index += 1) {
    assert.equal(unlimited.enqueue({ text: "m" + index, source: "caller" }), true);
  }
  assert.equal(unlimited.info().maxTurnsReached, false);
  assert.equal(unlimited.info().remainingTurns, null);
});

test("the session skips the grace window once the cap is reached", () => {
  const closed = [];
  const session = chat.createChatSession({
    enabled: true,
    maxTurns: 1,
    policy: { enabled: true, grace_s: 20, grace_ms: 20000 },
    send: () => {},
    onDone: (reason) => closed.push(reason),
    setTimer: () => {
      assert.fail("no grace timer may be armed at the cap");
    },
    clearTimer: () => {},
  });
  session.enqueue({ text: "prompt", source: "caller" });
  session.completeTurn({ reply: "done", status: "SUCCESS", duration_s: 1 });
  assert.deepEqual(closed, ["max turns reached"]);
  assert.equal(session.info().graceUntil, null);
});

/* ------------------------------------------------------------------ *
 * viewer helpers
 * ------------------------------------------------------------------ */

test("the viewer disables its input box and explains why at the cap", () => {
  assert.equal(shouldEnableInput({ isTTY: true, chat: true, maxTurnsReached: true }), false);
  assert.equal(shouldEnableInput({ isTTY: true, chat: true, maxTurnsReached: false }), true);
  assert.equal(shouldEnableInput({ isTTY: true, chat: true, interactive: true, maxTurnsReached: true }), false);
  assert.equal(formatMaxTurnsLine({ maxTurns: 2 }), "本段对话已达 2 轮上限，请让 Claude 开新对话");

  const renderer = createRenderer({ timestamp: false });
  assert.match(
    renderer.line(JSON.stringify({ event: "user_rejected", text: "third", at: "t", source: "window", reason: "max_turns_reached" })),
    /已拒绝 · 轮数上限 · third/,
  );
});

/* ------------------------------------------------------------------ *
 * integration helpers
 * ------------------------------------------------------------------ */

async function withRun(backend, options, fn) {
  const home = makeHome();
  const logDir = makeTmpDir("cli-baton-cap-log-");
  const env = fakeEnv({ backend, home: home.path, logDir: logDir.path, ...options });
  const client = await McpClient.start({ backend, env });
  try {
    return await fn({ client, env, logDir: logDir.path });
  } finally {
    await client.close().catch(() => {});
    home.remove();
    logDir.remove();
  }
}

function tool(client, backend, name, args = {}) {
  return client.callTool(backend + "_" + name, args).then((message) => {
    assert.equal(isToolError(message), false, JSON.stringify(toolPayload(message)));
    return toolPayload(message);
  });
}

function readEvents(runDir) {
  return fs
    .readFileSync(path.join(runDir, "stdout.jsonl"), "utf8")
    .split(NL)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/* ------------------------------------------------------------------ *
 * agy: the third message is refused
 * ------------------------------------------------------------------ */

test("agy: the third message is refused with max_turns_reached and never queued", { timeout: 45000 }, async () => {
  await withRun("agy", { mode: "echo", turnDelayMs: 400 }, async ({ client }) => {
    const sent = await tool(client, "agy", "send", { message: "one", cwd: makeCwd().path, timeout_s: 60 });
    const second = await tool(client, "agy", "say", { run_id: sent.run_id, text: "two" });
    assert.equal(second.say.queued, true);

    // The runner drains the inbox on a 200ms tick; the cap is enforced there.
    const capped = await waitFor(async () => {
      const current = await tool(client, "agy", "status", { run_id: sent.run_id });
      return current.max_turns_reached === true ? current : null;
    }, { timeoutMs: 10000, label: "the run to reach its turn cap" });
    assert.equal(capped.max_turns, 2);
    assert.equal(capped.turns_used, 2);
    assert.equal(capped.turns_remaining, 0);

    const third = await client.callTool("agy_say", { run_id: sent.run_id, text: "three" });
    assert.equal(isToolError(third), true);
    assert.equal(toolPayload(third).error, "max_turns_reached", "the error token is exact");

    const inbox = fs.readFileSync(path.join(sent.run_dir, "inbox.jsonl"), "utf8").split(NL).filter(Boolean);
    assert.equal(inbox.length, 1, "the refused message is not written to the inbox");
    assert.equal(JSON.parse(inbox[0]).text, "two");

    const final = await waitForTerminal(client, "agy", sent.run_id, { timeoutMs: 30000 });
    assert.equal(final.state, "completed");
    assert.equal(final.turns.length, 2, "exactly two turns (prompt + one follow-up)");

    // A finished run still reports "already finished" (the cap token belongs to
    // the running window); the cap is visible in the run payload instead.
    const afterDone = await client.callTool("agy_say", { run_id: sent.run_id, text: "late" });
    assert.equal(isToolError(afterDone), true);
    assert.match(String(toolPayload(afterDone).error), /already finished/);
    assert.deepEqual(final.turns.map((turn) => turn.user_text), ["one", "two"]);
    assert.equal(final.reply, "echo: two");
    assert.equal(final.max_turns_reached, true);
    assert.equal(final.grace_until, null, "the cap skips the grace window");
  });
});

test("agy: an inbox message past the cap is rejected instead of executed", { timeout: 45000 }, async () => {
  await withRun("agy", { mode: "echo", turnDelayMs: 500 }, async ({ client }) => {
    const sent = await tool(client, "agy", "send", { message: "one", cwd: makeCwd().path, timeout_s: 60 });
    await tool(client, "agy", "say", { run_id: sent.run_id, text: "two" });
    // Someone (an old window, a script) appends a third line directly.
    chat.appendInboxLine(sent.run_dir, { text: "three", source: "window" });

    const final = await waitForTerminal(client, "agy", sent.run_id, { timeoutMs: 30000 });
    assert.equal(final.turns.length, 2, "the third message must not become a turn");
    const events = readEvents(sent.run_dir);
    const rejected = events.filter((event) => event.event === "user_rejected");
    assert.equal(rejected.length, 1, JSON.stringify(events.map((event) => event.event)));
    assert.equal(rejected[0].text, "three");
    assert.equal(rejected[0].reason, "max_turns_reached");
    assert.equal(events.filter((event) => event.event === "user_injected" && event.text === "three").length, 0);
  });
});

test("agy: CLI_BATON_AGY_MAX_TURNS raises the cap", { timeout: 45000 }, async () => {
  await withRun("agy", { mode: "echo", turnDelayMs: 250, extra: { CLI_BATON_AGY_MAX_TURNS: "3" } }, async ({ client }) => {
    const sent = await tool(client, "agy", "send", { message: "one", cwd: makeCwd().path, timeout_s: 60 });
    await tool(client, "agy", "say", { run_id: sent.run_id, text: "two" });
    await waitFor(async () => {
      const current = await tool(client, "agy", "status", { run_id: sent.run_id });
      return current.turns_used >= 2 ? current : null;
    }, { timeoutMs: 10000, label: "second turn accepted" });
    await tool(client, "agy", "say", { run_id: sent.run_id, text: "three" });
    const capped = await waitFor(async () => {
      const current = await tool(client, "agy", "status", { run_id: sent.run_id });
      return current.max_turns_reached === true ? current : null;
    }, { timeoutMs: 10000, label: "third turn accepted" });
    assert.equal(capped.turns_used, 3);
    const fourth = await client.callTool("agy_say", { run_id: sent.run_id, text: "four" });
    assert.equal(isToolError(fourth), true);
    assert.equal(toolPayload(fourth).error, "max_turns_reached");

    const final = await waitForTerminal(client, "agy", sent.run_id, { timeoutMs: 30000 });
    assert.equal(final.turns.length, 3);
    assert.deepEqual(final.turns.map((turn) => turn.user_text), ["one", "two", "three"]);
  });
});

test("agy: a resumed session already counts as one used turn", { timeout: 45000 }, async () => {
  await withRun("agy", { mode: "echo", turnDelayMs: 400 }, async ({ client }) => {
    const sent = await tool(client, "agy", "send", {
      message: "continue",
      cwd: makeCwd().path,
      session_id: "conv-existing",
      timeout_s: 60,
    });
    assert.equal(sent.turns_used, undefined, "send only returns the run envelope");

    const status = await waitFor(async () => {
      const current = await tool(client, "agy", "status", { run_id: sent.run_id });
      return current.state === "running" && current.turns_used >= 1 ? current : null;
    }, { timeoutMs: 15000, label: "resumed run to start" });
    assert.equal(status.turns_used, 2, "the resumed session already used one of the two turns");
    assert.equal(status.max_turns_reached, true);
    assert.equal(status.turns_remaining, 0);

    const extra = await client.callTool("agy_say", { run_id: sent.run_id, text: "more" });
    assert.equal(isToolError(extra), true);
    assert.equal(toolPayload(extra).error, "max_turns_reached");

    const final = await waitForTerminal(client, "agy", sent.run_id, { timeoutMs: 30000 });
    assert.equal(final.turns.length, 1, "only the initial prompt fits");
    assert.equal(final.session_id, "conv-existing");
  });
});

/* ------------------------------------------------------------------ *
 * cap + window (macOS)
 * ------------------------------------------------------------------ */

test("agy at the cap skips the grace window and closes the window immediately", { skip: macOnly, timeout: 45000 }, async () => {
  const home = makeHome();
  const logDir = makeTmpDir("cli-baton-cap-grace-");
  const osascriptLog = path.join(makeTmpDir("cli-baton-osascript-").path, "calls.jsonl");
  const env = {
    ...fakeEnv({ backend: "agy", home: home.path, logDir: logDir.path, mode: "echo", turnDelayMs: 200, graceS: 30 }),
    CLI_BATON_VIEWER: "1",
    CLI_BATON_OSASCRIPT_BIN: FAKE_OSASCRIPT,
    FAKE_OSASCRIPT_LOG: osascriptLog,
  };
  const client = await McpClient.start({ backend: "agy", env });
  try {
    const sent = await tool(client, "agy", "send", { message: "one", cwd: makeCwd().path, timeout_s: 120 });
    await tool(client, "agy", "say", { run_id: sent.run_id, text: "two" });
    const final = await waitForTerminal(client, "agy", sent.run_id, { timeoutMs: 25000 });
    assert.equal(final.state, "completed");
    assert.equal(final.turns.length, 2);
    assert.equal(final.grace_until, null, "no 30s grace at the cap");
    assert.ok(final.duration_s < 20, "finished right after the last turn (" + final.duration_s + "s)");
    const info = await waitFor(() => {
      const viewer = readRunDir(sent.run_dir).viewer;
      return viewer && viewer.closed_at ? viewer : null;
    }, { timeoutMs: 15000, label: "viewer window closed" });
    assert.ok(info.window_id);
  } finally {
    await client.close().catch(() => {});
    home.remove();
    logDir.remove();
  }
});

test("the window shows the cap notice instead of an input box", async () => {
  const run = makeRunDir({ backend: "agy", meta: { chat: true, max_turns: 2 } });
  try {
    let text = "";
    const out = {
      isTTY: false,
      write(chunk) {
        text += String(chunk);
        return true;
      },
    };
    runs.writeHeartbeat(run.runDir, {
      chat: true,
      inflight: false,
      turns: 2,
      max_turns: 2,
      turns_used: 2,
      turns_remaining: 0,
      max_turns_reached: true,
      stdin_closed: false,
    });
    const done = runViewer({ runDir: run.runDir, out, pollMs: 20, idleMs: 60000, interactive: false });
    await waitFor(() => (text.includes("轮上限") ? text : null), { timeoutMs: 3000, label: "cap notice" });
    assert.match(text, /本段对话已达 2 轮上限，请让 Claude 开新对话/);
    run.writeResult({ state: "completed", reply: "", duration_s: 1, exit_code: 0 });
    assert.equal(await done, 0);
  } finally {
    run.remove();
  }
});

/* ------------------------------------------------------------------ *
 * codex: unlimited turns
 * ------------------------------------------------------------------ */

test("codex: the third and fourth turns work normally (no cap)", { timeout: 45000 }, async () => {
  await withRun("codex", { mode: "echo", turnDelayMs: 150 }, async ({ client }) => {
    const sent = await tool(client, "codex", "send", { message: "one", cwd: makeCwd().path, timeout_s: 60 });
    await tool(client, "codex", "say", { run_id: sent.run_id, text: "two" });
    await tool(client, "codex", "say", { run_id: sent.run_id, text: "three" });
    await tool(client, "codex", "say", { run_id: sent.run_id, text: "four" });

    const status = await tool(client, "codex", "status", { run_id: sent.run_id });
    assert.equal(status.max_turns, null, "codex has no cap");
    assert.equal(status.max_turns_reached, false);

    const final = await waitForTerminal(client, "codex", sent.run_id, { timeoutMs: 30000 });
    assert.equal(final.state, "completed");
    assert.equal(final.turns.length, 4, JSON.stringify(final.turns));
    assert.deepEqual(final.turns.map((turn) => turn.user_text), ["one", "two", "three", "four"]);
    assert.equal(final.reply, "echo: four");
    assert.equal(final.max_turns_reached, false);
    assert.equal(final.turns_remaining, null);
  });
});

test("codex: CLI_BATON_AGY_MAX_TURNS does not leak into the codex backend", { timeout: 45000 }, async () => {
  await withRun("codex", { mode: "echo", turnDelayMs: 100, extra: { CLI_BATON_AGY_MAX_TURNS: "2" } }, async ({ client }) => {
    const sent = await tool(client, "codex", "send", { message: "one", cwd: makeCwd().path, timeout_s: 60 });
    await tool(client, "codex", "say", { run_id: sent.run_id, text: "two" });
    await tool(client, "codex", "say", { run_id: sent.run_id, text: "three" });
    const final = await waitForTerminal(client, "codex", sent.run_id, { timeoutMs: 30000 });
    assert.equal(final.turns.length, 3);
  });
});
