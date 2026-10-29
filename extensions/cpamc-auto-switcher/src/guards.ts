import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const MAX_BASH_EXPLORATION_PER_TURN = 5;
export const MAX_SUBAGENT_POLL_PER_TURN = 2;
export const MAX_TOTAL_TOOLS_PER_TURN = 15;
export const MAX_CYCLE_REPETITIONS = 3;
export const CYCLE_WINDOW_SIZE = 6;
export const INCIDENT_TTL_MS = 24 * 60 * 60 * 1000; // 24 horas máximo de validez

/**
 * Resuelve la ruta en memoria/shm del incidente para un proyecto y sesión específicos.
 * Esto previene que un incidente en un proyecto contamine a otros proyectos o sesiones nuevas.
 */
export function resolveIncidentShmPath(cwd?: string, sessionId?: string): string {
	const baseDir = existsSync("/dev/shm") ? "/dev/shm" : tmpdir();
	const cwdNormalized = (cwd || process.cwd() || "").trim().toLowerCase();
	const cwdHash = createHash("sha256").update(cwdNormalized).digest("hex").slice(0, 12);
	const sessPart = sessionId ? `_${createHash("sha256").update(sessionId).digest("hex").slice(0, 8)}` : "";
	return join(baseDir, `cpamc_incident_${cwdHash}${sessPart}.json`);
}

export interface IncidentRecord {
	id: string;
	timestamp: number;
	session_id?: string;
	pid?: number;
	pool_id?: string;
	incident_type: "STEP_BUDGET_EXCEEDED" | "CYCLE_DETECTED" | "PROHIBITED_COMMAND" | "UPSTREAM_VELOCITY";
	trigger_command?: string;
	command_trace: string[];
	tokens_saved: number;
	actions_blocked: number;
	status: "mitigated";
}

export interface RunawayGuardTelemetry {
	// Volátiles del turno
	bashExplorationCount: number;
	subagentPollCount: number;
	totalToolCount: number;
	// Estado del disyuntor
	circuitBreakerTripped: boolean;
	circuitBreakerReason?: "STEP_BUDGET_EXCEEDED" | "CYCLE_DETECTED" | "PROHIBITED_COMMAND" | "UPSTREAM_VELOCITY";
	incidentId?: string;
	tokensSavedEstimate: number;
	// Acumulados de la sesión
	blockedIntrospections: number;
	blockedBashEvasions: number;
	blockedSubagentPolls: number;
	blockedProhibitedCommands: number;
	// Estado descriptivo para la UI
	lastBlockedReason?: string;
	lastBlockedAt?: number;
	lastIncident?: IncidentRecord;
}

/**
 * Normaliza comandos bash sustituyendo direcciones hexadecimales, rutas temporales,
 * números de múltiples dígitos y espacios redundantes para detectar bucles cíclicos estructurales.
 */
export function normalizeCommand(cmd: string): string {
	if (!cmd) return "";
	return cmd
		// Normalizar saltos de línea y espacios múltiples
		.replace(/\r?\n/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		// Abstraer direcciones hexadecimales (ej. 0x16dc380, 0x209d666)
		.replace(/\b0x[0-9a-fA-F]+\b/g, "<HEX>")
		// Abstraer rutas efímeras en /tmp
		.replace(/\/tmp\/[\w.-]+/g, "<TMP>")
		// Abstraer números largos (PIDs, timestamps, offsets > 2 dígitos)
		.replace(/\b\d{3,}\b/g, "<NUM>");
}

export class AutoSwitcherRunawayGuard {
	private bashCount = 0;
	private pollCount = 0;
	private totalTools = 0;
	private introspectionsBlocked = 0;
	private bashEvasionsBlocked = 0;
	private pollsBlocked = 0;
	private prohibitedBlocked = 0;

	private commandHistory: string[] = [];
	private rawCommandHistory: string[] = [];

	private isTripped = false;
	private tripReason?: "STEP_BUDGET_EXCEEDED" | "CYCLE_DETECTED" | "PROHIBITED_COMMAND" | "UPSTREAM_VELOCITY";
	private currentIncident?: IncidentRecord;
	private tokensSaved = 0;

	private lastReason?: string;
	private lastTimestamp?: number;

	private currentCwd?: string;
	private currentSessionId?: string;

	/**
	 * Configura el alcance de la sesión y proyecto activo.
	 */
	setScope(cwd?: string, sessionId?: string): void {
		this.currentCwd = cwd;
		this.currentSessionId = sessionId;
	}

	private getShmPath(): string {
		return resolveIncidentShmPath(this.currentCwd, this.currentSessionId);
	}

	private persistIncidentToShm(): void {
		if (!this.currentIncident) return;
		try {
			const payload = {
				incident: this.currentIncident,
				tripReason: this.tripReason,
				tokensSaved: this.tokensSaved,
				lastReason: this.lastReason,
				timestamp: Date.now(),
				cwd: this.currentCwd,
				sessionId: this.currentSessionId,
			};
			writeFileSync(this.getShmPath(), JSON.stringify(payload), "utf-8");
		} catch {}
	}

	loadIncidentFromShm(): boolean {
		try {
			const shmPath = this.getShmPath();
			if (existsSync(shmPath)) {
				const content = readFileSync(shmPath, "utf-8");
				const data = JSON.parse(content);
				if (data && data.incident && data.incident.id) {
					// Validación de TTL: Si tiene más de 24 horas, expira automáticamente
					const now = Date.now();
					const recordTime = data.timestamp || data.incident.timestamp || 0;
					if (now - recordTime > INCIDENT_TTL_MS) {
						this.dismissIncident();
						return false;
					}

					this.currentIncident = data.incident;
					this.isTripped = true;
					this.tripReason = data.tripReason || "CYCLE_DETECTED";
					this.tokensSaved = data.tokensSaved || 30000;
					this.lastReason = data.lastReason || "Incidente persistido en memoria";
					return true;
				}
			}
		} catch {}
		return false;
	}

	dismissIncident(): void {
		this.isTripped = false;
		this.tripReason = undefined;
		this.currentIncident = undefined;
		this.tokensSaved = 0;
		this.lastReason = undefined;
		try {
			const shmPath = this.getShmPath();
			if (existsSync(shmPath)) {
				unlinkSync(shmPath);
			}
		} catch {}
	}

	private generateIncidentId(): string {
		const rand = Math.random().toString(36).substring(2, 7);
		return `cb_${Date.now().toString(36)}_${rand}`;
	}

	checkTool(event: { toolName: string; input?: unknown }): { block: true; reason: string } | undefined {
		if (!event || typeof event.toolName !== "string") {
			return undefined;
		}

		this.totalTools++;
		const input = event.input as Record<string, unknown> | undefined;

		// 1. Presupuesto Máximo Global por Turno (Hard Turn Budget)
		if (this.totalTools >= MAX_TOTAL_TOOLS_PER_TURN) {
			this.isTripped = true;
			this.tripReason = "STEP_BUDGET_EXCEEDED";
			this.tokensSaved = Math.max(this.tokensSaved, 45000); // Estimación mínima conservadora
			const incId = this.generateIncidentId();
			this.currentIncident = {
				id: incId,
				timestamp: Date.now(),
				incident_type: "STEP_BUDGET_EXCEEDED",
				command_trace: [...this.rawCommandHistory],
				tokens_saved: this.tokensSaved,
				actions_blocked: this.totalTools,
				status: "mitigated",
			};
			this.lastReason = `Límite global de ${MAX_TOTAL_TOOLS_PER_TURN} acciones alcanzado`;
			this.lastTimestamp = Date.now();
			this.persistIncidentToShm();
			return {
				block: true,
				reason: `CIRCUIT BREAKER [Auto Switcher Pro]: Has alcanzado el límite máximo de ${MAX_TOTAL_TOOLS_PER_TURN} acciones consecutivas en este turno. Detén la exploración de inmediato, sintetiza tus hallazgos actuales y devuelve la palabra al usuario con tus conclusiones.`,
			};
		}

		// Si hay mutación de código o archivo, significa progreso real (resetea el buffer de bucle de comandos)
		if (event.toolName === "edit" || event.toolName === "write") {
			this.commandHistory = [];
			this.rawCommandHistory = [];
		}

		if (event.toolName === "bash" && typeof input?.command === "string") {
			const cmd = input.command.trim();
			this.rawCommandHistory.push(cmd);
			if (this.rawCommandHistory.length > 10) {
				this.rawCommandHistory.shift();
			}

			// 2. Bloqueo de herramientas host de diagnóstico de bajo nivel o contenedores
			if (/\b(?:objdump|readelf|gdb|strace|ltrace|docker\s+(?:cp|exec))\b/i.test(cmd)) {
				this.prohibitedBlocked++;
				this.isTripped = true;
				this.tripReason = "PROHIBITED_COMMAND";
				this.tokensSaved = Math.max(this.tokensSaved, 30000);
				const incId = this.generateIncidentId();
				this.currentIncident = {
					id: incId,
					timestamp: Date.now(),
					incident_type: "PROHIBITED_COMMAND",
					trigger_command: cmd,
					command_trace: [...this.rawCommandHistory],
					tokens_saved: this.tokensSaved,
					actions_blocked: 1,
					status: "mitigated",
				};
				this.lastReason = "Comando host de diagnóstico prohibido";
				this.lastTimestamp = Date.now();
				this.persistIncidentToShm();
				return {
					block: true,
					reason: "Bloqueado por Auto Switcher Pro: No está permitido ejecutar desensambladores o comandos docker de bajo nivel (objdump, readelf, gdb, strace, docker cp/exec) en el entorno de desarrollo. Concéntrate en el código fuente del proyecto o consulta al usuario.",
				};
			}

			// 3. Bloqueo de auto-introspección en sesiones internas o archivos temporales
			if (/(?:\.pi\/agent\/sessions|\/tmp\/edit_[\w.-]+\.json)/i.test(cmd)) {
				this.introspectionsBlocked++;
				this.lastReason = "Introspección de sesiones bloqueada";
				this.lastTimestamp = Date.now();
				return {
					block: true,
					reason: "Bloqueado por Auto Switcher Pro: No inspecciones archivos internos de sesión (.pi/agent/sessions) o temporales vía bash. Enfócate en la tarea o delega la investigación a un subagente.",
				};
			}

			// 4. Detector de Bucles Cíclicos (Command Pattern Normalization)
			const normalized = normalizeCommand(cmd);
			this.commandHistory.push(normalized);
			if (this.commandHistory.length > CYCLE_WINDOW_SIZE) {
				this.commandHistory.shift();
			}

			const occurrences = this.commandHistory.filter((c) => c === normalized).length;
			if (occurrences >= MAX_CYCLE_REPETITIONS) {
				this.isTripped = true;
				this.tripReason = "CYCLE_DETECTED";
				this.tokensSaved = Math.max(this.tokensSaved, 50000);
				const incId = this.generateIncidentId();
				this.currentIncident = {
					id: incId,
					timestamp: Date.now(),
					incident_type: "CYCLE_DETECTED",
					trigger_command: normalized,
					command_trace: [...this.rawCommandHistory],
					tokens_saved: this.tokensSaved,
					actions_blocked: occurrences,
					status: "mitigated",
				};
				this.lastReason = `Bucle cíclico detectado (${occurrences} repeticiones)`;
				this.lastTimestamp = Date.now();
				this.persistIncidentToShm();
				return {
					block: true,
					reason: `CIRCUIT BREAKER [Auto Switcher Pro]: Bucle de ejecución repetitivo detectado (comando equivalente ejecutado ${occurrences} veces). Detén la exploración y solicita orientación al usuario.`,
				};
			}

			// 5. Control de evasión por bash (búsquedas masivas de código para saltarse delegación)
			if (
				/\b(?:git\s+(?:grep|log|show)|grep\b|find\b|cat\b|sed\s+-n)\b/i.test(cmd) &&
				!/\b(?:odd\/|docs\/|\.md\b)/i.test(cmd)
			) {
				this.bashCount++;
				if (this.bashCount > MAX_BASH_EXPLORATION_PER_TURN) {
					this.bashEvasionsBlocked++;
					this.lastReason = "Evasión por bash bloqueada";
					this.lastTimestamp = Date.now();
					return {
						block: true,
						reason: `Presupuesto de terminal excedido (${this.bashCount}/${MAX_BASH_EXPLORATION_PER_TURN} consultas consecutivas): Has realizado demasiadas lecturas/búsquedas de código inline vía bash. Delega la exploración a un subagente para proteger la ventana de contexto.`,
					};
				}
			}
		}

		// 6. Freno a bucle de polling excesivo a subagentes en el mismo turno
		if (event.toolName === "subagent_status" || event.toolName === "subagent_result") {
			this.pollCount++;
			if (this.pollCount > MAX_SUBAGENT_POLL_PER_TURN) {
				this.pollsBlocked++;
				this.lastReason = "Polling excesivo de subagente bloqueado";
				this.lastTimestamp = Date.now();
				return {
					block: true,
					reason: `Polling de subagente bloqueado: Has consultado subagent_status/result ${this.pollCount} veces en el mismo turno. Finaliza tu turno y espera la notificación automática de finalización en background o utiliza mode: 'task'.`,
				};
			}
		}

		return undefined;
	}

	resetTurn(): void {
		this.bashCount = 0;
		this.pollCount = 0;
		this.totalTools = 0;
		this.commandHistory = [];
		this.rawCommandHistory = [];
	}

	resetSession(): void {
		this.resetTurn();
		this.introspectionsBlocked = 0;
		this.bashEvasionsBlocked = 0;
		this.pollsBlocked = 0;
		this.prohibitedBlocked = 0;
		this.isTripped = false;
		this.tripReason = undefined;
		this.currentIncident = undefined;
		this.tokensSaved = 0;
		this.lastReason = undefined;
		this.lastTimestamp = undefined;
	}

	getTelemetry(): RunawayGuardTelemetry {
		if (!this.isTripped) {
			this.loadIncidentFromShm();
		}
		return {
			bashExplorationCount: this.bashCount,
			subagentPollCount: this.pollCount,
			totalToolCount: this.totalTools,
			circuitBreakerTripped: this.isTripped,
			circuitBreakerReason: this.tripReason,
			incidentId: this.currentIncident?.id,
			tokensSavedEstimate: this.tokensSaved,
			blockedIntrospections: this.introspectionsBlocked,
			blockedBashEvasions: this.bashEvasionsBlocked,
			blockedSubagentPolls: this.pollsBlocked,
			blockedProhibitedCommands: this.prohibitedBlocked,
			lastBlockedReason: this.lastReason,
			lastBlockedAt: this.lastTimestamp,
			lastIncident: this.currentIncident,
		};
	}
}

// Instancia global compartida entre los hooks de evento y el adaptador de TUI
export const runawayGuard = new AutoSwitcherRunawayGuard();
