import { readFileSync, writeFileSync, existsSync, mkdirSync, watch, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type CPAModel = {
    slug?: string;
    id?: string;
    display_name?: string;
    owned_by?: string;
    context_window?: number;
    max_tokens?: number;
    input_modalities?: string[];
    default_reasoning_level?: string | null;
    supported_reasoning_levels?: Array<{ effort: string; description?: string }>;
};

type FallbackOpenAIModel = {
    id?: unknown;
    owned_by?: unknown;
    context_length?: unknown;
    max_input_tokens?: unknown;
    max_output_tokens?: unknown;
    capabilities?: {
        reasoning?: unknown;
        thinking?: unknown;
        vision?: unknown;
        image?: unknown;
        images?: unknown;
    };
};

const PROVIDER_ID = "cpamc";
const DEFAULT_BASE_URL = "http://localhost:8317";
const DEFAULT_MAX_TOKENS = 16_384;
const MAX_SAFE_OUTPUT_TOKENS = 65_536;

/**
 * Resuelve las rutas de caché de forma dinámica y universal:
 * - PI_CODING_AGENT_DIR si está definido
 * - ~/.gentle-shell/agent (Gentle Shell)
 * - Escaneo dinámico de carpetas de agentes en ~/.pi/ sin rutas fijas
 */
function resolveCacheTargets(): string[] {
    const targets = new Set<string>();
    if (process.env.PI_CODING_AGENT_DIR) {
        targets.add(join(process.env.PI_CODING_AGENT_DIR, "cpamc-models-cache.json"));
    }
    const home = homedir();
    const gentleAgentDir = join(home, ".gentle-shell", "agent");
    if (existsSync(gentleAgentDir)) {
        targets.add(join(gentleAgentDir, "cpamc-models-cache.json"));
    }
    const piDir = join(home, ".pi");
    if (existsSync(piDir)) {
        const standardAgent = join(piDir, "agent");
        targets.add(join(standardAgent, "cpamc-models-cache.json"));
        try {
            const entries = readdirSync(piDir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isDirectory() && entry.name.startsWith("agent")) {
                    targets.add(join(piDir, entry.name, "cpamc-models-cache.json"));
                }
            }
        } catch {}
    }
    return Array.from(targets);
}

/**
 * Resuelve las rutas de los archivos de señalización atómica emitidos por Auto Switcher Pro:
 * - auto-switcher-pro.epoch
 * - auto-switcher-pro-state.json
 */
function resolveSignalFileTargets(): string[] {
    const targets = new Set<string>();
    // Prioridad 1: Memoria compartida volátil (/dev/shm) para latencia cero (<5ms)
    if (existsSync("/dev/shm")) {
        targets.add("/dev/shm/auto-switcher-pro.epoch");
    }
    if (process.env.AUTO_SWITCHER_STATE_PATH) {
        targets.add(process.env.AUTO_SWITCHER_STATE_PATH);
    }
    const home = homedir();
    const servicePluginsDir = join(home, "services", "cliproxy", "plugins");
    if (existsSync(servicePluginsDir)) {
        targets.add(join(servicePluginsDir, "auto-switcher-pro.epoch"));
        targets.add(join(servicePluginsDir, "auto-switcher-pro-state.json"));
    }
    return Array.from(targets);
}

export function invalidateMemoryCaches(): void {
    cachedFilterData = null;
}

const PRIMARY_CACHE_PATH = process.env.PI_CODING_AGENT_DIR
    ? join(process.env.PI_CODING_AGENT_DIR, "cpamc-models-cache.json")
    : join(homedir(), ".pi", "agent", "cpamc-models-cache.json");

function loadCachedModels(): ReturnType<typeof toPiModelFromCPA>[] {
    const candidates = resolveCacheTargets();
    for (const p of candidates) {
        try {
            if (existsSync(p)) {
                const raw = readFileSync(p, "utf-8");
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed) && parsed.length > 0) {
                    return parsed;
                }
            }
        } catch {}
    }
    return [];
}

function saveCachedModels(models: unknown[]): void {
    if (!Array.isArray(models) || models.length === 0) return;
    const candidates = resolveCacheTargets();

    for (const target of candidates) {
        try {
            const dir = dirname(target);
            if (!existsSync(dir)) {
                // Solo crear si el padre principal existe (~/.pi o ~/.gentle-shell)
                const grandParent = dirname(dir);
                if (existsSync(grandParent)) {
                    mkdirSync(dir, { recursive: true });
                }
            }
            if (existsSync(dir)) {
                writeFileSync(target, JSON.stringify(models, null, 2), "utf-8");
            }
        } catch {
            // Silencioso ante errores de I/O
        }
    }
}

export interface StandaloneAccountDescriptor {
    accountKey: string;
    email: string;
    alias: string;
    provider: string;
    maskedEmail: string;
    excludedModels: Set<string>;
}

// Caché en memoria para retener los prefijos válidos y modelos excluidos
let cachedFilterData: {
    validPrefixes: Set<string>;
    prefixExclusions: Map<string, Set<string>>;
    familyActiveLeaderPrefix: Map<string, string>; // family -> primary active leader base_prefix
    prefixToFamily: Map<string, string>; // base_prefix -> family
    activePoolFamilies: Set<string>;
    poolAssignedPrefixes: Set<string>;
    activeBareProviders: Set<string>;
    bareExclusions: Set<string>;
    registeredPoolBases: Set<string>;
    confirmedActivePools: Set<string>;
    standaloneAccounts?: StandaloneAccountDescriptor[];
} | null = null;
let lastKnownEpoch: string | null = null;

let activePiInstance: ExtensionAPI | null = null;
const registeredSubproviders = new Set<string>();

function readCurrentSignalEpoch(): string | null {
    const epochTargets = [
        "/dev/shm/auto-switcher-pro.epoch",
        join(homedir(), "services", "cliproxy", "plugins", "auto-switcher-pro.epoch"),
    ];
    for (const target of epochTargets) {
        try {
            if (existsSync(target)) {
                const val = readFileSync(target, "utf-8").trim();
                if (val) return val;
            }
        } catch {}
    }
    return null;
}

function buildStrictThinkingLevelMap(levels: string[]): Record<string, string | null> {
    if (!levels || levels.length === 0) {
        return {
            off: null,
            minimal: null,
            low: "low",
            medium: "medium",
            high: "high",
            xhigh: null,
            max: null,
        };
    }

    const set = new Set(levels.map((lvl) => lvl.toLowerCase()));

    return {
        off: null,
        minimal: set.has("minimal") ? "minimal" : null,
        low: set.has("low") ? "low" : null,
        medium: set.has("medium") ? "medium" : null,
        high: set.has("high") ? "high" : null,
        xhigh: set.has("xhigh") ? "xhigh" : null,
        max: set.has("max") ? "max" : null,
    };
}

function resolveRecommendedContextWindow(modelId: string, reportedContext?: number): number {
    const id = modelId.toLowerCase();
    let recommendedCap = 128_000;

    if (id.includes("gpt") || id.includes("codex") || id.includes("openai")) {
        recommendedCap = 272_000;
    } else if (id.includes("claude")) {
        recommendedCap = 200_000;
    } else if (id.includes("gemini")) {
        recommendedCap = 370_000;
    }

    if (typeof reportedContext === "number" && Number.isFinite(reportedContext) && reportedContext > 0) {
        return Math.min(Math.floor(reportedContext), recommendedCap);
    }
    return recommendedCap;
}

function resolveBaseUrl(): string {
    const candidateUrls = resolveCandidateBaseUrls();
    return candidateUrls[0] || DEFAULT_BASE_URL;
}

/**
 * Intenta leer el host y puerto de CPAMC desde archivos de configuración locales
 * (útil si el usuario configuró un puerto personalizado como 8080, 8000, 9000, etc.)
 */
function discoverCpamcFromLocalConfig(): string | null {
    const home = homedir();
    const localAppData = process.env.LOCALAPPDATA || join(home, "AppData", "Local");
    const appData = process.env.APPDATA || join(home, "AppData", "Roaming");

    const candidateConfigs = [
        join(home, ".cli-proxy-api", "config.yaml"),
        join(home, "Library", "Application Support", "cli-proxy-api", "config.yaml"),
        join(localAppData, "cli-proxy-api", "config.yaml"),
        join(appData, "cli-proxy-api", "config.yaml"),
        join(home, "services", "cliproxy", "config.yaml"),
        "/CLIProxyAPI/config.yaml",
        join(home, ".local", "share", "EasyCLIProxyAPI", "cpa-core", "config.yaml"),
    ];

    for (const confPath of candidateConfigs) {
        try {
            if (existsSync(confPath)) {
                const text = readFileSync(confPath, "utf-8");
                // Buscar server.port o port: \d+
                const portMatch = text.match(/^\s*port:\s*(\d+)/m);
                const hostMatch = text.match(/^\s*host:\s*['"]?([^'"\s]+)['"]?/m);
                const tlsMatch = text.match(/^\s*enable:\s*(true|false)/m);

                if (portMatch) {
                    const port = portMatch[1];
                    let host = hostMatch && hostMatch[1] ? hostMatch[1].trim() : "127.0.0.1";
                    if (host === "" || host === "0.0.0.0") {
                        host = "127.0.0.1";
                    }
                    const scheme = tlsMatch && tlsMatch[1] === "true" ? "https" : "http";
                    return `${scheme}://${host}:${port}`;
                }
            }
        } catch {}
    }
    return null;
}

/**
 * Lee archivo de enlace persistente .cliproxy_url si existe
 * (permite al instalador o al usuario vincular un VPS/Proxmox/LAN con 1 sola línea)
 */
function discoverCpamcFromUrlFile(): string | null {
    const home = homedir();
    const candidates = [
        join(home, ".cliproxy_url"),
        join(home, ".cpamc_url"),
        join(home, ".gentle-shell", "agent", ".cliproxy_url"),
        join(home, ".gentle-shell", "agent", "cpamc.url"),
        join(home, ".pi", "agent", ".cliproxy_url"),
        join(home, ".pi", "agent", "cpamc.url"),
    ];
    if (process.env.PI_CODING_AGENT_DIR) {
        candidates.push(
            join(process.env.PI_CODING_AGENT_DIR, ".cliproxy_url"),
            join(process.env.PI_CODING_AGENT_DIR, "cpamc.url")
        );
    }

    for (const p of candidates) {
        try {
            if (existsSync(p)) {
                const content = readFileSync(p, "utf-8").trim();
                if (content && (content.startsWith("http://") || content.startsWith("https://"))) {
                    return content.replace(/\/+$/, "").replace(/\/v1$/, "");
                }
            }
        } catch {}
    }
    return null;
}

export type CpamcSettings = {
    baseUrl?: string;
    apiKey?: string;
    managementKey?: string;
};

/**
 * Resuelve la configuración de CPAMC declarada en settings.json del agente activo
 * (Gentle-Shell, Pi, Wilox-Pi). Proporciona inmunidad ante terminales que no heredaron
 * las variables de entorno del sistema operativo en caliente.
 */
export function resolveCpamcSettings(): CpamcSettings {
    const home = homedir();
    const candidates = new Set<string>();

    if (process.env.PI_CODING_AGENT_DIR) {
        candidates.add(join(process.env.PI_CODING_AGENT_DIR, "settings.json"));
    }
    candidates.add(join(home, ".gentle-shell", "agent", "settings.json"));
    candidates.add(join(home, ".pi", "agent", "settings.json"));
    candidates.add(join(home, ".pi", "agent-wilox", "settings.json"));

    const piDir = join(home, ".pi");
    if (existsSync(piDir)) {
        try {
            const entries = readdirSync(piDir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isDirectory() && entry.name.startsWith("agent")) {
                    candidates.add(join(piDir, entry.name, "settings.json"));
                }
            }
        } catch {}
    }

    for (const settingsPath of candidates) {
        try {
            if (existsSync(settingsPath)) {
                const raw = readFileSync(settingsPath, "utf-8");
                const parsed = JSON.parse(raw);
                if (parsed && typeof parsed === "object") {
                    const cpamc = (parsed as Record<string, unknown>).cpamc;
                    if (cpamc && typeof cpamc === "object") {
                        const rec = cpamc as Record<string, unknown>;
                        const baseUrl = typeof rec.baseUrl === "string" ? rec.baseUrl.trim() : undefined;
                        const apiKey = typeof rec.apiKey === "string" ? rec.apiKey.trim() : undefined;
                        const managementKey = typeof rec.managementKey === "string" ? rec.managementKey.trim() : undefined;
                        if (baseUrl || apiKey || managementKey) {
                            return { baseUrl, apiKey, managementKey };
                        }
                    }
                }
            }
        } catch {}
    }

    return {};
}

/**
 * Cascada universal de URLs base para CPAMC:
 * 1. Variable de entorno explícita (CLIPROXYAPI_BASE_URL / CPAMC_URL)
 * 2. Configuración en settings.json del agente (cpamc.baseUrl)
 * 3. Archivo de enlace persistente (.cliproxy_url / .cpamc_url)
 * 4. Descubrimiento de puerto personalizado en config.yaml local
 * 5. Loopback IPv4 estándar (http://127.0.0.1:8317)
 * 6. Loopback hostname (http://localhost:8317)
 * 7. Entornos de contenedor Docker / WSL (http://host.docker.internal:8317)
 * 8. Puertos alternativos comunes (8080, 8000, 9000)
 */
export function resolveCandidateBaseUrls(): string[] {
    const urls = new Set<string>();
    const explicit = (process.env.CLIPROXYAPI_BASE_URL || process.env.CPAMC_URL || "").trim().replace(/\/+$/, "").replace(/\/v1$/, "");
    if (explicit) {
        urls.add(explicit);
    }

    const settings = resolveCpamcSettings();
    if (settings.baseUrl) {
        urls.add(settings.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, ""));
    }

    const fileUrl = discoverCpamcFromUrlFile();
    if (fileUrl) {
        urls.add(fileUrl);
    }

    const configUrl = discoverCpamcFromLocalConfig();
    if (configUrl) {
        urls.add(configUrl);
    }

    // Candidatos estándar
    urls.add("http://127.0.0.1:8317");
    urls.add("http://localhost:8317");

    // Fallbacks para entornos dockerizados / WSL
    if (process.env.DOCKER_CONTAINER || process.env.WSL_DISTRO_NAME) {
        urls.add("http://host.docker.internal:8317");
    }

    return Array.from(urls);
}

/**
 * Resolución centralizada de la URL base de CPAMC (exportada para todos los módulos).
 * Respeta CLIPROXYAPI_BASE_URL / CPAMC_URL y jamás hardcodea IPs o hosts externos.
 */
export function resolveCpamcBaseUrl(): string {
    return resolveBaseUrl();
}

function requireApiKey(): string {
    let apiKey = (process.env.CLIPROXYAPI_API_KEY || "").trim();
    if (!apiKey) {
        const settings = resolveCpamcSettings();
        if (settings.apiKey) {
            apiKey = settings.apiKey;
            process.env.CLIPROXYAPI_API_KEY = apiKey;
        }
    }
    if (!apiKey) {
        const home = homedir();
        const diskApiKey = join(home, ".cliproxy_api_key");
        if (existsSync(diskApiKey)) {
            try {
                const key = readFileSync(diskApiKey, "utf-8").trim();
                if (key) {
                    apiKey = key;
                    process.env.CLIPROXYAPI_API_KEY = apiKey;
                }
            } catch {}
        }
    }
    if (!apiKey) {
        throw new Error(
            "CLIPROXYAPI_API_KEY is not set in the Pi process environment or settings.json. Export the CLIProxyAPI endpoint API key before starting pi.",
        );
    }
    return apiKey;
}

/**
 * Conjugación de pools: deriva para cada prefijo su etiqueta de pool y rol.
 * `agy` → "P1·LÍDER agy"; `agy_1` → "P1·RESERVA agy_1"; `agy2` → "P2·LÍDER agy2"...
 * Las bases de pool se numeran por orden alfabético determinista (P1, P2, ...).
 */
export function buildPoolLabelMap(prefixes: Iterable<string>, registeredPoolBases?: Set<string>): Map<string, string> {
    const bases = new Map<string, { leaders: string[]; reserves: string[] }>();
    for (const raw of prefixes) {
        const prefix = typeof raw === "string" ? raw.trim() : "";
        if (!prefix) continue;
        const match = prefix.match(/^(.*)_(\d+)$/);
        const base = match ? match[1] : prefix;
        if (!bases.has(base)) bases.set(base, { leaders: [], reserves: [] });
        const entry = bases.get(base)!;
        (match ? entry.reserves : entry.leaders).push(prefix);
    }
    const labels = new Map<string, string>();
    [...bases.keys()].sort().forEach((base, idx) => {
        const isRegisteredPool = registeredPoolBases ? registeredPoolBases.has(base.toLowerCase()) : true;
        const poolNum = `P${idx + 1}`;
        const entry = bases.get(base)!;
        entry.leaders.forEach((p) => {
            if (isRegisteredPool) {
                labels.set(p, `${poolNum}·LÍDER ${p}`);
            } else {
                labels.set(p, `LIBRE ${p}`);
            }
        });
        // Reservas de pools registrados exponen su rol; las de bases SIN pool registrado
        // (cuentas standalone OmniAuth Pro, topología zero-collision) son rutas nativas LIBRE.
        entry.reserves.forEach((p) => {
            if (isRegisteredPool) {
                labels.set(p, `${poolNum}·RESERVA ${p}`);
            } else {
                labels.set(p, `LIBRE ${p}`);
            }
        });
    });
    return labels;
}

function toPiModelFromCPA(model: CPAModel, poolLabels?: Map<string, string>) {
    const id = typeof model.slug === "string" && model.slug.trim()
        ? model.slug.trim()
        : (typeof model.id === "string" ? model.id.trim() : "");
    if (!id) return undefined;

    const lowerId = id.toLowerCase();
    const contextWindow = resolveRecommendedContextWindow(id, model.context_window);
    const maxTokens = Math.min(
        typeof model.max_tokens === "number" && Number.isFinite(model.max_tokens) && model.max_tokens > 0
            ? Math.floor(model.max_tokens)
            : DEFAULT_MAX_TOKENS,
        MAX_SAFE_OUTPUT_TOKENS,
    );

    const levels = (model.supported_reasoning_levels || [])
        .map((lvl) => (typeof lvl?.effort === "string" ? lvl.effort.trim().toLowerCase() : ""))
        .filter((effort): effort is string => Boolean(effort));

    const isReasoning = levels.length > 0 ||
        Boolean(model.default_reasoning_level) ||
        lowerId.includes("thinking") ||
        (model.display_name?.toLowerCase().includes("thinking") ?? false);

    const thinkingLevelMap = isReasoning
        ? buildStrictThinkingLevelMap(levels)
        : undefined;

    const supportsImages = (model.input_modalities?.includes("image") ?? false) ||
        lowerId.includes("vision") ||
        lowerId.includes("image") ||
        lowerId.includes("gemini") ||
        lowerId.includes("claude") ||
        lowerId.includes("gpt");

    const owner = typeof model.owned_by === "string" && model.owned_by.trim() ? model.owned_by.trim() : "CLIProxyAPI";
    const displayName = typeof model.display_name === "string" && model.display_name.trim() ? model.display_name.trim() : id;

    // Si es un Identificador Limpio de Pool (p. ej. Pool-01-gemini)
    if (/^pool-\d+-/i.test(id)) {
        return {
            id,
            name: `${id} (Pool Soberano · Auto Switcher Pro)`,
            provider: PROVIDER_ID,
            reasoning: true,
            input: ["text", "image"] as ("text" | "image")[],
            contextWindow,
            maxTokens,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
            reasoningEfforts: levels,
            description: `Grupo/Pool virtual activo ${id} con balanceo predictivo y failover en caliente`,
            displayName: id,
        };
    }

    const slash = id.indexOf("/");
    const prefix = slash > 0 ? id.slice(0, slash) : "";
    const isParent = prefix === "agy" || prefix === "agy2" || prefix === "agy_son" || prefix === "agy_opus" || prefix === "argon";
    const poolLabel = poolLabels?.get(prefix) ?? null;
    const rolePrefix = poolLabel
        ? (poolLabel.includes("LÍDER") ? `⭐ [${poolLabel}] ` : `[${poolLabel}] `)
        : (isParent ? `⭐ [${prefix === "argon" ? "LIBRE argon" : "ACTIVA"}] ` : "");

    return {
        id,
        name: displayName !== id ? `${rolePrefix}${displayName} (${id})` : `${rolePrefix}${id} (${owner})`,
        provider: PROVIDER_ID,
        reasoning: isReasoning,
        input: supportsImages ? (["text", "image"] as ("text" | "image")[]) : (["text"] as ("text" | "image")[]),
        contextWindow,
        maxTokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
        reasoningEfforts: levels,
        description: typeof (model as any).description === "string" ? (model as any).description.trim() : undefined,
        displayName: typeof model.display_name === "string" ? model.display_name.trim() : undefined,
    };
}

function toPiModelFromOpenAI(model: FallbackOpenAIModel, poolLabels?: Map<string, string>) {
    const id = typeof model.id === "string" ? model.id.trim() : "";
    if (!id) return undefined;

    const capabilities = model.capabilities ?? {};
    const lowerId = id.toLowerCase();
    const slashIdx = id.indexOf("/");
    const modelPrefix = slashIdx > 0 ? id.slice(0, slashIdx) : "";
    const poolLabel = poolLabels?.get(modelPrefix) ?? null;
    const labelPrefix = poolLabel ? `[${poolLabel}] ` : "";
    const reportedContext = typeof model.context_length === "number"
        ? model.context_length
        : (typeof model.max_input_tokens === "number" ? model.max_input_tokens : undefined);
    const contextWindow = resolveRecommendedContextWindow(id, reportedContext);
    const maxTokens = Math.min(
        typeof model.max_output_tokens === "number" && model.max_output_tokens > 0
            ? Math.floor(model.max_output_tokens)
            : DEFAULT_MAX_TOKENS,
        MAX_SAFE_OUTPUT_TOKENS,
    );
    const owner = typeof model.owned_by === "string" && model.owned_by.trim() ? model.owned_by.trim() : "CLIProxyAPI";
    const supportsImages = Boolean(
        capabilities.vision ||
        capabilities.image ||
        capabilities.images ||
        lowerId.includes("image") ||
        lowerId.includes("vision") ||
        lowerId.includes("gemini") ||
        lowerId.includes("claude") ||
        lowerId.includes("gpt"),
    );

    const isReasoning = Boolean(
        capabilities.reasoning ||
        capabilities.thinking ||
        lowerId.includes("thinking") ||
        lowerId.includes("high") ||
        lowerId.includes("pro") ||
        lowerId.includes("sol") ||
        lowerId.includes("luna") ||
        lowerId.includes("terra") ||
        lowerId.includes("o1") ||
        lowerId.includes("o3") ||
        lowerId.includes("gpt-5"),
    );

    const openAiEfforts = isReasoning ? ["low", "medium", "high"] : [];
    const thinkingLevelMap = isReasoning ? buildStrictThinkingLevelMap(openAiEfforts) : undefined;

    // Si es un Identificador Limpio de Pool (p. ej. Pool-01-gemini)
    if (/^pool-\d+-/i.test(id)) {
        return {
            id,
            name: `${id} (Pool Soberano · Auto Switcher Pro)`,
            provider: PROVIDER_ID,
            reasoning: isReasoning,
            input: supportsImages ? (["text", "image"] as ("text" | "image")[]) : (["text"] as ("text" | "image")[]),
            contextWindow,
            maxTokens,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
            reasoningEfforts: openAiEfforts,
        };
    }

    return {
        id,
        name: `${labelPrefix}${id} (${owner})`,
        provider: PROVIDER_ID,
        reasoning: isReasoning,
        input: supportsImages ? (["text", "image"] as ("text" | "image")[]) : (["text"] as ("text" | "image")[]),
        contextWindow,
        maxTokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
        reasoningEfforts: openAiEfforts,
    };
}

let mgmtKeyWarningLogged = false;

export type ManagementKeyResolution = {
    key: string;
    source: "disk_canonical" | "disk_agent" | "env" | "none";
    resolvedPath?: string;
    warning?: string;
};

export function resolveManagementKeyWithDiagnostics(): ManagementKeyResolution {
    const home = homedir();
    const canonicalPath = join(home, ".cliproxy_management_key");
    if (existsSync(canonicalPath)) {
        try {
            const diskKey = readFileSync(canonicalPath, "utf-8").trim();
            if (diskKey) {
                return { key: diskKey, source: "disk_canonical", resolvedPath: canonicalPath };
            }
        } catch {}
    }

    const keyCandidates = new Set<string>();
    if (process.env.PI_CODING_AGENT_DIR) {
        keyCandidates.add(join(process.env.PI_CODING_AGENT_DIR, ".cliproxy_management_key"));
    }
    keyCandidates.add(join(home, ".gentle-shell", "agent", ".cliproxy_management_key"));
    keyCandidates.add(join(home, ".pi", "agent", ".cliproxy_management_key"));

    const piDir = join(home, ".pi");
    if (existsSync(piDir)) {
        try {
            const entries = readdirSync(piDir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isDirectory() && entry.name.startsWith("agent")) {
                    keyCandidates.add(join(piDir, entry.name, ".cliproxy_management_key"));
                }
            }
        } catch {}
    }

    for (const keyFile of keyCandidates) {
        try {
            if (existsSync(keyFile)) {
                const diskKey = readFileSync(keyFile, "utf-8").trim();
                if (diskKey) {
                    return {
                        key: diskKey,
                        source: "disk_agent",
                        resolvedPath: keyFile,
                        warning: `Operando con clave de gestión desde subdirectorio secundario: ${keyFile}`,
                    };
                }
            }
        } catch {}
    }

    const settings = resolveCpamcSettings();
    if (settings.managementKey) {
        return {
            key: settings.managementKey,
            source: "disk_agent",
            warning: "Operando con clave de gestión desde settings.json.",
        };
    }

    const envKey = (process.env.CLIPROXYAPI_MANAGEMENT_KEY || process.env.CLIPROXY_MANAGEMENT_KEY || "").trim();
    if (envKey) {
        return {
            key: envKey,
            source: "env",
            warning: "Operando con clave de gestión provista exclusivamente por variable de entorno.",
        };
    }

    return {
        key: "",
        source: "none",
        warning: "[MODO DEGRADADO] No se encontró clave de gestión de CPAMC (.cliproxy_management_key ni CLIPROXYAPI_MANAGEMENT_KEY). " +
                 "Si corre en Docker: monte ~/.cliproxy_management_key o declare CLIPROXYAPI_MANAGEMENT_KEY para evitar fallbacks silenciosos.",
    };
}

export function resolveManagementKey(): string {
    const res = resolveManagementKeyWithDiagnostics();
    if (res.warning && !mgmtKeyWarningLogged) {
        mgmtKeyWarningLogged = true;
        if (res.source === "none") {
            console.warn(`[AutoSwitcher] ⚠️ ${res.warning}`);
        } else {
            console.info(`[AutoSwitcher] ℹ️ ${res.warning}`);
        }
    }
    return res.key;
}

type AuthFileSummary = {
    name?: string;
    note?: string;
    prefix?: string;
    type?: string;
    provider?: string;
    disabled?: boolean;
    unavailable?: boolean;
};

type DownloadedAuthFile = {
    prefix?: string;
    note?: string;
    type?: string;
    provider?: string;
    excluded_models?: string[];
};

async function fetchAccountPrefixesAndExclusions(preferredBaseUrl?: string, signal?: AbortSignal): Promise<{
    validPrefixes: Set<string>;
    prefixExclusions: Map<string, Set<string>>;
    familyActiveLeaderPrefix: Map<string, string>;
    prefixToFamily: Map<string, string>;
    activePoolFamilies: Set<string>;
    poolAssignedPrefixes: Set<string>;
    activeBareProviders: Set<string>;
    bareExclusions: Set<string>;
    registeredPoolBases: Set<string>;
    confirmedActivePools: Set<string>;
    standaloneAccounts: StandaloneAccountDescriptor[];
} | null> {
    const mgmtKey = resolveManagementKey();
    if (!mgmtKey) return null;

    // Gobernanza por Atomic Epoch (/dev/shm):
    // Si la caché en RAM está viva y el número de época no ha cambiado,
    // devolver la caché inmediatamente sin descargar todos los JSONs de credenciales.
    const currentEpoch = readCurrentSignalEpoch();
    if (cachedFilterData && currentEpoch && lastKnownEpoch === currentEpoch) {
        return cachedFilterData;
    }

    const candidateUrls = preferredBaseUrl
        ? [preferredBaseUrl, ...resolveCandidateBaseUrls().filter((u) => u !== preferredBaseUrl)]
        : resolveCandidateBaseUrls();

    for (const baseUrl of candidateUrls) {
        try {
            const timeout = AbortSignal.timeout(5000);
            const combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
            const res = await fetch(`${baseUrl}/v0/management/auth-files`, {
                headers: {
                    Authorization: `Bearer ${mgmtKey}`,
                    Accept: "application/json",
                },
                signal: combinedSignal,
            });

            if (!res.ok) continue;
            const data = (await res.json()) as { files?: AuthFileSummary[] };
            const files = Array.isArray(data.files) ? data.files : [];

            const validPrefixes = new Set<string>();
            const prefixExclusions = new Map<string, Set<string>>();
            const authFileExclusions = new Map<string, Set<string>>();
            const authFilePrefixes = new Map<string, string>();
            const authFileProviders = new Map<string, string>();
            const activeAuthFiles = new Set<string>();

            // Pre-poblar metadatos desde el resumen de archivos de autenticación
            for (const file of files) {
                const rawNote = typeof file.note === "string" ? file.note.trim() : "";
                const rawPref = typeof file.prefix === "string" ? file.prefix.trim() : "";
                const candidate = rawPref || rawNote;
                if (candidate) {
                    validPrefixes.add(candidate);
                }
                if (file.name && !file.disabled && !file.unavailable) {
                    activeAuthFiles.add(file.name);
                    if (file.type || file.provider) {
                        authFileProviders.set(file.name, (file.provider || file.type)!.toLowerCase());
                    }
                }
            }

            await Promise.allSettled(
                files.map(async (file) => {
                    if (!file.name || file.name.includes("/")) return;
                    const dlRes = await fetch(`${baseUrl}/v0/management/auth-files/download?name=${encodeURIComponent(file.name)}`, {
                        headers: {
                            Authorization: `Bearer ${mgmtKey}`,
                            Accept: "application/json",
                        },
                        signal: combinedSignal,
                    });
                    if (!dlRes.ok) return;
                    const dlData = (await dlRes.json()) as DownloadedAuthFile;
                    const pref = (typeof dlData.prefix === "string" && dlData.prefix.trim())
                        ? dlData.prefix.trim()
                        : (typeof dlData.note === "string" && dlData.note.trim())
                            ? dlData.note.trim()
                            : (typeof file.note === "string" ? file.note.trim() : "");
                    
                    authFilePrefixes.set(file.name, pref);
                    const prov = (dlData.provider || dlData.type || file.provider || file.type || "").toLowerCase().trim();
                    if (prov) {
                        authFileProviders.set(file.name, prov);
                    }

                    const exSet = new Set(Array.isArray(dlData.excluded_models) ? dlData.excluded_models : []);
                    authFileExclusions.set(file.name, exSet);

                    if (pref) {
                        validPrefixes.add(pref);
                        prefixExclusions.set(pref, exSet);
                    }
                })
            );

            const familyActiveLeaderPrefix = new Map<string, string>();
            const prefixToFamily = new Map<string, string>();

            const activePoolFamilies = new Set<string>();
            const poolAssignedPrefixes = new Set<string>();
            const poolMemberFiles = new Set<string>();
            const registeredPoolBases = new Set<string>();
            const confirmedActivePools = new Set<string>();

            const poolsRes = await fetch(`${baseUrl}/v0/management/auto-switcher-pro/pools`, {
                headers: {
                    Authorization: `Bearer ${mgmtKey}`,
                    Accept: "application/json",
                },
                signal: combinedSignal,
            });
            if (poolsRes.ok) {
                const poolsData = (await poolsRes.json()) as {
                    pools?: Array<{
                        id?: string;
                        name?: string;
                        display_name?: string;
                        base_prefix?: string;
                        family?: string;
                        enabled?: boolean;
                        leader_auth?: string;
                        reserves?: string[];
                        members?: string[];
                        policy?: { excluded_models?: string[] };
                    }>;
                };
                const pools = Array.isArray(poolsData.pools) ? poolsData.pools : [];
                
                // Mapeo ordenado determinista: el pool base canónico (ej. 'agy' frente a 'agy2')
                for (const pool of pools) {
                    const basePref = typeof pool.base_prefix === "string" ? pool.base_prefix.trim() : "";
                    if (!basePref) continue;

                    if (pool.enabled !== false) {
                        const poolIdentifier = (pool.display_name || pool.id || pool.name || "").trim();
                        if (poolIdentifier) {
                            confirmedActivePools.add(poolIdentifier);
                        }
                    }

                    registeredPoolBases.add(basePref.toLowerCase());
                    // Marcar el prefijo base del pool como asignado a un pool activo
                    poolAssignedPrefixes.add(basePref.toLowerCase());

                    if (pool.leader_auth) poolMemberFiles.add(pool.leader_auth.trim());
                    if (Array.isArray(pool.reserves)) {
                        for (const r of pool.reserves) if (r) poolMemberFiles.add(r.trim());
                    }
                    if (Array.isArray(pool.members)) {
                        for (const m of pool.members) if (m) poolMemberFiles.add(m.trim());
                    }

                    const fam = (typeof pool.family === "string" && pool.family.trim()) ? pool.family.trim() : "default";
                    activePoolFamilies.add(fam);
                    prefixToFamily.set(basePref, fam);
                    validPrefixes.add(basePref);

                    // Determinar el líder representativo activo para la familia
                    if (!familyActiveLeaderPrefix.has(fam)) {
                        familyActiveLeaderPrefix.set(fam, basePref);
                    } else {
                        const existing = familyActiveLeaderPrefix.get(fam)!;
                        // Priorizar prefijo canónico más corto o alfabéticamente superior ('agy' antes que 'agy2')
                        if (basePref.length < existing.length || (basePref.length === existing.length && basePref < existing)) {
                            familyActiveLeaderPrefix.set(fam, basePref);
                        }
                    }

                    // Sincronizar exclusiones de la Tuerca ⚙️ de la cuenta líder del pool
                    if (pool.leader_auth && authFileExclusions.has(pool.leader_auth)) {
                        prefixExclusions.set(basePref, authFileExclusions.get(pool.leader_auth)!);
                    } else if (Array.isArray(pool.policy?.excluded_models)) {
                        prefixExclusions.set(basePref, new Set(pool.policy.excluded_models));
                    }
                }
            }

            // Descubrir cuentas libres activas que NO pertenecen a ningún pool
            const activeBareProviders = new Set<string>();
            const bareExclusions = new Set<string>();

            for (const fileName of activeAuthFiles) {
                if (!poolMemberFiles.has(fileName)) {
                    const pref = authFilePrefixes.get(fileName) ?? "";
                    if (!pref || pref === "argon" || pref.startsWith("argon")) {
                        // Cuenta libre sin prefijo o cuenta Argon libre: habilitar su proveedor legítimo
                        const prov = authFileProviders.get(fileName) || (pref.startsWith("argon") ? "gemini-argon" : "antigravity");
                        activeBareProviders.add(prov);
                        const exs = authFileExclusions.get(fileName);
                        if (exs) {
                            for (const ex of exs) bareExclusions.add(ex);
                        }
                    }
                }
            }

            // Descubrir alias estables para cuentas standalone (CX1, CX2, AG1...)
            const standaloneAliases = new Map<string, string>();
            const standaloneAccounts: StandaloneAccountDescriptor[] = [];

            try {
                const manifestRes = await fetch(`${baseUrl}/v0/management/auto-switcher-pro/manifest`, {
                    headers: {
                        Authorization: `Bearer ${mgmtKey}`,
                        Accept: "application/json",
                    },
                    signal: combinedSignal,
                });
                if (manifestRes.ok) {
                    const mData = (await manifestRes.json()) as any;
                    if (mData.standalone_aliases && typeof mData.standalone_aliases === "object") {
                        for (const [k, v] of Object.entries(mData.standalone_aliases)) {
                            if (typeof v === "string") standaloneAliases.set(k, v);
                        }
                    }
                    if (Array.isArray(mData.accounts)) {
                        for (const a of mData.accounts) {
                            if (a.role === "unassigned" && a.account_key) {
                                const al = a.alias || standaloneAliases.get(a.account_key) || "";
                                if (al) {
                                    const prov = (a.provider || authFileProviders.get(a.account_key) || "antigravity").toLowerCase();
                                    const rawEmail = a.email || a.account_key;
                                    const atIdx = rawEmail.indexOf("@");
                                    const masked = atIdx > 3 ? `${rawEmail.slice(0, 3)}...${rawEmail.slice(atIdx - 3)}` : rawEmail;
                                    standaloneAccounts.push({
                                        accountKey: a.account_key,
                                        email: rawEmail,
                                        alias: al,
                                        provider: prov,
                                        maskedEmail: masked,
                                        excludedModels: authFileExclusions.get(a.account_key) || new Set(),
                                    });
                                }
                            }
                        }
                    }
                }
            } catch {}

            // Fallback de estado local si /manifest no estaba disponible o no devolvió alias
            if (standaloneAccounts.length === 0) {
                const stateFiles = resolveSignalFileTargets().filter((f) => f.endsWith("auto-switcher-pro-state.json"));
                for (const sf of stateFiles) {
                    try {
                        if (existsSync(sf)) {
                            const raw = JSON.parse(readFileSync(sf, "utf-8"));
                            if (raw.standalone_aliases && typeof raw.standalone_aliases === "object") {
                                for (const [k, v] of Object.entries(raw.standalone_aliases)) {
                                    if (typeof v === "string") standaloneAliases.set(k, v);
                                }
                            }
                        }
                    } catch {}
                }
                for (const fileName of activeAuthFiles) {
                    if (!poolMemberFiles.has(fileName)) {
                        const al = standaloneAliases.get(fileName);
                        if (al) {
                            const prov = (authFileProviders.get(fileName) || "antigravity").toLowerCase();
                            const rawEmail = fileName.replace(/^antigravity-|^codex-|^claude-/, "").replace(/\.json$/, "");
                            const atIdx = rawEmail.indexOf("@");
                            const masked = atIdx > 3 ? `${rawEmail.slice(0, 3)}...${rawEmail.slice(atIdx - 3)}` : rawEmail;
                            standaloneAccounts.push({
                                accountKey: fileName,
                                email: rawEmail,
                                alias: al,
                                provider: prov,
                                maskedEmail: masked,
                                excludedModels: authFileExclusions.get(fileName) || new Set(),
                            });
                        }
                    }
                }
            }

            const result = {
                validPrefixes,
                prefixExclusions,
                familyActiveLeaderPrefix,
                prefixToFamily,
                activePoolFamilies,
                poolAssignedPrefixes,
                activeBareProviders,
                bareExclusions,
                registeredPoolBases,
                confirmedActivePools,
                standaloneAccounts,
            };
            cachedFilterData = result;
            lastKnownEpoch = currentEpoch || readCurrentSignalEpoch();
            return result;
        } catch {
            // Continúa probando la siguiente URL en la cascada
        }
    }

    return cachedFilterData;
}

function isKnownFallbackPrefix(prefix: string): boolean {
    return /^agy\d*$/.test(prefix) ||
        prefix === "agy_son" || /^agy_son\d+$/.test(prefix) ||
        prefix === "agy_opus" || /^agy_opus\d+$/.test(prefix) ||
        ((prefix.startsWith("clau") || prefix.startsWith("claude")) && !prefix.startsWith("agy_")) ||
        prefix === "codex" || /^codex\d+$/.test(prefix) ||
        prefix === "argon" || /^argon\d*$/.test(prefix);
}

export function isCleanIncludedModel(id: string, filterData: {
    validPrefixes: Set<string>;
    prefixExclusions: Map<string, Set<string>>;
    familyActiveLeaderPrefix?: Map<string, string>;
    prefixToFamily?: Map<string, string>;
    activePoolFamilies?: Set<string>;
    poolAssignedPrefixes?: Set<string>;
    activeBareProviders?: Set<string>;
    bareExclusions?: Set<string>;
    registeredPoolBases?: Set<string>;
    standaloneAccounts?: StandaloneAccountDescriptor[];
} | null): boolean {
    const trimmed = id.trim();

    // 0. Si es un Identificador Limpio de Pool Canónico (p. ej. Pool-01-gemini, Pool-02-gemini)
    if (/^pool-\d+-/i.test(trimmed)) {
        return true;
    }

    const slashIndex = trimmed.indexOf("/");

    // Modelos Planos / Sin Barra (Cuentas Libres Nativas y Fallback Bimodal N=0)
    if (slashIndex === -1) {
        if (!filterData) {
            // Cold boot / offline fallback: permitir modelos estándar oficiales reconocidos
            const lower = trimmed.toLowerCase();
            return (
                lower.startsWith("gemini") ||
                lower.startsWith("claude") ||
                lower.startsWith("gpt") ||
                lower.startsWith("o1") ||
                lower.startsWith("o3") ||
                lower.startsWith("chatgpt") ||
                lower.includes("argon")
            );
        }

        if (!filterData.activeBareProviders || filterData.activeBareProviders.size === 0) {
            return false;
        }

        const lower = trimmed.toLowerCase();

        // Si las cuentas libres de este proveedor ya están expuestas unívocamente vía sub-proveedores con alias (ej. CX1, CX2),
        // suprimir la ruta plana ambigua bajo 'cpamc' para evitar opciones duplicadas no diferenciadas.
        if (filterData.standaloneAccounts && filterData.standaloneAccounts.length > 0) {
            const hasAliasedAccount = filterData.standaloneAccounts.some((acc) => {
                const prov = acc.provider.toLowerCase();
                if ((prov.includes("codex") || prov.includes("openai")) && (lower.startsWith("gpt") || lower.startsWith("o1") || lower.startsWith("o3") || lower.startsWith("chatgpt"))) return true;
                if ((prov.includes("antigravity") || prov.includes("google") || prov.includes("gemini")) && (lower.startsWith("gemini") || lower.includes("gemini")) && !lower.includes("argon")) return true;
                if (prov.includes("argon") && (lower.includes("argon") || lower === "gemini-4-argon" || lower === "gemini-2.5-pro")) return true;
                if ((prov.includes("claude") || prov.includes("anthropic")) && lower.startsWith("claude")) return true;
                return false;
            });
            if (hasAliasedAccount) {
                return false;
            }
        }

        let matchesActiveBareProvider = false;

        if (filterData.activeBareProviders.has("antigravity") && (lower.startsWith("gemini") || lower.includes("gemini"))) {
            matchesActiveBareProvider = true;
        } else if (
            (filterData.activeBareProviders.has("gemini-argon") || filterData.activeBareProviders.has("gemini_argon")) &&
            (lower.includes("argon") || lower === "gemini-4-argon" || lower === "gemini-2.5-pro")
        ) {
            matchesActiveBareProvider = true;
        } else if (
            (filterData.activeBareProviders.has("openai") || filterData.activeBareProviders.has("codex")) &&
            (lower.startsWith("gpt") || lower.startsWith("o1") || lower.startsWith("o3") || lower.startsWith("chatgpt"))
        ) {
            matchesActiveBareProvider = true;
        } else if (
            (filterData.activeBareProviders.has("anthropic") || filterData.activeBareProviders.has("claude")) &&
            lower.startsWith("claude")
        ) {
            matchesActiveBareProvider = true;
        }

        if (!matchesActiveBareProvider) {
            return false; // Bloquea modelos fantasma de omni-auth-pro (gpt-6-luna, deepseek-*, qwen*, etc.)
        }

        // Si la credencial física de la cuenta libre excluyó este modelo, respetarlo
        if (filterData.bareExclusions && filterData.bareExclusions.has(trimmed)) {
            return false;
        }

        return true;
    }

    if (slashIndex <= 0 || slashIndex >= trimmed.length - 1) {
        return false;
    }

    const prefix = trimmed.slice(0, slashIndex);

    // 1. Filtrar reservas numéricas (_1, _2...) SOLO cuando la base es un pool registrado
    //    (se exponen vía fachada virtual Pool-XX). Las cuentas standalone de OmniAuth Pro con
    //    topología zero-collision (base_N sin pool registrado, ej. nim_1) son rutas nativas
    //    legítimas de CPAMC y SÍ pasan a /model con su etiqueta [LIBRE <prefijo>].
    if (/_(\d+)$/.test(prefix)) {
        const base = prefix.slice(0, prefix.lastIndexOf("_")).toLowerCase();
        const registeredBases = filterData?.registeredPoolBases;
        if (!registeredBases || registeredBases.has(base)) {
            return false;
        }
    }

    // 1.5. REGLA ARQUITECTÓNICA SAGRADA (Máscara Virtual Pura y Coexistencia Granular por Cuenta):
    // - Si este prefijo físico está ASIGNADO a un pool activo (ej. "agy", "agy2"), SE OCULTA de /model
    //   porque ya está gobernado y enmascarado limpiamente por su Pool-XX-<familia>.
    // - Si este prefijo NO está asignado a ningún pool (cuenta libre / nueva del mismo o de otro proveedor),
    //   NO SE OCULTA: se respeta su comportamiento 100% nativo de CPAMC ("Auth Files Management") y pasa
    //   a /model con sus exclusiones de disco.
    if (filterData?.poolAssignedPrefixes && filterData.poolAssignedPrefixes.has(prefix.toLowerCase())) {
        return false; // Enmascarado bajo su respectivo Pool-XX
    }

    // 2. Comprobar validez de prefijo (validPrefixes del backend o fallback por convención N -> ∞)
    if (filterData) {
        if (!filterData.validPrefixes.has(prefix)) {
            return false;
        }
    } else if (!isKnownFallbackPrefix(prefix)) {
        return false;
    }

    // 3. Aislamiento estricto por familia de pool (Escalabilidad N -> ∞)
    const modelSlug = trimmed.slice(slashIndex + 1).toLowerCase();
    const isAgyGemini = /^agy\d*$/.test(prefix);
    const isAgySonnet = prefix === "agy_son" || /^agy_son\d+$/.test(prefix);
    const isAgyOpus = prefix === "agy_opus" || /^agy_opus\d+$/.test(prefix);
    const isDirectClaude = (prefix.startsWith("clau") || prefix.startsWith("claude")) && !prefix.startsWith("agy_");
    const isCodex = prefix === "codex" || /^codex\d+$/.test(prefix);
    const isArgon = prefix === "argon" || /^argon\d*$/.test(prefix);

    if (isAgyGemini && !modelSlug.includes("gemini")) {
        return false;
    }
    if (isAgySonnet && (!modelSlug.includes("sonnet") || modelSlug.includes("opus"))) {
        return false;
    }
    if (isAgyOpus && (!modelSlug.includes("opus") || modelSlug.includes("sonnet"))) {
        return false;
    }
    if (isDirectClaude && !modelSlug.includes("claude") && !modelSlug.includes("anthropic")) {
        return false;
    }
    if (isCodex && !modelSlug.includes("codex") && !modelSlug.includes("gpt") && !modelSlug.includes("openai")) {
        return false;
    }
    if (isArgon && !modelSlug.includes("gemini") && !modelSlug.includes("argon")) {
        return false;
    }

    // 4. Tuerca ⚙️ de Especialista: Si el modelo fue excluido en la cuenta física / líder, no pasa
    if (filterData) {
        const exSet = filterData.prefixExclusions.get(prefix);
        if (exSet) {
            if (exSet.has(trimmed)) return false;
            const unprefixed = trimmed.slice(slashIndex + 1);
            if (exSet.has(unprefixed)) return false;
        }

        // INVARIANTE AGENTS.md (Escalabilidad N -> ∞):
        // Cada pool activo registrado (base_prefix) es su propia fachada virtual independiente.
        // NUNCA colapsar o sombrear pools hermanos (agy, agy2, agy3... codex, codex2... clau, clau2...).
    }

    return true;
}

export function buildPendingAccountsPlaceholderModel(baseUrl: string) {
    const cleanUrl = baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
    return {
        id: "sin-cuentas-vinculadas",
        name: `ℹ️ [CPAMC ONLINE] Sin cuentas vinculadas (Abre ${cleanUrl}/management.html)`,
        provider: PROVIDER_ID,
        reasoning: false,
        input: ["text"] as ("text" | "image")[],
        contextWindow: 128000,
        maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        description: `El servidor CPAMC está activo y conectado en ${cleanUrl}. Puedes vincular tus cuentas de Google o Claude cuando lo desees desde la consola web (${cleanUrl}/management.html).`,
        displayName: "ℹ️ CPAMC (Sin cuentas vinculadas)",
    };
}

export async function fetchCLIProxyModels(signal?: AbortSignal) {
    const candidateUrls = resolveCandidateBaseUrls();
    const apiKey = requireApiKey();
    const prefixOf = (id: string) => {
        const idx = id.indexOf("/");
        return idx > 0 ? id.slice(0, idx) : "";
    };

    let filterData = await fetchAccountPrefixesAndExclusions(undefined, signal);
    let respondedOkUrl: string | null = null;

    // Intentar /v1/models?client_version=1 a través de la cascada universal
    for (const baseUrl of candidateUrls) {
        try {
            const timeout = AbortSignal.timeout(6000);
            const combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
            const response = await fetch(`${baseUrl}/v1/models?client_version=1`, {
                headers: { Authorization: `Bearer ${apiKey}` },
                signal: combinedSignal,
            });

            if (response.ok) {
                respondedOkUrl = baseUrl;
                const payload = (await response.json()) as { models?: CPAModel[] };
                if (Array.isArray(payload.models) && payload.models.length > 0) {
                    if (activePiInstance && filterData?.standaloneAccounts && filterData.standaloneAccounts.length > 0) {
                        syncStandaloneSubproviders(
                            activePiInstance,
                            filterData.standaloneAccounts,
                            payload.models,
                            baseUrl,
                            resolveProviderHeaders()
                        );
                    }
                    const included = payload.models.filter((model) => {
                        const id = typeof model.slug === "string" ? model.slug.trim()
                            : (typeof model.id === "string" ? model.id.trim() : "");
                        return isCleanIncludedModel(id, filterData);
                    });
                    const poolLabels = buildPoolLabelMap(
                        filterData ? [...filterData.validPrefixes] : included.map((m) => prefixOf(typeof m.slug === "string" ? m.slug : (m.id ?? ""))),
                        filterData?.registeredPoolBases
                    );
                    const mappedModels = included
                        .map((m) => toPiModelFromCPA(m, poolLabels))
                        .filter((model): model is NonNullable<ReturnType<typeof toPiModelFromCPA>> => Boolean(model));

                    const reconciled = reconcileActivePoolFacades(mappedModels, filterData?.confirmedActivePools);
                    if (reconciled.length > 0) {
                        return reconciled;
                    }
                }
            }
        } catch {
            // Continúa con la siguiente URL en la cascada
        }
    }

    // Fallback a /v1/models estándar a través de la cascada universal
    for (const baseUrl of candidateUrls) {
        try {
            const timeout = AbortSignal.timeout(6000);
            const combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
            const response = await fetch(`${baseUrl}/v1/models`, {
                headers: { Authorization: `Bearer ${apiKey}` },
                signal: combinedSignal,
            });

            if (response.ok) {
                respondedOkUrl = baseUrl;
                const payload = (await response.json()) as { data?: FallbackOpenAIModel[] };
                if (Array.isArray(payload.data) && payload.data.length > 0) {
                    if (activePiInstance && filterData?.standaloneAccounts && filterData.standaloneAccounts.length > 0) {
                        syncStandaloneSubproviders(
                            activePiInstance,
                            filterData.standaloneAccounts,
                            payload.data as any,
                            baseUrl,
                            resolveProviderHeaders()
                        );
                    }
                }
                const includedFallback = (payload.data ?? []).filter((model) => {
                    const id = typeof model.id === "string" ? model.id.trim() : "";
                    return isCleanIncludedModel(id, filterData);
                });
                const poolLabelsFallback = buildPoolLabelMap(
                    filterData ? [...filterData.validPrefixes] : includedFallback.map((m) => prefixOf(typeof m.id === "string" ? m.id : "")),
                    filterData?.registeredPoolBases
                );
                const mappedFallback = includedFallback
                    .map((m) => toPiModelFromOpenAI(m, poolLabelsFallback))
                    .filter((model): model is NonNullable<ReturnType<typeof toPiModelFromOpenAI>> => Boolean(model));

                const reconciled = reconcileActivePoolFacades(mappedFallback, filterData?.confirmedActivePools);
                if (reconciled.length > 0) {
                    return reconciled;
                }
            }
        } catch {
            // Continúa con la siguiente URL en la cascada
        }
    }

    // Si el servidor respondió HTTP 200 pero no tiene cuentas ni modelos aún (máquina recién instalada),
    // exponer un modelo informativo amigable en /model para evitar desconcierto en el usuario
    if (respondedOkUrl) {
        return [buildPendingAccountsPlaceholderModel(respondedOkUrl)];
    }

    throw new Error("CLIProxyAPI /v1/models failed across all candidate base URLs");
}

/**
 * Reconciliación resiliente de fachadas de pools confirmados:
 * Si el servidor CPAMC por cualquier motivo (caché estática del host, falta de reinicio tras crear pools)
 * no expone en /v1/models algún pool activo que sí confirmó el plugin en /auto-switcher-pro/pools,
 * inyecta la fachada limpia (Pool-XX-<familia>) para garantizar disponibilidad inmediata en /model.
 */
export function reconcileActivePoolFacades<T extends { id: string }>(
    models: T[],
    confirmedActivePools?: Set<string>,
): T[] {
    if (!confirmedActivePools || confirmedActivePools.size === 0) {
        return models;
    }
    const seenIds = new Set(models.map((m) => m.id.toLowerCase()));
    const result = [...models];

    for (const poolId of confirmedActivePools) {
        if (!seenIds.has(poolId.toLowerCase())) {
            seenIds.add(poolId.toLowerCase());
            const synthetic = toPiModelFromCPA({
                id: poolId,
                slug: poolId,
                object: "model",
                owned_by: "antigravity",
                display_name: poolId,
            } as CPAModel);
            if (synthetic) {
                result.push(synthetic as unknown as T);
            }
        }
    }

    result.sort((a, b) => a.id.localeCompare(b.id));
    return result;
}

export function resolveProviderHeaders(): Record<string, string> {
    let projectIdentity = "";
    const cwd = process.cwd();
    try {
        if (cwd) {
            projectIdentity = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
        }
    } catch {}

    let opencodeSessionId = process.env.OPENCODE_SESSION_ID || process.env.PI_FREE_BRIDGE_SESSION_ID || "";
    if (!opencodeSessionId) {
        try {
            const dbPath = join(homedir(), ".local", "share", "opencode", "opencode.db");
            if (existsSync(dbPath)) {
                const query = `sqlite3 "${dbPath}" "SELECT id FROM session ORDER BY time_created DESC LIMIT 1;"`;
                const stdout = execSync(query, { encoding: "utf-8", timeout: 800 }).trim();
                if (stdout && stdout.startsWith("ses_")) {
                    opencodeSessionId = stdout;
                }
            }
        } catch {}
    }
    if (!opencodeSessionId) {
        opencodeSessionId = `ses_${projectIdentity || "default_session"}`;
    }

    const providerHeaders: Record<string, string> = {
        "x-opencode-session": opencodeSessionId,
        "x-opencode-session-id": opencodeSessionId,
    };
    if (projectIdentity) {
        providerHeaders["x-project-identity"] = projectIdentity;
        providerHeaders["x-workspace-root"] = cwd;
    }
    return providerHeaders;
}

export function syncStandaloneSubproviders(
    pi: ExtensionAPI,
    standaloneAccounts: StandaloneAccountDescriptor[],
    rawModels: Array<{ id?: string; slug?: string; display_name?: string; [key: string]: any }>,
    candidateBaseUrl: string,
    providerHeaders: Record<string, string>
) {
    const currentAliases = new Set<string>();

    for (const acc of standaloneAccounts) {
        if (!acc.alias) continue;
        const subProvId = `cpamc - ${acc.alias}`;
        currentAliases.add(subProvId);

        const lowerProv = acc.provider.toLowerCase();
        const matchingRaw = rawModels.filter((m) => {
            const rawId = (typeof m.slug === "string" ? m.slug : (typeof m.id === "string" ? m.id : "")).trim();
            if (!rawId || /^pool-\d+-/i.test(rawId) || rawId.includes("/")) return false;
            if (acc.excludedModels.has(rawId)) return false;

            const lower = rawId.toLowerCase();
            if (lowerProv.includes("codex") || lowerProv.includes("openai")) {
                return lower.startsWith("gpt") || lower.startsWith("o1") || lower.startsWith("o3") || lower.startsWith("chatgpt") || lower.includes("codex");
            }
            if (lowerProv.includes("argon")) {
                return lower.includes("argon") || lower === "gemini-4-argon" || lower === "gemini-2.5-pro";
            }
            if (lowerProv.includes("antigravity") || lowerProv.includes("google") || lowerProv.includes("gemini")) {
                return (lower.startsWith("gemini") || lower.includes("gemini")) && !lower.includes("argon");
            }
            if (lowerProv.includes("claude") || lowerProv.includes("anthropic")) {
                return lower.startsWith("claude");
            }
            return false;
        });

        const mappedSubModels = matchingRaw.map((m) => {
            const id = (typeof m.slug === "string" ? m.slug : (typeof m.id === "string" ? m.id : "")).trim();
            const baseMapped = toPiModelFromCPA(m);
            if (!baseMapped) return null;
            const cleanDisplayName = typeof m.display_name === "string" && m.display_name.trim() ? m.display_name.trim() : id;
            return {
                ...baseMapped,
                id,
                provider: subProvId,
                name: `${cleanDisplayName} [${acc.alias}]`,
                description: `Cuenta libre ${acc.alias} (${acc.maskedEmail || acc.email}) · CPAMC`,
            };
        }).filter((m): m is NonNullable<typeof m> => Boolean(m));

        if (mappedSubModels.length > 0) {
            pi.registerProvider(subProvId, {
                name: `CPAMC (${acc.alias})`,
                baseUrl: `${candidateBaseUrl}/v1`,
                apiKey: "$CLIPROXYAPI_API_KEY",
                api: "openai-completions",
                headers: {
                    ...providerHeaders,
                    "X-Account-Alias": acc.alias,
                },
                models: mappedSubModels as any,
                compat: {
                    supportsDeveloperRole: false,
                    supportsReasoningEffort: true,
                    supportsUsageInStreaming: true,
                    maxTokensField: "max_tokens",
                },
                async refreshModels() {
                    return mappedSubModels as any;
                },
            } as any);
            registeredSubproviders.add(subProvId);
        }
    }

    for (const prev of Array.from(registeredSubproviders)) {
        if (!currentAliases.has(prev)) {
            try {
                if (typeof pi.unregisterProvider === "function") {
                    pi.unregisterProvider(prev);
                }
            } catch {}
            registeredSubproviders.delete(prev);
        }
    }
}

export function initDynamicProvider(pi: ExtensionAPI): void {
    activePiInstance = pi;
    const cachedModels = loadCachedModels();

    // Refresco asíncrono en segundo plano al arrancar la extensión
    fetchCLIProxyModels().then((models) => {
        if (Array.isArray(models) && models.length > 0) {
            saveCachedModels(models);
        }
    }).catch(() => {});

    // Watcher reactivo de señalización atómica: ante cambios en auto-switcher-pro.epoch
    // o en auto-switcher-pro-state.json, invalida la caché en RAM e invoca la sincronización en caliente.
    let debounceTimer: NodeJS.Timeout | null = null;
    const triggerHotReload = () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(async () => {
            try {
                invalidateMemoryCaches();
                const models = await fetchCLIProxyModels();
                if (Array.isArray(models) && models.length > 0) {
                    saveCachedModels(models);
                }
            } catch {}
        }, 75);
    };

    const signalTargets = resolveSignalFileTargets();
    for (const target of signalTargets) {
        try {
            if (existsSync(target)) {
                watch(target, () => triggerHotReload()).unref();
            } else {
                const parent = dirname(target);
                if (existsSync(parent)) {
                    watch(parent, (_event, filename) => {
                        if (typeof filename === "string" && (filename.includes("epoch") || filename.includes("state.json"))) {
                            triggerHotReload();
                        }
                    }).unref();
                }
            }
        } catch {}
    }

    // Inmunidad a Terminal Fantasma: hidratar process.env desde settings.json si no estaban exportadas
    const settings = resolveCpamcSettings();
    if (settings.apiKey && !process.env.CLIPROXYAPI_API_KEY) {
        process.env.CLIPROXYAPI_API_KEY = settings.apiKey;
    }
    if (settings.baseUrl && !process.env.CLIPROXYAPI_BASE_URL) {
        process.env.CLIPROXYAPI_BASE_URL = settings.baseUrl;
    }
    if (settings.managementKey && !process.env.CLIPROXYAPI_MANAGEMENT_KEY) {
        process.env.CLIPROXYAPI_MANAGEMENT_KEY = settings.managementKey;
    }

    const providerHeaders = resolveProviderHeaders();

    pi.registerProvider(PROVIDER_ID, {
        name: "CPAMC",
        baseUrl: `${resolveBaseUrl()}/v1`,
        apiKey: "$CLIPROXYAPI_API_KEY",
        api: "openai-completions",
        headers: providerHeaders,
        models: cachedModels.length > 0 ? (cachedModels as any) : undefined,
        compat: {
            supportsDeveloperRole: false,
            supportsReasoningEffort: true,
            supportsUsageInStreaming: true,
            maxTokensField: "max_tokens",
        },
        async refreshModels({ signal }: { signal?: AbortSignal } = {}) {
            invalidateMemoryCaches();
            const models = await fetchCLIProxyModels(signal);
            if (Array.isArray(models) && models.length > 0) {
                saveCachedModels(models);
            }
            return models;
        },
    } as any);
}

export default initDynamicProvider;
