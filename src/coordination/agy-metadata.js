import { isAgyLabel } from "../credentials/agy-local.js";

export async function readAgyAccountMetadata(store) {
  const labels = await store.client.sMembers(store.keys.agyAccountLabels());
  if (!labels.every(isAgyLabel)) throw new Error("Antigravity roster contains an invalid label.");
  return labels.sort().map((label) => ({ label }));
}

export async function ensureAgyAccountMetadata(store, { label }) {
  if (!isAgyLabel(label)) throw new Error("Antigravity roster requires a valid label.");
  await store.client.sAdd(store.keys.agyAccountLabels(), label);
}
