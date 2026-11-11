#!/usr/bin/env node
/**
 * Fake agy CLI.
 *
 * Two run modes:
 *  - conversation mode (real default now): `--input-format stream-json` → read
 *    one NDJSON user message per line from stdin, answer each with one turn
 *    (step_update* + result), stay alive until stdin closes.
 *  - legacy one-shot mode (`-p <prompt> --output-format json|stream-json`),
 *    kept so the backwards-compatible parser stays covered.
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { readConfig, recordInvocation, captureStdinIfRequested, spawnGrandchild, sleep, writeLine, logDirOf } from "./fake-common.mjs";

const cfg = readConfig();
const argv = process.argv.slice(2);
recordInvocation(cfg, argv);

// "agy models" subcommand (used by agy_list_models)
if (argv[0] === "models") {
  writeLine({
    models: [
      { id: "gemini-3-pro", name: "Gemini 3 Pro" },
      { id: "gemini-3-flash", name: "Gemini 3 Flash" },
    ],
  });
  process.exit(0);
}

const convIdx = argv.indexOf("--conversation");
const sessionId = convIdx >= 0 && argv[convIdx + 1] ? argv[convIdx + 1] : cfg.sessionId;

const formatIdx = argv.indexOf("--output-format");
const outputFormat = formatIdx >= 0 && argv[formatIdx + 1] ? argv[formatIdx + 1] : "json";
const streaming = outputFormat === "stream-json";
const inputIdx = argv.indexOf("--input-format");
const chatMode = inputIdx >= 0 && argv[inputIdx + 1] === "stream-json";

const STREAM_GAP_MS = 30;
const emit = (value) => writeLine(value);
const usage = () => cfg.usage;

function streamEvent(event, payload) {
  if (event === "step_update") emit({ event: "step_update", step_update: payload });
  else if (event === "result") emit({ event: "result", result: payload });
  else emit({ event, ...payload });
}

function initEvent() {
  streamEvent("init", {
    conversation_id: sessionId,
    init: {
      model: "fake-gemini",
      cwd: process.cwd(),
      tools: ["read_file", "write_file", "run_command"],
      permission_mode: "request-review",
    },
  });
}

function userInputStep(stepIndex) {
  streamEvent("step_update", {
    conversation_id: sessionId,
    step_index: stepIndex,
    state: "DONE",
    step_type: "user_input",
  });
}

/** Split the reply into a few text_delta steps, like real agy streaming. */
async function responseSteps(text, { chunkCount = 3, finalState = true, stepIndex = 1 } = {}) {
  const size = Math.max(1, Math.ceil(text.length / chunkCount));
  for (let index = 0; index < chunkCount; index += 1) {
    const chunk = text.slice(index * size, (index + 1) * size);
    streamEvent("step_update", {
      conversation_id: sessionId,
      step_index: stepIndex,
      state: index + 1 === chunkCount && finalState ? "DONE" : "ACTIVE",
      step_type: "agent_response",
      text_delta: chunk,
      ...(index + 1 === chunkCount && finalState ? { duration_seconds: 0.06, usage: usage() } : {}),
    });
    if (index + 1 < chunkCount) await sleep(STREAM_GAP_MS);
  }
}

function resultEvent({ status = "SUCCESS", response = "", error = null, duration = 0.08 } = {}) {
  const payload = {
    conversation_id: sessionId,
    status,
    response,
    duration_seconds: duration,
    num_turns: 1,
    usage: usage(),
  };
  if (error !== null) payload.error = error;
  streamEvent("result", payload);
}

function failExit() {
  process.stderr.write(cfg.stderr || "agy: fatal: simulated failure\n");
  process.exit(cfg.exitCode);
}

function secretExit() {
  process.stderr.write("Authorization: Bearer sk-live-abc123DEF456ghi789\n");
  process.stderr.write("api_key=SUPERSECRETVALUE token: abcdef123456 secret=topsecret\n");
  process.exit(cfg.exitCode);
}

/* ------------------------------------------------------------------ *
 * conversation mode: one turn per stdin line
 * ------------------------------------------------------------------ */

async function runChat() {
  const dir = logDirOf(cfg);
  const stdinLog = path.join(dir, "stdin.jsonl");
  fs.writeFileSync(stdinLog, "");
  initEvent();
  if (cfg.mode === "grandchild") spawnGrandchild(cfg);

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let turn = 0;
  for await (const line of rl) {
    const trimmed = String(line || "").trim();
    if (!trimmed) continue;
    fs.appendFileSync(stdinLog, trimmed + "\n");
    let message = null;
    try {
      message = JSON.parse(trimmed);
    } catch {
      message = null;
    }
    const content = message && message.message && Array.isArray(message.message.content) ? message.message.content[0] : null;
    const userText = content && typeof content.text === "string" ? content.text : "";
    turn += 1;
    if (cfg.turnDelayMs > 0) await sleep(cfg.turnDelayMs);
    userInputStep(turn * 2);

    if (cfg.mode === "fail") failExit();
    if (cfg.mode === "secret") secretExit();
    if (cfg.mode === "failed-status") {
      resultEvent({ status: "FAILED", response: "", error: "model exploded" });
      continue;
    }
    if (cfg.mode === "empty") {
      resultEvent({ status: "SUCCESS", response: "" });
      continue;
    }
    if (cfg.mode === "stream-no-result") {
      await responseSteps(cfg.text, { chunkCount: 2, stepIndex: turn * 2 });
      process.exit(0);
    }
    if (cfg.mode === "junk") {
      process.stderr.write("warning: config line\n");
      writeLine("not json at all");
    }
    if (cfg.mode === "silent") {
      // One delta, then a long pause: the turn eventually finishes, so stall
      // detection (idle_s) is exercised without breaking completion.
      await responseSteps("working", { chunkCount: 1, finalState: false, stepIndex: turn * 2 });
      await sleep(cfg.silenceMs);
      resultEvent({ status: "SUCCESS", response: cfg.text, duration: cfg.silenceMs / 1000 });
      continue;
    }
    if (cfg.mode === "chatty") {
      for (let index = 0; index < cfg.chunks; index += 1) {
        streamEvent("step_update", {
          conversation_id: sessionId,
          step_index: turn * 2,
          state: "ACTIVE",
          step_type: "agent_response",
          text_delta: "chunk" + index + " ",
        });
        await sleep(cfg.chunkMs);
      }
      resultEvent({ status: "SUCCESS", response: cfg.text });
      continue;
    }
    if (cfg.mode === "die-half-line") {
      // Leave an unterminated line behind and die: the runner must still flush a
      // queued user_injected record on its own line.
      const line = JSON.stringify({ event: "step_update", step_update: { conversation_id: sessionId, step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "CUT" } });
      process.stdout.write(line.slice(0, Math.floor(line.length / 2)));
      await sleep(cfg.halfLineMs);
      process.exit(cfg.exitCode || 1);
    }
    if (cfg.mode === "half-line") {
      // Emit one stdout line in two chunks with a pause in between: an injected
      // message arriving during that pause must not be spliced into the line.
      const line = JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: sessionId,
          step_index: turn * 2,
          state: "ACTIVE",
          step_type: "agent_response",
          text_delta: "HALF-",
        },
      });
      const cut = Math.max(1, Math.floor(line.length / 2));
      process.stdout.write(line.slice(0, cut));
      await sleep(cfg.halfLineMs);
      process.stdout.write(line.slice(cut) + "\n");
      await responseSteps(cfg.text, { chunkCount: 1, stepIndex: turn * 2 });
      resultEvent({ status: "SUCCESS", response: cfg.text });
      continue;
    }
    if (cfg.mode === "stream-tool-step") {
      streamEvent("step_update", {
        conversation_id: sessionId,
        step_index: turn * 2 + 1,
        state: "DONE",
        step_type: "tool_call",
        tool_name: "read_file",
        duration_seconds: 0.02,
      });
    }
    if (cfg.mode === "sleep" || cfg.mode === "grandchild") await sleep(cfg.sleepMs);
    const text =
      cfg.mode === "echo"
        ? "echo: " + userText
        : cfg.mode === "long"
          ? "A".repeat(cfg.replyChars)
          : cfg.text;
    await responseSteps(text, { chunkCount: cfg.mode === "long" ? 4 : 3, stepIndex: turn * 2 });
    resultEvent({ status: "SUCCESS", response: text });
  }
  process.exit(0);
}

if (chatMode) {
  await runChat();
  process.exit(0);
}

/* ------------------------------------------------------------------ *
 * legacy one-shot mode (kept for the backwards-compatibility tests)
 * ------------------------------------------------------------------ */

await captureStdinIfRequested(cfg, argv);

if (cfg.mode === "grandchild") spawnGrandchild(cfg);

if (streaming) {
  // The init event lands immediately: this is what makes stdout.jsonl non-empty
  // while the run is still running (live-progress regression test).
  await initEvent();
  userInputStep(0);
  if (cfg.mode === "sleep" || cfg.mode === "grandchild") await sleep(cfg.sleepMs);
  if (cfg.mode === "fail") failExit();
  if (cfg.mode === "secret") secretExit();
  if (cfg.mode === "failed-status") {
    await responseSteps("", { chunkCount: 1 });
    resultEvent({ status: "FAILED", response: "", error: "model exploded" });
    process.exit(0);
  }
  if (cfg.mode === "empty") {
    resultEvent({ status: "SUCCESS", response: "" });
    process.exit(0);
  }
  if (cfg.mode === "junk") {
    process.stderr.write("warning: config line\n");
    writeLine("not json at all");
    await responseSteps(cfg.text, { chunkCount: 2 });
    resultEvent({ status: "SUCCESS", response: cfg.text });
    process.exit(0);
  }
  if (cfg.mode === "stream-no-result") {
    await responseSteps(cfg.text, { chunkCount: 2 });
    process.exit(0);
  }
  if (cfg.mode === "silent") {
    await responseSteps("working", { chunkCount: 1, finalState: false });
    await sleep(cfg.silenceMs);
    resultEvent({ status: "SUCCESS", response: cfg.text });
    process.exit(0);
  }
  if (cfg.mode === "chatty") {
    for (let index = 0; index < cfg.chunks; index += 1) {
      streamEvent("step_update", {
        conversation_id: sessionId,
        step_index: 1,
        state: "ACTIVE",
        step_type: "agent_response",
        text_delta: "chunk" + index + " ",
      });
      await sleep(cfg.chunkMs);
    }
    resultEvent({ status: "SUCCESS", response: cfg.text });
    process.exit(0);
  }
  if (cfg.mode === "stream-tool-step") {
    streamEvent("step_update", {
      conversation_id: sessionId,
      step_index: 2,
      state: "DONE",
      step_type: "tool_call",
      tool_name: "read_file",
      duration_seconds: 0.02,
    });
  }
  const text = cfg.mode === "long" ? "A".repeat(cfg.replyChars) : cfg.text;
  await responseSteps(text, { chunkCount: cfg.mode === "long" ? 4 : 3 });
  resultEvent({ status: "SUCCESS", response: text });
  process.exit(0);
}

if (cfg.mode === "silent") {
  writeLine({ conversation_id: sessionId, status: "SUCCESS", response: cfg.text, duration_seconds: 60, num_turns: 1, usage: cfg.usage });
  process.exit(0);
}
if (cfg.mode === "chatty") {
  writeLine({ conversation_id: sessionId, status: "SUCCESS", response: cfg.text, duration_seconds: 1, num_turns: 1, usage: cfg.usage });
  process.exit(0);
}
if (cfg.mode === "sleep" || cfg.mode === "grandchild") await sleep(cfg.sleepMs);

if (cfg.mode === "fail") failExit();
if (cfg.mode === "secret") secretExit();
if (cfg.mode === "failed-status") {
  writeLine({ conversation_id: sessionId, status: "FAILED", response: "", error: "model exploded" });
  process.exit(0);
}
if (cfg.mode === "empty") {
  writeLine({ conversation_id: sessionId, status: "SUCCESS", response: "", duration_seconds: 0.01, num_turns: 0, usage: cfg.usage });
  process.exit(0);
}
if (cfg.mode === "junk") {
  process.stderr.write("warning: config line\n");
  writeLine("not json at all");
  writeLine({ conversation_id: sessionId, status: "SUCCESS", response: cfg.text, duration_seconds: 0.01, num_turns: 1, usage: cfg.usage });
  process.exit(0);
}
if (cfg.mode === "pretty") {
  process.stdout.write(JSON.stringify({ conversation_id: sessionId, status: "SUCCESS", response: cfg.text, duration_seconds: 0.01, num_turns: 1, usage: cfg.usage }, null, 2) + "\n");
  process.exit(0);
}
if (cfg.mode === "truncated-json") {
  writeLine('{"conversation_id":"' + sessionId + '","status":"SUCCESS","response":"cut off here');
  process.exit(0);
}

const text = cfg.mode === "long" ? "A".repeat(cfg.replyChars) : cfg.text;
writeLine({
  conversation_id: sessionId,
  status: "SUCCESS",
  response: text,
  duration_seconds: 0.02,
  num_turns: 1,
  usage: cfg.usage,
});
