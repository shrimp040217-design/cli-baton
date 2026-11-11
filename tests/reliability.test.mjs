import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import {
  McpClient,
  fakeEnv,
  isProcessAlive,
  isToolError,
  makeCwd,
  makeHome,
  makeTmpDir,
  readArgv,
  readJsonIfExists,
  sleep,
  toolPayload,
  waitFor,
  waitForTerminal,
} from "./helpers.mjs";

const RUN_ID_RE = /^[0-9a-f]{24}$/;

/**
 * Per-test scratch directories: CLI_BATON_HOME, a working directory and one or
 * more fake-CLI log directories. Every test creates (and removes) its own set,
 * so no test depends on ordering or shared state.
 */
function makeDirs() {
  const parts = [makeHome(), makeCwd(), makeTmpDir("cli-baton-log-")];
  return {
    home: parts[0].path,
    cwd: parts[1].path,
    logDir: parts[2].path,
    addLogDir() {
      const extra = makeTmpDir("cli-baton-log-");
      parts.push(extra);
      return extra.path;
    },
    cleanup() {
      for (const part of parts) {
        try {
          part.remove();
        } catch {
          // ignore
        }
      }
    },
  };
}

function readPidFile(file) {
  try {
    const value = Number(fs.readFileSync(file, "utf8").trim());
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function killPid(pid) {
  if (!pid) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // ignore
  }
}

/** Kill any fake CLI / grandchild recorded by the fixture, so no process leaks. */
function killRecordedProcs(logDir) {
  try {
    const info = readJsonIfExists(path.join(logDir, "argv.json"));
    if (info && Number.isInteger(info.pid)) killPid(info.pid);
  } catch {
    // ignore
  }
  killPid(readPidFile(path.join(logDir, "grandchild.pid")));
}

async function closeClient(client) {
  if (!client) return;
  try {
    await client.close({ signal: "SIGKILL", timeoutMs: 2000 });
  } catch {
    // ignore
  }
}

async function cancelQuietly(client, prefix, runId) {
  if (!client || !runId) return null;
  try {
    return toolPayload(await client.callTool(prefix + "_cancel", { run_id: runId }, 20000));
  } catch {
    return null;
  }
}

function assertToolError(message, label) {
  assert.ok(message, label + ": expected a JSON-RPC response");
  assert.equal(
    message.error,
    undefined,
    label + ": expected tool-level isError, got JSON-RPC error " + JSON.stringify(message.error),
  );
  const payload = toolPayload(message);
  assert.equal(isToolError(message), true, label + ": expected result.isError === true, got " + JSON.stringify(payload));
  assert.equal(
    typeof payload.error,
    "string",
    label + ": expected text JSON {error:<string>}, got " + JSON.stringify(payload),
  );
  assert.ok(payload.error.length > 0, label + ": error message must not be empty");
  return payload;
}

async function sendRun(client, prefix, args) {
  const message = await client.callTool(prefix + "_send", args, 20000);
  assert.equal(isToolError(message), false, "send failed: " + JSON.stringify(toolPayload(message)));
  const payload = toolPayload(message);
  assert.match(payload.run_id, RUN_ID_RE, "run_id must be 24 lowercase hex chars, got " + payload.run_id);
  return payload;
}

async function pollStatusUntil(client, prefix, runId, predicate, options = {}) {
  const { timeoutMs = 8000, intervalMs = 100, label = "status condition" } = options;
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const message = await client.callTool(prefix + "_status", { run_id: runId }, 10000);
    assert.equal(isToolError(message), false, "status returned a tool error: " + JSON.stringify(toolPayload(message)));
    last = toolPayload(message);
    if (predicate(last)) return last;
    await sleep(intervalMs);
  }
  throw new Error("timed out waiting for " + label + " (last status: " + JSON.stringify(last) + ")");
}

// (1) cancel must kill the whole process group, including a grandchild the CLI
// spawned; a second cancel is a no-op returning the cancelled state.
test("cancel kills the whole process group including a grandchild", { timeout: 45000 }, async () => {
  const dirs = makeDirs();
  const backend = "agy";
  const prefix = "agy";
  const env = fakeEnv({
    backend,
    home: dirs.home,
    logDir: dirs.logDir,
    mode: "grandchild",
    sleepMs: 60000,
  });
  let client = null;
  let runId = null;
  try {
    client = await McpClient.start({ backend, env, cwd: dirs.cwd });
    const sent = await sendRun(client, prefix, { message: "grandchild test", cwd: dirs.cwd });
    runId = sent.run_id;
    assert.equal(sent.backend, backend);
    assert.ok(fs.existsSync(sent.run_dir), "run_dir should exist on disk: " + sent.run_dir);

    const argvPath = path.join(dirs.logDir, "argv.json");
    const grandchildPidPath = path.join(dirs.logDir, "grandchild.pid");
    await waitFor(() => fs.existsSync(argvPath), { timeoutMs: 10000, label: "fake argv.json" });
    await waitFor(() => fs.existsSync(grandchildPidPath), { timeoutMs: 10000, label: "grandchild.pid" });

    const fakePid = readArgv(dirs.logDir).pid;
    const grandchildPid = readPidFile(grandchildPidPath);
    assert.ok(Number.isInteger(fakePid) && fakePid > 0, "argv.json should record the fake CLI pid");
    assert.ok(grandchildPid, "grandchild.pid should record a pid");
    await waitFor(() => isProcessAlive(fakePid) && isProcessAlive(grandchildPid), {
      timeoutMs: 5000,
      label: "fake CLI and grandchild to be alive before cancel",
    });

    const cancelMessage = await client.callTool(prefix + "_cancel", { run_id: runId }, 20000);
    assert.equal(
      isToolError(cancelMessage),
      false,
      "cancel should not be a tool error: " + JSON.stringify(toolPayload(cancelMessage)),
    );
    const cancelled = toolPayload(cancelMessage);
    assert.equal(cancelled.run_id, runId);
    assert.equal(cancelled.state, "cancelled", "cancel should return the cancelled state: " + JSON.stringify(cancelled));

    await waitFor(() => !isProcessAlive(fakePid), {
      timeoutMs: 6000,
      intervalMs: 100,
      label: "fake CLI to die after cancel",
    });
    await waitFor(() => !isProcessAlive(grandchildPid), {
      timeoutMs: 6000,
      intervalMs: 100,
      label: "grandchild to die after cancel (process group kill)",
    });

    const secondMessage = await client.callTool(prefix + "_cancel", { run_id: runId }, 20000);
    assert.equal(
      isToolError(secondMessage),
      false,
      "second cancel of a cancelled run should not be a tool error",
    );
    const second = toolPayload(secondMessage);
    assert.equal(second.state, "cancelled", "second cancel should still report cancelled: " + JSON.stringify(second));
  } finally {
    await cancelQuietly(client, prefix, runId);
    await closeClient(client);
    killRecordedProcs(dirs.logDir);
    dirs.cleanup();
  }
});

// (2) cancel on an already-terminal run is a read-only no-op.
test("cancel on an already-completed run returns completed without isError", { timeout: 30000 }, async () => {
  const dirs = makeDirs();
  const backend = "agy";
  const prefix = "agy";
  const env = fakeEnv({ backend, home: dirs.home, logDir: dirs.logDir, mode: "success" });
  let client = null;
  let runId = null;
  try {
    client = await McpClient.start({ backend, env, cwd: dirs.cwd });
    const sent = await sendRun(client, prefix, { message: "already done", cwd: dirs.cwd });
    runId = sent.run_id;

    const final = await waitForTerminal(client, prefix, runId, { timeoutMs: 20000 });
    assert.ok(final, "wait should return a payload");
    assert.equal(final.state, "completed", "run should complete: " + JSON.stringify(final));
    assert.equal(final.reply, "FAKE_OK");

    const cancelMessage = await client.callTool(prefix + "_cancel", { run_id: runId }, 20000);
    assert.equal(
      isToolError(cancelMessage),
      false,
      "cancel of a completed run must not be a tool error: " + JSON.stringify(toolPayload(cancelMessage)),
    );
    const payload = toolPayload(cancelMessage);
    assert.equal(payload.run_id, runId);
    assert.equal(payload.state, "completed", "cancel should report the current completed state: " + JSON.stringify(payload));
    assert.equal(payload.reply, "FAKE_OK", "cancel payload should keep the completed reply");
  } finally {
    await cancelQuietly(client, prefix, runId);
    await closeClient(client);
    killRecordedProcs(dirs.logDir);
    dirs.cleanup();
  }
});

// (3) SIGKILLing the detached runner must surface as interrupted, and the
// runner obviously cannot write result.json anymore.
test("killing the runner marks the run interrupted without producing result.json", { timeout: 45000 }, async () => {
  const dirs = makeDirs();
  const backend = "agy";
  const prefix = "agy";
  const env = fakeEnv({ backend, home: dirs.home, logDir: dirs.logDir, mode: "sleep", sleepMs: 5000 });
  let client = null;
  let runId = null;
  let fakePid = null;
  try {
    client = await McpClient.start({ backend, env, cwd: dirs.cwd });
    const sent = await sendRun(client, prefix, { message: "runner kill test", cwd: dirs.cwd });
    runId = sent.run_id;
    const runDir = sent.run_dir;

    const supervisorPath = path.join(runDir, "supervisor.json");
    await waitFor(() => fs.existsSync(supervisorPath), { timeoutMs: 10000, label: "supervisor.json" });
    const supervisor = readJsonIfExists(supervisorPath);
    assert.ok(supervisor, "supervisor.json should parse: " + JSON.stringify(supervisor));
    assert.ok(
      Number.isInteger(supervisor.pid) && supervisor.pid > 0,
      "supervisor.pid should be a pid: " + JSON.stringify(supervisor),
    );
    assert.ok(
      supervisor.pid_start !== undefined && supervisor.pid_start !== null,
      "supervisor.pid_start should be present: " + JSON.stringify(supervisor),
    );
    await waitFor(() => isProcessAlive(supervisor.pid), { timeoutMs: 5000, label: "runner pid to be alive" });
    await waitFor(() => fs.existsSync(path.join(dirs.logDir, "argv.json")), {
      timeoutMs: 10000,
      label: "fake CLI argv.json",
    });
    fakePid = readArgv(dirs.logDir).pid;

    process.kill(supervisor.pid, "SIGKILL");

    const statusPayload = await pollStatusUntil(client, prefix, runId, (payload) => payload.state === "interrupted", {
      timeoutMs: 6000,
      intervalMs: 150,
      label: "state 'interrupted' after SIGKILLing the runner",
    });
    assert.equal(statusPayload.state, "interrupted");
    assert.equal(
      fs.existsSync(path.join(runDir, "result.json")),
      false,
      "a SIGKILLed runner must not leave a result.json behind",
    );
    await sleep(500);
    assert.equal(
      fs.existsSync(path.join(runDir, "result.json")),
      false,
      "result.json must still be absent after the interrupted status was observed",
    );
  } finally {
    await cancelQuietly(client, prefix, runId);
    await closeClient(client);
    if (fakePid) killPid(fakePid);
    killRecordedProcs(dirs.logDir);
    dirs.cleanup();
  }
});

// (4) runs survive the MCP server: a detached runner keeps going after the
// server is SIGKILLed, and a fresh server can observe the result.
test("detached run completes after the MCP server is SIGKILLed", { timeout: 45000 }, async () => {
  const dirs = makeDirs();
  const backend = "agy";
  const prefix = "agy";
  const env = fakeEnv({ backend, home: dirs.home, logDir: dirs.logDir, mode: "sleep", sleepMs: 2500 });
  let clientA = null;
  let clientB = null;
  let runId = null;
  try {
    clientA = await McpClient.start({ backend, env, cwd: dirs.cwd });
    const sent = await sendRun(clientA, prefix, { message: "outlives server", cwd: dirs.cwd });
    runId = sent.run_id;

    await clientA.kill("SIGKILL");
    assert.equal(clientA.exit && clientA.exit.signal, "SIGKILL", "server should die by SIGKILL");

    await sleep(4000);

    clientB = await McpClient.start({ backend, env, cwd: dirs.cwd });
    const final = await waitForTerminal(clientB, prefix, runId, { timeoutMs: 15000 });
    assert.ok(final, "wait should return a payload");
    assert.equal(final.state, "completed", "detached run should complete: " + JSON.stringify(final));
    assert.equal(final.reply, "FAKE_OK", "detached run should keep its reply");
  } finally {
    await cancelQuietly(clientB, prefix, runId);
    await closeClient(clientA);
    await closeClient(clientB);
    killRecordedProcs(dirs.logDir);
    dirs.cleanup();
  }
});

// (5) stdin close is the clean shutdown path: exit 0, no background task kill.
test("stdin close exits 0 while a background run still completes", { timeout: 45000 }, async () => {
  const dirs = makeDirs();
  const backend = "agy";
  const prefix = "agy";
  const env = fakeEnv({ backend, home: dirs.home, logDir: dirs.logDir, mode: "sleep", sleepMs: 2000 });
  let client = null;
  let client2 = null;
  let runId = null;
  try {
    client = await McpClient.start({ backend, env, cwd: dirs.cwd });
    const sent = await sendRun(client, prefix, { message: "stdin close test", cwd: dirs.cwd });
    runId = sent.run_id;

    client.proc.stdin.end();
    const exit = await client.waitExit(3000);
    assert.ok(exit, "server should exit within 3s after stdin closes, but it is still running");
    assert.equal(exit.code, 0, "server should exit 0 on stdin close, got " + JSON.stringify(exit));

    await sleep(1500);
    client2 = await McpClient.start({ backend, env, cwd: dirs.cwd });
    const final = await waitForTerminal(client2, prefix, runId, { timeoutMs: 15000 });
    assert.ok(final, "wait should return a payload");
    assert.equal(final.state, "completed", "run should complete even after stdin close: " + JSON.stringify(final));
    assert.equal(final.reply, "FAKE_OK");
  } finally {
    await cancelQuietly(client2, prefix, runId);
    await closeClient(client);
    await closeClient(client2);
    killRecordedProcs(dirs.logDir);
    dirs.cleanup();
  }
});

test("a CLI exiting before reading stdin is failed with its stderr, not interrupted", { timeout: 45000 }, async () => {
  const dirs = makeDirs();
  const env = fakeEnv({ backend: "codex", home: dirs.home, logDir: dirs.logDir });
  const script = path.join(dirs.logDir, "dies-early.sh");
  fs.writeFileSync(script, "#!/bin/sh\necho 'env: node: No such file or directory' >&2\nexit 127\n", { mode: 0o755 });
  let client = null;
  try {
    client = await McpClient.start({ backend: "codex", env: { ...env, CODEX_BIN: script }, cwd: dirs.cwd });
    const sent = await sendRun(client, "codex", { message: "x".repeat(900000), cwd: dirs.cwd });
    const final = await waitForTerminal(client, "codex", sent.run_id, { timeoutMs: 15000 });
    assert.equal(final.state, "failed", JSON.stringify({ state: final.state, error: final.error }));
    assert.equal(final.exit_code, 127);
    assert.match(final.error, /node: No such file/);
  } finally {
    await closeClient(client);
    dirs.cleanup();
  }
});

test("a node-shebang CLI runs when PATH omits the Node folder", { timeout: 45000 }, async () => {
  const dirs = makeDirs();
  const env = fakeEnv({ backend: "codex", home: dirs.home, logDir: dirs.logDir });
  const script = path.join(dirs.logDir, "node-cli.mjs");
  const events = [
    { type: "thread.started", thread_id: "path-test" },
    { type: "item.completed", item: { type: "agent_message", text: "PATH_OK" } },
    { type: "turn.completed", usage: {} },
  ];
  fs.writeFileSync(
    script,
    "#!/usr/bin/env node\nprocess.stdin.resume();process.stdin.on('end',()=>{for(const e of " + JSON.stringify(events) + ")console.log(JSON.stringify(e))});\n",
    { mode: 0o755 },
  );
  let client = null;
  try {
    client = await McpClient.start({ backend: "codex", env: { ...env, CODEX_BIN: script, PATH: "/usr/bin:/bin" }, cwd: dirs.cwd });
    const sent = await sendRun(client, "codex", { message: "hello", cwd: dirs.cwd });
    const final = await waitForTerminal(client, "codex", sent.run_id, { timeoutMs: 15000 });
    assert.equal(final.state, "completed", JSON.stringify({ state: final.state, error: final.error }));
    assert.equal(final.reply, "PATH_OK");
  } finally {
    await closeClient(client);
    dirs.cleanup();
  }
});

// (6) the detached runner enforces send timeout_s; the run ends timed_out and
// the fake CLI is dead. result.json reflects the terminal state.
test("runner enforces the send timeout and reports timed_out", { timeout: 45000 }, async () => {
  const dirs = makeDirs();
  const backend = "agy";
  const prefix = "agy";
  const env = fakeEnv({ backend, home: dirs.home, logDir: dirs.logDir, mode: "sleep", sleepMs: 30000 });
  let client = null;
  let runId = null;
  let fakePid = null;
  try {
    client = await McpClient.start({ backend, env, cwd: dirs.cwd });
    const sent = await sendRun(client, prefix, { message: "timeout test", cwd: dirs.cwd, timeout_s: 10 });
    runId = sent.run_id;
    const runDir = sent.run_dir;

    await waitFor(() => fs.existsSync(path.join(dirs.logDir, "argv.json")), {
      timeoutMs: 10000,
      label: "fake CLI argv.json",
    });
    fakePid = readArgv(dirs.logDir).pid;
    assert.ok(isProcessAlive(fakePid), "fake CLI should be running before the timeout fires");

    const final = await waitForTerminal(client, prefix, runId, { timeoutMs: 25000, perCallS: 20 });
    assert.ok(final, "wait should return a payload");
    assert.equal(final.state, "timed_out", "runner should stop the run with timed_out: " + JSON.stringify(final));

    await waitFor(() => !isProcessAlive(fakePid), {
      timeoutMs: 6000,
      intervalMs: 100,
      label: "fake CLI to be killed on timeout",
    });

    const resultPath = path.join(runDir, "result.json");
    await waitFor(() => fs.existsSync(resultPath), { timeoutMs: 5000, label: "timed_out result.json" });
    const result = readJsonIfExists(resultPath);
    assert.ok(result, "result.json should parse");
    assert.equal(result.state, "timed_out", "result.json should record the timed_out state: " + JSON.stringify(result));
  } finally {
    await cancelQuietly(client, prefix, runId);
    await closeClient(client);
    if (fakePid) killPid(fakePid);
    killRecordedProcs(dirs.logDir);
    dirs.cleanup();
  }
});

// (7) run ids are validated for every per-run tool: traversal/injection/unknown
// ids are tool errors, never crashes or path escapes.
test("invalid and traversal run ids are rejected for status, wait and cancel", { timeout: 45000 }, async () => {
  const dirs = makeDirs();
  const backend = "agy";
  const prefix = "agy";
  const env = fakeEnv({ backend, home: dirs.home, logDir: dirs.logDir, mode: "success" });
  let client = null;
  try {
    client = await McpClient.start({ backend, env, cwd: dirs.cwd });

    const badIds = [
      "../../etc/passwd",
      "../x",
      "abc",
      "RUN_ABC",
      "a".repeat(24),
      "0".repeat(24),
    ];
    const tools = [prefix + "_status", prefix + "_wait", prefix + "_cancel"];

    for (const id of badIds) {
      for (const tool of tools) {
        const args = tool === prefix + "_wait" ? { run_id: id, timeout_s: 2 } : { run_id: id };
        const message = await client.callTool(tool, args, 10000);
        assertToolError(message, tool + " with run_id " + JSON.stringify(id));
      }
    }

    const pong = await client.request("ping", undefined, 5000);
    assert.deepEqual(pong, {}, "server should stay alive and answer ping after rejected run ids");
    assert.equal(client.exit, null, "MCP server process should still be running");
  } finally {
    await closeClient(client);
    killRecordedProcs(dirs.logDir);
    dirs.cleanup();
  }
});

// (8) a run id from one backend namespace must not resolve through the other
// backend, even when both share the same CLI_BATON_HOME.
test("run ids are isolated per backend when sharing CLI_BATON_HOME", { timeout: 45000 }, async () => {
  const dirs = makeDirs();
  const codexLogDir = dirs.addLogDir();
  const agyEnv = fakeEnv({ backend: "agy", home: dirs.home, logDir: dirs.logDir, mode: "success" });
  const codexEnv = fakeEnv({ backend: "codex", home: dirs.home, logDir: codexLogDir, mode: "success" });
  let agyClient = null;
  let codexClient = null;
  try {
    agyClient = await McpClient.start({ backend: "agy", env: agyEnv, cwd: dirs.cwd });
    const sent = await sendRun(agyClient, "agy", { message: "agy only run", cwd: dirs.cwd });
    const agyRunId = sent.run_id;
    const agyFinal = await waitForTerminal(agyClient, "agy", agyRunId, { timeoutMs: 20000 });
    assert.equal(agyFinal.state, "completed");

    codexClient = await McpClient.start({ backend: "codex", env: codexEnv, cwd: dirs.cwd });
    const statusMessage = await codexClient.callTool("codex_status", { run_id: agyRunId }, 10000);
    assertToolError(statusMessage, "codex status for an agy run id");

    const listMessage = await codexClient.callTool("codex_list_runs", {}, 10000);
    assert.equal(
      isToolError(listMessage),
      false,
      "codex_list_runs should succeed: " + JSON.stringify(toolPayload(listMessage)),
    );
    const list = toolPayload(listMessage);
    assert.ok(Array.isArray(list.runs), "list_runs should return a runs array: " + JSON.stringify(list));
    assert.ok(
      list.runs.every((run) => run.run_id !== agyRunId),
      "codex list_runs must not expose agy runs: " + JSON.stringify(list),
    );
  } finally {
    await closeClient(agyClient);
    await closeClient(codexClient);
    killRecordedProcs(dirs.logDir);
    killRecordedProcs(codexLogDir);
    dirs.cleanup();
  }
});

// (9) supervisor.json and a heartbeat that keeps refreshing while the runner is
// alive.
test("running runs expose supervisor.json and a refreshed heartbeat.json", { timeout: 45000 }, async () => {
  const dirs = makeDirs();
  const backend = "agy";
  const prefix = "agy";
  const env = fakeEnv({ backend, home: dirs.home, logDir: dirs.logDir, mode: "sleep", sleepMs: 8000 });
  let client = null;
  let runId = null;
  try {
    client = await McpClient.start({ backend, env, cwd: dirs.cwd });
    const sent = await sendRun(client, prefix, { message: "heartbeat test", cwd: dirs.cwd });
    runId = sent.run_id;
    const runDir = sent.run_dir;

    const supervisorPath = path.join(runDir, "supervisor.json");
    const heartbeatPath = path.join(runDir, "heartbeat.json");
    await waitFor(() => fs.existsSync(supervisorPath), { timeoutMs: 10000, label: "supervisor.json" });
    await waitFor(() => fs.existsSync(heartbeatPath), { timeoutMs: 10000, label: "heartbeat.json" });

    const supervisor = readJsonIfExists(supervisorPath);
    assert.ok(supervisor, "supervisor.json should parse: " + JSON.stringify(supervisor));
    assert.ok(
      Number.isInteger(supervisor.pid) && supervisor.pid > 0,
      "supervisor.pid should be a pid: " + JSON.stringify(supervisor),
    );
    assert.ok(
      supervisor.pid_start !== undefined && supervisor.pid_start !== null,
      "supervisor.pid_start should be present: " + JSON.stringify(supervisor),
    );
    assert.ok(isProcessAlive(supervisor.pid), "supervisor pid should be alive while the run is running");

    const firstHeartbeat = readJsonIfExists(heartbeatPath);
    assert.ok(firstHeartbeat, "heartbeat.json should parse");
    assert.equal(
      typeof firstHeartbeat.at,
      "number",
      "heartbeat.at should be epoch ms, got " + JSON.stringify(firstHeartbeat),
    );
    assert.ok(
      Math.abs(Date.now() - firstHeartbeat.at) <= 10000,
      "heartbeat.at should be recent, got " + firstHeartbeat.at + " vs now " + Date.now(),
    );

    const firstAt = firstHeartbeat.at;
    await waitFor(
      () => {
        const heartbeat = readJsonIfExists(heartbeatPath);
        return Boolean(heartbeat && typeof heartbeat.at === "number" && heartbeat.at > firstAt);
      },
      { timeoutMs: 7000, intervalMs: 100, label: "heartbeat.at to be refreshed while running" },
    );
    const refreshed = readJsonIfExists(heartbeatPath);
    assert.ok(
      Math.abs(Date.now() - refreshed.at) <= 10000,
      "refreshed heartbeat.at should stay recent, got " + refreshed.at + " vs now " + Date.now(),
    );
  } finally {
    await cancelQuietly(client, prefix, runId);
    await closeClient(client);
    killRecordedProcs(dirs.logDir);
    dirs.cleanup();
  }
});

// (10) terminal JSON is written atomically: no leftover temp files, result.json
// parses and records the completed state.
test("completed runs leave no temp files and a parseable result.json", { timeout: 30000 }, async () => {
  const dirs = makeDirs();
  const backend = "agy";
  const prefix = "agy";
  const env = fakeEnv({ backend, home: dirs.home, logDir: dirs.logDir, mode: "success" });
  let client = null;
  let runId = null;
  try {
    client = await McpClient.start({ backend, env, cwd: dirs.cwd });
    const sent = await sendRun(client, prefix, { message: "atomic json test", cwd: dirs.cwd });
    runId = sent.run_id;
    const runDir = sent.run_dir;

    const final = await waitForTerminal(client, prefix, runId, { timeoutMs: 20000 });
    assert.equal(final.state, "completed", "run should complete: " + JSON.stringify(final));

    const resultPath = path.join(runDir, "result.json");
    await waitFor(
      () => {
        const result = readJsonIfExists(resultPath);
        return Boolean(result && result.state === "completed");
      },
      { timeoutMs: 5000, label: "result.json with state completed" },
    );

    const entries = fs.readdirSync(runDir);
    const leftovers = entries.filter((name) => /\.tmp/i.test(name));
    assert.deepEqual(leftovers, [], "run_dir must not contain leftover tmp files: " + leftovers.join(", "));

    const result = readJsonIfExists(resultPath);
    assert.ok(result, "result.json should parse");
    assert.equal(result.state, "completed", "result.json should record completed: " + JSON.stringify(result));

    const meta = readJsonIfExists(path.join(runDir, "meta.json"));
    assert.ok(meta, "meta.json should parse");
  } finally {
    await cancelQuietly(client, prefix, runId);
    await closeClient(client);
    killRecordedProcs(dirs.logDir);
    dirs.cleanup();
  }
});

// (11) status while active reports running plus a string-array tail.
test("status reports running state and a string array tail", { timeout: 30000 }, async () => {
  const dirs = makeDirs();
  const backend = "agy";
  const prefix = "agy";
  const env = fakeEnv({ backend, home: dirs.home, logDir: dirs.logDir, mode: "sleep", sleepMs: 5000 });
  let client = null;
  let runId = null;
  try {
    client = await McpClient.start({ backend, env, cwd: dirs.cwd });
    const sent = await sendRun(client, prefix, { message: "status running test", cwd: dirs.cwd });
    runId = sent.run_id;
    assert.ok(fs.existsSync(sent.run_dir), "run_dir should exist on disk: " + sent.run_dir);

    const statusPayload = await pollStatusUntil(client, prefix, runId, (payload) => payload.state === "running", {
      timeoutMs: 10000,
      intervalMs: 100,
      label: "state 'running'",
    });
    assert.equal(statusPayload.state, "running");
    assert.equal(statusPayload.run_id, runId);
    assert.ok(Array.isArray(statusPayload.tail), "tail must be an array, got " + JSON.stringify(statusPayload.tail));
    for (const line of statusPayload.tail) {
      assert.equal(typeof line, "string", "tail entries must be strings, got " + JSON.stringify(line));
    }
  } finally {
    await cancelQuietly(client, prefix, runId);
    await closeClient(client);
    killRecordedProcs(dirs.logDir);
    dirs.cleanup();
  }
});

// (12) the same CLI session cannot be driven concurrently from two different
// MCP server processes that share one CLI_BATON_HOME.
test("same-session concurrency across two server processes is rejected", { timeout: 45000 }, async () => {
  const dirs = makeDirs();
  const secondLogDir = dirs.addLogDir();
  const backend = "agy";
  const prefix = "agy";
  const sessionId = "sess-shared-concurrency-1";
  const envA = fakeEnv({ backend, home: dirs.home, logDir: dirs.logDir, mode: "sleep", sleepMs: 3000 });
  const envB = fakeEnv({ backend, home: dirs.home, logDir: secondLogDir, mode: "sleep", sleepMs: 3000 });
  let clientA = null;
  let clientB = null;
  let runId = null;
  try {
    clientA = await McpClient.start({ backend, env: envA, cwd: dirs.cwd });
    const sent = await sendRun(clientA, prefix, { message: "first session run", cwd: dirs.cwd, session_id: sessionId });
    runId = sent.run_id;

    await pollStatusUntil(clientA, prefix, runId, (payload) => payload.state === "running", {
      timeoutMs: 10000,
      intervalMs: 100,
      label: "first run to be running before the concurrent send",
    });

    clientB = await McpClient.start({ backend, env: envB, cwd: dirs.cwd });
    const secondMessage = await clientB.callTool(
      prefix + "_send",
      { message: "second concurrent run", cwd: dirs.cwd, session_id: sessionId },
      15000,
    );
    assertToolError(secondMessage, "second same-session send from another server process");
  } finally {
    await cancelQuietly(clientA, prefix, runId);
    await closeClient(clientA);
    await closeClient(clientB);
    killRecordedProcs(dirs.logDir);
    killRecordedProcs(secondLogDir);
    dirs.cleanup();
  }
});
