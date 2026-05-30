export async function handleApply(context) {
  throw new Error(
    "`aim apply` was removed in the Redis cutover. Use `aim rebalance openclaw`; Redis is now the only shared credential source.",
  );
}
