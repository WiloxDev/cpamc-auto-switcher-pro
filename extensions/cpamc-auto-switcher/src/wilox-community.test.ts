import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { register } from "node:module";

const loaderCode = `
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith(".js") && specifier.startsWith(".")) {
    try {
      const resolvedUrl = new URL(specifier, context.parentURL);
      const filePath = fileURLToPath(resolvedUrl);
      if (!existsSync(filePath)) {
        const tsPath = filePath.replace(/\\.js$/, ".ts");
        if (existsSync(tsPath)) {
          return {
            shortCircuit: true,
            url: pathToFileURL(tsPath).href,
          };
        }
      }
    } catch {}
  }
  return nextResolve(specifier, context);
}
`;

register("data:text/javascript," + encodeURIComponent(loaderCode));

const {
	registerCpamcSentinelCustomizeModule,
	COMMUNITY_REGISTRY_SLOT,
} = await import("./wilox-community.js");
const {
	setQuotaCardViewMode,
	getQuotaCardViewMode,
	setActiveQuotaCardTab,
	getActiveQuotaCardTab,
	clearTelemetryHistoriesForTest,
} = await import("./store.js");
type WiloxCommunityModule = any;

describe("WiloxDev Modular Accordion Protocol (/gentle:customize) - CPAMC Sentinel", () => {
	let mockAdapter: any;
	let renderRequested: boolean;
	let mockTui: any;

	beforeEach(() => {
		clearTelemetryHistoriesForTest();
		setQuotaCardViewMode("essential");
		setActiveQuotaCardTab("quota");
		renderRequested = false;

		let enabled = true;
		let period = "Hoy (24h)";
		let accordion = "collapsed";

		mockAdapter = {
			isEnabled: () => enabled,
			toggleEnabled: () => {
				enabled = !enabled;
				return enabled;
			},
			setEnabled: (val: boolean) => {
				enabled = val;
			},
			getPeriodLabel: () => period,
			togglePeriod: () => {
				period = period.includes("24h") ? "Semana (7d)" : "Hoy (24h)";
				return period;
			},
			getAccordionMode: () => accordion,
			toggleExpanded: () => {
				accordion = accordion === "collapsed" ? "pinned" : "collapsed";
				return accordion;
			},
			update: async () => {},
		};

		mockTui = {
			requestRender: () => {
				renderRequested = true;
			},
		};
	});

	it("1. registers module into COMMUNITY_REGISTRY_SLOT with professional metadata", () => {
		const cleanup = registerCpamcSentinelCustomizeModule(mockAdapter, mockTui);
		const bus = (globalThis as any)[COMMUNITY_REGISTRY_SLOT] as Map<string, WiloxCommunityModule>;
		assert.ok(bus, "Global bus must exist");

		const mod = bus.get("cpamc-sentinel");
		assert.ok(mod, "cpamc-sentinel module must be registered");
		assert.strictEqual(mod.id, "cpamc-sentinel");
		assert.strictEqual(mod.title, "CPAMC Sentinel · Cuota, Telemetría & Cuidado del Chat");
		assert.strictEqual(mod.order, 10);
		assert.match(mod.summary(), /Active · Panel Unificado/);

		cleanup();
		assert.strictEqual(bus.get("cpamc-sentinel"), undefined, "Cleanup must remove module");
	});

	it("2. enforces Visual Badges format [ON]/[OFF] without keyboard redundancy in labels", () => {
		registerCpamcSentinelCustomizeModule(mockAdapter, mockTui);
		const bus = (globalThis as any)[COMMUNITY_REGISTRY_SLOT];
		const mod = bus.get("cpamc-sentinel")!;
		const rows = mod.rows;

		rows.forEach((r: any) => {
			const label = r.label();
			assert.match(label, /\[.+\]$/, `Label "${label}" must end with bracketed badge [Value]`);
			assert.doesNotMatch(label, /press enter|enter to|click to/i, `Label "${label}" must not contain redundant keyboard instructions`);
		});
	});

	it("3. implements Progressive Disclosure: only returns Master Switch row when enabled is false", () => {
		mockAdapter.setEnabled(false);
		registerCpamcSentinelCustomizeModule(mockAdapter, mockTui);
		const bus = (globalThis as any)[COMMUNITY_REGISTRY_SLOT];
		const mod = bus.get("cpamc-sentinel")!;

		assert.strictEqual(mod.summary(), "Disabled");
		const rows = mod.rows;
		assert.strictEqual(rows.length, 1, "Disabled module must return exactly 1 row");
		assert.strictEqual(rows[0]!.id, "sentinel-master-status");
		assert.strictEqual(rows[0]!.label(), "Módulo Centinela: [OFF]");
	});

	it("4. in Panel Unificado mode (essential), hides multitab child rows", () => {
		setQuotaCardViewMode("essential");
		registerCpamcSentinelCustomizeModule(mockAdapter, mockTui);
		const bus = (globalThis as any)[COMMUNITY_REGISTRY_SLOT];
		const mod = bus.get("cpamc-sentinel")!;
		const rows = mod.rows;

		const ids = rows.map((r: any) => r.id);
		assert.ok(ids.includes("sentinel-master-status"));
		assert.ok(ids.includes("sentinel-architecture-mode"));
		assert.strictEqual(ids.includes("sentinel-active-tab"), false, "Multitab sub-option must be hidden in Panel Unificado");

		const archRow = rows.find((r: any) => r.id === "sentinel-architecture-mode")!;
		assert.strictEqual(archRow.label(), "Arquitectura Visual: [Panel Unificado]");
		assert.ok(archRow.preview().sample.includes("Relojes concéntricos 5H y Semanal"));
	});

	it("5. toggling Arquitectura Visual switches to Dashboard Multitab and exposes active tab selector", () => {
		registerCpamcSentinelCustomizeModule(mockAdapter, mockTui);
		const bus = (globalThis as any)[COMMUNITY_REGISTRY_SLOT];
		const mod = bus.get("cpamc-sentinel")!;

		// Activar Multitab
		const archRow = mod.rows.find((r: any) => r.id === "sentinel-architecture-mode")!;
		archRow.action();

		assert.strictEqual(getQuotaCardViewMode(), "tabs");
		assert.strictEqual(renderRequested, true);

		// Ahora las rows hijas deben incluir sentinel-active-tab
		const updatedRows = mod.rows;
		const tabRow = updatedRows.find((r: any) => r.id === "sentinel-active-tab");
		assert.ok(tabRow, "Dashboard Multitab must expose active tab row");
		assert.strictEqual(tabRow.label(), "Pestaña Activa: [1 CUOTA]");
		assert.ok(tabRow.preview().sample.includes("Diales Braille concéntricos"));

		// Ciclar pestaña activa
		renderRequested = false;
		tabRow.action();
		assert.strictEqual(getActiveQuotaCardTab(), "metrics");
		assert.strictEqual(renderRequested, true);
		assert.strictEqual(tabRow.label(), "Pestaña Activa: [2 MÉTRICAS]");
	});

	it("6. preserves honest defense and period cycle actions", () => {
		registerCpamcSentinelCustomizeModule(mockAdapter, mockTui);
		const bus = (globalThis as any)[COMMUNITY_REGISTRY_SLOT];
		const mod = bus.get("cpamc-sentinel")!;

		const periodRow = mod.rows.find((r: any) => r.id === "sentinel-period")!;
		assert.strictEqual(periodRow.label(), "Período Histórico: [Hoy (24h)]");

		periodRow.action();
		assert.strictEqual(periodRow.label(), "Período Histórico: [Semana (7d)]");

		const chatRow = mod.rows.find((r: any) => r.id === "sentinel-chat-guard")!;
		assert.strictEqual(chatRow.label(), "Cuidado del Chat: [Blindado]");
		assert.ok(chatRow.preview().sample.includes("Límite máximo de 15 acciones"));
	});
});
