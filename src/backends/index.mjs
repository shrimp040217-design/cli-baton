import * as agy from "./agy.mjs";
import * as codex from "./codex.mjs";

export const BACKENDS = { agy, codex };
export const BACKEND_NAMES = Object.keys(BACKENDS);

export function getBackend(backendName) {
  return Object.prototype.hasOwnProperty.call(BACKENDS, backendName) ? BACKENDS[backendName] : null;
}
