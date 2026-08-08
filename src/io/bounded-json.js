const DEFAULT_MAX_BYTES = 32 * 1024;

export async function readBoundedJsonDocument(stdin, {
  maxBytes = DEFAULT_MAX_BYTES,
  errorMessage = "Invalid structured stdin request.",
} = {}) {
  if (
    stdin?.isTTY === true
    || !stdin
    || (
      typeof stdin[Symbol.asyncIterator] !== "function"
      && typeof stdin.on !== "function"
    )
  ) {
    throw new Error(errorMessage);
  }
  const chunks = [];
  let bytes = 0;
  try {
    for await (const chunk of stdin) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maxBytes) {
        throw new Error(errorMessage);
      }
      chunks.push(buffer);
    }
  } catch {
    throw new Error(errorMessage);
  }
  if (bytes === 0) throw new Error(errorMessage);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error(errorMessage);
  }
}
