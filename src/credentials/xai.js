import { XAI_PROVIDER } from "../core/constants.js";
import { isObject } from "../core/normalize.js";
import { ensureStateShape } from "../state/schema.js";

export function getXaiCredential(state, label) {
  ensureStateShape(state);
  const byLabel = state.credentials[XAI_PROVIDER];
  return isObject(byLabel?.[label]) ? byLabel[label] : null;
}

export function persistXaiCredentialForLabel({ state, label, credential }) {
  ensureStateShape(state);
  state.credentials[XAI_PROVIDER][label] = {
    access: credential.access,
    refresh: credential.refresh,
    expiresAt: credential.expiresAt,
    emailAddress: credential.emailAddress,
  };
  return state.credentials[XAI_PROVIDER][label];
}
