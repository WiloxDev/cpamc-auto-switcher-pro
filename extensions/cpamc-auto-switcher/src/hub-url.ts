/**
 * Resuelve la URL base canónica del Hub de Auto-Switcher con cascada de fallback:
 * 1. AUTO_SWITCHER_HUB_URL (entorno)
 * 2. CPAMC_LICENSE_HUB_URL (entorno)
 * 3. https://hub.wiloxdev.com (dominio formal con TLS)
 */
export function resolveHubBaseUrl(): string {
	const envUrl = process.env.AUTO_SWITCHER_HUB_URL || process.env.CPAMC_LICENSE_HUB_URL;
	if (envUrl) {
		return envUrl.replace(/\/+$/, "");
	}
	return "https://hub.wiloxdev.com";
}
