export async function handleSync(context) {
  const { positional } = context;
  const system = String(positional[1] ?? "").trim().toLowerCase();
  if (!system) {
    throw new Error(
      "Missing sync target. `aim sync` was removed in the Redis cutover. Use `aim redis migrate ...` for one-time import and Redis-backed target commands for runtime work.",
    );
  }
  throw new Error(
    `\`aim sync ${system}\` was removed in the Redis cutover. ` +
      "Use `aim redis migrate collect|plan|apply` for one-time legacy import; normal runtime commands now read Redis directly.",
  );
}
