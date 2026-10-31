import assert from "node:assert/strict";
import { describe, it } from "node:test";
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
	AutoSwitcherRunawayGuard,
	MAX_BASH_EXPLORATION_PER_TURN,
	MAX_SUBAGENT_POLL_PER_TURN,
	MAX_TOTAL_TOOLS_PER_TURN,
	runawayGuard,
	getHeadlessRunawayGuard,
	headlessGuardCount,
	MAX_CYCLE_REPETITIONS,
	normalizeCommand,
} = await import("./guards.js");

describe("AutoSwitcherRunawayGuard - Anti-Bucle y Protección de Contexto", () => {
	it("1. Bloquea introspección en .pi/agent/sessions o temporales", () => {
		const guard = new AutoSwitcherRunawayGuard();

		// Intentar leer sesión
		const res1 = guard.checkTool({
			toolName: "bash",
			input: { command: "cat /home/wilox/.pi/agent/sessions/xyz.jsonl" },
		});
		assert.ok(res1?.block);
		assert.match(res1.reason, /archivos internos de sesión/i);

		// Intentar leer archivo temporal de edición
		const res2 = guard.checkTool({
			toolName: "bash",
			input: { command: "cat /tmp/edit_temp-123.json" },
		});
		assert.ok(res2?.block);

		// Comandos normales no son bloqueados
		const resNormal = guard.checkTool({
			toolName: "bash",
			input: { command: "ls -la" },
		});
		assert.equal(resNormal, undefined);

		const tele = guard.getTelemetry();
		assert.equal(tele.blockedIntrospections, 2);
	});

	it("2. Limita la evasión de lecturas masivas por bash a MAX_BASH_EXPLORATION_PER_TURN", () => {
		const guard = new AutoSwitcherRunawayGuard();

		// Ejecutar hasta el límite permitido
		for (let i = 0; i < MAX_BASH_EXPLORATION_PER_TURN; i++) {
			const res = guard.checkTool({
				toolName: "bash",
				input: { command: `grep -rn "pattern_${i}" src/` },
			});
			assert.equal(res, undefined, `intento ${i + 1} no debe bloquear`);
		}

		// El intento 6 supera el límite y debe bloquear
		const blocked = guard.checkTool({
			toolName: "bash",
			input: { command: "cat src/large-file.ts" },
		});
		assert.ok(blocked?.block);
		assert.match(blocked.reason, /Presupuesto de terminal excedido/i);

		const tele = guard.getTelemetry();
		assert.equal(tele.bashExplorationCount, 6);
		assert.equal(tele.blockedBashEvasions, 1);

		// Documentación y markdown no cuentan para la evasión
		guard.resetTurn();
		const docRes = guard.checkTool({
			toolName: "bash",
			input: { command: "cat docs/guide.md" },
		});
		assert.equal(docRes, undefined);
		assert.equal(guard.getTelemetry().bashExplorationCount, 0);
	});

	it("3. Frena el bucle de polling a subagentes cuando supera MAX_SUBAGENT_POLL_PER_TURN en un turno", () => {
		const guard = new AutoSwitcherRunawayGuard();

		// Permitido 1 y 2
		const p1 = guard.checkTool({ toolName: "subagent_status", input: { task_id: "t1" } });
		assert.equal(p1, undefined);
		const p2 = guard.checkTool({ toolName: "subagent_result", input: { task_id: "t1" } });
		assert.equal(p2, undefined);

		// Tercero en el mismo turno bloquea
		const p3 = guard.checkTool({ toolName: "subagent_status", input: { task_id: "t1" } });
		assert.ok(p3?.block);
		assert.match(p3.reason, /Polling de subagente bloqueado/i);

		const tele = guard.getTelemetry();
		assert.equal(tele.blockedSubagentPolls, 1);

		// Al reiniciar turno, se reanuda el presupuesto de polling
		guard.resetTurn();
		const pAfterReset = guard.checkTool({ toolName: "subagent_status", input: { task_id: "t1" } });
		assert.equal(pAfterReset, undefined);
		assert.equal(guard.getTelemetry().subagentPollCount, 1);
		// El acumulado se mantiene para la UI
		assert.equal(guard.getTelemetry().blockedSubagentPolls, 1);
	});

	it("4. Bloquea comandos de diagnóstico binario y operaciones docker no autorizadas", () => {
		const guard = new AutoSwitcherRunawayGuard();

		// objdump
		const res1 = guard.checkTool({
			toolName: "bash",
			input: { command: "objdump -d /tmp/cli-proxy-api-bin" },
		});
		assert.ok(res1?.block);
		assert.match(res1.reason, /desensambladores o comandos docker/i);

		// readelf
		const res2 = guard.checkTool({
			toolName: "bash",
			input: { command: "readelf -s /bin/ls" },
		});
		assert.ok(res2?.block);

		// docker cp / docker exec
		const res3 = guard.checkTool({
			toolName: "bash",
			input: { command: "docker cp cli-proxy-api:/app/bin /tmp/bin" },
		});
		assert.ok(res3?.block);

		const tele = guard.getTelemetry();
		assert.equal(tele.circuitBreakerTripped, true);
		assert.equal(tele.circuitBreakerReason, "PROHIBITED_COMMAND");
	});

	it("5. Normaliza comandos extrayendo hexadecimales, rutas efímeras y números", () => {
		const raw1 = "objdump -d --start-address=0x16dc380 --stop-address=0x16dc580 /tmp/cli-proxy-api-bin";
		const norm1 = normalizeCommand(raw1);
		assert.equal(norm1, "objdump -d --start-address=<HEX> --stop-address=<HEX> <TMP>");

		const raw2 = "cat << 'EOF' > /tmp/read_struct_123.go\npackage main\nEOF";
		const norm2 = normalizeCommand(raw2);
		assert.equal(norm2, "cat << 'EOF' > <TMP> package main EOF");
	});

	it("6. Detecta y corta bucles cíclicos al repetirse 3 comandos equivalentes", () => {
		const guard = new AutoSwitcherRunawayGuard();

		// Ejecución 1 y 2 con diferentes direcciones de memoria
		guard.checkTool({
			toolName: "bash",
			input: { command: "python3 -c 'print(0x1234)' > /tmp/res1.txt" },
		});
		guard.checkTool({
			toolName: "bash",
			input: { command: "python3 -c 'print(0x5678)' > /tmp/res2.txt" },
		});

		// Ejecución 3 (mismo patrón normalizado) -> Circuit breaker disparado
		const blocked = guard.checkTool({
			toolName: "bash",
			input: { command: "python3 -c 'print(0x9abc)' > /tmp/res3.txt" },
		});

		assert.ok(blocked?.block);
		assert.match(blocked.reason, /Bucle de ejecución repetitivo detectado/i);

		const tele = guard.getTelemetry();
		assert.equal(tele.circuitBreakerTripped, true);
		assert.equal(tele.circuitBreakerReason, "CYCLE_DETECTED");
		assert.ok(tele.incidentId?.startsWith("cb_"));
	});

	it("7. Permite ciclos de compilación o pruebas si hay mutación de archivos (TDD)", () => {
		const guard = new AutoSwitcherRunawayGuard();

		// Intento 1 y 2 de prueba
		guard.checkTool({ toolName: "bash", input: { command: "go test -v ./..." } });
		guard.checkTool({ toolName: "bash", input: { command: "go test -v ./..." } });

		// Modificación de archivo (progreso real)
		guard.checkTool({ toolName: "edit", input: { path: "main.go" } });

		// Intento 3 de prueba no debe bloquear porque la ventana de ciclo se reinició con la mutación
		const res = guard.checkTool({ toolName: "bash", input: { command: "go test -v ./..." } });
		assert.equal(res, undefined, "no debe bloquear tras mutación de archivo en TDD");
	});

	it("8. Dispara Circuit Breaker al alcanzar MAX_TOTAL_TOOLS_PER_TURN = 15", () => {
		const guard = new AutoSwitcherRunawayGuard();

		// Ejecutar 14 herramientas variadas
		for (let i = 0; i < 14; i++) {
			const res = guard.checkTool({ toolName: "read", input: { path: `file_${i}.txt` } });
			assert.equal(res, undefined);
		}

		// Herramienta 15 -> Bloqueo por presupuesto total
		const blocked = guard.checkTool({ toolName: "read", input: { path: "file_15.txt" } });
		assert.ok(blocked?.block);
		assert.match(blocked.reason, /límite máximo de 15 acciones/i);

		const tele = guard.getTelemetry();
		assert.equal(tele.totalToolCount, 15);
		assert.equal(tele.circuitBreakerTripped, true);
		assert.equal(tele.circuitBreakerReason, "STEP_BUDGET_EXCEEDED");
		assert.ok(tele.tokensSavedEstimate > 0);

		// Limpieza del archivo persistido en SHM
		guard.dismissIncident();
		const teleCleared = guard.getTelemetry();
		assert.equal(teleCleared.circuitBreakerTripped, false);
		assert.equal(teleCleared.incidentId, undefined);
	});

	it("8b. Sesión headless (subagente): conserva el corte, pero con presupuesto amplio", () => {
		const guard = new AutoSwitcherRunawayGuard();
		// MAX_TOTAL_TOOLS_PER_TURN_HEADLESS = 200 / MAX_BASH_EXPLORATION_PER_TURN_HEADLESS = 60
		guard.setInteractive(false);

		// Un subagente legítimo pasa del techo interactivo de 15 sin ser cortado.
		for (let i = 0; i < 15; i++) {
			assert.equal(guard.checkTool({ toolName: "read", input: { path: `src_${i}.ts` } }), undefined);
		}
		assert.equal(guard.getTelemetry().circuitBreakerTripped, false);

		// Sigue habiendo techo finito: la acción 200 se bloquea.
		for (let i = 16; i < 200; i++) {
			assert.equal(guard.checkTool({ toolName: "read", input: { path: `src_${i}.ts` } }), undefined);
		}
		const blocked = guard.checkTool({ toolName: "read", input: { path: "src_200.ts" } });
		assert.ok(blocked?.block);
		assert.match(blocked.reason, /límite máximo de 200 acciones/i);
		assert.equal(guard.getTelemetry().circuitBreakerReason, "STEP_BUDGET_EXCEEDED");
		guard.dismissIncident();

		// Interactivo vuelve a ser estricto: 15 sigue cortando (sin regresión del lazo humano).
		const strict = new AutoSwitcherRunawayGuard();
		strict.setInteractive(true);
		for (let i = 0; i < 14; i++) {
			assert.equal(strict.checkTool({ toolName: "read", input: { path: `f_${i}.ts` } }), undefined);
		}
		assert.ok(strict.checkTool({ toolName: "read", input: { path: "f_15.ts" } })?.block);
		strict.dismissIncident();
	});

	it("8c. El registro headless aísla presupuestos entre sesiones concurrentes", () => {
		const a = getHeadlessRunawayGuard("sess-A", "/tmp/proj-A");
		const b = getHeadlessRunawayGuard("sess-B", "/tmp/proj-B");
		assert.notEqual(a, b);
		assert.notEqual(a, runawayGuard);

		// La sesión A consume su presupuesto sin tocar el de B ni el de la sesión interactiva.
		for (let i = 0; i < 15; i++) {
			assert.equal(a.checkTool({ toolName: "read", input: { path: `a_${i}.ts` } }), undefined);
		}
		assert.equal(b.getTelemetry().totalToolCount, 0);
		assert.equal(runawayGuard.getTelemetry().totalToolCount, 0);

		// A es reutilizable (misma id) y sigue contando; B conserva su techo propio de 200.
		assert.equal(getHeadlessRunawayGuard("sess-A", "/tmp/proj-A"), a);
		assert.equal(a.getTelemetry().totalToolCount, 15);
		assert.ok(headlessGuardCount() >= 2);
		a.dismissIncident();
		b.dismissIncident();
	});

	it("9. Persiste el incidente en /dev/shm y permite recuperarlo o descartarlo", () => {
		const testCwd = "/tmp/test-project-alpha";
		const testSession = "sess-12345";
		const guard1 = new AutoSwitcherRunawayGuard();
		guard1.setScope(testCwd, testSession);
		guard1.dismissIncident();

		// Forzar disparo por comando prohibido
		const blocked = guard1.checkTool({ toolName: "bash", input: { command: "objdump -d binary" } });
		assert.ok(blocked?.block);

		const tele1 = guard1.getTelemetry();
		assert.equal(tele1.circuitBreakerTripped, true);
		assert.ok(tele1.incidentId);

		// Crear una instancia nueva simulando reinicio de pane en la misma sesión/proyecto
		const guard2 = new AutoSwitcherRunawayGuard();
		guard2.setScope(testCwd, testSession);
		const tele2 = guard2.getTelemetry();
		assert.equal(tele2.circuitBreakerTripped, true);
		assert.equal(tele2.incidentId, tele1.incidentId);
		assert.equal(tele2.circuitBreakerReason, "PROHIBITED_COMMAND");

		// Aislamiento: otro proyecto o sesión limpia NO hereda el disyuntor
		const guardOther = new AutoSwitcherRunawayGuard();
		guardOther.setScope("/tmp/test-project-beta", "sess-clean");
		const teleOther = guardOther.getTelemetry();
		assert.equal(teleOther.circuitBreakerTripped, false);
		assert.equal(teleOther.incidentId, undefined);

		// Descartar deliberadamente
		guard2.dismissIncident();
		const tele3 = guard2.getTelemetry();
		assert.equal(tele3.circuitBreakerTripped, false);
		assert.equal(tele3.incidentId, undefined);
	});

	it("10. Provee countdown de 30s y auto-fading hacia Centinela Limpio", () => {
		const guard = new AutoSwitcherRunawayGuard();
		guard.checkTool({ toolName: "bash", input: { command: "objdump -d test" } });

		const tele1 = guard.getTelemetry();
		assert.equal(tele1.circuitBreakerTripped, true);
		assert.ok(typeof tele1.countdownSec === "number" && tele1.countdownSec <= 30 && tele1.countdownSec >= 28);
		assert.equal(tele1.mitigatedCount, 0);

		// Simular expiración de los 30s
		(guard as any).lastTimestamp = Date.now() - 31000;
		const tele2 = guard.getTelemetry();
		assert.equal(tele2.circuitBreakerTripped, false, "debe autodesvanecerse al expirar el countdown");
		assert.equal(tele2.mitigatedCount, 1, "debe contabilizar la mitigación");
		assert.ok(tele2.lastIncident, "el incidente original debe seguir disponible para autopsia");
	});

	it("11. Despeje inmediato por acción del usuario (Dual-Trigger) preservando histórico", () => {
		const guard = new AutoSwitcherRunawayGuard();
		guard.checkTool({ toolName: "bash", input: { command: "docker exec -it app sh" } });

		assert.equal(guard.getTelemetry().circuitBreakerTripped, true);

		// Usuario toma control / da orden directa -> fadeIncident inmediato
		guard.fadeIncident();

		const tele = guard.getTelemetry();
		assert.equal(tele.circuitBreakerTripped, false);
		assert.equal(tele.mitigatedCount, 1);
		assert.ok(tele.tokensSavedEstimate > 0);
	});

	it("11b. softClearOnUserPrompt despeja el disyuntor al enviar prompt o arrancar sesión fresca", () => {
		const guard = new AutoSwitcherRunawayGuard();
		guard.checkTool({ toolName: "bash", input: { command: "docker exec -it app sh" } });
		assert.equal(guard.getTelemetry().circuitBreakerTripped, true);

		// Usuario escribe un nuevo prompt -> softClearOnUserPrompt
		const cleared = guard.softClearOnUserPrompt();
		assert.equal(cleared, true);

		const tele = guard.getTelemetry();
		assert.equal(tele.circuitBreakerTripped, false);
		assert.equal(tele.mitigatedCount, 1);
		assert.ok(tele.tokensSavedEstimate > 0);

		// Llamadas subsecuentes retornan false si ya no está tripped
		assert.equal(guard.softClearOnUserPrompt(), false);
		guard.dismissIncident();
	});

	it("11c. una sesión con sessionId diferente no queda secuestrada por el disyuntor de una sesión previa", () => {
		const testCwd = "/tmp/test-project-dual-sess";
		// Simular incidente guardado a nivel de proyecto con sessionId antiguo en el payload
		const guardOld = new AutoSwitcherRunawayGuard();
		guardOld.setScope(testCwd);
		(guardOld as any).currentSessionId = "session-prev-111";
		guardOld.checkTool({ toolName: "bash", input: { command: "docker exec -it app sh" } });
		assert.equal(guardOld.getTelemetry().circuitBreakerTripped, true);

		// Nueva sesión en el mismo proyecto con nuevo session ID
		const guardNew = new AutoSwitcherRunawayGuard();
		guardNew.setScope(testCwd);
		(guardNew as any).currentSessionId = "session-next-222";
		const teleNew = guardNew.getTelemetry();
		// Debe desarmar el disyuntor porque la sesión es diferente
		assert.equal(teleNew.circuitBreakerTripped, false);

		guardOld.dismissIncident();
		guardNew.dismissIncident();
	});

	describe("12. Contrato de Resolución de Contexto y Sesión Canónica (guardForContext & resolveSessionId)", () => {
		// Importado dinámicamente o probado contra helpers canónicos de guards
		it("12a. resolveSessionId extrae id canónico de sessionManager.getSessionId()", async () => {
			const { resolveSessionId } = await import("./guards.js");
			const ctxWithMethod = {
				sessionManager: {
					getSessionId: () => "session-uuid-1234",
				},
			};
			assert.equal(resolveSessionId(ctxWithMethod), "session-uuid-1234");
		});

		it("12b. resolveSessionId soporta propiedad sessionId directa como fallback", async () => {
			const { resolveSessionId } = await import("./guards.js");
			const ctxWithProp = {
				sessionId: "direct-session-5678",
			};
			assert.equal(resolveSessionId(ctxWithProp), "direct-session-5678");
		});

		it("12c. guardForContext asigna presupuesto headless cuando hasUI === false o mode !== 'tui'", async () => {
			const { guardForContext } = await import("./guards.js");
			// Sesión de subagente SDK/RPC: sin UI o con hasUI false
			const sdkCtx = {
				hasUI: false,
				sessionManager: {
					getSessionId: () => "subagent-sdk-session-1",
				},
				cwd: "/tmp/project-subagent",
			};
			const guard = guardForContext(sdkCtx);
			assert.notEqual(guard, runawayGuard);
			assert.equal(guard.isInteractive(), false);

			// Sesión interactiva TUI: hasUI true y sin mode no-tui
			const tuiCtx = {
				hasUI: true,
				mode: "tui",
				sessionManager: {
					getSessionId: () => "tui-interactive-session-1",
				},
			};
			const interactiveGuard = guardForContext(tuiCtx);
			assert.equal(interactiveGuard, runawayGuard);
			assert.equal(interactiveGuard.isInteractive(), true);
		});
	});
});
