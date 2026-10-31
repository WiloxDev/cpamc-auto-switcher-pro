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
} = await import("./wilox-layout-manager.js");
type SidebarOrderPreset = any;

describe("Sidebar & Layout Manager (Universal Sidebar Dispatcher)", () => {
	beforeEach(() => {
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
			},
		});

		const current = readWiloxSettings();
		assert.strictEqual(current.sidebar.width, 50);
		assert.strictEqual(current.sidebar.orderPreset, "sentinel-top");
		assert.strictEqual(current.sidebar.visibility.jobs, false);
		assert.strictEqual(current.sidebar.visibility.sentinel, true);
	});
});
