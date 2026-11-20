import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import * as claudeBackend from "../src/backends/claude.mjs";
import { createRenderer, formatTokens } from "../src/viewer.mjs";
import {
  CLI_PATH,
  FAKE_CLAUDE,
  McpClient,
  fakeEnv,
  isToolError,
  makeCwd,
  makeHome,
  makeTmpDir,
  readArgv,
  sendWait,
  toolPayload,
  waitFor,
} from "./helpers.mjs";

function execShell(command, { env = process.env, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      reject(new Error("command timed out: " + command));
    }, timeoutMs);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function execCli(args, { env = process.env, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      reject(new Error("cli timed out: " + args.join(" ")));
    }, timeoutMs);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function withClient(backend, options, fn, clientInfo) {
  const home = makeHome();
  const logDir = makeTmpDir("cli-baton-log-");
  const env = fakeEnv({ backend, home: home.path, logDir: logDir.path, ...options });
  const client = await McpClient.start({ backend, env, clientInfo });
  try {
    return await fn({ client, logDir: logDir.path, home: home.path, env });
  } finally {
    await client.close().catch(() => {});
    home.remove();
    logDir.remove();
  }
}

/* ------------------------------------------------------------------ */
/* 1. claude backend unit tests                                       */
/* ------------------------------------------------------------------ */

test("claude buildInvocation: full vs read-only, resume, model, effort", () => {
  const full = claudeBackend.buildInvocation({ prompt: "-leading dash", cwd: "/tmp", model: "opus", effort: "xhigh" });
  assert.equal(full.stdin, "chat");
  assert.ok(full.args.includes("-p"));
  assert.ok(full.args.includes("--input-format") && full.args.includes("stream-json"));
  assert.ok(full.args.includes("--output-format") && full.args.includes("stream-json"));
  assert.ok(full.args.includes("--verbose"));
  assert.ok(full.args.includes("--dangerously-skip-permissions"));
  assert.ok(!full.args.includes("--permission-mode"));
  assert.ok(full.args.includes("--model") && full.args.includes("opus"));
  assert.ok(full.args.includes("--effort") && full.args.includes("xhigh"));
  assert.ok(!full.args.includes("-leading dash"));

  const ro = claudeBackend.buildInvocation({ prompt: "review", cwd: "/tmp", sessionId: "sess-123", access: "read-only" });
  assert.ok(ro.args.includes("--resume") && ro.args.includes("sess-123"));
  assert.ok(ro.args.includes("--permission-mode") && ro.args.includes("plan"));
  assert.ok(!ro.args.includes("--dangerously-skip-permissions"));
  assert.ok(!ro.args.includes("-c") && !ro.args.includes("--continue"));
});

test("claude parseOutput handles stream-json success, error result, missing result and empty reply", () => {
  const okStream = [
    JSON.stringify({ type: "system", subtype: "init", session_id: "sid-1" }),
    JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "HI" } } }),
    JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "HI", session_id: "sid-1", usage: { input_tokens: 3, output_tokens: 2 } }),
  ].join("\n");
  const ok = claudeBackend.parseOutput({ stdout: okStream, stderr: "", exitCode: 0 });
  assert.equal(ok.state, "completed");
  assert.equal(ok.reply, "HI");
  assert.equal(ok.sessionId, "sid-1");
  assert.equal(ok.error, null);

  const errStream = JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "boom", session_id: "sid-2" });
  const err = claudeBackend.parseOutput({ stdout: errStream, stderr: "", exitCode: 0 });
  assert.equal(err.state, "failed");
  assert.match(err.error, /boom/);

  const noResult = JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "partial" } } });
  const partial = claudeBackend.parseOutput({ stdout: noResult, stderr: "", exitCode: 0 });
  assert.equal(partial.state, "failed");
  assert.match(partial.error, /without a result event/);
  assert.equal(partial.reply, "partial");
});

test("claude sanitizeEnv removes CLAUDECODE and listModels parses --help aliases", async () => {
  const clean = claudeBackend.sanitizeEnv({ PATH: "/bin", CLAUDECODE: "1", KEEP: "yes" });
  assert.equal(clean.CLAUDECODE, undefined);
  assert.equal(clean.KEEP, "yes");

  const logDir = makeTmpDir("cli-baton-claude-help-");
  try {
    const result = await claudeBackend.listModels({
      execPath: FAKE_CLAUDE,
      env: { ...process.env, FAKE_LOG_DIR: logDir.path },
    });
    assert.equal(result.source, "claude --help");
    assert.deepEqual(
      result.models.map((m) => m.id),
      ["fable", "opus", "sonnet"],
    );
  } finally {
    logDir.remove();
  }
});

/* ------------------------------------------------------------------ */
/* 2. claude backend MCP lifecycle & viewer rendering                 */
/* ------------------------------------------------------------------ */

test("claude MCP server exposes claude_* tools, completes send/wait, strips CLAUDECODE, and supports claude_say", async () => {
  await withClient("claude", { mode: "echo", turnDelayMs: 600, extra: { CLAUDECODE: "1" } }, async ({ client, logDir }) => {
    const listed = await client.request("tools/list", {});
    const names = listed.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "claude_cancel",
      "claude_list_models",
      "claude_list_runs",
      "claude_say",
      "claude_send",
      "claude_status",
      "claude_wait",
    ]);

    const models = toolPayload(await client.callTool("claude_list_models", {}));
    assert.deepEqual(
      models.models.map((m) => m.id),
      ["fable", "opus", "sonnet"],
    );

    const cwd = makeCwd().path;
    const sent = toolPayload(await client.callTool("claude_send", { message: "first msg", cwd, model: "opus", effort: "high", timeout_s: 30 }));
    assert.equal(sent.backend, "claude");
    assert.ok(typeof sent.wait_command === "string" && sent.wait_command.includes("--backend claude"));

    // Queue a second turn while the first is running
    await waitFor(async () => toolPayload(await client.callTool("claude_status", { run_id: sent.run_id })).state === "running", {
      timeoutMs: 8000,
      label: "claude run to enter running",
    });
    const said = toolPayload(await client.callTool("claude_say", { run_id: sent.run_id, text: "second msg" }));
    assert.equal(said.say.queued, true);

    const done = toolPayload(await client.callTool("claude_wait", { run_id: sent.run_id, timeout_s: 30 }));
    assert.equal(done.state, "completed");
    assert.equal(done.turns.length, 2);
    assert.equal(done.turns[0].reply, "turn 1: first msg");
    assert.equal(done.turns[1].reply, "turn 2: second msg");
    assert.equal(done.reply, "turn 2: second msg");
    assert.equal(done.session_id, "fake-session-0001");
    assert.equal(fs.readFileSync(path.join(logDir, "claudecode.txt"), "utf8"), "UNSET");

    const argv = readArgv(logDir).argv;
    assert.ok(argv.includes("--model") && argv.includes("opus"));
    assert.ok(argv.includes("--effort") && argv.includes("high"));
    assert.ok(argv.includes("--dangerously-skip-permissions"));
  });
});

test("claude read-only uses --permission-mode plan and error-result maps to failed", async () => {
  await withClient("claude", { mode: "error-result" }, async ({ client, logDir }) => {
    const cwd = makeCwd().path;
    const { final } = await sendWait(client, { prefix: "claude", message: "check", cwd, access: "read-only", waitTimeoutMs: 20000 });
    assert.equal(final.state, "failed");
    assert.match(final.error, /simulated claude error/);
    const argv = readArgv(logDir).argv;
    assert.ok(argv.includes("--permission-mode") && argv.includes("plan"));
    assert.ok(!argv.includes("--dangerously-skip-permissions"));
  });
});

test("viewer renderer formats Claude stream-json without duplicating deltas and formats cached tokens", () => {
  const r = createRenderer({ timestamp: false });
  const init = r.line(JSON.stringify({ type: "system", subtype: "init", model: "claude-opus-5-5", permissionMode: "plan", session_id: "12345678-aaaa" }));
  assert.match(init, /init.*claude-opus-5-5.*plan/);
  const tool = r.line(JSON.stringify({ type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use", name: "Read" } } }));
  assert.match(tool, /tool.*Read/);
  const d1 = r.line(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello " } } }));
  const d2 = r.line(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "world" } } }));
  assert.equal(d1 + d2, "Hello world");
  // Duplicate assistant message after deltas is suppressed
  const dup = r.line(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Hello world" }] } }));
  assert.equal(dup, "");
  const res = r.line(JSON.stringify({ type: "result", subtype: "success", is_error: false, duration_ms: 1500, total_cost_usd: 0.0123, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 200 } }));
  assert.match(res, /result.*success.*1\.5s.*cached=200.*\$0\.0123/);
  assert.match(formatTokens({ input_tokens: 4, output_tokens: 6, cache_read_input_tokens: 50 }), /cached=50/);
});

/* ------------------------------------------------------------------ */
/* 3. wait_command, client detection & cli.mjs wait                   */
/* ------------------------------------------------------------------ */

test("wait_command is returned for Claude/Antigravity clients, executes to completion, and is omitted for Codex", async () => {
  // Claude client gets wait_command + Claude Bash background hint
  await withClient(
    "agy",
    { mode: "sleep", sleepMs: 600, text: "WAKE_OK" },
    async ({ client }) => {
      const sent = toolPayload(await client.callTool("agy_send", { message: "hello", cwd: makeCwd().path, timeout_s: 30 }));
      assert.equal(typeof sent.wait_command, "string");
      assert.match(sent.wait_command, /cli\.mjs"\s+wait\s+--backend\s+agy\s+[0-9a-f]{24}/);
      assert.match(sent.hint, /run_in_background/);

      // Running wait_command directly in a shell blocks until completion and prints the result JSON
      const res = await execShell(sent.wait_command);
      assert.equal(res.code, 0, "expected exit 0, stderr=" + res.stderr);
      const payload = JSON.parse(res.stdout);
      assert.equal(payload.run_id, sent.run_id);
      assert.equal(payload.state, "completed");
      assert.equal(payload.reply, "WAKE_OK");
    },
    { name: "claude-code", version: "2.1.325" },
  );

  // Antigravity client gets wait_command + Antigravity run_command hint
  await withClient(
    "claude",
    { mode: "sleep", sleepMs: 400, text: "AGY_CALLS_CLAUDE_OK" },
    async ({ client }) => {
      const sent = toolPayload(await client.callTool("claude_send", { message: "hi", cwd: makeCwd().path, timeout_s: 30 }));
      assert.equal(typeof sent.wait_command, "string");
      assert.match(sent.hint, /WaitMsBeforeAsync/);

      const res = await execShell(sent.wait_command);
      assert.equal(res.code, 0);
      const payload = JSON.parse(res.stdout);
      assert.equal(payload.state, "completed");
      assert.equal(payload.reply, "AGY_CALLS_CLAUDE_OK");
    },
    { name: "antigravity", version: "2.0.0" },
  );

  // Codex client does NOT receive wait_command; its wait tool defaults to 1800s
  await withClient(
    "agy",
    { text: "CODEX_CALLS_AGY_OK" },
    async ({ client }) => {
      const listed = await client.request("tools/list", {});
      const waitTool = listed.tools.find((t) => t.name === "agy_wait");
      assert.equal(waitTool.inputSchema.properties.timeout_s.default, 1800);
      assert.equal(waitTool.inputSchema.properties.timeout_s.maximum, 3600);

      const sent = toolPayload(await client.callTool("agy_send", { message: "hi", cwd: makeCwd().path, timeout_s: 30 }));
      assert.equal(sent.wait_command, undefined);
      assert.match(sent.hint, /agy_wait/);
      const done = toolPayload(await client.callTool("agy_wait", { run_id: sent.run_id }));
      assert.equal(done.state, "completed");
      assert.equal(done.reply, "CODEX_CALLS_AGY_OK");
    },
    { name: "codex-mcp-client", version: "0.101.0" },
  );
});

test("cli.mjs wait exit codes: 1 on failed, 2 on stalled, 3 on wait timeout, 1 on missing run", async () => {
  // Failed run -> exit 1
  await withClient("claude", { mode: "fail", exitCode: 2, stderr: "boom" }, async ({ client, home }) => {
    const sent = toolPayload(await client.callTool("claude_send", { message: "fail", cwd: makeCwd().path, timeout_s: 30 }));
    const res = await execCli(["wait", "--backend", "claude", sent.run_id, "--home", home, "--poll-ms", "100"]);
    assert.equal(res.code, 1);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.state, "failed");
  });

  // Stalled run -> exit 2 with stalled:true (without killing the run)
  await withClient("claude", { mode: "silent", silenceMs: 5000, text: "RECOVERED" }, async ({ client, home }) => {
    const sent = toolPayload(await client.callTool("claude_send", { message: "slow", cwd: makeCwd().path, timeout_s: 30, stall_s: 1 }));
    const res = await execCli(["wait", "--backend", "claude", sent.run_id, "--home", home, "--poll-ms", "100"]);
    assert.equal(res.code, 2);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.stalled, true);
    assert.equal(payload.state, "running");
    await client.callTool("claude_cancel", { run_id: sent.run_id });
  });

  // Wait --timeout expires -> exit 3 with timed_out:true
  await withClient("codex", { mode: "sleep", sleepMs: 4000 }, async ({ client, home }) => {
    const sent = toolPayload(await client.callTool("codex_send", { message: "slow", cwd: makeCwd().path, timeout_s: 30 }));
    const res = await execCli(["wait", "--backend", "codex", sent.run_id, "--home", home, "--timeout", "1", "--poll-ms", "100"]);
    assert.equal(res.code, 3);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.timed_out, true);
    await client.callTool("codex_cancel", { run_id: sent.run_id });
  });

  // Missing run -> exit 1
  const missing = await execCli(["wait", "--backend", "agy", "000000000000000000000000", "--home", makeHome().path]);
  assert.equal(missing.code, 1);
  assert.match(JSON.parse(missing.stdout).error, /not found/i);
});
