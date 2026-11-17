import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// A bare Codex family name means that family's newest release, the way Claude
// Code treats `fable` and `opus`, so a new Sol or Astra is used without editing
// AI Manager. Codex's own catalog says what exists, but a catalog written by an
// older Codex omits models that client could not run, so the newest version
// named here is also the floor.
const FALLBACK = Object.freeze({
  sol: "gpt-6.2-sol",
  astra: "gpt-6.2-astra",
  terra: "gpt-6.1-terra",
  luna: "gpt-6-luna",
});

export const CODEX_MODEL_FAMILIES = Object.freeze(Object.keys(FALLBACK));

function versionOf(slug, family) {
  const match = new RegExp(`^gpt-(\\d+(?:\\.\\d+)*)-${family}$`).exec(slug);
  return match ? match[1].split(".").map(Number) : null;
}

function newer(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

export function resolveCodexModel(value, { homeDir = os.homedir() } = {}) {
  const family = String(value ?? "").trim().toLowerCase();
  if (!Object.hasOwn(FALLBACK, family)) return value;
  let models = [];
  try {
    models = JSON.parse(fs.readFileSync(path.join(homeDir, ".codex", "models_cache.json"), "utf8")).models ?? [];
  } catch {}
  let best = { slug: FALLBACK[family], version: versionOf(FALLBACK[family], family) };
  for (const model of Array.isArray(models) ? models : []) {
    if (model?.visibility !== "list" || typeof model.slug !== "string") continue;
    const version = versionOf(model.slug, family);
    if (version && newer(version, best.version)) best = { slug: model.slug, version };
  }
  return best.slug;
}

// `aim codex run -- -m sol ...`: resolve a family name given to Codex's model flag.
export function resolveCodexModelArgs(args, options) {
  return args.map((arg, i) => {
    if (arg.startsWith("--model=")) return `--model=${resolveCodexModel(arg.slice(8), options)}`;
    return i > 0 && (args[i - 1] === "-m" || args[i - 1] === "--model") ? resolveCodexModel(arg, options) : arg;
  });
}
