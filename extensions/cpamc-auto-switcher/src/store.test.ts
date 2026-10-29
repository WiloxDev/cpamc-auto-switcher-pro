import { describe, it, beforeEach } from "node:test";
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

const {
	getRotationPairForModelSync,
	classifyModel,
	setCachedAccountsForTesting,
} = await import("./store.js");
const { formatSidebarQuotaCardLines, stripAnsi, visibleLen } = await import("./adapter.js");

describe("Standalone Accounts Quota Card & Model Resolution", () => {
	beforeEach(() => {
		setCachedAccountsForTesting([]);
	});

	it("resolves standalone account model without prefix to isNativeReadOnly pair", () => {
		setCachedAccountsForTesting([
			{
				status: "[OTHER]",
				provider: "antigravity",
				profile: "-",
				accountId: "standalone-dev@gmail.com",
				prefix: "-",
				consumed5h: "20%",
				consumedWeekly: "35%",
				minAvailable: "65%",
				reset5hInSec: 7200,
				resetWeeklyInSec: 86400,
			},
		]);

		const pair = getRotationPairForModelSync("gemini-2.5-pro", "cpamc");
		assert.ok(pair, "Pair must be non-null for standalone unassigned account");
		assert.strictEqual(pair.isNativeReadOnly, true, "Must be marked as native read-only");
		assert.strictEqual(pair.totalAccounts, 1);
		assert.strictEqual(pair.active.accountId, "standalone-dev@gmail.com");
		assert.strictEqual(pair.active.minAvailable, "65%");

		const lines = formatSidebarQuotaCardLines(pair, 48);
		const text = lines.map((l: string) => stripAnsi(l)).join("\n");
		assert.match(text, /CUENTA FIJA/);
		assert.match(text, /35%/);
		lines.forEach((l: string) => {
			assert.strictEqual(visibleLen(l), 48);
		});
	});

	it("resolves standalone account model with custom physical prefix to isNativeReadOnly pair", () => {
		setCachedAccountsForTesting([
			{
				status: "[OTHER]",
				provider: "antigravity",
				profile: "mi_cuenta",
				accountId: "mi_cuenta@gmail.com",
				prefix: "mi_cuenta",
				consumed5h: "15%",
				consumedWeekly: "25%",
				minAvailable: "75%",
				reset5hInSec: 3600,
				resetWeeklyInSec: 43200,
			},
		]);

		const pair = getRotationPairForModelSync("mi_cuenta/gemini-2.5-flash", "cpamc");
		assert.ok(pair, "Pair must resolve custom physical prefix of standalone account");
		assert.strictEqual(pair.isNativeReadOnly, true);
		assert.strictEqual(pair.poolKey, "mi_cuenta");
		assert.strictEqual(pair.active.accountId, "mi_cuenta@gmail.com");

		const lines = formatSidebarQuotaCardLines(pair, 48);
		const text = lines.map((l: string) => stripAnsi(l)).join("\n");
		assert.match(text, /CUENTA FIJA: mi_cuenta/);
		assert.match(text, /25%/);
		lines.forEach((l: string) => {
			assert.strictEqual(visibleLen(l), 48);
		});
	});

	it("resolves numeric indexed standalone accounts like nim_1 or nan", () => {
		setCachedAccountsForTesting([
			{
				status: "[OTHER]",
				provider: "opencode-go",
				profile: "nan",
				accountId: "cuenta nan 1",
				prefix: "nan",
				consumed5h: "0%",
				consumedWeekly: "0%",
				minAvailable: "100%",
			},
			{
				status: "[OTHER]",
				provider: "opencode-go",
				profile: "nim_1",
				accountId: "cuenta2-wilo9",
				prefix: "nim_1",
				consumed5h: "0%",
				consumedWeekly: "0%",
				minAvailable: "100%",
			},
		]);

		const pairNan = getRotationPairForModelSync("nan/deepseek-v4-flash", "cpamc");
		assert.ok(pairNan);
		assert.strictEqual(pairNan.poolKey, "nan");
		assert.strictEqual(pairNan.isNativeReadOnly, true);

		const pairNim1 = getRotationPairForModelSync("nim_1/deepseek-ai/deepseek-v4.1-flash", "cpamc");
		assert.ok(pairNim1);
		assert.strictEqual(pairNim1.poolKey, "nim_1");
		assert.strictEqual(pairNim1.isNativeReadOnly, true);
	});

	it("returns null when no matching standalone account is available in cache", () => {
		setCachedAccountsForTesting([]);
		const pair = getRotationPairForModelSync("gemini-2.5-flash", "cpamc");
		assert.strictEqual(pair, null);
	});
});
