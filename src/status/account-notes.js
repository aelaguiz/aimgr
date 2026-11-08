// Notes are advisory text. Quote them so newlines and terminal controls cannot
// impersonate another account in human-readable output.
export function formatAccountNote(record) {
  const text = JSON.stringify(record.note).replace(/[\u0080-\u009f]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return `${record.provider} / ${record.label}: ${text}`;
}

export function renderAccountNotes(notes, { heading = "ACCOUNT NOTES" } = {}) {
  if (notes === null || notes === undefined) return `${heading}\nUnavailable (Redis could not be read).\n`;
  if (notes.length === 0) return "";
  return `${heading}\n${notes.map(formatAccountNote).join("\n")}\n`;
}

export function accountNoteFor(notes, provider, label) {
  return notes?.find((entry) => entry.provider === provider && entry.label === label)?.note ?? null;
}

export async function readNotesForCommand(context) {
  const { loadRedisRuntime, closeRedisRuntime } = await import("../coordination/runtime.js");
  let runtime;
  try {
    runtime = await loadRedisRuntime({ homeDir: context.homeDir, connectRedisStoreImpl: context.connectRedisStoreImpl });
    return runtime.accountNotes;
  } catch {
    return null;
  } finally {
    if (runtime) await closeRedisRuntime(runtime).catch(() => {});
  }
}

export function notesForAccounts(notes, provider, accounts) {
  if (notes === null) return null;
  const labels = new Set(accounts.map((account) => account.label));
  return notes.filter((entry) => entry.provider === provider && labels.has(entry.label));
}
