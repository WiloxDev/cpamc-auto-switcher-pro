import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { classifyModel, querySwitcherAccounts, getAvailableQuotaForPrefix } from "./store.js";

/**
 * Registra el comando interactivo opcional `/cpamc-model` con decoradores de rol (`👑` Líder vs `🔄` Reserva)
 * y ordenamiento inteligente por menor uso (Least-Used) basado en la cuota en tiempo real.
 */
export function registerModelPicker(pi: any): void {
	pi.registerCommand("cpamc-model", {
		description: "Seleccionar modelo con indicador de líderes de rotación (👑), cuotas en vivo y auto-balance",
		handler: async (args: string, cmdCtx: ExtensionContext) => {
			const context = cmdCtx;

			// 1. Refrescar activamente el catálogo de modelos en el registro de Pi
			if (typeof context.modelRegistry?.refresh === "function") {
				try {
					await context.modelRegistry.refresh({ allowNetwork: true });
				} catch {
					// En caso de fallo de red, se mantiene el catálogo disponible en caché
				}
			}

			// 2. Asegurar que la telemetría y líderes de cuentas del switcher estén frescos
			await querySwitcherAccounts(true);

			const availableModels: Model<any>[] = context.modelRegistry?.getAvailable?.() || [];

			if (availableModels.length === 0) {
				context.ui?.notify("No hay modelos disponibles en el registro de Pi.", "warning");
				return;
			}

			// Notificación asistida si el único modelo de CPAMC es el aviso de vinculación pendiente
			const hasOnlyPlaceholder = availableModels.some((m) => m.id === "sin-cuentas-vinculadas") &&
				availableModels.filter((m) => m.id !== "sin-cuentas-vinculadas" && (m.provider === "cpamc" || m.provider === "cliproxyapi")).length === 0;

			if (hasOnlyPlaceholder) {
				context.ui?.notify(
					"ℹ️ CPAMC está conectado. Puedes vincular cuentas desde http://localhost:8317/management.html cuando desees usarlas.",
					"info",
				);
				return;
			}

			const target = args?.trim().toLowerCase();

			// Soporte para auto-balance inteligente mediante argumento (ej: `/cpamc-model auto` o `/cpamc-model best`)
			if (target === "auto" || target === "best" || target === "gemini") {
				const geminiModels = availableModels.filter(
					(m) => m.id.includes("gemini") && (m.provider === "cpamc" || m.provider === "cliproxyapi"),
				);
				if (geminiModels.length > 0) {
					// Seleccionar el líder con mayor cuota libre
					let best = geminiModels[0]!;
					let bestQuota = -1;
					for (const m of geminiModels) {
						const meta = classifyModel(m.id, m.provider);
						const q = getAvailableQuotaForPrefix(meta.prefix);
						if (q > bestQuota) {
							bestQuota = q;
							best = m;
						}
					}
					pi.setModel(best);
					const meta = classifyModel(best.id, best.provider);
					context.ui?.notify(
						`🎯 Auto-Balance aplicado: ${meta.roleIcon}${meta.familyIcon} ${best.id} (Cuota libre: ${bestQuota}% · Líder Óptimo)`,
						"info",
					);
					return;
				}
			}

			// Si el usuario pasó un argumento directo de modelo (ej: `/cpamc-model agy2/gemini-3.8-flash-high`)
			if (args?.trim()) {
				const rawTarget = args.trim();
				const directMatch = availableModels.find(
					(m) => m.id === rawTarget || m.id.toLowerCase() === rawTarget.toLowerCase(),
				);
				if (directMatch) {
					pi.setModel(directMatch);
					const meta = classifyModel(directMatch.id, directMatch.provider);
					context.ui?.notify(
						`Modelo cambiado a: ${meta.roleIcon}${meta.familyIcon} ${directMatch.id} [${directMatch.provider}]`,
						"info",
					);
					return;
				}
			}

			// Desplegar menú de selección interactiva nativa enriquecida
			await showInteractivePicker(context, pi, availableModels);
		},
	});
}

async function showInteractivePicker(ctx: ExtensionContext, pi: any, models: Model<any>[]): Promise<void> {
	let currentModel: any = null;
	try {
		currentModel = ctx.model;
	} catch {
		// ctx may be stale
	}

	// Clasificar y evaluar cuotas para todos los modelos
	const enriched = models.map((m) => {
		const meta = classifyModel(m.id, m.provider);
		const isCurrent = currentModel?.id === m.id && currentModel?.provider === m.provider;
		const quota = meta.isCpamc ? getAvailableQuotaForPrefix(meta.prefix) : 0;
		return {
			model: m,
			meta,
			isCurrent,
			quota,
			isBestCandidate: false,
		};
	});

	// Identificar el mejor candidato para cada familia de líderes
	const familyMaxQuota = new Map<string, number>();
	for (const item of enriched) {
		if (item.meta.isLeader && item.quota > 0) {
			const cur = familyMaxQuota.get(item.meta.familyLabel) ?? -1;
			if (item.quota > cur) {
				familyMaxQuota.set(item.meta.familyLabel, item.quota);
			}
		}
	}
	for (const item of enriched) {
		if (item.meta.isLeader && item.quota > 0) {
			const max = familyMaxQuota.get(item.meta.familyLabel);
			if (max !== undefined && item.quota === max) {
				item.isBestCandidate = true;
			}
		}
	}

	// Ordenamiento inteligente (Least-Used First):
	// 1. Líderes activos (👑), ordenados de MAYOR cuota libre a MENOR cuota libre.
	// 2. Directos (/login).
	// 3. Reservas (🔄).
	enriched.sort((a, b) => {
		if (a.meta.isLeader && !b.meta.isLeader) return -1;
		if (!a.meta.isLeader && b.meta.isLeader) return 1;

		if (a.meta.isLeader && b.meta.isLeader) {
			// Si son de la misma familia, el que tenga más cuota va primero (Least-Used)
			if (a.meta.familyLabel === b.meta.familyLabel) {
				if (b.quota !== a.quota) {
					return b.quota - a.quota;
				}
			}
		}

		if (!a.meta.isReserve && b.meta.isReserve) return -1;
		if (a.meta.isReserve && !b.meta.isReserve) return 1;
		return a.model.id.localeCompare(b.model.id);
	});

	// Construir etiquetas de texto formateadas para el selector nativo de Pi (string[])
	const labels = enriched.map((item) => {
		const marker = item.isCurrent ? "▸ " : "  ";
		const badge = `[${item.model.provider}]`;
		const quotaBadge = item.meta.isLeader && item.quota > 0 ? ` · ${Math.round(item.quota)}% libre` : "";
		const bestBadge = item.isBestCandidate && item.quota > 0 ? " · ⭐ Recomendado" : "";

		const roleBadge = item.meta.isLeader
			? `⚡ Líder${quotaBadge}${bestBadge}`
			: item.meta.isReserve
				? "💤 Reserva"
				: "⚡ Directo";

		return `${marker}${item.meta.roleIcon}${item.meta.familyIcon} ${item.model.id}  ${badge}  (${roleBadge})`;
	});

	if (typeof ctx.ui?.select !== "function") {
		// Fallback para entornos no interactivos
		ctx.ui?.notify("Selector interactivo de Pi no disponible en este entorno.", "warning");
		return;
	}

	const selectedLabel = await ctx.ui.select("Seleccionar Modelo (CPAMC Auto-Switcher · Balanceo Proactivo)", labels);
	if (!selectedLabel) return;

	const selectedIndex = labels.indexOf(selectedLabel);
	if (selectedIndex < 0) return;

	const selected = enriched[selectedIndex].model;
	pi.setModel(selected);
	const meta = classifyModel(selected.id, selected.provider);
	ctx.ui?.notify(`Modelo fijado: ${meta.roleIcon}${meta.familyIcon} ${selected.id}`, "info");
}
