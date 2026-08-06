import { handleHarnessTarget } from "./harness-target.js";

export async function handlePrime(context) {
  return handleHarnessTarget(context, "prime");
}
