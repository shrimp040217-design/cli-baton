#!/usr/bin/env node
/**
 * Fake `osascript` for tests: records every invocation, then pretends to be the
 * two AppleScripts src/viewer-window.mjs generates (open / close).
 *
 * Env:
 *   FAKE_OSASCRIPT_LOG            file to append one JSON record per call
 *   FAKE_OSASCRIPT_MODE           "fail" → exit 3 with stderr
 *   FAKE_OSASCRIPT_WINDOW_ID      window id printed for an open call (default 4242)
 *   FAKE_OSASCRIPT_CLOSE_RESULT   "missing" (user closed) / "still-open" (Terminal refused)
 */
import fs from "node:fs";

const argv = process.argv.slice(2);
const scriptIndex = argv.indexOf("-e");
const script = scriptIndex >= 0 ? String(argv[scriptIndex + 1] || "") : "";
const logFile = process.env.FAKE_OSASCRIPT_LOG || "";

if (logFile) {
  const record = {
    argv,
    script,
    kind: /do script "/.test(script) && /beforeIDs/.test(script) ? "open" : "other",
    pid: process.pid,
    at: new Date().toISOString(),
  };
  try {
    fs.appendFileSync(logFile, JSON.stringify(record) + "\n");
  } catch {
    // ignore
  }
}

if (String(process.env.FAKE_OSASCRIPT_MODE || "") === "fail") {
  process.stderr.write("osascript: simulated failure (Terminal not scriptable)\n");
  process.exit(3);
}

const isOpen = /beforeIDs/.test(script) && /do script /.test(script);
if (isOpen) {
  process.stdout.write(String(process.env.FAKE_OSASCRIPT_WINDOW_ID || "4242") + "\n");
  process.exit(0);
}

if (/close targetWindow saving no/.test(script)) {
  if (String(process.env.FAKE_OSASCRIPT_CLOSE_RESULT || "") === "missing") {
    process.stdout.write("missing\n");
  } else {
    process.stdout.write("closed\n");
  }
  process.exit(0);
}

process.stdout.write("\n");
process.exit(0);
