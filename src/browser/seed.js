import fs from "node:fs";
import path from "node:path";
import { ensureAccountShape } from "./bindings.js";
import { resolveAimBrowserUserDataDir, resolveOpenclawBrowserUserDataDir, resolveOpenclawStateDir } from "./chrome.js";
import { discoverOpenclawBrowserProfiles, formatOpenclawBrowserProfileChoice, openclawBrowserProfileExists, resolveOpenclawBrowserProfileFromInput } from "./openclaw.js";
import { promptRequiredLine } from "../io/prompts.js";
import { ANTHROPIC_PROVIDER, BROWSER_MODE_AGENT_BROWSER, BROWSER_MODE_AIM_PROFILE, BROWSER_MODE_CHROME_PROFILE, OPENAI_CODEX_PROVIDER, SUPPORTED_OAUTH_PROVIDERS } from "../core/constants.js";
import { isObject, normalizeLabel, normalizeProviderId } from "../core/normalize.js";
import { parseExpiresAtToMs, toIsoFromExpiresMs } from "../core/time.js";
import { getAccountBrowserState } from "../state/accounts.js";
import { ensureStateShape } from "../state/schema.js";

export function getCodexCredential(state, label) {
  ensureStateShape(state);
  const byLabel = state.credentials[OPENAI_CODEX_PROVIDER];
  return isObject(byLabel?.[label]) ? byLabel[label] : null;
}

export function getAnthropicCredential(state, label) {
  ensureStateShape(state);
  const byLabel = state.credentials[ANTHROPIC_PROVIDER];
  return isObject(byLabel?.[label]) ? byLabel[label] : null;
}

export function assertNoCodexAccountIdCollisions(state, label, accountId) {
  ensureStateShape(state);
  const byLabel = state.credentials[OPENAI_CODEX_PROVIDER];
  for (const [otherLabel, otherCred] of Object.entries(byLabel)) {
    if (otherLabel === label) continue;
    if (!isObject(otherCred)) continue;
    if (String(otherCred.accountId ?? "") === String(accountId)) {
      throw new Error(
        `Refusing to clobber: accountId=${accountId} is already assigned to label=${otherLabel}. ` +
          `This usually means Chrome profile selection is wrong.`,
      );
    }
  }
}

export function resolveOpenclawProfileIdForCodexLabel(label) {
  return resolveOpenclawProfileIdForProviderLabel(OPENAI_CODEX_PROVIDER, label);
}

export function resolveOpenclawProfileIdForProviderLabel(provider, label) {
  const p = normalizeProviderId(provider);
  if (!p) {
    throw new Error("resolveOpenclawProfileIdForProviderLabel requires provider.");
  }
  return `${p}:${normalizeLabel(label)}`;
}

export function seedAimBrowserProfileFromOpenclaw({ state, label, homeDir, profileId }) {
  const normalizedLabel = normalizeLabel(label);
  const selectedProfileId = String(profileId ?? "").trim();
  if (!selectedProfileId) {
    throw new Error(`Cannot seed AIM browser profile for label=${normalizedLabel} without an OpenClaw profile id.`);
  }

  const openclawStateDir = resolveOpenclawStateDir({ homeDir });
  const sourceUserDataDir = resolveOpenclawBrowserUserDataDir({
    openclawStateDir,
    profileId: selectedProfileId,
  });
  if (!fs.existsSync(sourceUserDataDir)) {
    throw new Error(
      `Cannot seed AIM browser profile for label=${normalizedLabel}: ` +
        `OpenClaw profile "${selectedProfileId}" does not exist under ${path.join(openclawStateDir, "browser")}.`,
    );
  }

  const targetUserDataDir = resolveAimBrowserUserDataDir({ homeDir, label: normalizedLabel });
  if (fs.existsSync(targetUserDataDir)) {
    return { status: "skipped", label: normalizedLabel, profileId: selectedProfileId, userDataDir: targetUserDataDir };
  }

  fs.mkdirSync(path.dirname(targetUserDataDir), { recursive: true });
  fs.cpSync(sourceUserDataDir, targetUserDataDir, {
    recursive: true,
    force: false,
    errorOnExist: true,
  });

  const browser = getAccountBrowserState(state, normalizedLabel, { create: true });
  browser.mode = BROWSER_MODE_AIM_PROFILE;
  browser.seededFromOpenclawProfileId = selectedProfileId;
  browser.seededAt = new Date().toISOString();
  if (Object.hasOwn(browser, "conflictReason")) {
    delete browser.conflictReason;
  }

  return { status: "seeded", label: normalizedLabel, profileId: selectedProfileId, userDataDir: targetUserDataDir };
}

export async function ensureAimBrowserProfileBinding({
  state,
  label,
  homeDir,
  promptLineImpl = promptRequiredLine,
  writeImpl = () => {},
}) {
  ensureStateShape(state);
  const normalizedLabel = normalizeLabel(label);
  const existing = state.accounts[normalizedLabel];
  if (existing && !isObject(existing)) {
    throw new Error(`accounts.${normalizedLabel} must be an object (got ${typeof existing})`);
  }

  const providerRaw = typeof existing?.provider === "string" ? existing.provider.trim() : "";
  const provider = normalizeProviderId(providerRaw || OPENAI_CODEX_PROVIDER);
  if (!SUPPORTED_OAUTH_PROVIDERS.has(provider)) {
    throw new Error(
      `accounts.${normalizedLabel}.provider=${providerRaw || "(missing)"} is not supported. ` +
        `Supported: ${Array.from(SUPPORTED_OAUTH_PROVIDERS.keys()).join(", ")}`,
    );
  }

  state.accounts[normalizedLabel] = {
    ...(existing ? existing : {}),
    provider,
  };
  ensureAccountShape(state.accounts[normalizedLabel], { providerHint: provider });

  const browser = getAccountBrowserState(state, normalizedLabel, { create: true });
  browser.mode = BROWSER_MODE_AIM_PROFILE;
  const targetUserDataDir = resolveAimBrowserUserDataDir({ homeDir, label: normalizedLabel });
  if (typeof browser.conflictReason === "string" && browser.conflictReason.trim()) {
    throw new Error(
      `AIM browser profile for label=${normalizedLabel} is blocked by conflict: ${browser.conflictReason}. ` +
        "Fix the browser/account mismatch before retrying.",
    );
  }
  if (fs.existsSync(targetUserDataDir)) {
    return targetUserDataDir;
  }

  const openclawStateDir = resolveOpenclawStateDir({ homeDir });
  const storedSeedSource =
    typeof browser.seededFromOpenclawProfileId === "string" ? browser.seededFromOpenclawProfileId.trim() : "";
  if (storedSeedSource) {
    if (openclawBrowserProfileExists({ openclawStateDir, profileId: storedSeedSource })) {
      seedAimBrowserProfileFromOpenclaw({ state, label: normalizedLabel, homeDir, profileId: storedSeedSource });
      return targetUserDataDir;
    }
    writeImpl(
      `Stored migration source "${storedSeedSource}" for label "${normalizedLabel}" was not found under:\n` +
        `  ${path.join(openclawStateDir, "browser")}\n` +
        "Pick a valid OpenClaw browser profile to seed the AIM-owned browser dir.\n\n",
    );
  }

  if (!fs.existsSync(openclawStateDir)) {
    throw new Error(
      "AIM browser profile is missing and no OpenClaw migration source is available on this host. " +
        `Expected OpenClaw state under: ${openclawStateDir}. ` +
        "Run on the Mac host or create the AIM-owned browser dir before retrying.",
    );
  }

  const profiles = discoverOpenclawBrowserProfiles({ openclawStateDir });
  if (profiles.length > 0) {
    writeImpl(`OpenClaw browser profiles available for one-time AIM seeding (from ${path.join(openclawStateDir, "browser")}):\n`);
    profiles.forEach((profile, idx) => {
      writeImpl(`  ${idx + 1}) ${formatOpenclawBrowserProfileChoice(profile)}\n`);
    });
    writeImpl("\n");

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const answer = await promptLineImpl(
        `Pick OpenClaw browser profile to seed AIM label "${normalizedLabel}" (number 1-${profiles.length}, or type the profile id):`,
      );
      const profileId = resolveOpenclawBrowserProfileFromInput({ input: answer, profiles });
      if (!profileId) {
        writeImpl(`Invalid choice: "${answer}". Try again.\n`);
        continue;
      }
      if (!openclawBrowserProfileExists({ openclawStateDir, profileId })) {
        writeImpl(
          `That profile doesn't exist under ${path.join(openclawStateDir, "browser")} (${profileId}). ` +
            "Refusing to guess; try again.\n",
        );
        continue;
      }

      seedAimBrowserProfileFromOpenclaw({ state, label: normalizedLabel, homeDir, profileId });
      return targetUserDataDir;
    }
  }

  if (profiles.length === 0) {
    throw new Error(
      "No OpenClaw browser profiles discovered to seed the AIM-owned browser dir. " +
        `Expected at least one profile under: ${path.join(openclawStateDir, "browser")}. ` +
        "Start OpenClaw browser management to create profiles, or use manual-callback mode for this label.",
    );
  }

  // Unreachable: either we select from discovered profiles or we throw.
}

export function getRepairBindingCommand(label) {
  return `aim browser set ${label} --mode ...`;
}

export function getMissingBindingActionForLabel(label) {
  return {
    actionRequired: "run_aim_browser_set",
    repairCommand: getRepairBindingCommand(label),
  };
}

export function getMissingBrowserActionForBinding({ label, bindingMode }) {
  if (bindingMode === BROWSER_MODE_AIM_PROFILE) {
    return {
      actionRequired: "run_aim_label",
      repairCommand: `aim ${label}`,
    };
  }
  return getMissingBindingActionForLabel(label);
}

export function assertMappedBrowserBindingExists({ label, binding }) {
  if (!binding) {
    throw new Error(
      `Browser-managed reauth for label=${label} requires an explicit browser binding. ` +
        `Repair it with \`${getRepairBindingCommand(label)}\`.`,
    );
  }

  if (binding.mode === BROWSER_MODE_CHROME_PROFILE) {
    if (!binding.userDataDir) {
      throw new Error(
        `Mapped Chrome binding for label=${label} is incomplete. Repair it with ` +
          `\`aim browser set ${label} --mode chrome-profile --user-data-dir <abs-path>\`.`,
      );
    }
    if (!fs.existsSync(binding.userDataDir)) {
      throw new Error(
        `Mapped Chrome profile for label=${label} is missing: ${binding.userDataDir}. ` +
          `Repair it with \`aim browser set ${label} --mode chrome-profile --user-data-dir <abs-path>\`.`,
      );
    }
    return binding;
  }

  if (binding.mode === BROWSER_MODE_AGENT_BROWSER) {
    if (!binding.agentBrowserProfile || !binding.agentBrowserSession) {
      throw new Error(
        `Mapped agent-browser binding for label=${label} is incomplete. Repair it with ` +
          `\`aim browser set ${label} --mode agent-browser --profile <abs-path> --session <name>\`.`,
      );
    }
    if (!fs.existsSync(binding.agentBrowserProfile)) {
      throw new Error(
        `Mapped agent-browser profile for label=${label} is missing: ${binding.agentBrowserProfile}. ` +
          `Repair it with \`aim browser set ${label} --mode agent-browser --profile <abs-path> --session <name>\`.`,
      );
    }
    return binding;
  }

  return binding;
}
