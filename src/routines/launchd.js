import path from "node:path";
import { resolveAimgrRoutineLogsDir } from "../io/paths.js";

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function stringNode(value, indent = "    ") {
  return `${indent}<string>${escapeXml(value)}</string>`;
}

function calendarDict(entry, indent) {
  return [
    `${indent}<dict>`,
    `${indent}  <key>Hour</key>`,
    `${indent}  <integer>${entry.hour}</integer>`,
    `${indent}  <key>Minute</key>`,
    `${indent}  <integer>${entry.minute}</integer>`,
    `${indent}</dict>`,
  ];
}

export function routineLaunchAgentLabel(routineId) {
  return `com.funcountry.aimgr.routine.${routineId}`;
}

export function routineLaunchAgentPath({ homeDir, routineId }) {
  return path.join(homeDir, "Library", "LaunchAgents", `${routineLaunchAgentLabel(routineId)}.plist`);
}

export function stagedRoutineLaunchAgentPath({ homeDir, routineId }) {
  return path.join(
    homeDir,
    ".aimgr",
    "routines",
    "launchagents",
    `${routineLaunchAgentLabel(routineId)}.plist`,
  );
}

export function renderRoutineLaunchAgent(routine, { homeDir, aimPath }) {
  if (!path.isAbsolute(aimPath)) throw new Error("LaunchAgent AIM path must be absolute.");
  const label = routineLaunchAgentLabel(routine.id);
  const logsDir = resolveAimgrRoutineLogsDir({ homeDir });
  const startCalendar = routine.calendar.length === 1
    ? calendarDict(routine.calendar[0], "    ")
    : [
        "    <array>",
        ...routine.calendar.flatMap((entry) => calendarDict(entry, "      ")),
        "    </array>",
      ];
  const launchPath = [
    path.join(homeDir, ".local", "bin"),
    path.join(homeDir, ".cargo", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].join(":");

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    stringNode(label, "  "),
    '  <key>ProgramArguments</key>',
    '  <array>',
    stringNode(aimPath),
    stringNode("routine"),
    stringNode("run"),
    stringNode(routine.id),
    '  </array>',
    '  <key>WorkingDirectory</key>',
    stringNode(routine.cwd, "  "),
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    '    <key>HOME</key>',
    stringNode(homeDir, "    "),
    '    <key>PATH</key>',
    stringNode(launchPath, "    "),
    '  </dict>',
    '  <key>StartCalendarInterval</key>',
    ...startCalendar,
    '  <key>StandardOutPath</key>',
    stringNode(path.join(logsDir, `routine-${routine.id}.out.log`), "  "),
    '  <key>StandardErrorPath</key>',
    stringNode(path.join(logsDir, `routine-${routine.id}.err.log`), "  "),
    '</dict>',
    '</plist>',
    '',
  ].join("\n");
}
