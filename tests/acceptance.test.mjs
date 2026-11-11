import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  McpClient, fakeEnv, makeHome, makeCwd, makeTmpDir, sendWait, waitForTerminal, toolPayload, isToolError,
  readArgv, readStdin, readRunDir, fileMode, waitFor, sleep, TERMINAL_STATES,
} from "./helpers.mjs";

const isWindows = process.platform === "win32";

async function withClient(backend, options, fn) {
  const home = makeHome();
  const logDir = makeTmpDir("cli-baton-log-");
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

function clearArgv(logDir) {
  fs.rmSync(path.join(logDir, "argv.json"), { force: true });
  fs.rmSync(path.join(logDir, "stdin.txt"), { force: true });
}

function assertFailed(state) {
  assert.equal(state.state, "failed");
  assert.ok(state.error && state.error.length > 0, "failed run should carry a non-empty error");
}

test("send returns immediately with run metadata and wait collects the reply", async () => {
  await withClient("agy", { mode: "sleep", sleepMs: 2500, text: "SLOW_OK" }, async ({ client, logDir }) => {
    const sendStarted = Date.now();
    const sendMessage = await client.callTool("agy_send", { message: "slow task", cwd: makeCwd().path, timeout_s: 30 });
    const sendElapsed = Date.now() - sendStarted;
    assert.equal(isToolError(sendMessage), false);
    const sent = toolPayload(sendMessage);
    assert.match(sent.run_id, /^[0-9a-f]{24}$/);
    assert.ok(["queued", "running"].includes(sent.state), "unexpected send state " + sent.state);
    assert.equal(sent.backend, "agy");
    assert.ok(sendElapsed < 2000, "send should return immediately, took " + sendElapsed + "ms");
    const done = await waitForTerminal(client, "agy", sent.run_id, { timeoutMs: 20000 });
    assert.equal(done.state, "completed");
    assert.equal(done.reply, "SLOW_OK");
    assert.ok(done.run_dir.startsWith(logDir) === false);
  });
});

test("successful send/wait exposes the documented field set for both backends", async () => {
  for (const backend of ["agy", "codex"]) {
    await withClient(backend, { text: backend.toUpperCase() + "_OK" }, async ({ client, logDir }) => {
      const cwd = makeCwd().path;
      const { sent, final } = await sendWait(client, { prefix: backend, message: "hello " + backend, cwd, waitTimeoutMs: 20000 });
      assert.ok(sent.run_dir);
      assert.equal(final.state, "completed");
      assert.equal(final.backend, backend);
      assert.equal(final.reply, backend.toUpperCase() + "_OK");
      assert.equal(final.chat, true, "both backends are conversations now");
      assert.equal(final.turns.length, 1, "the prompt is the first turn");
      assert.equal(final.turns[0].user_text, "hello " + backend);
      assert.equal(final.session_id, "fake-session-0001");
      assert.equal(final.exit_code, 0);
      assert.equal(final.error, null);
      assert.equal(final.access, "full");
      assert.equal(final.model, null);
      assert.equal(final.effort, null);
      assert.equal(final.cwd, cwd);
      assert.ok(final.started_at && final.ended_at);
      assert.equal(typeof final.duration_s, "number");
      assert.equal(typeof final.reply_truncated, "boolean");
      assert.equal(final.reply_truncated, false);
      assert.equal(typeof final.stderr_tail, "string");
      assert.ok(final.usage && typeof final.usage === "object");
      const run = readRunDir(final.run_dir);
      for (const name of ["meta.json", "prompt.txt", "stdout.jsonl", "stderr.log", "reply.txt", "result.json"]) {
        assert.ok(run.files.includes(name), name + " missing");
      }
      assert.equal(run.reply, backend.toUpperCase() + "_OK");
      assert.equal(run.prompt, "hello " + backend);
      if (!isWindows) {
        assert.equal(fileMode(final.run_dir), "700");
        for (const name of ["meta.json", "prompt.txt", "stdout.jsonl", "stderr.log", "reply.txt", "result.json"]) {
          assert.equal(fileMode(path.join(final.run_dir, name)), "600", name + " should be 0600");
        }
      }
    });
  }
});

test("default access is full for both backends and explicit read-only still wins", async () => {
  for (const backend of ["agy", "codex"]) {
    await withClient(backend, {}, async ({ client, logDir }) => {
      const cwd = makeCwd().path;
      clearArgv(logDir);
      const full = await sendWait(client, { prefix: backend, message: "full run", cwd, waitTimeoutMs: 20000 });
      assert.equal(full.final.access, "full");
      const fullArgv = readArgv(logDir).argv;
      if (backend === "agy") assert.ok(fullArgv.includes("--dangerously-skip-permissions"));
      else assert.ok(fullArgv.includes("--dangerously-bypass-approvals-and-sandbox"));
      clearArgv(logDir);
      const ro = await sendWait(client, { prefix: backend, message: "ro run", cwd, access: "read-only", waitTimeoutMs: 20000 });
      assert.equal(ro.final.access, "read-only");
      const roArgv = readArgv(logDir).argv;
      if (backend === "agy") {
        assert.ok(roArgv.includes("--mode") && roArgv.includes("plan"));
        assert.ok(!roArgv.includes("--dangerously-skip-permissions"));
      } else {
        assert.ok(roArgv.includes(String.fromCharCode(115,97,110,100,98,111,120,95,109,111,100,101) + "=" + String.fromCharCode(34) + "read-only" + String.fromCharCode(34)));
        assert.ok(roArgv.includes("approval_policy=" + String.fromCharCode(34) + "never" + String.fromCharCode(34)));
        assert.ok(!roArgv.includes("--dangerously-bypass-approvals-and-sandbox"));
      }
    });
  }
});

test("codex resume keeps read-only sandbox flags and omits -C", async () => {
  await withClient("codex", {}, async ({ client, logDir }) => {
    clearArgv(logDir);
    const { final } = await sendWait(client, {
      prefix: "codex", message: "resume ro", cwd: makeCwd().path, session_id: "thread-live-1", access: "read-only", waitTimeoutMs: 20000,
    });
    assert.equal(final.state, "completed");
    const argv = readArgv(logDir).argv;
    assert.equal(argv[0], "exec");
    assert.equal(argv[1], "resume");
    assert.ok(argv.includes("thread-live-1"));
    assert.ok(!argv.includes("-C"), "codex resume must not pass -C");
    assert.ok(!argv.includes("-s"), "codex resume must not pass -s");
    assert.ok(argv.includes("sandbox_mode=" + String.fromCharCode(34) + "read-only" + String.fromCharCode(34)));
    assert.ok(argv.includes("approval_policy=" + String.fromCharCode(34) + "never" + String.fromCharCode(34)));
    assert.ok(!argv.includes("--dangerously-bypass-approvals-and-sandbox"));
  });
});

test("resume session ids are passed correctly and never through --continue", async () => {
  await withClient("agy", {}, async ({ client, logDir }) => {
    const cwd = makeCwd().path;
    const first = await sendWait(client, { prefix: "agy", message: "first", cwd, waitTimeoutMs: 20000 });
    clearArgv(logDir);
    const second = await sendWait(client, { prefix: "agy", message: "second", cwd, session_id: "conv-abc", waitTimeoutMs: 20000 });
    assert.equal(second.final.state, "completed");
    const argv = readArgv(logDir).argv;
    assert.ok(argv.includes("--conversation") && argv.includes("conv-abc"));
    assert.ok(!argv.includes("--continue") && !argv.includes("-c"));
    assert.ok(first.final.reply);
  });
  await withClient("codex", {}, async ({ client, logDir }) => {
    const cwd = makeCwd().path;
    const first = await sendWait(client, { prefix: "codex", message: "first", cwd, waitTimeoutMs: 20000 });
    clearArgv(logDir);
    const second = await sendWait(client, { prefix: "codex", message: "second", cwd, session_id: first.final.session_id, waitTimeoutMs: 20000 });
    assert.equal(second.final.state, "completed");
    const argv = readArgv(logDir).argv;
    assert.equal(argv[0], "exec");
    assert.equal(argv[1], "resume");
    assert.ok(argv.includes(first.final.session_id));
    assert.ok(!argv.includes("--continue"));
    assert.ok(argv.includes("--dangerously-bypass-approvals-and-sandbox"), "codex resume default access must be full");
    assert.equal(readStdin(logDir).trim(), "second");
  });
});

test("prompts starting with a dash are passed safely for both backends", async () => {
  await withClient("agy", {}, async ({ client, logDir }) => {
    clearArgv(logDir);
    const { final } = await sendWait(client, { prefix: "agy", message: "- reply with DASH_OK", cwd: makeCwd().path, waitTimeoutMs: 20000 });
    assert.equal(final.state, "completed");
    const argv = readArgv(logDir).argv;
    assert.ok(!argv.some((argument) => argument.includes("DASH_OK")), "agy prompts go through stdin now");
    assert.ok(argv.includes("-p="), "-p= must stay a single empty-value token");
    const messages = fs
      .readFileSync(path.join(logDir, "stdin.jsonl"), "utf8")
      .split(String.fromCharCode(10))
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.equal(messages[0].message.content[0].text, "- reply with DASH_OK");
  });
  await withClient("codex", {}, async ({ client, logDir }) => {
    clearArgv(logDir);
    const { final } = await sendWait(client, { prefix: "codex", message: "- reply with DASH_OK", cwd: makeCwd().path, waitTimeoutMs: 20000 });
    assert.equal(final.state, "completed");
    const argv = readArgv(logDir).argv;
    assert.equal(argv[argv.length - 1], "-");
    assert.equal(readStdin(logDir).trim(), "- reply with DASH_OK");
  });
});

test("failure modes map to failed with an error for both backends", async () => {
  for (const backend of ["agy", "codex"]) {
    for (const mode of ["fail", "failed-status", "empty"]) {
      await withClient(backend, { mode }, async ({ client }) => {
        const { final } = await sendWait(client, { prefix: backend, message: "failing task", cwd: makeCwd().path, waitTimeoutMs: 20000 });
        assertFailed(final);
      });
    }
  }
});

test("replies over 100000 chars are truncated while reply.txt keeps the full text", async () => {
  await withClient("codex", { mode: "long", replyChars: 120000 }, async ({ client }) => {
    const { final } = await sendWait(client, { prefix: "codex", message: "long", cwd: makeCwd().path, waitTimeoutMs: 30000 });
    assert.equal(final.state, "completed");
    assert.equal(final.reply.length, 100000);
    assert.equal(final.reply_truncated, true);
    assert.equal(fs.readFileSync(path.join(final.run_dir, "reply.txt"), "utf8").length, 120000);
  });
});

test("stderr_tail and error are redacted", async () => {
  await withClient("agy", { mode: "secret", stderr: "Authorization: Bearer sk-live-abc123DEF456ghi789" + String.fromCharCode(10) + "api_key=SUPERSECRETVALUE" }, async ({ client }) => {
    const { final } = await sendWait(client, { prefix: "agy", message: "secret", cwd: makeCwd().path, waitTimeoutMs: 20000 });
    assertFailed(final);
    const haystack = String(final.stderr_tail) + " " + String(final.error);
    assert.ok(haystack.includes("[REDACTED]"), "expected [REDACTED] marker in " + haystack);
    assert.ok(!haystack.includes("sk-live-abc123DEF456ghi789"));
    assert.ok(!haystack.includes("SUPERSECRETVALUE"));
  });
});

test("non-JSON lines and transient codex error events are tolerated", async () => {
  await withClient("codex", { mode: "junk", text: "JUNK_OK" }, async ({ client }) => {
    const { final } = await sendWait(client, { prefix: "codex", message: "junk", cwd: makeCwd().path, waitTimeoutMs: 20000 });
    assert.equal(final.state, "completed");
    assert.equal(final.reply, "JUNK_OK");
  });
  await withClient("codex", { mode: "transient-errors", text: "STILL_OK" }, async ({ client }) => {
    const { final } = await sendWait(client, { prefix: "codex", message: "retry", cwd: makeCwd().path, waitTimeoutMs: 20000 });
    assert.equal(final.state, "completed");
    assert.equal(final.reply, "STILL_OK");
  });
});

test("argument validation rejects bad input without crashing", async () => {
  await withClient("agy", {}, async ({ client }) => {
    const cwd = makeCwd().path;
    const filePath = path.join(makeCwd().path, "file.txt");
    fs.writeFileSync(filePath, "x");
    const cases = [
      ["agy_send", {}],
      ["agy_send", { message: "", cwd }],
      ["agy_send", { message: 42, cwd }],
      ["agy_send", { message: "x", cwd: "relative/path" }],
      ["agy_send", { message: "x", cwd: path.join(cwd, "missing-dir") }],
      ["agy_send", { message: "x", cwd: filePath }],
      ["agy_send", { message: "x", cwd, effort: "ultra" }],
      ["agy_send", { message: "x", cwd, access: "all" }],
      ["agy_send", { message: "x", cwd, timeout_s: 5 }],
      ["agy_send", { message: "x", cwd, timeout_s: 90000 }],
      ["agy_send", { message: "x", cwd, session_id: "bad session" }],
      ["agy_wait", { run_id: "../../etc/passwd" }],
      ["agy_status", { run_id: "abc" }],
      ["agy_cancel", { run_id: "a".repeat(24) }],
      ["agy_status", { run_id: "0".repeat(24), tail: 51 }],
      ["agy_list_runs", { state: "nope" }],
      ["bogus_tool", {}],
    ];
    for (const [name, args] of cases) {
      const message = await client.callTool(name, args);
      assert.equal(isToolError(message), true, name + " " + JSON.stringify(args) + " should be isError");
      assert.ok(toolPayload(message).error, "error message expected for " + name);
    }
    const ping = await client.request("ping", {});
    assert.deepEqual(ping, {});
  });
});

test("same session cannot have two active runs", async () => {
  await withClient("agy", { mode: "sleep", sleepMs: 4000 }, async ({ client }) => {
    const cwd = makeCwd().path;
    const first = toolPayload(await client.callTool("agy_send", { message: "one", cwd, session_id: "S-1", timeout_s: 30 }));
    await waitFor(async () => {
      const status = toolPayload(await client.callTool("agy_status", { run_id: first.run_id }));
      return status.state === "running";
    }, { timeoutMs: 8000, label: "first run to start" });
    const second = await client.callTool("agy_send", { message: "two", cwd, session_id: "S-1", timeout_s: 30 });
    assert.equal(isToolError(second), true);
    assert.match(toolPayload(second).error, /session/i);
    const cancelled = toolPayload(await client.callTool("agy_cancel", { run_id: first.run_id }, 20000));
    assert.equal(cancelled.state, "cancelled");
  });
});

test("wait timeout reports current state with timed_out and does not kill the run", async () => {
  await withClient("agy", { mode: "sleep", sleepMs: 3500 }, async ({ client }) => {
    const cwd = makeCwd().path;
    const sent = toolPayload(await client.callTool("agy_send", { message: "slow", cwd, timeout_s: 30 }));
    const waited = toolPayload(await client.callTool("agy_wait", { run_id: sent.run_id, timeout_s: 1 }));
    assert.equal(waited.timed_out, true);
    assert.ok(["queued", "running"].includes(waited.state), "unexpected state " + waited.state);
    const final = await waitForTerminal(client, "agy", sent.run_id, { timeoutMs: 20000 });
    assert.equal(final.state, "completed");
  });
});

test("status returns recent tail lines bounded by the tail argument", async () => {
  await withClient("codex", { mode: "junk", text: "TAIL_OK" }, async ({ client }) => {
    const { final } = await sendWait(client, { prefix: "codex", message: "tail", cwd: makeCwd().path, waitTimeoutMs: 20000 });
    const defaultStatus = toolPayload(await client.callTool("codex_status", { run_id: final.run_id }));
    assert.ok(Array.isArray(defaultStatus.tail));
    assert.ok(defaultStatus.tail.length <= 5);
    const oneLine = toolPayload(await client.callTool("codex_status", { run_id: final.run_id, tail: 1 }));
    assert.equal(oneLine.tail.length, 1);
    assert.ok(oneLine.tail.every((line) => typeof line === "string"));
  });
});

test("list_runs is newest-first, filters by state and omits replies", async () => {
  await withClient("agy", {}, async ({ client }) => {
    const cwd = makeCwd().path;
    const first = await sendWait(client, { prefix: "agy", message: "run one", cwd, waitTimeoutMs: 20000 });
    await sleep(30);
    const second = await sendWait(client, { prefix: "agy", message: "run two", cwd, waitTimeoutMs: 20000 });
    const listing = toolPayload(await client.callTool("agy_list_runs", { limit: 10 }));
    assert.ok(listing.runs.length >= 2);
    assert.equal(listing.runs[0].run_id, second.final.run_id);
    assert.equal(listing.runs[1].run_id, first.final.run_id);
    assert.ok(listing.runs.every((entry) => !Object.prototype.hasOwnProperty.call(entry, "reply")));
    const completed = toolPayload(await client.callTool("agy_list_runs", { state: "completed" }));
    assert.ok(completed.runs.every((entry) => entry.state === "completed"));
    const limited = toolPayload(await client.callTool("agy_list_runs", { limit: 1 }));
    assert.equal(limited.runs.length, 1);
    assert.ok(limited.count >= limited.runs.length);
  });
});

test("list_models parses both backends and errors clearly instead of fabricating", async () => {
  await withClient("agy", {}, async ({ client }) => {
    const payload = toolPayload(await client.callTool("agy_list_models", {}, 30000));
    assert.equal(payload.backend, "agy");
    assert.deepEqual(payload.models.map((m) => m.id), ["gemini-3-pro", "gemini-3-flash"]);
    assert.equal(payload.source, "agy models");
  });
  await withClient("codex", {}, async ({ client }) => {
    const payload = toolPayload(await client.callTool("codex_list_models", {}, 30000));
    assert.deepEqual(payload.models.map((m) => m.id), ["gpt-5.2-codex", "gpt-5.2"]);
    assert.equal(payload.source, "codex debug models");
  });
  const broken = makeTmpDir("cli-baton-broken-");
  const script = path.join(broken.path, "agy");
  fs.writeFileSync(script, ["#!/bin/sh", "echo \"models exploded\" >&2", "exit 3", ""].join(String.fromCharCode(10)));
  fs.chmodSync(script, 0o755);
  const home = makeHome();
  const client = await McpClient.start({ backend: "agy", env: { ...process.env, CLI_BATON_HOME: home.path, AGY_BIN: script } });
  try {
    const message = await client.callTool("agy_list_models", {}, 30000);
    assert.equal(isToolError(message), true);
    const payload = toolPayload(message);
    assert.match(String(payload.error), /agy models/i);
    assert.ok(!payload.models || payload.models.length === 0);
  } finally {
    await client.close().catch(() => {});
    home.remove();
    broken.remove();
  }
});

test("meta.json replaces the prompt with a placeholder and never stores the raw prompt", async () => {
  await withClient("agy", {}, async ({ client }) => {
    const secretPrompt = "SECRET_PROMPT_TEXT_DO_NOT_STORE";
    const { final } = await sendWait(client, { prefix: "agy", message: secretPrompt, cwd: makeCwd().path, waitTimeoutMs: 20000 });
    const run = readRunDir(final.run_dir);
    const metaText = JSON.stringify(run.meta);
    assert.ok(metaText.includes("<prompt>"));
    assert.ok(!metaText.includes(secretPrompt));
    assert.equal(run.prompt, secretPrompt);
  });
  await withClient("codex", {}, async ({ client }) => {
    const secretPrompt = "SECRET_PROMPT_TEXT_CODEX";
    const { final } = await sendWait(client, { prefix: "codex", message: secretPrompt, cwd: makeCwd().path, waitTimeoutMs: 20000 });
    const run = readRunDir(final.run_dir);
    assert.ok(!JSON.stringify(run.meta).includes(secretPrompt));
    assert.equal(run.prompt, secretPrompt);
  });
});

test("cancel terminates an active run and is idempotent afterwards", async () => {
  await withClient("agy", { mode: "sleep", sleepMs: 60000 }, async ({ client }) => {
    const cwd = makeCwd().path;
    const sent = toolPayload(await client.callTool("agy_send", { message: "cancel me", cwd, timeout_s: 120 }));
    await waitFor(async () => {
      const status = toolPayload(await client.callTool("agy_status", { run_id: sent.run_id }));
      return status.state === "running";
    }, { timeoutMs: 8000, label: "run to start" });
    const cancelled = toolPayload(await client.callTool("agy_cancel", { run_id: sent.run_id }, 30000));
    assert.equal(cancelled.state, "cancelled");
    const again = await client.callTool("agy_cancel", { run_id: sent.run_id }, 30000);
    assert.equal(isToolError(again), false);
    assert.equal(toolPayload(again).state, "cancelled");
  });
});
test("redaction covers the literal sk-xxx and bare key= forms", async () => {
  const { redact } = await import("../src/runs.mjs");
  const NLx = String.fromCharCode(10);
  const redacted = redact("Bearer abc123XYZ" + NLx + "sk-xxx" + NLx + "key=baresecret" + NLx + "token: tok123" + NLx + "secret=sec123");
  assert.ok(!redacted.includes("abc123XYZ"), redacted);
  assert.ok(!redacted.includes("sk-xxx"), redacted);
  assert.ok(!redacted.includes("baresecret"), redacted);
  assert.ok(!redacted.includes("tok123"), redacted);
  assert.ok(!redacted.includes("sec123"), redacted);
  assert.ok((redacted.match(/\[REDACTED\]/g) || []).length >= 5, redacted);
});

test("relative CLI_BATON_HOME still resolves the run directory in the runner", async () => {
  const base = makeTmpDir("cli-baton-relhome-");
  const logDir = makeTmpDir("cli-baton-relhome-log-");
  const env = fakeEnv({ backend: "agy", home: "relative-home", logDir: logDir.path });
  env.CLI_BATON_HOME = "relative-home";
  const client = await McpClient.start({ backend: "agy", env, cwd: base.path });
  try {
    const { final } = await sendWait(client, { prefix: "agy", message: "relative home", cwd: makeCwd().path, waitTimeoutMs: 20000 });
    assert.equal(final.state, "completed");
    assert.ok(fs.existsSync(path.join(base.path, "relative-home", "agy", "runs", final.run_id, "result.json")));
  } finally {
    await client.close().catch(() => {});
    base.remove();
    logDir.remove();
  }
});