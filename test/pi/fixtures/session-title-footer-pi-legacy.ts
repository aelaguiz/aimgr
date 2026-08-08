import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";

function configuredBindings(): Map<string, string> {
	const bindings = new Map<string, string>();
	const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
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
		// The footer remains useful when auth is absent or temporarily unreadable.
	}
	return bindings;
}

function compactHome(cwd: string): string {
	const home = homedir();
	if (cwd === home) return "~";
	return cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const configured = configuredBindings();

		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsubscribe = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose: unsubscribe,
				invalidate() {},
				render(width: number): string[] {
					const title = ctx.sessionManager.getSessionName() || "untitled";
					const provider = ctx.model?.provider;
					const account =
						(provider ? configured.get(provider) : undefined) ||
						configured.get("openai-codex") ||
						configured.get("anthropic") ||
						"unbound";
					const branch = footerData.getGitBranch() || "no-branch";
					const cwd = compactHome(ctx.cwd);
					const separator = theme.fg("dim", " · ");
					const line = [
						theme.fg("accent", theme.bold(`title:${title}`)),
						theme.fg("dim", `account:${account}`),
						theme.fg("dim", `branch:${branch}`),
						theme.fg("dim", `cwd:${cwd}`),
					].join(separator);
					return [truncateToWidth(line, width)];
				},
			};
		});
	});
}
