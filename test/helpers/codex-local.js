import path from "node:path";
import { saveLocalCodexLogin } from "../../src/credentials/codex-local.js";
import { codexAccountPaths } from "../../src/privacy/codex-account-state.js";
import { loadLocalState } from "../../src/state/local-state.js";

export const CODEX_TEST_ENVIRONMENT = Object.freeze({ binding: "c".repeat(64) });
export const readCodexTestEnvironment = () => CODEX_TEST_ENVIRONMENT;

export function localCodexFixture(homeDir, accountId, credential) {
  return saveLocalCodexLogin({ homeDir, accountId, environment: CODEX_TEST_ENVIRONMENT }, {
    ...credential, refresh: `LOCAL_${credential.refresh}`,
  });
}

export function activeCodexAuthFile(homeDir) {
  const accountId = loadLocalState({ homeDir }).targets.codexCli.expectedAccountId;
  return path.join(codexAccountPaths({ homeDir, accountId, environment: CODEX_TEST_ENVIRONMENT }).accountRoot, "auth.json");
}
