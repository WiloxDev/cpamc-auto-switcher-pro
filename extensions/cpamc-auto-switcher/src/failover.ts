import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveCandidateBaseUrls, resolveCpamcBaseUrl } from "./provider.js";

const TIMEOUT_MS = 15_000;
const TERMINAL_STATUSES = new Set([
	"completed",
	"failed",
	"cancelled",
	"interrupted",
]);

const RATE_LIMIT_PATTERN =
	/\b429\b|rate.?limit|too many requests|quota|resource.?exhausted|\b502\b|\b503\b|\b504\b|service.?unavailable|bad.?gateway|gateway.?timeout|UNAVAILABLE|terminated|UND_ERR_BODY_TERMINATED|socket.?hang.?up|ECONNRESET|connection.?reset|connection.?refused|broken.?pipe|unexpected.?eof|\beof\b/i;

const AUTH_CONFIG_ERROR_PATTERN =
	/auth_not_found|incompatible_family_model|no active account matching model|invalid_model_for_provider/i;

function isRateLimitOrNetworkError(text: unknown): boolean {
	if (typeof text !== "string") return false;
	// Cirugía Falsa Rotación: Si el error es 503 auth_not_found o incompatibilidad de modelo estática,
	// NO clasificarlo como error de red ni cuota para evitar rotaciones cíclicas inútiles.
	if (AUTH_CONFIG_ERROR_PATTERN.test(text)) {
		return false;
	}
	return RATE_LIMIT_PATTERN.test(text);
}

function extractMessageText(message: any): string {
	if (!message) return "";
	if (typeof message.content === "string") return message.content;
	if (Array.isArray(message.content)) {
		return message.content
			.filter((c: any) => c && c.type === "text" && typeof c.text === "string")
			.map((c: any) => c.text)
			.join("")
			.trim();
	}
	return "";
}

function hasAnyToolCalls(message: any, toolResults?: unknown[]): boolean {
	if (Array.isArray(toolResults) && toolResults.length > 0) return true;
	if (Array.isArray(message?.content)) {
		return message.content.some((c: any) => c && c.type === "toolCall");
	}
	return false;
}

const DANGLING_CONNECTOR_PATTERN =
	/^(?:now|let'?s|let us|and|then|so|next|continuing|continuemos|a continuación|ahora|por lo tanto|procedo|procedemos|okay|ok|well)[.:,;…]?$/i;

/**
 * Compacta resultados masivos de herramientas para reducir drásticamente el consumo
 * de tokens en turnos de reanudación y auto-recovery.
 */
export function compactToolResultsForRecovery(toolResults?: unknown[]): string {
	if (!Array.isArray(toolResults) || toolResults.length === 0) {
		return "";
	}
	const chunks: string[] = [];
	for (const tr of toolResults) {
		if (!tr || typeof tr !== "object") continue;
		const r = tr as Record<string, any>;
		const content = typeof r.content === "string" ? r.content : (typeof r.text === "string" ? r.text : "");
		if (!content) continue;

		// Si el contenido supera 600 caracteres (aprox. 150 tokens), compactarlo
		if (content.length > 600) {
			const head = content.slice(0, 150).trim();
			const tail = content.slice(-250).trim();
			const omitted = content.length - 400;
			chunks.push(`[Herramienta previo: ${head}\n... [${omitted} caracteres omitidos para ahorro de tokens] ...\n${tail}]`);
		}
	}
	return chunks.length > 0 ? `\nContexto compactado previo:\n${chunks.join("\n")}` : "";
}

function isPrematureStop(message: any, toolResults?: unknown[]): boolean {
	if (!message || message.role !== "assistant") return false;
	if (message.stopReason !== "stop") return false;
	if (hasAnyToolCalls(message, toolResults)) return false;

	const text = extractMessageText(message).trim();
	if (!text) return false;

	// Si es una sola palabra colgante o frase ultra corta de transición
	if (text.length <= 40) {
		if (DANGLING_CONNECTOR_PATTERN.test(text)) return true;
		if (/(?:^|\s)(?:now|let'?s|a continuación|procedo a|voy a|next:?)[.:,;…]?$/i.test(text)) return true;
	}

	return false;
}

type TaskMeta = {
	id?: string;
	agent?: string;
	status?: string;
	mode?: string;
	effective_mode?: string;
	error?: string;
	result?: string;
};

type ToolDetails = {
	results?: unknown[];
	waited_task_ids?: unknown[];
};

function readTask(value: unknown): TaskMeta | undefined {
	if (!value || typeof value !== "object") return undefined;
	const source = value as Record<string, unknown>;
	const task: TaskMeta = {};

	for (const key of ["id", "agent", "status", "mode", "effective_mode", "error", "result"] as const) {
		if (typeof source[key] === "string") task[key] = source[key];
	}

	return Object.keys(task).length > 0 ? task : undefined;
}

// Module-level serialization and debouncing to prevent concurrent race conditions
let globalQueue: Promise<void> = Promise.resolve();
let lastForcedRunTime = 0;
const FORCED_DEBOUNCE_MS = 3_000;

let latestSystemPrompt = "";
const lastWarmupTimestamps = new Map<string, number>();

function triggerShadowWarmup(
	baseUrl: string,
	apiKey: string,
	reserveAccount: string,
	targetModel?: string,
	poolPrefix?: string,
): void {
	const now = Date.now();
	const lastWarmup = lastWarmupTimestamps.get(reserveAccount) || 0;
	// No emitir más de 1 warmup cada 4 minutos por cuenta (alineado al TTL de 5m de Google KV Cache)
	if (now - lastWarmup < 240_000) {
		return;
	}
	lastWarmupTimestamps.set(reserveAccount, now);

	// Disparar en segundo plano completamente asíncrono y desacoplado (fire-and-forget)
	setTimeout(async () => {
		try {
			const model = targetModel || "gemini-3.8-flash-high";
			const requestModel = poolPrefix ? `${poolPrefix}/${model}` : model;
			const promptContent = latestSystemPrompt || "Standby assistant ready.";

			const headers: Record<string, string> = {
				"Content-Type": "application/json",
				"X-Warmup-Target": reserveAccount,
			};
			if (apiKey) {
				headers["Authorization"] = `Bearer ${apiKey}`;
			}

			await fetch(`${baseUrl}/v1/chat/completions`, {
				method: "POST",
				headers,
				body: JSON.stringify({
					model: requestModel,
					messages: [
						{ role: "system", content: promptContent },
						{ role: "user", content: "ping" },
					],
					max_tokens: 1,
					temperature: 0,
				}),
				signal: AbortSignal.timeout(10_000),
			});
		} catch {
			// El shadow warmup es silencioso y defensivo
		}
	}, 150);
}

function notify(ctx: any, message: string, level: "info" | "warning" | "error" = "info"): void {
	try {
		ctx?.ui?.notify?.(message, level);
	} catch {
		// Notifications are best-effort
	}
}

async function attemptVirtualRotation(ctx: any, source?: string, force = false): Promise<boolean> {
	try {
		const candidateUrls = resolveCandidateBaseUrls();
		const keyFile = join(homedir(), ".cliproxy_management_key");
		let key = (process.env.CLIPROXYAPI_MANAGEMENT_KEY || "").trim();
		if (!key && existsSync(keyFile)) {
			key = readFileSync(keyFile, "utf-8").trim();
		}
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};
		if (key) {
			headers["Authorization"] = `Bearer ${key}`;
		}

		// Extraer el modelo activo y deducir el target pool_id / prefix si está disponible en el contexto
		let poolId = "";
		let prefix = "";
		const activeModelId = ctx?.model?.id || "";
		if (activeModelId) {
			const m = activeModelId.match(/^(Pool-\d+-[a-zA-Z0-9_-]+)/i);
			if (m) {
				poolId = m[1]!;
			} else {
				const slashIdx = activeModelId.indexOf("/");
				if (slashIdx > 0) {
					prefix = activeModelId.substring(0, slashIdx);
				}
			}
		}

		const payload: Record<string, any> = {
			reason: source || (force ? "failover" : "preventive"),
			force,
		};
		if (poolId) {
			payload.pool_id = poolId;
		}
		if (prefix) {
			payload.prefix = prefix;
		}

		for (const baseUrl of candidateUrls) {
			try {
				const res = await fetch(`${baseUrl}/v0/management/auto-switcher-pro/pools/rotate`, {
					method: "POST",
					headers,
					body: JSON.stringify(payload),
					signal: ctx?.signal,
				});
				if (res.ok) {
					const data = (await res.json()) as any;
					if (data?.ok) {
						// Si el backend indicó que el líder está sano y no fue necesario rotar (ahorro de caché)
						if (data.rotated === false) {
							if (data.warmup_needed && data.warmup_reserve) {
								triggerShadowWarmup(baseUrl, key, data.warmup_reserve, data.target_model, data.prefix);
							}
							return true;
						}

						const poolName = data.prefix || data.pool_id || poolId || "Pool";
						const newLeader = data.new_leader ? ` hacia ${data.new_leader.replace(/^antigravity-/, "").replace(/\.json$/, "")}` : "";
						if (force) {
							notify(ctx, `⚡ [Rescate Reactivo] ${poolName} rotó exitosamente${newLeader} para restaurar conexión`, "warning");
						}
						return true;
					}
				}
			} catch {
				// Siguiente URL candidata
			}
		}
	} catch {
		// Error general
	}
	return false;
}

function schedule(ctx: any, source: string, force = false): Promise<void> {
	if (force) {
		const now = Date.now();
		if (now - lastForcedRunTime < FORCED_DEBOUNCE_MS) {
			return globalQueue;
		}
		lastForcedRunTime = now;
	}

	const check = async (): Promise<void> => {
		try {
			// Rotación Virtual Pura en Auto Switcher Pro (en RAM, sin mutar credenciales físicas en disco)
			const virtualRotated = await attemptVirtualRotation(ctx, source, force);
			if (virtualRotated) {
				return;
			}

			// Si el backend virtual no respondió o falló, avisar honestamente sin corromper el disco
			if (force) {
				notify(ctx, `⚠️ Fallo al ejecutar rotación virtual de cuenta (${source}). Verifica la conectividad con CPAMC.`, "warning");
			}
		} catch (err: any) {
			notify(ctx, `cpamc-auto-switcher (${source}): ${err?.message || err}`, "warning");
		}
	};

	return (globalQueue = globalQueue.then(check, check));
}

export function scheduleAutoSwitcher(ctx: any, reason: string, force = false): void {
	schedule(ctx, reason, force);
}

export function initFailoverHook(pi: ExtensionAPI, onAlert?: () => void): void {

	// Capturar system prompt de la sesión para Ghost Warmup con inferencia real
	pi.on("before_agent_start", (event: any) => {
		if (typeof event?.systemPrompt === "string" && event.systemPrompt.trim()) {
			latestSystemPrompt = event.systemPrompt;
		}
	});

	// 1. Immediate detection of HTTP 429 response from provider before stream consumption
	pi.on("after_provider_response", (event: any, ctx: any) => {
		if (event?.status === 429) {
			onAlert?.();
			notify(ctx, "⚡ Rate limit (429) detectado en proveedor. Ejecutando cambio forzado de cuenta...", "warning");
			schedule(ctx, "provider status 429", true);
		}
	});

	// 2. Assistant message error with 429, network termination or quota exhaustion (SDK error stopReason)
	pi.on("message_end", (event: any, ctx: any) => {
		const message = event?.message;
		if (message?.role === "assistant" && message?.stopReason === "error") {
			if (isRateLimitOrNetworkError(message.errorMessage)) {
				onAlert?.();
				const isTerminated = /terminated|socket|ECONNRESET|broken.?pipe/i.test(message.errorMessage || "");
				const label = isTerminated
					? `⚡ Conexión interrumpida (${message.errorMessage.split("\n")[0]}). Rotando cuenta para recuperar flujo...`
					: `⚡ Error de cuota/429 detectado: ${message.errorMessage.split("\n")[0]}`;
				notify(ctx, label, "warning");
				schedule(ctx, isTerminated ? "network terminated error" : "assistant message 429/quota error", true);
			}
		}
	});

	// 3. After every main agent assistant turn finishes
	let consecutiveAutoRecoveries = 0;
	let lastRecoveryTimestamp = 0;

	pi.on("turn_end", (event: any, ctx: any) => {
		const message = event?.message;
		const toolResults = event?.toolResults;
		const now = Date.now();

		// Reiniciar contador de recuperaciones si pasaron más de 60 segundos desde la última
		if (now - lastRecoveryTimestamp > 60_000) {
			consecutiveAutoRecoveries = 0;
		}

		if (message?.stopReason === "error" && isRateLimitOrNetworkError(message?.errorMessage)) {
			onAlert?.();
			schedule(ctx, "turn network/unexpected EOF error", true);

			// Blindaje de Tokens contra Loops Infinitos de Reanudación:
			// Si ya se intentó recuperar consecutivamente sin éxito (máx 2 reintentos),
			// no seguir inyectando turnos ciegos que quemen miles de tokens de contexto.
			if (consecutiveAutoRecoveries >= 2) {
				notify(
					ctx,
					"🛑 Límite de auto-recuperaciones consecutivas alcanzado para proteger tu presupuesto de tokens. Revisa la conectividad de CPAMC.",
					"error",
				);
				consecutiveAutoRecoveries = 0;
				return;
			}

			consecutiveAutoRecoveries++;
			lastRecoveryTimestamp = now;

			notify(
				ctx,
				`⚡ Microcorte de streaming detectado (intento ${consecutiveAutoRecoveries}/2). Rotando cuenta y auto-reanudando agente...`,
				"warning",
			);

			// Compactar posibles outputs voluminosos de herramientas para ahorrar hasta 90% de tokens de entrada
			const compactHint = compactToolResultsForRecovery(toolResults);

			return {
				entries: [
					{
						type: "custom_message",
						customType: "auto-recovery-prompt",
						content: `[Auto Switcher Pro · Auto-Recuperación] Se detectó una interrupción de conexión o fin inesperado de flujo. Continúa directamente desde la última acción planificada.${compactHint}`,
						display: false,
					},
				],
				continue: true,
			};
		}

		// Si el turno concluyó con éxito, limpiar el contador de recuperaciones
		consecutiveAutoRecoveries = 0;

		// Detectar parálisis por falso stop (ej. el LLM escupió solo "Now" sin tools y se durmió)
		if (isPrematureStop(message, toolResults)) {
			const text = extractMessageText(message).trim();
			notify(ctx, `⚡ Falso stop detectado ("${text}"). Auto-reanudando agente...`, "info");

			// Contrato nativo de Pi en turn_end: BoundaryResult con continue: true y custom_message
			return {
				entries: [
					{
						type: "custom_message",
						customType: "auto-recovery-prompt",
						content: "[Auto Switcher Pro · Continuación] Continúa directamente con la acción planificada.",
						display: false,
					},
				],
				continue: true,
			};
		}

		schedule(ctx, "agent turn", false);
	});

	// 4. Synchronous task-mode subagent completions
	pi.on("tool_result", (event: any, ctx: any) => {
		if (event?.toolName !== "subagent_run" && event?.toolName !== "subagent_continue") {
			return;
		}

		const details = event.details as ToolDetails | undefined;
		if (!Array.isArray(details?.results) || details.results.length === 0) return;

		const waitedIds = Array.isArray(details.waited_task_ids)
			? new Set(details.waited_task_ids.filter((id): id is string => typeof id === "string"))
			: undefined;

		for (const value of details.results) {
			const task = readTask(value);
			if (!task || !task.status || !TERMINAL_STATUSES.has(task.status)) continue;
			if ((task.effective_mode ?? task.mode) === "background") continue;
			if (waitedIds && (!task.id || !waitedIds.has(task.id))) continue;

			const hasRateLimit = task.status === "failed" && isRateLimitOrNetworkError(task.error || task.result);
			schedule(ctx, `subagent ${task.agent || task.id || "completed"}`, hasRateLimit);
		}
	});

	// 5. Background subagent completions
	pi.on("message_start", (event: any, ctx: any) => {
		const message = event?.message;
		if (message?.customType !== "subagent-completion") return;
		const task = readTask(message?.details?.task);
		const hasRateLimit = task?.status === "failed" && isRateLimitOrNetworkError(task?.error || task?.result);
		schedule(ctx, `bg-subagent ${task?.agent || task?.id || "completed"}`, hasRateLimit);
	});
}
