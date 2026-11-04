import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveCpamcBaseUrl } from "./provider.js";

function getManagementToken(): string {
	try {
		const keyFile = join(homedir(), ".cliproxy_management_key");
		if (existsSync(keyFile)) {
			return readFileSync(keyFile, "utf-8").trim();
		}
	} catch {}
	return "";
}

export function registerAgentMatrixCommand(pi: ExtensionAPI): void {
	pi.registerCommand("agent:matrix", {
		description: "Muestra y administra la matriz de orquestación de modelos (Gentle-AI & jok3r-pi)",
		handler: async (args, ctx: ExtensionContext) => {
			if (ctx.hasUI) {
				ctx.ui.notify?.("🎛️ Consultando Matriz de Agentes en CPAMC Auto Switcher Pro...", "info");
			}

			try {
				const headers: Record<string, string> = {
					"X-Client-Harness": "jok3r_pi",
				};
				const token = getManagementToken();
				if (token) {
					headers["Authorization"] = `Bearer ${token}`;
				}

				const res = await fetch(`${resolveCpamcBaseUrl()}/v0/management/auto-switcher-pro/agent-matrix`, {
					headers,
					signal: AbortSignal.timeout(4000),
				});

				if (!res.ok) {
					throw new Error(`HTTP ${res.status}`);
				}

				const data = (await res.json()) as any;
				if (!data?.ok) {
					throw new Error(data?.message || "Respuesta inválida");
				}

				const gentleAgents = data.gentle_agents || [];
				const jok3rAgents = data.jok3r_agents || [];

				let output = "\n\x1b[1m\x1b[36m🎛️  MATRIZ DE AGENTES & ORQUESTACIÓN (CPAMC AUTO SWITCHER PRO)\x1b[0m\n";
				output += "\x1b[90m" + "─".repeat(78) + "\x1b[0m\n";

				output += "\n\x1b[1m\x1b[33m🅰️  UNIVERSO GENTLE-AI (OpenCode Editor & Gentle-Shell TUI)\x1b[0m\n";
				for (const a of gentleAgents) {
					const name = (a.displayName || a.agent_id).padEnd(25);
					const primary = `\x1b[32m${a.primary_pool}\x1b[0m`.padEnd(28);
					const fallback = `\x1b[90m→ \x1b[34m${a.fallback_pool}\x1b[0m`.padEnd(24);
					const thinking = `\x1b[35m[${a.thinking_level}]\x1b[0m`;
					output += `  ${name} ${primary} ${fallback} ${thinking}\n`;
				}

				output += "\n\x1b[1m\x1b[32m🅱️  SUITE SOBERANA WILOXDEV (Planned Workflow & Subagents)\x1b[0m\n";
				for (const a of jok3rAgents) {
					const name = (a.displayName || a.agent_id).padEnd(25);
					const primary = `\x1b[32m${a.primary_pool}\x1b[0m`.padEnd(28);
					const fallback = `\x1b[90m→ \x1b[34m${a.fallback_pool}\x1b[0m`.padEnd(24);
					const thinking = `\x1b[35m[${a.thinking_level}]\x1b[0m`;
					output += `  ${name} ${primary} ${fallback} ${thinking}\n`;
				}

				output += "\n\x1b[90m" + "─".repeat(78) + "\x1b[0m\n";
				output += "\x1b[36m💡 Edición gráfica disponible en CPAMC Web Console -> [ 🎛️ Matriz de Agentes ]\x1b[0m\n";

				const uiAny = ctx.hasUI ? (ctx.ui as any) : null;
				if (uiAny?.terminal) {
					uiAny.terminal.write?.(output);
				} else {
					console.log(output);
				}
			} catch (err: any) {
				if (ctx.hasUI) {
					ctx.ui.notify?.(`❌ Error consultando matriz: ${err?.message || err}`, "error");
				}
			}
		},
	});
}
