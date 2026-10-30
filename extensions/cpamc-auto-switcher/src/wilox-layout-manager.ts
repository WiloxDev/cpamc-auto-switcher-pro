import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

export interface WiloxUnifiedSettings {
	schema: "wiloxdev.unified/v1";
	ui: {
		lastExpandedModule: string | null;
	};
	sidebar: {
		width: number;
		breakpoint: number;
		gap: number;
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
};

const COMMUNITY_RAIL_SLOT = Symbol.for("gentle-pi.community.rail-width");
const COMMUNITY_REGISTRY_SLOT = Symbol.for("gentle-pi.community.wiloxdev.registry");
const COMMUNITY_EXPANDED_SLOT = Symbol.for("gentle-pi.community.wiloxdev.expanded");

const globalState = globalThis as typeof globalThis & {
	[COMMUNITY_RAIL_SLOT]?: number;
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
					sidebar: { ...current.sidebar, ...(data.sidebar || {}) },
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

/**
 * Módulo 1: Sidebar Geometry con terminología clara
 */
function registerSidebarModule(): void {
	registerCommunityModule({
		id: "sidebar",
		title: "Sidebar Geometry",
		order: 10,
		summary: () => `${getActiveRailWidth()} cols · ${getActiveRailWidth() <= 38 ? "Compact" : "Standard"}`,
		rows: [
			{
				id: "sidebar-toggle",
				label: () => getActiveRailWidth() === 38
					? "Width: [38 cols · Compact] ➔ Enter to switch to [50 cols · Standard]"
					: "Width: [50 cols · Standard] ➔ Enter to switch to [38 cols · Compact]",
				preview: () => ({
					title: "WiloxDev · Sidebar Geometry",
					sample: getActiveRailWidth() === 38
						? "[Compact: 38 cols] · Optimizes horizontal terminal space · Expands chat transcript width"
						: "[Standard: 50 cols] · Original Gentle Shell rail dimensions",
				}),
				action: () => {
					const nextW = getActiveRailWidth() === 38 ? 50 : 38;
					setActiveRailWidth(nextW);
				},
			},
			{
				id: "sidebar-preset",
				label: () => `Layout preset: ${getActiveRailWidth() === 38 ? "Compact (38 cols, 2 gap, 115 bp)" : "Standard (50 cols, 3 gap, 140 bp)"}`,
				preview: () => ({
					title: "WiloxDev · Sidebar Geometry",
					sample: getActiveRailWidth() === 38
						? "Compact preset: activates on terminals >= 115 cols, rail width 38, gap 2."
						: "Standard preset: activates on terminals >= 140 cols, rail width 50, gap 3.",
				}),
				action: () => {
					const nextW = getActiveRailWidth() === 38 ? 50 : 38;
					setActiveRailWidth(nextW);
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
						if (manifest.id && manifest.title && !globalState[COMMUNITY_REGISTRY_SLOT]?.has(manifest.id)) {
							// Módulo descubierto por metadata
							console.log(`[WiloxDev] Descubierto módulo de comunidad por metadata: ${manifest.id}`);
						}
					}
				} catch {}
			}
		} catch {}
	}
}

const LAYOUT_TARGET_FILES = [
	"/home/wilox/.local/share/gentle-shell/install/runtime/main-sdk/lib/shell-sidebar-layout.ts",
	"/home/wilox/.local/share/gentle-shell/install/prefix/lib/node_modules/gentle-pi/lib/shell-sidebar-layout.ts",
	"/home/wilox/.local/share/gentle-shell/install/runtime/main-source/lib/shell-sidebar-layout.ts",
	"/home/wilox/.local/share/gentle-shell/install/runtime/project/node_modules/gentle-pi/lib/shell-sidebar-layout.ts",
	"/home/wilox/projects/investigaciones/gentle-shell-official/lib/shell-sidebar-layout.ts",
];

const GENTLE_SHELL_TARGET_FILES = [
	"/home/wilox/.local/share/gentle-shell/install/runtime/main-sdk/extensions/gentle-shell.ts",
	"/home/wilox/.local/share/gentle-shell/install/prefix/lib/node_modules/gentle-pi/extensions/gentle-shell.ts",
	"/home/wilox/.local/share/gentle-shell/install/runtime/main-source/extensions/gentle-shell.ts",
	"/home/wilox/.local/share/gentle-shell/install/runtime/project/node_modules/gentle-pi/extensions/gentle-shell.ts",
	"/home/wilox/projects/investigaciones/gentle-shell-official/extensions/gentle-shell.ts",
];

const CUSTOMIZE_VIEW_TARGET_FILES = [
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
const communityState = globalThis as typeof globalThis & { [COMMUNITY_RAIL_SLOT]?: number };

export function communityRailWidth(): number {
	return typeof communityState[COMMUNITY_RAIL_SLOT] === "number" ? communityState[COMMUNITY_RAIL_SLOT]! : RAIL_WIDTH;
}
export function setCommunityRailWidth(width: number): void {
	communityState[COMMUNITY_RAIL_SLOT] = width;
}
`;
				content = content.replace("export const SIDEBAR_RAIL_COLUMNS = RAIL_WIDTH + GAP;", `export const SIDEBAR_RAIL_COLUMNS = RAIL_WIDTH + GAP;\n${injection}`);
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
