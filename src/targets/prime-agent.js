import path from "node:path";
import { isObject } from "../core/normalize.js";
import { resolveManagedPrimeAgentDir, resolvePrimeAuthFilePath } from "../io/paths.js";
import { resolveHarnessOwnedAuthPath } from "./harness-auth.js";

export function createPrimeTargetAdapter({ state, homeDir, env = {} }) {
  state.targets = isObject(state.targets) ? state.targets : {};
  state.targets.primeAgent = isObject(state.targets.primeAgent) ? state.targets.primeAgent : {};
  const resolvedAgentDir = resolveManagedPrimeAgentDir({ homeDir, env });
  const ownership = resolveHarnessOwnedAuthPath({
    targetState: state.targets.primeAgent,
    resolvedAuthPath: resolvePrimeAuthFilePath(resolvedAgentDir),
  });
  return Object.freeze({
    targetId: "prime",
    targetState: state.targets.primeAgent,
    agentDir: path.dirname(ownership.authPath),
    resolvedAgentDir,
    ...ownership,
  });
}
