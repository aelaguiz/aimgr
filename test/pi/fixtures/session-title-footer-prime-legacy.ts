import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const WIDGET_KEY = "session-identity";
type CredentialBinding = { binding: string };

function configuredBindings(): Map<string, string> {
	const bindings = new Map<string, string>();
	const agentDir = process.env.PRIME_AGENT_CODING_AGENT_DIR || join(homedir(), ".prime", "agent");
	try {
		const auth = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8"));
		if (!auth || typeof auth !== "object" || Array.isArray(auth)) return bindings;
		for (const [provider, entry] of Object.entries(auth)) {
			if (!entry || typeof entry !== "object" || Array.isArray(entry) || !("type" in entry)) continue;
			if (
				entry.type === "external" &&
				"source" in entry &&
				entry.source === "aimgr" &&
				"binding" in entry &&
				typeof entry.binding === "string"
			) {
				bindings.set(provider, entry.binding);
				continue;
			}
			if (entry.type === "oauth") {
				const accountId = "accountId" in entry && typeof entry.accountId === "string" ? entry.accountId : "";
				bindings.set(provider, accountId ? `oauth:${accountId.slice(0, 8)}` : "oauth");
			}
		}
	} catch {
		// The identity line remains useful when auth is absent or temporarily unreadable.
	}
	return bindings;
}

function sessionBindings(ctx: ExtensionContext): Map<string, CredentialBinding> {
	const getBindings = (
		ctx.sessionManager as typeof ctx.sessionManager & {
			getCredentialBindings?: () => Map<string, CredentialBinding>;
		}
	).getCredentialBindings;
	if (typeof getBindings !== "function") return new Map();
	try {
		return getBindings.call(ctx.sessionManager);
	} catch {
		return new Map();
	}
}

function gitBranch(cwd: string): string {
	try {
		return (
			execFileSync("git", ["-C", cwd, "branch", "--show-current"], {
				encoding: "utf8",
				timeout: 1000,
			}).trim() || "detached"
		);
	} catch {
		return "no-branch";
	}
}

function compactHome(cwd: string): string {
	const home = homedir();
	if (cwd === home) return "~";
	return cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd;
}

export default function (pi: ExtensionAPI) {
	let configured = new Map<string, string>();
	let branch = "no-branch";
	let lastLine: string | undefined;
	let refreshTimer: ReturnType<typeof setInterval> | undefined;

	const update = (ctx: ExtensionContext, refreshBranch = false) => {
		if (refreshBranch) branch = gitBranch(ctx.cwd);
		const title = ctx.sessionManager.getSessionName() || "untitled";
		const provider = ctx.model?.provider;
		const persisted = sessionBindings(ctx);
		const account =
			(provider ? persisted.get(provider)?.binding : undefined) ||
			(provider ? configured.get(provider) : undefined) ||
			persisted.get("openai-codex")?.binding ||
			persisted.get("anthropic")?.binding ||
			configured.get("openai-codex") ||
			configured.get("anthropic") ||
			"unbound";
		const line = [`title:${title}`, `account:${account}`, `branch:${branch}`, `cwd:${compactHome(ctx.cwd)}`].join(
			" · ",
		);
		if (line === lastLine) return;
		lastLine = line;
		ctx.ui.setWidget(WIDGET_KEY, [line], { placement: "belowEditor" });
	};

	pi.on("session_start", async (_event, ctx) => {
		if (refreshTimer) clearInterval(refreshTimer);
		configured = configuredBindings();
		branch = gitBranch(ctx.cwd);
		lastLine = undefined;
		update(ctx);
		refreshTimer = setInterval(() => update(ctx), 1000);
		refreshTimer.unref();
	});

	pi.on("agent_start", async (_event, ctx) => update(ctx, true));
	pi.on("agent_end", async (_event, ctx) => update(ctx, true));

	pi.on("session_shutdown", async (_event, ctx) => {
		if (refreshTimer) clearInterval(refreshTimer);
		refreshTimer = undefined;
		lastLine = undefined;
		ctx.ui.setWidget(WIDGET_KEY, undefined, { placement: "belowEditor" });
	});
}
