import { handleHarnessTarget } from "./harness-target.js";

export async function handlePi(context) {
  return handleHarnessTarget(context, "pi");
}
