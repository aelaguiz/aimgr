import { OPENAI_CODEX_PROVIDER } from "../../core/constants.js";
import { isInteractiveTerminal } from "../tty.js";
import { normalizeLabel } from "../../core/normalize.js";
import { writeJsonFileWithBackup } from "../../io/json-store.js";
import { resolveAgentsRepoRoot } from "../../io/paths.js";
import { performLabelMaintenance } from "../../panels/maintenance.js";
import { ensureStateShape, loadAimgrState } from "../../state/schema.js";
import { sanitizeForStatus } from "../../core/sanitize.js";
import { createManualCallbackStdioProtocol, writeJsonLine } from "../manual-callback-stdio.js";

export async function handleLogin(context) {
  const { opts, positional, statePath, homeDir, shorthandLabel, stdin, stdout, env, setExitCode, repoRoot, promptLineImpl, promptImpl, openUrlImpl, readOpenclawBindingsFromConfigImpl, readOpenclawAgentsListFromConfigImpl, runLabelControlPanelImpl, loginOpenAICodexImpl, refreshOpenAICodexImpl, refreshAnthropicImpl } = context;
  const rawLabel = shorthandLabel ?? positional[1];
  const writeImpl = (chunk) => stdout.write(chunk);
  if (opts.manualCallbackStdio) {
    let label = null;
    let state = null;
    try {
      label = normalizeLabel(rawLabel);
      state = loadAimgrState(statePath);
      ensureStateShape(state);
      const manualCallbackAutomation = createManualCallbackStdioProtocol({
        stdin,
        stdout,
        label,
        provider: OPENAI_CODEX_PROVIDER,
      });
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
        manualCallbackAutomation,
        writeImpl: () => {},
      });
      writeJsonFileWithBackup(statePath, state);
      writeJsonLine(stdout, sanitizeForStatus({ type: "result", ...result }));
      return;
    } catch (err) {
      if (state) {
        writeJsonFileWithBackup(statePath, state);
      }
      writeJsonLine(
        stdout,
        sanitizeForStatus({
          type: "error",
          ok: false,
          ...(label ? { label } : {}),
          error: String(err?.message ?? err),
        }),
      );
      setExitCode(1);
      return;
    }
  }

  const label = normalizeLabel(rawLabel);
  const state = loadAimgrState(statePath);
  ensureStateShape(state);
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
