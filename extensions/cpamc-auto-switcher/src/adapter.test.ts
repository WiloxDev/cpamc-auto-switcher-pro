import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

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
	CpamcTuiAdapter,
	formatFooterRotationBlock,
	formatSidebarQuotaCardLines,
	calculateQuotaPace,
	parseConsumedNumber,
	stripAnsi,
	visibleLen,
	truncateWithAnsi,
	setSessionAccordionState,
	renderUnicodeSparkline,
	renderBrailleDonut,
	renderQuotaCardTabBar,
} = await import("./adapter.js");
const { runawayGuard } = await import("./guards.js");
const {
	setQuotaCardViewMode,
	getQuotaCardViewMode,
	setActiveQuotaCardTab,
	getActiveQuotaCardTab,
	recordTurnTelemetry,
	recordTelemetryEvent,
	clearTelemetryHistoriesForTest,
} = await import("./store.js");
import type { PoolRotationPair } from "./store.js";

describe("Adapter Footer Formatting & Origin Indicator", () => {
	beforeEach(() => {
		runawayGuard.dismissIncident();
		runawayGuard.resetSession();
	});
	const mockNativePair: PoolRotationPair = {
		poolKey: "native",
		familyName: "Antigravity",
		familyIcon: "✨",
		totalAccounts: 1,
		isNativeReadOnly: true,
		active: {
			status: "[ACTIVE]",
			provider: "cpamc",
			profile: "default",
			accountId: "native-1",
			prefix: "agy",
			consumed5h: "0/100",
			consumedWeekly: "0/500",
			minAvailable: "100%",
		},
	};

	const mockPoolPair: PoolRotationPair = {
		poolKey: "Pool-01-gemini",
		familyName: "Gemini",
		familyIcon: "✨",
		totalAccounts: 2,
		isNativeReadOnly: false,
		active: {
			status: "[ACTIVE]",
			provider: "cpamc",
			profile: "default",
			accountId: "acc-1",
			prefix: "agy",
			consumed5h: "10/100",
			consumedWeekly: "50/500",
			minAvailable: "95%",
		},
		next: {
			status: "[RESERVE]",
			provider: "cpamc",
			profile: "default",
			accountId: "acc-2",
			prefix: "agy_1",
			consumed5h: "0/100",
			consumedWeekly: "0/500",
			minAvailable: "100%",
		},
	};

	it("renders footer block without originTag when not provided", () => {
		const out = formatFooterRotationBlock(mockPoolPair, false);
		const clean = stripAnsi(out);
		assert.match(clean, /⏸ agy 95%/);
		assert.match(clean, /⏭ agy_1 100%/);
		assert.doesNotMatch(clean, /· default/);
		assert.doesNotMatch(clean, /· sesión/);
	});

	it("renders persistent origin indicator '· default' in rotation block", () => {
		const out = formatFooterRotationBlock(mockPoolPair, false, "default");
		const clean = stripAnsi(out);
		assert.match(clean, /⏸ agy 95%/);
		assert.match(clean, /⏭ agy_1 100%/);
		assert.match(clean, /· default/);
	});

	it("renders persistent origin indicator '· sesión' in rotation block", () => {
		const out = formatFooterRotationBlock(mockPoolPair, true, "sesión");
		const clean = stripAnsi(out);
		assert.match(clean, /▶ agy 95%/);
		assert.match(clean, /· sesión/);
	});

	it("renders origin indicator on native read-only accounts", () => {
		const out = formatFooterRotationBlock(mockNativePair, false, "default");
		const clean = stripAnsi(out);
		assert.match(clean, /⚡ agy 100%/);
		assert.match(clean, /· default/);
	});

	it("renders standalone origin indicator when current pair is null", () => {
		const out = formatFooterRotationBlock(null, false, "sesión");
		const clean = stripAnsi(out);
		assert.match(clean, /· sesión/);
	});

	it("returns empty string when pair is null and originTag is undefined", () => {
		const out = formatFooterRotationBlock(null, false);
		assert.equal(out, "");
	});

	it("renders sidebar card with colloquial unified labels and CUIDANDO EL CHAT block", () => {
		const lines = formatSidebarQuotaCardLines(mockPoolPair, 48);
		const text = lines.map((l: string) => stripAnsi(l)).join("\n");
		assert.match(text, /Modelo\s+Pool-01-gemini/);
		assert.match(text, /Cuentas:\s+2\s+· listas/);
		assert.match(text, /⚡ acc-1/);
		assert.match(text, /5 HORAS/);
		assert.match(text, /SEMANAL/);
		assert.match(text, /Quedan 5h 0m/);
		assert.match(text, /⏱\s+/);
		assert.match(text, /Uso/);
		assert.match(text, /90% libre/);
		assert.match(text, /Ritmo/);
		assert.match(text, /Candidato a Líder:\s+acc-2/);
		assert.match(text, /\[CUIDANDO EL CHAT\]/);
		assert.match(text, /● En guardia/);
		assert.match(text, /Turno en vivo:/);
		assert.match(text, /0\/15 acciones/);
		assert.match(text, /Guardia:\s+0 bucles · Código protegido/);
	});

	it("renders dynamic telemetría viva in Guardia when incidents have been mitigated", () => {
		const mitigatedTelemetry: any = {
			totalToolCount: 0,
			circuitBreakerTripped: false,
			mitigatedCount: 1,
			tokensSavedEstimate: 30000,
		};
		const lines = formatSidebarQuotaCardLines(mockPoolPair, 48, undefined, undefined, false, mitigatedTelemetry);
		const text = lines.map((l: string) => stripAnsi(l)).join("\n");
		assert.match(text, /Guardia:\s+1 mitigado \(~30k tk salvados\)/);
	});

	it("renders sidebar card in active execution state with LIVE indicator", () => {
		const lines = formatSidebarQuotaCardLines(mockPoolPair, 48, undefined, undefined, true);
		const text = lines.map((l: string) => stripAnsi(l)).join("\n");
		assert.match(text, /\[● Escribiendo\]/);
		assert.match(text, /\[CUIDANDO EL CHAT\]/);
		assert.match(text, /⚡ Monitoreando turno/);
	});

	it("renders sidebar card in intercepted runaway loop state", () => {
		const alertTelemetry: any = {
			bashExplorationCount: 5,
			subagentPollCount: 1,
			blockedIntrospections: 1,
			blockedBashEvasions: 1,
			blockedSubagentPolls: 0,
			lastBlockedReason: "Evasión por bash bloqueada",
			totalToolCount: 6,
			circuitBreakerTripped: false,
			tokensSavedEstimate: 0,
			blockedProhibitedCommands: 0,
		};
		const lines = formatSidebarQuotaCardLines(mockPoolPair, 48, undefined, undefined, false, alertTelemetry);
		const text = lines.map((l: string) => stripAnsi(l)).join("\n");
		assert.match(text, /Frenando bucles/);
		assert.match(text, /⚡ Bucle Interceptado/);
		assert.match(text, /Bash:\s+🛑 Bloqueado/);
		assert.match(text, /Sesión:\s+🛑 Bloqueado/);
	});

	it("renders sidebar card in tripped circuit breaker state with hyperlink and tokens saved", () => {
		const trippedTelemetry = {
			bashExplorationCount: 0,
			subagentPollCount: 0,
			totalToolCount: 15,
			circuitBreakerTripped: true,
			circuitBreakerReason: "CYCLE_DETECTED" as const,
			incidentId: "cb_test123",
			tokensSavedEstimate: 85000,
			blockedIntrospections: 0,
			blockedBashEvasions: 0,
			blockedSubagentPolls: 0,
			blockedProhibitedCommands: 0,
		};
		const lines = formatSidebarQuotaCardLines(mockPoolPair, 48, undefined, undefined, false, trippedTelemetry);
		const text = lines.map((l: string) => stripAnsi(l)).join("\n");
		assert.match(text, /🛑 DISPARADO/);
		assert.match(text, /Ciclo repetitivo \(x3\)/);
		assert.match(text, /Tokens protegidos\s+~85k tokens/);
		assert.match(text, /Diagnóstico\s+\[Ver detalles \(3\) ↗\]/);
		assert.match(text, /O escribe\s+\/incident/);
		assert.match(text, /\[ACCIÓN REQUERIDA\]/);
		assert.match(text, /Dar orden directa/);

		// Verificar que el formato OSC 8 esté presente en las líneas sin stripAnsi con URL dinámica
		const rawText = lines.join("\n");
		assert.match(rawText, /\x1b\]8;;https?:\/\/[^\/]+\/management\.html#\/plugin-pages\/auto-switcher-pro-[^\/]+\/2#incident-cb_test123\x1b\\/);

		// Issue #24 regression guard: cada línea con OSC 8 debe medir exactamente 48 cols en TUI
		lines.forEach((l: string, idx: number) => {
			assert.strictEqual(visibleLen(l), 48, `Tripped circuit breaker line ${idx} must be 48 cols (got ${visibleLen(l)})`);
		});
	});

	it("satisfies Issue #24: truncateWithAnsi recognizes OSC 8 hyperlink sequences and avoids sidebar collapse (>48 cols)", () => {
		const longUrl = "http://127.0.0.1:8317/management.html#/plugin-pages/auto-switcher-pro-linux-amd64/2#incident-cb_test123";
		const link = `\x1b]8;;${longUrl}\x1b\\Diagnóstico de Incidente en Panel Web\x1b]8;;\x1b\\`;

		// 1. Truncating when text with OSC 8 exceeds maxW
		const truncated = truncateWithAnsi(link, 15);
		assert.ok(visibleLen(truncated) <= 15);
		assert.match(truncated, /\x1b\]8;;\x1b\\/);

		// 2. Preserves OSC 8 when it fits within maxW
		const fits = truncateWithAnsi(link, 50);
		assert.strictEqual(visibleLen(fits), visibleLen(link));
		assert.ok(fits.includes(longUrl));

		// 3. Line with label + OSC 8 fits strictly inside safeW = 48 columns
		const line = `│ Diagnóstico: ${link} │`;
		const fitted = truncateWithAnsi(line, 48);
		assert.ok(visibleLen(fitted) <= 48);
	});

	it("handles malformed pair with missing active account safely without throwing", () => {
		const malformedPair: any = {
			poolKey: "Pool-01-gemini",
			familyName: "Gemini Fleet",
			familyIcon: "✨",
			totalAccounts: 1,
			active: null,
			next: null,
		};
		const footer = formatFooterRotationBlock(malformedPair, false);
		assert.equal(footer, "");

		const lines = formatSidebarQuotaCardLines(malformedPair, 48);
		assert.ok(lines.length > 0);
		const text = lines.map((l: string) => stripAnsi(l)).join("\n");
		assert.match(text, /Sin cuentas con rotación activa/);
	});

	it("guards sidebar widget render and digest against invalidated context and null pairs", () => {
		let throwOnAccess = true;
		const mockContext: any = {
			get model() {
				if (throwOnAccess) {
					throw new Error("ExtensionContext is invalidated");
				}
				return { id: "gemini-3.8-flash-high", provider: "cpamc" };
			},
		};

		const adapter = new CpamcTuiAdapter(mockContext);
		const parts = new Map<string, any>();
		const gentleState = { parts };

		// Invalidate and inject
		(adapter as any).injectIntoSidebar(gentleState);

		const quotaWidget = parts.get("cpamc-quota-card");
		assert.ok(quotaWidget, "quota widget must be registered under cpamc-quota-card");
		assert.ok(parts.get("quota"), "quota widget must also be registered under quota");

		// Even when accessing model throws an error, render and digest MUST return safely without throwing
		const renderedLines = quotaWidget.render();
		assert.ok(Array.isArray(renderedLines));

		const digestStr = quotaWidget.digest();
		assert.equal(typeof digestStr, "string");
		assert.ok(digestStr.includes("none"));
	});

	it("resiliently hooks gentleState.parts.set so future footer overrides by Gentle-Shell are auto-decorated", () => {
		const mockContext: any = {
			model: { id: "Pool-01-gemini", provider: "cpamc" },
		};
		const adapter = new CpamcTuiAdapter(mockContext);
		(adapter as any).currentPair = mockPoolPair;

		const parts = new Map<string, any>();
		const gentleState = { parts };

		// 1. Initially Gentle-Shell has mounted its own footer rail
		const initialNativeFooter = {
			render: () => ["╭─ Status ─╮", "│ Session  │", "╰──────────╯"],
			digest: () => "status_123",
		};
		parts.set("footer", initialNativeFooter);

		// 2. Adapter injects into sidebar
		(adapter as any).injectIntoSidebar(gentleState);

		// Verified: footer was decorated
		const decorated1 = parts.get("footer");
		assert.ok(decorated1.__isCpamcDecorated, "footer must be decorated with CPAMC");
		const renderedLines1 = decorated1.render(48);
		const fullText1 = renderedLines1.join("\n");
		assert.match(fullText1, /Status/);
		assert.match(fullText1, /DISYUNTOR|CUIDANDO EL CHAT/);

		// 3. Gentle-Shell triggers an event (resize, git check, etc.) and overwrites footer with a new rail
		const reRegisteredFooter: any = {
			render: () => ["╭─ Status v2 ─╮", "│ Git: clean  │", "╰─────────────╯"],
			digest: () => "status_v2",
		};
		parts.set("footer", reRegisteredFooter);

		// Verified: The hook automatically re-wrapped the new footer on the fly!
		const decorated2 = parts.get("footer");
		assert.ok(decorated2.__isCpamcDecorated, "re-registered footer must be automatically re-wrapped");
		const renderedLines2 = decorated2.render(48);
		const fullText2 = renderedLines2.join("\n");
		assert.match(fullText2, /Status v2/);
		assert.match(fullText2, /DISYUNTOR|CUIDANDO EL CHAT/);

		// 4. Test cache invalidation and mouse toggle with strict click and hit-testing
		const cache = { revision: 1 };
		let requestedRender = false;
		let originalRailHandled = false;
		reRegisteredFooter.handleMouse = (evt: any) => {
			originalRailHandled = true;
			return { handled: true };
		};

		const mockTerminal: any = {
			[Symbol.for("gentle-pi.experimental-sidebar.cache")]: cache,
		};
		const mockTui = {
			terminal: mockTerminal,
			requestRender: () => { requestedRender = true; },
		};
		adapter.bindTui(mockTui);

		assert.equal(adapter.getAccordionMode(), "collapsed");

		// Test A: Evento 'press' es ignorado por completo (evita el parpadeo de doble disparo)
		const pressRes = decorated2.handleMouse({ type: "press", button: "left" });
		assert.equal(adapter.getAccordionMode(), "collapsed", "evento press NO debe cambiar el acordeón");

		// Test B: Click en la zona superior (Status Card, y = 1 < quotaStartY = 4) se delega a originalRail
		const statusClickRes = decorated2.handleMouse({ type: "click", button: "left", y: 1 });
		assert.equal(originalRailHandled, true, "click en Status Card debe delegarse al originalRail");
		assert.equal(adapter.getAccordionMode(), "collapsed", "click en Status Card no debe abrir la Quota Card");

		// Test C: Click en la zona intermedia (Quota Card, y = 6 >= quotaStartY = 4) abre el acordeón
		const quotaClickRes = decorated2.handleMouse({ type: "click", button: "left", y: 6 });
		assert.equal(quotaClickRes?.handled, true);
		assert.equal(adapter.getAccordionMode(), "pinned", "click en Quota Card debe alternar a pinned");
		assert.equal(cache.revision, 2, "sidebar cache revision must be incremented on mouse toggle");
		assert.equal(requestedRender, true, "requestRender must be called");

		// Test D (Límite Y inferior): Click por debajo de la Quota Card (y = 50 >= quotaEndY) se delega a originalRail
		originalRailHandled = false;
		const overflowYClick = decorated2.handleMouse({ type: "click", button: "left", y: 50 });
		assert.equal(originalRailHandled, true, "click por debajo de la Quota Card debe delegarse a originalRail");

		// Test E (Límite X lateral): Click fuera del ancho de la tarjeta (x = 60 >= width 48) se delega a originalRail
		originalRailHandled = false;
		const overflowXClick = decorated2.handleMouse({ type: "click", button: "left", x: 60, y: 6, width: 48 });
		assert.equal(originalRailHandled, true, "click fuera del ancho útil debe delegarse a originalRail");

		// Test F (Botones secundarios): Click derecho o rueda de ratón (button !== 'left') se delega sin alterar el acordeón
		originalRailHandled = false;
		adapter.setExpanded(false);
		const rightClickRes = decorated2.handleMouse({ type: "click", button: "right", y: 6 });
		assert.equal(originalRailHandled, true, "click derecho debe delegarse al rail nativo");
		assert.equal(adapter.getAccordionMode(), "collapsed", "click derecho no debe abrir el acordeón");

		// Test G: Click en la línea de Diagnóstico o /incident abre el Modal de Autopsia
		let modalOpened = false;
		adapter.onOpenIncidentModal = () => { modalOpened = true; };

		// Simular disyuntor activo en runawayGuard
		(runawayGuard as any).isTripped = true;
		(runawayGuard as any).tripReason = "PROHIBITED_COMMAND";
		(runawayGuard as any).lastTimestamp = Date.now();

		const trippedLines = formatSidebarQuotaCardLines(mockPoolPair, 48);
		const diagRelativeIdx = trippedLines.findIndex((l: string) => l.includes("Diagnóstico"));
		assert.ok(diagRelativeIdx !== -1, "línea de diagnóstico debe existir");

		// Click exactamente en la fila de diagnóstico
		const diagClickRes = decorated2.handleMouse({ type: "click", button: "left", y: 4 + diagRelativeIdx });
		assert.equal(diagClickRes?.handled, true);
		assert.equal(modalOpened, true, "click en fila de Diagnóstico debe invocar onOpenIncidentModal");

		runawayGuard.dismissIncident();
		adapter.destroy();
	});

	it("avoids duplicate rendering when Gentle-Shell already mounts cpamc-quota-card standalone", () => {
		const mockContext: any = {
			model: { id: "Pool-01-gemini", provider: "cpamc" },
		};
		const adapter = new CpamcTuiAdapter(mockContext);
		(adapter as any).currentPair = mockPoolPair;

		const parts = new Map<string, any>();
		const gentleState = { parts };

		const initialNativeFooter = {
			render: () => ["╭─ Status ─╮", "│ Session  │", "╰──────────╯"],
			digest: () => "status_123",
		};
		parts.set("footer", initialNativeFooter);

		// Inyectar en el sidebar
		(adapter as any).injectIntoSidebar(gentleState);

		const standaloneCard = parts.get("cpamc-quota-card");
		assert.ok(standaloneCard, "standalone card should be registered");

		// Caso A: Si standaloneCard se renderiza de forma autónoma
		const standaloneLines = standaloneCard.render(48);
		assert.match(standaloneLines.join("\n"), /DISYUNTOR|CUIDANDO EL CHAT|CENTINELA/);

		// Ahora el render() del footer decorado debe detectar que el standalone ya se dibujó y NO duplicar
		const decoratedFooter = parts.get("footer");
		const linesWithoutDuplication = decoratedFooter.render(48);
		assert.doesNotMatch(linesWithoutDuplication.join("\n"), /DISYUNTOR|CUIDANDO EL CHAT|CENTINELA/);
		assert.match(linesWithoutDuplication.join("\n"), /Status/);

		adapter.destroy();
	});

	it("satisfies Acceptance Criteria 1: 40% time elapsed and 25% consumed -> Ritmo holgado", () => {
		const dummyStyler: any = {
			easy: (t: string) => t,
			amber: (t: string) => t,
			error: (t: string) => t,
		};
		// total 300 mins (18000s), 40% elapsed means 60% remaining = 18000 * 0.6 = 10800s
		const pace = calculateQuotaPace("25%", 10800, 300, dummyStyler);
		assert.equal(pace.state, "easy");
		assert.match(pace.pillLabel, /Ritmo holgado/);
		assert.equal(pace.consumedPct, 25);
		assert.equal(pace.remainingPct, 75);
	});

	it("satisfies Acceptance Criteria 2: 30% time elapsed and 62% consumed -> Vas muy rápido", () => {
		const dummyStyler: any = {
			easy: (t: string) => t,
			amber: (t: string) => t,
			error: (t: string) => t,
		};
		// total 300 mins (18000s), 30% elapsed means 70% remaining = 18000 * 0.7 = 12600s
		const pace = calculateQuotaPace("62%", 12600, 300, dummyStyler);
		assert.equal(pace.state, "fast");
		assert.match(pace.pillLabel, /Vas muy rápido/);
		assert.equal(pace.consumedPct, 62);
		assert.equal(pace.remainingPct, 38);
	});

	it("satisfies Acceptance Criteria 3: 100% consumed before reset -> Cuota agotada", () => {
		const dummyStyler: any = {
			easy: (t: string) => t,
			amber: (t: string) => t,
			error: (t: string) => t,
		};
		const pace = calculateQuotaPace("100%", 7200, 300, dummyStyler);
		assert.equal(pace.state, "exhausted");
		assert.match(pace.pillLabel, /Cuota agotada/);
		assert.equal(pace.consumedPct, 100);
		assert.equal(pace.remainingPct, 0);
	});

	it("satisfies Acceptance Criteria 4: 5h 0m remaining and 0% consumed -> Ritmo holgado and clock empty", () => {
		const dummyStyler: any = {
			easy: (t: string) => t,
			amber: (t: string) => t,
			error: (t: string) => t,
		};
		const pace = calculateQuotaPace("0%", 18000, 300, dummyStyler);
		assert.equal(pace.state, "easy");
		assert.match(pace.pillLabel, /Ritmo holgado/);
		assert.equal(pace.consumedPct, 0);
		assert.equal(pace.remainingPct, 100);
		assert.equal(pace.remainingFormatted, "5h 0m");
	});

	it("satisfies Standalone Flat Quota: remainingSec=0 with low consumption shows Directa and no false 0m", () => {
		const dummyStyler: any = {
			easy: (t: string) => t,
			amber: (t: string) => t,
			error: (t: string) => t,
		};
		const pace = calculateQuotaPace("5%", 0, 300, dummyStyler);
		assert.equal(pace.state, "easy");
		assert.match(pace.pillLabel, /Ritmo holgado/);
		assert.equal(pace.consumedPct, 5);
		assert.equal(pace.remainingPct, 95);
		assert.equal(pace.remainingFormatted, "Directa");
		assert.equal(pace.timeElapsedPct, 0, "No debe marcar 100% transcurrido");
	});

	it("renders unified sidebar card for native standalone model collapsed by default with CUIDANDO EL CHAT and no rotations", () => {
		const lines = formatSidebarQuotaCardLines(mockNativePair, 48, undefined, undefined, false, undefined, undefined, false);
		const text = lines.map((l: string) => stripAnsi(l)).join("\n");
		assert.match(text, /⚡ CUENTA FIJA:/);
		assert.match(text, /\[○ Esperando\]/, "La cabecera no debe truncar el badge de estado vivo");
		assert.match(text, /Modo: Standalone/);
		assert.match(text, /Conex: Directa/, "El subtítulo no debe truncar Conex: Directa");
		assert.doesNotMatch(text, /Caché Afinidad/);
		assert.match(text, /5 HORAS/);
		assert.match(text, /SEMANAL/);
		assert.match(text, /\[CUIDANDO EL CHAT\]/);
		assert.match(text, /Turno en vivo:/);
		assert.match(text, /▶ \[Ver más: (Contexto y Sesión|Contexto de Sesión)\]/);
		assert.match(text, /Ctrl\+Alt\+X/);
		assert.doesNotMatch(text, /ROTACIONES & LIDERAZGO/);
		assert.doesNotMatch(text, /Candidato a Líder/);
		assert.doesNotMatch(text, /📦 CONTEXTO & COMPRESIÓN/);
		assert.doesNotMatch(text, /⚠️ CAUSAS DE ROTACIÓN/);
		lines.forEach((l: string, idx: number) => {
			const len = visibleLen(l);
			assert.strictEqual(len, 48, `Fila nativa colapsada ${idx} debe tener 48 columnas (actual: ${len})`);
		});
	});

	it("renders unified sidebar card for native standalone model in fatigue state showing Cuota baja instead of Limpiando", () => {
		const fatiguedNativePair: PoolRotationPair = {
			...mockNativePair,
			active: {
				...mockNativePair.active,
				minAvailable: "12%",
				consumed5h: "88/100",
			},
		};
		const lines = formatSidebarQuotaCardLines(fatiguedNativePair, 48, undefined, undefined, false, undefined, undefined, false);
		const text = lines.map((l: string) => stripAnsi(l)).join("\n");
		assert.match(text, /\[⚠️ Cuota baja\]/);
		assert.doesNotMatch(text, /\[⚡ Limpiando\]/);
	});

	it("renders unified sidebar card for native standalone model expanded with Context and quota reset time", () => {
		const nativeWithReset: PoolRotationPair = {
			...mockNativePair,
			active: {
				...mockNativePair.active,
				reset5hInSec: 7200, // 2h 0m
			},
		};
		const lines = formatSidebarQuotaCardLines(nativeWithReset, 48, undefined, undefined, false, undefined, undefined, true);
		const text = lines.map((l: string) => stripAnsi(l)).join("\n");
		assert.match(text, /⚡ CUENTA FIJA:/);
		assert.match(text, /\[CUIDANDO EL CHAT\]/);
		assert.match(text, /▼ \[Ocultar detalles/);
		assert.match(text, /TELEMETRÍA DE SESIÓN/, "Debe incluir bloque de telemetría de sesión homologado");
		assert.match(text, /ADVERTENCIA DE RESILIENCIA/, "Debe incluir diagnóstico de resiliencia sin pool");
		assert.match(text, /📦 CONTEXTO & COMPRESIÓN/);
		assert.match(text, /Reinicio 5h:\s+en 2h 0m/);
		assert.doesNotMatch(text, /ROTACIONES & LIDERAZGO/);
		assert.doesNotMatch(text, /Candidato a Líder/);
		assert.doesNotMatch(text, /⚠️ CAUSAS DE ROTACIÓN/);
		assert.doesNotMatch(text, /├[─]+┤\s*\n\s*├[─]+┤/, "No debe tener líneas divisorias dobles consecutivas");
		lines.forEach((l: string, idx: number) => {
			const len = visibleLen(l);
			assert.strictEqual(len, 48, `Fila nativa expandida ${idx} debe tener 48 columnas (actual: ${len})`);
		});
	});

	it("renders unified sidebar card collapsed by default ending after CUIDANDO EL CHAT with accordion row", () => {
		const lines = formatSidebarQuotaCardLines(mockPoolPair, 48, undefined, undefined, false, undefined, undefined, false);
		const text = lines.map((l: string) => stripAnsi(l)).join("\n");
		assert.match(text, /\[CUIDANDO EL CHAT\]/);
		assert.match(text, /▶ \[Ver más: (Detalles y Líderes|Contexto, Historial y Líderes)\]/);
		assert.match(text, /Ctrl\+Alt\+X/);
		assert.doesNotMatch(text, /📦 CONTEXTO & COMPRESIÓN/);
		assert.doesNotMatch(text, /⚠️ CAUSAS DE ROTACIÓN/);
		assert.doesNotMatch(text, /🔄 ROTACIONES & LIDERAZGO/);
		assert.match(text, /Estado actual:/);
		lines.forEach((l: string, idx: number) => {
			const len = visibleLen(l);
			assert.strictEqual(len, 48, `Fila colapsada ${idx} debe tener 48 columnas (actual: ${len})`);
		});
	});

	it("renders unified sidebar card fully expanded when isExpanded is true", () => {
		const lines = formatSidebarQuotaCardLines(mockPoolPair, 48, undefined, undefined, false, undefined, undefined, true);
		const text = lines.map((l: string) => stripAnsi(l)).join("\n");
		assert.match(text, /\[CUIDANDO EL CHAT\]/);
		assert.match(text, /▼ \[Ocultar detalles extendidos\]/);
		assert.match(text, /🔄 ROTACIONES & LIDERAZGO/);
		assert.match(text, /Rescate Red:\s+0\/2/);
		assert.match(text, /Subagentes:\s+0\/2/);
		assert.match(text, /Sesión:\s+Protegida/);
		assert.match(text, /Ahorro:\s+0 tk/);
		assert.match(text, /Bucles:\s+0 detectados/);
		assert.match(text, /Bash:\s+0\/5 llamadas/);
		assert.match(text, /📦 CONTEXTO & COMPRESIÓN/);
		assert.match(text, /⚠️ CAUSAS DE ROTACIÓN/);
		assert.match(text, /Estado actual:/);
		lines.forEach((l: string, idx: number) => {
			const len = visibleLen(l);
			assert.strictEqual(len, 48, `Fila expandida ${idx} debe tener 48 columnas (actual: ${len})`);
		});
	});

	it("renders unified sidebar card perfectly aligned to 48 columns matching reference screenshot", () => {
		const lines = formatSidebarQuotaCardLines(mockPoolPair, 48);
		assert.strictEqual(lines.length >= 18, true);
		lines.forEach((l: string, idx: number) => {
			const len = visibleLen(l);
			assert.strictEqual(len, 48, `Fila ${idx} debe tener exactamente 48 caracteres visibles (actual: ${len}): "${stripAnsi(l)}"`);
		});
	});

	it("renders unified sidebar card perfectly aligned to 38 columns with symmetrical borders", () => {
		const lines = formatSidebarQuotaCardLines(mockPoolPair, 38);
		assert.strictEqual(lines.length >= 18, true);
		lines.forEach((l: string, idx: number) => {
			const len = visibleLen(l);
			assert.strictEqual(len, 38, `Fila ${idx} debe tener exactamente 38 caracteres visibles (actual: ${len}): "${stripAnsi(l)}"`);
		});
	});

	describe("Accordion 3-Mode State Machine (Peek / Pin / Auto-Collapse)", () => {
		beforeEach(() => {
			setSessionAccordionState(false);
		});

		it("Test 1: Manual toggle transitions COLLAPSED -> PINNED -> COLLAPSED", () => {
			const adapter = new CpamcTuiAdapter(null);
			assert.equal(adapter.getAccordionMode(), "collapsed");
			assert.equal(adapter.isCardExpanded(), false);

			// First toggle: user manually opens -> PINNED
			const mode1 = adapter.toggleExpanded();
			assert.equal(mode1, "pinned");
			assert.equal(adapter.getAccordionMode(), "pinned");
			assert.equal(adapter.isCardExpanded(), true);

			// Second toggle: user closes -> COLLAPSED
			const mode2 = adapter.toggleExpanded();
			assert.equal(mode2, "collapsed");
			assert.equal(adapter.getAccordionMode(), "collapsed");
			assert.equal(adapter.isCardExpanded(), false);

			adapter.destroy();
		});

		it("Test 2: Triggering peek from COLLAPSED opens PEEK mode with 20s countdown", () => {
			const adapter = new CpamcTuiAdapter(null);
			adapter.triggerPeek(20);

			assert.equal(adapter.getAccordionMode(), "peek");
			assert.equal(adapter.isCardExpanded(), true);
			assert.equal(adapter.getPeekRemainingSeconds(), 20);

			adapter.destroy();
		});

		it("Test 3: Triggering peek again while already in PEEK resets countdown to 20s", () => {
			const adapter = new CpamcTuiAdapter(null);
			adapter.triggerPeek(20);
			// Simulate 5 seconds elapsed
			(adapter as any).peekRemainingSec = 15;
			assert.equal(adapter.getPeekRemainingSeconds(), 15);

			// Trigger new event
			adapter.triggerPeek(20);
			assert.equal(adapter.getAccordionMode(), "peek");
			assert.equal(adapter.getPeekRemainingSeconds(), 20);

			adapter.destroy();
		});

		it("Test 4: Expiration of countdown auto-collapses PEEK to COLLAPSED", () => {
			const adapter = new CpamcTuiAdapter(null);
			adapter.triggerPeek(2);
			assert.equal(adapter.getAccordionMode(), "peek");

			// Simulate timer ticks
			(adapter as any).tickPeek();
			assert.equal(adapter.getPeekRemainingSeconds(), 1);
			assert.equal(adapter.getAccordionMode(), "peek");

			(adapter as any).tickPeek();
			assert.equal(adapter.getPeekRemainingSeconds(), 0);
			assert.equal(adapter.getAccordionMode(), "collapsed");
			assert.equal(adapter.isCardExpanded(), false);

			adapter.destroy();
		});

		it("Test 5: Manual toggle / shortcut during PEEK freezes and pins to PINNED mode (cancels timer)", () => {
			const adapter = new CpamcTuiAdapter(null);
			adapter.triggerPeek(20);
			assert.equal(adapter.getAccordionMode(), "peek");

			// User hits Ctrl+Alt+X or clicks to freeze/pin
			const mode = adapter.toggleExpanded();
			assert.equal(mode, "pinned");
			assert.equal(adapter.getAccordionMode(), "pinned");
			assert.equal(adapter.isCardExpanded(), true);

			// Further ticks do not collapse because mode is pinned
			(adapter as any).tickPeek?.();
			assert.equal(adapter.getAccordionMode(), "pinned");
			assert.equal(adapter.isCardExpanded(), true);

			adapter.destroy();
		});

		it("Test 6: turn_start auto-collapses PEEK but preserves PINNED", () => {
			const adapter = new CpamcTuiAdapter(null);

			// Case A: in PEEK mode -> turn_start collapses it
			adapter.triggerPeek(20);
			assert.equal(adapter.getAccordionMode(), "peek");
			adapter.onTurnStart();
			assert.equal(adapter.getAccordionMode(), "collapsed");
			assert.equal(adapter.isCardExpanded(), false);

			// Case B: in PINNED mode -> turn_start keeps it PINNED
			adapter.toggleExpanded(); // -> pinned
			assert.equal(adapter.getAccordionMode(), "pinned");
			adapter.onTurnStart();
			assert.equal(adapter.getAccordionMode(), "pinned");
			assert.equal(adapter.isCardExpanded(), true);

			adapter.destroy();
		});

		it("Test 7: Renders badges and strict 48-column alignment for COLLAPSED, PEEK, and PINNED", () => {
			// COLLAPSED
			const linesCollapsed = formatSidebarQuotaCardLines(mockPoolPair, 48, undefined, undefined, false, undefined, undefined, "collapsed");
			const textCollapsed = linesCollapsed.map((l: string) => stripAnsi(l)).join("\n");
			assert.match(textCollapsed, /▶ \[Ver más: (Detalles y Líderes|Contexto, Historial y Líderes)\]/);
			linesCollapsed.forEach((l: string, idx: number) => {
				assert.strictEqual(visibleLen(l), 48, `Collapsed line ${idx} must be 48 cols`);
			});

			// PEEK (20s)
			const linesPeek20 = formatSidebarQuotaCardLines(mockPoolPair, 48, undefined, undefined, false, undefined, undefined, "peek", 20);
			const textPeek20 = linesPeek20.map((l: string) => stripAnsi(l)).join("\n");
			assert.match(textPeek20, /▼ \[Ocultar detalles\] · Cierra en 20s/);
			assert.match(textPeek20, /📦 CONTEXTO & COMPRESIÓN/);
			linesPeek20.forEach((l: string, idx: number) => {
				assert.strictEqual(visibleLen(l), 48, `Peek20 line ${idx} must be 48 cols`);
			});

			// PEEK (8s - single digit test for width padding consistency)
			const linesPeek8 = formatSidebarQuotaCardLines(mockPoolPair, 48, undefined, undefined, false, undefined, undefined, "peek", 8);
			const textPeek8 = linesPeek8.map((l: string) => stripAnsi(l)).join("\n");
			assert.match(textPeek8, /▼ \[Ocultar detalles\] · Cierra en 8s/);
			linesPeek8.forEach((l: string, idx: number) => {
				assert.strictEqual(visibleLen(l), 48, `Peek8 line ${idx} must be 48 cols`);
			});

			// PINNED
			const linesPinned = formatSidebarQuotaCardLines(mockPoolPair, 48, undefined, undefined, false, undefined, undefined, "pinned");
			const textPinned = linesPinned.map((l: string) => stripAnsi(l)).join("\n");
			assert.match(textPinned, /▼ \[Ocultar detalles extendidos\] · Fijo/);
			linesPinned.forEach((l: string, idx: number) => {
				assert.strictEqual(visibleLen(l), 48, `Pinned line ${idx} must be 48 cols`);
			});
		});

		it("Test 8: Native standalone model renders appropriate labels across modes", () => {
			const linesNativePeek = formatSidebarQuotaCardLines(mockNativePair, 48, undefined, undefined, false, undefined, undefined, "peek", 18);
			const text = linesNativePeek.map((l: string) => stripAnsi(l)).join("\n");
			assert.match(text, /▼ \[Ocultar detalles\] · Cierra en 18s/);
			linesNativePeek.forEach((l: string, idx: number) => {
				assert.strictEqual(visibleLen(l), 48, `Native peek line ${idx} must be 48 cols`);
			});
		});

		it("Test 9: Renders honest empty state for pool with no recent rotations (no fabricated data)", () => {
			const lines = formatSidebarQuotaCardLines(mockPoolPair, 48, undefined, undefined, false, undefined, undefined, "pinned");
			const text = lines.map((l: string) => stripAnsi(l)).join("\n");
			assert.match(text, /⚠️ CAUSAS DE ROTACIÓN \(ÚLTIMAS 24H\)/);
			assert.match(text, /Líder firme/);
			assert.match(text, /Sin rotaciones recientes/);
			assert.doesNotMatch(text, /mar\.\.\.tro/);
			lines.forEach((l: string, idx: number) => {
				assert.strictEqual(visibleLen(l), 48, `Pinned line ${idx} must be 48 cols`);
			});
		});
	});

	describe("Bimodal QuotaCard & Blessed-Contrib Visual Tabs", () => {
		beforeEach(() => {
			clearTelemetryHistoriesForTest();
		});

		it("1. renders Unicode sparklines accurately based on numeric values", () => {
			const emptySparkline = renderUnicodeSparkline([]);
			assert.strictEqual(emptySparkline.trim(), "");

			const risingValues = [10, 20, 30, 40, 50, 60, 70, 80];
			const sparkline = renderUnicodeSparkline(risingValues);
			assert.strictEqual(sparkline.length, 8);
			// El primer nivel debe ser menor que el último nivel
			assert.strictEqual(sparkline[0], " ");
			assert.strictEqual(sparkline[sparkline.length - 1], "█");
		});

		it("2. renders Braille circular donut dials with 4 symmetric lines", () => {
			const s = {
				error: (t: string) => t,
				warning: (t: string) => t,
				accentCyan: (t: string) => t,
				accentPurple: (t: string) => t,
			} as any;
			const donut = renderBrailleDonut(85, 65, s);
			assert.strictEqual(donut.length, 4);
			assert.ok(donut[0]!.includes("⢀⣤"));
			assert.ok(donut[3]!.includes("⠿⠟"));
		});

		it("3. renders TabBar with hitboxes matching exact character bounds", () => {
			const s = {
				accentCyan: (t: string) => t,
				boldWhite: (t: string) => t,
				muted: (t: string) => t,
			} as any;
			const { line, hitboxes } = renderQuotaCardTabBar(44, "quota", s);
			assert.strictEqual(hitboxes.length, 4);
			assert.strictEqual(hitboxes[0]!.id, "quota");
			assert.strictEqual(hitboxes[1]!.id, "metrics");
			assert.strictEqual(hitboxes[2]!.id, "pool");
			assert.strictEqual(hitboxes[3]!.id, "radar");
			assert.ok(hitboxes[0]!.startX < hitboxes[0]!.endX);
			assert.ok(hitboxes[1]!.startX >= hitboxes[0]!.endX);
		});

		it("4. preserves 100% Essential mode behavior by default aligned to 48 columns", () => {
			setQuotaCardViewMode("essential");
			assert.strictEqual(getQuotaCardViewMode(), "essential");

			const lines = formatSidebarQuotaCardLines(mockPoolPair, 48);
			lines.forEach((l: string, idx: number) => {
				assert.strictEqual(visibleLen(l), 48, `Essential line ${idx} must be 48 cols`);
			});
			const text = lines.map(stripAnsi).join("\n");
			assert.ok(text.includes("CUIDANDO EL CHAT"));
			assert.ok(text.includes("5 HORAS"));
		});

		it("5. renders all 4 tabs in Pro Blessed mode with strict 48-column alignment", () => {
			setQuotaCardViewMode("tabs");

			// Tab 1: CUOTA
			setActiveQuotaCardTab("quota");
			const quotaLines = formatSidebarQuotaCardLines(mockPoolPair, 48);
			quotaLines.forEach((l: string, idx: number) => {
				assert.strictEqual(visibleLen(l), 48, `Tab 1 line ${idx} must be 48 cols`);
			});
			const quotaText = quotaLines.map(stripAnsi).join("\n");
			assert.ok(quotaText.includes("[1 CUOTA]"));
			assert.ok(quotaText.includes("5H:"));

			// Tab 2: MÉTRICAS
			recordTurnTelemetry({ turnId: "t1", tokens: 42000, durationMs: 1100, toolsCount: 2 });
			setActiveQuotaCardTab("metrics");
			const metricsLines = formatSidebarQuotaCardLines(mockPoolPair, 48);
			metricsLines.forEach((l: string, idx: number) => {
				assert.strictEqual(visibleLen(l), 48, `Tab 2 line ${idx} must be 48 cols`);
			});
			const metricsText = metricsLines.map(stripAnsi).join("\n");
			assert.ok(metricsText.includes("[2 MÉTRICAS]"));
			assert.ok(metricsText.includes("Sparkline:"));

			// Tab 3: POOL
			setActiveQuotaCardTab("pool");
			const poolLines = formatSidebarQuotaCardLines(mockPoolPair, 48);
			poolLines.forEach((l: string, idx: number) => {
				assert.strictEqual(visibleLen(l), 48, `Tab 3 line ${idx} must be 48 cols`);
			});
			const poolText = poolLines.map(stripAnsi).join("\n");
			assert.ok(poolText.includes("[3 POOL]"));
			assert.ok(poolText.includes("FLOTA POOL"));

			// Tab 4: RADAR
			recordTelemetryEvent({ type: "rotation", source: "test", message: "Rotación preventiva exitosa" });
			setActiveQuotaCardTab("radar");
			const radarLines = formatSidebarQuotaCardLines(mockPoolPair, 48);
			radarLines.forEach((l: string, idx: number) => {
				assert.strictEqual(visibleLen(l), 48, `Tab 4 line ${idx} must be 48 cols`);
			});
			const radarText = radarLines.map(stripAnsi).join("\n");
			assert.ok(radarText.includes("[4 RADAR]"));
			assert.ok(radarText.includes("RADAR DE EVENTOS"));
		});

		it("6. triggers Smart Peeking auto-switching to Radar on critical incidents", () => {
			setQuotaCardViewMode("tabs");
			setActiveQuotaCardTab("quota");
			assert.strictEqual(getActiveQuotaCardTab(), "quota");

			// Disparar incidente mitigado
			recordTelemetryEvent({
				type: "incident_mitigated",
				source: "auto-switcher",
				message: "HTTP 429 mitigado en 85ms",
			});

			// Smart peeking activo: debe resolver temporalmente hacia 'radar'
			assert.strictEqual(getActiveQuotaCardTab(), "radar");

			// Al seleccionar manualmente otra pestaña, el Smart Peeking se desactiva
			setActiveQuotaCardTab("metrics");
			assert.strictEqual(getActiveQuotaCardTab(), "metrics");

			// Restaurar modo por defecto para no contaminar tests subsecuentes
			setQuotaCardViewMode("essential");
			setActiveQuotaCardTab("quota");
		});
	});
});
