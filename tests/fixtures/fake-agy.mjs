#!/usr/bin/env node
import { readConfig, recordInvocation, captureStdinIfRequested, spawnGrandchild, sleep, writeLine } from "./fake-common.mjs";

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

await captureStdinIfRequested(cfg, argv);

if (cfg.mode === "grandchild") spawnGrandchild(cfg);
if (cfg.mode === "sleep" || cfg.mode === "grandchild") await sleep(cfg.sleepMs);

if (cfg.mode === "fail") {
  process.stderr.write(cfg.stderr || "agy: fatal: simulated failure\n");
  process.exit(cfg.exitCode);
}
if (cfg.mode === "secret") {
  process.stderr.write("Authorization: Bearer sk-live-abc123DEF456ghi789\n");
  process.stderr.write("api_key=SUPERSECRETVALUE token: abcdef123456 secret=topsecret\n");
  process.exit(cfg.exitCode);
}
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
