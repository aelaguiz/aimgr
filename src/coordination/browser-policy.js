export function buildSharedBrowserPolicy(browser) {
  if (!browser || typeof browser !== "object" || Array.isArray(browser)) return {};
  return {
    ...(typeof browser.mode === "string" ? { mode: browser.mode } : {}),
    ...(typeof browser.seededFromOpenclawProfileId === "string"
      ? { seededFromOpenclawProfileId: browser.seededFromOpenclawProfileId }
      : {}),
    ...(typeof browser.seededAt === "string" ? { seededAt: browser.seededAt } : {}),
    ...(typeof browser.verifiedAt === "string" ? { verifiedAt: browser.verifiedAt } : {}),
    ...(typeof browser.conflictReason === "string" ? { conflictReason: browser.conflictReason } : {}),
  };
}

export function buildLocalBrowserBinding(browser) {
  if (!browser || typeof browser !== "object" || Array.isArray(browser)) return null;
  const binding = {
    ...(typeof browser.userDataDir === "string" ? { userDataDir: browser.userDataDir } : {}),
    ...(typeof browser.profileDirectory === "string" ? { profileDirectory: browser.profileDirectory } : {}),
    ...(typeof browser.agentBrowserProfile === "string" ? { agentBrowserProfile: browser.agentBrowserProfile } : {}),
    ...(typeof browser.agentBrowserSession === "string" ? { agentBrowserSession: browser.agentBrowserSession } : {}),
  };
  return Object.keys(binding).length > 0 ? binding : null;
}

export function buildLocalBrowserBindingsFromState(state) {
  const bindings = {};
  for (const [label, account] of Object.entries(state?.accounts ?? {})) {
    const binding = buildLocalBrowserBinding(account?.browser);
    if (binding) bindings[label] = binding;
  }
  return bindings;
}
