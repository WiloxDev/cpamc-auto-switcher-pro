import { exec } from "node:child_process";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { IncidentRecord, RunawayGuardTelemetry } from "./guards.js";
import { resolveCpamcBaseUrl } from "./provider.js";

export interface IncidentModalOptions {
	incident?: IncidentRecord;
	telemetry: RunawayGuardTelemetry;
	onDismiss?: () => void;
}

/**
 * Componente modal TUI nativo para inspeccionar autopsias de incidentes de bucle y disyuntor.
 */
export class IncidentModalComponent {
	private theme: any;
	private options: IncidentModalOptions;
	private done: () => void;

	constructor(theme: any, options: IncidentModalOptions, done: () => void) {
		this.theme = theme;
		this.options = options;
		this.done = done;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || data === "q" || data === "Q") {
			this.done();
		} else if (data === "d" || data === "D" || matchesKey(data, "return")) {
			this.options.onDismiss?.();
			this.done();
		} else if (data === "w" || data === "W") {
			const incId = this.options.telemetry.incidentId || this.options.incident?.id || "active";
			const baseUrl = resolveCpamcBaseUrl();
			const pluginTarget = process.platform === "win32"
				? "auto-switcher-pro-windows-amd64"
				: process.platform === "darwin"
					? "auto-switcher-pro-darwin-arm64"
					: "auto-switcher-pro-linux-amd64";
			const directUrl = `${baseUrl}/management.html#/plugin-pages/${pluginTarget}/2#incident-${incId}`;
			exec(`xdg-open "${directUrl}" 2>/dev/null || open "${directUrl}" 2>/dev/null || true`);
			this.done();
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const innerW = Math.max(10, width - 4);
		const lines: string[] = [];

		const inc = this.options.incident || this.options.telemetry.lastIncident;
		const reason =
			this.options.telemetry.circuitBreakerReason ||
			inc?.incident_type ||
			"CYCLE_DETECTED";

		const reasonLabel =
			reason === "CYCLE_DETECTED"
				? "Ciclo repetitivo detectado (x3)"
				: reason === "PROHIBITED_COMMAND"
					? "Comando host de diagnóstico prohibido"
					: reason === "STEP_BUDGET_EXCEEDED"
						? "Presupuesto máximo de acciones alcanzado (15/15)"
						: "Protección preventiva de velocidad upstream";

		const savedK = Math.max(
			1,
			Math.round((this.options.telemetry.tokensSavedEstimate || inc?.tokens_saved || 30000) / 1000),
		);
		const incId = inc?.id || this.options.telemetry.incidentId || "cb_unknown";

		const formatField = (label: string, value: string) => {
			const l = `${th.fg("dim", label)}:`;
			const pad = Math.max(1, 22 - visibleWidth(label) - 1);
			return `${l}${" ".repeat(pad)}${value}`;
		};

		lines.push("");
		lines.push(formatField("ID Incidente", th.fg("accent", incId)));
		lines.push(formatField("Diagnóstico", th.fg("error", reasonLabel)));
		lines.push(formatField("Tokens Protegidos", th.fg("success", `~${savedK}k tokens salvados`)));
		lines.push(formatField("Acciones Bloqueadas", th.fg("warning", `${inc?.actions_blocked || 1} acción(es)`)));
		lines.push("");

		const triggerCmd = inc?.trigger_command;
		if (triggerCmd) {
			lines.push(th.fg("dim", "Comando detonante:"));
			lines.push(`  ${th.fg("error", truncateToWidth(triggerCmd, innerW - 4))}`);
			lines.push("");
		}

		if (inc?.command_trace && inc.command_trace.length > 0) {
			lines.push(th.fg("dim", "Últimas acciones registradas:"));
			const traceSlice = inc.command_trace.slice(-3);
			for (const c of traceSlice) {
				lines.push(`  ${th.fg("dim", "•")} ${truncateToWidth(c, innerW - 6)}`);
			}
			lines.push("");
		}

		// Barra de acciones inferior
		const bar = `${th.fg("accent", "[ESC/Q]")} Cerrar  ${th.fg("accent", "[D]")} Descartar  ${th.fg("accent", "[W]")} Abrir Web`;
		lines.push(th.fg("border", "─".repeat(innerW)));
		lines.push(bar);

		// Enmarcar en caja centrada
		const titleStr = " 🛡️ AUTOPSIA DE SEGURIDAD [Auto Switcher Pro] ";
		const titleW = visibleWidth(titleStr);
		const topBorderLen1 = Math.max(1, Math.floor((innerW - titleW) / 2));
		const topBorderLen2 = Math.max(1, innerW - titleW - topBorderLen1);

		const result: string[] = [];
		result.push(
			`${th.fg("border", "╭" + "─".repeat(topBorderLen1))}${th.fg("accent", titleStr)}${th.fg("border", "─".repeat(topBorderLen2) + "╮")}`,
		);

		for (const l of lines) {
			const visW = visibleWidth(l);
			const sp = Math.max(0, innerW - visW);
			result.push(`${th.fg("border", "│ ")}${l}${" ".repeat(sp)}${th.fg("border", " │")}`);
		}

		result.push(`${th.fg("border", "╰" + "─".repeat(innerW + 2) + "╯")}`);
		return result;
	}

	invalidate(): void {}
	dispose(): void {}
}

/**
 * Abre el popup modal interactivo TUI de autopsia si la UI está disponible.
 */
export async function showIncidentModal(
	ctx: any,
	options: IncidentModalOptions,
): Promise<void> {
	if (!ctx?.hasUI || typeof ctx?.ui?.custom !== "function") {
		// Fallback para entornos sin UI interactiva
		const incId = options.telemetry.incidentId || options.incident?.id || "active";
		ctx?.ui?.notify?.(`🛡️ Autopsia de Incidente (${incId}). Ejecuta '/incident dismiss' para descartar.`, "info");
		return;
	}

	await ctx.ui.custom(
		(_tui: any, theme: any, _kb: any, done: () => void) =>
			new IncidentModalComponent(theme, options, done),
		{
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: 64,
				maxHeight: 22,
			},
		},
	);
}
