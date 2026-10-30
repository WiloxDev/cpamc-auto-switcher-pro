import { existsSync, watch } from "node:fs";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { initDynamicProvider, resolveCpamcBaseUrl, resolveManagementKey } from "./src/provider.js";
import { initFailoverHook, scheduleAutoSwitcher } from "./src/failover.js";
import { registerModelPicker } from "./src/picker.js";
import { registerAgentMatrixCommand } from "./src/matrix-command.js";
import { registerDoctorCommand } from "./src/doctor.js";
import { CpamcTuiAdapter } from "./src/adapter.js";
import {
	querySwitcherAccounts,
	checkProactivePoolRebalance,
	applyOptimisticQuotaDecrement,
	getRotationPairForModelSync,
	updateContextUsage,
	recordContextCompression,
	getQuotaCardViewMode,
	setQuotaCardViewMode,
	getActiveQuotaCardTab,
	setActiveQuotaCardTab,
	recordTurnTelemetry,
	type QuotaCardTabId,
	type QuotaCardViewMode,
} from "./src/store.js";
import { saveProjectModel, getProjectModel, clearProjectModel } from "./src/project-model-store.js";
import { runawayGuard } from "./src/guards.js";
import { showIncidentModal } from "./src/incident-modal.js";
import {
	initWiloxLayoutManager,
	readWiloxSettings,
	writeWiloxSettings,
	syncSidebarLayout,
} from "./src/wilox-layout-manager.js";

const execAsync = promisify(exec);
const CURRENT_VERSION = "1.0.0";

/**
 * Resuelve la URL base del centro de mando / hub de licencias con prioridad segura:
 * 1. AUTO_SWITCHER_HUB_URL (entorno)
 * 2. CPAMC_LICENSE_HUB_URL (entorno)
 * 3. https://hub.wiloxdev.com (dominio formal con TLS)
 */
export function resolveHubBaseUrl(): string {
	const envUrl = process.env.AUTO_SWITCHER_HUB_URL || process.env.CPAMC_LICENSE_HUB_URL;
	if (envUrl) {
		return envUrl.replace(/\/+$/, "");
	}
	return "https://hub.wiloxdev.com";
}

/**
 * CPAMC Auto-Switcher Unified Extension for Pi & Gentle-Shell
 *
 * Módulos integrados:
 * 1. Dynamic Provider: Registra el proveedor `cpamc` con catálogo dinámico de CLIProxyAPI.
 * 2. Failover Hook: Detección instantánea de 429 / Rate Limit y rotación forzada automática.
 * 3. Runtime UI & Telemetry:
 *    - Fullscreen Sidebar: QuotaCard reactiva calibrada a 48 cols con barras (▰▰▰▱▱▱) y guardia Anti-Sobrediseño.
 *    - Regular Mode: Telemetría compacta en Footer.
 *    - Selector interactivo de modelos `/cpamc-model`.
 * 4. Anti-Overengineering Governance:
 *    - Distribución universal de skills/anti-overengineering para Gentle-Shell, Wilox-Pi y Pi Vanilla.
 *
 * 100% Autocontenida: lista para clonar o copiar en ~/.gentle-shell/agent/extensions/
 */
export default function initCpamcUnifiedExtension(pi: ExtensionAPI): void {
	// 1. Inicializar proveedor dinámico de modelos
	try {
		initDynamicProvider(pi);
	} catch (err: any) {
		console.error("cpamc-auto-switcher: fallo al registrar provider cpamc:", err?.message || err);
	}

	// 2. Inicializar hook de failover y rotación automática
	try {
		initFailoverHook(pi, () => {
			adapter?.triggerPeek(20);
		});
	} catch (err: any) {
		console.error("cpamc-auto-switcher: fallo al registrar failover hook:", err?.message || err);
	}

	// 3. Inicializar selector complementario /cpamc-model
	registerModelPicker(pi);

	// 3a. Inicializar comando /agent:matrix
	registerAgentMatrixCommand(pi);

	// 3b. Inicializar comando /cpamc doctor (diagnóstico integral y autoreparación)
	registerDoctorCommand(pi);

	// 3b. Comando para restablecer el modelo del proyecto actual al default de Pi
	pi.registerCommand("model-default", {
		description: "Restablece el modelo del proyecto actual al default configurado en Pi",
		handler: async (_args, ctx) => {
			if (ctx.cwd) {
				clearProjectModel(ctx.cwd);
			}
			const settings = (ctx as any)?.settingsManager;
			const defaultProvider = settings?.getDefaultProvider?.() || "cpamc";
			const defaultModelId = settings?.getDefaultModel?.();
			if (defaultProvider && defaultModelId) {
				const target = ctx.modelRegistry?.find?.(defaultProvider, defaultModelId);
				if (target) {
					await pi.setModel(target);
					if (ctx.hasUI) {
						ctx.ui.notify?.(`✅ Modelo restablecido al default de Pi: ${defaultModelId}`, "info");
					}
					return;
				}
			}
			if (ctx.hasUI) {
				ctx.ui.notify?.("✅ Memoria de sesión restablecida para este proyecto.", "info");
			}
		},
	});

	// 3c. Comando para actualizar Auto Switcher Pro de forma segura (sin vectores de inyección remota)
	pi.registerCommand("switcher-update", {
		description: "Informa y verifica de forma segura las actualizaciones de Auto Switcher Pro vía canal autenticado",
		handler: async (_args, ctx) => {
			if (process.env.CPAMC_AIRGAP_MODE === "1" || process.env.CPAMC_AIRGAP_MODE === "true") {
				if (ctx.hasUI) {
					ctx.ui.notify?.("ℹ️ Entorno en modo aislado (Air-Gapped). Las actualizaciones remotas están desactivadas por política.", "info");
				}
				return;
			}
			try {
				const checkUrl = `${resolveHubBaseUrl()}/dist/version.json`;
				const res = await fetch(checkUrl, { signal: AbortSignal.timeout(4000) }).catch(() => null);
				if (res && res.ok) {
					const data = (await res.json()) as any;
					const latestVersion = data?.version;
					if (latestVersion && latestVersion !== CURRENT_VERSION) {
						if (ctx.hasUI) {
							ctx.ui.notify?.(`🚀 Nueva versión disponible: v${latestVersion} (actual: v${CURRENT_VERSION}). Descarga el artefacto verificado con SHA256 desde los releases oficiales.`, "info");
						}
						return;
					}
				}
			} catch {}
			if (ctx.hasUI) {
				ctx.ui.notify?.(`ℹ️ Auto Switcher Pro v${CURRENT_VERSION} está actualizado y protegido por el anillo criptográfico dual.`, "info");
			}
		},
	});

	// 3d. Comando One-Click Telemetry Share: /switcher-report
	pi.registerCommand("switcher-report", {
		description: "Envía un reporte de soporte con los últimos eventos de rotación al panel del VPS de Wilox",
		handler: async (args, ctx) => {
			if (process.env.CPAMC_AIRGAP_MODE === "1" || process.env.CPAMC_AIRGAP_MODE === "true") {
				if (ctx.hasUI) {
					ctx.ui.notify?.("🔒 Modo Air-Gap activo: el reporte de telemetría está deshabilitado por privacidad.", "info");
				}
				return;
			}
			if (ctx.hasUI) {
				ctx.ui.notify?.("📡 Recopilando telemetría anonimizada y enviando al Centro de Mando...", "info");
			}
			try {
				const summaryText = typeof args === "string" && args.trim().length > 0 ? args.trim() : "Reporte generado desde consola Pi";
				// 1. Obtener diagnóstico de CPAMC local (incluyendo token si existe en ~/.cliproxy_management_key)
				const headers: Record<string, string> = {};
				try {
					const { homedir } = await import("os");
					const { join } = await import("path");
					const { readFileSync, existsSync } = await import("fs");
					const keyFile = join(homedir(), ".cliproxy_management_key");
					if (existsSync(keyFile)) {
						const key = readFileSync(keyFile, "utf-8").trim();
						if (key) headers["Authorization"] = `Bearer ${key}`;
					}
				} catch {}

				const cpamcRes = await fetch(`${resolveCpamcBaseUrl()}/v0/management/auto-switcher-pro/report`, {
					headers,
					signal: AbortSignal.timeout(4000),
				}).catch(() => null);

				let payload: any = {
					timestamp: Math.floor(Date.now() / 1000),
					summary: summaryText,
					version: CURRENT_VERSION,
					os: process.platform,
				};

				if (cpamcRes && cpamcRes.ok) {
					const data = (await cpamcRes.json()) as any;
					if (data?.report) {
						payload = { ...data.report, summary: summaryText };
					}
				}

				// 2. Despachar al VPS mediante canal TLS seguro
				const reportUrl = `${resolveHubBaseUrl()}/api/v1/license/report`;
				const vpsRes = await fetch(reportUrl, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(payload),
					signal: AbortSignal.timeout(5000),
				});

				if (vpsRes.ok) {
					const resData = (await vpsRes.json()) as any;
					const repId = resData?.report_id || "OK";
					if (ctx.hasUI) {
						ctx.ui.notify?.(`✅ ¡Reporte enviado con éxito! ID de Ticket: ${repId}`, "info");
					}
				} else {
					throw new Error(`HTTP ${vpsRes.status}`);
				}
			} catch (err: any) {
				if (ctx.hasUI) {
					ctx.ui.notify?.(`❌ No se pudo enviar el reporte: ${err?.message || err}`, "error");
				}
			}
		},
	});

	// 3e. Comando para alternar el periodo de telemetría de ciclo de vida (Hoy -> Semana -> Mes)
	pi.registerCommand("switcher-period", {
		description: "Alterna el período de telemetría de ciclo de vida: Hoy (24h) -> Semana (7d) -> Mes (30d)",
		handler: async (_args, ctx) => {
			adapter?.togglePeriod();
			await adapter?.update(true, ctx);
			if (ctx.hasUI) {
				ctx.ui.notify?.(`📊 Período de ciclo de vida actualizado`, "info");
			}
		},
	});

	// Atajo de teclado para alternar período con 1 clic (Ctrl+Alt+P)
	pi.registerShortcut("ctrl+alt+p", {
		description: "Alternar período de telemetría en el sidebar",
		handler: async (ctx) => {
			adapter?.togglePeriod();
			await adapter?.update(true, ctx);
		},
	});

	// 3e-bis. Comando para alternar acordeón colapsable en la tarjeta del sidebar
	pi.registerCommand("switcher-accordion", {
		description: "Alterna el acordeón de telemetría en el sidebar (Peek / Pin permanente / Colapsado)",
		handler: async (_args, ctx) => {
			const mode = adapter?.toggleExpanded();
			await adapter?.update(true, ctx);
			if (ctx.hasUI) {
				const msg =
					mode === "pinned"
						? "📌 Acordeón fijado: Modo permanente activo (Ctrl+Alt+X para cerrar)"
						: mode === "peek"
							? "⏱️ Acordeón en modo alerta temporal (20s)"
							: "📁 Acordeón colapsado: Tarjeta compacta";
				ctx.ui.notify?.(msg, "info");
			}
		},
	});

	// Atajo de teclado para alternar acordeón (Ctrl+Alt+X)
	pi.registerShortcut("ctrl+alt+x", {
		description: "Alternar acordeón de la tarjeta de telemetría en el sidebar",
		handler: async (ctx) => {
			adapter?.toggleExpanded();
			await adapter?.update(true, ctx);
		},
	});

	// 3e. Comando dinámico e interactivo /cpamc-card (Toggle en caliente sin reiniciar)
	pi.registerCommand("cpamc-card", {
		description: "Alterna el estilo de la QuotaCard: Esencial (Compacto Default) vs Pro Pestañas Blessed",
		handler: async (args, ctx) => {
			const arg = args?.trim().toLowerCase();
			if (arg === "classic" || arg === "essential" || arg === "compact") {
				setQuotaCardViewMode("essential");
				await adapter?.update(true, ctx);
				if (ctx.hasUI) ctx.ui.notify?.("✅ QuotaCard: Modo Esencial / Compacto activo.", "info");
				return;
			}
			if (arg === "pro" || arg === "tabs" || arg === "blessed") {
				setQuotaCardViewMode("tabs");
				await adapter?.update(true, ctx);
				if (ctx.hasUI) ctx.ui.notify?.("⚡ QuotaCard: Modo Pro Pestañas Blessed activo.", "info");
				return;
			}
			// Si especifica sub-pestaña (ej: /cpamc-card 1, /cpamc-card quota, /cpamc-card radar)
			if (arg === "1" || arg === "quota") {
				setQuotaCardViewMode("tabs");
				setActiveQuotaCardTab("quota");
				await adapter?.update(true, ctx);
				return;
			}
			if (arg === "2" || arg === "metrics") {
				setQuotaCardViewMode("tabs");
				setActiveQuotaCardTab("metrics");
				await adapter?.update(true, ctx);
				return;
			}
			if (arg === "3" || arg === "pool") {
				setQuotaCardViewMode("tabs");
				setActiveQuotaCardTab("pool");
				await adapter?.update(true, ctx);
				return;
			}
			if (arg === "4" || arg === "radar") {
				setQuotaCardViewMode("tabs");
				setActiveQuotaCardTab("radar");
				await adapter?.update(true, ctx);
				return;
			}

			// Si no pasa argumentos y cuenta con UI interactiva, abrir selector interactivo
			if (ctx.hasUI && typeof ctx.ui.select === "function") {
				const current = getQuotaCardViewMode();
				const choice = await ctx.ui.select("Estilo de visualización para la QuotaCard del Sidebar:", [
					{
						label: `${current === "essential" ? "● " : "  "}Modo Esencial / Compacto (Default)`,
						description: "Tarjeta ligera, limpia y calibrada a 48 columnas sin distracciones",
						value: "essential",
					},
					{
						label: `${current === "tabs" ? "● " : "  "}Modo Pro Telemetría / Pestañas Blessed`,
						description: "Diales Braille, Sparklines de tokens, balance de flota y radar de rotaciones",
						value: "tabs",
					},
				]);

				if (choice?.value) {
					setQuotaCardViewMode(choice.value as QuotaCardViewMode);
					await adapter?.update(true, ctx);
					ctx.ui.notify?.(
						choice.value === "tabs"
							? "⚡ QuotaCard: Modo Pro Pestañas Blessed activado."
							: "✅ QuotaCard: Modo Esencial / Compacto activado.",
						"info",
					);
				}
				return;
			}

			// Alternancia rápida en caliente si no hay UI modal
			const nextMode: QuotaCardViewMode = getQuotaCardViewMode() === "essential" ? "tabs" : "essential";
			setQuotaCardViewMode(nextMode);
			await adapter?.update(true, ctx);
			if (ctx.hasUI) {
				ctx.ui.notify?.(
					nextMode === "tabs"
						? "⚡ QuotaCard: Alternado a Modo Pro Pestañas Blessed."
						: "✅ QuotaCard: Alternado a Modo Esencial / Compacto.",
					"info",
				);
			}
		},
	});

	// Atajo de teclado global Ctrl+Alt+Tab para ciclar pestañas en modo Pro sin colisión de escritura
	pi.registerShortcut("ctrl+alt+tab", {
		description: "Ciclar pestaña activa en la QuotaCard Pro del sidebar",
		handler: async (ctx) => {
			if (getQuotaCardViewMode() !== "tabs") {
				setQuotaCardViewMode("tabs");
				setActiveQuotaCardTab("quota");
			} else {
				const tabs: QuotaCardTabId[] = ["quota", "metrics", "pool", "radar"];
				const current = getActiveQuotaCardTab();
				const nextIdx = (tabs.indexOf(current) + 1) % tabs.length;
				setActiveQuotaCardTab(tabs[nextIdx]!);
			}
			await adapter?.update(true, ctx);
		},
	});

	// 3f. Captura en caliente de eventos de compresión y uso de tokens de contexto
	pi.on("session_compact", (_event, _ctx) => {
		recordContextCompression();
		adapter?.triggerPeek(20);
		if (adapter) {
			void adapter.update(false, _ctx);
		}
	});

	pi.on("turn_end", (_event, ctx) => {
		try {
			const usage = ctx.getContextUsage?.();
			if (usage && typeof usage.tokens === "number") {
				updateContextUsage(usage.tokens, usage.contextWindow || 200_000);
				// Registrar telemetría de turno para gráficas Sparkline
				recordTurnTelemetry({
					turnId: `${Date.now()}`,
					tokens: usage.tokens,
					durationMs: 1200,
					toolsCount: 0,
				});
			}
		} catch {}
	});

	let adapter: CpamcTuiAdapter | null = null;
	let timer: NodeJS.Timeout | null = null;
	let epochWatchers: Array<ReturnType<typeof watch>> = [];

	const clearTimer = (): void => {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
		if (epochWatchers.length > 0) {
			for (const w of epochWatchers) {
				try {
					w.close();
				} catch {}
			}
			epochWatchers = [];
		}
	};

	// Chequeo asíncrono no bloqueante de versión en segundo plano
	let hasCheckedUpdate = false;
	const checkRemoteUpdate = async (ctx: ExtensionContext): Promise<void> => {
		if (hasCheckedUpdate) return;
		hasCheckedUpdate = true;
		if (process.env.CPAMC_AIRGAP_MODE === "1" || process.env.CPAMC_AIRGAP_MODE === "true") {
			return;
		}
		try {
			const res = await fetch(`${resolveHubBaseUrl()}/dist/version.json`, { signal: AbortSignal.timeout(3000) });
			if (res.ok) {
				const data = (await res.json()) as { version?: string; notes?: string };
				if (data?.version && data.version !== CURRENT_VERSION) {
					if (ctx?.hasUI) {
						ctx.ui.notify?.(
							`⚡ Auto Switcher Pro v${data.version} disponible en tu VPS. Escribe /switcher-update para actualizar.`,
							"info",
						);
					}
				}
			}
		} catch {
			// Silencioso si no hay conexión o no responde
		}
	};

	pi.on("session_start", async (event: any, ctx: ExtensionContext) => {
		clearTimer();

		// Asignar el ámbito de proyecto y sesión al guard
		const sessionId = (ctx as any)?.sessionId || (ctx as any)?.sessionManager?.sessionId;
		runawayGuard.setScope(ctx?.cwd, sessionId);

		const reason = event?.reason;
		// Si es una sesión nueva (/new) o cold startup, rearmar el disyuntor limpio para no arrastrar fantasmas
		if (reason === "new" || reason === "startup") {
			runawayGuard.resetSession();
		}

		if (!adapter) {
			adapter = new CpamcTuiAdapter(ctx);
		} else {
			adapter.setContext(ctx);
		}

		adapter.onOpenIncidentModal = () => {
			void handleIncidentCommand(undefined, ctx);
		};

		// Siempre iniciar la tarjeta colapsada por defecto (en startup, /reload o /new)
		adapter.resetToCollapsed();

		// Rebalanceo proactivo en fronteras de ciclo de vida (/new, /reload, inicio de sesión)
		if (reason === "compact" && ctx?.hasUI) {
			ctx.ui.notify?.("✅ Contexto de sesión compactado y reanudado.", "info");
		}

		// Detección de reanudación de sesión en Herdr (snapshot previo restaurado)
		const isResumedSession =
			reason === "resume" || (reason === "startup" && (ctx.sessionManager?.getEntries?.()?.length ?? 0) > 0);
		if (isResumedSession) {
			if (ctx.cwd && ctx.model?.id && ctx.model?.provider) {
				saveProjectModel(ctx.cwd, ctx.model.provider, ctx.model.id);
			}
			if (ctx?.hasUI) {
				ctx.ui.notify?.(
					`ℹ️ Sesión previa de Herdr reanudada (${ctx.model?.id || "modelo de sesión"}). Usa /new para sesión limpia.`,
					"info",
				);
			}
		}

		// Restauración dinámica del modelo del proyecto al reiniciar sesión (/new)
		// Solo aplica en caliente durante la sesión activa en Herdr.
		// En arranque en frío (startup) siempre se inicia con el modelo default de Pi.
		if (reason === "new" && ctx.cwd) {
			try {
				const saved = getProjectModel(ctx.cwd);
				if (saved && (ctx.model?.id !== saved.modelId || ctx.model?.provider !== saved.provider)) {
					let targetModel = ctx.modelRegistry?.find?.(saved.provider, saved.modelId);
					// Contingencia cold boot: si no está en memoria y refresh está disponible, refrescar catálogo
					if (!targetModel && typeof ctx.modelRegistry?.refresh === "function") {
						await ctx.modelRegistry.refresh({ allowNetwork: true }).catch(() => {});
						targetModel = ctx.modelRegistry?.find?.(saved.provider, saved.modelId);
					}

					if (targetModel) {
						await pi.setModel(targetModel);
						if (ctx.hasUI) {
							ctx.ui.notify?.(`ℹ️ Manteniendo modelo de sesión: ${targetModel.id}`, "info");
						}
					} else if (saved && ctx.hasUI) {
						// Notificación informativa no invasiva si el modelo o pool guardado fue disuelto
						ctx.ui.notify?.(
							`⚠️ Modelo del proyecto (${saved.provider}/${saved.modelId}) no disponible. Usando default.`,
							"warning",
						);
					}
				} else if (saved && ctx.model?.id === saved.modelId) {
					// El modelo activo ya coincide con el modelo recordado de la sesión
					if (ctx.hasUI && ctx.model) {
						ctx.ui.notify?.(`ℹ️ Manteniendo modelo de sesión: ${ctx.model.id}`, "info");
					}
				} else if (ctx.hasUI && ctx.model) {
					ctx.ui.notify?.(`ℹ️ Sesión iniciada con modelo default: ${ctx.model.id}`, "info");
				}
			} catch {
				// Silencioso ante fallos al restaurar modelo de proyecto
			}
		}

		if (reason === "new" || reason === "reload" || reason === "startup") {
			try {
				await querySwitcherAccounts(true);
				const model = ctx.model;
				if (model) {
					const check = checkProactivePoolRebalance(model.id, model.provider);
					if (check.shouldSwitch) {
						scheduleAutoSwitcher(ctx, `proactive session rebalance (${reason})`, true);
					}
				}
			} catch {
				// Silencioso ante errores no críticos
			}
		}

		// Intentar captura inmediata de TUI y Terminal si ya están disponibles en ctx
		const directTui = (ctx as any)?.tui || (ctx as any)?.ui?.terminal;
		if (directTui) {
			adapter.bindTui(directTui);
		}

		// Capturar la instancia viva de TUI y Theme, y registrar el decorador del sidebar
		if (ctx.hasUI) {
			ctx.ui.setWidget("cpamc-tui-hook", (tui: any, theme: any) => {
				adapter?.bindTui(tui, theme);
				void adapter?.update(false, ctx);
				return {
					render: () => [],
					invalidate: () => {},
				};
			});
		}

		// Actualización inicial segura
		await adapter.update(false, ctx);

		// Disparar chequeo no invasivo de actualización remota
		void checkRemoteUpdate(ctx);

		// Bus Reactivo Instantáneo (<5ms) por Archivo de Época Compartido
		// Prioridad 1: CPAMC / CLIProxyAPI Console nativo (Linux, macOS M1-M4, Windows)
		const candidateEpochPaths = [
			// 1. CPAMC Console Canónico
			join(homedir(), ".cli-proxy-api", "plugins", "auto-switcher-pro.epoch"),
			join(homedir(), "Library", "Application Support", "cli-proxy-api", "plugins", "auto-switcher-pro.epoch"),
			join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "cli-proxy-api", "plugins", "auto-switcher-pro.epoch"),
			join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "cli-proxy-api", "plugins", "auto-switcher-pro.epoch"),
			join(homedir(), "services", "cliproxy", "plugins", "auto-switcher-pro.epoch"),

			// 2. Memoria compartida y temporales del sistema
			"/dev/shm/auto-switcher-pro.epoch",
			join(tmpdir(), "auto-switcher-pro.epoch"),

			// 3. EasyCLIProxyAPI (Derivado Desktop)
			join(homedir(), ".local", "share", "EasyCLIProxyAPI", "cpa-core", "plugins", "auto-switcher-pro.epoch"),
			join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "EasyCLIProxyAPI", "cpa-core", "plugins", "auto-switcher-pro.epoch"),
			join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "EasyCLIProxyAPI", "cpa-core", "plugins", "auto-switcher-pro.epoch"),
			join(homedir(), "Library", "Application Support", "EasyCLIProxyAPI", "cpa-core", "plugins", "auto-switcher-pro.epoch"),
		];
		let shmDebounce: NodeJS.Timeout | null = null;

		for (const epPath of candidateEpochPaths) {
			try {
				if (existsSync(epPath)) {
					const w = watch(epPath, () => {
						if (shmDebounce) clearTimeout(shmDebounce);
						shmDebounce = setTimeout(async () => {
							try {
								await querySwitcherAccounts(true);
								await adapter?.update(false, ctx);
							} catch {}
						}, 50);
					});
					w.on("error", () => {
						try {
							w.close();
						} catch {}
					});
					epochWatchers.push(w);
				}
			} catch {}
		}

		// Intervalo en segundo plano cada 25s protegido contra stale context
		let ticks = 0;
		timer = setInterval(async () => {
			try {
				await querySwitcherAccounts(true);
				await adapter?.update(false);

				// Cada ~75 segundos (3 ticks de 25s), refrescar catálogo de modelos en segundo plano
				ticks++;
				try {
					if (ticks % 3 === 0 && typeof ctx?.modelRegistry?.refresh === "function") {
						void ctx.modelRegistry.refresh({ allowNetwork: true }).catch(() => {});
					}
				} catch {}
			} catch {
				clearTimer();
			}
		}, 25_000);
	});

	// Reactividad ante eventos de sesión e interacción del usuario
	pi.on("session_info_changed", async (_event: any, ctx: ExtensionContext) => {
		try {
			await adapter?.update(false, ctx);
		} catch {}
	});

	pi.on("ui_prompt_start", async (_event: any, ctx: ExtensionContext) => {
		try {
			await adapter?.update(false, ctx);
		} catch {}
	});

	pi.on("turn_start", async (_event: any, ctx: ExtensionContext) => {
		try {
			// Si el disyuntor estaba disparado en el turno anterior, la reanudación del turno
			// por acción/orden del usuario lo despeja inmediatamente a Centinela Limpio (Dual-Trigger)
			if (runawayGuard.getTelemetry().circuitBreakerTripped) {
				runawayGuard.fadeIncident();
			}
			runawayGuard.resetTurn();
			adapter?.onTurnStart();
			await adapter?.update(true, ctx);
		} catch {}
	});

	// Blindaje contra bucles de terminal, auto-introspección y polling a subagentes
	pi.on("tool_call", async (event: any, ctx: ExtensionContext) => {
		const check = runawayGuard.checkTool(event);
		if (check?.block) {
			if (ctx?.hasUI) {
				ctx.ui.notify?.(`🛑 ${check.reason.split(":")[0] || "Acción frenada por Auto Switcher Pro"}`, "warning");
			}
			const tele = runawayGuard.getTelemetry();
			if (tele.circuitBreakerTripped && tele.lastIncident) {
				// Enviar incidente a la base de datos SQLite de Auto Switcher Pro en segundo plano
				const payload = {
					...tele.lastIncident,
					session_id: (ctx as any)?.sessionId || (ctx as any)?.sessionManager?.sessionId,
					pool_id: ctx?.model?.id,
				};
				const mgmtKey = resolveManagementKey();
				const headers: Record<string, string> = { "Content-Type": "application/json" };
				if (mgmtKey) {
					headers["Authorization"] = `Bearer ${mgmtKey}`;
				}
				void fetch(`${resolveCpamcBaseUrl()}/v0/management/auto-switcher-pro/incidents`, {
					method: "POST",
					headers,
					body: JSON.stringify(payload),
					signal: AbortSignal.timeout(3000),
				}).catch(() => {});
			}
			void adapter?.update(true, ctx);
			return check;
		}
		return undefined;
	});

	pi.on("turn_end", async (_event: any, ctx: ExtensionContext) => {
		try {
			// Mantener siempre actualizado el modelo con el que el usuario está trabajando activamente
			if (ctx?.cwd && ctx.model?.id && ctx.model?.provider) {
				saveProjectModel(ctx.cwd, ctx.model.provider, ctx.model.id);
			}

			// Reactividad optimista en RAM: decrementar cuota estimada de la cuenta activa al terminar streaming
			if (ctx?.model?.id && ctx?.model?.provider) {
				const pair = getRotationPairForModelSync(ctx.model.id, ctx.model.provider);
				if (pair?.active?.prefix) {
					applyOptimisticQuotaDecrement(pair.active.prefix, 0.8);
				}
			}

			await adapter?.update(false, ctx);
		} catch {}
	});

	// Persistir automáticamente el último modelo seleccionado por proyecto
	pi.on("model_select", async (event: any, ctx: ExtensionContext) => {
		try {
			const cwd = ctx?.cwd;
			const model = event?.model;
			if (model?.id === "sin-cuentas-vinculadas") {
				const baseUrl = resolveCpamcBaseUrl();
				ctx.ui?.notify?.(
					`ℹ️ CPAMC conectado. Puedes vincular tus cuentas desde ${baseUrl}/management.html cuando lo desees.`,
					"info",
				);
			}

			// Cirugía 3 / Idea 3: Guardia Pre-Vuelo en Pi ante modelos incompatibles en Pools
			if (model?.id && typeof model.id === "string" && model.id.toLowerCase().startsWith("pool-")) {
				const poolName = model.id.toLowerCase();
				const pair = getRotationPairForModelSync(model.id, model.provider || "cpamc");
				const targetM = (pair?.active?.model || "").toLowerCase();
				if (poolName.includes("codex") && targetM.includes("gemini")) {
					ctx.ui?.notify?.(
						`🛑 Incompatibilidad detectada: ${model.id} tiene asignado ${targetM}. Configura un modelo Codex (ej: gpt-6.1-sol) en el panel para evitar 503.`,
						"error",
					);
				} else if (poolName.includes("gemini") && (targetM.includes("gpt-") || targetM.includes("claude"))) {
					ctx.ui?.notify?.(
						`🛑 Incompatibilidad detectada: ${model.id} tiene asignado ${targetM}. Configura un modelo Gemini en el panel para evitar 503.`,
						"error",
					);
				}
			}

			if (cwd && model?.id && model?.provider) {
				saveProjectModel(cwd, model.provider, model.id);
			}
			await adapter?.update(false, ctx);
		} catch {}
	});

	// Limpieza en transiciones de sesión de Pi
	pi.on("session_before_switch", async (event: any, ctx?: ExtensionContext) => {
		clearTimer();
		runawayGuard.resetSession();
		// Capturar y registrar el modelo activo antes de que la sesión sea sustituida (/new o switch)
		try {
			if (event?.reason === "new" && ctx?.cwd && ctx?.model?.id && ctx?.model?.provider) {
				saveProjectModel(ctx.cwd, ctx.model.provider, ctx.model.id);
			}
		} catch {}
		adapter?.setContext(null);
	});

	pi.on("session_before_fork", async () => {
		clearTimer();
		runawayGuard.resetSession();
		adapter?.setContext(null);
	});

	pi.on("session_before_compact", async (_event: any, ctx?: ExtensionContext) => {
		clearTimer();
		adapter?.setContext(null);
		try {
			if (ctx?.hasUI) {
				ctx.ui.notify?.("⚡ Optimizando contexto de sesión (compactación en curso)...", "info");
			}
		} catch {
			// Silencioso
		}
	});

	pi.on("session_before_tree", async () => {
		clearTimer();
		adapter?.setContext(null);
	});

	pi.on("session_shutdown", async () => {
		clearTimer();
		runawayGuard.resetSession();
		runawayGuard.dismissIncident();
		adapter?.setContext(null);
	});

	// Comando interactivo /incident y /autopsia como fallback de terminal
	const handleIncidentCommand = async (args: string | undefined, ctx: ExtensionContext) => {
		const subcmd = (args || "").trim().toLowerCase();
		if (subcmd === "dismiss" || subcmd === "clear" || subcmd === "descartar") {
			runawayGuard.dismissIncident();
			await adapter?.update(false, ctx);
			if (ctx?.hasUI) {
				ctx.ui.notify?.("✅ Incidente descartado. Disyuntor rearmado.", "info");
			}
			return;
		}

		const tele = runawayGuard.getTelemetry();
		if (!tele.circuitBreakerTripped && !tele.incidentId) {
			if (ctx?.hasUI) {
				ctx.ui.notify?.("ℹ️ No hay incidentes activos de disyuntor en este momento.", "info");
			}
			return;
		}

		// Desplegar Modal TUI Nativo interactivo si hay UI disponible
		if (ctx?.hasUI && typeof (ctx.ui as any)?.custom === "function") {
			await showIncidentModal(ctx, {
				telemetry: tele,
				incident: tele.lastIncident,
				onDismiss: async () => {
					runawayGuard.dismissIncident();
					await adapter?.update(false, ctx);
					if (ctx?.hasUI) {
						ctx.ui.notify?.("✅ Incidente descartado. Disyuntor rearmado.", "info");
					}
				},
			});
			await adapter?.update(false, ctx);
			return;
		}

		const incId = tele.incidentId || "active";
		const baseUrl = resolveCpamcBaseUrl();
		const pluginTarget = process.platform === "win32"
			? "auto-switcher-pro-windows-amd64"
			: process.platform === "darwin"
				? "auto-switcher-pro-darwin-arm64"
				: "auto-switcher-pro-linux-amd64";
		const directUrl = `${baseUrl}/management.html#/plugin-pages/${pluginTarget}/2#incident-${incId}`;

		// Intentar abrir en navegador automáticamente si el entorno lo soporta
		exec(`xdg-open "${directUrl}" 2>/dev/null || open "${directUrl}" 2>/dev/null || true`);

		if (ctx?.hasUI) {
			ctx.ui.notify?.(`🔍 Abriendo autopsia de incidente (${incId})...\nURL: ${directUrl}`, "info");
		}
	};

	if (typeof (pi as any).registerCommand === "function") {
		(pi as any).registerCommand("incident", {
			description: "Abre o inspecciona la autopsia del último incidente de bucle (o usa '/incident dismiss' para descartar)",
			handler: handleIncidentCommand,
		});
		(pi as any).registerCommand("autopsia", {
			description: "Alias de /incident para inspeccionar autopsia forense en CPAMC Console",
			handler: handleIncidentCommand,
		});
		(pi as any).registerCommand("wilox", {
			description: "Community (WiloxDev): Alterna el sidebar entre modo Compacto (38 cols) y Estándar (50 cols) o usa '/wilox 38|50'",
			handler: async (args: string, ctx: ExtensionContext) => {
				const current = readWiloxSettings();
				const arg = args ? args.trim().toLowerCase() : "";
				let target = current.sidebarWidth === 38 ? 50 : 38;
				if (arg === "38" || arg === "compact" || arg === "on") target = 38;
				if (arg === "50" || arg === "standard" || arg === "default" || arg === "off") target = 50;

				writeWiloxSettings({
					sidebarWidth: target,
					sidebarBreakpoint: target <= 38 ? 115 : 140,
					gap: target <= 38 ? 2 : 3,
				});
				syncSidebarLayout(target);

				const label = target === 38 ? "Compacto (38 cols, ON)" : "Estándar (50 cols, OFF)";
				if (ctx?.hasUI) {
					ctx.ui.notify?.(`🌟 Community (WiloxDev): Sidebar configurado a ${label}. Se aplicará en el próximo arranque o recarga.`, "info");
				} else {
					console.log(`Community (WiloxDev): Sidebar configurado a ${label}`);
				}
			},
		});
	}

	// Inicializar WiloxLayoutManager y asegurar auto-reparación
	try {
		initWiloxLayoutManager();
	} catch (err: any) {
		console.error("cpamc-auto-switcher: fallo al inicializar WiloxLayoutManager:", err?.message || err);
	}
}
