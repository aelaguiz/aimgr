import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { handleStatus } from "./status.js";

// Match the active AIM machines in docs/FLEET.md and the addresses in
// devcluster's fixer.toml. The Air and retired old M1 are not AIM targets.
export const AIM_FLEET = Object.freeze([
  { name: "m5", target: "aelaguiz@amir-m5.fairy-salmon.ts.net" },
  { name: "home", target: "aelaguiz@home.fairy-salmon.ts.net" },
  { name: "m3-max", target: "aelaguiz@amirs-m3-max-new.fairy-salmon.ts.net" },
  { name: "m3-36gb", target: "aelaguiz@amir-m3-36gb.fairy-salmon.ts.net" },
  { name: "mini-1", target: "aelaguiz@amir-mini-1.fairy-salmon.ts.net" },
  { name: "mini-2", target: "aelaguiz@amir-mini-2.fairy-salmon.ts.net" },
  { name: "studio", target: "agents@amirs-mac-studio.fairy-salmon.ts.net" },
]);

const execFileAsync = promisify(execFile);

async function remoteStatus(target) {
  const { stdout } = await execFileAsync("ssh", [
    "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "ServerAliveInterval=10",
    "-o", "ServerAliveCountMax=2", target, '"$HOME/.local/bin/aim" status --all-accounts',
  ], { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  return stdout;
}

export async function handleCluster(context) {
  const { positional, opts, homeDir, stdout, setExitCode } = context;
  if (positional.length !== 2 || positional[1] !== "status" || opts.json || opts.compact
      || opts.accounts || opts.allAccounts || opts.assignments || opts.afterDoubleDash.length) {
    throw new Error("Usage: aim cluster status");
  }
  let localMachine;
  try {
    localMachine = (await readFile(path.join(homeDir, ".devcluster", "machine"), "utf8")).trim();
  } catch {
    throw new Error("Cannot identify this machine: ~/.devcluster/machine is unavailable.");
  }
  if (!AIM_FLEET.some((machine) => machine.name === localMachine)) {
    throw new Error(`Machine ${localMachine || "(empty)"} is not in the active AIM fleet.`);
  }
  const runRemote = context.clusterRemoteStatusImpl ?? remoteStatus;
  const runLocal = context.clusterLocalStatusImpl ?? (async () => {
    let output = "";
    await handleStatus({ ...context, opts: { ...opts, allAccounts: true }, stdout: { write: (text) => { output += text; } } });
    return output;
  });
  const results = await Promise.all(AIM_FLEET.map(async (machine) => {
    try {
      const output = await (machine.name === localMachine ? runLocal() : runRemote(machine.target));
      if (typeof output !== "string" || !output.trim()) throw new Error("empty status response");
      return { ...machine, output };
    } catch (error) {
      // SSH stderr can contain paths or arbitrary remote output; report a bounded reason.
      const reason = error?.killed || error?.code === "ETIMEDOUT" ? "timed out"
        : error?.code === 255 ? "SSH connection failed" : "status unavailable";
      return { ...machine, error: reason };
    }
  }));
  for (const result of results) {
    stdout.write(`=== ${result.name} ===\n`);
    stdout.write(result.error ? `ERROR: ${result.error}\n` : `${result.output.trimEnd()}\n`);
    stdout.write("\n");
  }
  if (results.some((result) => result.error)) setExitCode(1);
}
