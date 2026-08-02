const URL_PATTERN = /\b(?:redis|rediss|http|https|ws|wss):\/\/[^\s<>"'`]+/giu;
const SECRET_ASSIGNMENT_PATTERN = /\b(access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|client[_-]?secret|password|secret|token)\s*([=:])\s*[^\s,;]+/giu;
const BEARER_PATTERN = /\bBearer\s+[^\s,;]+/giu;

function redactUrl(raw) {
  try {
    const parsed = new URL(raw);
    const pathname = parsed.pathname === "/" ? "" : parsed.pathname;
    return `${parsed.protocol}//${parsed.host}${pathname}`;
  } catch {
    return "[redacted-endpoint]";
  }
}

export function redactCliErrorMessage(error) {
  const raw = typeof error?.message === "string" ? error.message : String(error ?? "");
  const message = raw
    .replace(URL_PATTERN, redactUrl)
    .replace(BEARER_PATTERN, "Bearer [redacted]")
    .replace(SECRET_ASSIGNMENT_PATTERN, (_match, key, separator) => `${key}${separator}[redacted]`)
    .replace(/[\r\n\t]+/gu, " ")
    .trim();
  return (message || "Command failed.").slice(0, 2_000);
}

export function formatCliError(error) {
  return `aim: ${redactCliErrorMessage(error)}`;
}
