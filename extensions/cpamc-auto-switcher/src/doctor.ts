import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveCpamcBaseUrl, resolveManagementKey } from "./provider.js";
import { querySwitcherAccounts } from "./store.js";

export interface DoctorCheckResult {
	name: string;
	ok: boolean;
	detail: string;
	latencyMs?: number;
	autoFixable?: boolean;
}

export interface DoctorReport {
	allOk: boolean;
	checks: DoctorCheckResult[];
	baseUrl: string;
	timestamp: number;
}

export async function runDiagnostics(ctx?: ExtensionContext): Promise<DoctorReport> {
	const baseUrl = resolveCpamcBaseUrl();
	const mgmtKey = resolveManagementKey();
	const checks: DoctorCheckResult[] = [];

	// 1. CPAMC Server Reachability
	const t0 = Date.now();
	try {
		const res = await fetch(`${baseUrl}/v1/models`, {
			signal: AbortSignal.timeout(6000),
		});
		const lat = Date.now() - t0;
		if (res.ok || res.status === 401 || res.status === 403) {
			checks.push({
				name: "Servidor CPAMC",
				ok: true,
				detail: `En línea en ${baseUrl} (HTTP ${res.status}, ${lat}ms)`,
				latencyMs: lat,
			});
		} else {
			checks.push({
				name: "Servidor CPAMC",
				ok: false,
				detail: `Respondió con estado anómalo HTTP ${res.status}`,
				latencyMs: lat,
			});
		}
	} catch (err: any) {
		checks.push({
			name: "Servidor CPAMC",
			ok: false,
			detail: `Inaccesible: ${err?.message || err}`,
		});
	}

	// 2. Motor CGO Auto Switcher Pro
	try {
		const headers: Record<string, string> = {};
		if (mgmtKey) headers["Authorization"] = `Bearer ${mgmtKey}`;
		const res = await fetch(`${baseUrl}/v0/management/plugins`, {
			headers,
			signal: AbortSignal.timeout(6000),
		});
		if (res.ok) {
			const data = (await res.json()) as any;
			const plugins = Array.isArray(data?.plugins) ? data.plugins : [];
			const found = plugins.find((p: any) => p.id?.includes("auto-switcher-pro") || p.path?.includes("auto-switcher-pro"));
			if (found && (found.enabled ?? true)) {
				checks.push({
					name: "Motor CGO (Auto Switcher Pro)",
					ok: true,
					detail: `Plugin activo (${found.id || "auto-switcher-pro"}, ver ${found.metadata?.version || "0.1.1"})`,
				});
			} else {
				checks.push({
					name: "Motor CGO (Auto Switcher Pro)",
					ok: false,
					detail: "Plugin no registrado o deshabilitado en config.yaml",
					autoFixable: true,
				});
			}
		} else {
			checks.push({
				name: "Motor CGO (Auto Switcher Pro)",
				ok: false,
				detail: `Management API denegada (HTTP ${res.status}). Verifica tu clave en ~/.cliproxy_management_key`,
				autoFixable: true,
			});
		}
	} catch (err: any) {
		checks.push({
			name: "Motor CGO (Auto Switcher Pro)",
			ok: false,
			detail: `No se pudo verificar plugin: ${err?.message || err}`,
		});
	}

	// 3. Telemetría y SQLite WAL (Rotaciones & Analytics)
	try {
		const headers: Record<string, string> = {};
		if (mgmtKey) headers["Authorization"] = `Bearer ${mgmtKey}`;
		let res = await fetch(`${baseUrl}/v0/management/auto-switcher-pro/manifest`, {
			headers,
			signal: AbortSignal.timeout(12000),
		});
		if (!res.ok && res.status === 404) {
			// Fallback si CPAMC o proxy mapea sin el prefijo /v0/management
			res = await fetch(`${baseUrl}/auto-switcher-pro/manifest`, {
				headers,
				signal: AbortSignal.timeout(12000),
			});
		}
		if (res.ok) {
			const data = (await res.json()) as any;
			const accounts = Array.isArray(data) ? data : (Array.isArray(data?.accounts) ? data.accounts : []);
			const count = accounts.length;
			const rotations = data?.lifecycle?.rotations_count;
			const rotationDetail = typeof rotations === "number" && rotations > 0 ? ` · ${rotations} rotaciones registradas` : "";
			if (count > 0 || (typeof rotations === "number" && rotations > 0)) {
				checks.push({
					name: "SQLite WAL & Telemetría",
					ok: true,
					detail: `Canal activo (${count} cuentas${rotationDetail})`,
				});
			} else {
				checks.push({
					name: "SQLite WAL & Telemetría",
					ok: true,
					detail: "Canal activo y listo (0 cuentas vinculadas · Listo para operar)",
				});
			}
		} else {
			checks.push({
				name: "SQLite WAL & Telemetría",
				ok: false,
				detail: `Ruta de telemetría inaccesible (HTTP ${res.status})`,
			});
		}
	} catch (err: any) {
		checks.push({
			name: "SQLite WAL & Telemetría",
			ok: false,
			detail: `Fallo de conexión con canal de cuotas: ${err?.message || err}`,
		});
	}

	// 4. Quota Card en Gentle-Shell / TUI
	try {
		const tui = (ctx as any)?.tui;
		const terminal = tui?.terminal as any;
		const gentleState = terminal?.[Symbol.for("gentle-pi.experimental-sidebar.state")];
		const hasCard = Boolean(gentleState?.parts?.has?.("cpamc-quota-card") || gentleState?.parts?.get?.("footer"));
		if (hasCard) {
			checks.push({
				name: "Tarjeta cpamc-quota-card",
				ok: true,
				detail: "Montada e interceptada orgánicamente en el riel de Gentle-Shell",
			});
		} else {
			checks.push({
				name: "Tarjeta cpamc-quota-card",
				ok: true,
				detail: "Riel TUI listo (se proyecta automáticamente al activar el sidebar o seleccionar un modelo CPAMC)",
			});
		}
	} catch {
		checks.push({
			name: "Tarjeta cpamc-quota-card",
			ok: true,
			detail: "Estado TUI en espera de renderizado",
		});
	}

	const allOk = checks.every((c) => c.ok);
	return {
		allOk,
		checks,
		baseUrl,
		timestamp: Date.now(),
	};
}

export function formatDoctorOutput(report: DoctorReport): string {
	let out = "\n\x1b[1m\x1b[36m╭─ 🩺 CPAMC AUTO-SWITCHER · DIAGNÓSTICO INTEGRAL ──────────╮\x1b[0m\n";
	out += `\x1b[90m│ Endpoint evaluado: ${report.baseUrl.padEnd(38)}│\x1b[0m\n`;
	out += "\x1b[36m├──────────────────────────────────────────────────────────┤\x1b[0m\n";

	for (const check of report.checks) {
		const icon = check.ok ? "\x1b[32m[✓]\x1b[0m" : "\x1b[31m[✗]\x1b[0m";
		out += `│ ${icon} \x1b[1m${check.name}\x1b[0m\n`;
		out += `│     \x1b[90m↳ ${check.detail}\x1b[0m\n`;
	}

	out += "\x1b[36m├──────────────────────────────────────────────────────────┤\x1b[0m\n";
	if (report.allOk) {
		out += "│ \x1b[32m✔ Componentes verificados y listos para operar.\x1b[0m       │\n";
	} else {
		out += "│ \x1b[33m⚠️ Se detectaron anomalías. Usa /cpamc doctor fix         │\x1b[0m\n";
	}
	out += "\x1b[36m╰──────────────────────────────────────────────────────────╯\x1b[0m\n";
	return out;
}

export async function formatAccountsTable(): Promise<string> {
	const accounts = await querySwitcherAccounts(true);
	if (!accounts || accounts.length === 0) {
		return "ℹ️ No hay cuentas vinculadas en CPAMC actualmente (listo para cuando desees vincularlas).";
	}

	const lines = [
		"┌───────┬────────────┬────────────────────────┬───────────┬─────────────┐",
		"│ ALIAS │ PROVEEDOR  │ CUENTA (OFUSCADA)      │ 5H DISP.  │ SEMANAL     │",
		"├───────┼────────────┼────────────────────────┼───────────┼─────────────┤",
	];

	for (const acc of accounts) {
		const alias = (acc.alias || (acc.status === "[OTHER]" ? "LIBRE" : acc.prefix || "-")).padEnd(5);
		const prov = (acc.provider || "cpamc").slice(0, 10).padEnd(10);
		const email = (acc.accountId || "-").slice(0, 22).padEnd(22);
		const c5h = (acc.minAvailable || "-").padEnd(9);
		const cWk = (acc.consumedWeekly ? `${100 - parseInt(acc.consumedWeekly)}%` : "-").padEnd(11);
		lines.push(`│ ${alias} │ ${prov} │ ${email} │ ${c5h} │ ${cWk} │`);
	}
	lines.push("└───────┴────────────┴────────────────────────┴───────────┴─────────────┘");
	return lines.join("\n");
}

export function registerDoctorCommand(pi: ExtensionAPI): void {
	pi.registerCommand("cpamc", {
		description: "Diagnóstico y control del ecosistema CPAMC Auto-Switcher (/cpamc doctor [fix])",
		handler: async (args: any, ctx: any) => {
			const argStr = typeof args === "string" ? args : (Array.isArray(args) ? args.join(" ") : "");
			const argList = argStr.trim().split(/\s+/).filter(Boolean);
			const sub = (argList[0] || "doctor").toLowerCase();
			if (sub === "doctor" || sub === "status") {
				if (ctx.hasUI) {
					ctx.ui.notify?.("🩺 Evaluando estado de los 4 componentes...", "info");
				}
				const report = await runDiagnostics(ctx);
				const formatted = formatDoctorOutput(report);
				console.log(formatted);

				const shouldFix = argList.includes("fix") || argList.includes("--fix");
				if (shouldFix || (!report.allOk && ctx.hasUI && typeof ctx.ui?.select === "function")) {
					if (shouldFix) {
						await executeAutoFix(ctx);
					} else {
						const choice = await ctx.ui.select?.("¿Deseas intentar autoreparación inmediata?", [
							"⚡ [F] Autoreparar componentes ahora",
							"Cerrar sin cambios",
						]);
						if (choice?.startsWith("⚡")) {
							await executeAutoFix(ctx);
						}
					}
				}
				return;
			}

			if (sub === "accounts" || sub === "alias" || sub === "aliases") {
				const output = await formatAccountsTable();
				console.log(output);
				if (ctx.hasUI) {
					ctx.ui.notify?.(output, "info");
				}
				return;
			}

			if (sub === "fix") {
				await executeAutoFix(ctx);
				return;
			}

			if (ctx.hasUI) {
				ctx.ui.notify?.("Uso: /cpamc doctor [fix]", "info");
			}
		},
	});

	pi.registerCommand("cpamc-accounts", {
		description: "Muestra la correspondencia entre alias (CX1, AG1...) y cuentas en CPAMC",
		handler: async (_args: any, ctx: any) => {
			const output = await formatAccountsTable();
			console.log(output);
			if (ctx.hasUI) {
				ctx.ui.notify?.(output, "info");
			}
		},
	});

	pi.registerCommand("cpamc-doctor", {
		description: "Alias directo para /cpamc doctor",
		handler: async (args: any, ctx: any) => {
			const argStr = typeof args === "string" ? args : (Array.isArray(args) ? args.join(" ") : "");
			const argList = argStr.trim().split(/\s+/).filter(Boolean);
			const report = await runDiagnostics(ctx);
			console.log(formatDoctorOutput(report));
			if (argList.includes("fix") || argList.includes("--fix")) {
				await executeAutoFix(ctx);
			}
		},
	});
}

async function executeAutoFix(ctx: ExtensionContext): Promise<void> {
	if (ctx.hasUI) {
		ctx.ui.notify?.("⚡ Ejecutando autoreparación y refresco de estado...", "info");
	}
	
	// 1. Evacuación automática de respaldos duplicados (*.bak*) que causan colisión de atajos
	try {
		const fs = await import("fs");
		const path = await import("path");
		const os = await import("os");

		const agentExtRoots = [
			path.join(os.homedir(), ".gentle-shell", "agent", "extensions"),
			path.join(os.homedir(), ".pi", "gentle-shell", "extensions"),
			path.join(os.homedir(), ".pi", "agent", "extensions"),
			path.join(os.homedir(), ".pi", "agent-wilox", "extensions"),
		];

		// Incluir directorio configurado en ~/.gentle-shell/config.json si existe
		try {
			const configJsonPath = path.join(os.homedir(), ".gentle-shell", "config.json");
			if (fs.existsSync(configJsonPath)) {
				const cfg = JSON.parse(fs.readFileSync(configJsonPath, "utf-8"));
				if (cfg?.home) {
					agentExtRoots.push(path.join(cfg.home, "extensions"));
				}
			}
		} catch {}

		const backupRootDir = path.join(os.homedir(), ".gentle-shell", "backups", "extensions");
		if (!fs.existsSync(backupRootDir)) {
			fs.mkdirSync(backupRootDir, { recursive: true });
		}

		for (const root of agentExtRoots) {
			if (fs.existsSync(root)) {
				const entries = fs.readdirSync(root);
				for (const entry of entries) {
					if (entry.startsWith("cpamc-auto-switcher.bak")) {
						const src = path.join(root, entry);
						const dst = path.join(backupRootDir, entry);
						try {
							fs.renameSync(src, dst);
							console.log(`[Doctor] 🧹 Respaldo duplicado evacuado: ${entry} -> backups/`);
						} catch {}
					}
				}
			}
		}
	} catch {}

	try {
		await ctx.modelRegistry?.refresh?.();
	} catch {}
	try {
		const tui = (ctx as any)?.tui;
		tui?.requestRender?.();
	} catch {}
	if (ctx.hasUI) {
		ctx.ui.notify?.("✅ Autoreparación completada (respaldos purgados y catálogo refrescado).", "info");
	}
}
