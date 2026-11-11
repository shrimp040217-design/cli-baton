/**
 * Protocol-level tests for the cli-baton MCP stdio server.
 *
 * Covers: initialize handshake (protocolVersion echo/default, serverInfo,
 * capabilities), notification semantics, ping, JSON-RPC error codes
 * (-32601 unknown method, -32700 parse error), tools/list contents and
 * annotations, unknown-tool handling, startup validation (missing/unknown
 * --backend), stdout JSON purity, and resilience to malformed tool arguments.
 *
 * Every test gets its own temp CLI_BATON_HOME / cwd / FAKE_LOG_DIR and cleans
 * up the spawned server process and directories afterwards. The fake agy /
 * codex CLIs are wired in through AGY_BIN / CODEX_BIN by helpers.fakeEnv.
 *
 * Run with: node --test tests/protocol.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  McpClient,
  fakeEnv,
  isToolError,
  makeHome,
  makeTmpDir,
  runServerToExit,
  sleep,
  toolPayload,
  waitFor,
} from "./helpers.mjs";

const BACKENDS = ["agy", "codex"];
const TEST_TIMEOUT = 30000;
// Both backends are conversations, so both expose <prefix>_say.
const TOOL_LEAVES = ["send", "say", "wait", "status", "cancel", "list_runs", "list_models"];
const CODEX_TOOL_LEAVES = TOOL_LEAVES;
const READ_ONLY_TOOLS = ["wait", "status", "list_runs", "list_models"];
const MUTATING_TOOLS = ["send", "say", "cancel"];

/**
 * Per-test sandbox: isolated temp CLI_BATON_HOME, cwd and FAKE_LOG_DIR.
 * Registers one after-hook that closes every spawned server before removing
 * the temp directories. Safe to call once per test.
 */
function makeSandbox(t, backend) {
  const home = makeHome();
  const cwd = makeTmpDir("cli-baton-protocol-cwd-");
  const logDir = makeTmpDir("cli-baton-protocol-log-");
  const env = fakeEnv({ backend, home: home.path, logDir: logDir.path });
  const cleanups = [];
  t.after(async () => {
    for (const cleanup of cleanups) {
      try {
        await cleanup();
      } catch {
        // Cleanup must never mask the real test result.
      }
    }
    home.remove();
    cwd.remove();
    logDir.remove();
  });
  return {
    env,
    cwd: cwd.path,
    home: home.path,
    logDir: logDir.path,
    onCleanup(fn) {
      cleanups.push(fn);
    },
  };
}

/** Spawn a server WITHOUT performing the initialize handshake. */
function spawnClient(t, backend) {
  const sandbox = makeSandbox(t, backend);
  const client = new McpClient({ backend, env: sandbox.env, cwd: sandbox.cwd });
  sandbox.onCleanup(() => client.close());
  return { client, sandbox };
}

/** Spawn a server and complete the standard initialize handshake. */
async function startClient(t, backend) {
  const { client, sandbox } = spawnClient(t, backend);
  await client.initialize();
  return { client, sandbox };
}

function parseToolResult(result) {
  assert.ok(result && Array.isArray(result.content), "tools/call result must contain a content array");
  assert.ok(result.content.length > 0, "tools/call content array must not be empty");
  const block = result.content[0];
  assert.equal(block.type, "text", "tools/call content block must be type 'text'");
  assert.equal(typeof block.text, "string", "tools/call content block text must be a string");
  return JSON.parse(block.text);
}

async function listTools(client) {
  const result = await client.request("tools/list", {});
  assert.ok(result && Array.isArray(result.tools), "tools/list must return a tools array");
  return result.tools;
}

function assertToolCatalog(tools, prefix) {
  const leaves = prefix === "agy" ? TOOL_LEAVES : CODEX_TOOL_LEAVES;
  const expectedNames = leaves.map((leaf) => prefix + "_" + leaf);
  const names = tools.map((tool) => tool.name);

  assert.equal(tools.length, expectedNames.length, "expected exactly " + expectedNames.length + " " + prefix + "_* tools, got: " + names.join(", "));
  assert.deepEqual(names.slice().sort(), expectedNames.slice().sort(), prefix + " tools/list names mismatch");

  const otherPrefix = prefix === "agy" ? "codex_" : "agy_";
  assert.equal(names.filter((name) => name.startsWith(otherPrefix)).length, 0, prefix + " server must not expose " + otherPrefix + "* tools");

  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  for (const tool of tools) {
    assert.ok(typeof tool.name === "string" && tool.name.startsWith(prefix + "_"), "unexpected tool name: " + JSON.stringify(tool.name));
    assert.equal(typeof tool.description, "string", tool.name + ": missing string description");
    assert.ok(tool.description.trim().length > 0, tool.name + ": description must not be empty");
    assert.ok(tool.inputSchema && typeof tool.inputSchema === "object", tool.name + ": missing inputSchema");
    assert.equal(tool.inputSchema.type, "object", tool.name + ": inputSchema.type must be 'object'");
    assert.ok(tool.annotations && typeof tool.annotations === "object", tool.name + ": missing annotations");
    assert.equal(typeof tool.annotations.readOnlyHint, "boolean", tool.name + ": annotations.readOnlyHint must be a boolean");
  }

  for (const leaf of READ_ONLY_TOOLS) {
    assert.equal(byName.get(prefix + "_" + leaf).annotations.readOnlyHint, true, prefix + "_" + leaf + ": readOnlyHint must be true");
  }
  for (const leaf of MUTATING_TOOLS) {
    const tool = byName.get(prefix + "_" + leaf);
    if (!tool) continue; // a backend may expose fewer tools than the shared list
    assert.equal(tool.annotations.readOnlyHint, false, prefix + "_" + leaf + ": readOnlyHint must be false");
  }
  assert.equal(byName.get(prefix + "_cancel").annotations.destructiveHint, true, prefix + "_cancel: destructiveHint must be true");
}

/* ------------------------------------------------------------------ */
/* 1. initialize handshake                                            */
/* ------------------------------------------------------------------ */

test("initialize echoes the client protocolVersion, serverInfo and tools capability", { timeout: TEST_TIMEOUT }, async (t) => {
  for (const backend of BACKENDS) {
    const { client } = spawnClient(t, backend);
    const init = await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "cli-baton-protocol-tests", version: "0.0.0" },
    });

    assert.equal(init.protocolVersion, "2024-11-05", backend + ": initialize must echo the client protocolVersion");
    assert.ok(init.serverInfo && typeof init.serverInfo === "object", backend + ": initialize must return serverInfo");
    assert.equal(init.serverInfo.name, backend + "-baton", backend + ": serverInfo.name mismatch");
    assert.ok(init.capabilities && typeof init.capabilities === "object", backend + ": initialize must return capabilities");
    assert.ok(Object.prototype.hasOwnProperty.call(init.capabilities, "tools"), backend + ": capabilities.tools must be present");

    client.notify("notifications/initialized", {});
    assert.equal(client.exit, null, backend + ": server exited during the handshake");
  }
});

test("initialize defaults protocolVersion to 2025-06-18 when params.protocolVersion is missing", { timeout: TEST_TIMEOUT }, async (t) => {
  for (const backend of BACKENDS) {
    const { client } = spawnClient(t, backend);
    const init = await client.request("initialize", {
      capabilities: {},
      clientInfo: { name: "cli-baton-protocol-tests", version: "0.0.0" },
    });

    assert.equal(init.protocolVersion, "2025-06-18", backend + ": missing protocolVersion must default to 2025-06-18");
    assert.equal(init.serverInfo.name, backend + "-baton", backend + ": serverInfo.name mismatch");
    assert.equal(client.exit, null, backend + ": server exited during the handshake");
  }
});

/* ------------------------------------------------------------------ */
/* 2. notifications / ping                                            */
/* ------------------------------------------------------------------ */

test("notifications produce no response and the next request is answered exactly once", { timeout: TEST_TIMEOUT }, async (t) => {
  const { client } = await startClient(t, "agy");

  const rawBefore = client.rawLines.length;
  const notificationsBefore = client.notifications.length;

  client.notify("notifications/initialized", {});
  client.notify("notifications/cancelled", { requestId: 999999 });
  await sleep(250);

  assert.equal(client.rawLines.length, rawBefore, "a notification must not produce a response line");
  assert.equal(client.notifications.length, notificationsBefore, "a notification must not produce a notification-style message");
  assert.equal(client.pending.size, 0, "server must not answer pending requests it does not have");

  const pingStart = client.rawLines.length;
  const pong = await client.request("ping");
  assert.deepEqual(pong, {}, "ping must return an empty result object");
  await sleep(150);

  const newLines = client.rawLines.slice(pingStart);
  assert.equal(newLines.length, 1, "expected exactly one response after ping, got: " + JSON.stringify(newLines));
  assert.equal(newLines[0].jsonrpc, "2.0");
  assert.notEqual(newLines[0].id, undefined);
  assert.notEqual(newLines[0].id, null);
  assert.deepEqual(newLines[0].result, {});
});

test("ping returns an empty result object", { timeout: TEST_TIMEOUT }, async (t) => {
  const { client } = await startClient(t, "codex");
  const pong = await client.request("ping");
  assert.deepEqual(pong, {});
  assert.equal(client.exit, null);
});

/* ------------------------------------------------------------------ */
/* 3. JSON-RPC error codes                                            */
/* ------------------------------------------------------------------ */

test("unknown method with an id returns JSON-RPC error -32601", { timeout: TEST_TIMEOUT }, async (t) => {
  const { client } = await startClient(t, "agy");
  const expectedId = client.nextId;
  const message = await client.requestRaw("resources/list", {});

  assert.ok(message.error, "unknown method must yield a JSON-RPC error object");
  assert.equal(message.error.code, -32601, "unknown method must use JSON-RPC error code -32601");
  assert.equal(typeof message.error.message, "string", "JSON-RPC error must carry a message string");
  assert.equal(message.id, expectedId, "JSON-RPC error must echo the request id");
  assert.equal(message.jsonrpc, "2.0");

  assert.deepEqual(await client.request("ping"), {}, "server must keep serving after -32601");
  assert.equal(client.exit, null);
});

test("invalid JSON line returns -32700 with id null and the server keeps serving", { timeout: TEST_TIMEOUT }, async (t) => {
  const { client } = await startClient(t, "agy");

  client.sendRaw("{ this is definitely not valid json }\n");

  const errorMessage = await waitFor(
    () => client.notifications.find((message) => message.error && message.error.code === -32700),
    { timeoutMs: 5000, label: "JSON-RPC -32700 parse error response" },
  );

  assert.equal(errorMessage.id, null, "parse-error response must have id null");
  assert.equal(errorMessage.jsonrpc, "2.0");
  assert.equal(typeof errorMessage.error.message, "string");
  assert.equal(client.exit, null, "server must not exit after a malformed JSON line");

  assert.deepEqual(await client.request("ping"), {}, "server must answer ping after a parse error");
  const tools = await client.request("tools/list", {});
  assert.ok(Array.isArray(tools.tools) && tools.tools.length === 7, "server must keep serving tools/list after a parse error");
});

/* ------------------------------------------------------------------ */
/* 4. tools/list                                                      */
/* ------------------------------------------------------------------ */

test("tools/list on the agy server exposes exactly the expected agy_* tools with annotations", { timeout: TEST_TIMEOUT }, async (t) => {
  const { client } = await startClient(t, "agy");
  const tools = await listTools(client);
  assertToolCatalog(tools, "agy");
});

test("tools/list on the codex server exposes exactly the expected codex_* tools with annotations", { timeout: TEST_TIMEOUT }, async (t) => {
  const { client } = await startClient(t, "codex");
  const tools = await listTools(client);
  assertToolCatalog(tools, "codex");
});

/* ------------------------------------------------------------------ */
/* 5. tools/call robustness                                           */
/* ------------------------------------------------------------------ */

test("tools/call of an unknown tool name returns an isError result for both backends", { timeout: TEST_TIMEOUT }, async (t) => {
  for (const backend of BACKENDS) {
    const { client } = await startClient(t, backend);
    const message = await client.callTool(backend + "_no_such_tool", {});

    assert.equal(message.error, undefined, backend + ": unknown tool must be a tool-level error, not a JSON-RPC error");
    assert.equal(isToolError(message), true, backend + ": unknown tool must return isError:true");
    const payload = parseToolResult(message.result);
    assert.equal(typeof payload.error, "string", backend + ": error payload must contain an error string");
    assert.ok(payload.error.trim().length > 0, backend + ": error message must not be empty");
    assert.equal(client.exit, null, backend + ": server crashed on unknown tool name");

    assert.deepEqual(await client.request("ping"), {}, backend + ": server must keep serving after an unknown tool call");
  }
});

test("tools/call with malformed argument types returns isError and never crashes", { timeout: TEST_TIMEOUT }, async (t) => {
  const { client } = await startClient(t, "agy");
  const cases = [
    { name: "agy_status", args: { run_id: 12345 } },
    { name: "agy_status", args: { run_id: { nested: "object" } } },
    { name: "agy_wait", args: { run_id: [] } },
    { name: "agy_list_runs", args: { limit: "not-a-number" } },
    { name: "agy_status", args: null },
  ];

  for (const testCase of cases) {
    const label = testCase.name + " with arguments " + JSON.stringify(testCase.args);
    const message = await client.callTool(testCase.name, testCase.args, 15000);
    assert.equal(message.error, undefined, label + ": wrong argument types must be a tool-level error, not a JSON-RPC error");
    assert.equal(isToolError(message), true, label + ": expected isError:true result");
    const payload = parseToolResult(message.result);
    assert.equal(typeof payload.error, "string", label + ": expected {error:<message>} payload");
    assert.ok(payload.error.trim().length > 0, label + ": error message must not be empty");
    assert.equal(client.exit, null, label + ": server crashed on malformed arguments");
  }

  assert.deepEqual(await client.request("ping"), {}, "server must keep serving after malformed tool arguments");
  assert.equal(client.exit, null);
});

/* ------------------------------------------------------------------ */
/* 6. startup validation                                              */
/* ------------------------------------------------------------------ */

test("missing --backend exits non-zero with a stderr message and empty stdout", { timeout: TEST_TIMEOUT }, async (t) => {
  const sandbox = makeSandbox(t, "agy");
  const result = await runServerToExit({ args: [], env: sandbox.env, timeoutMs: 15000 });

  assert.equal(result.signal, null, "server failed to exit on its own (signal: " + result.signal + ")");
  assert.equal(typeof result.code, "number", "server must exit with a numeric code");
  assert.notEqual(result.code, 0, "missing --backend must exit non-zero");
  assert.equal(result.stdout.trim(), "", "startup failure must not write anything to stdout");
  assert.ok(result.stderr.trim().length > 0, "startup failure must explain itself on stderr");
  assert.match(result.stderr, /backend/i, "stderr should mention the backend requirement");
});

test("unknown --backend exits non-zero with a stderr message and empty stdout", { timeout: TEST_TIMEOUT }, async (t) => {
  const sandbox = makeSandbox(t, "agy");
  const result = await runServerToExit({ args: ["--backend", "not-a-real-backend"], env: sandbox.env, timeoutMs: 15000 });

  assert.equal(result.signal, null, "server failed to exit on its own (signal: " + result.signal + ")");
  assert.equal(typeof result.code, "number", "server must exit with a numeric code");
  assert.notEqual(result.code, 0, "unknown --backend must exit non-zero");
  assert.equal(result.stdout.trim(), "", "startup failure must not write anything to stdout");
  assert.ok(result.stderr.trim().length > 0, "startup failure must explain itself on stderr");
  assert.match(result.stderr, /not-a-real-backend|backend/i, "stderr should identify the invalid backend");
});

/* ------------------------------------------------------------------ */
/* 7. stdout purity                                                   */
/* ------------------------------------------------------------------ */

test("stdout stays newline-delimited JSON-RPC during normal operation", { timeout: TEST_TIMEOUT }, async (t) => {
  const { client } = await startClient(t, "agy");

  await client.request("ping");
  await client.request("tools/list", {});
  await client.callTool("agy_no_such_tool", {});
  await client.callTool("agy_status", { run_id: "000000000000000000000000" });
  await sleep(200);

  assert.ok(client.rawLines.length > 0, "expected some stdout output");
  for (const entry of client.rawLines) {
    assert.equal(entry.parseError, undefined, "stdout contained a non-JSON line: " + JSON.stringify(entry.raw));
    assert.equal(entry.jsonrpc, "2.0", "stdout message is not JSON-RPC 2.0: " + JSON.stringify(entry));
  }
  await waitFor(() => client.buffer === "", { timeoutMs: 2000, label: "stdout to end on a complete line" });
  assert.equal(client.buffer, "", "stdout must not end with a partial line");
  assert.equal(client.exit, null);
});
