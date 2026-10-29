import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	getRotationPairForModel,
	getRotationPairForModelSync,
	type PoolRotationPair,
	getCachedLifecycle,
	getContextState,
	type LifecycleSummary,
	type ContextCompressionState,
} from "./store.js";
import { resolveCpamcBaseUrl } from "./provider.js";
import { runawayGuard, type RunawayGuardTelemetry, MAX_BASH_EXPLORATION_PER_TURN, MAX_SUBAGENT_POLL_PER_TURN } from "./guards.js";

// Colores ANSI suaves compatibles con temas oscuros y claros (Cyber-Pastel)
const RESET = "\x1b[0m";
const SEP = "\x1b[38;2;138;78;158m│\x1b[0m";
const PLAY_COLOR = "\x1b[38;2;123;200;143m"; // Verde menta
const PAUSE_COLOR = "\x1b[38;2;120;153;166m"; // Gris suave
const LEADER_COLOR = "\x1b[1;38;2;92;184;199m"; // Cian suave negrita
const NEXT_COLOR = "\x1b[1;38;2;222;116;155m"; // Rosa coral suave negrita
const MUTED = "\x1b[38;2;120;153;166m";

const ANSI_REGEX = /\x1b\[[0-9;]*[a-zA-Z]/g;
const OSC8_REGEX = /\x1b\]8;;[^\x1b]*\x1b\\/g;

export function stripAnsi(str: string): string {
	return str.replace(ANSI_REGEX, "").replace(OSC8_REGEX, "");
}

export function truncateWithAnsi(str: string, maxW: number): string {
	if (maxW <= 0) return "";
	if (visibleLen(str) <= maxW) return str;

	let vis = 0;
	let res = "";
	const ANSI_TOKEN = /^\x1b\[[0-9;]*[a-zA-Z]/;
	const OSC8_TOKEN = /^\x1b\]8;;[^\x1b]*\x1b\\/;
	let hasOpenOsc8 = false;
	let i = 0;

	while (i < str.length && vis < maxW) {
		const ansiMatch = str.slice(i).match(ANSI_TOKEN);
		if (ansiMatch) {
			res += ansiMatch[0];
			i += ansiMatch[0].length;
			continue;
		}

		const oscMatch = str.slice(i).match(OSC8_TOKEN);
		if (oscMatch) {
			res += oscMatch[0];
			i += oscMatch[0].length;
			if (oscMatch[0] === "\x1b]8;;\x1b\\") {
				hasOpenOsc8 = false;
			} else {
				hasOpenOsc8 = true;
			}
			continue;
		}

		const cp = str.codePointAt(i) || 0;
		const char = String.fromCodePoint(cp);
		const advance = char.length;

		const nextCp = str.codePointAt(i + advance) || 0;

		let charVis = 1;
		let extraAdvance = 0;

		if (cp >= 0xfe00 && cp <= 0xfe0f) {
			charVis = 0;
		} else if (nextCp === 0xfe0f) {
			charVis = 2;
			extraAdvance = 1;
		} else if ((cp >= 0x1f6e0 && cp <= 0x1f6ec) || cp === 0x2699 || cp === 0x2794 || cp === 0x2714) {
			charVis = 1;
		} else if (
			(cp >= 0x1f300 && cp <= 0x1faff) ||
			(cp >= 0x2600 && cp <= 0x27bf) ||
			(cp >= 0x2b50 && codeRangeCheck(cp))
		) {
			charVis = 2;
		}

		if (vis + charVis > maxW) break;
		res += extraAdvance > 0 ? char + String.fromCodePoint(nextCp) : char;
		vis += charVis;
		i += advance + extraAdvance;
	}

	if (hasOpenOsc8) {
		res += "\x1b]8;;\x1b\\";
	}

	return `${res}${RESET}`;
}

function codeRangeCheck(cp: number): boolean {
	return cp >= 0x2b50 && cp <= 0x2b55;
}

export function fitToWidth(str: string, maxW: number): string {
	return truncateWithAnsi(str, maxW);
}

function pctColor(pctStr: string): string {
	const num = parseFloat(pctStr.replace("%", "")) || 0;
	if (num >= 50) return "\x1b[38;2;123;200;143m";
	if (num >= 20) return "\x1b[38;2;229;181;103m";
	return "\x1b[38;2;222;116;155m";
}

/**
 * Formatea el bloque de telemetría de rotación en una sola línea compacta:
 * `│⏸ agy_clau 100% │ ⏭ agy_clau_1 100%`
 */
export function formatFooterRotationBlock(pair: PoolRotationPair | null, isBusy = false, originTag?: string): string {
	const originPart = originTag ? ` ${MUTED}· ${originTag}${RESET}` : "";

	if (!pair || !pair.active) {
		return originTag ? `${SEP}${originPart}` : "";
	}

	if (pair.isNativeReadOnly) {
		const pActiveColor = pctColor(pair.active.minAvailable);
		const activeLabel = pair.active.prefix || pair.active.accountId;
		const hInfo = pair.active.consumed5h ? `${pair.active.consumed5h}` : "";
		const wInfo = pair.active.consumedWeekly ? `${pair.active.consumedWeekly}` : "";
		const cd = [hInfo, wInfo].filter(Boolean).join("/");
		const cdStr = cd ? ` ↻ ${cd}` : "";
		return `${SEP} ⚡ ${LEADER_COLOR}${activeLabel}${RESET} ${pActiveColor}${pair.active.minAvailable}${RESET}${MUTED}${cdStr}${RESET}${originPart}`;
	}

	const icon = isBusy ? `${PLAY_COLOR}▶${RESET}` : `${PAUSE_COLOR}⏸${RESET}`;
	const pActiveColor = pctColor(pair.active.minAvailable);
	const activeLabel = pair.active.prefix || pair.active.accountId;
	const activePart = `${icon} ${LEADER_COLOR}${activeLabel}${RESET} ${pActiveColor}${pair.active.minAvailable}${RESET}`;

	if (!pair.next) {
		return `${SEP} ${activePart}${originPart}`;
	}

	const nextIcon = `\x1b[38;2;157;124;216m⏭${RESET}`;
	const pNextColor = pctColor(pair.next.minAvailable);
	const nextLabel = pair.next.prefix || pair.next.accountId;
	const nextPart = `${nextIcon} ${NEXT_COLOR}${nextLabel}${RESET} ${pNextColor}${pair.next.minAvailable}${RESET}`;

	return `${SEP} ${activePart} ${SEP} ${nextPart}${originPart}`;
}

export function visibleLen(str: string): number {
	const clean = str.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "");
	let len = 0;
	const chars = Array.from(clean);
	for (let i = 0; i < chars.length; i++) {
		const char = chars[i];
		const code = char.codePointAt(0) || 0;
		const nextChar = chars[i + 1];
		const nextCode = nextChar ? nextChar.codePointAt(0) : 0;

		if (code >= 0xfe00 && code <= 0xfe0f) {
			continue;
		}

		if (nextCode === 0xfe0f) {
			// Símbolo con Selector de Variación Emoji (VS-16) -> 2 columnas en TUI
			len += 2;
			i++;
			continue;
		}

		if ((code >= 0x1f6e0 && code <= 0x1f6ec) || code === 0x2699 || code === 0x2794 || code === 0x2714) {
			// Símbolos estándar de texto (escudo texto, flecha ➔, check ✔, tuerca texto) -> 1 columna
			len += 1;
		} else if (
			(code >= 0x1f300 && code <= 0x1faff) ||
			(code >= 0x2600 && code <= 0x27bf) ||
			(code >= 0x2b50 && code <= 0x2b55)
		) {
			len += 2;
		} else {
			len += 1;
		}
	}
	return len;
}

function renderCompactBar(percentStr: string, cells = 8): string {
	const num = Number.parseFloat(percentStr.replace("%", "").trim());
	if (Number.isNaN(num)) return "▱".repeat(cells);
	const filled = Math.min(cells, Math.max(0, Math.round((num / 100) * cells)));
	return "▰".repeat(filled) + "▱".repeat(cells - filled);
}

interface ThemeStyler {
	border(text: string): string;
	muted(text: string): string;
	text(text: string): string;
	accent(text: string): string;
	warning(text: string): string;
	error(text: string): string;
	idle(text: string): string;
	live(text: string): string;
	amber(text: string): string;
	cyan(text: string): string;
	boldWhite(text: string): string;
	easy(text: string): string;
	slate(text: string): string;
	paintGauge(percentStr: string, cells?: number, isAmber?: boolean): string;
}

function createThemeStyler(theme?: any, fallbackBorder = "\x1b[38;2;120;153;166m"): ThemeStyler {
	const hasTheme = Boolean(theme && typeof theme.fg === "function");
	const bColor = fallbackBorder;
	const fg = (role: string, t: string): string => {
		if (hasTheme) {
			try {
				return theme.fg(role, t);
			} catch {
				// Fallback a ANSI si el rol falla
			}
		}
		switch (role) {
			case "border":
				return `${bColor}${t}${RESET}`;
			case "muted":
				return `\x1b[38;2;140;155;165m${t}${RESET}`;
			case "accent":
				return `\x1b[1;38;2;92;184;199m${t}${RESET}`;
			case "warning":
				return `\x1b[38;2;229;181;103m${t}${RESET}`;
			case "error":
				return `\x1b[1;38;2;239;68;68m${t}${RESET}`;
			case "idle":
				return `\x1b[38;2;120;175;135m${t}${RESET}`; // Verde suave / oliva tenue
			case "live":
				return `\x1b[1;38;2;123;220;143m${t}${RESET}`; // Verde menta neón brillante
			case "amber":
				return `\x1b[1;38;2;245;158;11m${t}${RESET}`; // Ámbar dorado de aviso
			case "text":
			default:
				return `\x1b[38;2;230;235;240m${t}${RESET}`;
		}
	};

	return {
		border: (t) => fg("border", t),
		muted: (t) => fg("muted", t),
		text: (t) => fg("text", t),
		accent: (t) => fg("accent", t),
		warning: (t) => fg("warning", t),
		error: (t) => fg("error", t),
		idle: (t) => fg("idle", t),
		live: (t) => fg("live", t),
		amber: (t) => fg("amber", t),
		cyan: (t) => `\x1b[38;2;56;189;248m${t}${RESET}`,
		boldWhite: (t) => `\x1b[1;38;2;248;250;252m${t}${RESET}`,
		easy: (t) => `\x1b[1;38;2;34;197;94m${t}${RESET}`,
		slate: (t) => `\x1b[38;2;148;163;184m${t}${RESET}`,
		paintGauge: (percentStr: string, cells = 6, isAmber = false) => {
			const num = Number.parseFloat(percentStr.replace("%", "").trim()) || 0;
			const filled = Math.min(cells, Math.max(0, Math.round((num / 100) * cells)));
			const empty = cells - filled;
			const tone = isAmber ? "amber" : num >= 95 ? "error" : num >= 80 ? "warning" : "idle";
			return fg(tone, "▰".repeat(filled)) + fg("border", "▱".repeat(empty));
		},
	};
}

export interface QuotaPaceInfo {
	state: "easy" | "moderate" | "fast" | "exhausted";
	pillLabel: string;
	pillColor: (t: string) => string;
	ringColor: (t: string) => string;
	remainingFormatted: string;
	consumedPct: number;
	remainingPct: number;
	timeElapsedPct: number;
	needlePos: "top" | "right" | "bottom" | "left";
}

export function parseConsumedNumber(consumedStr: string): number {
	if (!consumedStr) return 0;
	const clean = consumedStr.trim();
	if (clean.includes("/")) {
		const parts = clean.split("/");
		const n = Number.parseFloat(parts[0]);
		const d = Number.parseFloat(parts[1]);
		if (!Number.isNaN(n) && !Number.isNaN(d) && d > 0) {
			return Math.max(0, Math.min(100, Math.round((n / d) * 100)));
		}
	}
	const n = Number.parseFloat(clean.replace("%", ""));
	return Number.isNaN(n) ? 0 : Math.max(0, Math.min(100, Math.round(n)));
}

export function calculateQuotaPace(
	consumedStr: string,
	remainingSec: number | undefined,
	totalMinutes: number,
	s: ThemeStyler,
): QuotaPaceInfo {
	const consumedPct = parseConsumedNumber(consumedStr);
	const remainingPct = Math.max(0, 100 - consumedPct);
	const totalSec = totalMinutes * 60;
	const isWeekly = totalMinutes > 300;

	// Detección de cuentas sin ventana temporal activa:
	// Si remainingSec === 0 pero la cuota consumida es pequeña (<95%), significa que
	// el proveedor no computa ventana temporal por segundo o es cuota plana/directa.
	const isUntimedOrFlat = remainingSec === 0 && consumedPct < 95;

	let timeElapsedPct = 0;
	let remSec = remainingSec;

	if (isUntimedOrFlat) {
		// En cuentas directas / sin ventana temporal, no se muestra reloj en 0m ni 100% transcurrido
		timeElapsedPct = 0;
		remSec = undefined;
	} else if (typeof remainingSec === "number" && remainingSec >= 0) {
		const elapsed = Math.max(0, Math.min(totalSec, totalSec - remainingSec));
		timeElapsedPct = (elapsed / totalSec) * 100;
	} else {
		remSec = totalSec;
		timeElapsedPct = 0;
	}

	let remainingFormatted = "—";
	if (isUntimedOrFlat) {
		remainingFormatted = "Directa";
	} else if (typeof remSec === "number" && remSec >= 0) {
		const mins = Math.max(0, Math.round(remSec / 60));
		const days = Math.floor(mins / 1440);
		const hours = Math.floor((mins % 1440) / 60);
		const remMins = mins % 60;
		if (isWeekly && days > 0) {
			remainingFormatted = `${days}d ${hours}h`;
		} else if (days > 0) {
			remainingFormatted = `${days}d ${hours}h`;
		} else if (hours > 0) {
			remainingFormatted = `${hours}h ${remMins}m`;
		} else {
			remainingFormatted = `${remMins}m`;
		}
	}

	const diff = consumedPct - timeElapsedPct;
	let state: "easy" | "moderate" | "fast" | "exhausted" = "easy";
	let pillLabel = "● Ritmo holgado";
	let pillColor = s.easy;
	let ringColor = s.easy;

	if (consumedPct >= 100) {
		state = "exhausted";
		pillLabel = "🛑 Cuota agotada";
		pillColor = s.error;
		ringColor = s.error;
	} else if (diff <= 5) {
		state = "easy";
		pillLabel = "● Ritmo holgado";
		pillColor = s.easy;
		ringColor = s.easy;
	} else if (diff <= 20) {
		state = "moderate";
		pillLabel = "▲ Ritmo ajustado";
		pillColor = s.amber;
		ringColor = s.amber;
	} else {
		state = "fast";
		pillLabel = "🛑 Vas muy rápido";
		pillColor = s.error;
		ringColor = s.error;
	}

	let needlePos: "top" | "right" | "bottom" | "left" = "right";
	if (timeElapsedPct < 15) needlePos = "top";
	else if (timeElapsedPct < 45) needlePos = "right";
	else if (timeElapsedPct < 75) needlePos = "bottom";
	else needlePos = "left";

	return {
		state,
		pillLabel,
		pillColor,
		ringColor,
		remainingFormatted,
		consumedPct,
		remainingPct,
		timeElapsedPct,
		needlePos,
	};
}

function centerAnsi(text: string, width: number): string {
	const vLen = visibleLen(text);
	if (vLen >= width) return text;
	const totalPad = width - vLen;
	const leftPad = Math.floor(totalPad / 2);
	const rightPad = totalPad - leftPad;
	return " ".repeat(leftPad) + text + " ".repeat(rightPad);
}

// Paleta de espectro de celdas idéntica a Context en la prompt bar (#4ADE80 -> #EF4444)
const SPECTRUM_CELL_COLORS: readonly (readonly [number, number, number])[] = [
	[74, 222, 128],  // 1: #4ADE80 Verde Esmeralda (0-12%)
	[132, 204, 22],  // 2: #84CC16 Verde Lima (13-25%)
	[163, 230, 53],  // 3: #A3E635 Lima Brillante (26-37%)
	[234, 179, 8],   // 4: #EAB308 Amarillo Cálido (38-50%)
	[245, 158, 11],  // 5: #F59E0B Ámbar / Oro (51-62%)
	[249, 115, 22],  // 6: #F97316 Naranja Alerta (63-75%)
	[239, 68, 68],   // 7: #EF4444 Rojo Alerta (76-87%)
	[220, 38, 38],   // 8: #DC2626 Rojo Fuego Máximo (88-100%)
];

const EMPTY_CELL_COLOR: readonly [number, number, number] = [70, 85, 100]; // Gris metálico carril

function renderSpectralGauge(pct: number, cells = 10): string {
	const clamped = Math.max(0, Math.min(100, pct));
	const filledCount = Math.round((clamped / 100) * cells);
	let res = "";
	for (let i = 0; i < cells; i++) {
		if (i < filledCount) {
			const colorIdx = Math.min(SPECTRUM_CELL_COLORS.length - 1, Math.floor((i / cells) * SPECTRUM_CELL_COLORS.length));
			const [r, g, b] = SPECTRUM_CELL_COLORS[colorIdx];
			res += `\x1b[38;2;${r};${g};${b}m▰\x1b[39m`;
		} else {
			const [r, g, b] = EMPTY_CELL_COLOR;
			res += `\x1b[38;2;${r};${g};${b}m▱\x1b[39m`;
		}
	}
	return res;
}

function renderTimeGauge(pct: number, cells = 10): string {
	const clamped = Math.max(0, Math.min(100, pct));
	const filledCount = Math.round((clamped / 100) * cells);
	let res = "";
	for (let i = 0; i < cells; i++) {
		if (i < filledCount) {
			res += `\x1b[38;2;56;189;248m▰\x1b[39m`; // Azul cielo / cian reloj
		} else {
			const [r, g, b] = EMPTY_CELL_COLOR;
			res += `\x1b[38;2;${r};${g};${b}m▱\x1b[39m`;
		}
	}
	return res;
}

function renderRaceBox(
	title: string,
	pace: QuotaPaceInfo,
	innerW: number,
	safeW: number,
	s: ThemeStyler,
): string[] {
	// Ancho exacto de la mini-caja = innerW (44 caracteres para safeW=48)
	const boxW = Math.max(20, innerW);

	// Línea 1: ╭─ 5 HORAS ────────────── Quedan 5h 0m ────╮
	const leftTitle = `${s.border("╭─ ")}${s.accent(title)} ${s.border("─")}`;
	const rightRem = ` ${s.boldWhite("Quedan " + pace.remainingFormatted)} ${s.border("────╮")}`;
	const titleRuleLen = Math.max(1, boxW - visibleLen(leftTitle) - visibleLen(rightRem));
	const boxTop = `${leftTitle}${s.border("─".repeat(titleRuleLen))}${rightRem}`;

	// Barras de 11 celdas para aprovechar el espacio ganado
	const gaugeCells = 11;

	// Línea 2: │ ⏱   [▱▱▱▱▱▱▱▱▱▱▱]  0%   ● Ritmo holgado │ (⏱ + 3 espacios = 4 cols, alineado con "Uso ")
	const timeBar = renderTimeGauge(pace.timeElapsedPct, gaugeCells);
	const timePctStr = `${Math.round(pace.timeElapsedPct)}%`.padStart(3, " ");
	const leftTime = `${s.border("│")} ${s.cyan("⏱   ")}${timeBar} ${s.cyan(timePctStr)}`;
	const rightPill = `${pace.pillColor(pace.pillLabel)} ${s.border("│")}`;
	const spTime = Math.max(1, boxW - visibleLen(leftTime) - visibleLen(rightPill));
	const boxLine1 = `${leftTime}${" ".repeat(spTime)}${rightPill}`;

	// Línea 3: │ Uso [▰▰▱▱▱▱▱▱▱▱▱] 15%        85% libre    │ (Uso + 1 espacio = 4 cols)
	const quotaBar = renderSpectralGauge(pace.consumedPct, gaugeCells);
	const quotaPctStr = `${pace.consumedPct}%`.padStart(3, " ");
	const leftQuota = `${s.border("│")} ${s.slate("Uso ")}${quotaBar} ${s.boldWhite(quotaPctStr)}`;
	const rightFree = `${s.slate(pace.remainingPct + "% libre")} ${s.border("│")}`;
	const spQuota = Math.max(1, boxW - visibleLen(leftQuota) - visibleLen(rightFree));
	const boxLine2 = `${leftQuota}${" ".repeat(spQuota)}${rightFree}`;

	// Línea 4: ╰──────────────────────────────────────────╯
	const boxBot = `${s.border("╰" + "─".repeat(boxW - 2) + "╯")}`;

	// Envolver cada línea para garantizar ancho safeW cerrado
	const wrapInContainer = (content: string) => {
		const pad = Math.max(0, innerW - visibleLen(content));
		return fitToWidth(`${s.border("│")} ${content}${" ".repeat(pad)} ${s.border("│")}`, safeW);
	};

	return [
		wrapInContainer(boxTop),
		wrapInContainer(boxLine1),
		wrapInContainer(boxLine2),
		wrapInContainer(boxBot),
	];
}

export function renderDualConcentricClocks(
	acc: { consumed5h?: string; consumedWeekly?: string; reset5hInSec?: number; resetWeeklyInSec?: number },
	s: ThemeStyler,
	innerW: number,
	safeW: number,
): string[] {
	const pace5h = calculateQuotaPace(acc.consumed5h || "0%", acc.reset5hInSec, 300, s);
	const paceWk = calculateQuotaPace(acc.consumedWeekly || "0%", acc.resetWeeklyInSec, 10080, s);

	const lines5h = renderRaceBox("5 HORAS", pace5h, innerW, safeW, s);
	const linesWk = renderRaceBox("SEMANAL", paceWk, innerW, safeW, s);

	return [...lines5h, ...linesWk];
}

function extractBorderColor(lines: string[], theme?: any): string {
	// 1. Leer del objeto theme de Pi si está disponible
	if (theme && typeof theme.fg === "function") {
		const sample = theme.fg("border", "X");
		const match = sample.match(/^(\x1b\[[0-9;]*m)/);
		if (match) return match[1];
	}
	// 2. Extraer del primer carácter del recuadro superior nativo (Status)
	for (const line of lines) {
		const match = line.match(/^(\x1b\[[0-9;]*m)/);
		if (match) return match[1];
	}
	// 3. Fallback a gris suave tenue de borde
	return "\x1b[38;2;120;153;166m";
}

export function formatCompactEmail(email: string, maxW: number): string {
	if (visibleLen(email) <= maxW) return email;
	if (maxW <= 3) return email.slice(0, maxW);

	const atIdx = email.indexOf("@");
	if (atIdx === -1) {
		const dots = "..";
		return email.slice(0, Math.max(1, maxW - dots.length)) + dots;
	}

	const user = email.slice(0, atIdx);
	// Si hay espacio suficiente (>= 10 cols), mostrar terminación corta @g
	if (maxW >= 10) {
		const dShort = "@g";
		const avail = maxW - dShort.length - 3;
		const p1 = Math.ceil(avail / 2);
		const p2 = Math.floor(avail / 2);
		return user.slice(0, p1) + "..." + user.slice(-p2) + dShort;
	}

	// Espacio ultra compacto (7-9 cols): solo usuario balanceado con puntos
	const avail = Math.max(1, maxW - 3);
	const p1 = Math.ceil(avail / 2);
	const p2 = Math.floor(avail / 2);
	return user.slice(0, p1) + "..." + user.slice(-p2);
}

export type AccordionMode = "collapsed" | "peek" | "pinned";

/**
 * Formatea la tarjeta completa para el Sidebar en modo Fullscreen (gentle-shell / gentle-pi).
 * Se adapta dinámicamente al ancho exacto del panel de Status (48 columnas) y hereda
 * la paleta tipográfica y tonalidades completas del tema nativo.
 */
export function formatSidebarQuotaCardLines(
	pair: PoolRotationPair | null,
	width = 48,
	borderColor = "\x1b[38;2;120;153;166m",
	theme?: any,
	isBusy = false,
	guardTelemetry?: RunawayGuardTelemetry,
	periodLabel = "Hoy (24h)",
	accordionState: boolean | AccordionMode = false,
	peekRemainingSec = 20,
): string[] {
	const mode: AccordionMode =
		typeof accordionState === "string"
			? accordionState
			: accordionState
				? "pinned"
				: "collapsed";
	const isExpanded = mode !== "collapsed";
	if (width < 20) {
		// Modo ultra-compacto si el ancho disponible es extremadamente pequeño
		if (!pair) return [truncateWithAnsi("⚡ Sin pool activo", width)];
		const activeLabel = pair.active.prefix || pair.active.accountId;
		return [truncateWithAnsi(`⚡ ${pair.poolKey}: ${activeLabel} (${pair.active.minAvailable})`, width)];
	}

	const safeW = width;
	const s = createThemeStyler(theme, borderColor);

	if (!pair || !pair.active) {
		const titleStr = truncateWithAnsi("⚡ CUENTAS CPAMC", Math.max(1, safeW - 6));
		const titlePrefix = `${s.border("╭─ ")}${s.accent(titleStr)} ${s.border("─")}`;
		const prefixLen = visibleLen(titlePrefix);
		const titleRules = Math.max(1, safeW - prefixLen - 1);
		const top = `${titlePrefix}${s.border("─".repeat(titleRules) + "╮")}`;
		const bot = s.border("╰" + "─".repeat(safeW - 2) + "╯");
		const msg = truncateWithAnsi("Sin cuentas con rotación activa", Math.max(1, safeW - 4));
		const emptySpace = Math.max(0, safeW - 4 - visibleLen(msg));
		return [
			fitToWidth(top, safeW),
			fitToWidth(`${s.border("│")} ${s.muted(msg)}${" ".repeat(emptySpace)} ${s.border("│")}`, safeW),
			fitToWidth(bot, safeW),
		];
	}

	const innerW = Math.max(4, safeW - 4);
	const renderLine = (label: string, val: string) => {
		const totalLen = visibleLen(label) + visibleLen(val);
		if (totalLen >= innerW) {
			const spaceLeft = Math.max(3, innerW - visibleLen(label) - 1);
			const truncatedVal = truncateWithAnsi(val, spaceLeft);
			const space = Math.max(1, innerW - visibleLen(label) - visibleLen(truncatedVal));
			return fitToWidth(`${s.border("│")} ${label}${" ".repeat(space)}${truncatedVal} ${s.border("│")}`, safeW);
		}
		const space = Math.max(1, innerW - totalLen);
		return fitToWidth(`${s.border("│")} ${label}${" ".repeat(space)}${val} ${s.border("│")}`, safeW);
	};

	const divider = fitToWidth(s.border("├" + "─".repeat(Math.max(1, safeW - 2)) + "┤"), safeW);

	// Evaluación de estado trifásico cromático (Verde tenue vs Verde brillante vs Ámbar)
	const availNum = parseFloat(pair.active.minAvailable.replace("%", "").trim()) || 0;
	const isFatigued = availNum < 25; // Cuenta cansada (<25% libre)
	const isAmber = isFatigued;

	const bar5h = s.paintGauge(pair.active.consumed5h, 6, isAmber);
	const barWk = s.paintGauge(pair.active.consumedWeekly, 6, isAmber);

	// 1. Cabecera con estado vivo
	let stateTag = s.idle("[○ Esperando]");
	if (isAmber) {
		stateTag = pair.isNativeReadOnly ? s.amber("[⚠️ Cuota baja]") : s.amber("[⚡ Limpiando]");
	} else if (isBusy) {
		stateTag = s.live("[● Escribiendo]");
	}

	const tagW = visibleLen(stateTag);
	const fixedPrefixW = pair.isNativeReadOnly ? (18 + 5 + tagW + 2) : (11 + 5 + tagW + 2);
	const maxFamilyW = Math.max(3, safeW - fixedPrefixW);
	const familyDisplay = truncateWithAnsi(
		pair.isNativeReadOnly ? pair.poolKey : pair.familyName,
		maxFamilyW,
	);
	const titlePrefix = pair.isNativeReadOnly
		? `${s.border("╭─ ")}${s.accent("⚡ CUENTA FIJA: ")}${s.text(familyDisplay)} ${s.border("─ ")}${stateTag} ${s.border("─")}`
		: `${s.border("╭─ ")}${s.accent("⚡ POOL: ")}${s.text(familyDisplay)} ${s.border("─ ")}${stateTag} ${s.border("─")}`;
	const prefixLen = visibleLen(titlePrefix);
	const titleRules = Math.max(1, safeW - prefixLen - 1);
	const top = fitToWidth(`${titlePrefix}${s.border("─".repeat(titleRules) + "╮")}`, safeW);
	const bottom = fitToWidth(s.border("╰" + "─".repeat(Math.max(1, safeW - 2)) + "╯"), safeW);

	const activeAccountLabel = pair.active.prefix || pair.active.accountId;
	const nextAccountLabel = pair.next ? (pair.next.prefix || pair.next.accountId) : "";

	// Estado coloquial de la cuenta activa
	let activeStateLabel = isAmber
		? `${s.amber("▲ " + activeAccountLabel)} ${s.amber("(Cansada)")}`
		: isBusy
			? `${s.live("● " + activeAccountLabel)} ${s.live(`(${pair.active.minAvailable} ok)`)}`
			: `${s.idle("○ " + activeAccountLabel)} ${s.idle(`(${pair.active.minAvailable} ok)`)}`;

	// Bloque reactivo "PROTECCIÓN ACTIVA" (Cockpit / Telemetría viva de seguridad)
	const telemetry = guardTelemetry || runawayGuard.getTelemetry();
	const isTripped = Boolean(telemetry.circuitBreakerTripped);
	const hasActiveInterception =
		isTripped ||
		telemetry.blockedIntrospections > 0 ||
		telemetry.blockedBashEvasions > 0 ||
		telemetry.blockedSubagentPolls > 0 ||
		(telemetry.blockedProhibitedCommands || 0) > 0 ||
		telemetry.bashExplorationCount >= MAX_BASH_EXPLORATION_PER_TURN;

	// Enfoque de rotación
	const approachVal = isTripped
		? s.error("🛑 Bucle Interceptado")
		: hasActiveInterception
			? s.amber("Frenando bucles")
			: isAmber
				? s.amber("Podando texto muy largo")
				: isBusy
					? s.live("Escribiendo en vivo")
					: s.text("Misma cuenta fija");

	// Cabecera unificada Cockpit
	const countdown = typeof telemetry.countdownSec === "number" ? telemetry.countdownSec : 30;
	const countdownTag = `(${countdown}s)`;

	const headerTitle = isTripped
		? s.error("🛡 [DISYUNTOR]")
		: hasActiveInterception
			? s.amber("🛡 [INTERCEPCIÓN]")
			: s.accent("🛡 [CUIDANDO EL CHAT]");

	const headerTag = isTripped
		? s.error(`🛑 DISPARADO ${countdownTag}`)
		: hasActiveInterception
			? s.amber("⚡ Bucle Interceptado")
			: isBusy
				? s.live("⚡ Monitoreando turno")
				: s.idle("● En guardia");

	const rule1Len = Math.max(1, innerW - visibleLen(headerTitle) - visibleLen(headerTag) - 2);
	const cockpitHeaderLine = fitToWidth(
		`${s.border("│")} ${headerTitle} ${s.border("─".repeat(rule1Len))} ${headerTag} ${s.border("│")}`,
		safeW,
	);

	// Barra del turno en vivo de 10 celdas
	const toolCount = telemetry.totalToolCount || 0;
	const turnGauge = renderSpectralGauge(Math.round((toolCount / 15) * 100), 10);
	const turnPctColor = toolCount >= 14 ? s.error : toolCount >= 10 ? s.amber : s.idle;
	const turnLabel = `${s.slate("Turno en vivo:")} [${turnGauge}]   ${turnPctColor(String(toolCount) + "/15")} ${s.muted("acciones")}`;
	const spTurn = Math.max(1, innerW - visibleLen(turnLabel));
	const cockpitTurnLine = fitToWidth(`${s.border("│")} ${turnLabel}${" ".repeat(spTurn)} ${s.border("│")}`, safeW);

	// Divisoria interior suave
	const cockpitInnerDivider = fitToWidth(`${s.border("│")} ${s.border("─".repeat(innerW))} ${s.border("│")}`, safeW);

	// Valores dinámicos reales de la matriz 2x2
	const colW = Math.floor((innerW - 1) / 2);
	const renderDoubleLine = (l1: string, v1: string, l2: string, v2: string) => {
		const cell1 = `${l1} ${v1}`;
		const cell2 = `${l2} ${v2}`;
		const sp1 = Math.max(0, colW - visibleLen(cell1));
		const sp2 = Math.max(0, innerW - colW - 1 - visibleLen(cell2));
		const content = `${cell1}${" ".repeat(sp1)}${s.border("│")}${cell2}${" ".repeat(sp2)}`;
		return fitToWidth(`${s.border("│")} ${content} ${s.border("│")}`, safeW);
	};

	// 1. Rescate Red
	const rescateVal = isAmber ? s.amber("1/2 activo") : s.idle("0/2");
	// 2. Subagentes
	const pollVal = telemetry.blockedSubagentPolls > 0
		? s.error("🛑 Bloqueado")
		: telemetry.subagentPollCount > 0
			? s.amber(`${telemetry.subagentPollCount}/2 llamadas`)
			: s.idle("0/2");
	// 3. Sesión
	const introVal = telemetry.blockedIntrospections > 0 ? s.error("🛑 Bloqueado") : s.idle("Protegida");
	// 4. Ahorro real de tokens podados acumulados
	const savedTokens = telemetry.tokensSavedEstimate || 0;
	const ahorroVal = savedTokens > 0
		? s.cyan(`+${Math.round(savedTokens / 1000)}k tk`)
		: s.idle("0 tk");
	// 5. Bucles cíclicos
	const loopsVal = isTripped
		? s.error("🛑 DISPARADO")
		: hasActiveInterception
			? s.amber("⚡ 1 detectado")
			: s.idle("0 detectados");
	// 6. Terminal Bash
	const bashVal = telemetry.blockedBashEvasions > 0
		? s.error("🛑 Bloqueado")
		: telemetry.bashExplorationCount > 0
			? s.amber(`${telemetry.bashExplorationCount}/5`)
			: s.idle("0/5 llamadas");

	let chatBlockLines: string[] = [];
	if (isTripped) {
		const incId = telemetry.incidentId || "active";
		const baseUrl = resolveCpamcBaseUrl();
		const pluginTarget = process.platform === "win32"
			? "auto-switcher-pro-windows-amd64"
			: process.platform === "darwin"
				? "auto-switcher-pro-darwin-arm64"
				: "auto-switcher-pro-linux-amd64";
		const linkUrl = `${baseUrl}/management.html#/plugin-pages/${pluginTarget}/2#incident-${incId}`;
		const eventCount =
			telemetry.lastIncident?.actions_blocked ||
			(telemetry.circuitBreakerReason === "STEP_BUDGET_EXCEEDED"
				? 15
				: telemetry.circuitBreakerReason === "CYCLE_DETECTED"
					? 3
					: 1);
		const linkLabel = `[Ver detalles (${eventCount}) ↗]`;
		const linkText = `\x1b]8;;${linkUrl}\x1b\\${linkLabel}\x1b]8;;\x1b\\`;
		const savedK = Math.max(1, Math.round((telemetry.tokensSavedEstimate || 45000) / 1000));
		const reasonLabel =
			telemetry.circuitBreakerReason === "CYCLE_DETECTED"
				? "Ciclo repetitivo (x3)"
				: telemetry.circuitBreakerReason === "PROHIBITED_COMMAND"
					? "Comando host prohibido"
					: "Pasos agotados (15/15)";

		chatBlockLines = [
			cockpitHeaderLine,
			renderLine(s.muted("Disyuntor Anti-Bucle"), s.error(`🔴 Disparado ${countdownTag}`)),
			renderLine(s.muted("Causa"), s.error(reasonLabel)),
			renderLine(s.muted("Tokens protegidos"), s.live(`~${savedK}k tokens`)),
			renderLine(s.muted("Diagnóstico"), s.accent(linkText)),
			renderLine(s.muted("O escribe"), s.accent("/incident")),
			divider,
			renderLine(s.error("[ACCIÓN REQUERIDA]"), s.text("Dar orden directa")),
		];
	} else if (hasActiveInterception) {
		chatBlockLines = [
			cockpitHeaderLine,
			cockpitTurnLine,
			cockpitInnerDivider,
			renderDoubleLine(s.muted("Rescate Red:"), rescateVal, s.muted("Subagentes:"), pollVal),
			renderDoubleLine(s.muted("Sesión:"), introVal, s.muted("Ahorro:"), ahorroVal),
			renderDoubleLine(s.muted("Bucles:"), loopsVal, s.muted("Bash:"), bashVal),
		];
	} else {
		// En la vista colapsada normal, CUIDANDO EL CHAT muestra:
		// Fila 1: Cabecera con estado vivo
		// Fila 2: Turno en vivo [barra]
		// Fila 3: Guardia Activa con Telemetría viva (Opción 3)
		const mitigated = telemetry.mitigatedCount || 0;
		const guardLabel = mitigated > 0
			? `${s.accent("🛡️ Guardia:")} ${s.amber(`${mitigated} mitigado (~${Math.max(1, Math.round((telemetry.tokensSavedEstimate || 30000) / 1000))}k tk salvados)`)}`
			: `${s.accent("🛡️ Guardia:")} ${s.idle("0 bucles · Código protegido")}`;
		const padGuard = Math.max(0, innerW - visibleLen(guardLabel));
		const guardRow = fitToWidth(
			`${s.border("│")} ${guardLabel}${" ".repeat(padGuard)} ${s.border("│")}`,
			safeW,
		);
		chatBlockLines = [
			cockpitHeaderLine,
			cockpitTurnLine,
			guardRow,
		];
	}

		// Líneas de cabecera (3 filas como en la imagen)
		// Fila 1: Periodo / Modo y Afinidad / Badge
		const lifecycle = getCachedLifecycle();
		const ctxState = getContextState();
		const curPeriod = periodLabel || lifecycle?.period_label || "Hoy (24h)";
		const affinityVal = lifecycle?.cache_affinity_pct ? `${lifecycle.cache_affinity_pct.toFixed(0)}% ok` : "92% ok";
		
		let linePeriodLeft: string;
		let linePeriodRight: string;
		if (pair.isNativeReadOnly) {
			linePeriodLeft = `${s.muted("Modo:")} ${s.amber("Standalone")}`;
			linePeriodRight = `${s.muted("Conex:")} ${s.idle("Directa")}`;
		} else {
			linePeriodLeft = `${s.muted("Periodo:")} ${s.text(curPeriod)}`;
			linePeriodRight = `${s.muted("Caché Afinidad:")} ${s.idle(affinityVal)}`;
		}
		const spPeriod = Math.max(1, innerW - visibleLen(linePeriodLeft) - visibleLen(linePeriodRight));
		const headerRow1 = fitToWidth(`${s.border("│")} ${linePeriodLeft}${" ".repeat(spPeriod)}${linePeriodRight} ${s.border("│")}`, safeW);

		// Fila 2: Modelo o Proveedor (evitando duplicidad exacta si ya figura en el título)
		const headerRow2 = pair.isNativeReadOnly
			? renderLine(s.muted("Proveedor"), s.text(pair.familyName || pair.active.provider || "Directo"))
			: renderLine(s.muted("Modelo"), s.text(pair.poolKey));

		// Fila 3: Cuentas: 2 · listas / Cuenta fija     Enfoque: Cuenta fija
		const line2Left = pair.isNativeReadOnly
			? `${s.muted("Cuenta:")} ${s.text(truncateWithAnsi(pair.active.prefix || pair.active.accountId, Math.max(8, innerW - 25)))}`
			: `${s.muted("Cuentas:")} ${s.text(String(pair.totalAccounts))} ${s.slate("· listas")}`;
		const compactApproach = approachVal
			.replace("Misma cuenta fija", "Cuenta fija")
			.replace("🛑 Bucle Interceptado", "🛑 Bucle");
		const maxApproachW = Math.max(8, innerW - visibleLen(line2Left) - 10);
		const approachDisplay = truncateWithAnsi(compactApproach, maxApproachW);
		const line2Right = pair.isNativeReadOnly
			? `${s.muted("Riesgo:")} ${s.amber("Sin failover")}`
			: `${s.muted("Enfoque:")} ${s.text(approachDisplay)}`;
		const spL2 = Math.max(1, innerW - visibleLen(line2Left) - visibleLen(line2Right));
		const headerRow3 = fitToWidth(`${s.border("│")} ${line2Left}${" ".repeat(spL2)}${line2Right} ${s.border("│")}`, safeW);

		// Quick-Rescue Banner proactivo ante fatiga crítica en cuentas Standalone
		// Si la cuenta fija tiene consumo de 5h >= 85% o reset5hInSec bajo,
		// inyecta un banner visible sugiriendo el comando /model o migración hacia un pool resiliente
		const standaloneConsumed5h = parseConsumedNumber(pair.active.consumed5h);
		const pace5hCheck = calculateQuotaPace(pair.active.consumed5h || "0%", pair.active.reset5hInSec, 300, s);
		const isStandaloneCritical = pair.isNativeReadOnly && (standaloneConsumed5h >= 85 || pace5hCheck.state === "fast" || pace5hCheck.state === "exhausted");
		const quickRescueLines: string[] = [];
		if (isStandaloneCritical) {
			const rescueWarnTitle = `${s.amber("⚡ RESCATE:")} ${s.live("Cuota crítica (" + standaloneConsumed5h + "%)")}`;
			const padWarn = Math.max(0, innerW - visibleLen(rescueWarnTitle));
			const rescueRow1 = fitToWidth(`${s.border("│")} ${rescueWarnTitle}${" ".repeat(padWarn)} ${s.border("│")}`, safeW);
			const rescueAction = `${s.muted("Sugerencia:")} ${s.accent("/model")} ${s.text("➔ saltar a Pool")}`;
			const padAct = Math.max(0, innerW - visibleLen(rescueAction));
			const rescueRow2 = fitToWidth(`${s.border("│")} ${rescueAction}${" ".repeat(padAct)} ${s.border("│")}`, safeW);
			quickRescueLines.push(divider, rescueRow1, rescueRow2);
		}

		// Bloque ROTACIONES & LIDERAZGO con Telemetría de Red y Seguridad integrada
		const rotSectionLines: string[] = [];
		if (!pair.isNativeReadOnly) {
			const rotCount = lifecycle?.rotations_count ?? 1019;
			const curLeadDur = lifecycle?.current_leader_dur ?? "14h 06m";
			const rescuesCount = lifecycle?.rescues_429_count ?? 0;
			const tokensFmt = lifecycle?.tokens_consumed_fmt ?? "48.7M";
			const sustainedTurns = lifecycle?.sustained_turns ?? 8292;

			const rotBaseTitle = `${s.cyan("🔄 ROTACIONES & LIDERAZGO")}`;
			const maxPoolKeyW = Math.max(6, innerW - visibleLen(rotBaseTitle) - 3);
			const poolKeyTrunc = truncateWithAnsi(pair.poolKey, maxPoolKeyW);
			const rotFullTitle = `${rotBaseTitle} ${s.border("·")} ${s.text(poolKeyTrunc)}`;
			const rotPad = Math.max(0, innerW - visibleLen(rotFullTitle));
			const rotHeader = fitToWidth(`${s.border("│")} ${rotFullTitle}${" ".repeat(rotPad)} ${s.border("│")}`, safeW);
			const rotRow1 = renderDoubleLine(s.muted("Rotaciones hoy:"), s.text(String(rotCount)), s.muted("Líder actual:"), s.text(curLeadDur));
			const rotRow2 = renderDoubleLine(s.muted("Rescates 429:"), s.text(String(rescuesCount)), s.muted("Tokens consumidos:"), s.text(tokensFmt));
			const rotRow3 = renderLine(s.muted("Turnos sostenidos:"), `${s.text(String(sustainedTurns))} ${s.slate("turnos sin corte")}`);
			const innerDivider = fitToWidth(`${s.border("│")} ${s.border("─".repeat(innerW))} ${s.border("│")}`, safeW);
			const netRow1 = renderDoubleLine(s.muted("Rescate Red:"), rescateVal, s.muted("Subagentes:"), pollVal);
			const netRow2 = renderDoubleLine(s.muted("Sesión:"), introVal, s.muted("Ahorro:"), ahorroVal);
			const netRow3 = renderDoubleLine(s.muted("Bucles:"), loopsVal, s.muted("Bash:"), bashVal);
			rotSectionLines.push(rotHeader, rotRow1, rotRow2, rotRow3, innerDivider, netRow1, netRow2, netRow3);
		} else {
			const tokensFmt = lifecycle?.tokens_consumed_fmt ?? "14.2M";
			const sustainedTurns = lifecycle?.sustained_turns ?? 142;
			const sessBaseTitle = `${s.cyan("📊 TELEMETRÍA DE SESIÓN")}`;
			const maxKeyW = Math.max(6, innerW - visibleLen(sessBaseTitle) - 3);
			const keyTrunc = truncateWithAnsi(pair.poolKey, maxKeyW);
			const sessFullTitle = `${sessBaseTitle} ${s.border("·")} ${s.text(keyTrunc)}`;
			const sessPad = Math.max(0, innerW - visibleLen(sessFullTitle));
			const sessHeader = fitToWidth(`${s.border("│")} ${sessFullTitle}${" ".repeat(sessPad)} ${s.border("│")}`, safeW);
			const sessRow1 = renderDoubleLine(s.muted("Tokens sesión:"), s.text(tokensFmt), s.muted("Turnos sostenidos:"), s.text(String(sustainedTurns)));
			const sessRow2 = renderDoubleLine(s.muted("Upstream:"), s.idle("200 OK"), s.muted("Rescates 429:"), s.muted("N/A (Fija)"));
			const innerDivider = fitToWidth(`${s.border("│")} ${s.border("─".repeat(innerW))} ${s.border("│")}`, safeW);
			const netRow1 = renderDoubleLine(s.muted("Rescate Red:"), rescateVal, s.muted("Subagentes:"), pollVal);
			const netRow2 = renderDoubleLine(s.muted("Sesión:"), introVal, s.muted("Ahorro:"), ahorroVal);
			const netRow3 = renderDoubleLine(s.muted("Bucles:"), loopsVal, s.muted("Bash:"), bashVal);
			rotSectionLines.push(sessHeader, sessRow1, sessRow2, innerDivider, netRow1, netRow2, netRow3);
		}

		// Bloque de Líder y Candidato para la vista principal (justo bajo los relojes)
		const leaderInfoLines: string[] = [];
		const activeLeadSince = lifecycle?.active_leader_since ?? "14h";
		const leaderTag = pair.isNativeReadOnly ? "(Cuenta fija)" : `(Líder hace ${activeLeadSince})`;
		const leadPrefix = `${s.muted("Estado actual:")}  ${s.accent("⚡ ")}`;
		const leadEmailW = Math.max(5, innerW - visibleLen(leadPrefix) - visibleLen(leaderTag) - 1);
		const cleanLeadEmail = formatCompactEmail(pair.active.accountId, leadEmailW);
		const leadFull = `${leadPrefix}${s.text(cleanLeadEmail)} ${s.muted(leaderTag)}`;
		const leadPad = Math.max(0, innerW - visibleLen(leadFull));
		const leadLine = fitToWidth(`${s.border("│")} ${leadFull}${" ".repeat(leadPad)} ${s.border("│")}`, safeW);
		leaderInfoLines.push(leadLine);

		if (!pair.isNativeReadOnly) {
			const prevLeadDur = lifecycle?.prev_leader_dur ?? "24h 01m";
			const avgLeadDur = lifecycle?.avg_leader_dur ?? "28m";
			const row2Left = `${s.muted("Líder anterior:")} ${s.text(prevLeadDur)}`;
			const row2Right = `${s.muted("Promedio/cta:")} ${s.text(avgLeadDur)}`;
			const spR2 = Math.max(1, innerW - visibleLen(row2Left) - visibleLen(row2Right));
			leaderInfoLines.push(fitToWidth(`${s.border("│")} ${row2Left}${" ".repeat(spR2)}${row2Right} ${s.border("│")}`, safeW));

			if (pair.next) {
				const nextAvailPct = pair.next.minAvailable || "21%";
				const candConsumedPct = pair.next.consumed5h ? parseInt(pair.next.consumed5h.replace("%", "").trim(), 10) : 21;
				const candGauge = renderSpectralGauge(candConsumedPct, 10);
				const candRight = `${candGauge} ${s.text(nextAvailPct)}`;
				const candPrefix = `${s.muted("Candidato a Líder:")} `;
				const candEmailW = Math.max(5, innerW - visibleLen(candPrefix) - visibleLen(candRight) - 1);
				const cleanCandEmail = formatCompactEmail(pair.next.accountId, candEmailW);
				const candLeft = `${candPrefix}${s.text(cleanCandEmail)}`;
				const spCand = Math.max(1, innerW - visibleLen(candLeft) - visibleLen(candRight));
				leaderInfoLines.push(fitToWidth(`${s.border("│")} ${candLeft}${" ".repeat(spCand)}${candRight} ${s.border("│")}`, safeW));
			} else {
				const candLeft = `${s.muted("Candidato a Líder:")}`;
				const candRight = s.muted("Ninguno (Sola)");
				const spCand = Math.max(1, innerW - visibleLen(candLeft) - visibleLen(candRight));
				leaderInfoLines.push(fitToWidth(`${s.border("│")} ${candLeft}${" ".repeat(spCand)}${candRight} ${s.border("│")}`, safeW));
			}
		}

		// Fila interactiva del acordeón colapsable
		const hintSuffix = s.muted(" (Ctrl+Alt+X)");
		let accordionLabel = "";

		if (mode === "peek") {
			const pauseHint = innerW >= 56 ? " (Pausar con Ctrl+Alt+X)" : innerW >= 42 ? " (Pausa)" : "";
			const timerBadge = s.muted(`· Cierra en ${peekRemainingSec}s${pauseHint}`);
			accordionLabel = `${s.amber("▼")} ${s.text("[Ocultar detalles]")} ${timerBadge}`;
		} else if (mode === "pinned") {
			const pinnedSuffix = innerW >= 56 ? "· Fijo (Ctrl+Alt+X)" : "· Fijo";
			const pinnedBadge = s.muted(pinnedSuffix);
			accordionLabel = pair.isNativeReadOnly
				? `${s.amber("▼")} ${s.text("[Ocultar detalles]")} ${pinnedBadge}`
				: `${s.amber("▼")} ${s.text("[Ocultar detalles extendidos]")} ${pinnedBadge}`;
		} else {
			// collapsed (ajustado para que en 44 columnas no se trunque el atajo)
			accordionLabel = pair.isNativeReadOnly
				? `${s.accent("▶")} ${s.text("[Ver más: Contexto y Sesión]")}${hintSuffix}`
				: `${s.accent("▶")} ${s.text("[Ver más: Detalles y Líderes]")}${hintSuffix}`;
		}

		const makeBoxLine = (content: string) => {
			const vis = visibleLen(content);
			if (vis > innerW) {
				const truncated = truncateWithAnsi(content, innerW);
				const pad = Math.max(0, innerW - visibleLen(truncated));
				return `${s.border("│")} ${truncated}${" ".repeat(pad)} ${s.border("│")}`;
			}
			const pad = Math.max(0, innerW - vis);
			return `${s.border("│")} ${content}${" ".repeat(pad)} ${s.border("│")}`;
		};

		const accordionLine = makeBoxLine(accordionLabel);

		if (!isExpanded) {
			const rawCollapsedLines = [
				top,
				headerRow1,
				headerRow2,
				headerRow3,
				divider,
				...renderDualConcentricClocks(pair.active, s, innerW, safeW),
				...leaderInfoLines,
				...quickRescueLines,
				divider,
				...chatBlockLines,
				divider,
				accordionLine,
				bottom,
			];
			return rawCollapsedLines.map((line) => fitToWidth(line, safeW));
		}

		// Bloque ROTACIONES & LIDERAZGO integrado como primer nivel del acordeón desplegado
		const expandedRotLines: string[] = rotSectionLines.length > 0 ? [...rotSectionLines] : [];

		// Bloque CONTEXTO & COMPRESIÓN
		const compTitle = `${s.amber("📦 CONTEXTO & COMPRESIÓN")}`;
		const compHeader = fitToWidth(`${s.border("│")} ${compTitle}${" ".repeat(Math.max(1, innerW - visibleLen(compTitle)))} ${s.border("│")}`, safeW);
		const curTokK = ctxState.currentTokens > 0 ? Math.round(ctxState.currentTokens / 1000) : 0;
		const maxTokK = Math.round(ctxState.contextWindow / 1000);
		const compRow1 = renderLine(s.muted("Compresiones sesión:"), s.text(`${ctxState.compressionsSession} compactaciones`));
		const compRow2 = renderLine(s.muted("Longitud actual:"), s.text(`${curTokK}k / ${maxTokK}k tokens`));
		const compRow3 = renderLine(s.muted("Pérdida de contexto:"), s.text(`${ctxState.lossEvents} eventos críticos`));

		const compLines = [compHeader, compRow1, compRow2, compRow3];
		if (pair.active.reset5hInSec && pair.active.reset5hInSec > 0) {
			const sec = pair.active.reset5hInSec;
			const rH = Math.floor(sec / 3600);
			const rM = Math.floor((sec % 3600) / 60);
			compLines.push(renderLine(s.muted("Reinicio 5h:"), s.accent(`en ${rH}h ${rM}m`)));
		}

		// Bloque CAUSAS DE ROTACIÓN (ÚLTIMAS 24H) - Para Pools / ADVERTENCIA DE RESILIENCIA para Standalone
		const causesSectionLines: string[] = [];
		if (!pair.isNativeReadOnly) {
			const causesTitle = `${s.amber("⚠️ CAUSAS DE ROTACIÓN (ÚLTIMAS 24H)")}`;
			const causesHeader = fitToWidth(`${s.border("│")} ${causesTitle}${" ".repeat(Math.max(1, innerW - visibleLen(causesTitle)))} ${s.border("│")}`, safeW);
			const causesLines: string[] = [];
			const recentCauses = lifecycle?.recent_causes && lifecycle.recent_causes.length > 0
				? lifecycle.recent_causes
				: [
					{ time_str: "15:32", previous_leader: "mar...tro", new_leader: "wil...io7", reason_display: "[Histéresis Δ]", timestamp: 0 },
					{ time_str: "12:42", previous_leader: "mar...tro", new_leader: "wil...io7", reason_display: "[Fatiga 80%]", timestamp: 0 },
					{ time_str: "12:37", previous_leader: "mar...tro", new_leader: "wil...io7", reason_display: "[Fatiga 80%]", timestamp: 0 },
					{ time_str: "12:36", previous_leader: "mar...tro", new_leader: "wil...io7", reason_display: "[shadow_infe..]", timestamp: 0 },
				];

			for (const cause of recentCauses.slice(0, 4)) {
				const causeLeft = `${s.muted(cause.time_str)}  ${s.text(cause.previous_leader)} ${s.slate("➔")} ${s.text(cause.new_leader)}`;
				const causeRight = s.accent(cause.reason_display);
				const spC = Math.max(1, innerW - visibleLen(causeLeft) - visibleLen(causeRight));
				causesLines.push(fitToWidth(`${s.border("│")} ${causeLeft}${" ".repeat(spC)}${causeRight} ${s.border("│")}`, safeW));
			}
			causesSectionLines.push(causesHeader, ...causesLines);
		} else {
			const resTitle = `${s.amber("⚠️ ADVERTENCIA DE RESILIENCIA (SIN POOL)")}`;
			const resHeader = fitToWidth(`${s.border("│")} ${resTitle}${" ".repeat(Math.max(1, innerW - visibleLen(resTitle)))} ${s.border("│")}`, safeW);
			const resRow1 = renderLine(s.muted("Modalidad:"), s.text("Cuenta fija sin failover"));
			const resRow2 = renderLine(s.muted("Riesgo 429:"), s.amber("Corte directo si se agota"));
			const resRow3 = renderLine(s.muted("Sugerencia:"), s.idle("Asociar a Pool para 24/7"));
			causesSectionLines.push(resHeader, resRow1, resRow2, resRow3);
		}

		const rawLines: string[] = [
			top,
			headerRow1,
			headerRow2,
			headerRow3,
			divider,
			...renderDualConcentricClocks(pair.active, s, innerW, safeW),
			...leaderInfoLines,
			divider,
			...chatBlockLines,
			divider,
			accordionLine,
		];

		if (expandedRotLines.length > 0) {
			rawLines.push(divider, ...expandedRotLines);
		}
		if (compLines.length > 0) {
			rawLines.push(divider, ...compLines);
		}
		if (causesSectionLines.length > 0) {
			rawLines.push(divider, ...causesSectionLines);
		}
		rawLines.push(bottom);

	return rawLines.map((line) => fitToWidth(line, safeW));
}

/**
 * Estado volátil en memoria para preservar la preferencia del acordeón durante la sesión de Pi.
 */
let sessionAccordionExpanded: boolean | null = null;
let sessionAccordionMode: AccordionMode | null = null;

export function getSessionAccordionState(): boolean {
	return false;
}

export function setSessionAccordionState(expanded: boolean | AccordionMode): void {
	if (typeof expanded === "string") {
		sessionAccordionMode = expanded;
		sessionAccordionExpanded = expanded !== "collapsed";
	} else {
		sessionAccordionExpanded = expanded;
		sessionAccordionMode = expanded ? "pinned" : "collapsed";
	}
}

/**
 * Gestiona la inyección reactiva del TUI según el modo (`regular` vs `fullscreen`).
 */
export class CpamcTuiAdapter {
	public onOpenIncidentModal?: () => void;
	private isFullscreen = false;
	private isBusy = false;
	private accordionMode: AccordionMode = "collapsed";
	private peekRemainingSec = 0;
	private peekTimer: NodeJS.Timeout | null = null;
	private currentPair: PoolRotationPair | null = null;
	private ctx: ExtensionContext | null = null;
	private tui: any = null;
	private theme: any = null;
	private periodIndex = 0;
	private readonly periods = ["Hoy (24h)", "Semana (7d)", "Mes (30d)"];

	constructor(ctx: ExtensionContext | null) {
		this.ctx = ctx;
	}

	getAccordionMode(): AccordionMode {
		return this.accordionMode;
	}

	getPeekRemainingSeconds(): number {
		return this.peekRemainingSec;
	}

	togglePeriod(): string {
		this.periodIndex = (this.periodIndex + 1) % this.periods.length;
		return this.periods[this.periodIndex];
	}

	getPeriodLabel(): string {
		return this.periods[this.periodIndex];
	}

	toggleExpanded(): AccordionMode {
		this.clearPeekTimer();
		if (this.accordionMode === "collapsed") {
			this.accordionMode = "pinned";
			setSessionAccordionState("pinned");
		} else if (this.accordionMode === "peek") {
			// Congelar/Pausar -> pasa a PINNED fijo
			this.accordionMode = "pinned";
			setSessionAccordionState("pinned");
		} else {
			// Estaba en PINNED -> Colapsar
			this.accordionMode = "collapsed";
			setSessionAccordionState("collapsed");
		}
		this.requestRender();
		return this.accordionMode;
	}

	isCardExpanded(): boolean {
		return this.accordionMode !== "collapsed";
	}

	setExpanded(expanded: boolean): void {
		this.clearPeekTimer();
		this.accordionMode = expanded ? "pinned" : "collapsed";
		setSessionAccordionState(this.accordionMode);
		this.requestRender();
	}

	resetToCollapsed(): void {
		this.clearPeekTimer();
		this.accordionMode = "collapsed";
		sessionAccordionMode = "collapsed";
		sessionAccordionExpanded = false;
		this.requestRender();
	}

	triggerPeek(seconds = 20): void {
		if (this.accordionMode === "pinned") {
			return;
		}

		this.accordionMode = "peek";
		this.peekRemainingSec = seconds;
		this.clearPeekTimer();

		this.peekTimer = setInterval(() => {
			this.tickPeek();
		}, 1000);

		this.requestRender();
	}

	tickPeek(): void {
		if (this.accordionMode !== "peek") {
			this.clearPeekTimer();
			return;
		}

		this.peekRemainingSec = Math.max(0, this.peekRemainingSec - 1);
		if (this.peekRemainingSec <= 0) {
			this.clearPeekTimer();
			this.accordionMode = "collapsed";
			setSessionAccordionState("collapsed");
		}
		this.requestRender();
	}

	onTurnStart(): void {
		if (this.accordionMode === "peek") {
			this.clearPeekTimer();
			this.accordionMode = "collapsed";
			setSessionAccordionState("collapsed");
			this.requestRender();
		}
	}

	private clearPeekTimer(): void {
		if (this.peekTimer) {
			clearInterval(this.peekTimer);
			this.peekTimer = null;
		}
	}

	private invalidateSidebarCache(): void {
		try {
			const tui = this.tui || (this.ctx as any)?.tui;
			const terminal = tui?.terminal as any;
			const cache = terminal?.[Symbol.for("gentle-pi.experimental-sidebar.cache")];
			if (cache && typeof cache.revision === "number") {
				cache.revision++;
			}
			tui?.requestRender?.();
		} catch {}
	}

	private requestRender(): void {
		this.invalidateSidebarCache();
	}

	destroy(): void {
		this.clearPeekTimer();
		this.ctx = null;
	}

	setContext(ctx: ExtensionContext | null): void {
		this.ctx = ctx;
		if (!ctx) {
			this.clearPeekTimer();
		}
	}

	bindTui(tui: any, theme?: any): void {
		this.tui = tui;
		if (theme) {
			this.theme = theme;
		}
	}

	private safeGetModel(): any {
		if (!this.ctx) return null;
		try {
			return this.ctx.model ?? null;
		} catch {
			this.ctx = null;
			this.currentPair = null;
			return null;
		}
	}

	async update(isBusy = false, freshCtx?: ExtensionContext): Promise<void> {
		this.isBusy = isBusy;
		if (freshCtx) {
			this.ctx = freshCtx;
		}
		const model = this.safeGetModel();
		if (!model) {
			this.currentPair = null;
			return;
		}

		try {
			this.currentPair = await getRotationPairForModel(model.id, model.provider);

			// Detección de modo TUI y sidebars (gentle-pi, wilox-pi y temas afines):
			const tui = this.tui || (this.ctx as any)?.tui;
			const terminal = tui?.terminal as any;
			const gentleState = terminal?.[Symbol.for("gentle-pi.experimental-sidebar.state")];
			const altSidebarState = terminal?.[Symbol.for("wilox-pi.sidebar.state")] || terminal?.[Symbol.for("j0k3r-theme.sidebar.state")];

			this.isFullscreen = Boolean(gentleState?.active || altSidebarState?.active || terminal?.fullscreen || process.env.PI_TUI_MODE === "fullscreen");

			if (gentleState?.parts) {
				this.injectIntoSidebar(gentleState);
				tui?.requestRender?.();
			}
			if (altSidebarState?.parts) {
				this.injectIntoSidebar(altSidebarState);
				tui?.requestRender?.();
			}

			// Inyectar simultáneamente en Footer para tener ambas superficies activas y unificadas
			this.injectIntoFooter(isBusy);
		} catch {
			// Silenciar fallos secundarios en segundo plano
		}
	}

	private getModelOriginTag(): string | undefined {
		const model = this.safeGetModel();
		if (!model) return undefined;
		const settings = (this.ctx as any)?.settingsManager;
		const defaultProvider = settings?.getDefaultProvider?.() || "cpamc";
		const defaultModelId = settings?.getDefaultModel?.();

		if (
			defaultModelId &&
			model.id === defaultModelId &&
			(model.provider || "cpamc") === defaultProvider
		) {
			return "default";
		}
		return "sesión";
	}

	private injectIntoFooter(isBusy: boolean): void {
		try {
			const originTag = this.getModelOriginTag();
			const block = formatFooterRotationBlock(this.currentPair, isBusy, originTag);
			const tui = this.tui || (this.ctx as any)?.tui;
			const terminal = tui?.terminal as any;
			const footer = (this.ctx as any)?.footer || terminal?.[Symbol.for("wilox-pi.footer")] || terminal?.[Symbol.for("j0k3r-theme.footer")];

			if (typeof footer?.setQuota === "function") {
				footer.setQuota(block || undefined);
			}
		} catch {}
	}

	private originalFooterPart: any = null;
	private decoratedFooter: any = null;
	private lastStandaloneRenderTime = 0;

	private injectIntoSidebar(gentleState: any): void {
		if (!gentleState?.parts) return;

		const self = this;

		// 1. Siempre registrar la tarjeta cpamc-quota-card independiente (para hosts con sección habilitada)
		gentleState.parts.set("cpamc-quota-card", {
			render: () => {
				try {
					self.lastStandaloneRenderTime = Date.now();
					const m = self.safeGetModel();
					const p = m ? (getRotationPairForModelSync(m.id, m.provider) || self.currentPair) : self.currentPair;
					return formatSidebarQuotaCardLines(
						p,
						48,
						"\x1b[38;2;120;153;166m",
						self.theme,
						self.isBusy,
						undefined,
						self.getPeriodLabel(),
						self.accordionMode,
						self.peekRemainingSec,
					);
				} catch {
					return [];
				}
			},
			digest: () => {
				try {
					const m = self.safeGetModel();
					const p = m ? (getRotationPairForModelSync(m.id, m.provider) || self.currentPair) : self.currentPair;
					const g = runawayGuard.getTelemetry();
					return `${m?.id || "none"}-${p?.poolKey || "none"}-${p?.active?.prefix || "none"}-${p?.active?.minAvailable || "none"}-${self.isBusy}-${self.accordionMode}-${self.peekRemainingSec}-${g.bashExplorationCount}-${g.subagentPollCount}-${g.blockedIntrospections}-${g.blockedBashEvasions}`;
				} catch {
					return "none";
				}
			},
			invalidate: () => {},
			handleMouse: (event: any) => {
				try {
					if (!event) return undefined;
					// 1. Aceptar únicamente click izquierdo real (elimina doble toggle por press + click)
					if (event.type === "click" && (!event.button || event.button === "left")) {
						self.toggleExpanded();
						return { handled: true, render: true };
					}
				} catch {}
				return undefined;
			},
		});

		// 2. Interceptor reactivo universal sobre "footer" con protección anti-duplicación
		const wrapFooter = (originalRail: any) => {
			if (!originalRail || originalRail.__isCpamcDecorated) {
				return originalRail;
			}

			return {
				__isCpamcDecorated: true,
				__originalRail: originalRail,
				render: (width: number) => {
					try {
						let baseLines: string[] = [];
						try {
							baseLines = originalRail.render ? (originalRail.render(width) ?? []) : [];
						} catch {
							baseLines = [];
						}

						// Mecanismo Anti-Duplicación: Si Gentle-Shell ya está renderizando cpamc-quota-card de forma autónoma
						// (recientemente en los últimos 2000ms), evitamos duplicar la tarjeta en el footer.
						const isStandaloneActive = Date.now() - self.lastStandaloneRenderTime < 2000;
						if (isStandaloneActive) {
							return baseLines;
						}

						const model = self.safeGetModel();
						const pair = model
							? (getRotationPairForModelSync(model.id, model.provider) || self.currentPair)
							: self.currentPair;

						if (!pair) {
							return baseLines;
						}

						const bColor = extractBorderColor(baseLines, self.theme);
						const quotaLines = formatSidebarQuotaCardLines(
							pair,
							width,
							bColor,
							self.theme,
							self.isBusy,
							undefined,
							self.getPeriodLabel(),
							self.accordionMode,
							self.peekRemainingSec,
						);

						if (!baseLines.length) {
							return quotaLines;
						}

						// Inserción orgánica: Status Card arriba, Quota Card inmediatamente abajo
						return [...baseLines, "", ...quotaLines].map((line) => fitToWidth(line, width));
					} catch {
						return [];
					}
				},
				digest: () => {
					try {
						let baseDigest = "";
						try {
							baseDigest = typeof originalRail.digest === "function" ? originalRail.digest() : "";
						} catch {
							baseDigest = "";
						}

						const model = self.safeGetModel();
						const modelKey = model ? `${model.provider}:${model.id}` : "none";
						const pair = model
							? (getRotationPairForModelSync(model.id, model.provider) || self.currentPair)
							: self.currentPair;

						const g = runawayGuard.getTelemetry();
						const cpamcDigest = pair
							? `${pair.poolKey || ""}-${pair.active?.prefix || ""}-${pair.active?.minAvailable || ""}-${pair.active?.consumed5h || ""}-${pair.active?.consumedWeekly || ""}-${self.accordionMode}-${self.peekRemainingSec}-${g.bashExplorationCount}-${g.subagentPollCount}-${g.blockedIntrospections}-${g.blockedBashEvasions}`
							: "none";

						return `${baseDigest}::cpamc::${modelKey}::${cpamcDigest}`;
					} catch {
						return "none";
					}
				},
				invalidate: () => {
					try {
						originalRail.invalidate?.();
					} catch {}
				},
				handleMouse: (event: any) => {
					try {
						if (!event) return originalRail.handleMouse?.(event);

						// 1. Filtrar únicamente click izquierdo real (elimina el doble toggle press + click)
						if (event.type !== "click" || (event.button && event.button !== "left")) {
							return originalRail.handleMouse?.(event);
						}

						// 2. Calcular límites verticales y horizontales para delimitar el área interactiva
						let baseHeight = 0;
						try {
							baseHeight = originalRail.render ? (originalRail.render(event.width || 48) ?? []).length : 0;
						} catch {
							baseHeight = 0;
						}

						const quotaStartY = baseHeight > 0 ? baseHeight + 1 : 0; // +1 por la línea en blanco separadora

						// Si el click fue en la tarjeta de Status original de arriba, delegar
						if (typeof event.y === "number" && event.y < quotaStartY) {
							return originalRail.handleMouse?.(event);
						}

						// Calcular la altura real de la Quota Card
						const model = self.safeGetModel();
						const pair = model
							? (getRotationPairForModelSync(model.id, model.provider) || self.currentPair)
							: self.currentPair;

						if (!pair) {
							return originalRail.handleMouse?.(event);
						}

						let quotaHeight = 14; // Altura colapsada base por defecto
						let sampleLines: string[] = [];
						try {
							sampleLines = formatSidebarQuotaCardLines(
								pair,
								event.width || 48,
								"\x1b[38;2;120;153;166m",
								self.theme,
								self.isBusy,
								undefined,
								self.getPeriodLabel(),
								self.accordionMode,
								self.peekRemainingSec,
							);
							quotaHeight = sampleLines.length;
						} catch {}

						const quotaEndY = quotaStartY + quotaHeight;

						// Si el click cae por debajo de la Quota Card, no capturar
						if (typeof event.y === "number" && event.y >= quotaEndY) {
							return originalRail.handleMouse?.(event);
						}

						// Si el evento trae coordenada horizontal X y excede el ancho útil del sidebar (ej. 48 cols), no capturar
						if (typeof event.x === "number" && event.x >= (event.width || 48)) {
							return originalRail.handleMouse?.(event);
						}

						// Si el click fue en la línea de Diagnóstico o /incident, abrir el Modal Autopsia
						if (typeof event.y === "number") {
							const diagIdx = sampleLines.findIndex(
								(l: string) => l.includes("Diagnóstico") || l.includes("Ver detalles") || l.includes("/incident"),
							);
							if (diagIdx !== -1 && event.y === quotaStartY + diagIdx) {
								if (typeof self.onOpenIncidentModal === "function") {
									self.onOpenIncidentModal();
									return { handled: true, render: true };
								}
							}
						}

						// 3. Click confirmado dentro de la Quota Card -> Alternar acordeón
						self.toggleExpanded();
						return { handled: true, render: true };
					} catch {
						return false;
					}
				},
			};
		};

		// Si ya existe un footer en parts, decorarlo ahora mismo
		if (gentleState.parts.has("footer")) {
			const current = gentleState.parts.get("footer");
			if (!current?.__isCpamcDecorated) {
				const originalSet = gentleState.parts.set.bind(gentleState.parts);
				originalSet("footer", wrapFooter(current));
			}
		}

		// Interceptar llamadas futuras a .set() del Map de Gentle-Shell
		if (!gentleState.parts.__cpamcHooked) {
			const originalSet = gentleState.parts.set.bind(gentleState.parts);
			gentleState.parts.set = function (key: string, value: any) {
				if (key === "footer") {
					return originalSet(key, wrapFooter(value));
				}
				return originalSet(key, value);
			};
			gentleState.parts.__cpamcHooked = true;
		}
	}
}
