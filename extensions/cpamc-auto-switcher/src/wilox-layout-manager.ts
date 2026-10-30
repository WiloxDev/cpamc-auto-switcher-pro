import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

export interface WiloxSettings {
	schema: "wiloxdev.settings/v1";
	sidebarWidth: number;
	sidebarBreakpoint: number;
	gap: number;
}

const DEFAULT_SETTINGS: WiloxSettings = {
	schema: "wiloxdev.settings/v1",
	sidebarWidth: 38,
	sidebarBreakpoint: 115,
	gap: 2,
};

const COMMUNITY_RAIL_SLOT = Symbol.for("gentle-pi.community.rail-width");
const globalState = globalThis as typeof globalThis & { [COMMUNITY_RAIL_SLOT]?: number };

export function getWiloxSettingsDir(): string {
	const candidates = [
		join(homedir(), ".pi", "gentle-shell"),
		join(homedir(), ".gentle-shell"),
		join(homedir(), ".pi", "agent"),
	];
	for (const dir of candidates) {
		if (existsSync(dir)) return dir;
	}
	const fallback = join(homedir(), ".pi", "gentle-shell");
	try {
		mkdirSync(fallback, { recursive: true });
	} catch {
		// Ignored
	}
	return fallback;
}

export function getWiloxSettingsPath(): string {
	return join(getWiloxSettingsDir(), "wilox-settings.json");
}

export function readWiloxSettings(): WiloxSettings {
	const path = getWiloxSettingsPath();
	try {
		if (existsSync(path)) {
			const data = JSON.parse(readFileSync(path, "utf8"));
			if (data && typeof data.sidebarWidth === "number") {
				return { ...DEFAULT_SETTINGS, ...data };
			}
		}
	} catch {
		// Fallback to default
	}
	return { ...DEFAULT_SETTINGS };
}

/**
 * Escritura Atómica Crash-Safe (patrón Gentle Shell: tmp + renameSync con mode 0o600)
 */
export function writeWiloxSettings(settings: Partial<WiloxSettings>): WiloxSettings {
	const current = readWiloxSettings();
	const updated: WiloxSettings = { ...current, ...settings };
	const dir = getWiloxSettingsDir();
	const path = getWiloxSettingsPath();
	const temp = `${path}.${randomUUID()}.tmp`;

	try {
		mkdirSync(dir, { recursive: true });
		writeFileSync(temp, JSON.stringify(updated, null, 2) + "\n", { mode: 0o600 });
		renameSync(temp, path);
	} catch (err) {
		try { unlinkSync(temp); } catch { /* Ignore */ }
		console.error("[WiloxDev] Error guardando wilox-settings:", err);
	}

	// Sincronizar en memoria de inmediato para reactividad en caliente
	if (typeof updated.sidebarWidth === "number") {
		globalState[COMMUNITY_RAIL_SLOT] = updated.sidebarWidth;
	}

	return updated;
}

export function getActiveRailWidth(): number {
	if (typeof globalState[COMMUNITY_RAIL_SLOT] === "number") {
		return globalState[COMMUNITY_RAIL_SLOT]!;
	}
	const settings = readWiloxSettings();
	globalState[COMMUNITY_RAIL_SLOT] = settings.sidebarWidth;
	return settings.sidebarWidth;
}

export function setActiveRailWidth(width: number): void {
	const safeWidth = width <= 38 ? 38 : 50;
	writeWiloxSettings({
		sidebarWidth: safeWidth,
		sidebarBreakpoint: safeWidth <= 38 ? 115 : 140,
		gap: safeWidth <= 38 ? 2 : 3,
	});
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
		} catch {
			// Ignore
		}
	}
}

/**
 * Parcheo reactivo y quirúrgico de shell-sidebar-layout.ts
 */
export function syncSidebarLayout(targetWidth?: number): boolean {
	const settings = readWiloxSettings();
	const width = targetWidth ?? settings.sidebarWidth;
	const breakpoint = width <= 38 ? 115 : 140;
	const gap = width <= 38 ? 2 : 3;

	// Sincronizar slot en memoria
	globalState[COMMUNITY_RAIL_SLOT] = width;

	let modified = false;

	for (const file of LAYOUT_TARGET_FILES) {
		if (!existsSync(file)) continue;
		try {
			let content = readFileSync(file, "utf8");
			let fileModified = false;

			// Reemplazar SIDEBAR_BREAKPOINT
			const breakpointPattern = /export const SIDEBAR_BREAKPOINT\s*=\s*\d+;/;
			const expectedBreakpoint = `export const SIDEBAR_BREAKPOINT = ${breakpoint};`;
			if (breakpointPattern.test(content)) {
				const currentMatch = content.match(breakpointPattern)?.[0];
				if (currentMatch !== expectedBreakpoint) {
					content = content.replace(breakpointPattern, expectedBreakpoint);
					fileModified = true;
				}
			}

			// Reemplazar RAIL_WIDTH
			const railWidthPattern = /const RAIL_WIDTH\s*=\s*\d+;/;
			const expectedRailWidth = `const RAIL_WIDTH = ${width};`;
			if (railWidthPattern.test(content)) {
				const currentMatch = content.match(railWidthPattern)?.[0];
				if (currentMatch !== expectedRailWidth) {
					content = content.replace(railWidthPattern, expectedRailWidth);
					fileModified = true;
				}
			}

			// Reemplazar GAP
			const gapPattern = /const GAP\s*=\s*\d+;/;
			const expectedGap = `const GAP = ${gap};`;
			if (gapPattern.test(content)) {
				const currentMatch = content.match(gapPattern)?.[0];
				if (currentMatch !== expectedGap) {
					content = content.replace(gapPattern, expectedGap);
					fileModified = true;
				}
			}

			// Inyectar soporte para reactividad en vivo si no existe
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

			// Asegurar que hstackHost use communityRailWidth dinámico
			if (content.includes("const hstackHost:") && !content.includes("const currentRailBasis = communityRailWidth()")) {
				content = content.replace(
					/\[NODE\]:\s*\(\)\s*=>\s*\(\{\s*type:\s*"hstack",\s*gap:\s*GAP,\s*align:\s*"stretch",\s*entries:\s*\[\s*\{\s*component:\s*left,\s*basis:\s*0,\s*grow:\s*1,\s*shrink:\s*1,\s*minSize:\s*1\s*\},\s*\{\s*component:\s*scroll,\s*basis:\s*RAIL_WIDTH,\s*grow:\s*0,\s*shrink:\s*0,\s*minSize:\s*RAIL_WIDTH\s*\},/g,
					`[NODE]: () => {
					const currentRailBasis = communityRailWidth();
					const currentGap = currentRailBasis <= 38 ? 2 : 3;
					state.railColumns = currentRailBasis + currentGap;
					return { type: "hstack", gap: currentGap, align: "stretch", entries: [
						{ component: left, basis: 0, grow: 1, shrink: 1, minSize: 1 },
						{ component: scroll, basis: currentRailBasis, grow: 0, shrink: 0, minSize: currentRailBasis },`
				);
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
 * Inyecta la categoría Community con subcategoría WiloxDev en extensions/gentle-shell.ts de forma idempotente y atómica.
 */
export function syncCustomizeCategory(): boolean {
	let modified = false;

	// 1. Asegurar tipo en visual-customize-view.ts
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
		} catch {
			// Ignore
		}
	}

	// 2. Inyectar bloque en extensions/gentle-shell.ts
	const injectionCode = `
			${WILOX_CUSTOMIZE_MARKER}
			category = "Community" as any;
			const COMMUNITY_SLOT = Symbol.for("gentle-pi.community.rail-width");
			const commState = globalThis as typeof globalThis & { [COMMUNITY_SLOT]?: number };
			const getWiloxWidth = (): number => {
				if (typeof commState[COMMUNITY_SLOT] === "number") return commState[COMMUNITY_SLOT]!;
				try {
					const p = "${getWiloxSettingsPath()}";
					const w = JSON.parse(require("node:fs").readFileSync(p, "utf8")).sidebarWidth;
					if (typeof w === "number") {
						commState[COMMUNITY_SLOT] = w;
						return w;
					}
				} catch {}
				return 38;
			};
			const setWiloxWidth = (w: number): void => {
				commState[COMMUNITY_SLOT] = w;
				try {
					const p = "${getWiloxSettingsPath()}";
					const current = JSON.parse(require("node:fs").readFileSync(p, "utf8") || "{}");
					current.sidebarWidth = w;
					current.sidebarBreakpoint = w <= 38 ? 115 : 140;
					current.gap = w <= 38 ? 2 : 3;
					const tmp = p + "." + require("node:crypto").randomUUID() + ".tmp";
					require("node:fs").writeFileSync(tmp, JSON.stringify(current, null, 2) + "\\n", { mode: 0o600 });
					require("node:fs").renameSync(tmp, p);
				} catch {}
			};
			add(
				() => \`WiloxDev · Compact sidebar: \${getWiloxWidth() === 38 ? "ON (38 cols)" : "OFF (50 cols)"}\`,
				"Sidebar layout preference updated.",
				() => {
					const nextW = getWiloxWidth() === 38 ? 50 : 38;
					setWiloxWidth(nextW);
					renderHost?.invalidateSidebar?.();
					renderHost?.requestRender();
					requestCustomizeRender?.();
				},
				() => ({
					title: "Community · WiloxDev",
					sample: getWiloxWidth() === 38
						? "[Compact rail: ON · 38 cols] · Optimizes horizontal terminal space · Expands conversation transcript width"
						: "[Compact rail: OFF · 50 cols] · Standard Gentle Shell rail geometry",
				})
			);
			add(
				() => \`WiloxDev · Sidebar mode: \${getWiloxWidth() === 38 ? "Compact (38 cols) [current]" : "Standard (50 cols) [current]"}\`,
				"Sidebar preset updated.",
				() => {
					const nextW = getWiloxWidth() === 38 ? 50 : 38;
					setWiloxWidth(nextW);
					renderHost?.invalidateSidebar?.();
					renderHost?.requestRender();
					requestCustomizeRender?.();
				},
				() => ({
					title: "Community · WiloxDev",
					sample: getWiloxWidth() === 38
						? "Compact preset: 38 cols rail, 2 cols gap, breakpoint 115."
						: "Standard preset: 50 cols rail, 3 cols gap, breakpoint 140.",
				})
			);
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
			console.error(`[WiloxDev] Error inyectando categoría en ${file}:`, err);
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
		syncSidebarLayout(settings.sidebarWidth);
		syncCustomizeCategory();
	} catch (err) {
		console.error("[WiloxDev] Error inicializando WiloxLayoutManager:", err);
	}
}
