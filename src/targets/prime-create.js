import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ANTHROPIC_PROVIDER, OPENAI_CODEX_PROVIDER } from "../core/constants.js";
import { isObject, normalizeLabel } from "../core/normalize.js";

const MAX_OPERATION_ID_LENGTH = 160;
const MAX_PATH_LENGTH = 4_096;
const MAX_NAME_LENGTH = 200;
const MAX_MODEL_LENGTH = 200;
const TOP_LEVEL_KEYS = new Set([
  "schemaVersion",
  "operationId",
  "targetAgentDir",
  "provider",
  "label",
  "preserveOtherProvider",
  "prime",
]);
const PRIME_KEYS = new Set(["daemonSocket", "cwd", "name", "model"]);
const STATUS_KEYS = new Set(["schemaVersion", "operationId"]);
const PRIME_LAUNCHER_LANES = new Set(["source", "dist", "installed", "unknown"]);
const OPERATION_STATUSES = new Set([
  "pending",
  "committed",
  "aborted_no_effect",
  "rolled_back_no_root",
  "partial_effect",
  "conflict_uncertain",
  "not_found",
]);

function protocolError() {
  return new Error("Invalid AIM Prime structured request.");
}

function exactKeys(value, allowed) {
  return isObject(value) && Object.keys(value).every((key) => allowed.has(key));
}

function boundedString(value, { maxLength, allowEmpty = false } = {}) {
  return typeof value === "string"
    && (allowEmpty || value.length > 0)
    && value.length <= maxLength
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function exactAbsolutePath(value) {
  return boundedString(value, { maxLength: MAX_PATH_LENGTH })
    && path.isAbsolute(value)
    && path.resolve(value) === value;
}

function normalizeRequestedLabel(value) {
  if (value === "auto") return value;
  if (!boundedString(value, { maxLength: 128 })) throw protocolError();
  try {
    const normalized = normalizeLabel(value);
    if (normalized !== value) throw protocolError();
    return normalized;
  } catch {
    throw protocolError();
  }
}

export function parsePrimeCreateRequest(value) {
  if (!exactKeys(value, TOP_LEVEL_KEYS) || value.schemaVersion !== 1) throw protocolError();
  if (!boundedString(value.operationId, { maxLength: MAX_OPERATION_ID_LENGTH })) throw protocolError();
  if (!exactAbsolutePath(value.targetAgentDir)) throw protocolError();
  if (value.provider !== OPENAI_CODEX_PROVIDER && value.provider !== ANTHROPIC_PROVIDER) {
    throw protocolError();
  }
  const label = normalizeRequestedLabel(value.label);
  const preserveOtherProvider = value.preserveOtherProvider ?? true;
  if (preserveOtherProvider !== true) throw protocolError();
  if (!exactKeys(value.prime, PRIME_KEYS)) throw protocolError();
  if (!exactAbsolutePath(value.prime.daemonSocket) || !exactAbsolutePath(value.prime.cwd)) {
    throw protocolError();
  }
  if (
    value.prime.name !== undefined
    && !boundedString(value.prime.name, { maxLength: MAX_NAME_LENGTH })
  ) {
    throw protocolError();
  }
  if (
    value.prime.model !== undefined
    && (
      !boundedString(value.prime.model, { maxLength: MAX_MODEL_LENGTH })
      || !/^[A-Za-z0-9._:/-]+$/.test(value.prime.model)
    )
  ) {
    throw protocolError();
  }
  return Object.freeze({
    schemaVersion: 1,
    operationId: value.operationId,
    targetAgentDir: value.targetAgentDir,
    provider: value.provider,
    label,
    preserveOtherProvider: true,
    prime: Object.freeze({
      daemonSocket: value.prime.daemonSocket,
      cwd: value.prime.cwd,
      ...(value.prime.name !== undefined ? { name: value.prime.name } : {}),
      ...(value.prime.model !== undefined ? { model: value.prime.model } : {}),
    }),
  });
}

export function parsePrimeCreateStatusRequest(value) {
  if (
    !exactKeys(value, STATUS_KEYS)
    || value.schemaVersion !== 1
    || !boundedString(value.operationId, { maxLength: MAX_OPERATION_ID_LENGTH })
  ) {
    throw protocolError();
  }
  return Object.freeze({ schemaVersion: 1, operationId: value.operationId });
}

export function primeCreateOperationKey(operationId) {
  return createHash("sha256").update(operationId, "utf8").digest("hex");
}

export function primeCreateRequestDigest(request) {
  return createHash("sha256").update(JSON.stringify(request), "utf8").digest("hex");
}

function sanitizePrimeColdCreate(value) {
  const keys = [
    "expectedBuildId",
    "expectedLauncherLane",
    "expectedDaemonGeneration",
    "targetBefore",
  ];
  if (
    !exactKeys(value, new Set(keys))
    || Object.keys(value).length !== keys.length
    || !boundedString(value.expectedBuildId, { maxLength: 256 })
    || !PRIME_LAUNCHER_LANES.has(value.expectedLauncherLane)
    || value.expectedDaemonGeneration !== null
    || value.targetBefore !== null
  ) {
    throw new Error("Prime create structured capability is unavailable.");
  }
  return Object.freeze({
    expectedBuildId: value.expectedBuildId,
    expectedLauncherLane: value.expectedLauncherLane,
    expectedDaemonGeneration: null,
    targetBefore: null,
  });
}

export function buildPrimeCreateDispatchRequest({ request, descriptor, coldCreate }) {
  const precondition = sanitizePrimeColdCreate(coldCreate);
  return Object.freeze({
    schemaVersion: 1,
    operationId: request.operationId,
    expectedAgentDir: request.targetAgentDir,
    daemonSocket: request.prime.daemonSocket,
    expectedBuildId: precondition.expectedBuildId,
    expectedLauncherLane: precondition.expectedLauncherLane,
    expectedDaemonGeneration: null,
    targetBefore: null,
    cwd: request.prime.cwd,
    ...(request.prime.name !== undefined ? { name: request.prime.name } : {}),
    provider: request.provider,
    ...(request.prime.model !== undefined ? { model: request.prime.model } : {}),
    expectedCredentialDescriptor: Object.freeze({
      provider: request.provider,
      source: "aimgr",
      binding: descriptor.binding,
      expectedIdentityFingerprint: descriptor.expectedIdentityFingerprint,
    }),
  });
}

function exactConfiguredBinding(value) {
  if (!isObject(value)) throw new Error("Prime create returned an invalid credential binding receipt.");
  const provider = value.provider;
  const source = value.source;
  const binding = value.binding;
  if (
    (provider !== OPENAI_CODEX_PROVIDER && provider !== ANTHROPIC_PROVIDER)
    || source !== "aimgr"
    || !boundedString(binding, { maxLength: 128 })
  ) {
    throw new Error("Prime create returned an invalid credential binding receipt.");
  }
  let normalized;
  try {
    normalized = normalizeLabel(binding);
  } catch {
    throw new Error("Prime create returned an invalid credential binding receipt.");
  }
  if (normalized !== binding) throw new Error("Prime create returned an invalid credential binding receipt.");
  return Object.freeze({ provider, source, binding });
}

function receiptString(value, label, { pathValue = false } = {}) {
  const valid = pathValue ? exactAbsolutePath(value) : boundedString(value, { maxLength: MAX_PATH_LENGTH });
  if (!valid) throw new Error(`Prime create returned an invalid ${label}.`);
  return value;
}

export function sanitizePrimeCreateReceipt(value, {
  operationId,
  provider,
  binding,
  expectedDaemonSocket,
  expectedBuildId,
  expectedLauncherLane,
}) {
  if (!isObject(value) || value.schemaVersion !== 1 || value.operationId !== operationId) {
    throw new Error("Prime create returned an invalid operation receipt.");
  }
  if (value.disposition !== "created" && value.disposition !== "reused" && value.disposition !== "forked") {
    throw new Error("Prime create returned an invalid disposition.");
  }
  if (
    !isObject(value.universe)
    || Object.keys(value.universe).length !== 4
    || !exactKeys(value.universe, new Set(["socket", "buildId", "launcherLane", "daemonGeneration"]))
    || !isObject(value.targetAfter)
  ) {
    throw new Error("Prime create returned an incomplete root receipt.");
  }
  if (value.targetBefore !== null || value.sourceTarget !== null) {
    throw new Error("Prime create did not satisfy the cold-create precondition.");
  }
  if (
    !exactAbsolutePath(expectedDaemonSocket)
    || !boundedString(expectedBuildId, { maxLength: 256 })
    || !PRIME_LAUNCHER_LANES.has(expectedLauncherLane)
    || value.universe.socket !== expectedDaemonSocket
    || value.universe.buildId !== expectedBuildId
    || value.universe.launcherLane !== expectedLauncherLane
  ) {
    throw new Error("Prime create returned a different daemon universe.");
  }
  const configuredCredentialBindings = Array.isArray(value.targetAfter.configuredCredentialBindings)
    ? value.targetAfter.configuredCredentialBindings.map(exactConfiguredBinding)
    : [];
  if (!configuredCredentialBindings.some(
    (entry) => entry.provider === provider && entry.source === "aimgr" && entry.binding === binding,
  )) {
    throw new Error("Prime create did not persist the expected configured credential binding.");
  }
  return Object.freeze({
    schemaVersion: 1,
    operationId,
    disposition: value.disposition,
    universe: Object.freeze({
      socket: receiptString(value.universe.socket, "universe socket", { pathValue: true }),
      buildId: receiptString(value.universe.buildId, "build identity"),
      launcherLane: value.universe.launcherLane,
      daemonGeneration: receiptString(value.universe.daemonGeneration, "daemon generation"),
    }),
    targetBefore: null,
    sourceTarget: null,
    targetAfter: Object.freeze({
      activeSessionId: receiptString(value.targetAfter.activeSessionId, "active session identity"),
      sessionId: receiptString(value.targetAfter.sessionId, "durable session identity"),
      sessionFile: receiptString(value.targetAfter.sessionFile, "session file", { pathValue: true }),
      configuredCredentialBindings: Object.freeze(configuredCredentialBindings),
    }),
  });
}

export function sameDescriptor(left, right) {
  return isDeepStrictEqual(left ?? null, right ?? null);
}

export class PrimeCreateDispatchError extends Error {
  constructor(message, { uncertain = true } = {}) {
    super(message);
    this.name = "PrimeCreateDispatchError";
    this.uncertain = uncertain;
  }
}

const PRIME_CREATE_CAPABILITY_FIXED = Object.freeze({
  schemaVersion: 1,
  capability: "prime-resident-root-create",
  capabilityVersion: 2,
  createRequestSchemaVersion: 1,
  createReceiptSchemaVersion: 1,
  createStatusRequestSchemaVersion: 1,
  createStatusReceiptSchemaVersion: 1,
});

const PRIME_SUBPROCESS_MAX_OUTPUT_BYTES = 128 * 1024;

async function runPrimeJsonSubprocess({ command, args, cwd, env, request, spawnImpl = spawn } = {}) {
  let child;
  try {
    child = await spawnImpl(command, args, {
      cwd,
      env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    return { error, status: null, stdout: "", outputExceeded: false, spawned: false };
  }
  if (!child || typeof child.once !== "function" || typeof child.kill !== "function") {
    return {
      error: new Error("invalid child process"),
      status: null,
      stdout: "",
      outputExceeded: false,
      spawned: false,
    };
  }

  return new Promise((resolve) => {
    const stdoutChunks = [];
    let outputBytes = 0;
    let outputExceeded = false;
    let transportError = null;
    let spawned = Number.isInteger(child.pid) && child.pid > 0;
    let settled = false;

    const observeOutput = (chunk, capture) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += buffer.length;
      if (capture && !outputExceeded) stdoutChunks.push(buffer);
      if (outputBytes <= PRIME_SUBPROCESS_MAX_OUTPUT_BYTES || outputExceeded) return;
      outputExceeded = true;
      stdoutChunks.length = 0;
      try {
        child.kill();
      } catch {
        // The fixed caller error intentionally hides process diagnostics.
      }
    };

    child.once("spawn", () => {
      spawned = true;
    });
    child.once("error", (error) => {
      transportError = error;
    });
    child.stdout?.on("data", (chunk) => observeOutput(chunk, true));
    child.stderr?.on("data", (chunk) => observeOutput(chunk, false));
    child.once("close", (status) => {
      if (settled) return;
      settled = true;
      resolve({
        error: transportError,
        status: Number.isInteger(status) ? status : null,
        stdout: outputExceeded ? "" : Buffer.concat(stdoutChunks).toString("utf8"),
        outputExceeded,
        spawned,
      });
    });

    if (!child.stdin || typeof child.stdin.end !== "function") {
      transportError = new Error("invalid child stdin");
      try {
        child.kill();
      } catch {
        // The fixed caller error intentionally hides process diagnostics.
      }
      return;
    }
    child.stdin.once?.("error", (error) => {
      transportError = error;
    });
    child.stdin.end(`${JSON.stringify(request)}
`);
  });
}

export async function inspectPrimeCreateCapability({ command, cwd, env, spawnImpl = spawn } = {}) {
  const result = await runPrimeJsonSubprocess({
    command,
    args: ["--dist", "create", "capabilities", "--request-json", "-"],
    cwd,
    env,
    request: { schemaVersion: 1 },
    spawnImpl,
  });
  if (result?.error || result?.status !== 0 || result?.outputExceeded) {
    throw new Error("Prime create structured capability is unavailable.");
  }
  let capability;
  try {
    capability = JSON.parse(String(result?.stdout ?? ""));
  } catch {
    throw new Error("Prime create structured capability is unavailable.");
  }
  if (
    !capability
    || typeof capability !== "object"
    || Array.isArray(capability)
    || Object.keys(capability).length !== Object.keys(PRIME_CREATE_CAPABILITY_FIXED).length + 1
    || Object.entries(PRIME_CREATE_CAPABILITY_FIXED).some(([key, value]) => capability[key] !== value)
    || !Object.hasOwn(capability, "coldCreate")
  ) {
    throw new Error("Prime create structured capability is unavailable.");
  }
  const coldCreate = sanitizePrimeColdCreate(capability.coldCreate);
  return Object.freeze({
    ...PRIME_CREATE_CAPABILITY_FIXED,
    coldCreate,
  });
}

function parseLauncherJson(result, { uncertainOnFailure }) {
  const uncertain = uncertainOnFailure && result?.spawned !== false;
  if (result?.error || result?.outputExceeded) {
    throw new PrimeCreateDispatchError("Prime create launcher failed.", { uncertain });
  }
  if (result?.status !== 0) {
    throw new PrimeCreateDispatchError("Prime create launcher returned no receipt.", { uncertain });
  }
  try {
    return JSON.parse(String(result?.stdout ?? ""));
  } catch {
    throw new PrimeCreateDispatchError("Prime create launcher returned no receipt.", { uncertain });
  }
}

export async function launchPrimeCreate({ command, request, cwd, env, spawnImpl = spawn } = {}) {
  const result = await runPrimeJsonSubprocess({
    command,
    args: ["--dist", "create", "--request-json", "-"],
    cwd,
    env,
    request,
    spawnImpl,
  });
  return parseLauncherJson(result, { uncertainOnFailure: true });
}

export async function lookupPrimeCreate({
  command,
  operationId,
  daemonSocket,
  cwd,
  env,
  spawnImpl = spawn,
} = {}) {
  const result = await runPrimeJsonSubprocess({
    command,
    args: ["--dist", "create", "status", "--request-json", "-"],
    cwd,
    env,
    request: { schemaVersion: 1, operationId, daemonSocket },
    spawnImpl,
  });
  if (result?.error || result?.status !== 0 || result?.outputExceeded) {
    throw new PrimeCreateDispatchError("Prime create status is unavailable.", { uncertain: true });
  }
  let parsed;
  try {
    parsed = JSON.parse(String(result?.stdout ?? ""));
  } catch {
    throw new PrimeCreateDispatchError("Prime create status returned no receipt.", { uncertain: true });
  }
  if (
    parsed?.schemaVersion === 1
    && parsed?.operationId === operationId
    && parsed?.found === false
    && Object.keys(parsed).length === 3
  ) {
    return Object.freeze({ status: "absent" });
  }
  if (
    parsed?.schemaVersion === 1
    && parsed?.operationId === operationId
    && parsed?.found === true
    && parsed?.status === "pending"
    && Object.keys(parsed).length === 4
  ) {
    return Object.freeze({ status: "pending" });
  }
  return Object.freeze({ status: "committed", receipt: parsed });
}

export function buildAimPrimeCreateReceipt({
  operationId,
  transactionStatus,
  provider = null,
  binding = null,
  priorBinding = null,
  preserveOtherProvider = true,
  root = null,
  rollbackStatus = null,
  reason = null,
}) {
  if (!OPERATION_STATUSES.has(transactionStatus)) {
    throw new Error("Invalid AIM Prime create transaction status.");
  }
  const committed = transactionStatus === "committed";
  const automaticRetryAllowed = false;
  const configuredBinding = committed || transactionStatus === "partial_effect"
    ? binding
    : transactionStatus === "aborted_no_effect" || transactionStatus === "rolled_back_no_root"
      ? priorBinding
      : null;
  const projectionEffect = committed
    ? "selected_future_root_projection_remains"
    : transactionStatus === "partial_effect"
      ? "selected_projection_may_remain"
      : transactionStatus === "rolled_back_no_root"
        ? "restored_prior_projection"
        : transactionStatus === "aborted_no_effect"
          ? "prior_projection_unchanged"
          : transactionStatus === "pending"
            ? "pending_recovery"
            : transactionStatus === "conflict_uncertain"
              ? "projection_uncertain"
              : "none";
  return Object.freeze({
    schemaVersion: 1,
    ok: committed,
    action: "prime_create",
    operationId,
    transactionStatus,
    projection: provider && binding
      ? Object.freeze({
          provider,
          selectedBinding: binding,
          configuredBinding,
          preserveOtherProvider: preserveOtherProvider === true,
          effect: projectionEffect,
        })
      : null,
    root,
    rollback: rollbackStatus
      ? Object.freeze({ status: rollbackStatus })
      : null,
    retry: Object.freeze({
      automaticAllowed: automaticRetryAllowed,
      statusLookupOnly: transactionStatus === "partial_effect" || transactionStatus === "conflict_uncertain",
    }),
    reason,
  });
}
