import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execute = promisify(execFile);

/** The immutable AIM helper calls the pinned upstream configuration and state
 * libraries with outbound traffic denied before their first call. Its private
 * response contains finite path/policy facts, never configuration contents. */
export async function prepareCodexNativeInputs({ artifact, prepared, parsedArgs, env, managed,
  ownedAppServer = false, operation = "initialize", executeImpl = execute } = {}) {
  const request = { operation, artifact_set: artifact.artifactSet, codex_home: prepared.codexHome,
    cwd: parsedArgs.cwd, profile: parsedArgs.profile, config: parsedArgs.config,
    harness: parsedArgs.harness ?? {}, owned_app_server: ownedAppServer,
    strict_config: parsedArgs.strictConfig ?? false,
    ignore_user_config: ["exec", "e"].includes(parsedArgs.command) && parsedArgs.ignoreUserConfig === true,
    ignore_rules: ["exec", "e"].includes(parsedArgs.command) && parsedArgs.ignoreRules === true,
    headless: ["exec", "e"].includes(parsedArgs.command), yolo: parsedArgs.yolo === true,
    worktree: parsedArgs.worktree === true && !parsedArgs.inspection,
    forced_config: managed.forced?.config_toml_base64 ?? "",
    forced_requirements: managed.forced?.requirements_toml_base64 ?? "" };
  let response;
  try {
    // Loader hooks execute before main and therefore before the helper can
    // install its boundary. Preserve the separate ordinary tool environment.
    const helperEnv = Object.fromEntries(Object.entries(env).filter(([key]) =>
      !key.startsWith("LD_") && !key.startsWith("DYLD_") && key !== "GLIBC_TUNABLES"));
    // execFile's async API has no input option; explicitly own all three pipes.
    // Do not inherit a socket, TTY, credential descriptor or native diagnostics.
    const promise = executeImpl(artifact.configState, [], { env: helperEnv, cwd: parsedArgs.cwd,
      encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 });
    promise.child.stdin.on("error", () => {});
    promise.child.stdin.end(JSON.stringify(request));
    response = JSON.parse((await promise).stdout);
  } catch {
    // Upstream parse errors may embed the original settings or a secret value.
    throw new Error("Codex could not prepare its local settings and databases. Check the selected native settings and required privacy policy.");
  }
  if (response.schema !== 1 || response.source_revision !== "54201ea65a3501d09a87c776376a0c16aa39db70"
    || (operation === "initialize" && response.initialized !== true)
    || !path.isAbsolute(response.cwd ?? "")
    || [response.reads, response.writes, response.database_roots, response.database_files]
      .some(items => !Array.isArray(items) || items.length > 256 || items.some(file => typeof file !== "string" || !path.isAbsolute(file)))
    || !Array.isArray(response.collectors) || response.collectors.length !== 3) {
    throw new Error("Codex returned an invalid native input inventory.");
  }
  if (request.worktree && (!path.isAbsolute(response.worktree_root ?? "") || typeof response.source_untrusted !== "boolean")) {
    throw new Error("Codex returned an invalid native worktree input inventory.");
  }
  if (!response.analytics_disabled || !response.feedback_disabled || !response.updates_disabled
    || response.collectors.some((collector, index) => collector.provider_destination && !(index === 2 && collector.kind === "statsig"))) {
    throw new Error("Codex's effective local settings conflict with the required privacy policy.");
  }
  return response;
}
