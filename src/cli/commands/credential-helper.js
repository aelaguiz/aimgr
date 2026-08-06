import { isObject, normalizeLabel } from "../../core/normalize.js";
import { closeRedisRuntime, loadRedisRuntime } from "../../coordination/runtime.js";
import {
  HARNESS_CREDENTIAL_ERROR_DETAILS,
  HARNESS_CREDENTIAL_SCHEMA_VERSION,
  HarnessCredentialError,
  resolveHarnessAccessCredential,
} from "../../credentials/harness-access.js";

const MAX_REQUEST_BYTES = 8 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const HELPER_ORDINARY_DEADLINE_MS = 5_000;
const HELPER_TOTAL_DEADLINE_MS = 40_000;
const ALLOWED_REQUEST_KEYS = new Set([
  "schemaVersion",
  "operation",
  "provider",
  "binding",
  "expectedIdentityFingerprint",
  "rejectedCredentialVersion",
]);
const IDENTITY_FINGERPRINT_PATTERN = /^aimgr-id-v1:[A-Za-z0-9_-]{43}$/;

function protocolError() {
  return new HarnessCredentialError("protocol_mismatch");
}

function readBoundedStdin(stdin, { signal } = {}) {
  if (stdin?.isTTY === true || !stdin || typeof stdin.on !== "function") {
    return Promise.reject(protocolError());
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const cleanup = () => {
      stdin.removeListener?.("data", onData);
      stdin.removeListener?.("end", onEnd);
      stdin.removeListener?.("error", onError);
      signal?.removeEventListener?.("abort", onAbort);
    };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const onData = (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > MAX_REQUEST_BYTES) {
        stdin.pause?.();
        finish(reject, protocolError());
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () => {
      if (bytes === 0) finish(reject, protocolError());
      else finish(resolve, Buffer.concat(chunks).toString("utf8"));
    };
    const onError = () => finish(reject, protocolError());
    const onAbort = () => finish(reject, new HarnessCredentialError("helper_timeout"));
    stdin.on("data", onData);
    stdin.once("end", onEnd);
    stdin.once("error", onError);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener?.("abort", onAbort, { once: true });
    stdin.resume?.();
  });
}

export function parseCredentialHelperRequest(raw) {
  let request;
  try {
    request = JSON.parse(raw);
  } catch {
    throw protocolError();
  }
  if (!isObject(request) || Object.keys(request).some((key) => !ALLOWED_REQUEST_KEYS.has(key))) {
    throw protocolError();
  }
  const provider = typeof request.provider === "string" ? request.provider : "";
  const binding = typeof request.binding === "string" ? request.binding : "";
  const expectedIdentityFingerprint = typeof request.expectedIdentityFingerprint === "string"
    ? request.expectedIdentityFingerprint
    : "";
  let normalizedBinding = null;
  try {
    normalizedBinding = normalizeLabel(binding);
  } catch {
    throw protocolError();
  }
  if (
    request.schemaVersion !== HARNESS_CREDENTIAL_SCHEMA_VERSION
    || request.operation !== "resolve"
    || (provider !== "openai-codex" && provider !== "anthropic")
    || normalizedBinding !== binding
    || !IDENTITY_FINGERPRINT_PATTERN.test(expectedIdentityFingerprint)
    || (
      request.rejectedCredentialVersion !== undefined
      && (!Number.isSafeInteger(request.rejectedCredentialVersion) || request.rejectedCredentialVersion < 0)
    )
  ) {
    throw protocolError();
  }
  return Object.freeze({
    provider,
    binding: normalizedBinding,
    expectedIdentityFingerprint,
    ...(request.rejectedCredentialVersion !== undefined
      ? { rejectedCredentialVersion: request.rejectedCredentialVersion }
      : {}),
  });
}

function fixedFailure(error) {
  const code = error instanceof HarnessCredentialError
    && Object.hasOwn(HARNESS_CREDENTIAL_ERROR_DETAILS, error.code)
    ? error.code
    : error?.name === "AbortError"
      ? "helper_timeout"
      : "coordination_unavailable";
  const detail = HARNESS_CREDENTIAL_ERROR_DETAILS[code];
  return {
    schemaVersion: HARNESS_CREDENTIAL_SCHEMA_VERSION,
    ok: false,
    code,
    message: detail.message,
    action: detail.action,
  };
}

function writeProtocolObject(stdout, value) {
  const json = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(json) > MAX_RESPONSE_BYTES) {
    throw new HarnessCredentialError("protocol_mismatch");
  }
  stdout.write(json);
}

async function loadHelperRuntimeWithinDeadline(options, { signal } = {}) {
  let abandoned = false;
  let timeout = null;
  let onAbort = null;
  const loadPromise = loadRedisRuntime(options);
  // Close a runtime that finishes after the ordinary path has already failed.
  loadPromise.then((lateRuntime) => {
    if (abandoned) closeRedisRuntime(lateRuntime).catch(() => {});
  }).catch(() => {});
  try {
    return await Promise.race([
      loadPromise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          abandoned = true;
          reject(new HarnessCredentialError("coordination_unavailable"));
        }, HELPER_ORDINARY_DEADLINE_MS);
        timeout.unref?.();
      }),
      new Promise((_, reject) => {
        onAbort = () => {
          abandoned = true;
          reject(new HarnessCredentialError("helper_timeout"));
        };
        if (signal?.aborted) onAbort();
        else signal?.addEventListener?.("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    signal?.removeEventListener?.("abort", onAbort);
  }
}

export async function handleCredentialHelper(context) {
  const {
    argv,
    positional,
    opts,
    stdin,
    stdout,
    homeDir,
    connectRedisStoreImpl,
    setExitCode,
  } = context;
  let runtime = null;
  const controller = new AbortController();
  const deadlineMs = Date.now() + HELPER_TOTAL_DEADLINE_MS;
  const timeout = setTimeout(() => controller.abort(new Error("helper deadline")), HELPER_TOTAL_DEADLINE_MS);
  timeout.unref?.();
  const signalEmitter = context.signalEmitter ?? process;
  const onTerminate = () => controller.abort(new Error("helper terminated"));
  signalEmitter.once?.("SIGTERM", onTerminate);

  try {
    if (positional.length !== 1 || opts.home !== undefined || argv?.length !== 1 || argv[0] !== "credential-helper") {
      throw protocolError();
    }
    if (!homeDir) throw new HarnessCredentialError("coordination_unavailable");
    const raw = await readBoundedStdin(stdin, { signal: controller.signal });
    const request = parseCredentialHelperRequest(raw);
    runtime = await loadHelperRuntimeWithinDeadline({
      homeDir,
      connectRedisStoreImpl,
    }, { signal: controller.signal });
    const response = await resolveHarnessAccessCredential({
      ...context,
      nowMs: Date.now(),
      signal: controller.signal,
      deadlineMs,
    }, {
      runtime,
      ...request,
      signal: controller.signal,
      deadlineMs,
    });
    writeProtocolObject(stdout, response);
  } catch (error) {
    setExitCode(1);
    writeProtocolObject(stdout, fixedFailure(
      controller.signal.aborted && !(error instanceof HarnessCredentialError)
        ? new HarnessCredentialError("helper_timeout")
        : error,
    ));
  } finally {
    clearTimeout(timeout);
    signalEmitter.removeListener?.("SIGTERM", onTerminate);
    if (runtime) await closeRedisRuntime(runtime).catch(() => {});
  }
}
