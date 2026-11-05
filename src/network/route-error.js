/** Route failure is separate from provider authentication/application errors. */
export class AccountRouteError extends Error {
  constructor(code, { label, profileRef, cause, provider = "anthropic" } = {}) {
    const client = provider === "openai-codex" ? "Codex" : "Claude";
    const detail = code === "proxy_unavailable" ? `assigned proxy is unavailable. ${client} cannot start or continue. Repair the proxy/tunnel, then explicitly retry or resume`
      : code === "native_proxy_unavailable" ? `native proxy is unavailable. ${client} cannot start. Repair the proxy installation, then explicitly retry or resume`
      : code === "proxy_exit_mismatch" ? "assigned proxy has an unexpected public IP. Repair the binding before resuming"
      : code.replaceAll("_", " ");
    super(`${client}${label ? ` ${label}` : ""}: ${detail}${profileRef ? ` (${profileRef})` : ""}.`, { cause });
    this.name = `${client}RouteError`;
    Object.assign(this, { code, label, profileRef, provider });
  }
}

export class CodexRouteError extends AccountRouteError {
  constructor(code, options) { super(code, { ...options, provider: "openai-codex" }); }
}
