export async function handlePromote(context) {
  const { positional } = context;
  const system = String(positional[1] ?? "").trim().toLowerCase();
  if (!system) {
    throw new Error(
      "Missing promote target. `aim promote` was removed in the Redis cutover; refreshed credentials publish to Redis directly.",
    );
  }
  throw new Error(
    `\`aim promote ${system}\` was removed in the Redis cutover. ` +
      "Login, refresh, capture, import, watch, and tend paths publish the shared Redis credential directly.",
  );
}
