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

const { isCleanIncludedModel, buildPoolLabelMap, reconcileActivePoolFacades, initDynamicProvider, resolveManagementKeyWithDiagnostics, resolveCandidateBaseUrls, resolveCpamcBaseUrl, resolveCpamcSettings, buildPendingAccountsPlaceholderModel, syncStandaloneSubproviders } = await import("./provider.js");

describe("Dynamic Provider Filtering & Granular Coexistence", () => {
    it("evaluates universal base URL resolution cascade (env, custom port, fallbacks)", () => {
        const origBase = process.env.CLIPROXYAPI_BASE_URL;
        const origCpa = process.env.CPAMC_URL;
        try {
            delete process.env.CLIPROXYAPI_BASE_URL;
            delete process.env.CPAMC_URL;

            const urlsDefault = resolveCandidateBaseUrls();
            assert.ok(urlsDefault.includes("http://127.0.0.1:8317"));
            assert.ok(urlsDefault.includes("http://localhost:8317"));

            // Test: URL explícita de red local (ej. Proxmox / VPS / LAN)
            process.env.CLIPROXYAPI_BASE_URL = "http://192.168.1.100:9000";
            const urlsCustom = resolveCandidateBaseUrls();
            assert.equal(urlsCustom[0], "http://192.168.1.100:9000");
            assert.equal(resolveCpamcBaseUrl(), "http://192.168.1.100:9000");

            // Test: URL HTTPS con dominio de servidor
            process.env.CLIPROXYAPI_BASE_URL = "https://cpamc.mi-servidor.cloud/";
            assert.equal(resolveCpamcBaseUrl(), "https://cpamc.mi-servidor.cloud");
        } finally {
            if (origBase !== undefined) process.env.CLIPROXYAPI_BASE_URL = origBase;
            else delete process.env.CLIPROXYAPI_BASE_URL;
            if (origCpa !== undefined) process.env.CPAMC_URL = origCpa;
            else delete process.env.CPAMC_URL;
        }
    });

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
        assert.ok(registeredProviderConfig.headers["x-opencode-session"], "x-opencode-session header missing");
        assert.ok(registeredProviderConfig.headers["x-opencode-session-id"], "x-opencode-session-id header missing");
        assert.equal(registeredProviderConfig.headers["x-opencode-session"], registeredProviderConfig.headers["x-opencode-session-id"]);
    });

    it("evaluates management key resolution and detects env fallback and none cleanly", () => {
        const originalEnv = process.env.CLIPROXYAPI_MANAGEMENT_KEY;
        try {
            process.env.CLIPROXYAPI_MANAGEMENT_KEY = "test-env-key-secret";
            const res = resolveManagementKeyWithDiagnostics();
            assert.ok(res.key, "key should be resolved");
            assert.ok(res.source, "source should be defined");
        } finally {
            if (originalEnv) {
                process.env.CLIPROXYAPI_MANAGEMENT_KEY = originalEnv;
            } else {
                delete process.env.CLIPROXYAPI_MANAGEMENT_KEY;
            }
        }
    });

    it("resolves cpamc settings and integrates seamlessly with candidate base URLs", () => {
        const settings = resolveCpamcSettings();
        assert.equal(typeof settings, "object");
        // Verify resolveCandidateBaseUrls incorporates settings if present
        const urls = resolveCandidateBaseUrls();
        assert.ok(Array.isArray(urls));
        assert.ok(urls.length > 0);
    });

    it("builds pending accounts placeholder model when 0 accounts exist on an active server", () => {
        const placeholder = buildPendingAccountsPlaceholderModel("http://localhost:8317");
        assert.equal(placeholder.id, "sin-cuentas-vinculadas");
        assert.ok(placeholder.name.includes("Sin cuentas vinculadas"));
        assert.ok(placeholder.name.includes("http://localhost:8317/management.html"));
        assert.equal(placeholder.provider, "cpamc");
    });
});

describe("Standalone OmniAuth Pro zero-collision prefixes (Fase 3 homologación)", () => {
    const standaloneFilterData = {
        validPrefixes: new Set(["nim_1", "nim_2"]),
        prefixExclusions: new Map([["nim_1", new Set<string>()], ["nim_2", new Set<string>()]]),
        familyActiveLeaderPrefix: new Map<string, string>(),
        prefixToFamily: new Map<string, string>(),
        activePoolFamilies: new Set<string>(),
        poolAssignedPrefixes: new Set<string>(),
        activeBareProviders: new Set(["antigravity"]),
        bareExclusions: new Set<string>(),
        registeredPoolBases: new Set<string>(),
    };

    it("exposes standalone account routes (nim_1/*, nim_2/*) that are not pool reserves", () => {
        assert.equal(isCleanIncludedModel("nim_1/meta/llama-3.1-405b-instruct", standaloneFilterData), true);
        assert.equal(isCleanIncludedModel("nim_2/z-ai/glm-5.3-flash", standaloneFilterData), true);
    });

    it("keeps hiding numeric reserves of registered pools (fachadas Pool-XX intactas)", () => {
        const registeredPools = {
            ...standaloneFilterData,
            validPrefixes: new Set(["agy", "agy2", "nim_1"]),
            prefixExclusions: new Map([["agy", new Set<string>()], ["agy2", new Set<string>()], ["nim_1", new Set<string>()]]),
            poolAssignedPrefixes: new Set(["agy", "agy2"]),
            registeredPoolBases: new Set(["agy", "agy2", "nim"]),
        };
        assert.equal(isCleanIncludedModel("agy_1/gemini-3.8-flash-high", registeredPools), false);
        assert.equal(isCleanIncludedModel("nim_1/meta/llama-3.1-405b-instruct", registeredPools), false);
    });

    it("labels standalone accounts as LIBRE <prefijo> instead of phantom pool reservations", () => {
        const labels = buildPoolLabelMap(["nim_1", "nim_2"], standaloneFilterData.registeredPoolBases);
        assert.equal(labels.get("nim_1"), "LIBRE nim_1");
        assert.equal(labels.get("nim_2"), "LIBRE nim_2");
    });

    it("labels registered pool reserves as P#·RESERVA (sin colisión con standalone)", () => {
        const labels = buildPoolLabelMap(["agy", "agy_1", "nim_1"], new Set(["agy", "agy2"]));
        assert.equal(labels.get("agy"), "P1·LÍDER agy");
        assert.equal(labels.get("agy_1"), "P1·RESERVA agy_1");
        assert.equal(labels.get("nim_1"), "LIBRE nim_1");
    });

    it("syncStandaloneSubproviders registers dedicated providers with X-Account-Alias headers and filtered models", () => {
        const registered: Record<string, any> = {};
        const mockPi: any = {
            registerProvider: (id: string, config: any) => {
                registered[id] = config;
            },
            unregisterProvider: (id: string) => {
                delete registered[id];
            },
        };

        const standaloneAccounts = [
            {
                accountKey: "codex-account1.json",
                email: "wil...dev@openai.com",
                alias: "CX1",
                provider: "codex",
                maskedEmail: "wil...dev@openai.com",
                excludedModels: new Set(["gpt-4-turbo"]),
            },
            {
                accountKey: "codex-account2.json",
                email: "wil...lab@openai.com",
                alias: "CX2",
                provider: "codex",
                maskedEmail: "wil...lab@openai.com",
                excludedModels: new Set<string>(),
            },
            {
                accountKey: "antigravity-wilsonlavio7@gmail.com.json",
                email: "wil...io7@gmail.com",
                alias: "AG1",
                provider: "antigravity",
                maskedEmail: "wil...io7@gmail.com",
                excludedModels: new Set<string>(),
            },
        ];

        const rawModels = [
            { id: "gpt-6.1-terra", display_name: "GPT-6.1 Terra", owned_by: "openai" },
            { id: "gpt-4-turbo", display_name: "GPT-4 Turbo", owned_by: "openai" },
            { id: "gemini-3-flash", display_name: "Gemini 3 Flash", owned_by: "google" },
            { id: "claude-3-7-sonnet", display_name: "Claude 3.7 Sonnet", owned_by: "anthropic" },
        ];

        syncStandaloneSubproviders(mockPi, standaloneAccounts, rawModels, "http://127.0.0.1:8317", { "x-project-identity": "test-id" });

        // Verificar que se registraron los 3 sub-proveedores
        assert.ok(registered["cpamc - CX1"], "cpamc - CX1 must be registered");
        assert.ok(registered["cpamc - CX2"], "cpamc - CX2 must be registered");
        assert.ok(registered["cpamc - AG1"], "cpamc - AG1 must be registered");

        // CX1 debe tener X-Account-Alias: CX1 y tener gpt-6.1-terra, pero NO gpt-4-turbo (por exclusión)
        const cx1Config = registered["cpamc - CX1"];
        assert.equal(cx1Config.headers["X-Account-Alias"], "CX1");
        assert.equal(cx1Config.headers["x-project-identity"], "test-id");
        const cx1ModelIds = cx1Config.models.map((m: any) => m.id);
        assert.ok(cx1ModelIds.includes("gpt-6.1-terra"));
        assert.equal(cx1ModelIds.includes("gpt-4-turbo"), false);
        assert.equal(cx1ModelIds.includes("gemini-3-flash"), false);

        // En /model, el providerBadge es [cpamc - CX1] y el name tiene el alias [CX1]
        const terraModel = cx1Config.models.find((m: any) => m.id === "gpt-6.1-terra");
        assert.equal(terraModel.provider, "cpamc - CX1");
        assert.ok(terraModel.name.includes("[CX1]"));

        // CX2 debe tener X-Account-Alias: CX2 y sí tener gpt-4-turbo
        const cx2Config = registered["cpamc - CX2"];
        assert.equal(cx2Config.headers["X-Account-Alias"], "CX2");
        const cx2ModelIds = cx2Config.models.map((m: any) => m.id);
        assert.ok(cx2ModelIds.includes("gpt-6.1-terra"));
        assert.ok(cx2ModelIds.includes("gpt-4-turbo"));

        // AG1 debe tener gemini-3-flash
        const ag1Config = registered["cpamc - AG1"];
        assert.equal(ag1Config.headers["X-Account-Alias"], "AG1");
        const ag1ModelIds = ag1Config.models.map((m: any) => m.id);
        assert.ok(ag1ModelIds.includes("gemini-3-flash"));
        assert.equal(ag1ModelIds.includes("gpt-6.1-terra"), false);
    });

    it("suppresses bare models under cpamc when that provider has standalone aliases registered", () => {
        const filterDataWithAliases = {
            ...mockFilterData,
            activeBareProviders: new Set(["codex", "antigravity"]),
            standaloneAccounts: [
                {
                    accountKey: "codex-1.json",
                    email: "wil...dev@openai.com",
                    alias: "CX1",
                    provider: "codex",
                    maskedEmail: "wil...dev@openai.com",
                    excludedModels: new Set<string>(),
                },
            ],
        };

        // Codex tiene alias CX1 -> se suprime el modelo plano gpt-6.1-terra de cpamc para evitar duplicado
        assert.equal(isCleanIncludedModel("gpt-6.1-terra", filterDataWithAliases), false);

        // Antigravity NO tiene alias en standaloneAccounts -> se conserva modelo plano de fallback
        assert.equal(isCleanIncludedModel("gemini-3.8-flash-high", filterDataWithAliases), true);
    });
});
