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

const { IncidentModalComponent } = await import("./incident-modal.js");

const mockTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

describe("IncidentModalComponent - Overlay Nativo Pi TUI", () => {
	it("renders centered autopsy modal with diagnostic fields and action bar", () => {
		const mockTelemetry: any = {
			circuitBreakerTripped: true,
			circuitBreakerReason: "PROHIBITED_COMMAND",
			incidentId: "cb_test_999",
			tokensSavedEstimate: 30000,
			lastIncident: {
				id: "cb_test_999",
				incident_type: "PROHIBITED_COMMAND",
				trigger_command: "docker exec -it cli-proxy-api sh",
				command_trace: ["ls -la", "docker exec -it cli-proxy-api sh"],
				tokens_saved: 30000,
				actions_blocked: 1,
				status: "mitigated",
			},
		};

		let doneCalled = false;
		const modal = new IncidentModalComponent(
			mockTheme,
			{ telemetry: mockTelemetry },
			() => { doneCalled = true; },
		);

		const lines = modal.render(64);
		assert.ok(lines.length > 5, "modal must render multi-line box");

		const text = lines.join("\n");
		assert.match(text, /AUTOPSIA DE SEGURIDAD/);
		assert.match(text, /ID Incidente/);
		assert.match(text, /cb_test_999/);
		assert.match(text, /Comando host de diagnóstico prohibido/);
		assert.match(text, /~30k tokens salvados/);
		assert.match(text, /docker exec -it cli-proxy-api sh/);
		assert.match(text, /\[ESC\/Q\] Cerrar/);
		assert.match(text, /\[D\] Descartar/);

		// Test key input: ESC closes modal
		modal.handleInput("\u001b");
		assert.equal(doneCalled, true, "ESC must call done");
	});

	it("dismisses incident when user presses 'd' or Return", () => {
		let dismissed = false;
		let doneCalled = false;

		const modal = new IncidentModalComponent(
			mockTheme,
			{
				telemetry: {
					circuitBreakerTripped: true,
					incidentId: "cb_d_test",
					tokensSavedEstimate: 10000,
				} as any,
				onDismiss: () => { dismissed = true; },
			},
			() => { doneCalled = true; },
		);

		modal.handleInput("d");
		assert.equal(dismissed, true, "'d' must trigger onDismiss");
		assert.equal(doneCalled, true, "'d' must close modal");
	});
});
