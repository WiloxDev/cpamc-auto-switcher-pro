import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { resolveCandidateBaseUrls, resolveCpamcBaseUrl } from "./provider.js";

const TIMEOUT_MS = 6000;
export const QUOTA_REFRESH_MS = 25_000;

export interface RotationCauseItem {
	time_str: string;
	previous_leader: string;
	new_leader: string;
	reason_display: string;
	timestamp: number;
}

export interface LifecycleSummary {
	period_label: string;
	cache_affinity_pct: number;
	rotations_count: number;
	current_leader_dur: string;
	current_leader_sec: number;
	rescues_429_count: number;
	tokens_consumed: number;
	tokens_consumed_fmt: string;
	sustained_turns: number;
	active_leader_email: string;
	active_leader_since: string;
	prev_leader_dur: string;
	avg_leader_dur: string;
	recent_causes: RotationCauseItem[];
}

export interface ContextCompressionState {
	compressionsSession: number;
	currentTokens: number;
	contextWindow: number;
	lossEvents: number;
}

let cachedLifecycle: LifecycleSummary | null = null;
let cachedLifecyclesByPool: Record<string, LifecycleSummary> = {};
let contextState: ContextCompressionState = {
	compressionsSession: 0,
	currentTokens: 0,
	contextWindow: 200_000,
	lossEvents: 0,
};

export function updateContextUsage(tokens: number, maxTokens: number) {
	if (tokens > 0) contextState.currentTokens = tokens;
	if (maxTokens > 0) contextState.contextWindow = maxTokens;
}

export function recordContextCompression() {
	contextState.compressionsSession += 1;
}

export function getContextState(): ContextCompressionState {
	return { ...contextState };
}

export function getCachedLifecycle(poolId?: string): LifecycleSummary | null {
	if (poolId) {
		const normId = poolId.trim().toLowerCase();
		for (const [k, v] of Object.entries(cachedLifecyclesByPool)) {
			if (k.toLowerCase() === normId) {
				return v;
			}
		}
	}
	return cachedLifecycle;
}

export function setCachedLifecycleForTesting(lifecycle: LifecycleSummary | null, poolId?: string): void {
	if (poolId) {
		if (lifecycle) {
			cachedLifecyclesByPool[poolId] = lifecycle;
		} else {
			delete cachedLifecyclesByPool[poolId];
		}
	} else {
		cachedLifecycle = lifecycle;
	}
}

export interface SwitcherAccount {
	status: string; // "[ACTIVE]" | "[RESERVE]" | "[OTHER]"
	provider: string;
	profile: string; // "default" (Gemini), "clau" (Claude), etc.
	accountId: string;
	prefix: string; // "agy", "agy_1", "agy_clau", "agy_clau_1", etc.
	consumed5h: string;
	consumedWeekly: string;
	minAvailable: string;
	reset5hInSec?: number;
	resetWeeklyInSec?: number;
}

export interface PoolRotationPair {
	poolKey: string;
	familyName: string;
	familyIcon: string;
	active: SwitcherAccount;
	next?: SwitcherAccount;
	totalAccounts: number;
	isNativeReadOnly?: boolean;
}

export interface ModelPoolClassification {
	isCpamc: boolean;
	prefix: string;
	isLeader: boolean;
	isReserve: boolean;
	roleIcon: string; // "👑 " | "🔄 " | "⚡ "
	familyIcon: string; // "✨ " | "🔶 " | "🤖 " | "🧩 "
	familyLabel: string;
	canonicalModelId: string;
	poolBase: string;
}

let cachedAccounts: SwitcherAccount[] = [];
let lastFetchTime = 0;
let isFetching = false;

export function setCachedAccountsForTesting(accounts: SwitcherAccount[]): void {
	cachedAccounts = accounts;
	lastFetchTime = Date.now();
}

interface StoredPool {
	id: string;
	base_prefix: string;
	active_leader?: string;
	leader_auth?: string;
	members?: string[];
	family?: string;
}

let cachedPoolsState: StoredPool[] = [];
let lastPoolsStateRead = 0;

/**
 * Enmascara correo al estilo canónico (local > 6: primeros 3 + ... + ultimos 3).
 */
function maskEmailFromAuth(authName: string): string {
	if (!authName) return "";
	const clean = authName.replace(/^antigravity-/, "").replace(/\.json$/, "");
	const parts = clean.split("@");
	if (parts.length !== 2) return clean;
	const [local, domain] = parts;
	if (local && local.length > 6) {
		return `${local.slice(0, 3)}...${local.slice(-3)}@${domain}`;
	}
	return `${local}@${domain}`;
}

export function getCandidateStatePaths(): string[] {
	const home = homedir();
	const localAppData = process.env.LOCALAPPDATA || join(home, "AppData", "Local");
	const appData = process.env.APPDATA || join(home, "AppData", "Roaming");

	return [
		// 1. CPAMC / CLIProxyAPI Console Canónico (PRIORIDAD 1 - Universal: Linux, macOS M1-M4, Windows)
		join(home, ".cli-proxy-api", "plugins", "auto-switcher-pro-state.json"),
		// macOS Apple Silicon / Intel Application Support
		join(home, "Library", "Application Support", "cli-proxy-api", "plugins", "auto-switcher-pro-state.json"),
		// Windows CLIProxyAPI nativo
		join(localAppData, "cli-proxy-api", "plugins", "auto-switcher-pro-state.json"),
		join(appData, "cli-proxy-api", "plugins", "auto-switcher-pro-state.json"),
		// Linux Servidor / VPS / Docker
		join(home, "services", "cliproxy", "plugins", "auto-switcher-pro-state.json"),
		"/CLIProxyAPI/plugins/auto-switcher-pro-state.json",

		// 2. EasyCLIProxyAPI (PRIORIDAD 2 - Derivado / Desktop)
		join(home, ".local", "share", "EasyCLIProxyAPI", "cpa-core", "plugins", "auto-switcher-pro-state.json"),
		join(localAppData, "EasyCLIProxyAPI", "cpa-core", "plugins", "auto-switcher-pro-state.json"),
		join(appData, "EasyCLIProxyAPI", "cpa-core", "plugins", "auto-switcher-pro-state.json"),
		join(home, "Library", "Application Support", "EasyCLIProxyAPI", "cpa-core", "plugins", "auto-switcher-pro-state.json"),
	];
}

/**
 * Lee el archivo de estado de pools si existe en rutas conocidas.
 */
function getStoredPools(): StoredPool[] {
	const now = Date.now();
	if (now - lastPoolsStateRead < 10_000 && cachedPoolsState.length > 0) {
		return cachedPoolsState;
	}

	const candidates = getCandidateStatePaths();

	for (const p of candidates) {
		try {
			if (existsSync(p)) {
				const raw = readFileSync(p, "utf-8");
				const parsed = JSON.parse(raw);
				if (Array.isArray(parsed?.pools)) {
					cachedPoolsState = parsed.pools;
					lastPoolsStateRead = now;
					return cachedPoolsState;
				}
			}
		} catch {}
	}
	return cachedPoolsState;
}

/**
 * Consulta el estado real de cuentas y rotación vía API REST de CPAMC / Auto Switcher Pro.
 * No genera subprocesos en el sistema operativo ni muta archivos en disco.
 * Implementa caché en memoria para no saturar la red ni la CPU.
 */
export async function querySwitcherAccounts(force = false): Promise<SwitcherAccount[]> {
	const now = Date.now();
	if (!force && cachedAccounts.length > 0 && now - lastFetchTime < QUOTA_REFRESH_MS) {
		return cachedAccounts;
	}

	if (isFetching && cachedAccounts.length > 0) {
		return cachedAccounts;
	}

	isFetching = true;
	try {
		const candidateUrls = resolveCandidateBaseUrls();
		let key = (process.env.CLIPROXYAPI_MANAGEMENT_KEY || "").trim();
		if (!key) {
			const home = homedir();
			const keyCandidates = [
				join(home, ".cliproxy_management_key"),
				join(home, ".gentle-shell", "agent", "cpamc-mgmt.key"),
				join(home, ".gentle-shell", "agent", ".cliproxy_management_key"),
				join(home, ".pi", "agent", "cpamc-mgmt.key"),
				join(home, ".pi", "agent", "cpamc.key"),
				join(home, ".pi", "agent", ".cliproxy_management_key"),
			];
			if (process.env.PI_CODING_AGENT_DIR) {
				keyCandidates.push(
					join(process.env.PI_CODING_AGENT_DIR, "cpamc-mgmt.key"),
					join(process.env.PI_CODING_AGENT_DIR, "cpamc.key"),
					join(process.env.PI_CODING_AGENT_DIR, ".cliproxy_management_key")
				);
			}
			for (const kf of keyCandidates) {
				try {
					if (existsSync(kf)) {
						const val = readFileSync(kf, "utf-8").trim();
						if (val) {
							key = val;
							break;
						}
					}
				} catch {}
			}
		}
		const headers: Record<string, string> = {
			Accept: "application/json",
		};
		if (key) {
			headers["Authorization"] = `Bearer ${key}`;
		}

		// Probar cada URL candidata de CPAMC hasta encontrar el endpoint vivo
		for (const baseUrl of candidateUrls) {
			try {
				// Prioridad 1: Consulta O(1) vía /auto-switcher-pro/manifest (elimina peticiones múltiples)
				try {
					const manifestRes = await fetch(`${baseUrl}/v0/management/auto-switcher-pro/manifest`, {
						headers,
						signal: AbortSignal.timeout(TIMEOUT_MS),
					});
					if (manifestRes.ok) {
						const mData = (await manifestRes.json()) as any;
						if (mData?.lifecycle) {
							cachedLifecycle = mData.lifecycle;
						}
						if (mData?.lifecycles && typeof mData.lifecycles === "object") {
							cachedLifecyclesByPool = { ...cachedLifecyclesByPool, ...mData.lifecycles };
						}
						if (mData?.ok && Array.isArray(mData?.accounts) && mData.accounts.length > 0) {
							const reserveIndexByPool = new Map<string, number>();
							const list: SwitcherAccount[] = mData.accounts.map((a: any) => {
								const isLeader = a.role === "leader";
								const isUnassigned = a.role === "unassigned";
								const basePref = a.base_prefix || (isUnassigned ? "-" : "default");
								let prefix = basePref;
								if (!isLeader && !isUnassigned) {
									const nextIdx = (reserveIndexByPool.get(basePref) || 0) + 1;
									reserveIndexByPool.set(basePref, nextIdx);
									prefix = `${basePref}_${nextIdx}`;
								}

								const w5h = typeof a.window_5h_pct === "number" ? a.window_5h_pct : 95;
								const wWk = typeof a.weekly_pct === "number" ? a.weekly_pct : 95;
								const minPct = Math.round(Math.min(w5h, wWk));
								const c5h = Math.max(0, Math.min(100, Math.round(100 - w5h)));
								const cWk = Math.max(0, Math.min(100, Math.round(100 - wWk)));
								const reset5h = typeof a.window_5h_reset_in === "number" ? a.window_5h_reset_in : undefined;
								const resetWk = typeof a.weekly_reset_in === "number" ? a.weekly_reset_in : undefined;

								const rawKey = (a.account_key || a.email || "").toLowerCase();
								let provider = "antigravity";
								if (rawKey.includes("opencode") || rawKey.includes("nan") || rawKey.includes("nim") || rawKey.includes("nvidia")) {
									provider = "opencode-go";
								} else if (rawKey.includes("codex") || rawKey.includes("openai")) {
									provider = "codex";
								} else if (rawKey.includes("claude") || rawKey.includes("anthropic")) {
									provider = "claude";
								}

								return {
									status: isLeader ? "[ACTIVE]" : isUnassigned ? "[OTHER]" : "[RESERVE]",
									provider,
									profile: basePref,
									accountId: a.email || maskEmailFromAuth(a.account_key),
									prefix,
									consumed5h: `${c5h}%`,
									consumedWeekly: `${cWk}%`,
									minAvailable: `${minPct}%`,
									reset5hInSec: reset5h,
									resetWeeklyInSec: resetWk,
								};
							});
							if (list.length > 0) {
								cachedAccounts = list;
								lastFetchTime = Date.now();
								return cachedAccounts;
							}
						}
					}
				} catch {}

				// Prioridad 2 (Fallback): Consultar telemetría de cuotas y pools en paralelo sin procesos hijos
				const [telemetryRes, poolsRes] = await Promise.allSettled([
					fetch(`${baseUrl}/auto-switcher-pro/predictive/telemetry`, {
						headers,
						signal: AbortSignal.timeout(TIMEOUT_MS),
					}),
					fetch(`${baseUrl}/v0/management/auto-switcher-pro/pools`, {
						headers,
						signal: AbortSignal.timeout(TIMEOUT_MS),
					}),
				]);

				const list: SwitcherAccount[] = [];

				if (poolsRes.status === "fulfilled" && poolsRes.value.ok) {
					const poolsData = (await poolsRes.value.json()) as any;
					const pools = Array.isArray(poolsData?.pools) ? poolsData.pools : [];

					let telemetryAccounts: any[] = [];
					if (telemetryRes.status === "fulfilled" && telemetryRes.value.ok) {
						const tData = (await telemetryRes.value.json()) as any;
						if (Array.isArray(tData?.accounts)) {
							telemetryAccounts = tData.accounts;
						}
					}

					// Mapear cada pool a su cuenta activa en RAM y sus reservas
					for (const p of pools) {
						const basePref = p.base_prefix || "";
						const leaderAuth = p.active_leader || p.leader_auth || "";
						const members: string[] = Array.isArray(p.members) ? p.members : [];

						// Buscar telemetría para el líder
						const leaderTele = telemetryAccounts.find((a: any) =>
							a.account_email === leaderAuth || a.prefix === basePref || (leaderAuth && a.account_email && leaderAuth.includes(a.account_email))
						);

						const minAvail = leaderTele?.min_available_pct !== undefined ? `${Math.round(leaderTele.min_available_pct)}%` : "95%";
						const c5h = leaderTele?.consumed_5h !== undefined ? `${leaderTele.consumed_5h}` : "0";
						const cW = leaderTele?.consumed_weekly !== undefined ? `${leaderTele.consumed_weekly}` : "0";

						list.push({
							status: "[ACTIVE]",
							provider: "antigravity",
							profile: p.family || "default",
							accountId: maskEmailFromAuth(leaderAuth),
							prefix: basePref,
							consumed5h: c5h,
							consumedWeekly: cW,
							minAvailable: minAvail,
						});

						// Listar miembros de reserva
						let reserveIdx = 0;
						for (const m of members) {
							if (m === leaderAuth) continue;
							reserveIdx++;
							const mTele = telemetryAccounts.find((a: any) =>
								a.account_email === m || (m && a.account_email && m.includes(a.account_email))
							);
							const mMinAvail = mTele?.min_available_pct !== undefined ? `${Math.round(mTele.min_available_pct)}%` : "100%";
							const m5h = mTele?.consumed_5h !== undefined ? `${mTele.consumed_5h}` : "0";
							const mWeekly = mTele?.consumed_weekly !== undefined ? `${mTele.consumed_weekly}` : "0";

							list.push({
								status: "[RESERVE]",
								provider: "antigravity",
								profile: p.family || "default",
								accountId: maskEmailFromAuth(m),
								prefix: `${basePref}_${reserveIdx}`,
								consumed5h: m5h,
								consumedWeekly: mWeekly,
								minAvailable: mMinAvail,
							});
						}
					}
				}

				if (list.length > 0) {
					cachedAccounts = list;
					lastFetchTime = Date.now();
					return cachedAccounts;
				}
			} catch {
				// Siguiente URL candidata
			}
		}

		// Si la API no respondió o vino vacía, intentar fallback a través de getStoredPools() en auto-switcher-pro-state.json
		throw new Error("Empty API response");
	} catch {
		// Fallback gracioso: leer estado guardado en auto-switcher-pro-state.json
		const pools = getStoredPools();
		if (pools.length > 0) {
			const fallbackList: SwitcherAccount[] = [];
			for (const p of pools) {
				const active = p.active_leader || p.leader_auth || "";
				if (active) {
					fallbackList.push({
						status: "[ACTIVE]",
						provider: "antigravity",
						profile: p.family || p.base_prefix,
						accountId: maskEmailFromAuth(active),
						prefix: p.base_prefix,
						consumed5h: "0",
						consumedWeekly: "0",
						minAvailable: "95%",
					});
				}
			}
			if (fallbackList.length > 0) {
				cachedAccounts = fallbackList;
				lastFetchTime = Date.now();
			}
		}
		return cachedAccounts;
	} finally {
		isFetching = false;
	}
}

/**
 * Clasifica cualquier modelo (sea de CPAMC o de /login directo)
 * determinando si es líder activo (👑), reserva (🔄) o directo (⚡).
 */
export function classifyModel(modelId: string, provider: string): ModelPoolClassification {
	let trimmed = (modelId || "").trim();
	const isCpamc =
		provider === "cpamc" ||
		provider === "cliproxyapi" ||
		trimmed.startsWith("cpamc/") ||
		trimmed.startsWith("cliproxyapi/");

	if (!isCpamc) {
		return {
			isCpamc: false,
			prefix: "",
			isLeader: false,
			isReserve: false,
			roleIcon: "⚡ ",
			familyIcon: "⚡ ",
			familyLabel: "Directo (/login)",
			canonicalModelId: trimmed,
			poolBase: "",
		};
	}

	// Normalizar: remover prefijo de proveedor si viene en modelId
	if (trimmed.startsWith("cpamc/")) {
		trimmed = trimmed.slice(6);
	} else if (trimmed.startsWith("cliproxyapi/")) {
		trimmed = trimmed.slice(12);
	}

	// Manejo específico del modelo informativo cuando no hay cuentas vinculadas aún
	if (trimmed === "sin-cuentas-vinculadas" || trimmed.includes("sin-cuentas")) {
		return {
			isCpamc: true,
			prefix: "",
			isLeader: false,
			isReserve: false,
			roleIcon: "⚠️ ",
			familyIcon: "⚠️ ",
			familyLabel: "Sin Cuentas",
			canonicalModelId: trimmed,
			poolBase: "",
		};
	}

	// Reconocimiento directo de Identificador Limpio de Pool Canónico (p. ej. Pool-01-gemini)
	if (/^pool-\d+-/i.test(trimmed)) {
		let familyIcon = "✨ ";
		let familyLabel = "Gemini (Pool)";
		const lower = trimmed.toLowerCase();
		if (lower.includes("claude") || lower.includes("sonnet") || lower.includes("opus")) {
			familyIcon = "🔶 ";
			familyLabel = "Claude (Pool)";
		} else if (lower.includes("codex") || lower.includes("gpt")) {
			familyIcon = "🧩 ";
			familyLabel = "Codex (Pool)";
		}

		return {
			isCpamc: true,
			prefix: trimmed,
			isLeader: true,
			isReserve: false,
			roleIcon: "👑 ",
			familyIcon,
			familyLabel,
			canonicalModelId: trimmed,
			poolBase: trimmed,
		};
	}

	const slash = trimmed.indexOf("/");
	const prefix = slash > 0 ? trimmed.slice(0, slash) : "";
	const canonical = slash > 0 ? trimmed.slice(slash + 1) : trimmed;

	// Si no tiene prefijo, es un modelo servido por el proxy sin pool específico
	if (!prefix) {
		return {
			isCpamc: true,
			prefix: "",
			isLeader: false,
			isReserve: false,
			roleIcon: "⚡ ",
			familyIcon: "🌐 ",
			familyLabel: "Proxy General",
			canonicalModelId: canonical,
			poolBase: "",
		};
	}

	// Regla de reserva: prefijo terminado en _\d+ (ej. agy_1, agy_clau_2)
	const reserveMatch = prefix.match(/^(.*)_(\d+)$/);
	const isReserve = Boolean(reserveMatch);
	const isLeader = !isReserve;
	const poolBase = reserveMatch ? reserveMatch[1]! : prefix;

	// Detección de Familia de Cuota con precedencia estricta
	let familyIcon = "🌐 ";
	let familyLabel = "General";

	if (poolBase.startsWith("agy_opus") || poolBase.startsWith("opus")) {
		familyIcon = "🟣 ";
		familyLabel = "Claude Opus";
	} else if (poolBase.startsWith("agy_son") || poolBase.startsWith("son")) {
		familyIcon = "🔶 ";
		familyLabel = "Claude Sonnet";
	} else if (poolBase.startsWith("agy_clau") || poolBase.startsWith("clau")) {
		familyIcon = "🤖 ";
		familyLabel = "Claude (Nativo)";
	} else if (poolBase.startsWith("agy") || poolBase.startsWith("g")) {
		familyIcon = "✨ ";
		familyLabel = "Gemini Puro";
	} else if (poolBase.startsWith("codex")) {
		familyIcon = "🧩 ";
		familyLabel = "Codex (GPT)";
	}

	const roleIcon = isLeader ? "👑 " : "🔄 ";

	return {
		isCpamc: true,
		prefix,
		isLeader,
		isReserve,
		roleIcon,
		familyIcon,
		familyLabel,
		canonicalModelId: canonical,
		poolBase,
	};
}

/**
 * Calcula de forma síncrona la pareja de rotación usando las cuentas en memoria caché.
 * Ideal para llamadas dentro del ciclo de render/digest del TUI.
 */
export function getRotationPairForModelSync(modelId: string, provider: string): PoolRotationPair | null {
	const info = classifyModel(modelId, provider);
	if (!info.isCpamc) return null;

	const accounts = cachedAccounts;
	if (accounts.length === 0) return null;

	// Si no tiene poolBase, es un modelo nativo CPAMC sin rotación (Solo Lectura)
	if (!info.poolBase) {
		const lowerModel = info.canonicalModelId.toLowerCase();
		let nativeAcc = accounts.find((a) => {
			if (a.status === "[OTHER]" || a.prefix === "-" || !a.prefix) {
				if (lowerModel.includes("gemini") && a.provider === "antigravity") return true;
				if ((lowerModel.includes("gpt") || lowerModel.includes("codex") || lowerModel.startsWith("o")) && (a.provider === "codex" || a.provider === "openai")) return true;
				if (lowerModel.includes("claude") && (a.provider === "claude" || a.provider === "anthropic")) return true;
				return true;
			}
			return false;
		});

		if (!nativeAcc) {
			nativeAcc = accounts.find((a) => a.status === "[OTHER]" || a.prefix === "-" || !a.prefix);
		}

		if (!nativeAcc) return null;

		return {
			poolKey: info.canonicalModelId,
			familyName: "CPAMC Directo",
			familyIcon: "⚡ ",
			active: nativeAcc,
			totalAccounts: 1,
			isNativeReadOnly: true,
		};
	}

	// Si el modelo invocado es una Fachada Soberana de Pool (ej. Pool-01-gemini),
	// buscar la definición en el estado de pools para mapear a sus cuentas miembros reales.
	let matchedBase = info.poolBase;
	let memberEmails = new Set<string>();
	let activeLeaderEmail = "";

	if (/^pool-\d+-/i.test(info.poolBase)) {
		const storedPools = getStoredPools();
		const matchedPool = storedPools.find(
			(p) => p.id.toLowerCase() === info.poolBase.toLowerCase() || p.base_prefix.toLowerCase() === info.poolBase.toLowerCase()
		);
		if (matchedPool) {
			matchedBase = matchedPool.base_prefix || info.poolBase;
			if (Array.isArray(matchedPool.members)) {
				for (const m of matchedPool.members) {
					memberEmails.add(maskEmailFromAuth(m).toLowerCase());
				}
			}
			if (matchedPool.active_leader) {
				activeLeaderEmail = maskEmailFromAuth(matchedPool.active_leader).toLowerCase();
			} else if (matchedPool.leader_auth) {
				activeLeaderEmail = maskEmailFromAuth(matchedPool.leader_auth).toLowerCase();
			}
		}
	}

	// Filtrar cuentas que pertenecen a este pool:
	// 1. Por coincidencia de correo en members del pool (resolución soberana de RAM)
	// 2. Por coincidencia de prefijo (base o sufijo numérico _N)
	// Cuentas con status [OTHER] o sin prefijo no pertenecen a ningún pool.
	const poolAccounts = accounts.filter((a) => {
		if (a.status === "[OTHER]" || a.prefix === "-" || !a.prefix) {
			return false;
		}
		const emailLower = (a.accountId || "").toLowerCase();
		if (memberEmails.size > 0 && memberEmails.has(emailLower)) {
			return true;
		}
		const p = a.prefix.trim();
		if (p === matchedBase) return true;
		if (p.startsWith(`${matchedBase}_`)) {
			const suffix = p.slice(matchedBase.length + 1);
			return /^\d+$/.test(suffix);
		}
		return false;
	});

	if (poolAccounts.length === 0) {
		// ¿Es una cuenta standalone / directa identificada por prefijo exacto (nim_1), base (nim) o nombre?
		const standalone = accounts.find((a) => {
			const p = (a.prefix || "").trim().toLowerCase();
			const accId = (a.accountId || "").trim().toLowerCase();
			const targetBase = matchedBase.toLowerCase();
			const targetPrefix = (info.prefix || "").trim().toLowerCase();

			if (targetPrefix && p === targetPrefix) return true;
			if (p === targetBase) return true;
			if (targetPrefix && accId.includes(targetPrefix)) return true;
			if (accId.includes(targetBase) || targetBase.includes(p)) return true;
			return false;
		});

		if (standalone) {
			const key = info.prefix || standalone.prefix || info.canonicalModelId;
			return {
				poolKey: key && key !== "-" ? key : info.canonicalModelId,
				familyName: "CPAMC Directo",
				familyIcon: "⚡ ",
				active: standalone,
				totalAccounts: 1,
				isNativeReadOnly: true,
			};
		}

		return null;
	}

	// Cuenta activa:
	// Prioridad 1: Coincidencia con activeLeaderEmail de RAM
	// Prioridad 2: Status [ACTIVE]
	// Prioridad 3: Prefijo exacto matchedBase
	const active =
		(activeLeaderEmail ? poolAccounts.find((a) => (a.accountId || "").toLowerCase() === activeLeaderEmail) : null) ||
		poolAccounts.find((a) => a.status === "[ACTIVE]") ||
		poolAccounts.find((a) => a.prefix === matchedBase) ||
		poolAccounts[0]!;

	// Reservas ordenadas por disponibilidad libre de cuota o prefijo
	const reserves = poolAccounts
		.filter((a) => (a.accountId || "").toLowerCase() !== (active.accountId || "").toLowerCase())
		.sort((a, b) => {
			const qA = parseFloat(a.minAvailable.replace("%", "").trim()) || 0;
			const qB = parseFloat(b.minAvailable.replace("%", "").trim()) || 0;
			if (qB !== qA) {
				return qB - qA; // Mejor candidata primero
			}
			return (a.prefix || "").localeCompare(b.prefix || "", undefined, { numeric: true });
		});

	const next = reserves.length > 0 ? reserves[0] : undefined;

	return {
		poolKey: info.poolBase,
		familyName: info.familyLabel,
		familyIcon: info.familyIcon,
		active,
		next,
		totalAccounts: poolAccounts.length,
	};
}

/**
 * Extrae el porcentaje de cuota libre remanente de una cuenta por su prefijo exacto
 * o identificador de fachada canónica (ej. "Pool-01-gemini").
 */
export function getAvailableQuotaForPrefix(prefix: string): number {
	if (!prefix) return 0;
	const cleanPrefix = prefix.trim();

	// Si es un pool soberano (Pool-XX-<family>), resolver contra su base_prefix o líder
	const poolMatch = cleanPrefix.match(/^pool-(\d+)-([a-zA-Z0-9_-]+)/i);
	if (poolMatch) {
		const pools = getStoredPools();
		const matchedPool = pools.find(
			(p) => p.id?.toLowerCase() === cleanPrefix.toLowerCase() || p.base_prefix?.toLowerCase() === cleanPrefix.toLowerCase()
		);
		if (matchedPool) {
			const targetPrefix = matchedPool.base_prefix || "";
			const account = cachedAccounts.find((a) => a.prefix.trim().toLowerCase() === targetPrefix.toLowerCase());
			if (account) {
				const raw = account.minAvailable.replace("%", "").trim();
				const val = parseFloat(raw);
				return Number.isFinite(val) ? val : 95;
			}
		}
		// Si está en pools pero aún no sincronizó telemetría, asumir estado saludable (95%)
		return 95;
	}

	const account = cachedAccounts.find((a) => a.prefix.trim() === cleanPrefix);
	if (!account) return 0;
	const raw = account.minAvailable.replace("%", "").trim();
	const val = parseFloat(raw);
	return Number.isFinite(val) ? val : 0;
}

/**
 * Retorna el mejor candidato líder de rotación (con mayor porcentaje disponible) para una familia dada.
 */
export function getBestCandidateLeader(prefixCandidates: string[]): string | null {
	if (!prefixCandidates || prefixCandidates.length === 0) return null;
	let bestPrefix = prefixCandidates[0]!;
	let bestQuota = -1;

	for (const p of prefixCandidates) {
		const q = getAvailableQuotaForPrefix(p);
		if (q > bestQuota) {
			bestQuota = q;
			bestPrefix = p;
		}
	}
	return bestPrefix;
}

/**
 * Evalúa si un pool amerita rebalanceo proactivo en el arranque o recarga de sesión:
 * Regla de Histéresis:
 * 1. Cuenta activa fatigada: cuota libre < 50%
 * 2. Reserva candidata con ventaja significativa: cuota(reserva) - cuota(activa) >= 30%
 */
export function checkProactivePoolRebalance(modelId: string, provider: string): { shouldSwitch: boolean; bestReservePrefix?: string } {
	const pair = getRotationPairForModelSync(modelId, provider);
	if (!pair || !pair.next) return { shouldSwitch: false };

	const activeQuota = getAvailableQuotaForPrefix(pair.active.prefix);
	const reserveQuota = getAvailableQuotaForPrefix(pair.next.prefix);

	// 1. Piso de agotamiento: la activa debe tener menos del 50% disponible
	if (activeQuota >= 50) return { shouldSwitch: false };

	// 2. Margen de ventaja: la reserva debe sacarle al menos 30 puntos porcentuales
	if (reserveQuota - activeQuota >= 30) {
		return {
			shouldSwitch: true,
			bestReservePrefix: pair.next.prefix,
		};
	}

	return { shouldSwitch: false };
}

/**
 * Decrementa de forma optimista en memoria RAM el porcentaje disponible de una cuenta tras un streaming exitoso.
 */
export function applyOptimisticQuotaDecrement(prefixOrEmail: string, pctDelta = 1.0): void {
	if (!prefixOrEmail || cachedAccounts.length === 0) return;
	const target = prefixOrEmail.toLowerCase().trim();

	for (const acc of cachedAccounts) {
		const accPrefix = (acc.prefix || "").toLowerCase();
		const accId = (acc.accountId || "").toLowerCase();
		if (accPrefix === target || accId.includes(target) || target.includes(accPrefix)) {
			const current = parseFloat(acc.minAvailable.replace("%", "")) || 100;
			const next = Math.max(0, +(current - pctDelta).toFixed(1));
			acc.minAvailable = `${next}%`;
			// Incrementar consumo de 5h en consonancia
			const current5h = parseFloat(acc.consumed5h.replace("%", "")) || 0;
			acc.consumed5h = `${Math.min(100, +(current5h + pctDelta).toFixed(1))}%`;
			break;
		}
	}
}

/**
 * Consulta las cuentas más recientes si es necesario y calcula la pareja de rotación.
 */
export async function getRotationPairForModel(modelId: string, provider: string): Promise<PoolRotationPair | null> {
	await querySwitcherAccounts();
	return getRotationPairForModelSync(modelId, provider);
}

// ============================================================================
// TELEMETRÍA Y PREFERENCIAS BIMODALES DE QUOTACARD (ESENCIAL vs PRO PESTAÑAS)
// ============================================================================

export type QuotaCardViewMode = "essential" | "tabs";
export type QuotaCardTabId = "quota" | "metrics" | "pool" | "radar";

export interface QuotaCardTelemetryEvent {
	timestamp: number;
	type: "rotation" | "incident_mitigated" | "cooling" | "circuit_breaker" | "rebalance" | "info";
	source: string;
	message: string;
	details?: string;
}

export interface QuotaTurnTelemetry {
	turnId: string;
	timestamp: number;
	tokens: number;
	durationMs: number;
	toolsCount: number;
}

const PREF_FILE_NAME = "cpamc-preferences.json";

function getPreferencesPath(): string {
	const home = process.env.HOME || process.env.USERPROFILE || "";
	return path.join(home, ".pi", "agent-wilox", PREF_FILE_NAME);
}

let activeViewMode: QuotaCardViewMode = "essential";
let activeTabId: QuotaCardTabId = "quota";
let smartPeekingUntil = 0;
let smartPeekingPreviousTab: QuotaCardTabId = "quota";

const turnTelemetryHistory: QuotaTurnTelemetry[] = [];
const telemetryEventsHistory: QuotaCardTelemetryEvent[] = [];
const MAX_TURN_HISTORY = 20;
const MAX_EVENT_HISTORY = 40;

/**
 * Carga las preferencias de QuotaCard desde disco (~/.pi/agent-wilox/cpamc-preferences.json)
 * sin bloquear ni arrojar excepciones si no existe.
 */
export function loadQuotaCardPreferences(): { viewMode: QuotaCardViewMode; activeTab: QuotaCardTabId } {
	try {
		const prefPath = getPreferencesPath();
		if (fs.existsSync(prefPath)) {
			const raw = fs.readFileSync(prefPath, "utf-8");
			const parsed = JSON.parse(raw);
			if (parsed.viewMode === "essential" || parsed.viewMode === "tabs") {
				activeViewMode = parsed.viewMode;
			}
			if (parsed.activeTab === "quota" || parsed.activeTab === "metrics" || parsed.activeTab === "pool" || parsed.activeTab === "radar") {
				activeTabId = parsed.activeTab;
			}
		}
	} catch {
		// Tolerancia ante fallos de disco; mantiene defaults en RAM
	}
	return { viewMode: activeViewMode, activeTab: activeTabId };
}

/**
 * Guarda las preferencias de QuotaCard de manera atómica en disco y actualiza RAM.
 */
export function saveQuotaCardPreferences(prefs: { viewMode?: QuotaCardViewMode; activeTab?: QuotaCardTabId }): void {
	if (prefs.viewMode) activeViewMode = prefs.viewMode;
	if (prefs.activeTab) activeTabId = prefs.activeTab;

	try {
		const prefPath = getPreferencesPath();
		const dir = path.dirname(prefPath);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		const tmpPath = `${prefPath}.tmp-${Date.now()}`;
		const payload = JSON.stringify({ viewMode: activeViewMode, activeTab: activeTabId }, null, 2);
		fs.writeFileSync(tmpPath, payload, "utf-8");
		fs.renameSync(tmpPath, prefPath);
	} catch {
		// Fallback silencioso en entornos restringidos de solo lectura
	}
}

export function getQuotaCardViewMode(): QuotaCardViewMode {
	return activeViewMode;
}

export function setQuotaCardViewMode(mode: QuotaCardViewMode): void {
	activeViewMode = mode;
	saveQuotaCardPreferences({ viewMode: mode });
}

export function getActiveQuotaCardTab(): QuotaCardTabId {
	// Evaluar Smart Peeking temporal
	if (smartPeekingUntil > Date.now()) {
		return "radar";
	}
	return activeTabId;
}

export function setActiveQuotaCardTab(tab: QuotaCardTabId): void {
	smartPeekingUntil = 0; // Desactivar peeking forzado si el usuario navega deliberadamente
	activeTabId = tab;
	saveQuotaCardPreferences({ activeTab: tab });
}

/**
 * Activa Smart Peeking hacia la pestaña Radar por una duración dada (ej. 5000ms),
 * guardando la pestaña previa para retornar automáticamente sin intervención del usuario.
 */
export function triggerSmartPeeking(durationMs = 5000): void {
	if (activeViewMode !== "tabs") return;
	if (smartPeekingUntil <= Date.now()) {
		smartPeekingPreviousTab = activeTabId;
	}
	smartPeekingUntil = Date.now() + durationMs;
}

/**
 * Registra métricas de consumo de un turno en RAM para alimentar los Sparklines y curvas temporales.
 */
export function recordTurnTelemetry(telemetry: Omit<QuotaTurnTelemetry, "timestamp">): void {
	turnTelemetryHistory.push({
		...telemetry,
		timestamp: Date.now(),
	});
	if (turnTelemetryHistory.length > MAX_TURN_HISTORY) {
		turnTelemetryHistory.shift();
	}
}

export function getTurnTelemetryHistory(): readonly QuotaTurnTelemetry[] {
	return turnTelemetryHistory;
}

/**
 * Registra un evento en la bitácora viva del Radar de Rotaciones y activa Smart Peeking si es crítico.
 */
export function recordTelemetryEvent(event: Omit<QuotaCardTelemetryEvent, "timestamp">): void {
	const entry: QuotaCardTelemetryEvent = {
		...event,
		timestamp: Date.now(),
	};
	telemetryEventsHistory.push(entry);
	if (telemetryEventsHistory.length > MAX_EVENT_HISTORY) {
		telemetryEventsHistory.shift();
	}

	if (event.type === "incident_mitigated" || event.type === "circuit_breaker") {
		triggerSmartPeeking(5000);
	}
}

export function getTelemetryEventsHistory(): readonly QuotaCardTelemetryEvent[] {
	return telemetryEventsHistory;
}

export function clearTelemetryHistoriesForTest(): void {
	turnTelemetryHistory.length = 0;
	telemetryEventsHistory.length = 0;
	smartPeekingUntil = 0;
	activeViewMode = "essential";
	activeTabId = "quota";
}

