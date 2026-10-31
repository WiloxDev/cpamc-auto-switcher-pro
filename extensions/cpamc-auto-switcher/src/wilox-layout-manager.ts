import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { runawayGuard } from "./guards.js";

export type SidebarOrderPreset = "standard" | "sentinel-top" | "tasks-first" | "custom";

export interface WiloxUnifiedSettings {
	schema: "wiloxdev.unified/v1";
	ui: {
		lastExpandedModule: string | null;
	};
	sidebar: {
		enabled: boolean;
		width: number;
		breakpoint: number;
		gap: number;
		orderPreset: SidebarOrderPreset;
		customOrder?: string[];
		visibility: {
			footer: boolean;
			sentinel: boolean;
			jobs: boolean;
			agents: boolean;
			todo: boolean;
		};
		adaptiveVerticalBudgeting: boolean;
		floatingHudWhenDisabled: boolean;
		smartFocusOnIncident: boolean;
	};
	scanner: {
		username: string;
		zenMode: boolean;
		showWorkingContext: boolean;
		showContextInIdle: boolean;
		showWorkingDuration: boolean;
		showCompactionCount: boolean;
	};
}

const DEFAULT_SETTINGS: WiloxUnifiedSettings = {
	schema: "wiloxdev.unified/v1",
	ui: {
		lastExpandedModule: "sidebar",
	},
	sidebar: {
		enabled: true,
		width: 38,
		breakpoint: 115,
		gap: 2,
		orderPreset: "standard",
		customOrder: ["footer", "sentinel", "jobs", "agents", "todo"],
		visibility: {
			footer: true,
			sentinel: true,
			jobs: true,
			agents: true,
			todo: true,
		},
		adaptiveVerticalBudgeting: true,
		floatingHudWhenDisabled: true,
		smartFocusOnIncident: true,
	},
	scanner: {
		username: "Wilox",
		zenMode: false,
		showWorkingContext: true,
		showContextInIdle: true,
		showWorkingDuration: true,
		showCompactionCount: true,
	},
};

const COMMUNITY_RAIL_SLOT = Symbol.for("gentle-pi.community.rail-width");
const COMMUNITY_SIDEBAR_ORDER_SLOT = Symbol.for("gentle-pi.community.sidebar.order");
const COMMUNITY_REGISTRY_SLOT = Symbol.for("gentle-pi.community.wiloxdev.registry");
const COMMUNITY_EXPANDED_SLOT = Symbol.for("gentle-pi.community.wiloxdev.expanded");

const globalState = globalThis as typeof globalThis & {
	[COMMUNITY_RAIL_SLOT]?: number;
	[COMMUNITY_SIDEBAR_ORDER_SLOT]?: string[];
	[COMMUNITY_REGISTRY_SLOT]?: Map<string, WiloxCommunityModule>;
	[COMMUNITY_EXPANDED_SLOT]?: string | null;
};

export interface WiloxCommunityRow {
	id: string;
	label: () => string;
	preview: () => { title: string; sample: string };
	action: (inline?: any) => void | Promise<void>;
}

export interface WiloxCommunityModule {
	id: string;
	title: string;
	summary: () => string;
	order?: number;
	rows: WiloxCommunityRow[];
}

/**
 * Directorio unificado estándar POSIX para WiloxDev
 */
export function getWiloxUnifiedConfigDir(): string {
	const dir = join(homedir(), ".config", "wiloxdev");
	if (!existsSync(dir)) {
		try {
			mkdirSync(dir, { recursive: true });
		} catch {}
	}
	return dir;
}

export function getWiloxUnifiedConfigPath(): string {
	return join(getWiloxUnifiedConfigDir(), "settings.json");
}

/**
 * Lee la configuración unificada migrando limpiamente desde archivos antiguos si existen
 */
export function readWiloxSettings(): WiloxUnifiedSettings {
	const path = getWiloxUnifiedConfigPath();
	let current: WiloxUnifiedSettings = structuredClone(DEFAULT_SETTINGS);

	// 1. Intentar leer almacén unificado
	if (existsSync(path)) {
		try {
			const data = JSON.parse(readFileSync(path, "utf8"));
			if (data && data.schema === "wiloxdev.unified/v1") {
				return {
					...current,
					...data,
					ui: { ...current.ui, ...(data.ui || {}) },
					sidebar: {
						...current.sidebar,
						...(data.sidebar || {}),
						orderPreset: data.sidebar?.orderPreset || current.sidebar.orderPreset,
						customOrder: data.sidebar?.customOrder || current.sidebar.customOrder,
						adaptiveVerticalBudgeting: data.sidebar?.adaptiveVerticalBudgeting ?? current.sidebar.adaptiveVerticalBudgeting,
						floatingHudWhenDisabled: data.sidebar?.floatingHudWhenDisabled ?? current.sidebar.floatingHudWhenDisabled,
						smartFocusOnIncident: data.sidebar?.smartFocusOnIncident ?? current.sidebar.smartFocusOnIncident,
						visibility: {
							...current.sidebar.visibility,
							...(data.sidebar?.visibility || {}),
						},
					},
					scanner: { ...current.scanner, ...(data.scanner || {}) },
				};
			}
		} catch {}
	}

	// 2. Migración transparente de ~/.pi/gentle-shell/wilox-settings.json si existe
	const legacySidebarPath = join(homedir(), ".pi", "gentle-shell", "wilox-settings.json");
	if (existsSync(legacySidebarPath)) {
		try {
			const data = JSON.parse(readFileSync(legacySidebarPath, "utf8"));
			if (data?.sidebarWidth) {
				current.sidebar.width = data.sidebarWidth;
				current.sidebar.breakpoint = data.sidebarBreakpoint || (data.sidebarWidth <= 38 ? 115 : 140);
				current.sidebar.gap = data.gap || (data.sidebarWidth <= 38 ? 2 : 3);
			}
		} catch {}
	}

	// 3. Migración transparente de ~/.scanner-chatrc.json si existe
	const legacyScannerPath = join(homedir(), ".scanner-chatrc.json");
	if (existsSync(legacyScannerPath)) {
		try {
			const data = JSON.parse(readFileSync(legacyScannerPath, "utf8"));
			if (data && typeof data === "object") {
				current.scanner = { ...current.scanner, ...data };
			}
		} catch {}
	}

	return current;
}

/**
 * Escritura Atómica Crash-Safe (POSIX renameSync sobre archivo temporal con mode 0o600)
 */
export function writeWiloxSettings(patch: Partial<WiloxUnifiedSettings>): WiloxUnifiedSettings {
	const current = readWiloxSettings();
	const updated: WiloxUnifiedSettings = {
		...current,
		...patch,
		ui: { ...current.ui, ...(patch.ui || {}) },
		sidebar: { ...current.sidebar, ...(patch.sidebar || {}) },
		scanner: { ...current.scanner, ...(patch.scanner || {}) },
	};

	const dir = getWiloxUnifiedConfigDir();
	const path = getWiloxUnifiedConfigPath();
	const temp = `${path}.${randomUUID()}.tmp`;

	try {
		mkdirSync(dir, { recursive: true });
		writeFileSync(temp, JSON.stringify(updated, null, 2) + "\n", { mode: 0o600 });
		renameSync(temp, path);
	} catch (err) {
		try { unlinkSync(temp); } catch {}
		console.error("[WiloxDev] Error guardando settings unificados:", err);
	}

	// Sincronizar en memoria
	globalState[COMMUNITY_RAIL_SLOT] = updated.sidebar.width;
	globalState[COMMUNITY_EXPANDED_SLOT] = updated.ui.lastExpandedModule;

	// Sincronizar espejos legacy para retrocompatibilidad absoluta
	try {
		const legacySidebarPath = join(homedir(), ".pi", "gentle-shell", "wilox-settings.json");
		const legacySidebarDir = join(homedir(), ".pi", "gentle-shell");
		mkdirSync(legacySidebarDir, { recursive: true });
		const tmpSidebar = `${legacySidebarPath}.${randomUUID()}.tmp`;
		writeFileSync(tmpSidebar, JSON.stringify({
			schema: "wiloxdev.settings/v1",
			sidebarWidth: updated.sidebar.width,
			sidebarBreakpoint: updated.sidebar.breakpoint,
			gap: updated.sidebar.gap,
		}, null, 2) + "\n", { mode: 0o600 });
		renameSync(tmpSidebar, legacySidebarPath);
	} catch {}

	try {
		const legacyScannerPath = join(homedir(), ".scanner-chatrc.json");
		const tmpScanner = `${legacyScannerPath}.${randomUUID()}.tmp`;
		writeFileSync(tmpScanner, JSON.stringify(updated.scanner, null, 2) + "\n", { mode: 0o600 });
		renameSync(tmpScanner, legacyScannerPath);
	} catch {}

	return updated;
}

export function getActiveRailWidth(): number {
	if (typeof globalState[COMMUNITY_RAIL_SLOT] === "number") {
		return globalState[COMMUNITY_RAIL_SLOT]!;
	}
	const settings = readWiloxSettings();
	globalState[COMMUNITY_RAIL_SLOT] = settings.sidebar.width;
	return settings.sidebar.width;
}

export function setActiveRailWidth(width: number): void {
	const safeWidth = width <= 38 ? 38 : 50;
	writeWiloxSettings({
		sidebar: {
			width: safeWidth,
			breakpoint: safeWidth <= 38 ? 115 : 140,
			gap: safeWidth <= 38 ? 2 : 3,
		},
	});
}

export function getLastExpandedModule(): string | null {
	if (typeof globalState[COMMUNITY_EXPANDED_SLOT] !== "undefined") {
		return globalState[COMMUNITY_EXPANDED_SLOT] ?? null;
	}
	const settings = readWiloxSettings();
	globalState[COMMUNITY_EXPANDED_SLOT] = settings.ui.lastExpandedModule;
	return settings.ui.lastExpandedModule;
}

export function setLastExpandedModule(moduleId: string | null): void {
	globalState[COMMUNITY_EXPANDED_SLOT] = moduleId;
	writeWiloxSettings({
		ui: { lastExpandedModule: moduleId },
	});
}

/**
 * Registro de Módulos WiloxDev en el bus global en memoria
 */
export function registerCommunityModule(module: WiloxCommunityModule): void {
	const registry = globalState[COMMUNITY_REGISTRY_SLOT] ??= new Map<string, WiloxCommunityModule>();
	registry.set(module.id, module);
}

/**
 * Preset "WiloxDev Suite" de 1 solo clic (One-Click Setup)
 */
export function applyWiloxDevOptimalDefaults(): void {
	writeWiloxSettings({
		sidebar: {
			width: 38,
			breakpoint: 115,
			gap: 2,
		},
		scanner: {
			username: "Wilox",
			zenMode: false,
			showWorkingContext: true,
			showContextInIdle: true,
			showWorkingDuration: true,
			showCompactionCount: true,
		},
	});
	syncSidebarLayout(38);
}

export function getResolvedSidebarSections(
	preset: SidebarOrderPreset,
	visibility: Record<string, boolean>,
	customOrder?: string[],
	smartFocus = true,
): string[] {
	let rawOrder: string[] = [];
	if (preset === "custom" && Array.isArray(customOrder) && customOrder.length > 0) {
		rawOrder = [...customOrder];
	} else if (preset === "sentinel-top") {
		rawOrder = ["sentinel", "footer", "jobs", "agents", "todo"];
	} else if (preset === "tasks-first") {
		rawOrder = ["footer", "todo", "jobs", "agents", "sentinel"];
	} else {
		// "standard"
		rawOrder = ["footer", "sentinel", "jobs", "agents", "todo"];
	}

	// Smart Focus / Event-Driven Elevation (Alerta Roja):
	// Si ocurre un incidente crítico o 429 mitigado, Sentinel sube temporalmente a la cima (#1)
	if (smartFocus) {
		try {
			const g = runawayGuard.getTelemetry();
			const hasActiveIncident = Boolean(
				g.circuitBreakerTripped ||
				g.blockedIntrospections > 0 ||
				g.blockedBashEvasions > 0 ||
				((g.mitigatedCount ?? 0) > 0 && (g.tokensSavedEstimate ?? 0) > 0 && (Date.now() - (g.lastIncident?.timestamp || 0) < 20000))
			);
			if (hasActiveIncident && rawOrder.includes("sentinel")) {
				rawOrder = ["sentinel", ...rawOrder.filter((id) => id !== "sentinel")];
			}
		} catch {}
	}

	return rawOrder.filter((id) => visibility[id] !== false);
}

export function shiftSentinelOrder(direction: "up" | "down"): string[] {
	const settings = readWiloxSettings();
	const baseOrder = settings.sidebar.customOrder && settings.sidebar.customOrder.length > 0
		? [...settings.sidebar.customOrder]
		: getResolvedSidebarSections(settings.sidebar.orderPreset, { footer: true, sentinel: true, jobs: true, agents: true, todo: true }, undefined, false);

	const idx = baseOrder.indexOf("sentinel");
	if (idx === -1) return baseOrder;

	const targetIdx = direction === "up" ? idx - 1 : idx + 1;
	if (targetIdx >= 0 && targetIdx < baseOrder.length) {
		const temp = baseOrder[idx]!;
		baseOrder[idx] = baseOrder[targetIdx]!;
		baseOrder[targetIdx] = temp;

		writeWiloxSettings({
			sidebar: {
				...settings.sidebar,
				orderPreset: "custom",
				customOrder: baseOrder,
			},
		});
		updateGlobalSidebarOrder();
		syncSidebarLayout();
	}
	return baseOrder;
}

export function updateGlobalSidebarOrder(): void {
	const settings = readWiloxSettings();
	const sections = getResolvedSidebarSections(
		settings.sidebar.orderPreset,
		settings.sidebar.visibility,
		settings.sidebar.customOrder,
		settings.sidebar.smartFocusOnIncident,
	);
	globalState[COMMUNITY_SIDEBAR_ORDER_SLOT] = sections;
}

/**
 * Módulo 1: Gentle Shell · Sidebar & Layout Manager · Distribución y Tarjetas
 */
function registerSidebarModule(): void {
	registerCommunityModule({
		id: "sidebar",
		title: "Gentle Shell · Sidebar & Layout Manager",
		order: 5,
		summary: () => {
			const s = readWiloxSettings().sidebar;
			const presetNames: Record<SidebarOrderPreset, string> = {
				standard: "Estándar",
				"sentinel-top": "Sentinel Top",
				"tasks-first": "Tareas Primero",
				custom: "Personalizado",
			};
			const activeCount = Object.values(s.visibility).filter(Boolean).length;
			return `${s.width} cols · ${presetNames[s.orderPreset]} (${activeCount} activas)`;
		},
		rows: [
			{
				id: "sidebar-master-status",
				label: () => {
					const s = readWiloxSettings().sidebar;
					return `Riel Derecho: [${s.enabled ? "ON" : "OFF"}]`;
				},
				preview: () => {
					const s = readWiloxSettings().sidebar;
					return {
						title: "Gentle Shell · Master Switch del Sidebar",
						sample: s.enabled
							? "[ON] Riel lateral visible con distribución modular y tarjetas activas."
							: "[OFF] Oculta por completo el riel lateral para maximizar el ancho del chat.",
					};
				},
				action: () => {
					const s = readWiloxSettings().sidebar;
					writeWiloxSettings({ sidebar: { ...s, enabled: !s.enabled } });
					syncSidebarLayout();
				},
			},
			{
				id: "sidebar-width",
				label: () => {
					const s = readWiloxSettings().sidebar;
					return `Ancho del Riel: [${s.width === 38 ? "38 cols · Compacto" : "50 cols · Standard"}]`;
				},
				preview: () => {
					const s = readWiloxSettings().sidebar;
					return {
						title: "Gentle Shell · Geometría del Riel",
						sample: s.width === 38
							? "[Compacto: 38 cols] · Optimiza el espacio horizontal en terminales medianas."
							: "[Standard: 50 cols] · Dimensiones amplias oficiales de Gentle Shell.",
					};
				},
				action: () => {
					const s = readWiloxSettings().sidebar;
					const nextW = s.width === 38 ? 50 : 38;
					setActiveRailWidth(nextW);
				},
			},
			{
				id: "sidebar-order-preset",
				label: () => {
					const s = readWiloxSettings().sidebar;
					const presetLabels: Record<SidebarOrderPreset, string> = {
						standard: "1. Estándar (Status ➔ Sentinel ➔ Jobs ➔ Todo)",
						"sentinel-top": "2. Sentinel Top (Sentinel ➔ Status ➔ Jobs ➔ Todo)",
						"tasks-first": "3. Tareas Primero (Status ➔ Todo ➔ Jobs ➔ Sentinel)",
						custom: "4. Personalizado (Orden Arbitrario Libre)",
					};
					return `Esquema de Orden: [${presetLabels[s.orderPreset]}]`;
				},
				preview: () => {
					const s = readWiloxSettings().sidebar;
					const samples: Record<SidebarOrderPreset, string> = {
						standard: [
							"┌─ Preview: [1. Estándar] ────────────────────────────────────────┐",
							"│ ✿ Gentle Shell ✿ (Banner Cabecera)                              │",
							"│ 1. Status Bar (footer)      · Modelo activo y Git branch        │",
							"│ 2. ⚡ CPAMC Sentinel        · Cuota, Líderes y Centinela        │",
							"│ 3. Jobs & Tasks             · Procesos en segundo plano         │",
							"│ 4. Agents                   · Subagentes activos                │",
							"│ 5. Todo                     · Checklist de tareas               │",
							"└─────────────────────────────────────────────────────────────────┘",
						].join("\n"),
						"sentinel-top": [
							"┌─ Preview: [2. Sentinel Top] (Monitoreo Prioritario) ────────────┐",
							"│ ✿ Gentle Shell ✿ (Banner Cabecera)                              │",
							"│ 1. ⚡ CPAMC Sentinel        · Cuota, Líderes y Centinela [TOP]  │",
							"│ 2. Status Bar (footer)      · Modelo activo y Git branch        │",
							"│ 3. Jobs & Tasks             · Procesos en segundo plano         │",
							"│ 4. Agents                   · Subagentes activos                │",
							"│ 5. Todo                     · Checklist de tareas               │",
							"└─────────────────────────────────────────────────────────────────┘",
						].join("\n"),
						"tasks-first": [
							"┌─ Preview: [3. Tareas Primero] (Enfoque Productividad) ──────────┐",
							"│ ✿ Gentle Shell ✿ (Banner Cabecera)                              │",
							"│ 1. Status Bar (footer)      · Modelo activo y Git branch        │",
							"│ 2. Todo                     · Checklist de tareas [PRIORIDAD]   │",
							"│ 3. Jobs & Tasks             · Procesos en segundo plano         │",
							"│ 4. Agents                   · Subagentes activos                │",
							"│ 5. ⚡ CPAMC Sentinel        · Cuota al pie del riel             │",
							"└─────────────────────────────────────────────────────────────────┘",
						].join("\n"),
						custom: [
							"┌─ Preview: [4. Personalizado] (Orden Arbitrario) ────────────────┐",
							"│ ✿ Gentle Shell ✿ (Banner Cabecera)                              │",
							"│ Distribución reordenada libremente por el usuario.              │",
							"│ Usa la opción 'Mover Sentinel' abajo para cambiar de posición.  │",
							"└─────────────────────────────────────────────────────────────────┘",
						].join("\n"),
					};
					return {
						title: "Gentle Shell · Esquema de Distribución",
						sample: samples[s.orderPreset],
					};
				},
				action: () => {
					const s = readWiloxSettings().sidebar;
					const cycle: SidebarOrderPreset[] = ["standard", "sentinel-top", "tasks-first"];
					const nextIdx = (cycle.indexOf(s.orderPreset) + 1) % cycle.length;
					const nextPreset = cycle[nextIdx]!;
					writeWiloxSettings({ sidebar: { ...s, orderPreset: nextPreset } });
					updateGlobalSidebarOrder();
					syncSidebarLayout();
				},
			},
			{
				id: "sidebar-shift-sentinel",
				label: () => {
					const s = readWiloxSettings().sidebar;
					const currentOrder = s.customOrder && s.customOrder.length > 0
						? s.customOrder
						: getResolvedSidebarSections(s.orderPreset, s.visibility, undefined, false);
					const idx = currentOrder.indexOf("sentinel");
					const posStr = idx !== -1 ? `#${idx + 1}` : "Oculto";
					const actionHint = idx === 0 ? "Bajar ▼" : "Subir ▲";
					return `Mover Sentinel: [Posición ${posStr} ➔ ${actionHint}]`;
				},
				preview: () => {
					const s = readWiloxSettings().sidebar;
					const currentOrder = s.customOrder && s.customOrder.length > 0
						? s.customOrder
						: getResolvedSidebarSections(s.orderPreset, s.visibility, undefined, false);
					const idx = currentOrder.indexOf("sentinel");
					return {
						title: "Reordenamiento Libre del Sentinel",
						sample: [
							`Posición actual en la pila: ${idx + 1} de ${currentOrder.length}`,
							`Secuencia: [ ${currentOrder.join(" ➔ ")} ]`,
							"Presiona Enter para alternar y desplazar la tarjeta dentro del riel.",
						].join("\n"),
					};
				},
				action: () => {
					const s = readWiloxSettings().sidebar;
					const currentOrder = s.customOrder && s.customOrder.length > 0
						? s.customOrder
						: getResolvedSidebarSections(s.orderPreset, s.visibility, undefined, false);
					const idx = currentOrder.indexOf("sentinel");
					const direction = idx === 0 ? "down" : "up";
					shiftSentinelOrder(direction);
				},
			},
			{
				id: "sidebar-smart-focus",
				label: () => {
					const s = readWiloxSettings().sidebar;
					return `Smart Focus (Alerta Roja): [${s.smartFocusOnIncident ? "ON" : "OFF"}]`;
				},
				preview: () => ({
					title: "Smart Focus · Elevación Dinámica en Incidentes",
					sample: [
						"Si ocurre un HTTP 429, disyuntor o ciclo de bucle repetitivo:",
						" • [ON]  Eleva automáticamente a CPAMC Sentinel a la posición #1.",
						" • Al normalizarse el incidente, regresa a su posición configurada.",
						" • [OFF] Mantiene el orden estricto configurado sin importar incidentes.",
					].join("\n"),
				}),
				action: () => {
					const s = readWiloxSettings().sidebar;
					writeWiloxSettings({
						sidebar: { ...s, smartFocusOnIncident: !s.smartFocusOnIncident },
					});
					updateGlobalSidebarOrder();
					syncSidebarLayout();
				},
			},
			{
				id: "sidebar-adaptive-vertical",
				label: () => {
					const s = readWiloxSettings().sidebar;
					return `Auto-Colapso en Pantallas Bajas: [${s.adaptiveVerticalBudgeting ? "ON" : "OFF"}]`;
				},
				preview: () => ({
					title: "Adaptive Vertical Budgeting",
					sample: [
						"Ajusta el despliegue cuando la terminal tiene poca altura (<32 líneas):",
						" • [ON]  Auto-compacta tarjetas inferiores para proteger la vista de Status y Cuota.",
						" • [OFF] Despliega tarjetas completas requiriendo scroll manual.",
					].join("\n"),
				}),
				action: () => {
					const s = readWiloxSettings().sidebar;
					writeWiloxSettings({
						sidebar: { ...s, adaptiveVerticalBudgeting: !s.adaptiveVerticalBudgeting },
					});
					updateGlobalSidebarOrder();
					syncSidebarLayout();
				},
			},
			{
				id: "sidebar-floating-hud",
				label: () => {
					const s = readWiloxSettings().sidebar;
					return `HUD Mini-Pill sin Riel: [${s.floatingHudWhenDisabled ? "ON" : "OFF"}]`;
				},
				preview: () => ({
					title: "HUD Mini-Pill en Status Bar",
					sample: [
						"Cuando apagas el riel derecho para tener chat a 160 columnas:",
						" • [ON]  Inyecta cápsula mínima: [⚡ 97% ok · 2h35m] en la barra de status.",
						" • [OFF] Oculta toda telemetría de cuota al desactivar el sidebar.",
					].join("\n"),
				}),
				action: () => {
					const s = readWiloxSettings().sidebar;
					writeWiloxSettings({
						sidebar: { ...s, floatingHudWhenDisabled: !s.floatingHudWhenDisabled },
					});
					syncSidebarLayout();
				},
			},
			{
				id: "sidebar-vis-status",
				label: () => {
					const s = readWiloxSettings().sidebar;
					return `Tarjeta Status (footer): [${s.visibility.footer ? "ON" : "OFF"}]`;
				},
				preview: () => ({
					title: "Tarjeta Status Bar (Modelo & Git)",
					sample: "Muestra el modelo de IA conectado, rama actual de git y estado de MCPs.",
				}),
				action: () => {
					const s = readWiloxSettings().sidebar;
					writeWiloxSettings({
						sidebar: {
							...s,
							visibility: { ...s.visibility, footer: !s.visibility.footer },
						},
					});
					updateGlobalSidebarOrder();
					syncSidebarLayout();
				},
			},
			{
				id: "sidebar-vis-sentinel",
				label: () => {
					const s = readWiloxSettings().sidebar;
					return `Tarjeta Sentinel (CPAMC): [${s.visibility.sentinel ? "ON" : "OFF"}]`;
				},
				preview: () => ({
					title: "Tarjeta CPAMC Sentinel",
					sample: "Telemetría viva de cuotas, reloj de 5h/semanal, líderes y centinela Cuidando el Chat.",
				}),
				action: () => {
					const s = readWiloxSettings().sidebar;
					writeWiloxSettings({
						sidebar: {
							...s,
							visibility: { ...s.visibility, sentinel: !s.visibility.sentinel },
						},
					});
					updateGlobalSidebarOrder();
					syncSidebarLayout();
				},
			},
			{
				id: "sidebar-vis-jobs",
				label: () => {
					const s = readWiloxSettings().sidebar;
					return `Tarjeta Jobs / Tareas: [${s.visibility.jobs ? "ON" : "OFF"}]`;
				},
				preview: () => ({
					title: "Tarjeta Jobs (Procesos en segundo plano)",
					sample: "Muestra las tareas asíncronas y comandos en segundo plano en ejecución.",
				}),
				action: () => {
					const s = readWiloxSettings().sidebar;
					writeWiloxSettings({
						sidebar: {
							...s,
							visibility: { ...s.visibility, jobs: !s.visibility.jobs },
						},
					});
					updateGlobalSidebarOrder();
					syncSidebarLayout();
				},
			},
			{
				id: "sidebar-vis-agents",
				label: () => {
					const s = readWiloxSettings().sidebar;
					return `Tarjeta Agents / Subagentes: [${s.visibility.agents ? "ON" : "OFF"}]`;
				},
				preview: () => ({
					title: "Tarjeta Agents (Planned Workflow)",
					sample: "Indica el estado del orquestador y los subagentes delegados (00-discovery a 03-verify).",
				}),
				action: () => {
					const s = readWiloxSettings().sidebar;
					writeWiloxSettings({
						sidebar: {
							...s,
							visibility: { ...s.visibility, agents: !s.visibility.agents },
						},
					});
					updateGlobalSidebarOrder();
					syncSidebarLayout();
				},
			},
			{
				id: "sidebar-vis-todo",
				label: () => {
					const s = readWiloxSettings().sidebar;
					return `Tarjeta Todo / Checklist: [${s.visibility.todo ? "ON" : "OFF"}]`;
				},
				preview: () => ({
					title: "Tarjeta Todo (Checklist)",
					sample: "Lista de pasos completados y pendientes del plan de trabajo activo.",
				}),
				action: () => {
					const s = readWiloxSettings().sidebar;
					writeWiloxSettings({
						sidebar: {
							...s,
							visibility: { ...s.visibility, todo: !s.visibility.todo },
						},
					});
					updateGlobalSidebarOrder();
					syncSidebarLayout();
				},
			},
		],
	});
}

/**
 * Módulo 2: Chat Scanner & Working Comet
 */
function registerChatScannerModule(): void {
	registerCommunityModule({
		id: "chat-scanner",
		title: "Chat Scanner & Working Comet",
		order: 20,
		summary: () => {
			const s = readWiloxSettings().scanner;
			return `${s.username} · ${s.zenMode ? "Zen Mode" : "Dynamic"}`;
		},
		rows: [
			{
				id: "scanner-badge-name",
				label: () => {
					const s = readWiloxSettings().scanner;
					return `Badge Identity: [${s.username}] ➔ Enter to change`;
				},
				preview: () => {
					const s = readWiloxSettings().scanner;
					return {
						title: "Chat Scanner · Badge Identity",
						sample: `[IDLE] ╭─ 󰣇 ${s.username} ✿ 󰣇 Ctx: 24% [ 󰁨×1 ] ─────────────────────────────────────────╮`,
					};
				},
				action: async (inline?: any) => {
					const s = readWiloxSettings().scanner;
					if (inline && typeof inline.input === "function") {
						const inputName = await inline.input({ prompt: "Badge Identity", value: s.username });
						if (inputName && inputName.trim()) {
							writeWiloxSettings({ scanner: { ...s, username: inputName.trim() } });
						}
					} else {
						const nextName = s.username === "Wilox" ? "archlinux" : "Wilox";
						writeWiloxSettings({ scanner: { ...s, username: nextName } });
					}
				},
			},
			{
				id: "scanner-comet",
				label: () => {
					const s = readWiloxSettings().scanner;
					return s.zenMode
						? "Working Comet: [OFF · Zen Mode] ➔ Enter to enable"
						: "Working Comet: [ON · 10 cols forward LTR] ➔ Enter to disable";
				},
				preview: () => ({
					title: "Chat Scanner · Working Comet",
					sample: `[WORKING] ╭── ◆●•∙· ✿ exploring… │ [2.8s] │ 󰁨×1 │ Context ▰▰▱▱▱▱▱▱ 24% ──────╮`,
				}),
				action: () => {
					const s = readWiloxSettings().scanner;
					writeWiloxSettings({ scanner: { ...s, zenMode: !s.zenMode } });
				},
			},
			{
				id: "scanner-context",
				label: () => {
					const s = readWiloxSettings().scanner;
					const show = s.showWorkingContext && s.showContextInIdle;
					return `Context Gauge: [${show ? "Visible · Full" : "Hidden"}] ➔ Enter to toggle`;
				},
				preview: () => ({
					title: "Chat Scanner · Context Gauge",
					sample: `Muestra el medidor visual de contexto y tokens en el marco del prompt.`,
				}),
				action: () => {
					const s = readWiloxSettings().scanner;
					const next = !(s.showWorkingContext && s.showContextInIdle);
					writeWiloxSettings({
						scanner: { ...s, showWorkingContext: next, showContextInIdle: next },
					});
				},
			},
			{
				id: "scanner-duration",
				label: () => {
					const s = readWiloxSettings().scanner;
					return `Duration Badge: [${s.showWorkingDuration ? "Visible [3.4s]" : "Hidden"}] ➔ Enter to toggle`;
				},
				preview: () => ({
					title: "Chat Scanner · Duration Badge",
					sample: `Muestra los segundos transcurridos en tiempo real durante la ejecución de tareas.`,
				}),
				action: () => {
					const s = readWiloxSettings().scanner;
					writeWiloxSettings({ scanner: { ...s, showWorkingDuration: !s.showWorkingDuration } });
				},
			},
			{
				id: "scanner-compaction",
				label: () => {
					const s = readWiloxSettings().scanner;
					return `Compaction Badge: [${s.showCompactionCount ? "Visible [󰁨×n]" : "Hidden"}] ➔ Enter to toggle`;
				},
				preview: () => ({
					title: "Chat Scanner · Compaction Badge",
					sample: `Indica la cantidad de compactaciones realizadas en la sesión actual.`,
				}),
				action: () => {
					const s = readWiloxSettings().scanner;
					writeWiloxSettings({ scanner: { ...s, showCompactionCount: !s.showCompactionCount } });
				},
			},
			{
				id: "scanner-zen",
				label: () => {
					const s = readWiloxSettings().scanner;
					return `Zen Mode: [${s.zenMode ? "Active (Quiet)" : "Inactive (Dynamic)"}] ➔ Enter to toggle`;
				},
				preview: () => ({
					title: "Chat Scanner · Zen Mode",
					sample: `Desactiva animaciones y cometas para ahorrar CPU o trabajar sin distracciones.`,
				}),
				action: () => {
					const s = readWiloxSettings().scanner;
					writeWiloxSettings({ scanner: { ...s, zenMode: !s.zenMode } });
				},
			},
		],
	});
}

/**
 * Escáner de extensiones instaladas para auto-descubrimiento mediante package.json (Punto 2.1)
 */
export function autoDiscoverCommunityExtensions(): void {
	const searchRoots = [
		join(homedir(), ".pi", "gentle-shell", "extensions"),
		join(homedir(), ".gentle-shell", "agent", "extensions"),
		join(homedir(), ".pi", "agent", "extensions"),
	];

	const discoveredIds = new Set<string>();

	for (const root of searchRoots) {
		if (!existsSync(root)) continue;
		try {
			const entries = readdirSync(root, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isDirectory()) continue;
				const pkgPath = join(root, entry.name, "package.json");
				if (!existsSync(pkgPath)) continue;
				try {
					const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
					if (pkg.wiloxCommunity && typeof pkg.wiloxCommunity === "object") {
						const manifest = pkg.wiloxCommunity;
						const modId = manifest.id || manifest.moduleId;
						if (modId && !discoveredIds.has(modId) && !globalState[COMMUNITY_REGISTRY_SLOT]?.has(modId)) {
							discoveredIds.add(modId);
							// Módulo descubierto por metadata: registro silencioso sin ensuciar la salida de terminal en arranque
							if (process.env.DEBUG_WILOXDEV === "1" || process.env.DEBUG_WILOXDEV === "true") {
								console.debug(`[WiloxDev] Descubierto módulo de comunidad por metadata: ${modId}`);
							}
						}
					}
				} catch {}
			}
		} catch {}
	}
}

const LAYOUT_TARGET_FILES = [
	"/home/wilox/.local/share/mise/installs/node/24.21.0/lib/node_modules/gentle-pi/lib/shell-sidebar-layout.ts",
	"/home/wilox/.local/share/gentle-shell/install/runtime/main-sdk/lib/shell-sidebar-layout.ts",
	"/home/wilox/.local/share/gentle-shell/install/prefix/lib/node_modules/gentle-pi/lib/shell-sidebar-layout.ts",
	"/home/wilox/.local/share/gentle-shell/install/runtime/main-source/lib/shell-sidebar-layout.ts",
	"/home/wilox/.local/share/gentle-shell/install/runtime/project/node_modules/gentle-pi/lib/shell-sidebar-layout.ts",
	"/home/wilox/projects/investigaciones/gentle-shell-official/lib/shell-sidebar-layout.ts",
];

const GENTLE_SHELL_TARGET_FILES = [
	"/home/wilox/.local/share/mise/installs/node/24.21.0/lib/node_modules/gentle-pi/extensions/gentle-shell.ts",
	"/home/wilox/.local/share/gentle-shell/install/runtime/main-sdk/extensions/gentle-shell.ts",
	"/home/wilox/.local/share/gentle-shell/install/prefix/lib/node_modules/gentle-pi/extensions/gentle-shell.ts",
	"/home/wilox/.local/share/gentle-shell/install/runtime/main-source/extensions/gentle-shell.ts",
	"/home/wilox/.local/share/gentle-shell/install/runtime/project/node_modules/gentle-pi/extensions/gentle-shell.ts",
	"/home/wilox/projects/investigaciones/gentle-shell-official/extensions/gentle-shell.ts",
];

const CUSTOMIZE_VIEW_TARGET_FILES = [
	"/home/wilox/.local/share/mise/installs/node/24.21.0/lib/node_modules/gentle-pi/lib/visual-customize-view.ts",
	"/home/wilox/.local/share/gentle-shell/install/runtime/main-sdk/lib/visual-customize-view.ts",
	"/home/wilox/.local/share/gentle-shell/install/prefix/lib/node_modules/gentle-pi/lib/visual-customize-view.ts",
	"/home/wilox/.local/share/gentle-shell/install/runtime/main-source/lib/visual-customize-view.ts",
	"/home/wilox/.local/share/gentle-shell/install/runtime/project/node_modules/gentle-pi/lib/visual-customize-view.ts",
	"/home/wilox/projects/investigaciones/gentle-shell-official/lib/visual-customize-view.ts",
];

function clearJitiCache(): void {
	const jitiDirs = [
		"/home/wilox/.local/share/gentle-shell/install/tmp/jiti",
		join(tmpdir(), "jiti"),
	];
	for (const dir of jitiDirs) {
		try {
			if (existsSync(dir)) {
				rmSync(dir, { recursive: true, force: true });
			}
		} catch {}
	}
}

/**
 * Parcheo reactivo y quirúrgico de shell-sidebar-layout.ts
 */
export function syncSidebarLayout(targetWidth?: number): boolean {
	const settings = readWiloxSettings();
	const width = targetWidth ?? settings.sidebar.width;
	const breakpoint = width <= 38 ? 115 : 140;
	const gap = width <= 38 ? 2 : 3;

	globalState[COMMUNITY_RAIL_SLOT] = width;
	let modified = false;

	for (const file of LAYOUT_TARGET_FILES) {
		if (!existsSync(file)) continue;
		try {
			let content = readFileSync(file, "utf8");
			let fileModified = false;

			const breakpointPattern = /export const SIDEBAR_BREAKPOINT\s*=\s*\d+;/;
			const expectedBreakpoint = `export const SIDEBAR_BREAKPOINT = ${breakpoint};`;
			if (breakpointPattern.test(content)) {
				const currentMatch = content.match(breakpointPattern)?.[0];
				if (currentMatch !== expectedBreakpoint) {
					content = content.replace(breakpointPattern, expectedBreakpoint);
					fileModified = true;
				}
			}

			const railWidthPattern = /const RAIL_WIDTH\s*=\s*\d+;/;
			const expectedRailWidth = `const RAIL_WIDTH = ${width};`;
			if (railWidthPattern.test(content)) {
				const currentMatch = content.match(railWidthPattern)?.[0];
				if (currentMatch !== expectedRailWidth) {
					content = content.replace(railWidthPattern, expectedRailWidth);
					fileModified = true;
				}
			}

			const gapPattern = /const GAP\s*=\s*\d+;/;
			const expectedGap = `const GAP = ${gap};`;
			if (gapPattern.test(content)) {
				const currentMatch = content.match(gapPattern)?.[0];
				if (currentMatch !== expectedGap) {
					content = content.replace(gapPattern, expectedGap);
					fileModified = true;
				}
			}

			if (!content.includes("COMMUNITY_RAIL_SLOT")) {
				const injection = `
const COMMUNITY_RAIL_SLOT = Symbol.for("gentle-pi.community.rail-width");
const COMMUNITY_SIDEBAR_ORDER_SLOT = Symbol.for("gentle-pi.community.sidebar.order");
const communityState = globalThis as typeof globalThis & {
	[COMMUNITY_RAIL_SLOT]?: number;
	[COMMUNITY_SIDEBAR_ORDER_SLOT]?: string[];
};

export function communityRailWidth(): number {
	return typeof communityState[COMMUNITY_RAIL_SLOT] === "number" ? communityState[COMMUNITY_RAIL_SLOT]! : RAIL_WIDTH;
}
export function setCommunityRailWidth(width: number): void {
	communityState[COMMUNITY_RAIL_SLOT] = width;
}
export function communitySidebarSections(): string[] {
	if (Array.isArray(communityState[COMMUNITY_SIDEBAR_ORDER_SLOT]) && communityState[COMMUNITY_SIDEBAR_ORDER_SLOT]!.length > 0) {
		return communityState[COMMUNITY_SIDEBAR_ORDER_SLOT]!;
	}
	return ["footer", "sentinel", "jobs", "agents", "todo"];
}
`;
				content = content.replace("export const SIDEBAR_RAIL_COLUMNS = RAIL_WIDTH + GAP;", `export const SIDEBAR_RAIL_COLUMNS = RAIL_WIDTH + GAP;\n${injection}`);
				fileModified = true;
			}

			// Parcheo dinámico de sections en el riel
			const sectionsStatic1 = 'const sections = ["footer", "jobs", "agents", "todo"]';
			const sectionsStatic2 = 'const sections = ["footer", "agents", "todo"]';
			const sectionsDynamic = 'const sections = (typeof communitySidebarSections === "function" ? communitySidebarSections() : ["footer", "sentinel", "jobs", "agents", "todo"])';
			if (content.includes(sectionsStatic1)) {
				content = content.replace(sectionsStatic1, sectionsDynamic);
				fileModified = true;
			} else if (content.includes(sectionsStatic2)) {
				content = content.replace(sectionsStatic2, sectionsDynamic);
				fileModified = true;
			}

			if (fileModified) {
				const temp = `${file}.${randomUUID()}.tmp`;
				writeFileSync(temp, content, "utf8");
				renameSync(temp, file);
				modified = true;
			}
		} catch (err) {
			console.error(`[WiloxDev] Error sincronizando ${file}:`, err);
		}
	}

	if (modified) {
		clearJitiCache();
	}
	return modified;
}

const WILOX_CUSTOMIZE_MARKER = "/* WILOXDEV_CUSTOMIZE_SECTION_START */";

/**
 * Inyecta el Motor de Acordeón Dinámico puro en extensions/gentle-shell.ts
 */
export function syncCustomizeCategory(): boolean {
	let modified = false;

	// 1. Asegurar tipos en visual-customize-view.ts
	for (const file of CUSTOMIZE_VIEW_TARGET_FILES) {
		if (!existsSync(file)) continue;
		try {
			let content = readFileSync(file, "utf8");
			if (!content.includes('"Community"') && content.includes('"Reset"')) {
				content = content.replace('"Reset"', '"Reset" | "Community"');
				const temp = `${file}.${randomUUID()}.tmp`;
				writeFileSync(temp, content, "utf8");
				renameSync(temp, file);
				modified = true;
			}
		} catch {}
	}

	// 2. Inyectar Motor de Acordeón 100% Dinámico
	const injectionCode = `
			${WILOX_CUSTOMIZE_MARKER}
			category = "Community" as any;
			const COMM_REGISTRY_SLOT = Symbol.for("gentle-pi.community.wiloxdev.registry");
			const COMM_EXPANDED_SLOT = Symbol.for("gentle-pi.community.wiloxdev.expanded");
			const commBus = globalThis as typeof globalThis & {
				[COMM_REGISTRY_SLOT]?: Map<string, { id: string; title: string; order?: number; summary: () => string; rows: Array<{ id: string; label: () => string; preview: () => { title: string; sample: string }; action: (inline?: any) => void | Promise<void> }> }>;
				[COMM_EXPANDED_SLOT]?: string | null;
			};
			const commRegistry = commBus[COMM_REGISTRY_SLOT] ??= new Map();

			// 1. Opción Maestra: Preset One-Click Setup
			rows.push({
				category,
				label: () => "⚡ WiloxDev Suite: Apply Optimal Defaults (One-Click)",
				preview: () => ({
					title: "WiloxDev Suite · One-Click Setup",
					sample: "Aplica de un golpe la configuración recomendada: Sidebar Compacto (38 cols) + Chat Scanner activo con cometa + Badge Wilox.",
				}),
				action: () => {
					try {
						const m = require("/home/wilox/.pi/gentle-shell/extensions/cpamc-auto-switcher/src/wilox-layout-manager.js");
						m.applyWiloxDevOptimalDefaults();
						ctx.ui.notify?.("⚡ WiloxDev Suite: Configuración recomendada aplicada con éxito.", "info");
					} catch {}
					renderHost?.invalidateSidebar?.();
					renderHost?.requestRender();
					requestCustomizeRender?.();
				},
			});

			// 2. Despachador de Acordeón 100% Dinámico (itera commRegistry sin listas fijas)
			const sortedModules = [...commRegistry.values()].sort((a, b) => (a.order || 50) - (b.order || 50));
			for (const mod of sortedModules) {
				const isExpanded = () => commBus[COMM_EXPANDED_SLOT] === mod.id;

				// Cabecera de Carpeta de Acordeón
				rows.push({
					category,
					label: () => isExpanded()
						? \`▼ 📂 WiloxDev · \${mod.title} (\${mod.summary()}) ➔ [Press Enter to collapse]\`
						: \`► 📁 WiloxDev · \${mod.title} (\${mod.summary()}) ➔ [Press Enter to expand]\`,
					preview: () => ({
						title: \`WiloxDev · \${mod.title}\`,
						sample: isExpanded()
							? \`[Módulo Desplegado] Pulsa Enter para contraer y ocultar sus opciones.\`
							: \`[Módulo Contraído] Pulsa Enter para desplegar y ajustar sus opciones.\`,
					}),
					action: () => {
						const nextState = isExpanded() ? null : mod.id;
						commBus[COMM_EXPANDED_SLOT] = nextState;
						try {
							const m = require("/home/wilox/.pi/gentle-shell/extensions/cpamc-auto-switcher/src/wilox-layout-manager.js");
							m.setLastExpandedModule(nextState);
						} catch {}
						renderHost?.invalidateSidebar?.();
						renderHost?.requestRender();
						requestCustomizeRender?.();
					},
				});

				// Opciones hijas (visibles únicamente cuando el módulo está expandido)
				for (const child of mod.rows) {
					rows.push({
						category,
						visible: () => isExpanded(),
						label: () => \`    • \${child.label()}\`,
						preview: () => child.preview(),
						action: async (inline: any) => {
							await child.action(inline);
							renderHost?.invalidateSidebar?.();
							renderHost?.requestRender();
							requestCustomizeRender?.();
						},
					});
				}
			}
			/* WILOXDEV_CUSTOMIZE_SECTION_END */
`;

	for (const file of GENTLE_SHELL_TARGET_FILES) {
		if (!existsSync(file)) continue;
		try {
			let content = readFileSync(file, "utf8");
			let fileModified = false;

			if (content.includes(WILOX_CUSTOMIZE_MARKER)) {
				const regex = /\/\* WILOXDEV_CUSTOMIZE_SECTION_START \*\/[\s\S]*?\/\* WILOXDEV_CUSTOMIZE_SECTION_END \*\//;
				if (regex.test(content)) {
					content = content.replace(regex, injectionCode.trim());
					fileModified = true;
				}
			} else if (content.includes('category = "Reset";')) {
				content = content.replace('category = "Reset";', `${injectionCode}\n\t\t\tcategory = "Reset";`);
				fileModified = true;
			}

			if (fileModified) {
				const temp = `${file}.${randomUUID()}.tmp`;
				writeFileSync(temp, content, "utf8");
				renameSync(temp, file);
				modified = true;
			}
		} catch (err) {
			console.error(`[WiloxDev] Error inyectando acordeón en ${file}:`, err);
		}
	}

	if (modified) {
		clearJitiCache();
	}
	return modified;
}

/**
 * Inicialización al arrancar la extensión cpamc-auto-switcher
 */
export function initWiloxLayoutManager(): void {
	try {
		const settings = readWiloxSettings();
		writeWiloxSettings(settings);

		// 1. Restaurar último estado del acordeón en memoria
		globalState[COMMUNITY_EXPANDED_SLOT] = settings.ui.lastExpandedModule;

		// 2. Registrar módulos del ecosistema
		updateGlobalSidebarOrder();
		registerSidebarModule();
		registerChatScannerModule();

		// 3. Auto-descubrimiento por package.json
		autoDiscoverCommunityExtensions();

		// 4. Sincronizar el layout
		syncSidebarLayout(settings.sidebar.width);

		// 5. Sincronizar el acordeón en /gentle:customize
		syncCustomizeCategory();
	} catch (err) {
		console.error("[WiloxDev] Error inicializando WiloxLayoutManager:", err);
	}
}
