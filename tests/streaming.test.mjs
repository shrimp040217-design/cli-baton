/**
 * Streaming tests: agy now runs with --output-format stream-json, the runner
 * writes every event to stdout.jsonl while the CLI is still working, and
 * parseOutput understands both the NDJSON stream and the legacy single object.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import * as agy from "../src/backends/agy.mjs";
import * as codex from "../src/backends/codex.mjs";
import {
  McpClient,
  fakeEnv,
  isToolError,
  makeCwd,
  makeHome,
  makeTmpDir,
  sleep,
  toolPayload,
  waitFor,
  waitForTerminal,
} from "./helpers.mjs";

const NL = String.fromCharCode(10);
const J = (value) => JSON.stringify(value);
const ndjson = (events) => events.map((event) => J(event)).join(NL) + NL;

const SAMPLE_STREAM = [
  {
    event: "init",
    conversation_id: "conv-stream-1",
    init: { model: "gemini-3-pro", cwd: "/tmp", tools: ["read_file", "run_command"], permission_mode: "request-review" },
  },
  { event: "step_update", step_update: { conversation_id: "conv-stream-1", step_index: 0, state: "DONE", step_type: "user_input" } },
  {
    event: "step_update",
    step_update: { conversation_id: "conv-stream-1", step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "Rivers carve " },
  },
  {
    event: "step_update",
    step_update: {
      conversation_id: "conv-stream-1",
      step_index: 1,
      state: "DONE",
      step_type: "agent_response",
      text_delta: "canyons." + NL,
      duration_seconds: 5.46,
      usage: { input_tokens: 11, output_tokens: 7 },
    },
  },
  {
    event: "result",
    result: {
      conversation_id: "conv-stream-1",
      status: "SUCCESS",
      response: "Rivers carve canyons." + NL,
      duration_seconds: 5.6,
      num_turns: 1,
      usage: { input_tokens: 11, output_tokens: 7 },
    },
  },
];

test("agy parseOutput: stream-json result event maps exactly like the legacy JSON object", () => {
  const parsed = agy.parseOutput({ stdout: ndjson(SAMPLE_STREAM), stderr: "", exitCode: 0 });
  assert.equal(parsed.state, "completed");
  assert.equal(parsed.reply, "Rivers carve canyons." + NL);
  assert.equal(parsed.sessionId, "conv-stream-1");
  assert.equal(parsed.status, "SUCCESS");
  assert.equal(parsed.usage.input_tokens, 11);
  assert.equal(parsed.usage.output_tokens, 7);
  assert.equal(parsed.stream, true);
  assert.equal(parsed.error, null);
});

test("agy parseOutput: stream events are collected even when unrelated lines are mixed in", () => {
  const stdout = ["warning: proxy detected", ndjson(SAMPLE_STREAM).trimEnd(), "trailing junk"].join(NL) + NL;
  const parsed = agy.parseOutput({ stdout, stderr: "", exitCode: 0 });
  assert.equal(parsed.state, "completed");
  assert.equal(parsed.reply.trim(), "Rivers carve canyons.");
});

test("agy parseOutput: missing result event falls back to concatenated text_delta with an explicit error", () => {
  const stream = SAMPLE_STREAM.slice(0, 4); // init + steps, no result event
  const parsed = agy.parseOutput({ stdout: ndjson(stream), stderr: "", exitCode: 0 });
  assert.equal(parsed.state, "failed");
  assert.equal(parsed.reply, "Rivers carve canyons." + NL);
  assert.equal(parsed.delta_count, 2);
  assert.match(parsed.error, /without a result event/i);
  assert.match(parsed.error, /text_delta/);
});

test("agy parseOutput: stream with a FAILED result status fails with the backend error", () => {
  const stream = [
    SAMPLE_STREAM[0],
    { event: "result", result: { conversation_id: "c2", status: "FAILED", response: "", error: "model exploded", usage: {} } },
  ];
  const parsed = agy.parseOutput({ stdout: ndjson(stream), stderr: "", exitCode: 0 });
  assert.equal(parsed.state, "failed");
  assert.equal(parsed.status, "FAILED");
  assert.match(parsed.error, /model exploded/);
});

test("agy parseOutput: legacy single JSON object still parses (backwards compatible fixtures)", () => {
  const legacy = J({ conversation_id: "legacy-1", status: "SUCCESS", response: "old format", usage: { input_tokens: 1 } });
  const parsed = agy.parseOutput({ stdout: legacy, stderr: "", exitCode: 0 });
  assert.equal(parsed.state, "completed");
  assert.equal(parsed.reply, "old format");
  assert.equal(parsed.sessionId, "legacy-1");
  assert.equal(parsed.stream, false);
});

test("agy parseStreamEvents: extracts the last result event and every delta", () => {
  const stream = [
    { event: "init", conversation_id: "c3" },
    { event: "step_update", step_update: { text_delta: "a" } },
    { event: "step_update", step_update: { text_delta: "b" } },
    { event: "result", result: { status: "SUCCESS", response: "first" } },
    { event: "result", result: { status: "SUCCESS", response: "second" } },
  ];
  const parsed = agy.parseStreamEvents(ndjson(stream));
  assert.equal(parsed.sawStream, true);
  assert.equal(parsed.eventCount, 5);
  assert.equal(parsed.deltas, "ab");
  assert.equal(parsed.deltaCount, 2);
  assert.equal(parsed.resultObject.response, "second");
});

async function withClient(options, fn) {
  const home = makeHome();
  const logDir = makeTmpDir("cli-baton-stream-log-");
  const env = fakeEnv({ backend: "agy", home: home.path, logDir: logDir.path, ...options });
  const client = await McpClient.start({ backend: "agy", env });
  try {
    return await fn({ client, logDir: logDir.path, home: home.path });
  } finally {
    await client.close().catch(() => {});
    home.remove();
    logDir.remove();
  }
}

function readIfPresent(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

test("agy: stdout.jsonl is non-empty while the run is still running", { timeout: 30000 }, async () => {
  await withClient({ mode: "sleep", sleepMs: 2500, text: "LIVE_OK" }, async ({ client }) => {
    const sent = toolPayload(await client.callTool("agy_send", { message: "live progress", cwd: makeCwd().path, timeout_s: 30 }));
    const stdoutPath = path.join(sent.run_dir, "stdout.jsonl");

    // Wait for both lines: init and user_input are two separate writes, so a
    // snapshot taken right after "init" can legitimately miss the second one.
    const text = await waitFor(() => {
      const current = readIfPresent(stdoutPath);
      return current.includes('"event":"init"') && current.includes('"step_type":"user_input"') ? current : null;
    }, { timeoutMs: 6000, label: "stream events to reach stdout.jsonl" });

    const status = toolPayload(await client.callTool("agy_status", { run_id: sent.run_id }));
    assert.equal(status.state, "running", "stdout must have content before the run finishes: " + JSON.stringify(status));
    assert.match(text, /"event":"init"/);
    assert.match(text, /"step_type":"user_input"/);

    const final = await waitForTerminal(client, "agy", sent.run_id, { timeoutMs: 20000 });
    assert.equal(final.state, "completed", JSON.stringify(final));
    assert.equal(final.reply, "LIVE_OK");
    const complete = readIfPresent(stdoutPath);
    assert.match(complete, /"event":"result"/);
    assert.ok(complete.length > text.length, "stdout.jsonl should keep growing until the result event");
  });
});

test("agy: the child actually receives --output-format stream-json", { timeout: 20000 }, async () => {
  await withClient({}, async ({ client, logDir }) => {
    const sent = toolPayload(await client.callTool("agy_send", { message: "argv check", cwd: makeCwd().path }));
    const done = await waitForTerminal(client, "agy", sent.run_id, { timeoutMs: 15000 });
    assert.equal(done.state, "completed");
    const argv = JSON.parse(fs.readFileSync(path.join(logDir, "argv.json"), "utf8")).argv;
    assert.equal(argv[argv.indexOf("--output-format") + 1], "stream-json");
  });
});

test("agy: a stream that ends without a result event fails but keeps the streamed reply", { timeout: 20000 }, async () => {
  await withClient({ mode: "stream-no-result", text: "PARTIAL_BUT_VISIBLE" }, async ({ client }) => {
    const sent = toolPayload(await client.callTool("agy_send", { message: "no result", cwd: makeCwd().path }));
    const final = await waitForTerminal(client, "agy", sent.run_id, { timeoutMs: 15000 });
    assert.equal(final.state, "failed");
    assert.equal(final.reply, "PARTIAL_BUT_VISIBLE");
    assert.match(String(final.error), /result event/i);
  });
});

test("codex: stdout.jsonl is streamed line by line during the run", { timeout: 30000 }, async () => {
  const home = makeHome();
  const logDir = makeTmpDir("cli-baton-stream-codex-");
  const env = fakeEnv({ backend: "codex", home: home.path, logDir: logDir.path, mode: "sleep", sleepMs: 2500 });
  const client = await McpClient.start({ backend: "codex", env });
  try {
    const sent = toolPayload(await client.callTool("codex_send", { message: "codex live", cwd: makeCwd().path, timeout_s: 30 }));
    const stdoutPath = path.join(sent.run_dir, "stdout.jsonl");
    const text = await waitFor(() => {
      const current = readIfPresent(stdoutPath);
      return current.includes("thread.started") ? current : null;
    }, { timeoutMs: 6000, label: "codex thread.started to reach stdout.jsonl" });
    const status = toolPayload(await client.callTool("codex_status", { run_id: sent.run_id }));
    assert.equal(status.state, "running", "codex events must land before completion: " + JSON.stringify(status));
    assert.match(text, /"type":"thread\.started"/);
    await sleep(50);
    await waitForTerminal(client, "codex", sent.run_id, { timeoutMs: 20000 });
  } finally {
    await client.close().catch(() => {});
    home.remove();
    logDir.remove();
  }
});

test("codex parseOutput keeps working on the same JSONL fixture after the agy change", () => {
  const parsed = codex.parseOutput({
    stdout: ndjson([
      { type: "thread.started", thread_id: "t-stream" },
      { type: "turn.started" },
      { type: "item.completed", item: { type: "agent_message", text: "ok" } },
      { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2 } },
    ]),
    stderr: "",
    exitCode: 0,
  });
  assert.equal(parsed.state, "completed");
  assert.equal(parsed.reply, "ok");
  assert.equal(parsed.sessionId, "t-stream");
});
