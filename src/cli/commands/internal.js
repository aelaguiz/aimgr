export async function handleInternal(context) {
  const { positional } = context;
  const subcmd = String(positional[1] ?? "").trim().toLowerCase();
  if (!subcmd) {
    throw new Error("Missing internal subcommand.");
  }
  if (subcmd === "apply-codex-promotion" || subcmd === "apply-claude-promotion") {
    throw new Error(
      `\`aim internal ${subcmd}\` was removed in the Redis cutover. ` +
        "There is no file-authority promotion receiver after Redis becomes the shared credential source.",
    );
  }
  throw new Error(`Unsupported internal subcommand: ${subcmd}.`);
}
