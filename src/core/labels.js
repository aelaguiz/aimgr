export function normalizeLabel(input) {
  const label = String(input ?? "").trim().toLowerCase();
  if (!label) {
    throw new Error("Missing label.");
  }
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(label)) {
    throw new Error(
      `Invalid label: ${label}. Use lowercase letters, numbers, '_' and '-' (e.g. boss, coder2).`,
    );
  }
  const reserved = new Set([
    "status",
    "login",
    "pin",
    "autopin",
    "rebalance",
    "apply",
    "sync",
    "promote",
    "hermes",
    "codex",
    "browser",
    "internal",
    "use",
    "show",
    "set",
    "help",
  ]);
  if (reserved.has(label)) {
    throw new Error(`Refusing label=${label} (reserved CLI word). Pick a different label (e.g. boss, coder2).`);
  }
  if (label === "default") {
    throw new Error("Refusing label=default (we never want *:default in steady state).");
  }
  return label;
}

export function normalizeAgentId(input) {
  const agentId = String(input ?? "").trim();
  if (!agentId) {
    throw new Error("Missing OpenClaw agent id.");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(agentId)) {
    throw new Error(`Invalid OpenClaw agent id: ${agentId}`);
  }
  return agentId;
}

export function normalizeHermesHomeId(input) {
  const homeId = String(input ?? "").trim();
  if (!homeId) {
    throw new Error("Missing Hermes home id.");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(homeId)) {
    throw new Error(`Invalid Hermes home id: ${homeId}`);
  }
  return homeId;
}
