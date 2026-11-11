/**
 * Stall / progress tests (task B): the runner records throttled progress fields
 * in heartbeat.json, status/wait surface them with idle_s, and wait returns
 * stalled:true (without killing anything) when idle_s exceeds stall_s.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import * as runs from "../src/runs.mjs";
import { listTools } from "../src/tools.mjs";
import {
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

const J = (value) => JSON.stringify(value);

test("createThrottle allows at most one write per interval (fake clock)", () => {
  let clock = 1000;
  const throttle = runs.createThrottle({ intervalMs: 1000, now: () => clock });
  assert.equal(throttle.ready(), true, "the first write is always allowed");
  throttle.mark();
  assert.equal(throttle.ready(), false);
  clock += 999;
  assert.equal(throttle.ready(), false);
  clock += 1;
  assert.equal(throttle.ready(), true, "exactly one interval later it is ready again");
  throttle.mark();
  assert.equal(throttle.ready(), false);
  throttle.force();
  assert.equal(throttle.ready(), true, "force() re-arms the throttle for a final flush");
});

test("readProgress tolerates a heartbeat without progress fields", () => {
  const run = makeRunDir();
  try {
    fs.writeFileSync(path.join(run.runDir, "heartbeat.json"), J({ at: Date.now(), pid: process.pid }) + "\n");
    const progress = runs.readProgress(run.runDir);
    assert.deepEqual(progress, { last_output_at: null, stdout_bytes: 0, event_count: 0, last_event: null });
  } finally {
    run.remove();
  }
});

async function withClient(backend, options, fn) {
  const home = makeHome();
  const logDir = makeTmpDir("cli-baton-stall-log-");
  const env = fakeEnv({ backend, home: home.path, logDir: logDir.path, ...options });
  const client = await McpClient.start({ backend, env });
  try {
    return await fn({ client, logDir: logDir.path, home: home.path });
  } finally {
    await client.close().catch(() => {});
    home.remove();
    logDir.remove();
  }
}

function send(client, prefix, args) {
  return client.callTool(prefix + "_send", args).then((message) => {
    assert.equal(isToolError(message), false, JSON.stringify(toolPayload(message)));
    return toolPayload(message);
  });
}

function status(client, prefix, runId) {
  return client.callTool(prefix + "_status", { run_id: runId }).then((message) => {
    assert.equal(isToolError(message), false, JSON.stringify(toolPayload(message)));
    return toolPayload(message);
  });
}

test("status exposes last_output_at, stdout_bytes, event_count, last_event and idle_s", { timeout: 30000 }, async () => {
  await withClient("agy", { mode: "silent", silenceMs: 15000, text: "SILENT_OK" }, async ({ client }) => {
    const sent = await send(client, "agy", { message: "progress fields", cwd: makeCwd().path, timeout_s: 60, stall_s: 30 });
    const runDir = sent.run_dir;

    const payload = await waitFor(async () => {
      const current = await status(client, "agy", sent.run_id);
      return current.stdout_bytes > 0 && current.event_count >= 2 ? current : null;
    }, { timeoutMs: 8000, intervalMs: 100, label: "progress fields in status" });

    assert.equal(payload.state, "running");
    assert.equal(typeof payload.stdout_bytes, "number");
    assert.ok(payload.stdout_bytes > 0, "stdout_bytes should grow with stdout.jsonl");
    assert.ok(payload.event_count >= 2, "the init/step events should be counted");
    assert.equal(payload.last_event, "step_update");
    assert.equal(typeof payload.last_output_at, "string");
    assert.ok(Number.isFinite(Date.parse(payload.last_output_at)), "last_output_at should be an ISO timestamp");
    assert.equal(typeof payload.idle_s, "number");
    assert.ok(payload.idle_s >= 0);
    assert.equal(payload.stall_s, 30, "the stall threshold from send is stored on the run");

    const onDisk = readRunDir(runDir).meta;
    assert.equal(onDisk.stall_s, 30);
    await client.callTool("agy_cancel", { run_id: sent.run_id }, 20000);
  });
});

test("stdout_bytes matches stdout.jsonl and grows with output", { timeout: 30000 }, async () => {
  await withClient("agy", { mode: "chatty", chunks: 40, chunkMs: 20, text: "CHATTY_OK" }, async ({ client }) => {
    const sent = await send(client, "agy", { message: "bytes", cwd: makeCwd().path, timeout_s: 60 });
    const first = await waitFor(async () => {
      const current = await status(client, "agy", sent.run_id);
      return current.stdout_bytes > 0 ? current : null;
    }, { timeoutMs: 8000, intervalMs: 50, label: "first stdout bytes" });
    const second = await waitFor(async () => {
      const current = await status(client, "agy", sent.run_id);
      return current.stdout_bytes > first.stdout_bytes ? current : null;
    }, { timeoutMs: 8000, intervalMs: 50, label: "growing stdout bytes" });
    assert.ok(second.stdout_bytes > first.stdout_bytes);
    assert.ok(second.event_count > 0 && second.last_event);

    const final = await waitForTerminal(client, "agy", sent.run_id, { timeoutMs: 20000 });
    assert.equal(final.state, "completed");
    const bytes = Buffer.byteLength(fs.readFileSync(path.join(sent.run_dir, "stdout.jsonl"), "utf8"), "utf8");
    assert.equal(final.stdout_bytes, bytes, "the final flush must report the real stdout size");
    assert.equal(final.last_event, "result");
  });
});

test("heartbeat progress is written at most once per second", { timeout: 30000 }, async () => {
  await withClient("agy", { mode: "chatty", chunks: 80, chunkMs: 20, text: "THROTTLE_OK" }, async ({ client }) => {
    const sent = await send(client, "agy", { message: "throttle", cwd: makeCwd().path, timeout_s: 60 });
    const heartbeatPath = path.join(sent.run_dir, "heartbeat.json");
    await waitFor(() => fs.existsSync(heartbeatPath), { timeoutMs: 5000, label: "heartbeat.json" });

    const samples = [];
    for (let index = 0; index < 16; index += 1) {
      const heartbeat = JSON.parse(fs.readFileSync(heartbeatPath, "utf8"));
      samples.push({
        last_output_at: heartbeat.last_output_at,
        stdout_bytes: heartbeat.stdout_bytes,
      });
      await sleep(100);
    }
    const distinct = new Set(samples.map((sample) => sample.last_output_at));
    assert.ok(
      distinct.size <= 4,
      "expected <= 1 progress write per second over ~1.6s, saw " + distinct.size + " distinct last_output_at values",
    );
    assert.ok(
      samples[samples.length - 1].stdout_bytes > samples[0].stdout_bytes,
      "output kept flowing during the throttle window",
    );
    await waitForTerminal(client, "agy", sent.run_id, { timeoutMs: 20000 });
  });
});

test("wait returns stalled:true immediately when idle_s exceeds stall_s without killing the run", { timeout: 40000 }, async () => {
  await withClient("agy", { mode: "silent", silenceMs: 15000, text: "SILENT_OK" }, async ({ client }) => {
    const sent = await send(client, "agy", { message: "stall me", cwd: makeCwd().path, timeout_s: 60, stall_s: 1 });
    const started = Date.now();
    const waited = toolPayload(await client.callTool("agy_wait", { run_id: sent.run_id, timeout_s: 30 }));
    const elapsed = Date.now() - started;

    assert.equal(waited.stalled, true, JSON.stringify(waited));
    assert.equal(waited.state, "running");
    assert.equal(waited.stall_s, 1);
    assert.ok(waited.idle_s > 1, "idle_s should exceed the threshold: " + waited.idle_s);
    assert.ok(elapsed < 8000, "wait should return on the stall instead of blocking the full timeout (took " + elapsed + "ms)");

    // Stall detection is advisory only: the process must still be alive.
    const after = await status(client, "agy", sent.run_id);
    assert.equal(after.state, "running");
    const argv = JSON.parse(fs.readFileSync(path.join(after.run_dir, "supervisor.json"), "utf8"));
    assert.ok(runs.isPidAlive(argv.pid), "the runner must still be alive after a stall report");

    const cancelled = toolPayload(await client.callTool("agy_cancel", { run_id: sent.run_id }, 20000));
    assert.equal(cancelled.state, "cancelled");
  });
});

test("wait keeps waiting while output keeps flowing (no false stall)", { timeout: 40000 }, async () => {
  await withClient("agy", { mode: "chatty", chunks: 30, chunkMs: 100, text: "FLOWING_OK" }, async ({ client }) => {
    const sent = await send(client, "agy", { message: "flowing", cwd: makeCwd().path, timeout_s: 60, stall_s: 1 });
    const message = await client.callTool("agy_wait", { run_id: sent.run_id, timeout_s: 30 });
    const payload = toolPayload(message);
    assert.equal(payload.stalled, undefined, "a run that keeps emitting must not report stalled: " + JSON.stringify(payload));
    assert.equal(payload.state, "completed");
    assert.equal(payload.reply, "FLOWING_OK");
  });
});

test("wait accepts an explicit stall_s overriding the stored one", { timeout: 40000 }, async () => {
  await withClient("agy", { mode: "silent", silenceMs: 15000, text: "SILENT_OK" }, async ({ client }) => {
    const sent = await send(client, "agy", { message: "override", cwd: makeCwd().path, timeout_s: 60 });
    const started = Date.now();
    const waited = toolPayload(await client.callTool("agy_wait", { run_id: sent.run_id, timeout_s: 30, stall_s: 1 }));
    assert.equal(waited.stalled, true);
    assert.equal(waited.stall_s, 1, "the explicit wait value wins");
    assert.ok(Date.now() - started < 8000);
    await client.callTool("agy_cancel", { run_id: sent.run_id }, 20000);
  });
});

test("a run without stall_s never reports stalled (existing wait behaviour)", { timeout: 30000 }, async () => {
  await withClient("agy", { mode: "silent", silenceMs: 3000, text: "LATE_OK" }, async ({ client }) => {
    const sent = await send(client, "agy", { message: "no threshold", cwd: makeCwd().path, timeout_s: 60 });
    const waited = toolPayload(await client.callTool("agy_wait", { run_id: sent.run_id, timeout_s: 2 }));
    assert.equal(waited.stalled, undefined);
    assert.equal(waited.timed_out, true, JSON.stringify(waited));
    assert.ok(["queued", "running"].includes(waited.state));
    const final = await waitForTerminal(client, "agy", sent.run_id, { timeoutMs: 20000 });
    assert.equal(final.state, "completed");
  });
});

test("codex exposes the same progress fields and stall behaviour", { timeout: 40000 }, async () => {
  const home = makeHome();
  const logDir = makeTmpDir("cli-baton-stall-codex-");
  const env = fakeEnv({ backend: "codex", home: home.path, logDir: logDir.path, mode: "sleep", sleepMs: 15000 });
  const client = await McpClient.start({ backend: "codex", env });
  try {
    const sent = await send(client, "codex", { message: "codex stall", cwd: makeCwd().path, timeout_s: 60, stall_s: 1 });
    const waiting = client.callTool("codex_wait", { run_id: sent.run_id, timeout_s: 30 });
    const payload = toolPayload(await waiting);
    assert.equal(payload.stalled, true, JSON.stringify(payload));
    assert.equal(payload.state, "running");
    assert.ok(payload.idle_s > 1);
    assert.ok(payload.stdout_bytes > 0);
    // fake-codex emits thread.started and turn.started back to back; the throttled
    // publish may legitimately report either of them as the last event.
    assert.ok(["thread.started", "turn.started"].includes(payload.last_event), "unexpected last_event " + payload.last_event);
    const cancelled = toolPayload(await client.callTool("codex_cancel", { run_id: sent.run_id }, 20000));
    assert.equal(cancelled.state, "cancelled");
  } finally {
    await client.close().catch(() => {});
    home.remove();
    logDir.remove();
  }
});

test("stall_s is validated and advertised in the tool schema", async () => {
  const tools = listTools("agy");
  const sendTool = tools.find((tool) => tool.name === "agy_send");
  const waitTool = tools.find((tool) => tool.name === "agy_wait");
  assert.ok(sendTool.inputSchema.properties.stall_s, "agy_send should advertise stall_s");
  assert.equal(sendTool.inputSchema.properties.stall_s.minimum, 1);
  assert.ok(waitTool.inputSchema.properties.stall_s, "agy_wait should advertise stall_s");
  assert.match(waitTool.description, /stalled:true/);
  assert.match(sendTool.inputSchema.properties.stall_s.description, /never killed/);

  const home = makeHome();
  const logDir = makeTmpDir("cli-baton-stall-validation-");
  const env = fakeEnv({ backend: "agy", home: home.path, logDir: logDir.path });
  const client = await McpClient.start({ backend: "agy", env });
  try {
    const cwd = makeCwd().path;
    for (const bad of [0, -1, 1.5, "5", 86401]) {
      const message = await client.callTool("agy_send", { message: "x", cwd, stall_s: bad });
      assert.equal(isToolError(message), true, "stall_s=" + JSON.stringify(bad) + " should be rejected");
      assert.match(String(toolPayload(message).error), /stall_s/);
    }
    const waiting = await client.callTool("agy_wait", { run_id: "a".repeat(24), stall_s: 0 });
    assert.equal(isToolError(waiting), true);
  } finally {
    await client.close().catch(() => {});
    home.remove();
    logDir.remove();
  }
});
