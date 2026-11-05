const CODEX_PLANS = new Set([
  "free", "go", "plus", "pro", "prolite", "promax", "team", "business",
  "self_serve_business_prolite", "self_serve_business_usage_based",
  "enterprise", "hc", "ent26", "enterprise_cbp_automation", "enterprise_cbp_usage_based",
  "edu", "education", "edu_plus", "edu_pro", "sci", "sci_plus",
]);

export function normalizeCodexPlan(value) {
  const match = typeof value === "string" ? value.trim().toLowerCase().match(/^([a-z0-9_]+)(?: \(\$[0-9.]+\))?$/) : null;
  return match && CODEX_PLANS.has(match[1]) ? match[1] : null;
}
