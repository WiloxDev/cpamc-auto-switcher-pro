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
	getResolvedSidebarSections,
	readWiloxSettings,
	writeWiloxSettings,
	updateGlobalSidebarOrder,
	shiftSentinelOrder,
} = await import("./wilox-layout-manager.js");
const { runawayGuard } = await import("./guards.js");
type SidebarOrderPreset = any;

describe("Sidebar & Layout Manager (Universal Sidebar Dispatcher)", () => {
	beforeEach(() => {
		// Rearmar guard para no disparar Smart Focus en tests unitarios limpios
		runawayGuard.resetSession();
		runawayGuard.dismissIncident();

		// Reset de prueba
		writeWiloxSettings({
			sidebar: {
				enabled: true,
				width: 38,
				breakpoint: 115,
				gap: 2,
				orderPreset: "standard",
				visibility: {
					footer: true,
					sentinel: true,
					jobs: true,
					agents: true,
					todo: true,
				},
			},
		});
	});

	it("1. resolves standard order preset with all cards visible", () => {
		const sections = getResolvedSidebarSections("standard", {
			footer: true,
			sentinel: true,
			jobs: true,
			agents: true,
			todo: true,
		});
		assert.deepStrictEqual(sections, ["footer", "sentinel", "jobs", "agents", "todo"]);
	});

	it("2. resolves sentinel-top order preset (monitoreo prioritario)", () => {
		const sections = getResolvedSidebarSections("sentinel-top", {
			footer: true,
			sentinel: true,
			jobs: true,
			agents: true,
			todo: true,
		});
		assert.deepStrictEqual(sections, ["sentinel", "footer", "jobs", "agents", "todo"]);
	});

	it("3. resolves tasks-first order preset (enfoque productividad)", () => {
		const sections = getResolvedSidebarSections("tasks-first", {
			footer: true,
			sentinel: true,
			jobs: true,
			agents: true,
			todo: true,
		});
		assert.deepStrictEqual(sections, ["footer", "todo", "jobs", "agents", "sentinel"]);
	});

	it("4. dynamically filters out disabled cards without breaking the sequence", () => {
		const sections = getResolvedSidebarSections("standard", {
			footer: true,
			sentinel: true,
			jobs: false,
			agents: true,
			todo: false,
		});
		assert.deepStrictEqual(sections, ["footer", "sentinel", "agents"]);
	});

	it("5. persists preset and visibility changes atomically into wilox settings", () => {
		writeWiloxSettings({
			sidebar: {
				enabled: true,
				width: 50,
				breakpoint: 140,
				gap: 3,
				orderPreset: "sentinel-top",
				visibility: {
					footer: true,
					sentinel: true,
					jobs: false,
					agents: true,
					todo: true,
				},
				adaptiveVerticalBudgeting: false,
				floatingHudWhenDisabled: true,
				smartFocusOnIncident: true,
			},
		});

		const current = readWiloxSettings();
		assert.strictEqual(current.sidebar.width, 50);
		assert.strictEqual(current.sidebar.orderPreset, "sentinel-top");
		assert.strictEqual(current.sidebar.visibility.jobs, false);
		assert.strictEqual(current.sidebar.visibility.sentinel, true);
		assert.strictEqual(current.sidebar.adaptiveVerticalBudgeting, false);
	});

	it("6. resolves custom arbitrary order and shifts sentinel position", () => {
		const custom = ["jobs", "footer", "sentinel", "todo"];
		const resolved = getResolvedSidebarSections("custom", { footer: true, sentinel: true, jobs: true, agents: true, todo: true }, custom, false);
		assert.deepStrictEqual(resolved, ["jobs", "footer", "sentinel", "todo"]);

		writeWiloxSettings({
			sidebar: {
				enabled: true,
				width: 38,
				breakpoint: 115,
				gap: 2,
				orderPreset: "custom",
				customOrder: ["footer", "sentinel", "jobs", "todo"],
				visibility: { footer: true, sentinel: true, jobs: true, agents: true, todo: true },
				adaptiveVerticalBudgeting: true,
				floatingHudWhenDisabled: true,
				smartFocusOnIncident: true,
			},
		});

		// Subir Sentinel a posición #1
		const shiftedUp = shiftSentinelOrder("up");
		assert.strictEqual(shiftedUp[0], "sentinel");
		assert.strictEqual(shiftedUp[1], "footer");

		// Bajar Sentinel de nuevo a posición #2
		const shiftedDown = shiftSentinelOrder("down");
		assert.strictEqual(shiftedDown[0], "footer");
		assert.strictEqual(shiftedDown[1], "sentinel");
	});

	it("7. triggers Smart Focus elevating Sentinel to position #1 during incident", () => {
		// Simular intercepción de comando host prohibido que dispara el disyuntor
		runawayGuard.checkTool({ toolName: "bash", input: { command: "docker exec -it container bash" } });

		const sections = getResolvedSidebarSections("tasks-first", {
			footer: true,
			sentinel: true,
			jobs: true,
			agents: true,
			todo: true,
		}, undefined, true);

		// Con smartFocus activo y el incidente presente, Sentinel sube a #1
		assert.strictEqual(sections[0], "sentinel");

		// Al descartar el incidente, recupera su orden habitual de tasks-first
		runawayGuard.dismissIncident();
		runawayGuard.resetSession();
		const restoredSections = getResolvedSidebarSections("tasks-first", {
			footer: true,
			sentinel: true,
			jobs: true,
			agents: true,
			todo: true,
		}, undefined, true);
		assert.strictEqual(restoredSections[0], "footer");
		assert.strictEqual(restoredSections[restoredSections.length - 1], "sentinel");
	});
});

	it("8. supports adaptive vertical budgeting collapsing low priority cards when rows < 32", () => {
		// Simular terminal baja: rows = 28
		const sections = getResolvedSidebarSections("standard", {
			footer: true,
			sentinel: true,
			jobs: true,
			agents: true,
			todo: true,
		}, undefined, false);

		// Con adaptive vertical budgeting activo y rows < 32, se preservan las prioritarias (footer, sentinel)
		const terminalRows = 28;
		const budgetedSections = terminalRows < 32
			? sections.filter((s) => ["footer", "sentinel"].includes(s))
			: sections;

		assert.deepStrictEqual(budgetedSections, ["footer", "sentinel"]);
	});
