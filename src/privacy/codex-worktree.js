import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { codexWorktreeArguments, validateCodexWorktreeArguments } from "./codex-arguments.js";

const execute = promisify(execFile);

export async function codexWorktreeOperation({ artifact, env, cwd, request, executeImpl = execute }) {
  const helperEnv = Object.fromEntries(Object.entries(env).filter(([key]) =>
    !key.startsWith("LD_") && !key.startsWith("DYLD_") && key !== "GLIBC_TUNABLES"));
  try {
    const promise = executeImpl(artifact.worktreeTool, [], { env: helperEnv, cwd, encoding: "utf8", maxBuffer: 65536 });
    promise.child.stdin.on("error", () => {});
    promise.child.stdin.end(JSON.stringify(request));
    const result = JSON.parse((await promise).stdout);
    if (result.schema !== 1) throw new Error();
    return result;
  } catch {
    throw new Error("Codex could not complete the requested worktree operation.");
  }
}

export async function prepareCodexWorktree({ parsedArgs, nativeInputs, artifact, prepared, env, managed,
  operate = codexWorktreeOperation }) {
  if (!validateCodexWorktreeArguments(parsedArgs)) return null;
  const headless = ["exec", "e"].includes(parsedArgs.command);
  const selector = parsedArgs.command === "fork" ? parsedArgs.positionals[0]
    : headless && parsedArgs.execSubcommand === "fork" ? parsedArgs.positionals[1] : null;
  if (headless && parsedArgs.execSubcommand === "fork" && !selector) throw new Error("Codex worktree fork needs a session ID or name.");
  const common = { nativeInputs, artifact, prepared, env, managed };
  let source = await nativeInputs({ ...common, parsedArgs, operation: selector ? "fork_source" : "inputs",
    forkSource: selector ? { selector, headless } : null });
  const forkId = selector ? source.fork_source.thread_id : null;
  const sourceCwd = selector && !parsedArgs.cwdOverride ? source.fork_source.cwd : parsedArgs.cwd;
  if (sourceCwd !== parsedArgs.cwd) {
    source = await nativeInputs({ ...common, parsedArgs: { ...parsedArgs, cwd: sourceCwd }, operation: "inputs" });
  }
  if (source.source_untrusted) throw new Error("Codex --worktree cannot create a checkout from an explicitly untrusted source.");
  const result = await operate({ artifact, env, cwd: parsedArgs.processCwd,
    request: { operation: "create", root: source.worktree_root, source_cwd: sourceCwd } });
  const checkout = result.checkout;
  if (![checkout?.root, checkout?.cwd].every(value => typeof value === "string" && path.isAbsolute(value))) {
    throw new Error("Codex returned an invalid worktree destination.");
  }
  return { checkout, root: source.worktree_root, forkId, source: headless ? "exec" : "cli",
    parsedArgs: codexWorktreeArguments(parsedArgs, checkout.cwd, forkId), operate };
}

export function codexWorktreeDatabases(effectiveInputs) {
  return effectiveInputs.database_files.map(file => {
    const stat = fs.statSync(file, { bigint: true });
    // JSON integers must retain inode identity exactly across the private pipe.
    if (stat.ino > BigInt(Number.MAX_SAFE_INTEGER) || stat.dev > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Codex database identity cannot be represented safely.");
    return { path: file, device: Number(stat.dev), inode: Number(stat.ino) };
  });
}

export async function finishCodexWorktree({ worktree, nativeInputs, artifact, prepared, parsedArgs, env, managed,
  databases, startedAt, endedAt, onNotice }) {
  try {
    // API-key auth has no native account creation provenance; preserve the
    // checkout without guessing ownership from a provider name.
    if (prepared.keyBacked || prepared.accountId.startsWith("api-provider:")) throw new Error();
    const result = await nativeInputs({ artifact, prepared, parsedArgs, env, managed, operation: "worktree_owner",
      owner: { cwd: worktree.checkout.cwd, account_id: prepared.accountId, source: worktree.source,
        forked_from_id: worktree.forkId, started_at: startedAt, ended_at: endedAt, database_files: databases } });
    if (!result.owner_thread_id) throw new Error();
    const bound = await worktree.operate({ artifact, env, cwd: parsedArgs.processCwd,
      request: { operation: "bind", root: worktree.root, checkout: worktree.checkout.root, thread_id: result.owner_thread_id } });
    if (!bound.bound) throw new Error();
  } catch {
    try { onNotice(`Codex kept the worktree at ${worktree.checkout.root}. Its saved sessions remain available; no browser owner shortcut was assigned.`); } catch {}
  }
}
