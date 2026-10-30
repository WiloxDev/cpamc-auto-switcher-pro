import { describe, it } from "node:test";
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

const { formatDoctorOutput } = await import("./doctor.js");
type DoctorReport = import("./doctor.js").DoctorReport;

describe("Doctor Diagnostic Engine", () => {
	it("formats healthy report correctly", () => {
		const report: DoctorReport = {
			allOk: true,
			baseUrl: "http://127.0.0.1:8317",
			timestamp: Date.now(),
			checks: [
				{ name: "Servidor CPAMC", ok: true, detail: "En línea en http://127.0.0.1:8317 (HTTP 200, 4ms)" },
				{ name: "Motor CGO (Auto Switcher Pro)", ok: true, detail: "Plugin activo (v0.1.1)" },
				{ name: "SQLite WAL & Telemetría", ok: true, detail: "Canal activo (4 cuentas)" },
				{ name: "Tarjeta cpamc-quota-card", ok: true, detail: "Montada e interceptada" },
			],
		};

		const formatted = formatDoctorOutput(report);
		assert.match(formatted, /DIAGNÓSTICO INTEGRAL/);
		assert.match(formatted, /\[✓\].*Servidor CPAMC/);
		assert.match(formatted, /✔ Componentes verificados y listos para operar/);
	});

	it("formats anomalous report and flags auto-repair prompt", () => {
		const report: DoctorReport = {
			allOk: false,
			baseUrl: "http://127.0.0.1:8317",
			timestamp: Date.now(),
			checks: [
				{ name: "Servidor CPAMC", ok: true, detail: "En línea" },
				{ name: "Motor CGO (Auto Switcher Pro)", ok: false, detail: "Deshabilitado en config.yaml", autoFixable: true },
				{ name: "SQLite WAL & Telemetría", ok: true, detail: "Activo" },
				{ name: "Tarjeta cpamc-quota-card", ok: true, detail: "Montada" },
			],
		};

		const formatted = formatDoctorOutput(report);
		assert.match(formatted, /\[✗\].*Motor CGO/);
		assert.match(formatted, /⚠️ Se detectaron anomalías/);
		assert.match(formatted, /\/cpamc doctor fix/);
	});
});
