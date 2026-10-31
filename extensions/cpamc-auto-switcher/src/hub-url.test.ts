import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
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
register(`data:text/javascript,${encodeURIComponent(loaderCode)}`);

const { resolveHubBaseUrl } = await import("./hub-url.js");

describe("Extension Pi - resolveHubBaseUrl Security Contract", () => {
	const originalAutoHub = process.env.AUTO_SWITCHER_HUB_URL;
	const originalCpamcHub = process.env.CPAMC_LICENSE_HUB_URL;

	beforeEach(() => {
		delete process.env.AUTO_SWITCHER_HUB_URL;
		delete process.env.CPAMC_LICENSE_HUB_URL;
	});

	afterEach(() => {
		if (originalAutoHub !== undefined) process.env.AUTO_SWITCHER_HUB_URL = originalAutoHub;
		else delete process.env.AUTO_SWITCHER_HUB_URL;

		if (originalCpamcHub !== undefined) process.env.CPAMC_LICENSE_HUB_URL = originalCpamcHub;
		else delete process.env.CPAMC_LICENSE_HUB_URL;
	});

	it("defaults strictly to TLS domain https://hub.wiloxdev.com", () => {
		const url = resolveHubBaseUrl();
		assert.equal(url, "https://hub.wiloxdev.com");
	});

	it("prioritizes AUTO_SWITCHER_HUB_URL and strips trailing slashes", () => {
		process.env.AUTO_SWITCHER_HUB_URL = "https://custom-hub.example.com///";
		const url = resolveHubBaseUrl();
		assert.equal(url, "https://custom-hub.example.com");
	});

	it("falls back to CPAMC_LICENSE_HUB_URL when AUTO_SWITCHER_HUB_URL is unset", () => {
		process.env.CPAMC_LICENSE_HUB_URL = "https://secondary-hub.example.com/";
		const url = resolveHubBaseUrl();
		assert.equal(url, "https://secondary-hub.example.com");
	});
});
