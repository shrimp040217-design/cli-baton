import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import * as runs from "./runs.mjs";
import { getBackend } from "./backends/index.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_PATH = path.join(HERE, "runner.mjs");

export const EFFORT_VALUES = ["low", "medium", "high", "xhigh", "max"];
export const ACCESS_VALUES = ["read-only", "full"];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class ToolInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "ToolInputError";
  }
}

function accessDescription(backendName) {
  if (backendName === "agy") {
    return "Access mode. Default: full (passes --dangerously-skip-permissions). read-only passes --mode plan and does not skip permission prompts.";
  }
  return 'Access mode. Default: full (passes --dangerously-bypass-approvals-and-sandbox). read-only passes -c sandbox_mode="read-only" -c approval_policy="never" for both new and resumed sessions.';
}

function buildDefinition(backendName) {
  const prefix = backendName + "_";
  return [
    {
      suffix: "send",
      description:
        "Send a task to the " +
        backendName +
        " CLI. Returns immediately with run_id/state/run_dir; use " +
        prefix +
        "wait or " +
        prefix +
        "status to collect the result. access defaults to full for both backends.",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string", description: "Task prompt sent to the CLI." },
          cwd: { type: "string", description: "Absolute path to an existing directory; the CLI runs there." },
          session_id: {
            type: "string",
            description:
              backendName === "agy"
                ? "Resume an existing conversation with --conversation <session_id>. Never uses -c/--continue."
                : "Resume an existing codex session: codex exec resume <session_id>.",
          },
          model: { type: "string", description: "Model name (default: CLI default)." },
          effort: { type: "string", enum: EFFORT_VALUES, description: "Reasoning effort." },
          access: { type: "string", enum: ACCESS_VALUES, description: accessDescription(backendName), default: "full" },
          timeout_s: {
            type: "integer",
            minimum: 10,
            maximum: 86400,
            default: 3600,
            description: "Runner-side timeout in seconds (kills the CLI process group).",
          },
        },
        required: ["message", "cwd"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    {
      suffix: "wait",
      description:
        "Wait for a run to reach a terminal state (polls every 500ms). Returns the current state plus timed_out:true when the wait deadline elapses.",
      inputSchema: {
        type: "object",
        properties: {
          run_id: { type: "string", description: "Run id returned by " + prefix + "send." },
          timeout_s: { type: "integer", minimum: 1, maximum: 540, default: 240, description: "Maximum time to wait." },
        },
        required: ["run_id"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      suffix: "status",
      description: "Return a run's current state without waiting, including the most recent raw event lines.",
      inputSchema: {
        type: "object",
        properties: {
          run_id: { type: "string", description: "Run id." },
          tail: {
            type: "integer",
            minimum: 0,
            maximum: 50,
            default: 5,
            description: "Number of recent event lines to include (max 50).",
          },
        },
        required: ["run_id"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      suffix: "cancel",
      description:
        "Cancel a run: SIGTERM to the CLI process group, then SIGKILL after 5 seconds; final state is cancelled. Already-finished runs return their current state without error.",
      inputSchema: {
        type: "object",
        properties: { run_id: { type: "string", description: "Run id." } },
        required: ["run_id"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    {
      suffix: "list_runs",
      description: "List runs for this backend, newest first. Reply bodies are not included.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 100, default: 20, description: "Maximum number of runs." },
          state: {
            type: "string",
            enum: runs.STATE_VALUES,
            description: "Only return runs in this state.",
          },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      suffix: "list_models",
      description:
        backendName === "agy"
          ? "List models known to the agy CLI by parsing 'agy models'. Returns a clear error (never a fabricated list) if the CLI cannot provide one."
          : "List models known to the codex CLI by parsing 'codex debug models'. Returns a clear error (never a fabricated list) if the CLI cannot provide one.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
  ];
}

export function listTools(backendName) {
  const backend = getBackend(backendName);
  if (!backend) throw new Error("Unknown backend: " + backendName);
  return buildDefinition(backendName).map((definition) => ({
    name: backendName + "_" + definition.suffix,
    description: definition.description,
    inputSchema: definition.inputSchema,
    annotations: definition.annotations,
  }));
}

export function toolOkResult(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

export function toolErrorResult(message) {
  return { content: [{ type: "text", text: JSON.stringify({ error: message }, null, 2) }], isError: true };
}

function asObject(args) {
  if (args === undefined || args === null) return {};
  if (typeof args !== "object" || Array.isArray(args)) throw new ToolInputError("arguments must be a JSON object");
  return args;
}

function requireString(args, key, { nonEmpty = false, maxLength = 1000000 } = {}) {
  const value = args[key];
  if (value === undefined || value === null) throw new ToolInputError("Missing required parameter: " + key);
  if (typeof value !== "string") throw new ToolInputError("Parameter " + key + " must be a string");
  if (nonEmpty && value.trim() === "") throw new ToolInputError("Parameter " + key + " must not be empty");
  if (value.length > maxLength) throw new ToolInputError("Parameter " + key + " is too long (max " + maxLength + " characters)");
  return value;
}

function optionalString(args, key, { maxLength = 1000, pattern = null, patternDescription = "" } = {}) {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ToolInputError("Parameter " + key + " must be a string");
  if (value.trim() === "") throw new ToolInputError("Parameter " + key + " must not be empty when provided");
  if (value.length > maxLength) throw new ToolInputError("Parameter " + key + " is too long (max " + maxLength + " characters)");
  if (pattern && !pattern.test(value)) throw new ToolInputError("Parameter " + key + " is invalid" + (patternDescription ? ": " + patternDescription : ""));
  return value;
}

function integerArg(args, key, { min, max, defaultValue }) {
  const value = args[key];
  if (value === undefined || value === null) return defaultValue;
  if (typeof value !== "number" || !Number.isInteger(value)) throw new ToolInputError("Parameter " + key + " must be an integer");
  if (value < min || value > max) throw new ToolInputError("Parameter " + key + " must be between " + min + " and " + max);
  return value;
}

function enumArg(args, key, values, { required = false, defaultValue } = {}) {
  const value = args[key];
  if (value === undefined || value === null) {
    if (required) throw new ToolInputError("Missing required parameter: " + key);
    return defaultValue;
  }
  if (typeof value !== "string") throw new ToolInputError("Parameter " + key + " must be a string");
  if (!values.includes(value)) throw new ToolInputError("Parameter " + key + " must be one of: " + values.join(", "));
  return value;
}

function runIdArg(args) {
  const value = requireString(args, "run_id", { nonEmpty: true, maxLength: 128 });
  if (!runs.isValidRunId(value)) throw new ToolInputError("Invalid run_id: expected 24 lowercase hex characters");
  return value;
}

function cwdArg(args) {
  const cwd = requireString(args, "cwd", { nonEmpty: true, maxLength: 4096 });
  if (!path.isAbsolute(cwd)) throw new ToolInputError("cwd must be an absolute path: " + cwd);
  let stat;
  try {
    stat = fs.statSync(cwd);
  } catch {
    throw new ToolInputError("cwd does not exist: " + cwd);
  }
  if (!stat.isDirectory()) throw new ToolInputError("cwd is not a directory: " + cwd);
  return cwd;
}

async function handleSend({ backendName, backend, args, env }) {
  const message = requireString(args, "message", { nonEmpty: true, maxLength: 1000000 });
  const cwd = cwdArg(args);
  const sessionId = optionalString(args, "session_id", {
    maxLength: 512,
    pattern: /^[^\s\u0000-\u001f]+$/,
    patternDescription: "must not contain whitespace or control characters",
  });
  const model = optionalString(args, "model", {
    maxLength: 200,
    pattern: /^[^\s\u0000-\u001f]+$/,
    patternDescription: "must not contain whitespace or control characters",
  });
  const effort = enumArg(args, "effort", EFFORT_VALUES);
  const access = enumArg(args, "access", ACCESS_VALUES, { defaultValue: backend.defaultAccess });
  const timeoutS = integerArg(args, "timeout_s", { min: 10, max: 86400, defaultValue: 3600 });

  const root = runs.resolveRoot(env);
  const active = runs.findActiveRunBySession({ root, backend: backendName, sessionId });
  if (active) {
    throw new ToolInputError(
      "A run is already active for session_id " +
        JSON.stringify(sessionId) +
        " (run_id " +
        active.run_id +
        ", state " +
        active.state +
        "). Wait for it or cancel it before sending another message in this session.",
    );
  }

  const located = backend.findExecutable(env);
  if (!located) throw new ToolInputError(backend.executableNotFoundMessage(env));

  const runId = runs.generateRunId();
  const argvTemplate = backend.buildInvocation({
    prompt: "<prompt>",
    cwd,
    sessionId,
    model,
    effort,
    access,
  }).args;

  const { runDir } = runs.createRun({
    root,
    backend: backendName,
    runId,
    prompt: message,
    meta: {
      cwd,
      session_id: sessionId || null,
      model: model || null,
      effort: effort || null,
      access,
      timeout_s: timeoutS,
      cli_path: located.path,
      cli_source: located.source,
      argv: argvTemplate,
      prompt_placeholder: "<prompt>",
      runner_spawned_at: new Date().toISOString(),
    },
  });

  const child = spawn(process.execPath, [RUNNER_PATH, "--backend", backendName, "--run-id", runId], {
    detached: true,
    stdio: "ignore",
    cwd: runDir,
    env: { ...process.env, CLI_BATON_HOME: root },
    windowsHide: true,
  });
  child.unref();
  if (child.pid) {
    runs.writeSupervisor(runDir, {
      pid: child.pid,
      pid_start: runs.processStartToken(child.pid),
      spawned_at: new Date().toISOString(),
      backend: backendName,
      run_id: runId,
    });
  }
  child.on("error", (error) => {
    try {
      runs.writeFileAtomic(runs.runPaths(runDir).reply, "", 0o600);
      runs.finalizeRun({
        runDir,
        patch: {
          state: "failed",
          reply: "",
          exit_code: null,
          error: "Failed to start runner: " + String((error && error.message) || error),
          started_at: null,
          ended_at: new Date().toISOString(),
        },
      });
    } catch {
      // ignore
    }
  });

  const snapshot = runs.getRunSnapshot({ root, backend: backendName, runId, includeReply: false });
  return {
    run_id: runId,
    state: snapshot ? snapshot.state : "queued",
    run_dir: runDir,
    backend: backendName,
  };
}

async function handleWait({ backendName, args, env }) {
  const runId = runIdArg(args);
  const timeoutS = integerArg(args, "timeout_s", { min: 1, max: 540, defaultValue: 240 });
  const root = runs.resolveRoot(env);
  const deadline = Date.now() + timeoutS * 1000;
  let snapshot = runs.getRunSnapshot({ root, backend: backendName, runId, includeReply: true });
  if (!snapshot) throw new ToolInputError("Run not found: " + runId);
  while (!runs.TERMINAL_STATES.has(snapshot.state)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const payload = runs.formatToolPayload(snapshot);
      payload.timed_out = true;
      return payload;
    }
    await sleep(Math.min(500, remaining));
    snapshot = runs.getRunSnapshot({ root, backend: backendName, runId, includeReply: true });
    if (!snapshot) throw new ToolInputError("Run not found: " + runId);
  }
  return runs.formatToolPayload(snapshot);
}

async function handleStatus({ backendName, args, env }) {
  const runId = runIdArg(args);
  const tail = integerArg(args, "tail", { min: 0, max: 50, defaultValue: 5 });
  const root = runs.resolveRoot(env);
  const snapshot = runs.getRunSnapshot({ root, backend: backendName, runId, includeReply: true, tail });
  if (!snapshot) throw new ToolInputError("Run not found: " + runId);
  return runs.formatToolPayload(snapshot);
}

async function handleCancel({ backendName, args, env }) {
  const runId = runIdArg(args);
  const root = runs.resolveRoot(env);
  const result = await runs.cancelRun({ root, backend: backendName, runId });
  if (!result.found) throw new ToolInputError("Run not found: " + runId);
  return runs.formatToolPayload(result.snapshot);
}

async function handleListRuns({ backendName, args, env }) {
  const limit = integerArg(args, "limit", { min: 1, max: 100, defaultValue: 20 });
  const state = enumArg(args, "state", runs.STATE_VALUES);
  const root = runs.resolveRoot(env);
  const listing = runs.listRuns({ root, backend: backendName, limit, state: state || null });
  return { backend: backendName, runs: listing.runs, count: listing.count, total: listing.total };
}

async function handleListModels({ backendName, backend, env }) {
  const located = backend.findExecutable(env);
  if (!located) throw new ToolInputError(backend.executableNotFoundMessage(env));
  const result = await backend.listModels({ execPath: located.path, env });
  return {
    backend: backendName,
    models: result.models,
    source: result.source,
    count: result.models.length,
    executable: located.path,
  };
}

const HANDLERS = {
  send: handleSend,
  wait: handleWait,
  status: handleStatus,
  cancel: handleCancel,
  list_runs: handleListRuns,
  list_models: handleListModels,
};

export async function callTool({ backendName, name, args, env = process.env }) {
  const backend = getBackend(backendName);
  if (!backend) return toolErrorResult("Unknown backend: " + backendName);
  const prefix = backendName + "_";
  const suffix = typeof name === "string" && name.startsWith(prefix) ? name.slice(prefix.length) : null;
  const handler = suffix ? HANDLERS[suffix] : null;
  if (!handler) {
    return toolErrorResult("Unknown tool for the " + backendName + " backend: " + String(name));
  }
  let parsed;
  try {
    parsed = asObject(args);
  } catch (error) {
    return toolErrorResult(error.message);
  }
  try {
    const payload = await handler({ backendName, backend, args: parsed, env });
    return toolOkResult(payload);
  } catch (error) {
    if (error instanceof ToolInputError) return toolErrorResult(error.message);
    if (error && error.code === "INVALID_RUN_ID") return toolErrorResult(error.message);
    return toolErrorResult("Internal error: " + String((error && error.message) || error));
  }
}
