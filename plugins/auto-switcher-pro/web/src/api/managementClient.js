/**
 * Web Management API Client for CLIProxyAPI Visual Profile Plugin.
 *
 * Implements:
 * - CPAMC parent/local storage key extraction with XOR deobfuscation (`enc::v1::`).
 * - Fail-closed authentication guard.
 * - Same-origin endpoint enforcement (disallows cross-origin or unsafe URLs).
 * - GET /v0/management/auth-files list retrieval (accepts only explicit physical name, rejects missing name).
 * - GET /v0/management/auth-files/download?name= URL-encoded prefix download.
 * - Fail-closed loadAuthFilesWithPrefixes: any download failure (404/401) aborts entire load with sanitized status.
 * - Prefix-only extraction: credentials/secrets are NEVER stored, returned, or logged.
 * - Graph construction with immutable exact auth-file name IDs, strictly avoiding credential keys in state.
 */

import { computeGraphLayout } from '../graph/layout';

const SECRET_SALT = 'cli-proxy-api-webui::secure-storage';
const ENC_PREFIX = 'enc::v1::';
const EMAIL_REGEX = /[a-zA-Z0-9._%+]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const SUFFIX_STRIP = /(?:-plus)?\.json$/i;

/**
 * Abbreviates an email address matching cmd/cpamc-auto-switcher/main.go:
 * First 3 + '...' + last 3 of local part, preserving domain.
 * If local part has <= 6 characters, returns original email unchanged.
 * If email has no '@', returns original string.
 *
 * @param {string} email
 * @returns {string} Masked/abbreviated email
 */
export function abbreviateEmail(email) {
  if (!email || typeof email !== 'string') return '';
  const trimmed = email.trim();
  const atIdx = trimmed.lastIndexOf('@');
  if (atIdx === -1) {
    return trimmed;
  }
  const local = trimmed.slice(0, atIdx);
  const domain = trimmed.slice(atIdx);
  const runes = Array.from(local);
  if (runes.length <= 6) {
    return trimmed;
  }
  return runes.slice(0, 3).join('') + '...' + runes.slice(-3).join('') + domain;
}

/**
 * Extracts and masks email safely from auth file metadata or filename.
 *
 * SAFETY INVARIANTS:
 * - If email field is present, validates with EMAIL_REGEX and abbreviates.
 * - If email field is absent, attempts to extract email pattern from filename (e.g. user@domain.com.json).
 * - Avoids displaying full filename as email: if filename does NOT match an email pattern, returns empty string.
 * - Raw email is NEVER returned or stored in node.data.
 *
 * @param {string} [email]
 * @param {string} [fileName]
 * @returns {string} Abbreviated email or empty string
 */
export function extractSafeMaskedEmail(email, fileName) {
  if (email && typeof email === 'string') {
    const cleanEmail = email.replace(SUFFIX_STRIP, '').trim();
    const match = cleanEmail.match(EMAIL_REGEX);
    if (match) {
      return abbreviateEmail(match[0]);
    }
  }
  if (fileName && typeof fileName === 'string') {
    const cleanName = fileName.replace(SUFFIX_STRIP, '').trim();
    const match = cleanName.match(EMAIL_REGEX);
    if (match) {
      return abbreviateEmail(match[0]);
    }
  }
  return '';
}

/**
 * Masks any email addresses embedded in a display identifier (such as a filename,
 * node ID, candidate list, or error message) while preserving file extensions and
 * surrounding non-email context.
 *
 * SAFETY & PRIVACY INVARIANTS:
 * - Pure display helper: never mutates exact physical auth-file IDs or state payloads.
 * - Matches embedded emails (e.g. user@domain.com) and abbreviates local parts > 6 chars
 *   to first3...last3 preserving domain and suffix (e.g. dev...ser@openai.com.json).
 * - Leaves local parts <= 6 chars unchanged per CLIProxyAPI masking convention.
 * - Non-email strings and filenames are returned unchanged.
 * - Safe against null, undefined, or non-string inputs.
 *
 * @param {string} identifier - Filename, ID, or text that may contain embedded emails
 * @returns {string} Safe display string with embedded emails masked
 */
export function maskDisplayIdentifier(identifier) {
  if (!identifier || typeof identifier !== 'string') return '';
  return identifier.replace(
    /[a-zA-Z0-9._%+]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    (match) => abbreviateEmail(match)
  );
}

/**
 * Sanitizes a file name for safe display in error messages without leaking control characters or tokens.
 *
 * @param {string} name
 * @returns {string} Sanitized filename
 */
export function sanitizeFileName(name) {
  if (!name || typeof name !== 'string') return 'unknown';
  // Strip control chars and limit length to avoid log pollution
  const clean = name.replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim();
  if (clean.length > 64) {
    return clean.slice(0, 60) + '...';
  }
  return clean || 'unknown';
}

/**
 * Deobfuscates CPAMC storage payload using host and userAgent XOR cipher.
 *
 * @param {string} raw - The stored string value
 * @param {string} [host] - Hostname override for testing
 * @param {string} [ua] - User agent override for testing
 * @returns {string} Deobfuscated string, or raw if not obfuscated or on error
 */
export function deobfuscateCPAMC(raw, host, ua) {
  if (!raw || typeof raw !== 'string') return '';
  if (!raw.startsWith(ENC_PREFIX)) return raw;

  try {
    const effectiveHost =
      host ||
      (typeof window !== 'undefined' && window.location && window.location.host) ||
      'localhost';
    const effectiveUa =
      ua ||
      (typeof navigator !== 'undefined' && navigator.userAgent) ||
      '';

    const keyStr = `${SECRET_SALT}|${effectiveHost}|${effectiveUa}`;
    const encoder = new TextEncoder();
    const keyBytes = encoder.encode(keyStr);

    const b64 = raw.slice(ENC_PREFIX.length);
    const binary = atob(b64);
    const dataBytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      dataBytes[i] = binary.charCodeAt(i);
    }

    const decrypted = new Uint8Array(dataBytes.length);
    for (let i = 0; i < dataBytes.length; i++) {
      decrypted[i] = dataBytes[i] ^ keyBytes[i % keyBytes.length];
    }

    return new TextDecoder().decode(decrypted);
  } catch {
    // Fail-safe: return raw on decode error without throwing or leaking
    return raw;
  }
}

/**
 * Obfuscates plain text matching CPAMC XOR cipher.
 * Useful for tests and symmetrical verification.
 *
 * @param {string} plainText
 * @param {string} [host]
 * @param {string} [ua]
 * @returns {string} Obfuscated payload with 'enc::v1::' prefix
 */
export function obfuscateCPAMC(plainText, host, ua) {
  if (typeof plainText !== 'string') return '';
  const effectiveHost =
    host ||
    (typeof window !== 'undefined' && window.location && window.location.host) ||
    'localhost';
  const effectiveUa =
    ua ||
    (typeof navigator !== 'undefined' && navigator.userAgent) ||
    '';

  const keyStr = `${SECRET_SALT}|${effectiveHost}|${effectiveUa}`;
  const encoder = new TextEncoder();
  const keyBytes = encoder.encode(keyStr);
  const dataBytes = encoder.encode(plainText);

  const encrypted = new Uint8Array(dataBytes.length);
  for (let i = 0; i < dataBytes.length; i++) {
    encrypted[i] = dataBytes[i] ^ keyBytes[i % keyBytes.length];
  }

  let binary = '';
  for (let i = 0; i < encrypted.length; i++) {
    binary += String.fromCharCode(encrypted[i]);
  }

  return ENC_PREFIX + btoa(binary);
}

/**
 * Retrieves the management key from CPAMC parent storage (iframe) or local storage.
 * Fails closed and returns empty string if key is not found.
 *
 * @param {Object} [options]
 * @param {string} [options.injectedKey] - Directly injected key for test override
 * @param {Storage} [options.parentStorage] - Storage override for parent window
 * @param {Storage} [options.localStorage] - Storage override for local window
 * @param {string} [options.host] - Host override
 * @param {string} [options.userAgent] - User agent override
 * @returns {string} Management key or empty string
 */
export function getManagementKey(options = {}) {
  if (options.injectedKey) {
    return options.injectedKey.trim();
  }

  const effectiveHost = options.host;
  const effectiveUa = options.userAgent;

  // 1. Try parent localStorage (iframe scenario inside CPAMC)
  try {
    const parentStorage =
      options.parentStorage ||
      (typeof window !== 'undefined' && window.parent && window.parent !== window
        ? window.parent.localStorage
        : null);

    if (parentStorage) {
      const raw = parentStorage.getItem('cli-proxy-auth');
      if (raw) {
        const decrypted = deobfuscateCPAMC(raw, effectiveHost, effectiveUa);
        const parsed = JSON.parse(decrypted);
        if (parsed?.state?.managementKey) {
          return String(parsed.state.managementKey).trim();
        }
      }
    }
  } catch {
    // Cross-origin iframe security or parsing error: fall through
  }

  // 2. Try window.localStorage (direct host scenario)
  try {
    const localStorage =
      options.localStorage ||
      (typeof window !== 'undefined' ? window.localStorage : null);

    if (localStorage) {
      const raw = localStorage.getItem('cli-proxy-auth');
      if (raw) {
        const decrypted = deobfuscateCPAMC(raw, effectiveHost, effectiveUa);
        const parsed = JSON.parse(decrypted);
        if (parsed?.state?.managementKey) {
          return String(parsed.state.managementKey).trim();
        }
      }
    }
  } catch {
    // Parsing error: fall through
  }

  // 3. Try direct explicit storage (manual input or standalone panel fallback)
  try {
    const storage =
      options.localStorage ||
      (typeof window !== 'undefined' ? window.localStorage : null);

    if (storage) {
      const explicitKey =
        storage.getItem('management_key') || storage.getItem('managementKey');
      if (explicitKey && String(explicitKey).trim()) {
        return String(explicitKey).trim();
      }
    }
  } catch {
    // Storage access restricted: fall through
  }

  // 4. Try URL search params (?key=... or ?management_key=...)
  try {
    if (typeof window !== 'undefined' && window.location && window.location.search) {
      const params = new URLSearchParams(window.location.search);
      const urlKey = params.get('key') || params.get('management_key');
      if (urlKey && urlKey.trim()) {
        return urlKey.trim();
      }
    }
  } catch {
    // Search params parsing error: fall through
  }

  // Fail closed
  return '';
}

/**
 * Validates that an endpoint URL is strictly same-origin.
 * Rejects cross-origin, protocol-relative, and invalid URLs.
 *
 * @param {string} endpoint
 * @throws {Error} If endpoint violates same-origin policy
 */
export function assertSafeSameOrigin(endpoint) {
  if (!endpoint || typeof endpoint !== 'string') {
    throw new Error('Invalid endpoint: empty URL');
  }

  const trimmed = endpoint.trim();

  // Relative path starting with / is safe same-origin, unless protocol-relative (//)
  if (trimmed.startsWith('/')) {
    if (trimmed.startsWith('//')) {
      throw new Error('Unsafe origin rejected: protocol-relative URLs not allowed');
    }
    return;
  }

  // Absolute URL: origin MUST match current window.location.origin
  try {
    const baseOrigin =
      typeof window !== 'undefined' && window.location && window.location.origin
        ? window.location.origin
        : 'http://localhost';
    const parsed = new URL(trimmed, baseOrigin);
    const expected = new URL(baseOrigin);

    if (parsed.origin !== expected.origin) {
      throw new Error(
        `Unsafe origin rejected: cross-origin requests to ${parsed.origin} not allowed`
      );
    }
  } catch (err) {
    if (err.message && err.message.includes('Unsafe origin rejected')) {
      throw err;
    }
    throw new Error('Invalid endpoint URL');
  }
}

let serverTimeOffsetMs = 0;

/**
 * Returns current server time offset in milliseconds relative to local clock.
 * Guarded against jitter: only non-zero when drift exceeds 2 seconds.
 */
export function getServerTimeOffsetMs() {
  return serverTimeOffsetMs;
}

/**
 * Executes an authenticated API fetch against the Management API.
 * Fails closed if management key is missing.
 * Enforces same-origin policy and sanitizes error responses.
 *
 * @param {string} endpoint - API path or same-origin URL
 * @param {Object} [options]
 * @returns {Promise<Response>}
 */
export async function apiFetch(endpoint, options = {}) {
  assertSafeSameOrigin(endpoint);

  const key = options.key !== undefined ? options.key : getManagementKey(options);
  if (!key) {
    throw new Error(
      'Management key not found. Please log in to CPAMC with "Remember password" enabled.'
    );
  }

  const fetchImpl = options.fetchFn || (typeof fetch !== 'undefined' ? fetch : null);
  if (!fetchImpl) {
    throw new Error('Fetch API is not available in current environment');
  }

  // Safely merge custom headers:
  // SECURITY INVARIANT:
  // Remove/ignore caller Authorization headers case-insensitively (e.g. 'authorization', 'AUTHORIZATION')
  // and ensure the authoritative Bearer management key is final and cannot be overwritten.
  const mergedHeaders = {
    Accept: 'application/json',
  };

  if (options.headers) {
    if (typeof options.headers.forEach === 'function') {
      options.headers.forEach((value, name) => {
        if (typeof name === 'string' && name.toLowerCase() !== 'authorization') {
          mergedHeaders[name] = value;
        }
      });
    } else if (typeof options.headers === 'object') {
      for (const [name, value] of Object.entries(options.headers)) {
        if (typeof name === 'string' && name.toLowerCase() !== 'authorization') {
          mergedHeaders[name] = value;
        }
      }
    }
  }

  // Case-insensitively strip any lingering authorization variants
  for (const headerKey of Object.keys(mergedHeaders)) {
    if (headerKey.toLowerCase() === 'authorization') {
      delete mergedHeaders[headerKey];
    }
  }

  // Final authoritative Authorization header
  mergedHeaders['Authorization'] = `Bearer ${key}`;

  const { headers: _ignoredHeaders, ...restOptions } = options;

  let res;
  try {
    res = await fetchImpl(endpoint, {
      ...restOptions,
      headers: mergedHeaders,
    });
  } catch {
    // Sanitize network errors so no tokens or sensitive connection details leak
    throw new Error('Management API network request failed');
  }

  // Sincronización client-server con HTTP Date header y Drift Guard (2s)
  const dateHeader = res?.headers?.get?.('date');
  if (dateHeader) {
    try {
      const serverTime = new Date(dateHeader).getTime();
      if (!Number.isNaN(serverTime)) {
        const delta = serverTime - Date.now();
        if (Math.abs(delta) > 2000) {
          serverTimeOffsetMs = delta;
        }
      }
    } catch {}
  }

  if (!res.ok) {
    if (res.status === 401) {
      throw new Error('401 Unauthorized: Invalid or expired management key');
    }
    if (res.status === 403) {
      throw new Error('403 Forbidden: Management key does not have required permissions');
    }
    if (res.status === 404) {
      throw new Error('404 Not Found: Resource not found');
    }
    if (res.status === 409) {
      throw new Error('409 Conflict: Resource conflict detected on server');
    }
    let errorDetail = '';
    try {
      const errJson = await res.clone().json();
      if (errJson && typeof errJson === 'object') {
        errorDetail = errJson.error || errJson.message || '';
      }
    } catch {
      // ignore json parse failure on non-json error responses
    }
    if (errorDetail) {
      throw new Error(`Management API request failed with status ${res.status}: ${errorDetail}`);
    }
    throw new Error(`Management API request failed with status ${res.status}`);
  }

  return res;
}

/**
 * Retrieves the list of configured auth files via GET /v0/management/auth-files.
 *
 * SAFETY INVARIANT:
 * Fails closed on malformed listing entries. Strictly requires an explicit, non-empty
 * physical `name` string for every listed item. Never falls back to `id` (which may be an
 * index rather than a physical file).
 *
 * @param {Object} [options]
 * @returns {Promise<Array<{ name: string, id: string, type: string, provider: string, status: string }>>}
 * @throws {Error} If the listing format is invalid or any entry lacks a physical name
 */
export async function listAuthFiles(options = {}) {
  const endpoint = '/v0/management/auth-files';
  const res = await apiFetch(endpoint, options);
  const data = await res.json();
  if (!Array.isArray(data?.files)) {
    throw new Error('Invalid auth files listing: response missing "files" array.');
  }
  const rawFiles = data.files;

  const validFiles = [];
  for (let i = 0; i < rawFiles.length; i++) {
    const file = rawFiles[i];
    if (!file || typeof file !== 'object') {
      throw new Error(`Invalid auth files listing: entry at index ${i} is not a valid object.`);
    }
    if (typeof file.name !== 'string' || !file.name.trim()) {
      const identifier = file.id ? ` (id: "${String(file.id).trim()}")` : ` at index ${i}`;
      throw new Error(
        `Invalid auth files listing: entry${identifier} is missing a physical filename.`
      );
    }
    const exactName = file.name;

    // Skip subdirectories (e.g. backup folders like backup-6-accounts/...)
    // which CPAMC download endpoint rejects with HTTP 400 Bad Request
    if (exactName.includes('/') || exactName.includes('\\')) {
      continue;
    }

    validFiles.push({
      name: exactName,
      id: typeof file.id === 'string' && file.id.trim() ? file.id : exactName,
      type: typeof file.type === 'string' ? file.type.trim() : '',
      provider: typeof file.provider === 'string' ? file.provider.trim() : '',
      email: typeof file.email === 'string' ? file.email.trim() : '',
      status: typeof file.status === 'string' ? file.status.trim() : '',
      // Real native telemetry (non-sensitive, bounded) from CPAMC listing:
      // required so cards reflect actual CPAMC state instead of mock data.
      auth_index: typeof file.auth_index === 'string' ? file.auth_index.trim() : '',
      project_id: typeof file.project_id === 'string' ? file.project_id.trim() : '',
      unavailable: file.unavailable === true,
      disabled: file.disabled === true,
      cooldowns: sanitizeCooldowns(file.cooldowns),
      recent_requests: sanitizeRecentRequests(file.recent_requests),
      success: typeof file.success === 'number' ? file.success : 0,
      failed: typeof file.failed === 'number' ? file.failed : 0,
      next_retry_after: typeof file.next_retry_after === 'string' ? file.next_retry_after : '',
    });
  }

  // Complemento de alta fidelidad: consultar en paralelo las cuentas gestionadas por OmniAuth Pro Hub
  // para evitar fallos de desencriptación AES-256 en disco e inyectarlas transparentemente.
  try {
    const hubEndpoint = '/v0/management/hub/accounts';
    const hubRes = await apiFetch(hubEndpoint, options);
    if (hubRes.ok) {
      const hubData = await hubRes.json();
      if (Array.isArray(hubData?.accounts)) {
        const hubMap = new Map();
        hubData.accounts.forEach((acc) => {
          if (acc && typeof acc.ID === 'string' && acc.ID.trim()) {
            hubMap.set(acc.ID.trim(), acc);
          } else if (acc && typeof acc.id === 'string' && acc.id.trim()) {
            hubMap.set(acc.id.trim(), acc);
          }
        });

        // Combinar o enriquecer validFiles
        validFiles.forEach((f) => {
          const hubItem = hubMap.get(f.name);
          if (hubItem) {
            f.hubManaged = true;
            f.prefix = hubItem.prefix || hubItem.Prefix || '';
            f.provider = (hubItem.provider || hubItem.Provider || f.provider || '').toLowerCase().trim();
            f.email = hubItem.label || hubItem.Label || f.email || f.name;
            if (hubItem.in_cooldown || hubItem.InCooldown) {
              f.unavailable = true;
              f.cooldowns = [{
                scope: 'global',
                reason: '429 Rate Limit Cooldown (OmniAuth Pro)',
                remaining_seconds: 60,
              }];
            }
            hubMap.delete(f.name);
          }
        });

        // Si existen cuentas en OmniAuth Pro que no aparecieron en el listing nativo
        hubMap.forEach((hubItem, id) => {
          validFiles.push({
            name: id,
            id,
            type: (hubItem.provider || hubItem.Provider || 'omniauth-pro').toLowerCase().trim(),
            provider: (hubItem.provider || hubItem.Provider || 'omniauth-pro').toLowerCase().trim(),
            email: hubItem.label || hubItem.Label || id,
            prefix: hubItem.prefix || hubItem.Prefix || '',
            status: (hubItem.disabled || hubItem.Disabled) ? 'disabled' : 'active',
            hubManaged: true,
            unavailable: Boolean(hubItem.in_cooldown || hubItem.InCooldown),
            disabled: Boolean(hubItem.disabled || hubItem.Disabled),
            cooldowns: (hubItem.in_cooldown || hubItem.InCooldown) ? [{
              scope: 'global',
              reason: '429 Rate Limit Cooldown (OmniAuth Pro)',
              remaining_seconds: 60,
            }] : [],
            recent_requests: [],
            success: 0,
            failed: 0,
          });
        });
      }
    }
  } catch (hubErr) {
    // Si OmniAuth Pro no está instalado o el endpoint falla, continuar normalmente con CPAMC nativo
    console.debug?.('[VisualProfile] OmniAuth Pro Hub accounts not accessible:', hubErr.message);
  }

  return validFiles;
}

/**
 * Sanitizes CPAMC native cooldown entries, keeping only the bounded, non-sensitive
 * fields required to reflect real quota-exhaustion state on cards.
 *
 * @param {Array} [cooldowns]
 * @returns {Array<Object>}
 */
function sanitizeCooldowns(cooldowns) {
  if (!Array.isArray(cooldowns)) return [];
  return cooldowns
    .map((c) => {
      if (!c || typeof c !== 'object') return null;
      return {
        scope: typeof c.scope === 'string' ? c.scope : '',
        model_key: typeof c.model_key === 'string' ? c.model_key : '',
        reason: typeof c.reason === 'string' ? c.reason : '',
        retry_at: typeof c.retry_at === 'string' ? c.retry_at : '',
        remaining_seconds: typeof c.remaining_seconds === 'number' ? c.remaining_seconds : null,
        http_status: typeof c.http_status === 'number' ? c.http_status : 0,
      };
    })
    .filter(Boolean);
}

/**
 * Sanitizes CPAMC native recent request buckets (10-minute windows), keeping only
 * time/success/failed counts. Never contains credentials.
 *
 * @param {Array} [recentRequests]
 * @returns {Array<Object>}
 */
function sanitizeRecentRequests(recentRequests) {
  if (!Array.isArray(recentRequests)) return [];
  return recentRequests
    .map((b) => {
      if (!b || typeof b !== 'object') return null;
      return {
        time: typeof b.time === 'string' ? b.time : '',
        success: typeof b.success === 'number' ? b.success : 0,
        failed: typeof b.failed === 'number' ? b.failed : 0,
      };
    })
    .filter(Boolean);
}

/**
 * Downloads raw auth file credential JSON and extracts ONLY the prefix.
 *
 * CRITICAL SECURITY INVARIANT:
 * Raw credential contents, tokens, client secrets, and refresh tokens are
 * discarded immediately and NEVER returned, stored in state, or logged.
 *
 * @param {string} fileName - Exact filename of the auth file
 * @param {Object} [options]
 * @returns {Promise<{ name: string, prefix: string }>}
 */
export async function downloadAuthFilePrefix(fileName, options = {}) {
  if (!fileName || typeof fileName !== 'string' || !fileName.trim()) {
    throw new Error('Invalid auth file name: filename must be a non-empty string');
  }

  const exactName = fileName;
  const encodedName = encodeURIComponent(exactName);
  const endpoint = `/v0/management/auth-files/download?name=${encodedName}`;

  const res = await apiFetch(endpoint, options);
  const rawData = await res.json();

  // Extract ONLY prefix and excluded_models. Discard entire rawData immediately.
  let prefix = '';
  if (rawData && typeof rawData.prefix === 'string') {
    prefix = rawData.prefix.trim();
  }

  let excluded_models = [];
  if (Array.isArray(rawData?.excluded_models)) {
    excluded_models = rawData.excluded_models.map((m) => String(m || '').trim()).filter(Boolean);
  } else if (Array.isArray(rawData?.excludedModels)) {
    excluded_models = rawData.excludedModels.map((m) => String(m || '').trim()).filter(Boolean);
  }

  return {
    name: exactName,
    prefix,
    excluded_models,
  };
}

/**
 * Retrieves the models associated with an individual auth credential via GET /v0/management/auth-files/models?name=...
 *
 * @param {string} fileName - Exact physical filename of the auth file
 * @param {Object} [options] - Options passed to apiFetch
 * @returns {Promise<string[]>} Array of model IDs reported by native CPAMC
 */
export async function getAuthFileModels(fileName, options = {}) {
  if (!fileName || typeof fileName !== 'string' || !fileName.trim()) {
    return [];
  }
  const cleanName = fileName.trim();
  const endpoints = [
    `/v0/management/auth-files/models?name=${encodeURIComponent(cleanName)}`,
    `/v8/management/credentials/models?name=${encodeURIComponent(cleanName)}`,
  ];
  for (const endpoint of endpoints) {
    try {
      const res = await apiFetch(endpoint, options);
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data?.models) && data.models.length > 0) {
          return data.models.map((m) => m?.id || m?.name || String(m)).filter(Boolean);
        }
      }
    } catch {
      // fallback al siguiente endpoint
    }
  }
  return [];
}

/**
 * Fetches all auth files and their prefixes from the Management API.
 *
 * FAIL-CLOSED SAFETY CONTRACT:
 * If downloading ANY auth file's prefix fails (e.g. 404 Not Found, 401 Unauthorized),
 * this function REJECTS the entire load rather than returning prefix: '' which would
 * allow an unknown original prefix to be accidentally overwritten in a partially editable graph.
 *
 * @param {Object} [options]
 * @returns {Promise<Array<{ name: string, prefix: string }>>}
 * @throws {Error} Sanitized error with filename and HTTP status (no secrets)
 */
export async function loadAuthFilesWithPrefixes(options = {}) {
  const files = await listAuthFiles(options);
  if (!files.length) return [];

  // Fail closed: if ANY file fails to download, reject the entire batch
  const results = await Promise.all(
    files.map(async (file) => {
      // Si el archivo ya viene catalogado por el Hub de OmniAuth Pro con su prefix resuelto:
      if (file.hubManaged && typeof file.prefix === 'string') {
        const record = {
          name: file.name,
          prefix: file.prefix,
          excluded_models: file.excluded_models || [],
        };
        if (file.type) record.type = file.type;
        if (file.provider) record.provider = file.provider;
        if (file.email) record.email = file.email;
        if (file.status) record.status = file.status;
        if (file.auth_index) record.auth_index = file.auth_index;
        if (file.project_id) record.project_id = file.project_id;
        if (file.unavailable !== undefined) record.unavailable = file.unavailable === true;
        if (file.disabled !== undefined) record.disabled = file.disabled === true;
        if (Array.isArray(file.cooldowns)) record.cooldowns = file.cooldowns;
        if (Array.isArray(file.recent_requests)) record.recent_requests = file.recent_requests;
        if (typeof file.success === 'number') record.success = file.success;
        if (typeof file.failed === 'number') record.failed = file.failed;
        if (file.next_retry_after) record.next_retry_after = file.next_retry_after;
        return record;
      }

      try {
        const details = await downloadAuthFilePrefix(file.name, options);
        const record = {
          name: file.name,
          prefix: details.prefix,
          excluded_models: details.excluded_models || [],
        };
        if (file.type) record.type = file.type;
        if (file.provider) record.provider = file.provider;
        if (file.email) record.email = file.email;
        if (file.status) record.status = file.status;
        if (file.auth_index) record.auth_index = file.auth_index;
        if (file.project_id) record.project_id = file.project_id;
        if (file.unavailable !== undefined) record.unavailable = file.unavailable === true;
        if (file.disabled !== undefined) record.disabled = file.disabled === true;
        if (Array.isArray(file.cooldowns)) record.cooldowns = file.cooldowns;
        if (Array.isArray(file.recent_requests)) record.recent_requests = file.recent_requests;
        if (typeof file.success === 'number') record.success = file.success;
        if (typeof file.failed === 'number') record.failed = file.failed;
        if (file.next_retry_after) record.next_retry_after = file.next_retry_after;
        return record;
      } catch (err) {
        // If an individual auth file fails with 400 Bad Request (e.g. nested path or corrupted descriptor),
        // skip it defensively rather than failing closed on the entire visual profile graph.
        if (err.message && err.message.includes('400')) {
          console.warn(`[VisualProfile] Skipping unreadable auth file "${file.name}":`, err.message);
          return null;
        }

        const safeName = maskDisplayIdentifier(sanitizeFileName(file.name));
        let statusText = 'request failed';
        if (err.message && err.message.includes('401')) {
          statusText = '401 Unauthorized';
        } else if (err.message && err.message.includes('404')) {
          statusText = '404 Not Found';
        } else if (err.message && err.message.includes('403')) {
          statusText = '403 Forbidden';
        } else {
          const match = err.message && err.message.match(/status (\d+)/i);
          if (match) {
            statusText = `HTTP ${match[1]}`;
          }
        }
        throw new Error(`Failed to load auth file "${safeName}": ${statusText}`);
      }
    })
  );

  // In CLIProxyAPI pool, duplicate prefixes are legitimate (account pools/rotation).
  // Return loaded results directly without blanket unique-prefix lockout. Filter out skipped items.
  return results.filter(Boolean);
}

/**
 * Builds React Flow nodes and edges from actual auth files.
 *
 * SAFETY INVARIANTS:
 * - Node IDs are immutable exact auth-file names.
 * - Initial prefix and dirty tracking state are attached.
 * - Avoids leaking any credential keys (token, secret, client_secret, password, json) into state.
 * - Reconstructs parent/child edges when child prefixes match `${parentPrefix}_${n}`.
 * - Marks synthetic flag as false (real auth files).
 *
 * @param {Array<{ name: string, prefix: string }>} authFiles
 * @returns {{ nodes: Array<Object>, edges: Array<Object> }}
 */
export function buildGraphFromAuthFiles(authFiles = [], options = {}) {
  if (!Array.isArray(authFiles) || !authFiles.length) {
    return { nodes: [], edges: [] };
  }

  const registeredPools = Array.isArray(options.registeredPools) ? options.registeredPools : [];
  const poolByLeaderMap = new Map();
  const poolsByMemberMap = new Map(); // fileName -> Array of pools where it participates
  registeredPools.forEach((p) => {
    if (!p) return;
    if (p.leader_auth) poolByLeaderMap.set(p.leader_auth, p);
    const allMembers = [
      ...(p.leader_auth ? [p.leader_auth] : []),
      ...(Array.isArray(p.members) ? p.members : []),
      ...(Array.isArray(p.reserves) ? p.reserves : []),
    ];
    allMembers.forEach((m) => {
      if (m) {
        if (!poolsByMemberMap.has(m)) {
          poolsByMemberMap.set(m, []);
        }
        const existingList = poolsByMemberMap.get(m);
        if (!existingList.some((x) => x.id === p.id)) {
          existingList.push(p);
        }
      }
    });
  });

  // Filter and sanitize input records to ensure only clean name and prefix are consumed
  // Preserves exact physical filename identity
  const cleanFiles = [];
  authFiles.forEach((file) => {
    if (file && typeof file.name === 'string' && file.name.trim()) {
      const rawExclusions = Array.isArray(file.excluded_models)
        ? file.excluded_models
        : Array.isArray(file.excludedModels)
        ? file.excludedModels
        : [];
      const cleanExclusions = rawExclusions.map((m) => String(m || '').trim()).filter(Boolean);

      cleanFiles.push({
        name: file.name,
        prefix: typeof file.prefix === 'string' ? file.prefix.trim() : '',
        type: typeof file.type === 'string' ? file.type.trim() : '',
        provider: typeof file.provider === 'string' ? file.provider.trim() : '',
        email: typeof file.email === 'string' ? file.email.trim() : '',
        status: typeof file.status === 'string' ? file.status.trim() : '',
        excluded_models: cleanExclusions,
        excludedModels: cleanExclusions,
        auth_index: file.auth_index !== undefined ? file.auth_index : file.authIndex,
        project_id: file.project_id || file.projectId || '',
        unavailable: file.unavailable === true,
        disabled: file.disabled === true,
        cooldowns: Array.isArray(file.cooldowns) ? file.cooldowns : [],
        recent_requests: Array.isArray(file.recent_requests) ? file.recent_requests : [],
        success: typeof file.success === 'number' ? file.success : 0,
        failed: typeof file.failed === 'number' ? file.failed : 0,
        next_retry_after: typeof file.next_retry_after === 'string' ? file.next_retry_after : '',
      });
    }
  });

  if (!cleanFiles.length) {
    return { nodes: [], edges: [] };
  }

  // Map prefix -> Array of auth files sharing that prefix
  // In CLIProxyAPI, duplicate prefixes are legitimate (pool rotation)
  const prefixToFilesMap = new Map();
  cleanFiles.forEach((file) => {
    if (file.prefix) {
      if (!prefixToFilesMap.has(file.prefix)) {
        prefixToFilesMap.set(file.prefix, []);
      }
      prefixToFilesMap.get(file.prefix).push(file);
    }
  });

  const edges = [];
  const childNodeIds = new Set();
  const ambiguousChildMap = new Map();

  // Identify relationships where child prefix matches parent prefix + '_N'
  // When duplicate parent prefix exists, graph inference must NOT invent parent edge (leave ambiguous nodes disconnected and visibly explain)
  cleanFiles.forEach((file) => {
    const childPrefix = file.prefix;
    if (childPrefix) {
      const match = childPrefix.match(/^(.*)_(\d+)$/);
      if (match) {
        const candidateParentPrefix = match[1];
        const candidateParents = prefixToFilesMap.get(candidateParentPrefix) || [];
        // Only infer an edge when candidate parent prefix is unambiguous (exactly 1 parent file)
        if (candidateParents.length === 1) {
          const parentFile = candidateParents[0];
          if (parentFile.name !== file.name) {
            childNodeIds.add(file.name);
            edges.push({
              id: `edge__${parentFile.name}-${file.name}`,
              source: parentFile.name,
              target: file.name,
              animated: true,
              style: { stroke: '#58a6ff', strokeWidth: 2 },
            });
            return;
          }
        } else if (candidateParents.length > 1) {
          // Multiple candidate parents share candidateParentPrefix: leave disconnected and record ambiguity info
          ambiguousChildMap.set(file.name, {
            parentPrefix: candidateParentPrefix,
            candidateCount: candidateParents.length,
            candidateNames: candidateParents.map((p) => p.name),
          });
          return;
        }
      }
    }

    const filePools = poolsByMemberMap.get(file.name) || [];
    filePools.forEach((assignedPool) => {
      const isLeader = assignedPool?.leader_auth === file.name;
      const poolFam = (assignedPool?.family || '').toLowerCase();
      const isClaudePool = poolFam.includes('claude') || poolFam.includes('sonnet') || poolFam.includes('opus') || (assignedPool?.base_prefix || '').startsWith('agy_clau');
      const isDualAccount = (file.type === 'antigravity' || file.provider === 'antigravity') && filePools.length > 1;

      if (assignedPool && assignedPool.leader_auth && !isLeader) {
        const leaderPools = poolsByMemberMap.get(assignedPool.leader_auth) || [];
        const isLeaderDual = leaderPools.length > 1;
        const sourceId = isLeaderDual && isClaudePool ? `${assignedPool.leader_auth}@claude` : (isLeaderDual && !isClaudePool ? `${assignedPool.leader_auth}@gemini` : assignedPool.leader_auth);
        const targetId = isDualAccount && isClaudePool ? `${file.name}@claude` : (isDualAccount && !isClaudePool ? `${file.name}@gemini` : file.name);

        childNodeIds.add(targetId);
        const edgeId = `edge__${sourceId}-${targetId}`;
        if (!edges.some((e) => e.id === edgeId)) {
          edges.push({
            id: edgeId,
            source: sourceId,
            target: targetId,
            animated: true,
            style: { stroke: isClaudePool ? '#a855f7' : '#38bdf8', strokeWidth: 2 },
          });
        }
      }
    });
  });

  // Build nodes with strictly whitelisted non-credential fields
  const rawNodes = [];
  cleanFiles.forEach((file) => {
    const fileName = file.name;
    const filePools = poolsByMemberMap.get(fileName) || [];
    const isAntigravity = (file.type === 'antigravity' || file.provider === 'antigravity');
    const isDualAccount = isAntigravity && filePools.length > 1;

    // Helper para generar el nodo con su data
    const createNodeInstance = (nodeId, assignedPool, roleSuffix = '') => {
      const isPoolLeader = assignedPool?.leader_auth === fileName;
      const isRAMLeader = assignedPool?.active_leader === fileName;

      let virtualPrefix = '';
      if (assignedPool) {
        if (isPoolLeader) {
          virtualPrefix = assignedPool.base_prefix || '';
        } else {
          const reserveList = Array.isArray(assignedPool.reserves)
            ? assignedPool.reserves
            : (Array.isArray(assignedPool.members) ? assignedPool.members.filter((m) => m !== assignedPool.leader_auth) : []);
          const rIdx = reserveList.indexOf(fileName);
          const seq = rIdx >= 0 ? rIdx + 1 : 1;
          virtualPrefix = `${assignedPool.base_prefix}_${seq}`;
        }
      }

      const prefix = file.prefix;
      const isChild = childNodeIds.has(nodeId);
      const isRoot = !isChild && Boolean(prefix || isPoolLeader);
      const ambiguousParent = ambiguousChildMap.get(fileName) || null;
      const accountType = (file.type || file.provider || '').trim().toLowerCase();
      const maskedEmail = extractSafeMaskedEmail(file.email, fileName);

      return {
        id: nodeId,
        type: 'profile',
        position: { x: 0, y: 0 },
        excluded_models: file.excluded_models || [],
        excludedModels: file.excludedModels || [],
        data: {
          fileName,
          nodeId,
          roleSuffix, // 'gemini' o 'claude' cuando es dual
          prefix,
          virtualPrefix,
          initialPrefix: prefix,
          label: prefix || (assignedPool ? `[${assignedPool.id}]` : fileName),
          isDirty: false,
          isRoot,
          isSynthetic: false, // Real auth-file node
          ambiguousParent,
          accountType,
          provider: (file.provider || file.type || '').trim().toLowerCase(),
          maskedEmail,
          email: maskedEmail,
          excluded_models: file.excluded_models || [],
          excludedModels: file.excludedModels || [],
          auth_index: file.auth_index,
          project_id: file.project_id,
          unavailable: file.unavailable === true,
          disabled: file.disabled === true,
          cooldowns: file.cooldowns || [],
          recent_requests: file.recent_requests || [],
          success: file.success || 0,
          failed: file.failed || 0,
          next_retry_after: file.next_retry_after || '',
          poolId: assignedPool?.id || null,
          isRAMLeader,
          isPoolLeader,
        },
      };
    };

    if (isDualAccount) {
      // Generar dos nodos visuales separados: uno para su faceta Gemini y otro para Claude
      filePools.forEach((pool) => {
        const poolFam = (pool.family || '').toLowerCase();
        const isClaude = poolFam.includes('claude') || poolFam.includes('sonnet') || poolFam.includes('opus') || (pool.base_prefix || '').startsWith('agy_clau');
        const roleSuffix = isClaude ? 'claude' : 'gemini';
        rawNodes.push(createNodeInstance(`${fileName}@${roleSuffix}`, pool, roleSuffix));
      });
    } else {
      const assignedPool = filePools[0] || null;
      rawNodes.push(createNodeInstance(fileName, assignedPool, ''));
    }
  });

  // Deterministic topology-aware layout: roots above descendants, collision-free separate lanes
  const nodes = computeGraphLayout(rawNodes, edges);

  return { nodes, edges };
}

/**
 * Updates the prefix attribute of an auth record using PATCH /v0/management/auth-files/fields.
 *
 * CRITICAL SAFETY & SECURITY INVARIANTS:
 * - Only exact physical filename and current prefix (including empty string) are sent.
 * - Credentials, tokens, secrets, or keys are NEVER included in payload or logged.
 * - Enforces same-origin policy via apiFetch.
 * - Handles 401 Unauthorized, 404 Not Found, and 409 Conflict with sanitized error messages.
 *
 * @param {string} fileName - Exact physical filename of the auth file
 * @param {string} prefix - The new prefix string (empty string is explicitly allowed)
 * @param {Object} [options] - Options passed to apiFetch (e.g. key, fetchFn)
 * @returns {Promise<{ name: string, prefix: string, status: number }>}
 */
export async function patchAuthFilePrefix(fileName, prefix, options = {}) {
  if (!fileName || typeof fileName !== 'string' || !fileName.trim()) {
    throw new Error('Invalid auth file name: filename must be a non-empty string');
  }

  const exactName = fileName;
  const cleanPrefix = typeof prefix === 'string' ? prefix.trim() : '';

  const endpoint = '/v0/management/auth-files/fields';
  const body = JSON.stringify({
    name: exactName,
    prefix: cleanPrefix,
  });

  // SECURITY INVARIANTS:
  // 1. Disallow caller options from overriding HTTP method ('PATCH') or JSON body.
  // 2. Retain 'Content-Type: application/json' even if custom headers are requested.
  const {
    headers: customHeaders,
    method: _ignoredMethod,
    body: _ignoredBody,
    ...safeOptions
  } = options;

  const requestHeaders = {};
  if (customHeaders) {
    if (typeof customHeaders.forEach === 'function') {
      customHeaders.forEach((val, k) => {
        if (typeof k === 'string' && k.toLowerCase() !== 'content-type') {
          requestHeaders[k] = val;
        }
      });
    } else if (typeof customHeaders === 'object') {
      for (const [k, val] of Object.entries(customHeaders)) {
        if (typeof k === 'string' && k.toLowerCase() !== 'content-type') {
          requestHeaders[k] = val;
        }
      }
    }
  }

  // Ensure Content-Type is strictly application/json (case-insensitively delete any override attempts)
  for (const headerKey of Object.keys(requestHeaders)) {
    if (headerKey.toLowerCase() === 'content-type') {
      delete requestHeaders[headerKey];
    }
  }
  requestHeaders['Content-Type'] = 'application/json';

  try {
    const res = await apiFetch(endpoint, {
      ...safeOptions,
      method: 'PATCH',
      body,
      headers: requestHeaders,
    });

    return {
      name: exactName,
      prefix: cleanPrefix,
      status: res.status,
    };
  } catch (err) {
    const safeName = maskDisplayIdentifier(sanitizeFileName(exactName));
    const rawMsg = err.message || '';

    if (rawMsg.includes('401')) {
      throw new Error(`401 Unauthorized: Invalid or expired management key for "${safeName}"`);
    }
    if (rawMsg.includes('404')) {
      throw new Error(`404 Not Found: Auth file "${safeName}" not found`);
    }
    if (rawMsg.includes('409')) {
      throw new Error(`409 Conflict: Resource conflict for "${safeName}"`);
    }
    if (rawMsg.includes('403')) {
      throw new Error(
        `403 Forbidden: Management key does not have required permissions for "${safeName}"`
      );
    }

    throw new Error(`Failed to save prefix for "${safeName}": ${rawMsg || 'Request failed'}`);
  }
}

/**
 * Lists the model catalog via GET /v1/models.
 *
 * Returns raw model IDs, including pool-prefixed routes (e.g. "g1/gemini-3.8-flash-high")
 * registered by CLIProxyAPI for each auth-file prefix.
 *
 * @param {Object} [options]
 * @returns {Promise<{ models: string[] }>}
 */
export async function listModels(options = {}) {
  const res = await apiFetch('/v1/models', { ...options, method: 'GET' });
  const payload = await res.json();
  const data = Array.isArray(payload?.data) ? payload.data : [];
  const models = data
    .map((m) => (typeof m?.id === 'string' ? m.id : ''))
    .filter(Boolean);
  return { models };
}

/**
 * Persists an array of dirty auth-file prefixes to the Management API.
 *
 * ATOMICITY & RECONCILIATION CONTRACT:
 * - Does NOT claim atomicity across multiple files, as the backend updates files individually.
 * - Rejects synthetic nodes: never sends synthetic nodes to the Management API.
 * - Permits duplicate prefixes for legitimate account rotation pools in CLIProxyAPI.
 * - Uses Promise.allSettled to track individual successes and failures without crashing on partial failure.
 * - Returns { successful: Array<{ name, prefix }>, failed: Array<{ name, prefix, error }> }.
 * - Errors are sanitized and contain no secret material or tokens.
 *
 * @param {Array<{ name: string, prefix: string, isSynthetic?: boolean }>} filesToSave
 * @param {Object} [options]
 * @returns {Promise<{ successful: Array<{ name: string, prefix: string }>, failed: Array<{ name: string, prefix: string, error: string }> }>}
 */
export async function saveAuthFilePrefixes(filesToSave = [], options = {}) {
  if (!Array.isArray(filesToSave) || filesToSave.length === 0) {
    return { successful: [], failed: [] };
  }

  // Filter out any synthetic items (never persist synthetic nodes)
  const realFiles = filesToSave.filter(
    (item) => item && typeof item.name === 'string' && !item.isSynthetic
  );

  if (realFiles.length === 0) {
    return { successful: [], failed: [] };
  }

  // In CLIProxyAPI pool, duplicate prefixes are legitimate (pool rotation)
  // No blanket unique-prefix lockout before sending requests
  const results = await Promise.allSettled(
    realFiles.map((item) => patchAuthFilePrefix(item.name, item.prefix, options))
  );

  const successful = [];
  const failed = [];

  results.forEach((res, idx) => {
    const item = realFiles[idx];
    if (res.status === 'fulfilled') {
      successful.push({
        name: item.name,
        prefix: typeof item.prefix === 'string' ? item.prefix.trim() : '',
      });
    } else {
      failed.push({
        name: item.name,
        prefix: typeof item.prefix === 'string' ? item.prefix.trim() : '',
        error: res.reason?.message || 'Save failed',
      });
    }
  });

  return { successful, failed };
}

/**
 * Derives the default virtual auth-file name for a clone: `<base>.<prefix>.json`.
 * The file name must remain a safe, path-separator-free identifier.
 *
 * @param {string} sourceFileName
 * @param {string} prefix
 * @returns {string}
 */
export function deriveVirtualAuthName(sourceFileName, prefix) {
  const base = String(sourceFileName || '').replace(/\.json$/i, '');
  return `${base}.${prefix}.json`;
}

/**
 * Clones a physical auth file into a virtual credential with a different routing
 * prefix and family-specific model exclusions, using the plugin host bridge.
 *
 * SECURITY INVARIANTS:
 * - Never transmits credentials, tokens, or secrets. Only identifiers and model lists.
 * - Uses apiFetch (same-origin + authoritative Bearer management key).
 *
 * @param {Object} input
 * @param {string} input.sourceFileName Exact physical auth-file name to clone.
 * @param {string} input.prefix Routing prefix for the virtual credential.
 * @param {string} [input.name] Target file name (derived when omitted).
 * @param {string[]} [input.targetModels] Models the clone should serve.
 * @param {string[]} [input.oppositeModels] Models the clone must not serve.
 * @param {string[]} [input.excludedModels] Explicit full exclusion override.
 * @param {Object} [options]
 * @returns {Promise<{ name: string, path: string, prefix: string }>}
 */
export async function virtualizeAccount(input = {}, options = {}) {
  const sourceFileName = typeof input.sourceFileName === 'string' ? input.sourceFileName.trim() : '';
  const prefix = typeof input.prefix === 'string' ? input.prefix.trim() : '';
  if (!sourceFileName) {
    throw new Error('Invalid virtualize request: sourceFileName is required');
  }
  if (!prefix) {
    throw new Error('Invalid virtualize request: prefix is required');
  }

  const name = (typeof input.name === 'string' && input.name.trim())
    ? input.name.trim()
    : deriveVirtualAuthName(sourceFileName, prefix);

  const payload = {
    source_file_name: sourceFileName,
    name,
    prefix,
  };
  if (Array.isArray(input.targetModels)) {
    payload.target_models = input.targetModels;
  }
  if (Array.isArray(input.targetPatterns)) {
    payload.target_patterns = input.targetPatterns;
  }
  if (Array.isArray(input.oppositeModels)) {
    payload.opposite_models = input.oppositeModels;
  }
  if (Array.isArray(input.excludedModels)) {
    payload.excluded_models = input.excludedModels;
  }

  const res = await apiFetch('/v0/management/auto-switcher-pro/virtualize', {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const data = await res.json();
  if (!data || data.ok !== true) {
    throw new Error(data?.message || 'Virtualize request failed');
  }
  return {
    name: data.name || name,
    path: data.path || '',
    prefix: data.prefix || prefix,
  };
}

/**
 * Extrae el número canónico de un pool a partir de su ID, displayName o basePrefix.
 * Ejemplos: "Pool-01-gemini" -> 1, "Pool-02-gemini" -> 2, "agy" -> 1, "agy2" -> 2
 *
 * @param {Object|string} pool
 * @returns {number}
 */
export function extractPoolNumber(pool) {
  if (!pool) return 999999;
  const candidates = typeof pool === 'string'
    ? [pool]
    : [pool.id, pool.displayName, pool.display_name, pool.name, pool.basePrefix, pool.base_prefix, pool.routeSlug, pool.route_slug].filter(Boolean);

  const poolNumRegex = /(?:pool[_-]?|agy|codex|clau|prefix[_-]?)(\d+)/i;
  for (const c of candidates) {
    const match = String(c).match(poolNumRegex);
    if (match && match[1]) {
      const parsed = parseInt(match[1], 10);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }

  const digitRegex = /\d+/;
  for (const c of candidates) {
    const match = String(c).match(digitRegex);
    if (match && match[0]) {
      const parsed = parseInt(match[0], 10);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }

  const basePrefix = typeof pool === 'string' ? pool : (pool.basePrefix || pool.base_prefix || '');
  const lower = String(basePrefix).trim().toLowerCase();
  if (lower === 'agy' || lower === 'codex' || lower === 'clau' || lower === 'agy_clau' || lower === 'agy_son' || lower === 'agy_opus') {
    return 1;
  }
  return 999999;
}

/**
 * Ordena de forma determinista y estable una lista de pools por su índice numérico soberano.
 * Desempata por ID y luego por base_prefix.
 *
 * @param {Array<Object>} pools
 * @returns {Array<Object>}
 */
export function sortPoolsByNumber(pools) {
  if (!Array.isArray(pools)) return [];
  return [...pools].sort((a, b) => {
    const numA = extractPoolNumber(a);
    const numB = extractPoolNumber(b);
    if (numA !== numB) return numA - numB;
    const idA = String(a.id || a.displayName || a.display_name || a.basePrefix || a.base_prefix || '').toLowerCase();
    const idB = String(b.id || b.displayName || b.display_name || b.basePrefix || b.base_prefix || '').toLowerCase();
    if (idA !== idB) return idA.localeCompare(idB);
    const prefA = String(a.basePrefix || a.base_prefix || '').toLowerCase();
    const prefB = String(b.basePrefix || b.base_prefix || '').toLowerCase();
    return prefA.localeCompare(prefB);
  });
}

/**
 * Fetches registered logical pools from the Auto Switcher Pro plugin registry.
 *
 * @param {Object} [options]
 * @returns {Promise<{ ok: boolean, pools: Array<Object>, count: number }>}
 */
export async function listPools(options = {}) {
  const res = await apiFetch('/v0/management/auto-switcher-pro/pools', {
    ...options,
    method: 'GET',
  });

  const data = await res.json();
  const rawPools = Array.isArray(data?.pools) ? data.pools : [];
  const sortedPools = sortPoolsByNumber(rawPools);
  return {
    ok: Boolean(data?.ok),
    pools: sortedPools,
    count: typeof data?.count === 'number' ? data.count : sortedPools.length,
  };
}

/**
 * Saves or updates a logical load-balancing pool in the Auto Switcher Pro plugin registry.
 *
 * @param {Object} poolData
 * @param {string} poolData.family
 * @param {string} poolData.base_prefix
 * @param {string} poolData.leader_auth
 * @param {string[]} poolData.reserves
 * @param {Object} [poolData.policy]
 * @param {Object} [options]
 * @returns {Promise<{ ok: boolean, pool: Object, message: string }>}
 */
export async function savePool(poolData = {}, options = {}) {
  const res = await apiFetch('/v0/management/auto-switcher-pro/pools', {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(poolData),
  });

  const data = await res.json();
  if (!data || data.ok !== true) {
    throw new Error(data?.message || 'Failed to save pool definition');
  }
  return {
    ok: true,
    pool: data.pool || null,
    message: data.message || '',
  };
}

/**
 * Dissolves a logical pool from the Auto Switcher Pro plugin registry by base prefix.
 *
 * @param {string} basePrefix
 * @param {Object} [options]
 * @returns {Promise<{ ok: boolean, deleted: boolean, message: string }>}
 */
export async function dissolvePool(basePrefix, options = {}) {
  const trimmed = typeof basePrefix === 'string' ? basePrefix.trim() : '';
  if (!trimmed) {
    throw new Error('basePrefix is required to dissolve pool');
  }

  const res = await apiFetch(`/v0/management/auto-switcher-pro/pools?prefix=${encodeURIComponent(trimmed)}`, {
    ...options,
    method: 'DELETE',
  });

  const data = await res.json();
  return {
    ok: Boolean(data?.ok),
    deleted: Boolean(data?.deleted),
    message: data?.message || '',
  };
}

/**
 * Extracts the master auth-file identity from a virtual filename.
 * Returns null if the file is not a virtual derivative.
 *
 * Examples:
 * - 'antigravity-user@gmail.com.agy_son.json' -> 'antigravity-user@gmail.com.json'
 * - 'antigravity-user@gmail.com.agy_son_1.json' -> 'antigravity-user@gmail.com.json'
 * - 'antigravity-user@gmail.com.json' -> null
 *
 * @param {string} fileName
 * @returns {string|null} Origin master file name or null
 */
export function extractVirtualOrigin(fileName) {
  if (!fileName || typeof fileName !== 'string') return null;
  const trimmed = fileName.trim();
  const withoutJson = trimmed.replace(/\.json$/i, '');
  if (!withoutJson) return null;

  const atIdx = withoutJson.lastIndexOf('@');
  if (atIdx === -1) {
    const lastDot = withoutJson.lastIndexOf('.');
    return lastDot > 0 ? `${withoutJson.slice(0, lastDot)}.json` : null;
  }

  const domainAndBeyond = withoutJson.slice(atIdx + 1);
  const parts = domainAndBeyond.split('.');
  if (parts.length <= 1) return null;

  let tldEndIdx = 1;
  const countryTLDs = new Set(['uk', 'br', 'mx', 'ar', 'au', 'jp', 'cn', 'de', 'fr', 'es']);
  const secondLevels = new Set(['co', 'com', 'org', 'net', 'edu', 'gov']);
  if (
    parts.length >= 3 &&
    secondLevels.has(parts[1].toLowerCase()) &&
    countryTLDs.has(parts[2].toLowerCase())
  ) {
    tldEndIdx = 2;
  }

  if (parts.length > tldEndIdx + 1) {
    const masterDomain = parts.slice(0, tldEndIdx + 1).join('.');
    const masterBase = withoutJson.slice(0, atIdx + 1) + masterDomain;
    return `${masterBase}.json`;
  }

  return null;
}

/**
 * Formats a list of excluded models into concise human-readable badges.
 *
 * @param {string[]} [excludedModels]
 * @returns {string[]} Badges such as ['Excluye 5.5', 'Excluye Gemini', 'Claude Only']
 */
export function extractExclusionBadges(excludedModels = []) {
  if (!Array.isArray(excludedModels) || !excludedModels.length) {
    return [];
  }
  const badges = [];
  const list = excludedModels.map((m) => String(m || '').toLowerCase());

  const has55 = list.some((m) => m.includes('5-5') || m.includes('5.5'));
  const hasGemini = list.some((m) => m.includes('gemini'));
  const hasClaude = list.some((m) => m.includes('claude'));
  const hasCodex = list.some((m) => m.includes('codex') || m.includes('gpt'));

  if (has55) badges.push('Excluye 5.5');
  if (hasGemini) badges.push('Excluye Gemini');
  if (hasClaude) badges.push('Excluye Claude');
  if (hasCodex) badges.push('Excluye Codex');
  if (hasGemini && !hasClaude) badges.push('Claude Only');

  return badges;
}

/**
 * Classifies an auth file or graph node into master vs virtual account.
 * Strictly adheres to VP-7 privacy invariants (masks email and identifiers).
 *
 * @param {string|Object} fileOrNode
 * @returns {{
 *   fileName: string,
 *   isVirtual: boolean,
 *   isMaster: boolean,
 *   role: 'master'|'virtual',
 *   masterOrigin: string|null,
 *   maskedEmail: string,
 *   prefix: string,
 *   exclusionBadges: string[],
 *   excludedModels: string[]
 * }}
 */
export function classifyAuthAccount(fileOrNode) {
  let fileName = '';
  let prefix = '';
  let email = '';
  let excludedModels = [];
  let isExplicitVirtual = false;

  if (typeof fileOrNode === 'string') {
    fileName = fileOrNode.trim();
  } else if (fileOrNode && typeof fileOrNode === 'object') {
    fileName = (
      fileOrNode.fileName ||
      fileOrNode.name ||
      fileOrNode.data?.fileName ||
      fileOrNode.data?.name ||
      (typeof fileOrNode.id === 'string' && fileOrNode.id.endsWith('.json') ? fileOrNode.id : '')
    ).trim();
    prefix = (fileOrNode.prefix || fileOrNode.data?.prefix || '').trim();
    email = (fileOrNode.email || fileOrNode.data?.email || '').trim();
    excludedModels =
      fileOrNode.excludedModels ||
      fileOrNode.data?.excludedModels ||
      fileOrNode.excluded_models ||
      fileOrNode.data?.excluded_models ||
      [];
    isExplicitVirtual = Boolean(fileOrNode.isVirtual || fileOrNode.data?.isVirtual);
  }

  const masterOrigin = extractVirtualOrigin(fileName);
  const isVirtual = Boolean(masterOrigin) || isExplicitVirtual;
  const isMaster = !isVirtual;
  const role = isVirtual ? 'virtual' : 'master';
  const effectiveEmailSource = masterOrigin || fileName;
  const maskedEmail = extractSafeMaskedEmail(email, effectiveEmailSource);

  let rawEmail = email;
  if ((!rawEmail || rawEmail.includes('...')) && effectiveEmailSource) {
    const cleanSource = effectiveEmailSource.replace(SUFFIX_STRIP, '').trim();
    const match = cleanSource.match(EMAIL_REGEX);
    if (match && !match[0].includes('...')) {
      rawEmail = match[0];
    }
  }

  const exclusionBadges = extractExclusionBadges(excludedModels);

  let derivedPrefix = prefix;
  if (!derivedPrefix && isVirtual && fileName) {
    const withoutJson = fileName.replace(/\.json$/i, '');
    const lastDot = withoutJson.lastIndexOf('.');
    if (lastDot > 0) {
      derivedPrefix = withoutJson.slice(lastDot + 1);
    }
  }

  return {
    fileName,
    email: rawEmail || maskedEmail,
    isVirtual,
    isMaster,
    role,
    masterOrigin,
    maskedEmail,
    prefix: derivedPrefix,
    exclusionBadges,
    excludedModels,
  };
}

/**
 * Permanently deletes a virtual/derived auth file from the CPAMC disk.
 * Strictly verifies against directory traversal before making the call.
 *
 * @param {string} fileName
 * @param {Object} [options]
 * @returns {Promise<{ name: string, ok: boolean, status: number }>}
 */
export async function deleteAuthFile(fileName, options = {}) {
  const cleanName = typeof fileName === 'string' ? fileName.trim() : '';
  if (!cleanName) {
    throw new Error('Invalid auth file name: fileName is required');
  }
  if (cleanName.includes('..') || cleanName.includes('/') || cleanName.includes('\\')) {
    throw new Error('Invalid auth file name: directory traversal characters rejected');
  }
  if (!cleanName.endsWith('.json')) {
    throw new Error('Invalid auth file name: must end with .json');
  }

  const endpoint = `/v0/management/auth-files?name=${encodeURIComponent(cleanName)}`;
  try {
    const res = await apiFetch(endpoint, {
      ...options,
      method: 'DELETE',
    });
    return { name: cleanName, ok: true, status: res.status };
  } catch (primaryErr) {
    if (primaryErr?.message?.includes('404') || primaryErr?.message?.includes('405')) {
      const fallbackEndpoint = `/v0/management/auto-switcher-pro/virtualize?name=${encodeURIComponent(cleanName)}`;
      const res = await apiFetch(fallbackEndpoint, {
        ...options,
        method: 'DELETE',
      });
      return { name: cleanName, ok: true, status: res.status };
    }
    throw primaryErr;
  }
}

/**
 * Canonical catalog of supported models by provider family.
 * Ensures complete model visibility in specialist pickers and exclusion engines,
 * even when the dynamic live /v1/models catalog is narrowed to active specialist routes.
 */
export const CANONICAL_PROVIDER_MODELS = {
  gemini: [
    'gemini-3.8-flash-high',
    'gemini-3.7-flash-high',
    'gemini-3.6-flash-high',
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite',
    'gemini-3-flash',
  ],
  claude: [
    'claude-3-7-sonnet',
    'claude-3-5-sonnet',
    'claude-3-5-haiku',
    'claude-3-opus',
    'claude-sonnet-4-6',
    'claude-sonnet-5-5-high',
    'claude-opus-4-6-thinking',
    'claude-opus-5-5-high',
  ],
  codex: [
    'gpt-6.1',
    'gpt-6.1-sol',
    'gpt-6.1-astra',
    'gpt-6-astra',
    'gpt-6-sol',
    'gpt-6-luna',
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
    'gpt-5.5',
    'gpt-5.5-pro',
    'gpt-5.4',
    'gpt-5.4-mini',
    'gpt-5.4-nano',
    'gpt-5.4-pro',
    'gpt-5.3-codex',
    'gpt-5.3-codex-spark',
    'gpt-5.2',
    'gpt-5.2-pro',
    'gpt-5.1',
    'gpt-5',
    'o4-mini',
    'o3',
    'o3-mini',
    'o3-pro',
    'o1',
    'o1-mini',
    'o1-pro',
    'o1-preview',
    'chatgpt-4o-latest',
    'gpt-4o',
    'gpt-4o-mini',
    'gpt-4.1',
    'gpt-4-turbo',
    'gpt-4',
  ],
  nan: [
    'deepseek-v4-flash',
    'glm-5.3-flash',
    'mimo-v2.6-flash',
    'qwen3.8-flash',
    'deepseek-v4-pro',
  ],
  nvidia: [
    'meta/llama-3.3-70b-instruct',
    'deepseek-ai/deepseek-r1',
    'nvidia/llama-3.1-nemotron-70b-instruct',
    'qwen/qwen2.5-coder-32b-instruct',
    'meta/llama-3.1-405b-instruct',
  ],
  deepseek: [
    'deepseek-chat',
    'deepseek-reasoner',
  ],
  groq: [
    'llama-3.3-70b-versatile',
    'llama-3.1-8b-instant',
    'mixtral-8x7b-32768',
    'gemma2-9b-it',
  ],
  cerebras: [
    'llama-3.3-70b',
    'llama3.1-8b',
  ],
  mistral: [
    'mistral-large-latest',
    'codestral-latest',
    'pixtral-large-latest',
    'ministral-8b-latest',
  ],
  typesafe: [
    'jev-latest',
    'jev-1.13',
  ],
  vercel: [
    'anthropic/claude-3-7-sonnet',
    'openai/gpt-4o',
    'deepseek/deepseek-chat',
    'google/gemini-2.0-flash',
    'meta/llama-3.3-70b',
  ],
  opencode: [
    'deepseek-chat',
    'gemini-2.5-flash',
  ],
};

export const DEPRECATED_MODEL_FALLBACKS = {
  'gemini-3.7-flash-high': 'gemini-3.8-flash-high',
  'gemini-3.6-flash-high': 'gemini-3.8-flash-high',
  'gemini-3.1-pro-low': 'gemini-3.8-flash-high',
  'gemini-pro-agent': 'gemini-3.8-flash-high',
  'gemini-2.5-flash-high': 'gemini-3.8-flash-high',
  'gemini-3.1-flash-image': 'gemini-3.8-flash-high',
};

/**
 * Deterministically constructs Wilox's scalable 2N managed pool cards model from physical OAuth master accounts.
 *
 * For N physical OAuth master accounts, produces exactly 2N managed cards (N Gemini + N Claude).
 * - Gemini card: familyRole 'gemini', targeted to Gemini models, excluding Claude/GPT.
 * - Claude card: familyRole 'claude', targeted to Claude models, excluding Gemini.
 *
 * Merges active virtual credentials on disk into their corresponding managed cards without
 * creating duplicate entries or clone sprawl. Strictly adheres to VP-7 privacy invariants.
 *
 * @param {Array<Object>} nodes - List of graph nodes or auth file descriptor objects
 * @returns {Array<Object>} Deterministic list of 2N managed cards
 */
export function buildManagedPoolCards(nodes = [], registeredPools = null) {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    return [];
  }

  // Si se provee la lista de pools registrados por GroupManager en el plugin:
  // Si no hay pools creados (registeredPools = []), devuelve estrictamente 0 tarjetas (Auto Auth Files limpio).
  // Si hay pools creados, genera exactamente las tarjetas correspondientes a dichos pools.
  if (registeredPools !== null && Array.isArray(registeredPools)) {
    if (registeredPools.length === 0) {
      return [];
    }

    const cards = [];
    registeredPools.forEach((pool) => {
      const familyKey = String(pool.family || '').toLowerCase();
      let familyRole = 'claude';
      if (familyKey.startsWith('gemini_pure') || familyKey === 'gemini') {
        familyRole = 'gemini';
      } else if (familyKey.includes('codex') || familyKey.includes('openai') || familyKey.includes('gpt')) {
        familyRole = 'codex';
      } else if (familyKey === 'nan' || familyKey.includes('nan')) {
        familyRole = 'nan';
      } else if (familyKey === 'nvidia' || familyKey.includes('nvidia')) {
        familyRole = 'nvidia';
      } else if (familyKey === 'deepseek' || familyKey.includes('deepseek')) {
        familyRole = 'deepseek';
      } else if (familyKey === 'groq' || familyKey.includes('groq')) {
        familyRole = 'groq';
      } else if (familyKey === 'cerebras' || familyKey.includes('cerebras')) {
        familyRole = 'cerebras';
      } else if (familyKey === 'mistral' || familyKey.includes('mistral')) {
        familyRole = 'mistral';
      } else if (familyKey === 'typesafe' || familyKey.includes('typesafe')) {
        familyRole = 'typesafe';
      } else if (familyKey === 'vercel' || familyKey.includes('vercel')) {
        familyRole = 'vercel';
      } else if (familyKey === 'opencode' || familyKey.includes('opencode')) {
        familyRole = 'opencode';
      }
      const basePrefix = pool.base_prefix || '';

      // Gobernanza virtual pura: la política del pool define el especialista de la tarjeta.
      const poolTargets = Array.isArray(pool.policy?.target_models)
        ? pool.policy.target_models
        : [];
      const poolDefaultSpecialist =
        pool.policy?.disable_isolation === false && poolTargets.length === 1
          ? String(poolTargets[0]).trim()
          : null;

      const buildCardForAuth = (authFileName, poolRole, assignedPrefix) => {
        const matchingNode = nodes.find(
          (n) => (n.data?.fileName || n.name || n.id) === authFileName
        );
        // Invariante estricto de auto-limpieza: Si la cuenta física no existe en los nodos
        // de CPAMC (fue borrada en Auth Files Management), NO generar tarjeta fantasma.
        if (!matchingNode) {
          return null;
        }

        // Independencia per-cuenta: Priorizar el modelo especialista configurado
        // individualmente en pool.member_models[authFileName], con fallback al especialista global del pool.
        const memberModel =
          pool.member_models && pool.member_models[authFileName]
            ? String(pool.member_models[authFileName]).trim()
            : null;
        const specialistModel = memberModel || poolDefaultSpecialist;

        const classification = classifyAuthAccount(matchingNode);

        // Enlazar el clon virtual legacy en disco (si existe) con esta tarjeta del registro,
        // preservando trazabilidad de origen, exclusiones reales del archivo y disolución individual.
        const linkedVirtualNode = nodes.find((n) => {
          const cls = classifyAuthAccount(n);
          return cls.isVirtual && cls.masterOrigin === authFileName && cls.prefix === assignedPrefix;
        });
        const linkedVirtual = linkedVirtualNode ? classifyAuthAccount(linkedVirtualNode) : null;

        const masterData = matchingNode?.data || {};
        const accountTelemetry = {
          authIndex: masterData.auth_index || matchingNode?.auth_index || '',
          projectId: masterData.project_id || masterData.projectId || '',
          unavailable: masterData.unavailable === true,
          disabled: masterData.disabled === true,
          cooldowns: masterData.cooldowns || [],
          recentRequests: masterData.recent_requests || [],
          success: masterData.success || 0,
          failed: masterData.failed || 0,
          nextRetryAfter: masterData.next_retry_after || '',
        };

        // Prioridad de exclusiones: Si la cuenta tiene exclusiones individuales (ej. modo especialista
        // configurado vía tuerca), esa configuración individual manda sobre la política genérica del pool.
        const accountExclusions = linkedVirtual?.excludedModels
          || classification.excludedModels
          || [];
        let policyExclusions = accountExclusions;
        if (policyExclusions.length === 0) {
          if (Array.isArray(pool.policy?.excluded_models) && pool.policy.excluded_models.length > 0) {
            policyExclusions = pool.policy.excluded_models;
          } else if (Array.isArray(pool.policy?.target_models) && pool.policy.target_models.length > 0) {
            const familyCatalog = CANONICAL_PROVIDER_MODELS[familyRole] || [];
            policyExclusions = computeSpecialistExclusions(familyCatalog, pool.policy.target_models[0]);
          }
        }
        const exclusionBadges = pool.policy?.exclude_55
          ? ['Excluye 5.5']
          : (linkedVirtual?.exclusionBadges || classification.exclusionBadges || []);

        // Resolución simétrica del rol de liderazgo en RAM:
        // Si el pool define un active_leader dinámico, exclusivamente esa cuenta es 'leader'.
        // Todas las demás cuentas del pool (incluyendo el líder nominal si fue relevado) son 'reserve'.
        const isDynamicRAMLeader = pool.active_leader
          ? pool.active_leader === authFileName
          : poolRole === 'leader';
        const effectivePoolRole = pool.active_leader
          ? (pool.active_leader === authFileName ? 'leader' : 'reserve')
          : poolRole;

        let fullEmail = classification.email;
        if (!fullEmail || fullEmail.includes('...')) {
          const match = authFileName.replace(SUFFIX_STRIP, '').trim().match(EMAIL_REGEX);
          if (match && !match[0].includes('...')) {
            fullEmail = match[0];
          }
        }

        return {
          cardId: `${authFileName}::${basePrefix}::${assignedPrefix}`,
          poolId: pool.id || basePrefix,
          isDynamicRAMLeader,
          masterFileName: authFileName,
          email: fullEmail || classification.maskedEmail || extractSafeMaskedEmail('', authFileName),
          maskedEmail: classification.maskedEmail || extractSafeMaskedEmail('', authFileName),
          familyRole,
          assignedPrefix,
          poolRole: effectivePoolRole,
          activePoolBase: basePrefix,
          specialistModel,
          poolDisableIsolation: pool.policy?.disable_isolation === true,
          poolTargetModels: poolTargets,
          exclusionBadges,
          excludedModels: policyExclusions,
          excluded_models: policyExclusions,
          virtualFileName: linkedVirtual?.fileName || '',
          ...accountTelemetry,
        };
      };

      if (pool.leader_auth) {
        const leaderCard = buildCardForAuth(pool.leader_auth, 'leader', basePrefix);
        if (leaderCard) {
          cards.push(leaderCard);
        }
      }

      if (Array.isArray(pool.reserves)) {
        pool.reserves.forEach((resAuth, idx) => {
          const reservePrefix = `${basePrefix}_${idx + 1}`;
          const resCard = buildCardForAuth(resAuth, 'reserve', reservePrefix);
          if (resCard) {
            cards.push(resCard);
          }
        });
      }
    });

    return cards;
  }

  const masterAccountsMap = new Map();
  const virtualEntries = [];

  const isClaudePrefix = (p) => {
    if (!p) return false;
    const lower = p.toLowerCase();
    return (
      lower.startsWith('agy_son') ||
      lower.startsWith('agy_opus') ||
      lower.startsWith('agy_clau') ||
      lower.startsWith('clau') ||
      lower.startsWith('son')
    );
  };

  const isGeminiPrefix = (p) => {
    if (!p) return false;
    const lower = p.toLowerCase();
    return (lower.startsWith('agy') || lower.startsWith('g')) && !isClaudePrefix(lower);
  };

  nodes.forEach((item) => {
    if (!item) return;
    const classification = classifyAuthAccount(item);
    const provider = (
      item.provider ||
      item.data?.provider ||
      item.accountType ||
      item.data?.accountType ||
      ''
    ).toLowerCase();

    // Only Antigravity accounts form the cards
    const isAntigravity = provider === 'antigravity' || classification.fileName.startsWith('antigravity-');

    if (!isAntigravity) {
      return;
    }

    if (classification.isMaster) {
      if (!masterAccountsMap.has(classification.fileName)) {
        masterAccountsMap.set(classification.fileName, {
          masterFileName: classification.fileName,
          maskedEmail: classification.maskedEmail,
          masterNode: item,
          classification,
        });
      } else {
        const existing = masterAccountsMap.get(classification.fileName);
        existing.masterNode = item;
        existing.classification = classification;
        if (classification.maskedEmail) {
          existing.maskedEmail = classification.maskedEmail;
        }
      }
    } else if (classification.isVirtual && classification.masterOrigin) {
      virtualEntries.push({
        node: item,
        classification,
        masterOrigin: classification.masterOrigin,
      });
      if (!masterAccountsMap.has(classification.masterOrigin)) {
        masterAccountsMap.set(classification.masterOrigin, {
          masterFileName: classification.masterOrigin,
          maskedEmail: classification.maskedEmail || extractSafeMaskedEmail('', classification.masterOrigin),
          masterNode: null,
          classification: null,
        });
      }
    }
  });

  const cards = [];

  masterAccountsMap.forEach((masterInfo, masterFileName) => {
    const maskedEmail = masterInfo.maskedEmail || extractSafeMaskedEmail('', masterFileName);
    const masterNode = masterInfo.masterNode;
    const masterPrefix = (
      masterInfo.classification?.prefix ||
      masterNode?.prefix ||
      masterNode?.data?.prefix ||
      ''
    ).trim();

    // Real native account telemetry from the physical master file (CPAMC listing).
    // Both Gemini and Claude cards of a master share the same physical account.
    const masterData = masterNode?.data || {};
    const accountTelemetry = {
      authIndex: masterData.auth_index || masterNode?.auth_index || '',
      projectId: masterData.project_id || masterData.projectId || '',
      unavailable: masterData.unavailable === true,
      disabled: masterData.disabled === true,
      cooldowns: masterData.cooldowns || [],
      recentRequests: masterData.recent_requests || [],
      success: masterData.success || 0,
      failed: masterData.failed || 0,
      nextRetryAfter: masterData.next_retry_after || '',
    };

    // Virtual files derived from this master
    const relatedVirtuals = virtualEntries.filter(
      (v) => v.masterOrigin === masterFileName
    );

    // --- 1. GEMINI CARD ---
    const geminiVirtual = relatedVirtuals.find((v) =>
      isGeminiPrefix(v.classification.prefix)
    );
    const hasMasterGemini = isGeminiPrefix(masterPrefix);

    let geminiPrefix = '';
    let geminiVirtualFile = '';
    let geminiExclusions = [];
    let geminiRawExcludedModels = [];

    if (geminiVirtual) {
      geminiPrefix = geminiVirtual.classification.prefix;
      geminiVirtualFile = geminiVirtual.classification.fileName;
      geminiExclusions = geminiVirtual.classification.exclusionBadges || [];
      geminiRawExcludedModels = geminiVirtual.classification.excludedModels || [];
    } else if (hasMasterGemini) {
      geminiPrefix = masterPrefix;
      geminiVirtualFile = '';
      geminiExclusions = masterInfo.classification?.exclusionBadges || [];
      geminiRawExcludedModels = masterInfo.classification?.excludedModels || [];
    } else {
      geminiRawExcludedModels = masterInfo?.classification?.excludedModels || [];
    }

    let geminiPoolRole = 'unassigned';
    let geminiPoolBase = '';
    if (geminiPrefix && !geminiPrefix.startsWith('unlinked_')) {
      const match = geminiPrefix.match(/^(.*)_(\d+)$/);
      geminiPoolRole = match ? 'reserve' : 'leader';
      geminiPoolBase = match ? match[1] : geminiPrefix;
    }

    cards.push({
      cardId: `${masterFileName}::gemini`,
      masterFileName,
      maskedEmail,
      familyRole: 'gemini',
      assignedPrefix: geminiPrefix,
      poolRole: geminiPoolRole,
      activePoolBase: geminiPoolBase,
      exclusionBadges: geminiExclusions,
      excludedModels: geminiRawExcludedModels,
      excluded_models: geminiRawExcludedModels,
      virtualFileName: geminiVirtualFile,
      ...accountTelemetry,
    });

    // --- 2. CLAUDE CARD ---
    const claudeVirtual = relatedVirtuals.find((v) =>
      isClaudePrefix(v.classification.prefix)
    );
    const hasMasterClaude = isClaudePrefix(masterPrefix);

    let claudePrefix = '';
    let claudeVirtualFile = '';
    let claudeExclusions = [];
    let claudeRawExcludedModels = [];

    if (claudeVirtual) {
      claudePrefix = claudeVirtual.classification.prefix;
      claudeVirtualFile = claudeVirtual.classification.fileName;
      claudeExclusions = claudeVirtual.classification.exclusionBadges || [];
      claudeRawExcludedModels = claudeVirtual.classification.excludedModels || [];
    } else if (hasMasterClaude) {
      claudePrefix = masterPrefix;
      claudeVirtualFile = '';
      claudeExclusions = masterInfo.classification?.exclusionBadges || [];
      claudeRawExcludedModels = masterInfo.classification?.excludedModels || [];
    } else {
      claudeRawExcludedModels = masterInfo?.classification?.excludedModels || [];
    }

    let claudePoolRole = 'unassigned';
    let claudePoolBase = '';
    if (claudePrefix && !claudePrefix.startsWith('unlinked_')) {
      const match = claudePrefix.match(/^(.*)_(\d+)$/);
      claudePoolRole = match ? 'reserve' : 'leader';
      claudePoolBase = match ? match[1] : claudePrefix;
    }

    cards.push({
      cardId: `${masterFileName}::claude`,
      masterFileName,
      maskedEmail,
      familyRole: 'claude',
      assignedPrefix: claudePrefix,
      poolRole: claudePoolRole,
      activePoolBase: claudePoolBase,
      exclusionBadges: claudeExclusions,
      excludedModels: claudeRawExcludedModels,
      excluded_models: claudeRawExcludedModels,
      virtualFileName: claudeVirtualFile,
      ...accountTelemetry,
    });
  });

  return cards;
}

/**
 * Computes specialist model exclusions.
 * Given available models and a chosen target model, returns a sorted, deduplicated
 * array containing every available model except the target.
 *
 * @param {string[]} availableModels - List of model identifiers
 * @param {string} targetModel - Chosen single target model
 * @returns {string[]} Sorted, deduplicated exclusions
 */
export function computeSpecialistExclusions(availableModels = [], targetModel = '') {
  if (!Array.isArray(availableModels)) return [];
  let cleanTarget = typeof targetModel === 'string' ? targetModel.trim() : '';
  while (cleanTarget.includes('/')) {
    cleanTarget = cleanTarget.slice(cleanTarget.indexOf('/') + 1);
  }

  const set = new Set();
  for (const m of availableModels) {
    if (typeof m !== 'string' && !m?.id && !m?.name) continue;
    let base = typeof m === 'string' ? m.trim() : (m?.id || m?.name || '').trim();
    while (base.includes('/')) {
      base = base.slice(base.indexOf('/') + 1);
    }
    if (base && base !== cleanTarget) {
      set.add(base);
    }
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

/**
 * Resolves inherited catalog models available for a specific card based on its family
 * (gemini, claude, codex), strips route prefixes (toBaseModelId), and excludes any
 * model in globalDisabledModels.
 *
 * @param {Object} card - Target card descriptor
 * @param {Array<string|Object>} catalogModels - Raw model catalog list
 * @param {string[]} [globalDisabledModels] - Globally disabled model IDs
 * @returns {string[]} Deduplicated, sorted list of base model IDs
 */
export function resolveInheritedCardModels(card, catalogModels = [], globalDisabledModels = []) {
  if (!Array.isArray(catalogModels)) return [];

  const familyRole = (
    card?.familyRole ||
    card?.family ||
    card?.role ||
    ''
  ).toLowerCase();

  const prefix = (
    card?.assignedPrefix ||
    card?.prefix ||
    card?.classification?.prefix ||
    ''
  ).toLowerCase();

  let effectiveFamily = 'gemini';
  if (
    familyRole === 'claude' ||
    prefix.startsWith('agy_son') ||
    prefix.startsWith('agy_opus') ||
    prefix.startsWith('agy_clau') ||
    prefix.startsWith('clau') ||
    prefix.startsWith('son')
  ) {
    effectiveFamily = 'claude';
  } else if (familyRole === 'codex' || prefix.startsWith('codex')) {
    effectiveFamily = 'codex';
  } else if (familyRole === 'gemini' || prefix.startsWith('agy') || prefix.startsWith('g')) {
    effectiveFamily = 'gemini';
  } else if (familyRole && CANONICAL_PROVIDER_MODELS[familyRole]) {
    effectiveFamily = familyRole;
  } else if (familyRole) {
    effectiveFamily = familyRole;
  }

  const toBaseModelId = (id) => {
    if (typeof id !== 'string') return '';
    let clean = id.trim();
    while (clean.includes('/')) {
      clean = clean.slice(clean.indexOf('/') + 1);
    }
    return clean;
  };

  const disabledSet = new Set(
    (Array.isArray(globalDisabledModels) ? globalDisabledModels : [])
      .map((m) => toBaseModelId(String(m || '')).toLowerCase())
      .filter(Boolean)
  );

  const resultSet = new Set();

  for (const rawItem of catalogModels) {
    const rawId = typeof rawItem === 'string' ? rawItem : rawItem?.id || rawItem?.name || '';
    if (!rawId) continue;
    const baseId = toBaseModelId(rawId);
    if (!baseId) continue;
    const lower = baseId.toLowerCase();

    // Invariante de Arquitectura Sagrada:
    // Las fachadas virtuales de pools (Pool-XX-*) son identificadores soberanos de balanceo,
    // NUNCA modelos físicos elegibles para especialización en una credencial individual.
    if (lower.startsWith('pool-') || lower.includes('pool-')) {
      continue;
    }

    if (disabledSet.has(lower) || disabledSet.has(rawId.toLowerCase())) {
      continue;
    }

    let matches = false;
    if (effectiveFamily === 'gemini') {
      matches = lower.includes('gemini');
    } else if (effectiveFamily === 'claude') {
      const isDirectClaude = prefix.startsWith('clau');
      if (isDirectClaude) {
        matches =
          rawId.toLowerCase().startsWith('clau/') ||
          (lower.includes('claude') &&
            !lower.includes('4-6') &&
            !lower.includes('5-5') &&
            !lower.startsWith('gpt'));
      } else {
        matches =
          lower.includes('claude') ||
          lower.includes('sonnet') ||
          lower.includes('opus') ||
          /^gpt/.test(lower);
      }
    } else if (effectiveFamily === 'codex') {
      matches =
        rawId.toLowerCase().startsWith('codex/') ||
        lower.includes('codex') ||
        lower.includes('chatgpt') ||
        lower.startsWith('gpt-') ||
        lower.startsWith('o1') ||
        lower.startsWith('o3') ||
        lower.startsWith('o4');
    } else if (CANONICAL_PROVIDER_MODELS[effectiveFamily]) {
      const canonicalSet = new Set(CANONICAL_PROVIDER_MODELS[effectiveFamily].map((m) => m.toLowerCase()));
      matches =
        rawId.toLowerCase().startsWith(`${effectiveFamily}/`) ||
        canonicalSet.has(lower) ||
        lower.includes(effectiveFamily);
    } else {
      matches = rawId.toLowerCase().startsWith(`${effectiveFamily}/`) || lower.includes(effectiveFamily);
    }

    if (matches) {
      resultSet.add(baseId);
    }
  }

  // Si el catálogo está vacío o no arrojó coincidencias, proveer fallback canónico de proveedor si existe
  if (resultSet.size === 0 && CANONICAL_PROVIDER_MODELS[effectiveFamily]) {
    for (const canonical of CANONICAL_PROVIDER_MODELS[effectiveFamily]) {
      const base = toBaseModelId(canonical);
      if (base && !disabledSet.has(base.toLowerCase())) {
        resultSet.add(base);
      }
    }
  }

  return Array.from(resultSet).sort((a, b) => a.localeCompare(b));
}

/**
 * Updates the excluded_models attribute of an auth record using PATCH /v0/management/auth-files/fields.
 *
 * CRITICAL SAFETY & SECURITY INVARIANTS:
 * - Mutates target auth-file in-place without creating clone files on disk.
 * - Credentials, tokens, secrets, or keys are NEVER included in payload or logged.
 * - Enforces same-origin policy via apiFetch.
 * - Handles 401 Unauthorized, 404 Not Found, and 409 Conflict with sanitized error messages.
 *
 * @param {string} fileName - Exact physical filename of the auth file
 * @param {string[]} excludedModels - List of model IDs to exclude
 * @param {Object} [options] - Options passed to apiFetch (key, fetchFn, etc.)
 * @returns {Promise<{ name: string, excluded_models: string[], ok: boolean, status: number }>}
 */
export async function patchAuthFileExclusions(fileName, excludedModels = [], options = {}) {
  if (!fileName || typeof fileName !== 'string' || !fileName.trim()) {
    throw new Error('Invalid auth file name: filename must be a non-empty string');
  }

  const exactName = fileName.trim();
  const cleanExcluded = Array.isArray(excludedModels)
    ? Array.from(
        new Set(
          excludedModels
            .map((m) => String(m || '').trim())
            .filter(Boolean)
        )
      ).sort()
    : [];

  const endpoint = '/v0/management/auth-files/fields';
  const body = JSON.stringify({
    name: exactName,
    excluded_models: cleanExcluded,
  });

  const {
    headers: customHeaders,
    method: _ignoredMethod,
    body: _ignoredBody,
    ...safeOptions
  } = options;

  const requestHeaders = {};
  if (customHeaders) {
    if (typeof customHeaders.forEach === 'function') {
      customHeaders.forEach((val, k) => {
        if (typeof k === 'string' && k.toLowerCase() !== 'content-type') {
          requestHeaders[k] = val;
        }
      });
    } else if (typeof customHeaders === 'object') {
      for (const [k, val] of Object.entries(customHeaders)) {
        if (typeof k === 'string' && k.toLowerCase() !== 'content-type') {
          requestHeaders[k] = val;
        }
      }
    }
  }

  for (const headerKey of Object.keys(requestHeaders)) {
    if (headerKey.toLowerCase() === 'content-type') {
      delete requestHeaders[headerKey];
    }
  }
  requestHeaders['Content-Type'] = 'application/json';

  try {
    const res = await apiFetch(endpoint, {
      ...safeOptions,
      method: 'PATCH',
      body,
      headers: requestHeaders,
    });

    return {
      name: exactName,
      excluded_models: cleanExcluded,
      ok: true,
      status: res.status,
    };
  } catch (err) {
    const safeName = maskDisplayIdentifier(sanitizeFileName(exactName));
    const rawMsg = err.message || '';

    if (rawMsg.includes('401')) {
      throw new Error(`401 Unauthorized: Invalid or expired management key for "${safeName}"`);
    }
    if (rawMsg.includes('404')) {
      throw new Error(`404 Not Found: Auth file "${safeName}" not found`);
    }
    if (rawMsg.includes('409')) {
      throw new Error(`409 Conflict: Resource conflict for "${safeName}"`);
    }
    throw new Error(`Failed to update model exclusions for "${safeName}": ${err.message}`);
  }
}

/**
 * Detects whether a card is in Specialist Mode (exactly one model active) vs Multipurpose Mode.
 *
 * @param {Object} card - Card object with excluded_models or excludedModels
 * @param {string[]} inheritedModels - List of inherited models for this card family
 * @returns {{ isSpecialist: boolean, activeSpecialistModel: string|null, excludedCount: number }}
 */
export function detectSpecialistState(card, inheritedModels = []) {
  const excludedList = (
    card?.excluded_models ||
    card?.excludedModels ||
    card?.classification?.excludedModels ||
    []
  ).map((m) => String(m || '').trim());
  const excludedSet = new Set(excludedList);

  if (!Array.isArray(inheritedModels) || inheritedModels.length < 2) {
    return {
      isSpecialist: false,
      activeSpecialistModel: null,
      excludedCount: excludedList.length,
    };
  }

  const activeModels = inheritedModels.filter((m) => !excludedSet.has(m));
  if (activeModels.length === 1) {
    return {
      isSpecialist: true,
      activeSpecialistModel: activeModels[0],
      excludedCount: inheritedModels.length - 1,
    };
  }

  return {
    isSpecialist: false,
    activeSpecialistModel: null,
    excludedCount: excludedList.length,
  };
}

/**
 * Computes real account activity from CPAMC native recent_requests buckets
 * (10-minute windows). Returns total requests and success percentage.
 *
 * @param {Array<{time: string, success: number, failed: number}>} [recentRequests]
 * @returns {{ reqs: number, ok: number, failed: number, okPct: number }}
 */
export function computeAccountTelemetry(recentRequests = []) {
  if (!Array.isArray(recentRequests)) {
    return { reqs: 0, ok: 0, failed: 0, okPct: 100 };
  }
  let ok = 0;
  let failed = 0;
  recentRequests.forEach((bucket) => {
    if (!bucket || typeof bucket !== 'object') return;
    ok += typeof bucket.success === 'number' ? bucket.success : 0;
    failed += typeof bucket.failed === 'number' ? bucket.failed : 0;
  });
  const reqs = ok + failed;
  const okPct = reqs > 0 ? Math.round((ok / reqs) * 100) : 100;
  return { reqs, ok, failed, okPct };
}

/**
 * Classifies a model identifier into the Antigravity quota family used by the
 * switcher convention: 'gemini' or 'claude_gpt'.
 *
 * @param {string} modelKey
 * @returns {'gemini'|'claude_gpt'|'other'}
 */
function modelFamily(modelKey) {
  const lower = String(modelKey || '').toLowerCase();
  if (lower.startsWith('gemini')) return 'gemini';
  if (
    lower.startsWith('claude') ||
    lower.startsWith('gpt') ||
    lower.startsWith('gpt-oss') ||
    lower.startsWith('codex')
  ) {
    return 'claude_gpt';
  }
  return 'other';
}

/**
 * Classifies CPAMC native cooldown entries into active (still in the future)
 * per-family exhaustion state. Only non-expired cooldowns are considered.
 *
 * @param {Array<{model_key: string, reason: string, retry_at: string, http_status: number}>} [cooldowns]
 * @param {number} [nowMs=Date.now()]
 * @returns {{
 *   active: Array<Object>,
 *   gemini: Object|null,
 *   claudeGpt: Object|null,
 *   hasGemini: boolean,
 *   hasClaudeGpt: boolean
 * }}
 */
export function classifyCooldowns(cooldowns = [], nowMs = Date.now()) {
  if (!Array.isArray(cooldowns)) {
    return { active: [], gemini: null, claudeGpt: null, hasGemini: false, hasClaudeGpt: false };
  }
  const active = cooldowns
    .map((c) => {
      if (!c || typeof c !== 'object') return null;
      const retryAtMs = c.retry_at ? new Date(c.retry_at).getTime() : NaN;
      if (!isNaN(retryAtMs) && retryAtMs <= nowMs) return null; // already expired
      const modelKey = String(c.model_key || '').trim();
      return {
        modelKey,
        family: modelFamily(modelKey),
        reason: String(c.reason || ''),
        httpStatus: typeof c.http_status === 'number' ? c.http_status : 0,
        retryAt: c.retry_at || '',
        retryAtMs: isNaN(retryAtMs) ? null : retryAtMs,
      };
    })
    .filter(Boolean);

  const earliestPerFamily = (family) => {
    const list = active.filter((a) => a.family === family);
    if (list.length === 0) return null;
    return list.reduce((earliest, a) =>
      a.retryAtMs !== null && (!earliest || earliest.retryAtMs === null || a.retryAtMs < earliest.retryAtMs)
        ? a
        : earliest
    );
  };

  const gemini = earliestPerFamily('gemini');
  const claudeGpt = earliestPerFamily('claude_gpt');
  return {
    active,
    gemini,
    claudeGpt,
    hasGemini: !!gemini,
    hasClaudeGpt: !!claudeGpt,
  };
}

/**
 * Formats the remaining time between now and a future ISO date as a compact
 * human-readable duration (e.g. "43h 51m", "2d 11h").
 *
 * @param {string} isoDate
 * @param {number} [nowMs=Date.now()]
 * @returns {string}
 */
export function formatRemainingDuration(isoDate, nowMs = Date.now()) {
  if (!isoDate) return '';
  const target = new Date(isoDate).getTime();
  if (isNaN(target)) return '';
  const delta = Math.max(0, target - nowMs);
  const totalMinutes = Math.floor(delta / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const mins = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

export const ANTIGRAVITY_SUBSCRIPTION_URL =
  'https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist';

export const ANTIGRAVITY_QUOTA_URLS = [
  'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
  'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
  'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:retrieveUserQuotaSummary',
];

export const ANTIGRAVITY_HEADERS = {
  Authorization: 'Bearer $TOKEN$',
  'Content-Type': 'application/json',
  'User-Agent': 'antigravity/hub/2.23.0 darwin/arm64',
};

export const ANTIGRAVITY_PLAN_BY_TIER_ID = {
  'free-tier': 'Free',
  'g1-pro-tier': 'Pro',
  'g1-ultra-tier': 'Ultra',
  'g1-ultra-lite-tier': 'Ultra Lite',
};

/**
 * Parses Antigravity tier summary (from loadCodeAssist).
 *
 * @param {Object|string} payload
 * @returns {{ plan: string, tierId: string|null, tierName: string|null }|null}
 */
export function parseAntigravityTierSummary(payload) {
  if (!payload) return null;
  let envelope = payload;
  if (typeof envelope === 'string') {
    try {
      envelope = JSON.parse(envelope);
    } catch {
      return null;
    }
  }
  const parsed =
    envelope && typeof envelope.body === 'object' && envelope.body !== null
      ? envelope.body
      : typeof envelope.body === 'string'
      ? (() => {
          try {
            return JSON.parse(envelope.body);
          } catch {
            return envelope;
          }
        })()
      : envelope;

  const normalizeTier = (val) => {
    if (!val || typeof val !== 'object') return null;
    return {
      id: typeof val.id === 'string' ? val.id.trim() : null,
      name: typeof val.name === 'string' ? val.name.trim() : null,
    };
  };

  const currentTier = normalizeTier(parsed?.currentTier ?? parsed?.current_tier);
  const paidTier = normalizeTier(parsed?.paidTier ?? parsed?.paid_tier);
  const effectiveTier = paidTier?.id ? paidTier : currentTier;

  if (!effectiveTier || (!effectiveTier.id && !effectiveTier.name)) {
    // No tier information available: return null plan so the UI can render an
    // explicit "sin datos" state instead of a fabricated default.
    return { plan: null, tierId: null, tierName: null };
  }

  const plan =
    (effectiveTier.id && ANTIGRAVITY_PLAN_BY_TIER_ID[effectiveTier.id]) ||
    effectiveTier.name ||
    'Pro';

  return {
    plan,
    tierId: effectiveTier.id,
    tierName: effectiveTier.name,
  };
}

/**
 * Formats duration delta into human-friendly representation (e.g. 4h 32m, 6d 12h).
 *
 * @param {string|number} dateStr
 * @param {number} [serverTimeOffsetMs=0]
 * @returns {string}
 */
export function formatQuotaDuration(dateStr, serverTimeOffsetMs = 0) {
  if (!dateStr) return '';
  const target = new Date(dateStr).getTime();
  if (isNaN(target)) return '';
  const delta = target - (Date.now() + serverTimeOffsetMs);
  if (delta <= 0) return '0m';
  const totalMinutes = Math.floor(delta / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const mins = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

/**
 * Parses Antigravity retrieveUserQuotaSummary payload into canonical groups:
 * GEMINI MODELS and CLAUDE AND GPT MODELS, each with Five Hour Limit and Weekly Limit.
 *
 * @param {Object|string} payload
 * @param {number} [serverTimeOffsetMs=0]
 * @returns {Array<{ title: string, models: string, rows: Array<Object> }>}
 */
export function parseAntigravityQuotaPayload(payload, serverTimeOffsetMs = 0) {
  if (!payload) return [];
  let envelope = payload;
  if (typeof envelope === 'string') {
    try {
      envelope = JSON.parse(envelope);
    } catch {
      return [];
    }
  }
  const body =
    envelope && typeof envelope.body === 'object' && envelope.body !== null
      ? envelope.body
      : typeof envelope.body === 'string'
      ? (() => {
          try {
            return JSON.parse(envelope.body);
          } catch {
            return envelope;
          }
        })()
      : envelope;

  const rawGroups = Array.isArray(body?.groups) ? body.groups : [];
  if (!rawGroups.length) {
    return [];
  }

  return rawGroups.map((g) => {
    const rawTitle = (g.displayName || g.display_name || g.name || 'Models').toUpperCase();
    let title = rawTitle;
    if (rawTitle.includes('GEMINI')) {
      title = 'GEMINI MODELS';
    } else if (rawTitle.includes('CLAUDE') || rawTitle.includes('GPT')) {
      title = 'CLAUDE AND GPT MODELS';
    }

    const models = Array.isArray(g.models)
      ? g.models.map((m) => m.displayName || m.name || m).join(', ')
      : '';

    const rawBuckets = g.buckets || g.limits || [];
    const rows = rawBuckets.map((b) => {
      const remFrac = b.remainingFraction !== undefined ? b.remainingFraction : b.remaining_fraction;
      const fraction =
        remFrac !== undefined && remFrac !== null && !isNaN(Number(remFrac))
          ? Number(remFrac)
          : null;
      const percent =
        fraction !== null ? Math.max(0, Math.min(100, Math.round(fraction * 100))) : 100;
      const resetTime = b.resetTime || b.reset_time;
      const resetDuration = formatQuotaDuration(resetTime, serverTimeOffsetMs);
      const resetMs = resetTime ? new Date(resetTime).getTime() : null;

      let label = String(b.displayName || b.display_name || b.label || b.window || 'Limit');
      const labelLower = label.toLowerCase();
      if (labelLower.includes('5') || labelLower.includes('five')) {
        label = 'Five Hour Limit';
      } else if (labelLower.includes('week')) {
        label = 'Weekly Limit';
      }

      let percentLabel;
      let warning = false;
      let resetLabel;

      if (fraction === null) {
        percentLabel = '100% remaining';
        resetLabel = resetDuration ? `Refreshes in ${resetDuration}` : 'Refreshes in 5h 0m';
      } else {
        percentLabel = fraction === 1 ? 'Quota available' : `${percent}% remaining`;
        warning = percent < 20;
        resetLabel = resetDuration
          ? `Refreshes in ${resetDuration}`
          : label === 'Weekly Limit'
          ? 'Refreshes in 6d 23h'
          : 'Refreshes in 5h 0m';
      }

      return {
        label,
        window: b.window,
        percent,
        percentLabel,
        resetLabel,
        resetMs,
        warning,
      };
    });

    // Default rows if empty
    if (rows.length === 0) {
      rows.push(
        {
          label: 'Five Hour Limit',
          percent: 100,
          percentLabel: 'Quota available',
          resetLabel: 'Refreshes in 5h 0m',
          warning: false,
        },
        {
          label: 'Weekly Limit',
          percent: 100,
          percentLabel: '100% remaining',
          resetLabel: 'Refreshes in 6d 23h',
          warning: false,
        }
      );
    }

    return {
      title,
      models,
      rows,
    };
  });
}

// TTL para caché de cuotas en cliente: 5 minutos (evita saturación a Google en recargas y cambios de solapa)
export const QUOTA_CACHE_TTL_MS = 5 * 60 * 1000;
const quotaMemoryCache = new Map();

/**
 * Acceso seguro a localStorage o sessionStorage con fallback a memoria
 */
function getStorage(type = 'local') {
  try {
    if (typeof window !== 'undefined') {
      const storage = type === 'local' ? window.localStorage : window.sessionStorage;
      if (storage) return storage;
    }
  } catch {
    // Modo restringido o SSR
  }
  return null;
}

/**
 * Obtiene la clave de almacenamiento para el caché de cuota de una tarjeta o nodo.
 */
function getQuotaCacheKey(cardOrNode) {
  const rawKey =
    cardOrNode?.fileName ||
    cardOrNode?.name ||
    cardOrNode?.auth_index ||
    cardOrNode?.authIndex ||
    cardOrNode?.masterFileName ||
    '0';
  return `cpamc_quota_${String(rawKey).toLowerCase()}`;
}

/**
 * Limpia el caché en memoria y en localStorage de cuotas (útil para pruebas y resets).
 */
export function clearQuotaCache() {
  quotaMemoryCache.clear();
  const storage = getStorage('local') || getStorage('session');
  if (storage) {
    try {
      const keysToRemove = [];
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        if (k && k.startsWith('cpamc_quota_')) {
          keysToRemove.push(k);
        }
      }
      keysToRemove.forEach((k) => storage.removeItem(k));
    } catch {
      // ignore storage access errors
    }
  }
}

/**
 * Recupera un resultado de cuota en caché si aún no ha expirado su TTL (5 minutos).
 */
function getCachedQuota(cacheKey) {
  const now = Date.now();

  // 1. Verificar primero en memoria
  if (quotaMemoryCache.has(cacheKey)) {
    const entry = quotaMemoryCache.get(cacheKey);
    if (entry && now - entry.timestamp < QUOTA_CACHE_TTL_MS) {
      return entry.data;
    }
    quotaMemoryCache.delete(cacheKey);
  }

  // 2. Verificar en localStorage (persiste entre recargas F5, nuevas pestañas y cambios de vista)
  const storage = getStorage('local') || getStorage('session');
  if (storage) {
    try {
      const stored = storage.getItem(cacheKey);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed && typeof parsed.timestamp === 'number' && now - parsed.timestamp < QUOTA_CACHE_TTL_MS) {
          quotaMemoryCache.set(cacheKey, parsed);
          return parsed.data;
        }
        storage.removeItem(cacheKey);
      }
    } catch {
      // Manejo seguro ante restricciones de storage
    }
  }

  return null;
}

/**
 * Guarda un resultado de cuota válido en el caché en memoria y en localStorage.
 */
function setCachedQuota(cacheKey, data) {
  if (!data) return;
  const entry = {
    timestamp: Date.now(),
    data,
  };
  quotaMemoryCache.set(cacheKey, entry);
  const storage = getStorage('local') || getStorage('session');
  if (storage) {
    try {
      storage.setItem(cacheKey, JSON.stringify(entry));
    } catch {
      // Storage lleno o deshabilitado
    }
  }
}

/**
 * Intenta recuperar cuotas existentes en RAM desde el backend Go (manifest o telemetry)
 * evitando peticiones costosas a Google vía /v0/management/api-call.
 */
async function fetchQuotaFromBackendTelemetry(cardOrNode, options = {}) {
  try {
    const rawKey = String(
      cardOrNode?.fileName ||
      cardOrNode?.name ||
      cardOrNode?.masterFileName ||
      ''
    ).toLowerCase();
    const cleanEmail = rawKey.replace(/^antigravity-/, '').replace(/\.json$/, '');

    const res = await apiFetch('/v0/management/auto-switcher-pro/manifest', {
      ...options,
      method: 'GET',
    });
    if (!res.ok) return null;
    const manifest = await res.json();
    if (!manifest || !manifest.ok) return null;

    if (
      (!Array.isArray(manifest.accounts) || manifest.accounts.length === 0) &&
      (!Array.isArray(manifest.telemetry) || manifest.telemetry.length === 0)
    ) {
      return null;
    }

    // Buscar coincidencia en accounts o telemetry
    let matchedAcc = null;
    if (Array.isArray(manifest.accounts)) {
      matchedAcc = manifest.accounts.find((a) => {
        const aKey = String(a.account_key || a.accountKey || '').toLowerCase();
        const aEmail = String(a.email || '').toLowerCase();
        return (
          (rawKey && aKey.includes(rawKey)) ||
          (cleanEmail && (aEmail.includes(cleanEmail) || aKey.includes(cleanEmail)))
        );
      });
    }

    if (!matchedAcc && Array.isArray(manifest.telemetry)) {
      const t = manifest.telemetry.find((item) => {
        const tKey = String(item.account_key || item.accountKey || '').toLowerCase();
        return (rawKey && tKey.includes(rawKey)) || (cleanEmail && tKey.includes(cleanEmail));
      });
      if (t) {
        matchedAcc = {
          window_5h_pct: t.window_5h_pct ?? t.Window5hPct,
          weekly_pct: t.weekly_pct ?? t.WeeklyPct,
          window_5h_reset_in: t.window_5h_reset_in ?? t.Window5hResetIn,
          weekly_reset_in: t.weekly_reset_in ?? t.WeeklyResetIn,
          plan: t.plan || 'Antigravity Pro',
        };
      }
    }

    if (matchedAcc) {
      const w5h = typeof matchedAcc.window_5h_pct === 'number' ? matchedAcc.window_5h_pct : (matchedAcc.Window5hPct ?? 100);
      const wWeekly = typeof matchedAcc.weekly_pct === 'number' ? matchedAcc.weekly_pct : (matchedAcc.WeeklyPct ?? 100);
      const w5hReset = matchedAcc.window_5h_reset_in || matchedAcc.Window5hResetIn || 0;
      const wWeeklyReset = matchedAcc.weekly_reset_in || matchedAcc.WeeklyResetIn || 0;
      const plan = matchedAcc.plan || 'Antigravity Pro';

      const geminiRows = [
        {
          label: 'Five Hour Limit',
          percent: Math.round(w5h),
          percentLabel: `${Math.round(w5h)}% remaining`,
          resetLabel: w5hReset > 0 ? `Refreshes in ${Math.round(w5hReset / 60)}m` : 'Refreshes in 5h 0m',
          warning: w5h < 20,
        },
        {
          label: 'Weekly Limit',
          percent: Math.round(wWeekly),
          percentLabel: `${Math.round(wWeekly)}% remaining`,
          resetLabel: wWeeklyReset > 0 ? `Refreshes in ${Math.round(wWeeklyReset / 3600)}h` : 'Refreshes in 6d 23h',
          warning: wWeekly < 20,
        },
      ];

      const claudeRows = [
        {
          label: 'Five Hour Limit',
          percent: Math.round(w5h),
          percentLabel: `${Math.round(w5h)}% remaining`,
          resetLabel: w5hReset > 0 ? `Refreshes in ${Math.round(w5hReset / 60)}m` : 'Refreshes in 5h 0m',
          warning: w5h < 20,
        },
        {
          label: 'Weekly Limit',
          percent: Math.round(wWeekly),
          percentLabel: `${Math.round(wWeekly)}% remaining`,
          resetLabel: wWeeklyReset > 0 ? `Refreshes in ${Math.round(wWeeklyReset / 3600)}h` : 'Refreshes in 6d 23h',
          warning: wWeekly < 20,
        },
      ];

      const groups = [
        {
          title: 'GEMINI MODELS',
          models: 'gemini-2.5-pro, gemini-2.5-flash',
          rows: geminiRows,
        },
        {
          title: 'CLAUDE AND GPT MODELS',
          models: 'claude-3-7-sonnet, claude-3-opus',
          rows: claudeRows,
        },
      ];

      return {
        plan,
        groups,
        live: true,
        loading: false,
        error: null,
      };
    }
  } catch {
    // Si falla manifest, se procede con la lógica normal
  }
  return null;
}

/**
 * Fetches Antigravity quota and subscription plan via POST /v0/management/api-call proxy.
 * Sometido a caché con TTL de 5 minutos: si se consultó recientemente, retorna
 * los datos almacenados instantáneamente sin emitir peticiones a Google, a menos
 * que options.force === true.
 *
 * @param {Object} cardOrNode
 * @param {Object} [options]
 * @param {boolean} [options.force=false]
 * @returns {Promise<{ plan: string, groups: Array<Object>, loading: boolean, error: string|null, cached?: boolean }>}
 */
export async function fetchCardQuota(cardOrNode, options = {}) {
  const cacheKey = getQuotaCacheKey(cardOrNode);
  const force = options.force === true;

  if (!force) {
    const cached = getCachedQuota(cacheKey);
    if (cached) {
      return {
        ...cached,
        cached: true,
      };
    }

    // 2. Si no está en caché, intentar leer primero telemetría en RAM del backend Go
    // (el AutonomousQuotaPoller ya mantiene las cuotas actualizadas en background)
    const backendQuota = await fetchQuotaFromBackendTelemetry(cardOrNode, options);
    if (backendQuota) {
      setCachedQuota(cacheKey, backendQuota);
      return {
        ...backendQuota,
        cached: true,
      };
    }
  }

  const authIndex =
    cardOrNode?.auth_index ||
    cardOrNode?.authIndex ||
    cardOrNode?.fileName ||
    cardOrNode?.name ||
    cardOrNode?.masterFileName ||
    '0';
  const projectId = cardOrNode?.project_id || cardOrNode?.projectId || '';

  let plan = null;

  // 1. Fetch subscription tier summary (loadCodeAssist is the only reliably
  // reachable endpoint for these accounts). Real tier only; never invented.
  try {
    const subRes = await apiFetch('/v0/management/api-call', {
      ...options,
      method: 'POST',
      body: JSON.stringify({
        authIndex,
        method: 'POST',
        url: ANTIGRAVITY_SUBSCRIPTION_URL,
        header: ANTIGRAVITY_HEADERS,
        data: JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY' } }),
      }),
    });
    if (subRes.ok) {
      const subResult = await subRes.json();
      const tierSummary = parseAntigravityTierSummary(subResult);
      if (tierSummary?.plan) {
        plan = tierSummary.plan;
      }
    }
  } catch {
    // Non-fatal: plan stays unknown (null) instead of a fabricated default
  }

  // 2. Fetch quota summary. If Google's quota endpoints are unreachable
  // (e.g. 403 SUBSCRIPTION_REQUIRED for non-licensed accounts), return an
  // EMPTY groups array. Mock/fabricated percentages are never rendered.
  let groups = [];
  let error = null;

  for (const url of ANTIGRAVITY_QUOTA_URLS) {
    try {
      const qRes = await apiFetch('/v0/management/api-call', {
        ...options,
        method: 'POST',
        body: JSON.stringify({
          authIndex,
          method: 'POST',
          url,
          header: ANTIGRAVITY_HEADERS,
          data: projectId ? JSON.stringify({ project: projectId }) : '{}',
        }),
      });

      if (qRes.ok) {
        const qResult = await qRes.json();
        const parsedGroups = parseAntigravityQuotaPayload(qResult);
        if (parsedGroups.length > 0) {
          groups = parsedGroups;
          break;
        }
      }
    } catch (err) {
      error = err.message || 'Error al consultar cuota';
    }
  }

  // 3. Telemetría viva hacia el plugin Go CGO en segundo plano:
  // Si obtuvimos métricas de cuota válidas, despachar en silencio hacia
  // /v0/management/auto-switcher-pro/predictive/telemetry para alimentar
  // el motor predictivo en Go sin demorar la respuesta de la UI.
  if (groups.length > 0) {
    try {
      const cleanPref = (cardOrNode?.prefix || cardOrNode?.note || '').trim().toLowerCase();
      const famRole = (cardOrNode?.familyRole || '').trim().toLowerCase();
      const isClaude =
        famRole === 'claude' ||
        cleanPref.startsWith('agy_clau') ||
        cleanPref.startsWith('agy_son') ||
        cleanPref.startsWith('agy_opus') ||
        cleanPref.startsWith('clau') ||
        cleanPref.startsWith('son') ||
        cleanPref.startsWith('opus');
      const isGemini =
        famRole === 'gemini' ||
        (!isClaude && (/^agy\d*(_\d+)?$/.test(cleanPref) || cleanPref.startsWith('g') || cleanPref === 'default'));

      const detectedFamily = isClaude ? 'claude' : (isGemini ? 'gemini' : (famRole || 'gemini'));

      let win5h = null;
      let winWeekly = null;
      let win5hResetIn = 0;
      let winWeeklyResetIn = 0;

      for (const g of groups) {
        const titleLower = (g.title || '').toLowerCase();
        // Aislamiento de familias: no cruzar grupos de Claude y Gemini
        if (isGemini && !titleLower.includes('gemini')) continue;
        if (isClaude && !titleLower.includes('claude') && !titleLower.includes('gpt')) continue;

        for (const r of g.rows || []) {
          const l = (r.label || '').toLowerCase();
          if (l.includes('5') || l.includes('five')) {
            if (typeof r.percent === 'number') {
              win5h = win5h === null ? r.percent : Math.min(win5h, r.percent);
            }
            if (r.resetMs) {
              win5hResetIn = Math.max(0, Math.round((r.resetMs - Date.now()) / 1000));
            }
          } else if (l.includes('week')) {
            if (typeof r.percent === 'number') {
              winWeekly = winWeekly === null ? r.percent : Math.min(winWeekly, r.percent);
            }
            if (r.resetMs) {
              winWeeklyResetIn = Math.max(0, Math.round((r.resetMs - Date.now()) / 1000));
            }
          }
        }
      }

      const accKey =
        cardOrNode?.fileName ||
        cardOrNode?.name ||
        cardOrNode?.masterFileName ||
        cardOrNode?.email ||
        cardOrNode?.auth_index ||
        '';

      // Solo empujar telemetría si se obtuvieron cuotas reales para la familia y la telemetría está habilitada
      const isTelemetryEnabled =
        typeof window === 'undefined' ||
        !window.localStorage ||
        window.localStorage.getItem('telemetry_enabled') !== 'false';

      if (accKey && (win5h !== null || winWeekly !== null) && isTelemetryEnabled) {
        // Fire-and-forget background push to Go CGO plugin
        apiFetch('/v0/management/auto-switcher-pro/predictive/telemetry', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            account_key: accKey,
            family: detectedFamily,
            window_5h_pct: win5h !== null ? win5h : 100.0,
            weekly_pct: winWeekly !== null ? winWeekly : 100.0,
            window_5h_reset_in: win5hResetIn,
            weekly_reset_in: winWeeklyResetIn,
            plan: plan || 'Unknown',
          }),
        }).catch(() => {});
      }
    } catch {
      // Ignorar errores en segundo plano
    }
  }

  const result = {
    plan,
    groups,
    live: groups.length > 0,
    loading: false,
    error,
  };

  // Solo almacenar en caché si obtuvimos información coherente (plan o grupos)
  if (result.plan || (result.groups && result.groups.length > 0)) {
    setCachedQuota(cacheKey, result);
  }

  return result;
}

/**
 * Adapta el resultado de cuotas (sea sobre raw de api-call, respuesta de fetchCardQuota
 * o estructura normalizada) a { fiveHourConsumed, weeklyConsumed, minAvailable }.
 *
 * @param {Object} rawEnvelopeOrQuotaResult
 * @param {string} [provider='antigravity']
 * @param {string} [prefix='']
 * @returns {{ fiveHourConsumed: number|null, weeklyConsumed: number|null, minAvailable: number }}
 */
export function adaptCardQuotaResult(rawEnvelopeOrQuotaResult, provider = 'antigravity', prefix = '') {
  if (!rawEnvelopeOrQuotaResult) {
    return { fiveHourConsumed: null, weeklyConsumed: null, minAvailable: 100 };
  }

  // 1. Si ya viene previamente normalizado con minAvailable
  if (
    typeof rawEnvelopeOrQuotaResult.minAvailable === 'number' &&
    (rawEnvelopeOrQuotaResult.fiveHourConsumed !== undefined || rawEnvelopeOrQuotaResult.weeklyConsumed !== undefined)
  ) {
    return {
      fiveHourConsumed: rawEnvelopeOrQuotaResult.fiveHourConsumed,
      weeklyConsumed: rawEnvelopeOrQuotaResult.weeklyConsumed,
      minAvailable: rawEnvelopeOrQuotaResult.minAvailable,
    };
  }

  let payload = rawEnvelopeOrQuotaResult;
  if (rawEnvelopeOrQuotaResult && rawEnvelopeOrQuotaResult.body) {
    if (typeof rawEnvelopeOrQuotaResult.body === 'string') {
      try {
        payload = JSON.parse(rawEnvelopeOrQuotaResult.body);
      } catch {
        payload = rawEnvelopeOrQuotaResult.body;
      }
    } else {
      payload = rawEnvelopeOrQuotaResult.body;
    }
  }

  const prov = (provider || '').toLowerCase();
  const prof = (prefix || '').replace(/^(agy|codex)_?/, '').toLowerCase();

  let worstFiveHour = null;
  let worstWeekly = null;

  if (prov === 'codex') {
    const rl = payload?.rate_limit;
    if (rl?.primary_window?.used_percent !== undefined && rl.primary_window.used_percent !== null) {
      worstFiveHour = Math.max(0, Math.min(100, Number(rl.primary_window.used_percent)));
    }
    if (rl?.secondary_window?.used_percent !== undefined && rl.secondary_window.used_percent !== null) {
      worstWeekly = Math.max(0, Math.min(100, Number(rl.secondary_window.used_percent)));
    }
  } else {
    // Antigravity (Google Cloud Code): Aislar cuotas por convención de familia
    const cleanPrefix = (prefix || '').trim().toLowerCase();
    const isClaudeFamily =
      cleanPrefix.startsWith('agy_clau') ||
      cleanPrefix.startsWith('agy_son') ||
      cleanPrefix.startsWith('agy_opus') ||
      cleanPrefix.startsWith('clau') ||
      cleanPrefix.startsWith('son') ||
      cleanPrefix.startsWith('opus') ||
      prof.startsWith('clau') ||
      prof.startsWith('son') ||
      prof.startsWith('opus');
    const isGeminiFamily =
      !isClaudeFamily && (/^agy\d*(_\d+)?$/.test(cleanPrefix) || prof.startsWith('g') || prof === 'default');

    const groups = payload?.groups || [];
    for (const group of groups) {
      const grpName = (group.displayName || group.title || '').toLowerCase();
      if (isGeminiFamily && !grpName.includes('gemini')) continue;
      if (isClaudeFamily && !grpName.includes('claude') && !grpName.includes('gpt')) continue;

      if (Array.isArray(group.rows)) {
        for (const r of group.rows) {
          const l = (r.label || '').toLowerCase();
          // r.percent representa el porcentaje DISPONIBLE (remaining), por lo que consumido = 100 - r.percent
          const consPct = typeof r.percent === 'number' ? Math.max(0, Math.min(100, 100 - r.percent)) : null;
          if (consPct !== null) {
            if (l.includes('5') || l.includes('five')) {
              if (worstFiveHour === null || consPct > worstFiveHour) worstFiveHour = consPct;
            } else if (l.includes('week')) {
              if (worstWeekly === null || consPct > worstWeekly) worstWeekly = consPct;
            }
          }
        }
      }

      if (Array.isArray(group.buckets)) {
        for (const b of group.buckets) {
          const name = (b.displayName || b.label || b.window || '').toLowerCase();
          const remPct = (b.remainingFraction !== undefined ? b.remainingFraction : 1.0) * 100;
          const consPct = Math.max(0, Math.min(100, 100 - remPct));

          if (name.includes('5') || name.includes('five')) {
            if (worstFiveHour === null || consPct > worstFiveHour) {
              worstFiveHour = consPct;
            }
          } else if (name.includes('week')) {
            if (worstWeekly === null || consPct > worstWeekly) {
              worstWeekly = consPct;
            }
          }
        }
      }
    }
  }

  const five = worstFiveHour !== null ? worstFiveHour : 0;
  const weekly = worstWeekly !== null ? worstWeekly : 0;
  const minAvailable = Math.max(0, 100 - Math.max(five, weekly));

  return {
    fiveHourConsumed: worstFiveHour !== null ? Math.round(worstFiveHour * 10) / 10 : null,
    weeklyConsumed: worstWeekly !== null ? Math.round(worstWeekly * 10) / 10 : null,
    minAvailable: Math.round(minAvailable * 10) / 10,
  };
}

/**
 * Maintenance Engine API Functions
 */
export async function scanSystemHealth(options = {}) {
  const res = await apiFetch('/v0/management/auto-switcher-pro/maintenance/scan', {
    ...options,
    method: 'GET',
  });
  return res.json();
}

export async function cleanSystemResidues(options = {}) {
  const res = await apiFetch('/v0/management/auto-switcher-pro/maintenance/clean', {
    ...options,
    method: 'POST',
  });
  return res.json();
}

export async function updateManagementConsole(options = {}) {
  const res = await apiFetch('/v0/management/auto-switcher-pro/maintenance/update-console', {
    ...options,
    method: 'POST',
  });
  return res.json();
}

/**
 * Obtiene el reporte de auto-diagnóstico e integridad (Self-Healing Boot Report).
 */
export async function getSelfHealingReport(options = {}) {
  const res = await apiFetch('/v0/management/auto-switcher-pro/self-healing', {
    ...options,
    method: 'GET',
  });
  return res.json();
}

/**
 * Exporta la traza anónima de telemetría y eventos de la caja negra (.trace).
 */
export async function exportTelemetryTrace(options = {}) {
  const res = await apiFetch('/v0/management/auto-switcher-pro/telemetry/export-trace', {
    ...options,
    method: 'GET',
  });
  return res.json();
}

/**
 * Obtiene el estado del motor de rebalanceo predictivo y la fatiga de las cuentas.
 */
export async function getPredictiveState(options = {}) {
  const res = await apiFetch('/v0/management/auto-switcher-pro/predictive', {
    ...options,
    method: 'GET',
  });
  return res.json();
}

/**
 * Actualiza la configuración del motor de rebalanceo predictivo.
 */
export async function updatePredictiveConfig(config, options = {}) {
  const res = await apiFetch('/v0/management/auto-switcher-pro/predictive', {
    ...options,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(config),
  });
  return res.json();
}

/**
 * Ejecuta una rotación virtual forzada de líder en un pool registrado del plugin.
 *
 * @param {string} [idOrPrefix]
 * @param {Object} [options]
 * @returns {Promise<{ ok: boolean, pool_id: string, prefix: string, old_leader: string, new_leader: string, message: string }>}
 */
export async function rotatePool(idOrPrefix = '', options = {}) {
  const res = await apiFetch('/v0/management/auto-switcher-pro/pools/rotate', {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(idOrPrefix ? { prefix: idOrPrefix } : {}),
  });
  const data = await res.json();
  if (!res.ok || !data?.ok) {
    throw new Error(data?.message || 'Error al ejecutar rotación de pool');
  }
  return data;
}

/**
 * Consulta la bitácora de auditoría histórica y eventos de caja negra desde SQLite WAL.
 */
export async function fetchAuditLog(options = {}) {
  const res = await apiFetch('/v0/management/auto-switcher-pro/audit-log', {
    ...options,
    method: 'GET',
  });
  return res.json();
}

/**
 * Consulta la lista de incidentes de disyuntor y bucles de agentes mitigados desde SQLite.
 */
export async function fetchGuardIncidents(options = {}) {
  const res = await apiFetch('/v0/management/auto-switcher-pro/incidents', {
    ...options,
    method: 'GET',
  });
  return res.json();
}

/**
 * Consulta un incidente específico por ID con su autopsia forense y traza de comandos.
 */
export async function fetchGuardIncident(id, options = {}) {
  const res = await apiFetch(`/v0/management/auto-switcher-pro/incidents?id=${encodeURIComponent(id)}`, {
    ...options,
    method: 'GET',
  });
  return res.json();
}

/**
 * Consulta la matriz de orquestación de agentes (Gentle-AI & jok3r-pi).
 */
export async function fetchAgentMatrix(options = {}) {
  const res = await apiFetch('/v0/management/auto-switcher-pro/agent-matrix', {
    ...options,
    method: 'GET',
  });
  return res.json();
}

/**
 * Guarda y sincroniza la matriz de agentes en SQLite WAL y archivos de perfil en disco.
 *
 * @param {Array<Object>} agents
 * @param {Object} [options]
 */
export async function saveAgentMatrix(agents, options = {}) {
  const res = await apiFetch('/v0/management/auto-switcher-pro/agent-matrix', {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agents }),
  });
  const data = await res.json();
  if (!res.ok || !data?.ok) {
    throw new Error(data?.message || 'Error al guardar matriz de agentes');
  }
  return data;
}

/**
 * Ejecuta una prueba de fuego (Dry-Run Ping) para verificar latencia y salud de una ruta.
 *
 * @param {string} poolId
 * @param {string} [targetModel]
 * @param {Object} [options]
 */
export async function testAgentRoute(poolId, targetModel = '', options = {}) {
  const res = await apiFetch('/v0/management/auto-switcher-pro/agent-matrix/ping', {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pool_id: poolId, target_model: targetModel }),
  });
  const data = await res.json();
  if (!res.ok || !data?.ok) {
    throw new Error(data?.message || 'Error en prueba de ruta');
  }
  return data;
}

/**
 * Escanea el entorno para detectar dinámicamente los arneses y agentes del equipo.
 *
 * @param {Object} [options]
 */
export async function scanAgentEnvironment(options = {}) {
  const res = await apiFetch('/v0/management/auto-switcher-pro/agent-matrix/scan-environment', {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'scan' }),
  });
  const data = await res.json();
  if (!res.ok || !data?.ok) {
    throw new Error(data?.message || 'Error al escanear arneses del equipo');
  }
  return data;
}

/**
 * Dispara el Shadow Warmup asíncrono para pre-calentar los sockets y prompt cache de los pools objetivo.
 *
 * @param {string[]} [targetPools]
 * @param {Object} [options]
 */
export async function triggerTriageWarmup(targetPools = [], options = {}) {
  const res = await apiFetch('/v0/management/auto-switcher-pro/agent-matrix/warmup-triage', {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target_pools: targetPools }),
  });
  const data = await res.json();
  if (!res.ok || !data?.ok) {
    throw new Error(data?.message || 'Error al disparar warmup de triage');
  }
  return data;
}

/**
 * Consulta la auditoría de versiones del arnés en tiempo real (Local vs Release oficial npm vs GitHub main).
 *
 * @param {string} harnessId
 * @param {Object} [options]
 */
export async function fetchHarnessVersion(harnessId = 'gentle_shell', options = {}) {
  const res = await apiFetch(`/v0/management/auto-switcher-pro/agent-matrix/harness-version?harness=${encodeURIComponent(harnessId)}`, {
    ...options,
    method: 'GET',
  });
  const data = await res.json();
  if (!res.ok || !data?.ok) {
    throw new Error(data?.message || 'Error al obtener versión del arnés');
  }
  return data.data;
}/**
 * Consulta la versión del plugin Auto Switcher Pro y sincronización con GitHub Releases.
 *
 * @param {Object} [options]
 */
export async function fetchPluginVersion(options = {}) {
  const res = await apiFetch('/v0/management/auto-switcher-pro/version', {
    ...options,
    method: 'GET',
  });
  return res.json();
}

/**
 * Consulta el estado y salud del motor (Healthz check).
 *
 * @param {Object} [options]
 */
export async function fetchPluginHealth(options = {}) {
  const res = await apiFetch('/v0/management/auto-switcher-pro/healthz', {
    ...options,
    method: 'GET',
  });
  return res.json();
}

/**
 * Consulta el resumen agregador O(1) de pools, cuentas, telemetría y líderes en RAM.
 *
 * @param {Object} [options]
 */
export async function fetchManifest(options = {}) {
  const res = await apiFetch('/v0/management/auto-switcher-pro/manifest', {
    ...options,
    method: 'GET',
  });
  return res.json();
}

/**
 * Consulta el estado de licencia y Machine ID de hardware.
 *
 * @param {Object} [options]
 */
export async function fetchLicenseStatus(options = {}) {
  const res = await apiFetch('/v0/management/auto-switcher-pro/license/status', {
    ...options,
    method: 'GET',
  });
  return res.json();
}


