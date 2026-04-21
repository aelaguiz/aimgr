import path from "node:path";
import { normalizeBrowserBindingMode, normalizeInteractiveOAuthMode, setBrowserBinding } from "./bindings.js";
import { BROWSER_MODE_AGENT_BROWSER, BROWSER_MODE_AIM_PROFILE, BROWSER_MODE_CHROME_PROFILE, REAUTH_MODE_MANUAL_CALLBACK } from "../core/constants.js";

export function assertNoUnexpectedBrowserSetOptions(mode, opts) {
  if (mode === REAUTH_MODE_MANUAL_CALLBACK) {
    if (opts.seedFromOpenclaw || opts.userDataDir || opts.profileDirectory || opts.profile || opts.session) {
      throw new Error("`aim browser set --mode manual-callback` does not accept browser path/session flags.");
    }
    return;
  }
  if (mode === BROWSER_MODE_AIM_PROFILE) {
    if (opts.userDataDir || opts.profileDirectory || opts.profile || opts.session) {
      throw new Error("`aim browser set --mode aim-profile` only supports optional --seed-from-openclaw <profileId>.");
    }
    return;
  }
  if (mode === BROWSER_MODE_CHROME_PROFILE) {
    if (opts.seedFromOpenclaw || opts.profile || opts.session) {
      throw new Error(
        "`aim browser set --mode chrome-profile` only supports --user-data-dir <abs-path> and optional --profile-directory <name>.",
      );
    }
    return;
  }
  if (mode === BROWSER_MODE_AGENT_BROWSER && (opts.seedFromOpenclaw || opts.userDataDir)) {
    throw new Error("`aim browser set --mode agent-browser` requires --profile <abs-path> and --session <name> only.");
  }
}

export function setBrowserBindingFromCli({ state, label, opts }) {
  const requestedModeRaw = String(opts.mode ?? "").trim();
  if (!requestedModeRaw) {
    throw new Error(
      "Missing --mode for `aim browser set`. Supported: aim-profile, chrome-profile, agent-browser, manual-callback.",
    );
  }

  if (requestedModeRaw === "generic-chrome") {
    throw new Error(
      "Unsupported browser mode: generic-chrome. Use `--mode chrome-profile --user-data-dir <abs-path>` instead.",
    );
  }

  const requestedReauthMode = normalizeInteractiveOAuthMode(requestedModeRaw);
  if (requestedReauthMode === REAUTH_MODE_MANUAL_CALLBACK) {
    assertNoUnexpectedBrowserSetOptions(REAUTH_MODE_MANUAL_CALLBACK, opts);
    return setBrowserBinding({ state, label, mode: REAUTH_MODE_MANUAL_CALLBACK });
  }

  const bindingMode = normalizeBrowserBindingMode(requestedModeRaw);
  if (!bindingMode) {
    throw new Error(
      `Unsupported browser mode: ${requestedModeRaw}. Supported: aim-profile, chrome-profile, agent-browser, manual-callback.`,
    );
  }

  assertNoUnexpectedBrowserSetOptions(bindingMode, opts);
  if (bindingMode === BROWSER_MODE_AIM_PROFILE) {
    return setBrowserBinding({
      state,
      label,
      mode: BROWSER_MODE_AIM_PROFILE,
      seedFromOpenclaw: opts.seedFromOpenclaw,
    });
  }
  if (bindingMode === BROWSER_MODE_CHROME_PROFILE) {
    if (!opts.userDataDir) {
      throw new Error("`aim browser set --mode chrome-profile` requires --user-data-dir <abs-path>.");
    }
    return setBrowserBinding({
      state,
      label,
      mode: BROWSER_MODE_CHROME_PROFILE,
      userDataDir: opts.userDataDir,
      profileDirectory: opts.profileDirectory,
    });
  }
  if (!opts.profile || !opts.session) {
    throw new Error("`aim browser set --mode agent-browser` requires --profile <abs-path> and --session <name>.");
  }
  return setBrowserBinding({
    state,
    label,
    mode: BROWSER_MODE_AGENT_BROWSER,
    agentBrowserProfile: opts.profile,
    agentBrowserSession: opts.session,
  });
}
