/**
 * Viewer tests: event rendering, run-state following, the idle status line, and
 * the stand-alone CLI (`node src/viewer.mjs <run_dir>`) auto-exiting on a
 * terminal state.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import {
  CLEAR_LINE,
  createRenderer,
  createTailReader,
  formatFinalLine,
  formatGraceLine,
  formatInboxAck,
  handleViewerInput,
  shouldEnableInput,
  formatStatusLine,
  formatTokens,
  renderHeader,
  runViewer,
  submitInput,
  summarizeValue,
  toolNameOf,
} from "../src/viewer.mjs";
import * as runs from "../src/runs.mjs";
import { VIEWER_PATH, makeRunDir, makeTmpDir, sleep, waitFor } from "./helpers.mjs";

const FIXED_NOW = () => new Date(2026, 0, 1, 12, 34, 56);
const J = (value) => JSON.stringify(value);

function renderer(options = {}) {
  return createRenderer({ now: FIXED_NOW, color: false, ...options });
}

function collector() {
  let text = "";
  return {
    isTTY: false,
    write(chunk) {
      text += String(chunk);
      return true;
    },
    get text() {
      return text;
    },
  };
}

test("renderHeader shows backend, model, effort, cwd and the run id", () => {
  const header = renderHeader({
    meta: {
      backend: "agy",
      run_id: "0123456789abcdef01234567",
      model: "gemini-3-pro",
      effort: "high",
      access: "read-only",
      cwd: "/tmp/work dir",
      state: "running",
    },
    runDir: "/tmp/work dir/.cli-baton/agy/runs/0123456789abcdef01234567",
  });
  assert.match(header, /cli-baton · agy · run 0123456789abcdef01234567/);
  assert.match(header, /model\s+gemini-3-pro/);
  assert.match(header, /effort\s+high/);
  assert.match(header, /access\s+read-only/);
  assert.match(header, /cwd\s+\/tmp\/work dir/);
  assert.match(header, /backend\s+agy/);
  assert.ok(header.includes("─"));
});

test("renderer: agy init event becomes one timestamped marker line", () => {
  const out = renderer().line(
    J({
      event: "init",
      conversation_id: "conv-1234567890",
      init: { model: "gemini-3-pro", cwd: "/tmp", tools: ["a", "b", "c"], permission_mode: "request-review" },
    }),
  );
  const lines = out.split("\n").filter(Boolean);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[12:34:56\] → init · model=gemini-3-pro · cwd=\/tmp · tools=3 · permission=request-review/);
  assert.match(lines[0], /conversation=conv-123…/);
});

test("renderer: text_delta streams without newlines and step changes are markers", () => {
  const r = renderer();
  const userInput = r.line(J({ event: "step_update", step_update: { step_index: 0, state: "DONE", step_type: "user_input" } }));
  assert.match(userInput, /^\[12:34:56\] → step 0 · user_input · DONE\n$/);

  const first = r.line(
    J({ event: "step_update", step_update: { step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "Rivers carve " } }),
  );
  assert.match(first, /^\[12:34:56\] → step 1 · agent_response · ACTIVE\nRivers carve $/);

  // Same state/type: no repeated marker, just the continuation.
  const second = r.line(
    J({ event: "step_update", step_update: { step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "canyons." } }),
  );
  assert.equal(second, "canyons.");

  const done = r.line(
    J({ event: "step_update", step_update: { step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "\n", duration_seconds: 5.46 } }),
  );
  assert.match(done, /^\n\[12:34:56\] → step 1 · agent_response · DONE · 5\.5s\n$/);
});

test("renderer: tool steps show the tool name", () => {
  const out = renderer().line(
    J({ event: "step_update", step_update: { step_index: 2, state: "DONE", step_type: "tool_call", tool_name: "read_file" } }),
  );
  assert.match(out, /→ tool · read_file · tool_call · DONE/);
  assert.equal(toolNameOf({ step_type: "tool_call", tool_name: "grep" }), "grep");
  assert.equal(toolNameOf({ tool: { name: "write_file" } }), "write_file");
  assert.equal(toolNameOf({ step_type: "agent_response" }), null);
});

test("renderer: result event shows status, duration and tokens", () => {
  const out = renderer().line(
    J({
      event: "result",
      result: { status: "SUCCESS", duration_seconds: 5.6, num_turns: 1, usage: { input_tokens: 12, output_tokens: 3 } },
    }),
  );
  assert.match(out, /→ result · status=SUCCESS/);
  assert.match(out, /用时=5\.6s/);
  assert.match(out, /tokens in=12 out=3 total=15/);
  assert.match(out, /turns=1/);
});

test("renderer: unknown events, unknown JSON and non-JSON lines each render as one line", () => {
  const r = renderer();
  const unknownEvent = r.line(J({ event: "mystery", payload: { a: 1 } }));
  assert.match(unknownEvent, /^\[12:34:56\] → mystery · \{"event":"mystery","payload":\{"a":1\}\}\n$/);

  const unknownJson = r.line(J({ totally: "unknown", n: 2 }));
  assert.match(unknownJson, /^\[12:34:56\] · json · \{"totally":"unknown","n":2\}\n$/);

  const raw = r.line("plain text from the CLI");
  assert.match(raw, /^\[12:34:56\] · raw · plain text from the CLI\n$/);

  const longRaw = renderer().line("x".repeat(1000));
  assert.ok(longRaw.includes("…"), "long lines should be shortened");

  assert.equal(r.line("   "), "");
  assert.equal(summarizeValue("a\nb"), "a b");
});

test("renderer: user_injected shows who typed into the conversation", () => {
  const windowLine = renderer().line(
    J({ event: "user_injected", text: "typed here", at: "2026-01-01T00:00:00.000Z", source: "window" }),
  );
  assert.match(windowLine, /→ 插话 · 窗口 · typed here/);
  const callerLine = renderer().line(J({ event: "user_injected", text: "from the tool", source: "caller" }));
  assert.match(callerLine, /→ 插话 · 调用方 · from the tool/);
});

test("renderer: codex events render session, tool, message and usage", () => {
  const r = renderer();
  assert.match(r.line(J({ type: "thread.started", thread_id: "thread-abcdef123456" })), /→ session · thread-a…/);
  assert.match(r.line(J({ type: "turn.started" })), /→ turn · started/);
  assert.match(
    r.line(J({ type: "item.completed", item: { type: "command_execution", command: "ls -la /tmp" } })),
    /→ tool · ls -la \/tmp/,
  );
  assert.equal(r.line(J({ type: "item.completed", item: { type: "agent_message", text: "codex says hi" } })), "codex says hi\n");
  assert.match(
    r.line(J({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } })),
    /→ turn · completed · tokens in=10 out=2 total=12/,
  );
  assert.match(r.line(J({ type: "turn.failed", error: { message: "nope" } })), /✗ turn\.failed · nope/);
  assert.match(r.line(J({ type: "error", message: "Reconnecting" })), /warning · Reconnecting/);
  // item.updated must not duplicate the assistant text.
  assert.equal(r.line(J({ type: "item.updated", item: { type: "agent_message", text: "partial" } })), "");
  assert.match(r.stderr("boom on stderr"), /! stderr · boom on stderr/);
});

test("formatTokens handles both backend usage shapes and rejects junk", () => {
  assert.equal(formatTokens({ input_tokens: 1, output_tokens: 2 }), "in=1 out=2 total=3");
  assert.equal(formatTokens({ prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 }), "in=5 out=6 total=11");
  assert.equal(formatTokens({ input_tokens: 1, output_tokens: 2, cached_input_tokens: 1 }), "in=1 out=2 total=3 cached=1");
  assert.equal(formatTokens(null), null);
  assert.equal(formatTokens({}), null);
});

test("formatInboxAck and submitInput append window messages to the inbox", () => {
  assert.equal(formatInboxAck({ inflight: false }), "已发送");
  assert.equal(formatInboxAck({ inflight: true }), "已排队（当前 turn 结束后执行）");

  const run = makeRunDir();
  try {
    const sent = submitInput({ runDir: run.runDir, text: "hello agy", inflight: false });
    assert.equal(sent.ok, true);
    assert.equal(sent.ack, "已发送");
    const queued = submitInput({ runDir: run.runDir, text: "later", inflight: true });
    assert.equal(queued.ack, "已排队（当前 turn 结束后执行）");

    const lines = fs
      .readFileSync(path.join(run.runDir, "inbox.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.deepEqual(lines.map((entry) => entry.text), ["hello agy", "later"]);
    assert.equal(lines[0].source, "window");
    assert.ok(lines[0].at);

    const empty = submitInput({ runDir: run.runDir, text: "   " });
    assert.equal(empty.ok, false);
    const broken = submitInput({ runDir: "/dev/null/nope", text: "x" });
    assert.equal(broken.ok, false);
    assert.match(broken.ack, /发送失败/);
  } finally {
    run.remove();
  }
});

test("shouldEnableInput only offers the input line for a chat run on a TTY", () => {
  assert.equal(shouldEnableInput({ isTTY: true, chat: true }), true);
  assert.equal(shouldEnableInput({ isTTY: false, chat: true }), false);
  assert.equal(shouldEnableInput({ isTTY: true, chat: false }), false, "one-shot runs have nobody reading the inbox");
  assert.equal(shouldEnableInput({ isTTY: true, chat: true, interactive: false }), false, "explicit override wins");
});

test("handleViewerInput writes window messages and never lies about a closed run", () => {
  const run = makeRunDir({ backend: "agy" });
  try {
    const queued = handleViewerInput({ runDir: run.runDir, text: "while busy", state: { inflight: true, stdin_closed: false } });
    assert.equal(queued.ok, true);
    assert.equal(queued.ack, "已排队（当前 turn 结束后执行）");

    const closed = handleViewerInput({ runDir: run.runDir, text: "too late", state: { inflight: false, stdin_closed: true } });
    assert.equal(closed.ok, false);
    assert.match(closed.ack, /对话已收尾/);

    const blank = handleViewerInput({ runDir: run.runDir, text: "   ", state: {} });
    assert.equal(blank.ok, false);

    const entries = fs
      .readFileSync(path.join(run.runDir, "inbox.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.deepEqual(entries.map((entry) => entry.text), ["while busy"], "only the accepted message is queued");
    assert.equal(entries[0].source, "window");
  } finally {
    run.remove();
  }
});

test("formatGraceLine counts down to the auto-close", () => {
  assert.equal(formatGraceLine({ remainingS: 19.2 }), "完成；20 秒内输入可继续对话，否则自动关闭");
  assert.equal(formatGraceLine({ remainingS: 0.2 }), "完成；1 秒内输入可继续对话，否则自动关闭");
  assert.equal(formatGraceLine({ remainingS: 0 }), "完成；0 秒内输入可继续对话，否则自动关闭");
});

test("runViewer shows the grace countdown instead of the idle line", async () => {
  const run = makeRunDir({ backend: "agy" });
  const out = collector();
  try {
    run.writeMeta({ child_pid: null }, "running");
    runs.writeHeartbeat(run.runDir, { chat: true, inflight: false, turns: 1, grace_until: Date.now() + 3000 });
    const done = runViewer({ runDir: run.runDir, out, pollMs: 20, idleMs: 10, interruptGraceMs: 60000, interactive: false });
    await waitFor(() => (out.text.includes("秒内输入可继续对话") ? out.text : null), { timeoutMs: 3000, label: "grace countdown" });
    assert.match(out.text, /完成；\d+ 秒内输入可继续对话，否则自动关闭/);
    run.writeResult({ state: "completed", reply: "", duration_s: 1, exit_code: 0 });
    assert.equal(await done, 0);
  } finally {
    run.remove();
  }
});

test("formatStatusLine reports idle seconds and whether the pid is alive", () => {
  const alive = formatStatusLine({ idleSeconds: 12.4, childPid: 4242, childAlive: true, heartbeatAgeSeconds: 1.2, state: "running" });
  assert.match(alive, /仍在运行，已 12s 无新输出/);
  assert.match(alive, /进程 pid 4242 存活/);
  assert.match(alive, /心跳 1s 前/);
  assert.match(alive, /state=running/);

  const dead = formatStatusLine({ idleSeconds: 7, childPid: 99, childAlive: false });
  assert.match(dead, /仍在运行，已 7s 无新输出/);
  assert.match(dead, /进程 pid 99 已退出/);
  assert.ok(!dead.includes("心跳"));
});

test("formatFinalLine reports the state, duration, exit code, tokens and error", () => {
  const line = formatFinalLine({
    state: "completed",
    result: {
      state: "completed",
      duration_s: 5.6,
      exit_code: 0,
      reply: "hello",
      usage: { input_tokens: 3, output_tokens: 4 },
    },
  });
  assert.match(line, /运行结束 · completed/);
  assert.match(line, /用时 5\.6s/);
  assert.match(line, /exit=0/);
  assert.match(line, /tokens in=3 out=4 total=7/);
  assert.match(line, /reply 5 字符/);

  const failed = formatFinalLine({ state: "failed", result: { state: "failed", error: "boom", reply: "" } });
  assert.match(failed, /运行结束 · failed/);
  assert.match(failed, /error: boom/);
});

test("createTailReader returns only complete lines and keeps partial ones buffered", () => {
  const tmp = makeTmpDir("cli-baton-tail-");
  try {
    const file = path.join(tmp.path, "stdout.jsonl");
    fs.writeFileSync(file, '{"a":1}\n{"b":');
    const reader = createTailReader(file);
    assert.deepEqual(reader.read(), ['{"a":1}']);
    fs.appendFileSync(file, '2}\n');
    assert.deepEqual(reader.read(), ['{"b":2}']);
    assert.deepEqual(reader.read(), []);
    fs.appendFileSync(file, '{"c":3}\n');
    assert.deepEqual(reader.read(), ['{"c":3}']);
  } finally {
    tmp.remove();
  }
});

test("runViewer replays stdout and stderr, then exits 0 on a terminal state", async () => {
  const run = makeRunDir({ backend: "agy" });
  const out = collector();
  const err = collector();
  try {
    run.appendStdout(J({ event: "init", init: { model: "gemini-3-pro", cwd: "/tmp" } }) + "\n");
    run.appendStdout(
      J({ event: "step_update", step_update: { step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "LIVE_TEXT" } }) + "\n",
    );
    run.appendStderr("note from stderr\n");
    run.writeMeta({ child_pid: null }, "running");

    const done = runViewer({ runDir: run.runDir, out, err, pollMs: 20, idleMs: 60000, interruptGraceMs: 60000 });
    await sleep(80);
    run.writeResult({ state: "completed", reply: "LIVE_TEXT", duration_s: 1.5, exit_code: 0 });
    assert.equal(await done, 0);

    assert.match(out.text, /cli-baton · agy · run a{24}/);
    assert.match(out.text, /→ init · model=gemini-3-pro/);
    assert.match(out.text, /LIVE_TEXT/);
    assert.match(out.text, /! stderr · note from stderr/);
    assert.match(out.text, /运行结束 · completed/);
    assert.equal(err.text, "");
  } finally {
    run.remove();
  }
});

test("runViewer prints the idle status line when nothing arrives", async () => {
  const run = makeRunDir({ backend: "agy" });
  const out = collector();
  try {
    run.writeMeta({ child_pid: process.pid }, "running");
    const done = runViewer({ runDir: run.runDir, out, pollMs: 10, idleMs: 30, interruptGraceMs: 60000 });
    const text = await waitFor(() => (out.text.includes("仍在运行") ? out.text : null), { timeoutMs: 2000, label: "idle status line" });
    assert.match(text, /仍在运行，已 \d+s 无新输出/);
    assert.match(text, /进程 pid \d+ 存活/);
    assert.ok(text.includes(CLEAR_LINE), "the status line must be redrawn in place");

    run.writeResult({ state: "failed", error: "kaboom", reply: "" });
    assert.equal(await done, 0);
    assert.match(out.text, /运行结束 · failed/);
    assert.match(out.text, /error: kaboom/);
    assert.ok(out.text.trimEnd().split("\n").pop().includes("error: kaboom"), "final status must be printed last");
  } finally {
    run.remove();
  }
});

test("runViewer exits 0 for every terminal state", async () => {
  for (const state of ["completed", "failed", "cancelled", "timed_out"]) {
    const run = makeRunDir({ backend: "codex" });
    const out = collector();
    try {
      run.writeResult({ state, reply: "", error: null });
      assert.equal(await runViewer({ runDir: run.runDir, out, pollMs: 5, idleMs: 60000 }), 0, state);
      assert.match(out.text, new RegExp("运行结束 · " + state));
    } finally {
      run.remove();
    }
  }
  // "interrupted" has no result.json; the viewer decides from supervisor
  // liveness once the grace period is over.
  const run = makeRunDir({ backend: "agy" });
  const out = collector();
  try {
    assert.equal(await runViewer({ runDir: run.runDir, out, pollMs: 5, idleMs: 60000, interruptGraceMs: 0 }), 0);
    assert.match(out.text, /运行结束 · interrupted/);
  } finally {
    run.remove();
  }
});

test("runViewer registers its pid and start token in viewer.json", async () => {
  const run = makeRunDir({ backend: "agy" });
  const out = collector();
  try {
    run.writeViewer({ window_id: "5555", opened_at: new Date().toISOString() });
    const done = runViewer({ runDir: run.runDir, out, pollMs: 10, idleMs: 60000, interruptGraceMs: 60000 });
    await sleep(50);
    run.writeResult({ state: "completed", reply: "", duration_s: 0.1, exit_code: 0 });
    assert.equal(await done, 0);
    const info = JSON.parse(fs.readFileSync(path.join(run.runDir, "viewer.json"), "utf8"));
    assert.equal(info.window_id, "5555", "existing fields are preserved");
    assert.equal(info.pid, process.pid);
    assert.ok(info.pid_start && info.pid_start.length > 0, "the start token guards the runner against pid reuse");
  } finally {
    run.remove();
  }
});

test("viewer CLI follows a live run and exits 0 by itself", { timeout: 30000 }, async () => {
  const run = makeRunDir({ backend: "agy", meta: { model: "gemini-3-pro", effort: "high", cwd: "/tmp/live cwd" } });
  const child = spawn(process.execPath, [VIEWER_PATH, run.runDir], {
    env: { ...process.env, CLI_BATON_VIEWER_POLL_MS: "20" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  try {
    await waitFor(() => stdout.includes("cli-baton · agy"), { timeoutMs: 6000, label: "viewer header" });
    run.appendStdout(J({ event: "init", init: { model: "gemini-3-pro", cwd: "/tmp/live cwd", tools: [] } }) + "\n");
    run.appendStdout(
      J({ event: "step_update", step_update: { step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "STREAMED" } }) + "\n",
    );
    await waitFor(() => stdout.includes("STREAMED"), { timeoutMs: 6000, label: "streamed delta" });
    run.writeResult({ state: "completed", reply: "STREAMED", duration_s: 2, exit_code: 0 });

    const result = await exited;
    assert.equal(result.code, 0, "viewer should exit 0 (signal=" + result.signal + ", stderr=" + stderr + ")");
    assert.match(stdout, /model\s+gemini-3-pro/);
    assert.match(stdout, /effort\s+high/);
    assert.match(stdout, /cwd\s+\/tmp\/live cwd/);
    assert.match(stdout, /运行结束 · completed/);
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
    run.remove();
  }
});

test("viewer CLI rejects a missing argument and a non-run directory", async () => {
  const noArgs = await new Promise((resolve) => {
    const child = spawn(process.execPath, [VIEWER_PATH], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("exit", (code) => resolve({ code, stderr }));
  });
  assert.equal(noArgs.code, 2);
  assert.match(noArgs.stderr, /viewer\.mjs <run_dir>/);

  const tmp = makeTmpDir("cli-baton-viewer-bad-");
  try {
    const notRun = await new Promise((resolve) => {
      const child = spawn(process.execPath, [VIEWER_PATH, tmp.path], { stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("exit", (code) => resolve({ code, stderr }));
    });
    assert.equal(notRun.code, 1);
    assert.match(notRun.stderr, /meta\.json missing/);
  } finally {
    tmp.remove();
  }
});
