import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

export function readConfig() {
  const env = process.env;
  let usage = { input_tokens: 12, output_tokens: 3 };
  if (env.FAKE_USAGE) {
    try {
      usage = JSON.parse(env.FAKE_USAGE);
    } catch {
      // keep default
    }
  }
  return {
    logDir: env.FAKE_LOG_DIR || "",
    mode: env.FAKE_MODE || "success",
    text: env.FAKE_TEXT === undefined ? "FAKE_OK" : env.FAKE_TEXT,
    sessionId: env.FAKE_SESSION_ID || "fake-session-0001",
    stderr: env.FAKE_STDERR || "",
    sleepMs: Number(env.FAKE_SLEEP_MS || 60000),
    replyChars: Number(env.FAKE_REPLY_CHARS || 150000),
    exitCode: Number(env.FAKE_EXIT_CODE || 3),
    usage,
  };
}

export function logDirOf(cfg) {
  if (!cfg.logDir) throw new Error("FAKE_LOG_DIR is required");
  fs.mkdirSync(cfg.logDir, { recursive: true });
  return cfg.logDir;
}

export function recordInvocation(cfg, argv) {
  const dir = logDirOf(cfg);
  const info = {
    argv,
    cwd: process.cwd(),
    pid: process.pid,
    ppid: process.ppid,
    backend_script: path.basename(process.argv[1] || ""),
    started_at: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(dir, "argv.json"), JSON.stringify(info, null, 2));
  fs.writeFileSync(path.join(dir, "argv.txt"), argv.join("\n") + "\n");
}

export function readAllStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => {
      data += d;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
    process.stdin.resume();
  });
}

export async function captureStdinIfRequested(cfg, argv) {
  if (!argv.includes("-")) return "";
  const text = await readAllStdin();
  fs.writeFileSync(path.join(logDirOf(cfg), "stdin.txt"), text);
  return text;
}

export function spawnGrandchild(cfg) {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], {
    stdio: "ignore",
  });
  fs.writeFileSync(path.join(logDirOf(cfg), "grandchild.pid"), String(child.pid));
  child.unref();
  return child;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function writeLine(objOrString) {
  const text = typeof objOrString === "string" ? objOrString : JSON.stringify(objOrString);
  process.stdout.write(text + "\n");
}
