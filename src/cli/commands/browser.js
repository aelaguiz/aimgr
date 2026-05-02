import { setBrowserBindingFromCli } from "../../browser/bindings-cli.js";
import { showBrowserBinding } from "../../browser/bindings.js";
import { normalizeLabel } from "../../core/normalize.js";
import { writeJsonFileWithBackup } from "../../io/json-store.js";
import { loadAimgrState } from "../../state/schema.js";
import { sanitizeForStatus } from "../../core/sanitize.js";

export async function handleBrowser(context) {
  const { opts, positional, statePath, homeDir, stdout } = context;
  const subcmd = String(positional[1] ?? "").trim().toLowerCase();
  if (!subcmd) {
    throw new Error("Missing browser subcommand. Usage: aim browser show <label> | aim browser set <label> --mode ...");
  }
  const label = normalizeLabel(positional[2]);
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
