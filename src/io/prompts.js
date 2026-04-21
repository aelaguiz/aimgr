import readline from "node:readline/promises";
import { writeStdout } from "./streams.js";

export async function promptLine(message, { defaultValue } = {}) {
  if (!process.stdin.isTTY) {
    throw new Error(`Cannot prompt for input (stdin is not a TTY). Needed: ${message}`);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const answer = await rl.question(`${message.trim()} `);
      const value = String(answer ?? "").trim();
      if (value.length > 0) return value;
      if (defaultValue !== undefined) return String(defaultValue);
    }
  } finally {
    rl.close();
  }
}

export async function promptRequiredLine(message) {
  if (!process.stdin.isTTY) {
    throw new Error(`Cannot prompt for input (stdin is not a TTY). Needed: ${message}`);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const answer = await rl.question(`${message.trim()} `);
      const value = String(answer ?? "").trim();
      if (value.length > 0) return value;
    }
  } finally {
    rl.close();
  }
}

export function formatMenuPromptSuffix(options) {
  const keys = (Array.isArray(options) ? options : [])
    .map((option) => String(option?.key ?? "").trim())
    .filter(Boolean);
  if (keys.length === 0) return "";
  const numeric = keys.every((key) => /^\d+$/.test(key));
  if (!numeric) {
    return ` (${keys.join("/")})`;
  }
  const sorted = keys.map((key) => Number(key)).toSorted((a, b) => a - b);
  const contiguous = sorted.every((value, index) => index === 0 || value === sorted[index - 1] + 1);
  if (contiguous) {
    return ` (${sorted[0]}-${sorted[sorted.length - 1]})`;
  }
  return ` (${sorted.join("/")})`;
}

export async function promptMenuChoice({
  title,
  options,
  prompt = "Choose:",
  promptLineImpl = promptLine,
  writeImpl = writeStdout,
}) {
  const normalizedOptions = Array.isArray(options) ? options.filter(Boolean) : [];
  if (title) {
    writeImpl(`${title}\n`);
  }
  for (const option of normalizedOptions) {
    writeImpl(`  ${option.key}. ${option.label}\n`);
    const details = Array.isArray(option.details)
      ? option.details
      : typeof option.details === "string" && option.details.trim()
        ? [option.details.trim()]
        : [];
    for (const detail of details) {
      writeImpl(`     ${detail}\n`);
    }
  }
  writeImpl("\n");

  const validKeys = new Set(normalizedOptions.map((option) => String(option.key)));
  const suffix = formatMenuPromptSuffix(normalizedOptions);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const answer = await promptLineImpl(`${prompt}${suffix}`);
    const choice = String(answer ?? "").trim();
    if (validKeys.has(choice)) {
      return choice;
    }
    writeImpl(`Invalid choice: "${choice}". Try again.\n`);
  }
}
