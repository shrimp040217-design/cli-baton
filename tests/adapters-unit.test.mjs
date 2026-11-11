import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as agy from "../src/backends/agy.mjs";
import * as codex from "../src/backends/codex.mjs";
import { FAKE_AGY, FAKE_CODEX, makeTmpDir } from "./helpers.mjs";

const NL = String.fromCharCode(10);
const Q = String.fromCharCode(34);
const J = (value) => JSON.stringify(value);
const jsonl = (events) => events.map((event) => J(event)).join(NL) + NL;
const sandboxReadOnly = "sandbox_mode=" + Q + "read-only" + Q;
const approvalNever = "approval_policy=" + Q + "never" + Q;
const effortHigh = "model_reasoning_effort=" + Q + "high" + Q;

test("agy buildInvocation: conversation mode, prompt goes through stdin, no bare -p", () => {
  const invocation = agy.buildInvocation({ prompt: "hello", cwd: "/tmp/work" });
  assert.equal(agy.defaultAccess, "full");
  // agy now runs as a long-lived conversation: stdin stays open for more turns.
  assert.equal(invocation.stdin, "chat");
  assert.equal(invocation.args[0], "--input-format");
  assert.equal(invocation.args[1], "stream-json");
  assert.equal(invocation.args[invocation.args.indexOf("--output-format") + 1], "stream-json");
  assert.ok(invocation.args.includes("-p="), "-p= must stay a single empty-value token");
  assert.ok(!invocation.args.includes("-p"), "a bare -p would swallow the next argument");
  assert.ok(!invocation.args.includes("hello"), "the prompt must not travel through argv");
  assert.equal(invocation.args[invocation.args.length - 1], "-p=");
  assert.ok(invocation.args.includes("--dangerously-skip-permissions"));
  assert.ok(!invocation.args.includes("--mode"));
});

test("agy buildInvocation: read-only uses --mode plan, resume uses --conversation only", () => {
  const invocation = agy.buildInvocation({ prompt: "p", cwd: "/tmp/work", sessionId: "conv-1", model: "m1", effort: "high", access: "read-only" });
  assert.ok(invocation.args.includes("--mode"));
  assert.ok(invocation.args.includes("plan"));
  assert.ok(!invocation.args.includes("--dangerously-skip-permissions"));
  assert.ok(invocation.args.includes("--model") && invocation.args.includes("m1"));
  assert.ok(invocation.args.includes("--effort") && invocation.args.includes("high"));
  assert.ok(invocation.args.includes("--conversation") && invocation.args.includes("conv-1"));
  assert.ok(!invocation.args.includes("--continue"));
  assert.ok(!invocation.args.includes("-c"));
});

test("agy buildInvocation: leading-dash prompts never reach argv at all", () => {
  const invocation = agy.buildInvocation({ prompt: "-please do it", cwd: "/tmp/work" });
  assert.ok(!invocation.args.some((argument) => argument.includes("please do it")));
  assert.equal(invocation.prompt, "-please do it", "the runner sends it as the first stdin message");
});

test("codex buildInvocation: new session defaults to full and reads prompt from stdin", () => {
  const invocation = codex.buildInvocation({ prompt: "hello", cwd: "/tmp/work" });
  assert.equal(codex.defaultAccess, "full");
  assert.equal(invocation.stdin, "prompt");
  assert.deepEqual(invocation.args.slice(0, 3), ["exec", "--json", "--skip-git-repo-check"]);
  assert.ok(invocation.args.includes("-C") && invocation.args.includes("/tmp/work"));
  assert.ok(invocation.args.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.equal(invocation.args[invocation.args.length - 1], "-");
  assert.ok(!invocation.args.includes(sandboxReadOnly));
});

test("codex buildInvocation: resume drops -C and keeps read-only sandbox flags", () => {
  const invocation = codex.buildInvocation({ prompt: "p", cwd: "/tmp/work", sessionId: "thread-1", access: "read-only", model: "m", effort: "high" });
  assert.deepEqual(invocation.args.slice(0, 2), ["exec", "resume"]);
  assert.ok(invocation.args.includes("thread-1"));
  assert.ok(!invocation.args.includes("-C"));
  assert.ok(!invocation.args.includes("-s"));
  assert.ok(!invocation.args.includes("--sandbox"));
  assert.ok(invocation.args.includes(sandboxReadOnly));
  assert.ok(invocation.args.includes(approvalNever));
  assert.ok(!invocation.args.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.ok(invocation.args.includes("-m") && invocation.args.includes("m"));
  assert.ok(invocation.args.includes(effortHigh));
  assert.equal(invocation.args[invocation.args.length - 1], "-");
});

test("agy parseOutput handles success, failure status, empty reply, nonzero exit and junk", () => {
  const success = agy.parseOutput({ stdout: J({ conversation_id: "c1", status: "SUCCESS", response: "hi", usage: { input_tokens: 3 } }), stderr: "", exitCode: 0 });
  assert.equal(success.state, "completed");
  assert.equal(success.reply, "hi");
  assert.equal(success.sessionId, "c1");
  assert.equal(success.usage.input_tokens, 3);

  const failedStatus = agy.parseOutput({ stdout: J({ conversation_id: "c1", status: "FAILED", response: "", error: "boom" }), stderr: "", exitCode: 0 });
  assert.equal(failedStatus.state, "failed");
  assert.match(failedStatus.error, /boom/);

  const empty = agy.parseOutput({ stdout: J({ conversation_id: "c1", status: "SUCCESS", response: "" }), stderr: "", exitCode: 0 });
  assert.equal(empty.state, "failed");
  assert.match(empty.error, /empty/i);

  const nonzero = agy.parseOutput({ stdout: "", stderr: "fatal error" + NL, exitCode: 2 });
  assert.equal(nonzero.state, "failed");
  assert.match(nonzero.error, /fatal error/);

  const junk = agy.parseOutput({ stdout: "not json" + NL + J({ status: "SUCCESS", response: "ok" }), stderr: "", exitCode: 0 });
  assert.equal(junk.state, "completed");
  assert.equal(junk.reply, "ok");

  const pretty = agy.parseOutput({ stdout: JSON.stringify({ status: "SUCCESS", response: "pretty" }, null, 2), stderr: "", exitCode: 0 });
  assert.equal(pretty.state, "completed");
  const truncatedJson = agy.parseOutput({ stdout: "{\"status\":\"SUCC", stderr: "", exitCode: 0 });
  assert.equal(truncatedJson.state, "failed");
});

test("codex parseOutput: last agent_message wins, usage comes from turn.completed", () => {
  const parsed = codex.parseOutput({
    stdout: jsonl([
      { type: "thread.started", thread_id: "t1" },
      { type: "turn.started" },
      { type: "item.completed", item: { type: "agent_message", text: "first" } },
      { type: "item.completed", item: { type: "agent_message", text: "last" } },
      { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } },
    ]),
    stderr: "",
    exitCode: 0,
  });
  assert.equal(parsed.state, "completed");
  assert.equal(parsed.reply, "last");
  assert.equal(parsed.sessionId, "t1");
  assert.equal(parsed.usage.output_tokens, 2);
});

test("codex parseOutput: turn.failed, empty reply, junk lines and transient errors", () => {
  const turnFailed = codex.parseOutput({ stdout: jsonl([{ type: "turn.failed", error: { message: "nope" } }]), stderr: "", exitCode: 0 });
  assert.equal(turnFailed.state, "failed");
  assert.match(turnFailed.error, /nope/);

  const empty = codex.parseOutput({ stdout: jsonl([{ type: "thread.started", thread_id: "t" }, { type: "turn.completed" }]), stderr: "", exitCode: 0 });
  assert.equal(empty.state, "failed");
  assert.match(empty.error, /empty/i);

  const junk = codex.parseOutput({ stdout: "not json at all" + NL + jsonl([{ type: "item.completed", item: { type: "agent_message", text: "ok" } }]), stderr: "", exitCode: 0 });
  assert.equal(junk.state, "completed");
  assert.equal(junk.reply, "ok");

  const transient = codex.parseOutput({
    stdout: jsonl([
      { type: "error", message: "Reconnecting... 1/5 (request timed out)" },
      { type: "item.completed", item: { type: "error", message: "transient warning" } },
      { type: "item.completed", item: { type: "agent_message", text: "fine" } },
      { type: "turn.completed" },
    ]),
    stderr: "",
    exitCode: 0,
  });
  assert.equal(transient.state, "completed");
  assert.equal(transient.reply, "fine");

  const nonzero = codex.parseOutput({ stdout: "", stderr: "boom" + NL, exitCode: 4 });
  assert.equal(nonzero.state, "failed");
  assert.match(nonzero.error, /boom/);
});

test("findExecutable honours env override, PATH and HOME/.local/bin and returns null when absent", () => {
  const tmp = makeTmpDir("cli-baton-adapters-");
  try {
    const fake = path.join(tmp.path, "agy");
    fs.copyFileSync(FAKE_AGY, fake);
    fs.chmodSync(fake, 0o755);

    const viaEnv = agy.findExecutable({ ...process.env, AGY_BIN: fake });
    assert.equal(viaEnv.source, "env");
    assert.equal(viaEnv.path, fake);

    const badOverride = agy.findExecutable({ ...process.env, AGY_BIN: path.join(tmp.path, "missing"), PATH: tmp.path, HOME: tmp.path });
    assert.equal(badOverride, null);

    const viaPath = agy.findExecutable({ ...process.env, PATH: tmp.path, HOME: path.join(tmp.path, "no-home") });
    assert.equal(viaPath.source, "path");
    assert.equal(viaPath.path, fake);

    const home = path.join(tmp.path, "home");
    fs.mkdirSync(path.join(home, ".local", "bin"), { recursive: true });
    const homeFake = path.join(home, ".local", "bin", "agy");
    fs.copyFileSync(FAKE_AGY, homeFake);
    fs.chmodSync(homeFake, 0o755);
    const viaHome = agy.findExecutable({ ...process.env, PATH: "/nonexistent-dir-xyz", HOME: home });
    assert.equal(viaHome.source, "home-local-bin");
    assert.equal(viaHome.path, homeFake);

    const notFound = agy.findExecutable({ ...process.env, AGY_BIN: "", PATH: "/nonexistent-dir-xyz", HOME: path.join(tmp.path, "empty") });
    assert.equal(notFound, null);
    assert.match(agy.executableNotFoundMessage({ ...process.env, PATH: "/nonexistent-dir-xyz", HOME: path.join(tmp.path, "empty") }), /agy/);
  } finally {
    tmp.remove();
  }
});

test("listModels parses both fake CLIs and throws a clear error on failure", async () => {
  const logDir = makeTmpDir("cli-baton-models-");
  try {
    const agyModels = await agy.listModels({ execPath: FAKE_AGY, env: { ...process.env, FAKE_LOG_DIR: logDir.path } });
    assert.deepEqual(agyModels.models.map((model) => model.id), ["gemini-3-pro", "gemini-3-flash"]);
    assert.equal(agyModels.source, "agy models");

    const codexModels = await codex.listModels({ execPath: FAKE_CODEX, env: { ...process.env, FAKE_LOG_DIR: logDir.path } });
    assert.deepEqual(codexModels.models.map((model) => model.id), ["gpt-5.2-codex", "gpt-5.2"]);
    assert.equal(codexModels.source, "codex debug models");

    const broken = path.join(logDir.path, "broken-agy");
    fs.writeFileSync(broken, ["#!/bin/sh", "echo models exploded >&2", "exit 3", ""].join(NL));
    fs.chmodSync(broken, 0o755);
    await assert.rejects(() => agy.listModels({ execPath: broken, env: { ...process.env, FAKE_LOG_DIR: logDir.path } }), /agy models/i);
  } finally {
    logDir.remove();
  }
});