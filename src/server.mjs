#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import { listTools, callTool, toolErrorResult } from "./tools.mjs";
import { getBackend } from "./backends/index.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
let VERSION = "0.0.0";
try {
  VERSION = JSON.parse(fs.readFileSync(path.join(HERE, "..", "package.json"), "utf8")).version || VERSION;
} catch {
  // keep fallback
}

function parseBackendArg(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--backend") return argv[index + 1];
    if (arg.startsWith("--backend=")) return arg.slice("--backend=".length);
  }
  return undefined;
}

const backendName = parseBackendArg(process.argv.slice(2));
if (backendName === undefined) {
  process.stderr.write("[cli-baton] missing required argument: --backend <agy|codex>\n");
  process.exit(1);
}
if (!backendName) {
  process.stderr.write("[cli-baton] --backend requires a value (agy or codex)\n");
  process.exit(1);
}
const backend = getBackend(backendName);
if (!backend) {
  process.stderr.write("[cli-baton] unknown backend: " + backendName + " (expected agy or codex)\n");
  process.exit(1);
}

const SERVER_NAME = backendName + "-baton";
const log = (message) => {
  try {
    process.stderr.write("[" + SERVER_NAME + "] " + message + "\n");
  } catch {
    // ignore
  }
};
log("v" + VERSION + " ready on stdio (backend=" + backendName + ")");

function writeMessage(message) {
  try {
    process.stdout.write(JSON.stringify(message) + "\n");
  } catch {
    process.exit(0);
  }
}

function respond(id, result) {
  writeMessage({ jsonrpc: "2.0", id, result });
}

function respondError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  writeMessage({ jsonrpc: "2.0", id, error });
}

async function handleMessage(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    respondError(null, -32600, "Invalid Request");
    return;
  }
  const id = message.id;
  const hasId = Object.prototype.hasOwnProperty.call(message, "id") && id !== null && id !== undefined;
  const method = message.method;
  if (typeof method !== "string") {
    if (hasId) respondError(id, -32600, "Invalid Request: method must be a string");
    return;
  }
  if (!hasId) {
    // Notification (e.g. notifications/initialized, notifications/cancelled):
    // JSON-RPC never sends a response for these.
    return;
  }

  const params = message.params;

  if (method === "initialize") {
    const requested = params && typeof params.protocolVersion === "string" && params.protocolVersion.trim();
    respond(id, {
      protocolVersion: requested || "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: VERSION },
    });
    return;
  }

  if (method === "ping") {
    respond(id, {});
    return;
  }

  if (method === "tools/list") {
    respond(id, { tools: listTools(backendName) });
    return;
  }

  if (method === "tools/call") {
    const toolName = params && params.name;
    const toolArgs = params ? params.arguments : undefined;
    if (typeof toolName !== "string" || toolName === "") {
      respond(id, toolErrorResult("Invalid tools/call params: missing tool name"));
      return;
    }
    try {
      const result = await callTool({ backendName, name: toolName, args: toolArgs, env: process.env });
      respond(id, result);
    } catch (error) {
      log("tools/call " + toolName + " crashed: " + String((error && error.message) || error));
      respond(id, toolErrorResult("Internal error: " + String((error && error.message) || error)));
    }
    return;
  }

  respondError(id, -32601, "Method not found: " + method);
}

const rl = readline.createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    respondError(null, -32700, "Parse error");
    return;
  }
  void handleMessage(message);
});

rl.on("close", () => {
  // stdin closed: exit without touching detached runners, which keep working.
  log("stdin closed; exiting (running tasks continue in their detached runners)");
  process.exit(0);
});

process.stdout.on("error", () => process.exit(0));
process.on("uncaughtException", (error) => log("uncaught exception: " + String((error && error.stack) || error)));
process.on("unhandledRejection", (error) => log("unhandled rejection: " + String((error && error.stack) || error)));
