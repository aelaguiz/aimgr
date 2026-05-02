export async function handlePin(context) {
  throw new Error("`aim pin` was removed. Use `aim rebalance openclaw` for selection and `aim apply` only to materialize stored assignments.");
}

export async function handleAutopin(context) {
  const { positional } = context;
  const system = String(positional[1] ?? "").trim().toLowerCase();
  if (!system) {
    throw new Error('Missing autopin target. `aim autopin openclaw` was removed; use `aim rebalance openclaw`.');
  }
  throw new Error("`aim autopin openclaw` was removed. Use `aim rebalance openclaw`.");
}
