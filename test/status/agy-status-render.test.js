import assert from "node:assert/strict";
import test from "node:test";
import { renderClusterStatusText } from "../../src/status/cluster-view.js";
import { renderStatusText } from "../../src/status/render.js";
import { renderStatusCompactText } from "../../src/status/table.js";

const NOW = Date.parse("2026-11-20T19:00:00Z");
const MINUTE = 60_000;

function report(connections, overrides = {}) {
  return { runtime: "supported", localState: "available", runtimeInstalled: true, connections, ...overrides };
}

function machine(name, agy, accountNotes = []) {
  return { name, view: { accounts: [], agy, accountNotes }, claude: { accounts: [] } };
}

function accountRow(text, label) {
  return text.split("\n").find((line) => line.startsWith(`${label} `));
}

test("local Antigravity status shows launch blockers and independent quota windows", () => {
  const connections = [
    { label: "working", status: "ready", availability: "limited", observation: {
      plan: "Pro",
      observedAtMs: NOW - 16 * MINUTE,
      buckets: [
        { id: "gemini-weekly", remainingFraction: 0, resetAtMs: NOW - MINUTE },
        { id: "gemini-5h", disabled: true },
        { id: "claude-gpt-5h", remainingAmount: 50, resetAtMs: NOW + 20 * MINUTE },
      ],
    } },
    { label: "busy", status: "ready", availability: "in-use" },
    { label: "route", status: "ready", availability: "route-error" },
    { label: "missing", status: "ready", availability: "runtime-missing" },
    { label: "new", status: "not-enrolled", availability: "not-enrolled" },
    { label: "unverified", status: "ready", availability: "ready", route: "unverified" },
  ];
  const view = { nowMs: NOW, accounts: [], accountNotes: [], agy: report(connections) };
  const text = renderStatusText(view);
  assert.match(text, /Gemini weekly.*Claude\/GPT 5h/);
  assert.match(accountRow(text, "working"), /local grant present.*limited.*Pro.*0% left · reset elapsed.*disabled.*50 left · resets in 20m.*16m ago · stale/);
  assert.match(accountRow(text, "busy"), /in use.*unobserved/);
  assert.match(accountRow(text, "route"), /required route blocked · check the assigned route/);
  assert.match(accountRow(text, "missing"), /approved runtime missing · install the approved runtime/);
  assert.match(accountRow(text, "new"), /not enrolled here · aim agy login new/);
  assert.match(accountRow(text, "unverified"), /ready to launch · route unverified.*unobserved/);

  const compact = renderStatusCompactText(view);
  assert.match(compact, /agy\/working=local-grant-present.*plan="Pro".*gemini-weekly="0% left · reset elapsed".*claude-gpt-5h="50 left · resets in 20m".*observed="16m ago · stale"/);
  assert.match(compact, /agy\/busy=local-grant-present.*availability="in use"/);
  assert.match(compact, /agy\/missing=local-grant-present.*install the approved runtime/);
  assert.doesNotMatch(compact, /quota=unavailable/);
});

test("cluster shows one newest Antigravity observation and separate availability by host", () => {
  const label = "workspace";
  const observation = (plan, age, remainingFraction) => ({
    plan,
    observedAtMs: NOW - age * MINUTE,
    buckets: [{ id: "gemini-weekly", remainingFraction, resetAtMs: NOW + 25 * MINUTE }],
  });
  const oldObservation = observation("Starter", 20, 0.05);
  const newObservation = observation("Ultra", 5, 0.8);
  const withGrant = (availability, usage) => ({ label, status: "ready", availability, ...(usage ? { observation: usage } : {}) });
  const text = renderClusterStatusText([
    machine("mini-3", report([withGrant("ready", oldObservation)]), [
      { provider: "antigravity", label, note: "Pilot\nowned here" },
    ]),
    machine("mini-2", report([withGrant("in-use", newObservation)]), [
      { provider: "antigravity", label, note: "duplicate note" },
    ]),
    machine("m5", report([{ label, status: "ready" }])),
    machine("mini-4", report([{ label, status: "needs-sign-in", availability: "needs-sign-in" }])),
    machine("home", report([withGrant("runtime-missing")], { runtimeInstalled: false })),
    machine("studio", report([withGrant("route-error")])),
    machine("mini-5", report([{ label, status: "unknown", availability: "unknown" }], { localState: "unavailable" })),
    { name: "old-m1", view: { accounts: [] }, claude: { accounts: [] } },
    { name: "m3-36gb", error: "SSH connection failed" },
  ], { nowMs: NOW });

  const row = accountRow(text, label);
  assert.equal(text.split("\n").filter((line) => line.startsWith(`${label} `)).length, 1);
  assert.match(row, /5\/6.*mini-3, mini-2, m5, home, studio.*Ultra.*80% left · resets in 25m.*5m ago/);
  assert.match(row, /ready to launch mini-3.*in use mini-2.*local grant only m5.*sign-in required mini-4/);
  assert.match(row, /approved runtime missing home.*required route blocked studio.*unknown mini-5/);
  assert.match(text, /antigravity \/ workspace: "Pilot\\nowned here"/);
  assert.doesNotMatch(text, /Starter|duplicate note/);
});
