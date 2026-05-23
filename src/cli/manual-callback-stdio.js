import readline from "node:readline/promises";

export function writeJsonLine(stdout, value) {
  stdout.write(`${JSON.stringify(value)}\n`);
}

export function parseManualCallbackStdioInput(input) {
  const raw = String(input ?? "").trim();
  if (!raw) {
    throw new Error("Missing callback URL on stdin.");
  }

  if (raw.startsWith("{")) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Invalid manual callback stdin JSON: ${String(err?.message ?? err)}`);
    }
    const callbackUrl =
      typeof parsed?.url === "string" && parsed.url.trim()
        ? parsed.url.trim()
        : typeof parsed?.callbackUrl === "string" && parsed.callbackUrl.trim()
          ? parsed.callbackUrl.trim()
          : "";
    if (!callbackUrl) {
      throw new Error("Manual callback stdin JSON must include url or callbackUrl.");
    }
    return callbackUrl;
  }

  return raw;
}

export async function readNonEmptyLineFromStdin(stdin) {
  if (!stdin || typeof stdin[Symbol.asyncIterator] !== "function") {
    throw new Error("Cannot read callback URL from stdin.");
  }
  const rl = readline.createInterface({ input: stdin, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const value = String(line ?? "").trim();
      if (value) return value;
    }
  } finally {
    rl.close();
  }
  throw new Error("Missing callback URL on stdin.");
}

export function createManualCallbackStdioProtocol({ stdin, stdout, label, provider }) {
  let callbackInputPromise = null;
  const readCallbackUrl = async () => {
    callbackInputPromise ??= readNonEmptyLineFromStdin(stdin).then(parseManualCallbackStdioInput);
    return await callbackInputPromise;
  };

  return {
    emitAuthUrl: ({ url }) => {
      writeJsonLine(stdout, {
        type: "auth_url",
        label,
        provider,
        url,
      });
    },
    readCallbackUrl,
  };
}
