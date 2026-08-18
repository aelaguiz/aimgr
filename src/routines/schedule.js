import { randomUUID } from "node:crypto";

const ADMISSION_WINDOW_MS = 10 * 60_000;

function pad2(value) {
  return String(value).padStart(2, "0");
}

function localZoneName(date) {
  const part = new Intl.DateTimeFormat("en-US", { timeZoneName: "short" })
    .formatToParts(date)
    .find((entry) => entry.type === "timeZoneName");
  return part?.value ?? "local";
}

function localMinuteParts(date) {
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    hour: date.getHours(),
    minute: date.getMinutes(),
  };
}

export function formatScheduledLocal(date) {
  const value = localMinuteParts(date);
  return `${value.year}-${pad2(value.month)}-${pad2(value.day)} ${pad2(value.hour)}:${pad2(value.minute)} ${localZoneName(date)}`;
}

export function buildRoutineFireKey(id, date) {
  const value = localMinuteParts(date);
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffset = Math.abs(offsetMinutes);
  const offset = `${sign}${pad2(Math.floor(absoluteOffset / 60))}${pad2(absoluteOffset % 60)}`;
  return `${id}--${value.year}-${pad2(value.month)}-${pad2(value.day)}T${pad2(value.hour)}-${pad2(value.minute)}${offset}`;
}

function candidatesForDate(routine, now, dayOffset) {
  return routine.calendar
    .map((entry) => ({
      entry,
      date: new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + dayOffset,
        entry.hour,
        entry.minute,
        0,
        0,
      ),
    }))
    .filter(({ entry, date }) => entry.weekday === undefined || date.getDay() === entry.weekday)
    .map(({ date }) => date);
}

export function deriveRoutineOccurrence(routine, { now = new Date(), manual = false } = {}) {
  let scheduledAt;
  if (manual) {
    scheduledAt = new Date(now);
    scheduledAt.setSeconds(0, 0);
  } else {
    const candidates = [
      ...candidatesForDate(routine, now, -1),
      ...candidatesForDate(routine, now, 0),
    ].filter((candidate) => candidate.getTime() <= now.getTime());
    if (candidates.length === 0) {
      throw new Error(`Routine ${routine.id} has no due calendar occurrence.`);
    }
    scheduledAt = candidates.reduce((latest, candidate) => (
      candidate.getTime() > latest.getTime() ? candidate : latest
    ));
  }

  const delayMs = now.getTime() - scheduledAt.getTime();
  const admitted = manual || (delayMs >= 0 && delayMs <= ADMISSION_WINDOW_MS);
  const scheduledLocal = formatScheduledLocal(scheduledAt);
  return {
    manual,
    admitted,
    delayMs,
    scheduledAt,
    scheduledLocal,
    fireKey: manual
      ? `${buildRoutineFireKey(routine.id, scheduledAt)}--manual-${randomUUID()}`
      : buildRoutineFireKey(routine.id, scheduledAt),
    title: routine.spaceTitleFormat.replace("{scheduled_local}", scheduledLocal),
  };
}

export const ROUTINE_ADMISSION_WINDOW_MS = ADMISSION_WINDOW_MS;
