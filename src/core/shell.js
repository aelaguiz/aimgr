export function formatBrowserLaunchFailure(opened) {
  const reason = String(opened?.reason ?? "unknown").trim() || "unknown";
  const detail = String(opened?.error ?? "").trim();
  return detail ? `${reason}: ${detail}` : reason;
}
