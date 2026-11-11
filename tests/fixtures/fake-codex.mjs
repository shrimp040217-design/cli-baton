#!/usr/bin/env node
import { readConfig, recordInvocation, captureStdinIfRequested, spawnGrandchild, sleep, writeLine } from "./fake-common.mjs";

const cfg = readConfig();
const argv = process.argv.slice(2);
recordInvocation(cfg, argv);

// "codex debug models" (used by codex_list_models)
if (argv[0] === "debug" && argv[1] === "models") {
  writeLine({
    models: [
      { slug: "gpt-5.2-codex", display_name: "GPT-5.2-Codex" },
      { slug: "gpt-5.2", display_name: "GPT-5.2" },
    ],
  });
  process.exit(0);
}

const isResume = argv[0] === "exec" && argv[1] === "resume";
let sessionId = cfg.sessionId;
if (isResume) {
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-") break;
    if (!arg.startsWith("-")) {
      sessionId = arg;
      break;
    }
  }
}

await captureStdinIfRequested(cfg, argv);

const emit = (obj) => writeLine(obj);
const usage = () => ({ input_tokens: 123, cached_input_tokens: 0, output_tokens: 7, reasoning_output_tokens: 0 });

emit({ type: "thread.started", thread_id: sessionId });
emit({ type: "turn.started" });

if (cfg.mode === "grandchild") spawnGrandchild(cfg);
if (cfg.mode === "sleep" || cfg.mode === "grandchild") await sleep(cfg.sleepMs);

if (cfg.mode === "fail") {
  process.stderr.write(cfg.stderr || "codex: fatal: simulated failure\n");
  process.exit(cfg.exitCode);
}
if (cfg.mode === "secret") {
  process.stderr.write("Authorization: Bearer sk-live-abc123DEF456ghi789\n");
  process.stderr.write("api_key=SUPERSECRETVALUE token: abcdef123456 secret=topsecret\n");
  process.exit(cfg.exitCode);
}
if (cfg.mode === "failed-status") {
  emit({ type: "turn.failed", error: { message: "model exploded" } });
  process.exit(0);
}
if (cfg.mode === "empty") {
  emit({ type: "turn.completed", usage: usage() });
  process.exit(0);
}
if (cfg.mode === "junk") {
  writeLine("this is not json");
  writeLine({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: cfg.text } });
  writeLine("another junk line");
  emit({ type: "turn.completed", usage: usage() });
  process.exit(0);
}
if (cfg.mode === "transient-errors") {
  emit({ type: "error", message: "Reconnecting... 1/5 (request timed out)" });
  emit({ type: "item.completed", item: { id: "item_0", type: "error", message: "transient warning" } });
}

const text = cfg.mode === "long" ? "A".repeat(cfg.replyChars) : cfg.text;
emit({ type: "item.completed", item: { id: "item_2", type: "agent_message", text } });
emit({ type: "turn.completed", usage: usage() });
