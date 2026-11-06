import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

// Mismo resolutor .js -> .ts que el resto de suites de esta extensión.
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
        if (existsSync(tsPath)) return { shortCircuit: true, url: pathToFileURL(tsPath).href };
      }
    } catch {}
  }
  return nextResolve(specifier, context);
}
`;
register("data:text/javascript," + encodeURIComponent(loaderCode));

const { CpamcTuiAdapter } = await import("./adapter.js");

/**
 * Cobertura del contrato de composición del footer (issues #31 y #32).
 *
 * El fixture de `adapter.test.ts` imita un rail plano. Aquí la cadena real es la que causó
 * la duplicación en Gentle Shell: un compositor de ranuras de otra extensión debajo del
 * decorador de CPAMC, y capas por encima montadas después a través del `parts.set` interceptado.
 */

const SLOTS_KEY = Symbol.for("gentle-pi.community.wiloxdev.sidebar-slots");

type Part = Record<string, any>;

const baseRail = (): Part => ({
	render: () => ["╭─ Status ─╮", "│ Sesión   │", "╰──────────╯"],
	digest: () => "status",
	invalidate: () => {},
});

/** Compositor de ranuras con el contrato de wellness-reloj / gentle-context-lens. */
const slotsCompositor = (base: Part): Part => {
	const registry: Map<string, any> = (globalThis as any)[SLOTS_KEY] ?? new Map();
	registry.set("pomo", { render: () => ["PomoReloj Bigote"], enabled: () => true, order: () => 10 });
	(globalThis as any)[SLOTS_KEY] = registry;
	return {
		__isWiloxSlotsCompositor: true,
		__originalRail: base,
		render: (width?: number) => [...(base.render?.(width) ?? []), "PomoReloj Bigote"],
		digest: () => "compositor",
		invalidate: () => base.invalidate?.(),
	};
};

const newAdapter = (): any => {
	const ctx: any = { model: { id: "Pool-01-gemini", provider: "cpamc" } };
	return new CpamcTuiAdapter(ctx);
};

const chainOf = (top: Part): Part[] => {
	const seen = new Set<Part>();
	const out: Part[] = [];
	let node: Part | undefined = top;
	while (node && !seen.has(node)) {
		seen.add(node);
		out.push(node);
		node = node.__originalRail;
	}
	return out;
};

const count = (lines: string[], needle: string) => lines.filter((l) => l.includes(needle)).length;

/** Host dinámico: recorre todas las partes registradas, no solo el footer. */
const paintEveryPart = (parts: Map<string, Part>, width = 48): string[] => {
	const out: string[] = [];
	for (const key of parts.keys()) out.push(...(parts.get(key)?.render?.(width) ?? []));
	return out;
};

describe("Contrato de composición del footer con ranuras de terceros", () => {
	it("deja el compositor de ranuras alcanzable bajo el decorador", () => {
		const adapter = newAdapter();
		const parts = new Map<string, Part>();
		const base = baseRail();
		const compositor = slotsCompositor(base);
		parts.set("footer", compositor);

		(adapter as any).injectIntoSidebar({ parts });

		const footer = parts.get("footer") as Part;
		assert.equal(footer.__isCpamcDecorated, true, "el decorador debe envolverse sobre lo existente");
		assert.equal(footer.__originalRail, compositor, "__originalRail es el contrato que permite recorrer la cadena");

		const chain = chainOf(footer);
		assert.equal(chain.filter((n) => n.__isWiloxSlotsCompositor).length, 1, "el compositor sigue alcanzable");
		assert.deepEqual(
			chain.map((n) => (n.__isCpamcDecorated ? "cpamc" : n.__isWiloxSlotsCompositor ? "slots" : "rail")),
			["cpamc", "slots", "rail"],
			"el recorrido documenta cuántas capas hay y cuál es el compositor",
		);

		const lines = footer.render(48);
		assert.equal(count(lines, "PomoReloj"), 1, "la ranura de otra extensión se pinta una sola vez");
		assert.equal(count(lines, "Sesión"), 1);
	});

	it("es idempotente: reinyectar no apila decoradores", () => {
		const adapter = newAdapter();
		const parts = new Map<string, Part>();
		parts.set("footer", slotsCompositor(baseRail()));

		(adapter as any).injectIntoSidebar({ parts });
		(adapter as any).injectIntoSidebar({ parts });
		(adapter as any).injectIntoSidebar({ parts });

		const chain = chainOf(parts.get("footer") as Part);
		assert.equal(chain.filter((n) => n.__isCpamcDecorated).length, 1);
		assert.equal(count(parts.get("footer").render(48), "PomoReloj"), 1);
	});

	it("no reinstala un compositor encima cuando el set() interceptado recibe uno", () => {
		const adapter = newAdapter();
		const parts = new Map<string, Part>();
		const base = baseRail();
		parts.set("footer", base);

		(adapter as any).injectIntoSidebar({ parts });

		// Orden de carga inverso: la otra extensión monta su compositor DESPUÉS del hook.
		const compositor = slotsCompositor(base);
		parts.set("footer", compositor);

		const footer = parts.get("footer") as Part;
		assert.equal(footer.__isCpamcDecorated, true, "el hook sigue decorando lo que se le entregue");
		const chain = chainOf(footer);
		assert.equal(chain.filter((n) => n.__isCpamcDecorated).length, 1, "sin apilar decoradores");
		assert.equal(chain.filter((n) => n.__isWiloxSlotsCompositor).length, 1, "el compositor no se duplica");
		assert.equal(count(footer.render(48), "PomoReloj"), 1);
	});

	it("pinta la tarjeta de cuota una sola vez en un host que recorre todas las partes", () => {
		const adapter = newAdapter();
		const parts = new Map<string, Part>();
		parts.set("footer", slotsCompositor(baseRail()));

		(adapter as any).injectIntoSidebar({ parts });

		const lines = paintEveryPart(parts);
		const digest = parts.get("sentinel")?.digest?.() ?? "";
		const cardNeedle = String(digest).split("_")[0] || "Cuota";
		const painted = lines.filter((l) => /cpamc|gemini|Cuota|quota/i.test(l)).length;
		assert.ok(
			painted <= 1,
			`con el riel activo la tarjeta no debe repetirse en el footer (líneas candidatas: ${painted}, aguja: ${cardNeedle})`,
		);
	});
});
