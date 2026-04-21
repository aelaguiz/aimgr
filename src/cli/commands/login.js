import { isInteractiveTerminal } from "../tty.js";
import { normalizeLabel } from "../../core/normalize.js";
import { writeJsonFileWithBackup } from "../../io/json-store.js";
import { resolveAgentsRepoRoot } from "../../io/paths.js";
import { performLabelMaintenance } from "../../panels/maintenance.js";
import { ensureStateShape, loadAimgrState } from "../../state/schema.js";
import { sanitizeForStatus } from "../../core/sanitize.js";

export async function handleLogin(context) {
  const { positional, statePath, homeDir, shorthandLabel, stdin, stdout, env, repoRoot, promptLineImpl, promptImpl, openUrlImpl, readOpenclawBindingsFromConfigImpl, readOpenclawAgentsListFromConfigImpl, runLabelControlPanelImpl, loginOpenAICodexImpl, refreshOpenAICodexImpl, refreshAnthropicImpl } = context;
  const label = normalizeLabel(shorthandLabel ?? positional[1]);
  const state = loadAimgrState(statePath);
  ensureStateShape(state);
  const writeImpl = (chunk) => stdout.write(chunk);
  if (shorthandLabel && isInteractiveTerminal({ stdin, stdout })) {
    await runLabelControlPanelImpl({
      statePath,
      state,
      label,
      homeDir,
      repoRoot: resolveAgentsRepoRoot({ repoRoot, env }),
      promptLineImpl,
      promptImpl,
      openUrlImpl,
      readOpenclawBindingsFromConfigImpl,
      readOpenclawAgentsListFromConfigImpl,
      loginOpenAICodexImpl,
        refreshOpenAICodexImpl,
        refreshAnthropicImpl,
        writeImpl,
      });
    return;
  }

  try {
    const result = await performLabelMaintenance({
      state,
      label,
      homeDir,
      promptLineImpl,
      promptImpl,
      openUrlImpl,
      loginOpenAICodexImpl,
        refreshOpenAICodexImpl,
        refreshAnthropicImpl,
        writeImpl,
      });
    writeJsonFileWithBackup(statePath, state);
    stdout.write(
      `${JSON.stringify(
        sanitizeForStatus(result),
        null,
        2,
      )}\n`,
    );
    return;
  } catch (err) {
    writeJsonFileWithBackup(statePath, state);
    throw err;
  }
}
