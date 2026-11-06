import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execute = promisify(execFile);

/** The immutable AIM helper calls the pinned upstream configuration and state
 * libraries with outbound traffic denied before their first call. Its private
 * response contains finite path/policy facts, never configuration contents. */
export async function prepareCodexNativeInputs({ artifact, prepared, parsedArgs, env, managed,
  ownedAppServer = false, operation = "initialize", owner = null, forkSource = null, executeImpl = execute } = {}) {
  const request = { operation, artifact_set: artifact.artifactSet, codex_home: prepared.codexHome,
    cwd: parsedArgs.cwd, profile: parsedArgs.profile, config: parsedArgs.config,
    harness: parsedArgs.harness ?? {}, owned_app_server: ownedAppServer,
    strict_config: parsedArgs.strictConfig ?? false,
    ignore_user_config: ["exec", "e"].includes(parsedArgs.command) && parsedArgs.ignoreUserConfig === true,
    ignore_rules: ["exec", "e"].includes(parsedArgs.command) && parsedArgs.ignoreRules === true,
    headless: ["exec", "e", "review"].includes(parsedArgs.command), yolo: parsedArgs.yolo === true,
    oss: parsedArgs.oss === true, local_provider: parsedArgs.localProvider ?? null,
    oss_choice: parsedArgs.ossChoice ?? null,
    explicit_cwd: parsedArgs.cwdOverride != null,
    worktree: parsedArgs.worktree === true && !parsedArgs.inspection,
    owner, fork_source: forkSource,
    saved: !parsedArgs.inspection && ["resume", "fork"].includes(parsedArgs.command) ? {
      fork: parsedArgs.command === "fork", selector: parsedArgs.last ? null : parsedArgs.positionals?.[0] ?? null,
      last: parsedArgs.last === true, all: parsedArgs.all === true,
      include_non_interactive: parsedArgs.optionFacts?.some(option => option.key === "--include-non-interactive") ?? false,
      explicit_cwd: parsedArgs.cwdOverride != null,
    } : null,
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
      encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024 });
    promise.child.stdin.on("error", () => {});
    promise.child.stdin.end(JSON.stringify(request));
    response = JSON.parse((await promise).stdout);
  } catch (error) {
    if (error.stderr?.includes("failed at OSS worktree provider;")) {
      throw new Error(`Codex started without a configured local provider, but the created worktree selects one. Specify --local-provider=lmstudio or --local-provider=ollama with --oss. The worktree was kept at ${parsedArgs.cwd}.`);
    }
    if (error.stderr?.includes("failed at OSS worktree source;")) {
      throw new Error("Codex cannot determine this worktree's fork source before its local provider is selected. Specify --local-provider=lmstudio or --local-provider=ollama with --oss. No worktree was created.");
    }
    // Upstream parse errors may embed the original settings or a secret value.
    throw new Error("Codex could not prepare its local settings and databases. Check the selected native settings and required privacy policy.");
  }
  if (response.schema !== 1 || response.source_revision !== "6ff1e1ca3b30fc8b914720681fcf5fe62e95f856"
    || (operation === "initialize" && response.initialized !== true)
    || !path.isAbsolute(response.cwd ?? "")
    || [response.reads, response.writes, response.database_roots, response.database_files, response.project_cwds ?? [],
      response.skill_roots ?? [], response.system_skill_roots ?? [], response.writable_skill_roots ?? []]
      .some(items => !Array.isArray(items) || items.some(file => typeof file !== "string" || !path.isAbsolute(file)))
    || typeof response.exporters_disabled !== "boolean") {
    throw new Error("Codex returned an invalid native input inventory.");
  }
  if (request.worktree && (!path.isAbsolute(response.worktree_root ?? "") || typeof response.source_untrusted !== "boolean")) {
    throw new Error("Codex returned an invalid native worktree input inventory.");
  }
  if (request.oss && !request.headless && response.oss_choice !== "picker"
    && (typeof response.oss_choice?.provider !== "string" || !response.oss_choice.provider)) {
    throw new Error("Codex returned an invalid local provider choice.");
  }
  if (operation === "fork_source" && (!path.isAbsolute(response.fork_source?.cwd ?? "")
    || !/^[a-f0-9-]{36}$/.test(response.fork_source?.thread_id ?? ""))) throw new Error("Codex could not resolve the requested worktree fork.");
  if (operation === "worktree_owner" && response.owner_thread_id !== null
    && !/^[a-f0-9-]{36}$/.test(response.owner_thread_id ?? "")) throw new Error("Codex returned an invalid worktree owner.");
  if (!response.analytics_disabled || !response.feedback_disabled || !response.updates_disabled
    || !response.exporters_disabled) {
    throw new Error("Codex's effective local settings conflict with the required privacy policy.");
  }
  return response;
}
