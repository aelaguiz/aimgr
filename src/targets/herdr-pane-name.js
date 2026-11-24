import crypto from "node:crypto";
import path from "node:path";
import { execFile } from "node:child_process";
import { readJsonFile, writeJsonFileIfChanged } from "../io/json-store.js";

// Herdr names the agent running in a pane (`lessons-writer`, say) and clears the name the
// moment that agent's process exits, about a second later, keeping no trace of it. So an
// agent restarted in its own pane comes back with no name, and whatever reaches it by name
// cannot. While an aim session runs in a Herdr pane, aim notes the name the pane's agent
// carries. A resume typed into the same pane, for a session in the same folder, gives that
// name back once Herdr sees the new session there.
//
// It never guesses: with no note for this pane and folder, or with a name already on the new
// session (someone named it first), it does nothing. Nothing here can fail or hold up a launch:
// every Herdr call is bounded, and a failed one is the same as no answer.

const LOOK_EVERY_MS = 60_000;
const GIVE_BACK_FOR_MS = 120_000;
const GIVE_BACK_EVERY_MS = 2_000;
const HERDR_TIMEOUT_MS = 3_000;

function notePath(homeDir, socket, pane) {
  const key = crypto.createHash("sha256").update(`${socket}\0${pane}`).digest("hex").slice(0, 32);
  return path.join(homeDir, ".aimgr", "herdr-pane-names", `${key}.json`);
}

function herdrAgent({ env, pane, args, execFileImpl }) {
  return new Promise((resolve) => {
    execFileImpl(env.HERDR_BIN_PATH || "herdr", ["agent", ...args], { env, timeout: HERDR_TIMEOUT_MS }, (error, stdout) => {
      try {
        resolve(JSON.parse(String(stdout ?? "")));
      } catch {
        resolve({ error: { message: error?.message ?? `herdr agent ${args[0]} ${pane} gave no answer` } });
      }
    });
  });
}

/**
 * Keep the Herdr name of the agent in this pane while `kind` runs here, and with `giveBack`,
 * put the name this pane last carried back on the new session. Returns `{ note, stop }`:
 * `note` is a line to print before the session starts (or null), and `stop` ends the looking.
 */
export function keepHerdrPaneName({
  env = {},
  homeDir,
  cwd,
  kind,
  giveBack = false,
  execFileImpl = execFile,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  nowImpl = Date.now,
}) {
  const socket = env.HERDR_SOCKET_PATH;
  const pane = env.HERDR_PANE_ID;
  if (!socket || !pane || !homeDir || !cwd) return { note: null, stop: () => {} };
  const file = notePath(homeDir, socket, pane);
  let last = null;
  try { last = readJsonFile(file); } catch { last = null; }
  const remember = (name) => {
    try { writeJsonFileIfChanged(file, { socket, pane, cwd, name }); } catch { /* a note we cannot write is no note */ }
  };
  let pending = giveBack && last?.socket === socket && last?.pane === pane && last?.cwd === cwd && last?.name
    ? last.name
    : null;
  const deadline = nowImpl() + GIVE_BACK_FOR_MS;
  let timer = null;
  let stopped = false;

  const schedule = () => {
    if (stopped) return;
    timer = setTimeoutImpl(look, pending ? GIVE_BACK_EVERY_MS : LOOK_EVERY_MS);
    timer?.unref?.();
  };
  // One look: note the name the session carries, or give the pending one back. A rename Herdr
  // refuses (the name is live on another agent) is tried again until the deadline, then dropped.
  async function look() {
    timer = null;
    try {
      const agent = (await herdrAgent({ env, pane, args: ["get", pane], execFileImpl }))?.result?.agent;
      if (stopped) return;
      const ours = agent?.pane_id === pane && agent?.agent === kind;
      if (ours && agent.name) {
        pending = null;
        remember(agent.name);
      } else if (pending && nowImpl() >= deadline) {
        pending = null;
      } else if (ours && pending) {
        const renamed = (await herdrAgent({ env, pane, args: ["rename", pane, pending], execFileImpl }))?.result?.agent;
        if (!stopped && renamed?.name === pending) {
          remember(pending);
          pending = null;
        }
      }
    } catch { /* the next look tries again */ }
    schedule();
  }
  schedule();
  return {
    note: pending ? `[aim] This Herdr pane last carried the name ${pending}; the session gets it back once Herdr sees it here.` : null,
    stop: () => {
      stopped = true;
      if (timer) clearTimeoutImpl(timer);
    },
  };
}
