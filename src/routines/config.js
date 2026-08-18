import path from "node:path";
import { readAimgrConfig } from "../config/aimgr-config.js";
import { isObject } from "../core/normalize.js";

export const ROUTINE_PROVIDERS = new Set(["anthropic", "openai-codex"]);
export const ROUTINE_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

function requiredString(value, field, id) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Routine ${id} requires non-empty ${field}.`);
  }
  return value.trim();
}

function validateCalendar(value, id) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Routine ${id} requires at least one calendar entry.`);
  }
  return value.map((entry, index) => {
    if (!isObject(entry)) {
      throw new Error(`Routine ${id} calendar[${index}] must be an object.`);
    }
    const hour = Number(entry.hour);
    const minute = Number(entry.minute);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
      throw new Error(`Routine ${id} calendar[${index}].hour must be an integer from 0 to 23.`);
    }
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
      throw new Error(`Routine ${id} calendar[${index}].minute must be an integer from 0 to 59.`);
    }
    if (entry.weekday === undefined || entry.weekday === null) {
      return { hour, minute };
    }
    const weekday = Number(entry.weekday);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      throw new Error(`Routine ${id} calendar[${index}].weekday must be an integer from 0 (Sunday) to 6 (Saturday).`);
    }
    return { hour, minute, weekday };
  });
}

export function validateRoutineDefinition(id, value) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(String(id ?? ""))) {
    throw new Error(`Invalid routine id: ${String(id ?? "") || "<empty>"}.`);
  }
  if (!isObject(value)) {
    throw new Error(`Routine ${id} must be an object.`);
  }

  const provider = requiredString(value.provider, "provider", id);
  if (!ROUTINE_PROVIDERS.has(provider)) {
    throw new Error(`Routine ${id} has unsupported provider=${provider}.`);
  }
  const thinking = requiredString(value.thinking, "thinking", id);
  if (!ROUTINE_THINKING_LEVELS.has(thinking)) {
    throw new Error(`Routine ${id} has unsupported thinking=${thinking}.`);
  }
  const cwd = requiredString(value.cwd, "cwd", id);
  const promptFile = requiredString(value.promptFile, "promptFile", id);
  if (!path.isAbsolute(cwd) || !path.isAbsolute(promptFile)) {
    throw new Error(`Routine ${id} cwd and promptFile must be absolute paths.`);
  }
  const spaceTitleFormat = requiredString(value.spaceTitleFormat, "spaceTitleFormat", id);
  const marker = "{scheduled_local}";
  if (spaceTitleFormat.split(marker).length !== 2 || /\{[^}]*\}/.test(spaceTitleFormat.replace(marker, ""))) {
    throw new Error(`Routine ${id} spaceTitleFormat must contain exactly one {scheduled_local} token.`);
  }

  return Object.freeze({
    id,
    calendar: validateCalendar(value.calendar, id),
    cwd,
    promptFile,
    provider,
    model: requiredString(value.model, "model", id),
    thinking,
    herdrSession: requiredString(value.herdrSession, "herdrSession", id),
    spaceTitleFormat,
  });
}

export function readRoutineDefinition({ homeDir, id }) {
  const read = readAimgrConfig({ homeDir });
  if (!Object.hasOwn(read.config.routines, id)) {
    throw new Error(`Unknown routine: ${id}.`);
  }
  return {
    ...read,
    routine: validateRoutineDefinition(id, read.config.routines[id]),
  };
}

export function readAllRoutineDefinitions({ homeDir }) {
  const read = readAimgrConfig({ homeDir });
  return {
    ...read,
    routines: Object.entries(read.config.routines)
      .map(([id, value]) => validateRoutineDefinition(id, value)),
  };
}
