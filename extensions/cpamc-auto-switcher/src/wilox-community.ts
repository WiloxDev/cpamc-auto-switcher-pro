/**
 * Protocolo de Acordeón Modular WiloxDev para Gentle Shell (/gentle:customize)
 * Integración nativa de la tarjeta CPAMC Sentinel · Cuota, Telemetría & Cuidado del Chat.
 */

import {
	getQuotaCardViewMode,
	setQuotaCardViewMode,
	getActiveQuotaCardTab,
	setActiveQuotaCardTab,
	saveQuotaCardPreferences,
	type QuotaCardViewMode,
	type QuotaCardTabId,
} from "./store.js";
import { runawayGuard } from "./guards.js";

export const COMMUNITY_REGISTRY_SLOT = Symbol.for("gentle-pi.community.wiloxdev.registry");
export const COMMUNITY_EXPANDED_SLOT = Symbol.for("gentle-pi.community.wiloxdev.expanded");

export interface WiloxCommunityRow {
	id: string;
	label: () => string;
	preview: () => { title: string; sample: string };
	action: (inline?: any) => void | Promise<void>;
}

export interface WiloxCommunityModule {
	id: string;
	title: string;
	order?: number;
	summary: () => string;
	rows: WiloxCommunityRow[];
}

export interface CpamcSentinelAdapterContract {
	isEnabled?(): boolean;
	toggleEnabled?(): boolean;
	setEnabled?(val: boolean): void;
	getPeriodLabel?(): string;
	togglePeriod?(): string;
	getAccordionMode?(): string;
	toggleExpanded?(): string;
	update?(force?: boolean, ctx?: any): Promise<void>;
}

export function registerCpamcSentinelCustomizeModule(
	adapter: CpamcSentinelAdapterContract,
	tui?: any,
): () => void {
	const registry = ((globalThis as any)[COMMUNITY_REGISTRY_SLOT] ??= new Map<string, WiloxCommunityModule>());

	const moduleDef: WiloxCommunityModule = {
		id: "cpamc-sentinel",
		title: "CPAMC Sentinel · Cuota, Telemetría & Cuidado del Chat",
		order: 10,
		summary: () => {
			const enabled = adapter.isEnabled?.() ?? true;
			if (!enabled) return "Disabled";
			const mode = getQuotaCardViewMode();
			return mode === "essential" ? "Active · Panel Unificado" : "Active · Dashboard Multitab";
		},
		get rows(): WiloxCommunityRow[] {
			const isEnabled = adapter.isEnabled?.() ?? true;

			// 1. Master Switch con Progressive Disclosure
			const masterRow: WiloxCommunityRow = {
				id: "sentinel-master-status",
				label: () => `Módulo Centinela: [${isEnabled ? "ON" : "OFF"}]`,
				preview: () => ({
					title: "CPAMC Sentinel · Master Switch",
					sample: isEnabled
						? "[ON] Centinela activo: telemetría en vivo, rotación de cuentas y protección de turnos."
						: "[OFF] Centinela desactivado: oculta la tarjeta del sidebar y libera espacio en pantalla.",
				}),
				action: () => {
					adapter.toggleEnabled?.();
					adapter.update?.(true);
					tui?.requestRender?.();
				},
			};

			if (!isEnabled) {
				return [masterRow];
			}

			// 2. Arquitectura Visual (Panel Unificado vs Dashboard Multitab)
			const currentMode = getQuotaCardViewMode();
			const modeDisplay = currentMode === "essential" ? "Panel Unificado" : "Dashboard Multitab";
			const styleRow: WiloxCommunityRow = {
				id: "sentinel-architecture-mode",
				label: () => `Arquitectura Visual: [${modeDisplay}]`,
				preview: () => {
					if (currentMode === "essential") {
						return {
							title: "Arquitectura: Panel Unificado (38/48 cols)",
							sample: [
								"╭─ ⚡ POOL: Gemini ─ [○ Esperando] ──╮  • Relojes concéntricos 5H y Semanal",
								"│ ⏱ ▰▰▰▰▱▱▱▱  48%      ● Holgado │  • Ritmo coloquial en vivo",
								"│ Uso ▱▱▱▱▱▱▱▱   3%    97% libre │  • Líder y reserva de flota activa",
								"│ Líder: ⚡ m...o (Líder hace 14h)   │  • Escudo anti-bucle Cuidando el Chat",
								"│ 🛡[CENTINELA] ──────── ● En guardia │  • Acordeón colapsable con Ctrl+Alt+X",
								"╰────────────────────────────────────╯",
							].join("\n"),
						};
					}
					return {
						title: "Arquitectura: Dashboard Multitab (Blessed UNIX)",
						sample: [
							"╭─ ⚡ POOL: Gemini ────────────────╮  • 4 Cuadrantes interactivos:",
							"│ [1 CUOTA] 2 MÉTRICAS 3 POOL 4 RADAR │    [1] Diales Braille de precisión",
							"│  ⢀⣤⣴⣶⣾⣿   5H: 3%  · 97% libre │    [2] Sparklines de tokens por turno",
							"│  ⠿⣿⣿⣿⣿⠟  Sem: 74% · 26% libre│    [3] Balance y miembros de flota",
							"│ 💡 Navegación con números 1..4     │    [4] Bitácora radar y rescates 429",
							"╰──────────────────────────────────╯",
						].join("\n"),
					};
				},
				action: () => {
					const nextMode: QuotaCardViewMode = currentMode === "essential" ? "tabs" : "essential";
					setQuotaCardViewMode(nextMode);
					adapter.update?.(true);
					tui?.requestRender?.();
				},
			};

			const childRows: WiloxCommunityRow[] = [masterRow, styleRow];

			// 3. Sub-opciones exclusivas de Dashboard Multitab
			if (currentMode === "tabs") {
				const tabLabels: Record<QuotaCardTabId, string> = {
					quota: "1 CUOTA",
					metrics: "2 MÉTRICAS",
					pool: "3 POOL",
					radar: "4 RADAR",
				};

				childRows.push({
					id: "sentinel-active-tab",
					label: () => {
						const currentActive = getActiveQuotaCardTab();
						return `Pestaña Activa: [${tabLabels[currentActive] || currentActive.toUpperCase()}]`;
					},
					preview: () => {
						const currentActive = getActiveQuotaCardTab();
						return {
							title: `Pestaña Blessed: [${tabLabels[currentActive] || currentActive.toUpperCase()}]`,
							sample: [
								"Navega entre las vistas analíticas en tiempo real:",
								" • [1 CUOTA]:   Diales Braille concéntricos (consumo 5h y semanal).",
								" • [2 MÉTRICAS]: Gráficos Sparkline Unicode de tokens por turno.",
								" • [3 POOL]:    Tabla comparativa de todas las cuentas del pool.",
								" • [4 RADAR]:   Registro forense de rotaciones, cooling y 429.",
							].join("\n"),
						};
					},
					action: () => {
						const currentActive = getActiveQuotaCardTab();
						const order: QuotaCardTabId[] = ["quota", "metrics", "pool", "radar"];
						const nextIdx = (order.indexOf(currentActive) + 1) % order.length;
						setActiveQuotaCardTab(order[nextIdx]!);
						adapter.update?.(true);
						tui?.requestRender?.();
					},
				});
			}

			// 4. Cuidado del Chat (Defensa y Centinela)
			const isBreakerArmado = true;
			childRows.push({
				id: "sentinel-chat-guard",
				label: () => `Cuidado del Chat: [${isBreakerArmado ? "Blindado" : "Flexible"}]`,
				preview: () => ({
					title: "Cuidado del Chat · Centinela Anti-Bucle",
					sample: [
						"🛡[CENTINELA] ──────── ● En guardia",
						" • Intercepción de bucles cíclicos (3 comandos idénticos repetidos).",
						" • Límite máximo de 15 acciones continuas por turno (Anti-Runaway).",
						" • Bloqueo de lecturas masivas en bash y comandos host prohibidos.",
						" • Disyuntor automático con autopsia forense y diagnóstico en CPAMC.",
					].join("\n"),
				}),
				action: () => {
					// Toggle feedback en UI
					tui?.requestRender?.();
				},
			});

			// 5. Período Histórico (24h / 7d / 30d)
			childRows.push({
				id: "sentinel-period",
				label: () => `Período Histórico: [${adapter.getPeriodLabel?.() || "Hoy (24h)"}]`,
				preview: () => {
					const curPeriod = adapter.getPeriodLabel?.() || "Hoy (24h)";
					return {
						title: "Ventana de Ciclo de Vida y Telemetría",
						sample: [
							`Período actual: [${curPeriod}]`,
							"Define la ventana de tiempo para calcular:",
							" • Cantidad de rotaciones acumuladas.",
							" • Porcentaje de afinidad de prompt caching.",
							" • Historial de causas de rotación y rescates 429.",
						].join("\n"),
					};
				},
				action: () => {
					adapter.togglePeriod?.();
					adapter.update?.(true);
					tui?.requestRender?.();
				},
			});

			// 6. Acordeón Base (Colapsado / Fijado)
			childRows.push({
				id: "sentinel-accordion",
				label: () => {
					const curAcc = adapter.getAccordionMode?.() || "collapsed";
					return `Acordeón Base: [${curAcc === "pinned" ? "Fijado" : "Colapsado"}]`;
				},
				preview: () => {
					const curAcc = adapter.getAccordionMode?.() || "collapsed";
					const display = curAcc === "pinned" ? "Fijado" : "Colapsado";
					return {
						title: `Acordeón: [${display}] (Atajo: Ctrl+Alt+X)`,
						sample: curAcc === "pinned"
							? "[Fijado] Muestra siempre la autopsia completa de contexto, tokens y líderes."
							: "[Colapsado] Vista compacta de 19 líneas optimizada para concentración.",
					};
				},
				action: () => {
					adapter.toggleExpanded?.();
					adapter.update?.(true);
					tui?.requestRender?.();
				},
			});

			return childRows;
		},
	};

	registry.set(moduleDef.id, moduleDef);

	return () => {
		if (registry.get(moduleDef.id) === moduleDef) {
			registry.delete(moduleDef.id);
		}
	};
}
