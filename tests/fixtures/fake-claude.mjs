#!/usr/bin/env node
/**
 * Fake Claude Code CLI for cli-baton tests.
 *
 * Supports:
 *   - `--help` (used by `claude_list_models`)
 *   - `-p --input-format stream-json --output-format stream-json --verbose [--include-partial-messages]`
 *     reading one NDJSON user message per line from stdin and emitting Claude
 *     stream-json events (system/init, stream_event, assistant, result).
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { readConfig, recordInvocation, sleep, writeLine, logDirOf } from "./fake-common.mjs";

const cfg = readConfig();
const argv = process.argv.slice(2);
recordInvocation(cfg, argv);

if (argv.includes("--help")) {
  if (cfg.mode === "models-fail") {
    process.stderr.write("claude: help failed\n");
    process.exit(1);
  }
  process.stdout.write(
    "Usage: claude [options] [command] [prompt]\n\n" +
      "Options:\n" +
      "  --model <model>   Model for the current session. Provide an alias for\n" +
      "                    the latest model (e.g. 'fable', 'opus', or 'sonnet')\n" +
      "                    or a model's full name.\n" +
      "  --effort <level>  Effort level (low, medium, high, xhigh, max)\n",
  );
  process.exit(0);
}

const resumeIdx = argv.indexOf("--resume");
const sessionId = resumeIdx >= 0 && argv[resumeIdx + 1] ? argv[resumeIdx + 1] : cfg.sessionId;
const permIdx = argv.indexOf("--permission-mode");
const permissionMode = permIdx >= 0 && argv[permIdx + 1] ? argv[permIdx + 1] : "bypassPermissions";

function emit(value) {
  writeLine(value);
}

function initEvent() {
  emit({
    type: "system",
    subtype: "init",
    cwd: process.cwd(),
    session_id: sessionId,
    model: "claude-sonnet-5-5",
    permissionMode,
    tools: ["Read", "Edit", "Bash"],
  });
}

async function emitTurn(text, { isError = false, subtype = "success" } = {}) {
  emit({ type: "stream_event", event: { type: "message_start", message: { role: "assistant", content: [] } }, session_id: sessionId });
  if (!isError) {
    const mid = Math.max(1, Math.floor(text.length / 2));
    const parts = text.length > 1 ? [text.slice(0, mid), text.slice(mid)] : [text];
    emit({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, session_id: sessionId });
    for (const part of parts) {
      emit({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: part } }, session_id: sessionId });
      await sleep(15);
    }
    emit({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] }, session_id: sessionId });
    emit({ type: "stream_event", event: { type: "content_block_stop", index: 0 }, session_id: sessionId });
  }
  emit({
    type: "result",
    subtype,
    is_error: isError,
    result: text,
    session_id: sessionId,
    duration_ms: 120,
    num_turns: 1,
    total_cost_usd: 0.0012,
    usage: {
      input_tokens: cfg.usage.input_tokens || 10,
      output_tokens: cfg.usage.output_tokens || 5,
      cache_read_input_tokens: 100,
    },
  });
}

async function main() {
  // Verify CLAUDECODE was stripped if test checks for it
  const dir = logDirOf(cfg);
  fs.writeFileSync(path.join(dir, "claudecode.txt"), process.env.CLAUDECODE === undefined ? "UNSET" : String(process.env.CLAUDECODE));
  const stdinLog = path.join(dir, "stdin.jsonl");
  fs.writeFileSync(stdinLog, "");

  if (cfg.mode === "fail") {
    process.stderr.write(cfg.stderr || "claude: simulated failure\n");
    process.exit(cfg.exitCode || 1);
  }

  initEvent();

  const rl = readline.createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity });
  const queue = [];
  let processing = false;
  let stdinEnded = false;
  let turnIndex = 0;

  const maybeExit = () => {
    if (stdinEnded && !processing && queue.length === 0) process.exit(0);
  };

  const pump = async () => {
    if (processing) return;
    processing = true;
    while (queue.length > 0) {
      const line = queue.shift();
      turnIndex += 1;
      let userText = "";
      try {
        const parsed = JSON.parse(line);
        const content = parsed && parsed.message ? parsed.message.content : "";
        userText = typeof content === "string" ? content : Array.isArray(content) ? content.map((b) => b.text || "").join("") : "";
      } catch {
        userText = line;
      }

      if (cfg.mode === "silent") {
        await sleep(cfg.silenceMs || 6000);
        await emitTurn(cfg.text || "AFTER_SILENCE");
        continue;
      }
      if (cfg.mode === "sleep") {
        await sleep(cfg.sleepMs || 2000);
        await emitTurn(cfg.text || "SLEEP_OK");
        continue;
      }
      if (cfg.mode === "error-result") {
        await emitTurn("simulated claude error", { isError: true, subtype: "error_during_execution" });
        continue;
      }
      if (cfg.mode === "echo") {
        if (cfg.turnDelayMs) await sleep(cfg.turnDelayMs);
        await emitTurn("turn " + turnIndex + ": " + userText);
        continue;
      }
      if (cfg.turnDelayMs) await sleep(cfg.turnDelayMs);
      const reply = cfg.text !== "FAKE_OK" || turnIndex === 1 ? cfg.text : "turn " + turnIndex + ": " + userText;
      await emitTurn(reply);
    }
    processing = false;
    maybeExit();
  };

  rl.on("line", (line) => {
    if (!line.trim()) return;
    fs.appendFileSync(stdinLog, line + "\n");
    queue.push(line);
    void pump();
  });

  rl.on("close", () => {
    stdinEnded = true;
    maybeExit();
  });
}

main().catch((error) => {
  process.stderr.write(String(error && error.stack ? error.stack : error) + "\n");
  process.exit(1);
});
