import { setBrowserBindingFromCli } from "../../browser/bindings-cli.js";
import { showBrowserBinding } from "../../browser/bindings.js";
import { readAimgrConfig } from "../../config/aimgr-config.js";
import { buildLocalBrowserBindingsFromState, buildSharedBrowserPolicy } from "../../coordination/browser-policy.js";
import { buildLocalMachineInfo } from "../../coordination/machine.js";
import { closeRedisStore, connectRedisStore, publishLabel, readSnapshot, registerMachine } from "../../coordination/redis-store.js";
import { buildCoordinationView, findLabelRecord } from "../../coordination/snapshot.js";
import { normalizeLabel } from "../../core/normalize.js";
import { writeJsonFileWithBackup } from "../../io/json-store.js";
import { loadLocalState, writeLocalState } from "../../state/local-state.js";
import { loadAimgrState } from "../../state/schema.js";
import { sanitizeForStatus } from "../../core/sanitize.js";

async function handleRedisBrowser(context, { subcmd, label }) {
  const { opts, homeDir, stdout, nowMs } = context;
  const redis = readAimgrConfig({ homeDir }).config.redis;
  if (!redis.url) return false;
  const connectImpl = context.connectRedisStoreImpl ?? connectRedisStore;
  const store = await connectImpl({ url: redis.url, keyPrefix: redis.keyPrefix });
  try {
    const machine = buildLocalMachineInfo({ homeDir, now: new Date(nowMs) });
    await registerMachine(store, machine);
    const snapshot = await readSnapshot(store);
    const localState = loadLocalState({ homeDir });
    const state = buildCoordinationView(snapshot, { machineId: machine.machineId, localState });
    const currentLabel = findLabelRecord(snapshot, { provider: opts.provider ?? "openai-codex", label })
      ?? (snapshot.labels ?? []).find((record) => record.label === label);
    if (subcmd === "show") {
      const shown = showBrowserBinding({ state, label, homeDir });
      stdout.write(`${JSON.stringify(sanitizeForStatus({ ...shown, source: "redis" }), null, 2)}\n`);
      return true;
    }
    if (!currentLabel) {
      throw new Error(`Cannot set browser policy before Redis label exists: ${label}. Run \`aim login ${label}\` first.`);
    }
    const updated = setBrowserBindingFromCli({ state, label, opts });
    const account = state.accounts[label];
    writeLocalState({
      homeDir,
      localState: {
        ...localState,
        browserBindings: buildLocalBrowserBindingsFromState(state),
      },
    });
    const published = await publishLabel(store, {
      expectedVersion: currentLabel.version,
      machineId: machine.machineId,
      observedAt: new Date(nowMs).toISOString(),
      labelRecord: {
        ...currentLabel,
        expect: account.expect ?? {},
        reauth: account.reauth ?? {},
        browser: buildSharedBrowserPolicy(account.browser),
        pool: account.pool ?? { enabled: true },
      },
    });
    stdout.write(
      `${JSON.stringify(
        sanitizeForStatus({
          ok: published.ok,
          browser: {
            label,
            source: "redis",
            updated,
            current: showBrowserBinding({ state, label, homeDir }),
            published,
          },
        }),
        null,
        2,
      )}\n`,
    );
    return true;
  } finally {
    await closeRedisStore(store);
  }
}

export async function handleBrowser(context) {
  const { opts, positional, statePath, homeDir, stdout } = context;
  const subcmd = String(positional[1] ?? "").trim().toLowerCase();
  if (!subcmd) {
    throw new Error("Missing browser subcommand. Usage: aim browser show <label> | aim browser set <label> --mode ...");
  }
  const label = normalizeLabel(positional[2]);
  if (await handleRedisBrowser(context, { subcmd, label })) {
    return;
  }
  const state = loadAimgrState(statePath);
  if (subcmd === "show") {
    const shown = showBrowserBinding({ state, label, homeDir });
    stdout.write(`${JSON.stringify(sanitizeForStatus(shown), null, 2)}\n`);
    return;
  }
  if (subcmd === "set") {
    const updated = setBrowserBindingFromCli({ state, label, opts });
    writeJsonFileWithBackup(statePath, state);
    stdout.write(
      `${JSON.stringify(
        sanitizeForStatus({
          ok: true,
          browser: {
            label,
            updated,
            current: showBrowserBinding({ state, label, homeDir }),
          },
        }),
        null,
        2,
      )}\n`,
    );
    return;
  }
  throw new Error(`Unsupported browser subcommand: ${subcmd} (supported: show, set).`);
}
