import { describe, it } from "node:test";
import assert from "node:assert/strict";
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

const { isCleanIncludedModel, buildPoolLabelMap, reconcileActivePoolFacades, initDynamicProvider } = await import("./provider.js");

describe("Dynamic Provider Filtering & Granular Coexistence", () => {
    const mockFilterData = {
        validPrefixes: new Set(["agy", "agy2"]),
        prefixExclusions: new Map([["agy", new Set<string>()], ["agy2", new Set<string>()]]),
        familyActiveLeaderPrefix: new Map([["gemini_pure", "agy"]]),
        prefixToFamily: new Map([["agy", "gemini_pure"], ["agy2", "gemini_pure"]]),
        activePoolFamilies: new Set(["gemini_pure"]),
        poolAssignedPrefixes: new Set(["agy", "agy2"]),
        activeBareProviders: new Set(["antigravity"]),
        bareExclusions: new Set<string>(),
        registeredPoolBases: new Set(["agy", "agy2"]),
    };

    it("includes canonical pool clean facades (Pool-01-gemini, Pool-02-gemini)", () => {
        assert.equal(isCleanIncludedModel("Pool-01-gemini", mockFilterData), true);
        assert.equal(isCleanIncludedModel("Pool-02-gemini", mockFilterData), true);
    });

    it("masks physical accounts assigned to active pools", () => {
        assert.equal(isCleanIncludedModel("agy/gemini-3.8-flash-high", mockFilterData), false);
        assert.equal(isCleanIncludedModel("agy2/gemini-3.8-flash-high", mockFilterData), false);
    });

    it("masks reserve accounts (_1, _2...) on disk", () => {
        assert.equal(isCleanIncludedModel("agy_1/gemini-3.8-flash-high", mockFilterData), false);
        assert.equal(isCleanIncludedModel("agy2_1/gemini-3.8-flash-high", mockFilterData), false);
    });

    it("includes bare native models when an active unassigned bare provider exists", () => {
        assert.equal(isCleanIncludedModel("gemini-3.8-flash-high", mockFilterData), true);
        assert.equal(isCleanIncludedModel("gemini-3.7-flash-high", mockFilterData), true);
    });

    it("blocks third-party phantom models from omni-auth-pro", () => {
        assert.equal(isCleanIncludedModel("gpt-6-luna", mockFilterData), false);
        assert.equal(isCleanIncludedModel("deepseek-flash", mockFilterData), false);
        assert.equal(isCleanIncludedModel("deepseek-v4-flash", mockFilterData), false);
        assert.equal(isCleanIncludedModel("qwen3.8-flash", mockFilterData), false);
        assert.equal(isCleanIncludedModel("minimax-m3", mockFilterData), false);
    });

    it("blocks bare models when no active unassigned bare provider exists", () => {
        const noBareFilterData = {
            ...mockFilterData,
            activeBareProviders: new Set<string>(),
        };
        assert.equal(isCleanIncludedModel("gemini-3.8-flash-high", noBareFilterData), false);
    });

    it("respects exclusions defined in free accounts on disk", () => {
        const excludedFilterData = {
            ...mockFilterData,
            bareExclusions: new Set(["gemini-3-flash"]),
        };
        assert.equal(isCleanIncludedModel("gemini-3.8-flash-high", excludedFilterData), true);
        assert.equal(isCleanIncludedModel("gemini-3-flash", excludedFilterData), false);
    });

    it("labels registered pool prefixes with P1, P2 and unassigned with LIBRE", () => {
        const labels = buildPoolLabelMap(["agy", "agy_1", "agy3"], new Set(["agy"]));
        assert.equal(labels.get("agy"), "P1·LÍDER agy");
        assert.equal(labels.get("agy_1"), "P1·RESERVA agy_1");
        assert.equal(labels.get("agy3"), "LIBRE agy3");
    });

    it("verifies N=0 total dissolution fallback (all pools dissolved, native accounts exposed without outage)", () => {
        const zeroPoolsFilterData = {
            validPrefixes: new Set<string>(),
            prefixExclusions: new Map(),
            familyActiveLeaderPrefix: new Map(),
            prefixToFamily: new Map(),
            activePoolFamilies: new Set<string>(),
            poolAssignedPrefixes: new Set<string>(),
            activeBareProviders: new Set(["antigravity"]),
            bareExclusions: new Set<string>(),
            registeredPoolBases: new Set<string>(),
        };

        // No pools exist
        assert.equal(isCleanIncludedModel("Pool-01-gemini", zeroPoolsFilterData), true); // regex passes, but in N=0 CPAMC won't return it
        // Native bare models MUST pass smoothly
        assert.equal(isCleanIncludedModel("gemini-3.8-flash-high", zeroPoolsFilterData), true);
        assert.equal(isCleanIncludedModel("gemini-3-flash", zeroPoolsFilterData), true);
        assert.equal(isCleanIncludedModel("gemini-pro-agent", zeroPoolsFilterData), true);
        // Phantom models MUST STILL be blocked
        assert.equal(isCleanIncludedModel("gpt-6-luna", zeroPoolsFilterData), false);
        assert.equal(isCleanIncludedModel("deepseek-flash", zeroPoolsFilterData), false);
    });

    it("verifies account adoption (when free account is adopted into pool, its bare models disappear)", () => {
        // Post-adopción: Todas las cuentas pertenecen a pools, 0 cuentas libres sin prefijo
        const allAdoptedFilterData = {
            ...mockFilterData,
            activeBareProviders: new Set<string>(), // 0 bare free accounts
            bareExclusions: new Set<string>(),
        };

        // Las fachadas de pool se mantienen
        assert.equal(isCleanIncludedModel("Pool-01-gemini", allAdoptedFilterData), true);
        assert.equal(isCleanIncludedModel("Pool-02-gemini", allAdoptedFilterData), true);
        // Las cuentas físicas y reservas están enmascaradas
        assert.equal(isCleanIncludedModel("agy/gemini-3.8-flash-high", allAdoptedFilterData), false);
        assert.equal(isCleanIncludedModel("agy_1/gemini-3.8-flash-high", allAdoptedFilterData), false);
        assert.equal(isCleanIncludedModel("agy_2/gemini-3.8-flash-high", allAdoptedFilterData), false);
        // Los modelos planos desaparecen de /model porque no hay cuentas libres
        assert.equal(isCleanIncludedModel("gemini-3.8-flash-high", allAdoptedFilterData), false);
    });

    it("reconciles missing pool facades when CPAMC host has not restarted", () => {
        const rawServerModels = [
            { id: "gemini-3.8-flash-high" },
        ];
        const confirmedPools = new Set(["Pool-01-gemini", "Pool-02-gemini"]);
        const reconciled = reconcileActivePoolFacades(rawServerModels, confirmedPools);

        const ids = reconciled.map((m) => m.id);
        assert.ok(ids.includes("Pool-01-gemini"));
        assert.ok(ids.includes("Pool-02-gemini"));
        assert.ok(ids.includes("gemini-3.8-flash-high"));
        assert.equal(reconciled.length, 3);
    });

    it("verifies registration injects x-project-identity and x-workspace-root headers", () => {
        let registeredProviderConfig: any = null;
        const mockPi: any = {
            registerProvider: (_id: string, config: any) => {
                registeredProviderConfig = config;
            },
        };

        initDynamicProvider(mockPi);

        assert.ok(registeredProviderConfig, "provider must be registered");
        assert.ok(registeredProviderConfig.headers, "provider must include headers");
        assert.ok(registeredProviderConfig.headers["x-project-identity"], "x-project-identity header missing");
        assert.equal(registeredProviderConfig.headers["x-workspace-root"], process.cwd());
        assert.equal(typeof registeredProviderConfig.headers["x-project-identity"], "string");
        assert.equal(registeredProviderConfig.headers["x-project-identity"].length, 16);
    });
});
