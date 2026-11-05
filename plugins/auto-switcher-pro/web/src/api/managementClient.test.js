import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  deobfuscateCPAMC,
  obfuscateCPAMC,
  getManagementKey,
  assertSafeSameOrigin,
  apiFetch,
  listAuthFiles,
  downloadAuthFilePrefix,
  loadAuthFilesWithPrefixes,
  buildGraphFromAuthFiles,
  sanitizeFileName,
  patchAuthFilePrefix,
  saveAuthFilePrefixes,
  virtualizeAccount,
  classifyAuthAccount,
  extractVirtualOrigin,
  extractExclusionBadges,
  deleteAuthFile,
  buildManagedPoolCards,
  abbreviateEmail,
  extractSafeMaskedEmail,
  maskDisplayIdentifier,
  computeSpecialistExclusions,
  resolveInheritedCardModels,
  patchAuthFileExclusions,
  detectSpecialistState,
  parseAntigravityTierSummary,
  formatQuotaDuration,
  parseAntigravityQuotaPayload,
  fetchCardQuota,
  clearQuotaCache,
  QUOTA_CACHE_TTL_MS,
  computeAccountTelemetry,
  classifyCooldowns,
  formatRemainingDuration,
  extractPoolNumber,
  sortPoolsByNumber,
} from './managementClient';

describe('Management API Client - Auth & Security Invariants', () => {
  const TEST_HOST = 'cpamc.local:8080';
  const TEST_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
  const TEST_KEY = 'secret-mgmt-key-998877';

  it('correctly round-trips obfuscation and deobfuscation with CPAMC cipher (v2 and v1)', () => {
    const rawPayload = JSON.stringify({ state: { managementKey: TEST_KEY } });
    
    // v2 (CPAMC v8 default)
    const obfuscatedV2 = obfuscateCPAMC(rawPayload, TEST_HOST, TEST_UA, 'v2');
    expect(obfuscatedV2.startsWith('enc::v2::')).toBe(true);
    const deobfuscatedV2 = deobfuscateCPAMC(obfuscatedV2, TEST_HOST, TEST_UA);
    expect(deobfuscatedV2).toBe(rawPayload);
    expect(JSON.parse(deobfuscatedV2).state.managementKey).toBe(TEST_KEY);

    // v1 (legacy)
    const obfuscatedV1 = obfuscateCPAMC(rawPayload, TEST_HOST, TEST_UA, 'v1');
    expect(obfuscatedV1.startsWith('enc::v1::')).toBe(true);
    const deobfuscatedV1 = deobfuscateCPAMC(obfuscatedV1, TEST_HOST, TEST_UA);
    expect(deobfuscatedV1).toBe(rawPayload);
    expect(JSON.parse(deobfuscatedV1).state.managementKey).toBe(TEST_KEY);
  });

  it('returns raw text unchanged if not starting with enc::v1:: or enc::v2::', () => {
    const plain = JSON.stringify({ state: { managementKey: 'plain_key' } });
    expect(deobfuscateCPAMC(plain, TEST_HOST, TEST_UA)).toBe(plain);
    expect(deobfuscateCPAMC('', TEST_HOST, TEST_UA)).toBe('');
    expect(deobfuscateCPAMC(null, TEST_HOST, TEST_UA)).toBe('');
  });

  it('extracts management key from parent storage in iframe mode (v2 and v1)', () => {
    const rawPayload = JSON.stringify({ state: { managementKey: TEST_KEY } });
    const obfuscatedV2 = obfuscateCPAMC(rawPayload, TEST_HOST, TEST_UA, 'v2');

    const mockParentStorage = {
      getItem: vi.fn((key) => (key === 'cli-proxy-auth' ? obfuscatedV2 : null)),
    };

    const key = getManagementKey({
      parentStorage: mockParentStorage,
      host: TEST_HOST,
      userAgent: TEST_UA,
    });

    expect(key).toBe(TEST_KEY);
    expect(mockParentStorage.getItem).toHaveBeenCalledWith('cli-proxy-auth');
  });

  it('falls back to local storage when parent storage is absent', () => {
    const rawPayload = JSON.stringify({ state: { managementKey: 'local-key-456' } });
    const obfuscated = obfuscateCPAMC(rawPayload, TEST_HOST, TEST_UA);

    const mockLocalStorage = {
      getItem: vi.fn((key) => (key === 'cli-proxy-auth' ? obfuscated : null)),
    };

    const key = getManagementKey({
      parentStorage: null,
      localStorage: mockLocalStorage,
      host: TEST_HOST,
      userAgent: TEST_UA,
    });

    expect(key).toBe('local-key-456');
  });

  it('fails closed and returns empty string when storage has no key', () => {
    const mockStorage = { getItem: vi.fn(() => null) };
    const key = getManagementKey({
      parentStorage: mockStorage,
      localStorage: mockStorage,
    });
    expect(key).toBe('');
  });

  it('enforces safe same-origin endpoints and rejects cross-origin URLs', () => {
    // Valid same-origin relative URLs
    expect(() => assertSafeSameOrigin('/v0/management/auth-files')).not.toThrow();
    expect(
      () => assertSafeSameOrigin('/v0/management/auth-files/download?name=acc.json')
    ).not.toThrow();

    // Protocol-relative URLs MUST be rejected
    expect(() => assertSafeSameOrigin('//attacker.com/v0/management')).toThrow(
      /protocol-relative/
    );

    // Cross-origin absolute URLs MUST be rejected
    expect(() => assertSafeSameOrigin('https://evil.org/api')).toThrow(
      /cross-origin/
    );

    // Empty or invalid
    expect(() => assertSafeSameOrigin('')).toThrow(/empty/);
  });

  it('fails closed when apiFetch is called without a valid management key', async () => {
    await expect(
      apiFetch('/v0/management/auth-files', {
        key: '',
        parentStorage: { getItem: () => null },
        localStorage: { getItem: () => null },
      })
    ).rejects.toThrow(/Management key not found/);
  });

  it('case-insensitively strips and ignores malicious caller Authorization headers to ensure key is final', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ files: [] }),
    });

    // 1. Plain object with lowercase 'authorization' and uppercase 'AUTHORIZATION'
    await apiFetch('/v0/management/auth-files', {
      key: 'authoritative-mgmt-key',
      fetchFn: mockFetch,
      headers: {
        authorization: 'Bearer attacker-fake-token',
        AUTHORIZATION: 'Bearer attacker-override',
        'X-Safe-Header': 'preserve-me',
      },
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, init1] = mockFetch.mock.calls[0];
    expect(init1.headers.Authorization).toBe('Bearer authoritative-mgmt-key');
    expect(init1.headers.authorization).toBeUndefined();
    expect(init1.headers.AUTHORIZATION).toBeUndefined();
    expect(init1.headers['X-Safe-Header']).toBe('preserve-me');

    // 2. Fetch API Headers instance with lowercase authorization
    const customHeaders = new Headers();
    customHeaders.append('authorization', 'Bearer malicious-token-via-headers-instance');
    customHeaders.append('x-custom-metric', '12345');

    await apiFetch('/v0/management/auth-files', {
      key: 'authoritative-mgmt-key',
      fetchFn: mockFetch,
      headers: customHeaders,
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [, init2] = mockFetch.mock.calls[1];
    expect(init2.headers.Authorization).toBe('Bearer authoritative-mgmt-key');
    expect(init2.headers.authorization).toBeUndefined();
    expect(init2.headers['x-custom-metric']).toBe('12345');
  });

  it('sanitizes 401 Unauthorized response without leaking secrets', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'secret response from backend that should not leak',
    });

    await expect(
      apiFetch('/v0/management/auth-files', {
        key: 'invalid-key-xyz',
        fetchFn: mockFetch,
      })
    ).rejects.toThrow('401 Unauthorized: Invalid or expired management key');
  });
});

describe('listAuthFiles - Fail-Closed Physical Name Enforcement', () => {
  it('accepts entries with explicit physical filenames and returns normalized file objects', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        files: [
          { name: 'valid-acc-1.json', id: '0', type: 'antigravity' },
          { name: 'valid-acc-2.json', id: 'acc_id_4', type: 'antigravity' },
        ],
      }),
    });

    const files = await listAuthFiles({
      key: 'test-key',
      fetchFn: mockFetch,
    });

    expect(files.length).toBe(2);
    expect(files[0].name).toBe('valid-acc-1.json');
    expect(files[0].id).toBe('0');
    expect(files[1].name).toBe('valid-acc-2.json');
    expect(files[1].id).toBe('acc_id_4');
  });

  it('fails closed when an entry is missing physical filename instead of silently skipping', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        files: [
          { name: 'valid-acc-1.json', id: '0' },
          { id: '1', type: 'codex' }, // missing physical name!
        ],
      }),
    });

    await expect(
      listAuthFiles({
        key: 'test-key',
        fetchFn: mockFetch,
      })
    ).rejects.toThrow('Invalid auth files listing: entry (id: "1") is missing a physical filename.');
  });

  it('fails closed when listing response is malformed or entry is not an object', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ files: 'not-an-array' }),
    });

    await expect(
      listAuthFiles({
        key: 'test-key',
        fetchFn: mockFetch,
      })
    ).rejects.toThrow('Invalid auth files listing: response missing "files" array.');
  });
});

describe('Auth Files Download & Prefix-Only Extraction', () => {
  it('extracts ONLY prefix and never stores or returns credentials', async () => {
    const sensitiveCredential = {
      prefix: 'agy_p1',
      token: 'sk-ant-api-top-secret-token',
      client_secret: 'super-confidential-secret',
      refresh_token: 'refresh-token-data',
      chatgpt_account_id: 'chatgpt-acc-777',
      private_key: '-----BEGIN PRIVATE KEY-----',
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => sensitiveCredential,
    });

    const result = await downloadAuthFilePrefix('antigravity account #1.json', {
      key: 'test-key',
      fetchFn: mockFetch,
    });

    // Validates URL-encoding of filename parameter
    expect(mockFetch).toHaveBeenCalledWith(
      '/v0/management/auth-files/download?name=antigravity%20account%20%231.json',
      expect.anything()
    );

    // Validates extracted fields
    expect(result.name).toBe('antigravity account #1.json');
    expect(result.prefix).toBe('agy_p1');

    // CRITICAL: secrets MUST NOT be present
    expect(result.token).toBeUndefined();
    expect(result.client_secret).toBeUndefined();
    expect(result.refresh_token).toBeUndefined();
    expect(result.private_key).toBeUndefined();
    expect(result._raw).toBeUndefined();
  });

  it('returns empty prefix string when credential JSON lacks prefix', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: 'active', email: 'test@example.com' }),
    });

    const result = await downloadAuthFilePrefix('unlinked.json', {
      key: 'test-key',
      fetchFn: mockFetch,
    });

    expect(result.name).toBe('unlinked.json');
    expect(result.prefix).toBe('');
    expect(result.excluded_models).toEqual([]);
  });

  it('extracts excluded_models array from payload and returns clean list', async () => {
    const credential = {
      prefix: 'agy_son',
      excluded_models: ['gemini-2.5-flash', 'gemini-2.0-flash'],
      token: 'sk-secret-token',
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => credential,
    });

    const result = await downloadAuthFilePrefix('antigravity-spec.json', {
      key: 'test-key',
      fetchFn: mockFetch,
    });

    expect(result.name).toBe('antigravity-spec.json');
    expect(result.prefix).toBe('agy_son');
    expect(result.excluded_models).toEqual(['gemini-2.5-flash', 'gemini-2.0-flash']);
    expect(result.token).toBeUndefined();
  });
});

describe('loadAuthFilesWithPrefixes - Fail-Closed Safety Contract', () => {
  it('combines list and download securely when all files succeed', async () => {
    const mockFetch = vi.fn().mockImplementation((url) => {
      if (url === '/v0/management/auth-files') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            files: [{ name: 'f1.json' }, { name: 'f2.json' }],
          }),
        });
      }
      if (url.includes('f1.json')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ prefix: 'agy_p1', secret: 'discard_me' }),
        });
      }
      if (url.includes('f2.json')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ prefix: 'agy_p1_1', token: 'discard_me' }),
        });
      }
      return Promise.reject(new Error('Unknown url'));
    });

    const records = await loadAuthFilesWithPrefixes({
      key: 'test-key',
      fetchFn: mockFetch,
    });

    expect(records).toEqual([
      {
        name: 'f1.json',
        prefix: 'agy_p1',
        excluded_models: [],
        unavailable: false,
        disabled: false,
        cooldowns: [],
        recent_requests: [],
        success: 0,
        failed: 0,
      },
      {
        name: 'f2.json',
        prefix: 'agy_p1_1',
        excluded_models: [],
        unavailable: false,
        disabled: false,
        cooldowns: [],
        recent_requests: [],
        success: 0,
        failed: 0,
      },
    ]);
  });

  it('propagates excluded_models into each auth file descriptor record', async () => {
    const mockFetch = vi.fn().mockImplementation((url) => {
      if (url === '/v0/management/auth-files') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            files: [{ name: 'f1.json' }],
          }),
        });
      }
      if (url.includes('f1.json')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ prefix: 'agy_p1', excluded_models: ['gemini-1.5-pro'] }),
        });
      }
      return Promise.reject(new Error('Unknown url'));
    });

    const records = await loadAuthFilesWithPrefixes({
      key: 'test-key',
      fetchFn: mockFetch,
    });

    expect(records).toEqual([
      {
        name: 'f1.json',
        prefix: 'agy_p1',
        excluded_models: ['gemini-1.5-pro'],
        unavailable: false,
        disabled: false,
        cooldowns: [],
        recent_requests: [],
        success: 0,
        failed: 0,
      },
    ]);
  });

  it('fails closed on 404 download failure without returning partially editable prefix: "" fallback', async () => {
    const mockFetch = vi.fn().mockImplementation((url) => {
      if (url === '/v0/management/auth-files') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            files: [{ name: 'good.json' }, { name: 'missing.json' }],
          }),
        });
      }
      if (url.includes('good.json')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ prefix: 'agy_p1' }),
        });
      }
      if (url.includes('missing.json')) {
        return Promise.resolve({
          ok: false,
          status: 404,
          json: async () => ({ error: 'not_found' }),
        });
      }
      return Promise.reject(new Error('Unknown url'));
    });

    // MUST reject entire load rather than returning prefix: '' for missing.json
    await expect(
      loadAuthFilesWithPrefixes({
        key: 'test-key',
        fetchFn: mockFetch,
      })
    ).rejects.toThrow('Failed to load auth file "missing.json": 404 Not Found');
  });

  it('loads auth files with legitimate duplicate prefixes in CLIProxyAPI pool', async () => {
    const mockFetch = vi.fn().mockImplementation((url) => {
      if (url === '/v0/management/auth-files') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            files: [{ name: 'account-1.json' }, { name: 'account-2.json' }],
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ prefix: 'duplicate_prefix' }),
      });
    });

    const records = await loadAuthFilesWithPrefixes({
      key: 'test-key',
      fetchFn: mockFetch,
    });

    expect(records).toEqual([
      {
        name: 'account-1.json',
        prefix: 'duplicate_prefix',
        excluded_models: [],
        unavailable: false,
        disabled: false,
        cooldowns: [],
        recent_requests: [],
        success: 0,
        failed: 0,
      },
      {
        name: 'account-2.json',
        prefix: 'duplicate_prefix',
        excluded_models: [],
        unavailable: false,
        disabled: false,
        cooldowns: [],
        recent_requests: [],
        success: 0,
        failed: 0,
      },
    ]);
  });

  it('seamlessly integrates and decodes OmniAuth Pro accounts from /hub/accounts without failing closed on encrypted files', async () => {
    const mockFetch = vi.fn().mockImplementation((url) => {
      if (url === '/v0/management/auth-files') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            files: [
              { name: 'antigravity-account.json', provider: 'antigravity' },
              { name: 'nan-ea07f57cae3f.json', provider: '' },
            ],
          }),
        });
      }
      if (url === '/v0/management/hub/accounts') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            accounts: [
              {
                id: 'nan-ea07f57cae3f.json',
                provider: 'nan',
                prefix: 'nan',
                label: 'NaN Builders Pro',
                in_cooldown: false,
              },
              {
                id: 'nvidia-nim-acc2.json',
                provider: 'nvidia',
                prefix: 'nvidia',
                label: 'NVIDIA NIM Account 2',
                in_cooldown: true,
              },
            ],
          }),
        });
      }
      if (url.includes('antigravity-account.json')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ prefix: 'agy' }),
        });
      }
      // If CPAMC attempts to download encrypted nan file, it would return raw cipher/error
      if (url.includes('nan-ea07f57cae3f.json')) {
        return Promise.reject(new Error('SyntaxError: Unexpected token in JSON at position 0'));
      }
      return Promise.reject(new Error(`Unhandled URL: ${url}`));
    });

    const records = await loadAuthFilesWithPrefixes({
      key: 'test-key',
      fetchFn: mockFetch,
    });

    expect(records.length).toBe(3);
    const nanRec = records.find((r) => r.name === 'nan-ea07f57cae3f.json');
    expect(nanRec).toBeDefined();
    expect(nanRec.prefix).toBe('nan');
    expect(nanRec.provider).toBe('nan');
    expect(nanRec.email).toBe('NaN Builders Pro');

    const nvidiaRec = records.find((r) => r.name === 'nvidia-nim-acc2.json');
    expect(nvidiaRec).toBeDefined();
    expect(nvidiaRec.prefix).toBe('nvidia');
    expect(nvidiaRec.provider).toBe('nvidia');
    expect(nvidiaRec.unavailable).toBe(true);
    expect(nvidiaRec.cooldowns.length).toBeGreaterThan(0);
  });
});

describe('buildGraphFromAuthFiles & Credential Leak Prevention', () => {
  it('assigns immutable exact file names as node IDs and links parent/child edges', () => {
    const authFiles = [
      { name: 'auth-root.json', prefix: 'agy_p1' },
      { name: 'auth-child-1.json', prefix: 'agy_p1_1' },
      { name: 'auth-child-2.json', prefix: 'agy_p1_2' },
      { name: 'auth-unlinked.json', prefix: '' },
    ];

    const { nodes, edges } = buildGraphFromAuthFiles(authFiles);

    expect(nodes.length).toBe(4);
    // Node IDs MUST be exact file names
    expect(nodes[0].id).toBe('auth-root.json');
    expect(nodes[1].id).toBe('auth-child-1.json');
    expect(nodes[2].id).toBe('auth-child-2.json');
    expect(nodes[3].id).toBe('auth-unlinked.json');

    // Data verification
    expect(nodes[0].data.fileName).toBe('auth-root.json');
    expect(nodes[0].data.prefix).toBe('agy_p1');
    expect(nodes[0].data.initialPrefix).toBe('agy_p1');
    expect(nodes[0].data.isDirty).toBe(false);
    expect(nodes[0].data.isSynthetic).toBe(false);
    expect(nodes[0].data.isRoot).toBe(true);

    expect(nodes[1].data.isRoot).toBe(false);
    expect(nodes[2].data.isRoot).toBe(false);

    // Edges verification
    expect(edges.length).toBe(2);
    expect(edges[0].source).toBe('auth-root.json');
    expect(edges[0].target).toBe('auth-child-1.json');
    expect(edges[1].source).toBe('auth-root.json');
    expect(edges[1].target).toBe('auth-child-2.json');
  });

  it('forwards excluded_models and excludedModels to node.data and root node properties', () => {
    const authFiles = [
      { name: 'auth-spec.json', prefix: 'agy', excluded_models: ['gemini-1.5-pro'] },
    ];
    const { nodes } = buildGraphFromAuthFiles(authFiles);
    expect(nodes[0].excluded_models).toEqual(['gemini-1.5-pro']);
    expect(nodes[0].excludedModels).toEqual(['gemini-1.5-pro']);
    expect(nodes[0].data.excluded_models).toEqual(['gemini-1.5-pro']);
    expect(nodes[0].data.excludedModels).toEqual(['gemini-1.5-pro']);
  });

  it('builds graph with duplicate prefixes and leaves ambiguous nodes disconnected', () => {
    const filesWithDuplicateParents = [
      { name: 'parent-a.json', prefix: 'agy_p1' },
      { name: 'parent-b.json', prefix: 'agy_p1' },
      { name: 'child-ambiguous.json', prefix: 'agy_p1_1' },
      { name: 'parent-solo.json', prefix: 'agy_p2' },
      { name: 'child-solo.json', prefix: 'agy_p2_1' },
    ];

    const { nodes, edges } = buildGraphFromAuthFiles(filesWithDuplicateParents);

    expect(nodes.length).toBe(5);
    // Graph inference must NOT invent parent edge when duplicate parent prefix (leave ambiguous nodes disconnected)
    // Only child-solo.json has an unambiguous parent (parent-solo.json)
    expect(edges.length).toBe(1);
    expect(edges[0].source).toBe('parent-solo.json');
    expect(edges[0].target).toBe('child-solo.json');

    // child-ambiguous.json remains disconnected (no edge invented)
    expect(edges.some((e) => e.target === 'child-ambiguous.json')).toBe(false);
  });

  it('projects dual visual nodes for Antigravity accounts assigned across Gemini and Claude pools', () => {
    const authFiles = [
      { name: 'antigravity-shared.json', type: 'antigravity', prefix: 'agy' },
      { name: 'antigravity-claude-leader.json', type: 'antigravity', prefix: 'agy_clau' },
    ];
    const registeredPools = [
      {
        id: 'Pool-01-gemini',
        family: 'gemini_pure',
        base_prefix: 'agy',
        leader_auth: 'antigravity-shared.json',
      },
      {
        id: 'Pool-04-claude',
        family: 'claude',
        base_prefix: 'agy_clau',
        leader_auth: 'antigravity-claude-leader.json',
        reserves: ['antigravity-shared.json'],
      },
    ];

    const { nodes, edges } = buildGraphFromAuthFiles(authFiles, { registeredPools });

    // antigravity-shared.json must be projected as two distinct nodes
    const geminiNode = nodes.find((n) => n.id === 'antigravity-shared.json@gemini');
    const claudeNode = nodes.find((n) => n.id === 'antigravity-shared.json@claude');

    expect(geminiNode).toBeDefined();
    expect(claudeNode).toBeDefined();
    expect(geminiNode.data.fileName).toBe('antigravity-shared.json');
    expect(claudeNode.data.fileName).toBe('antigravity-shared.json');
    expect(geminiNode.data.roleSuffix).toBe('gemini');
    expect(claudeNode.data.roleSuffix).toBe('claude');

    // Gemini facet is leader of Pool-01-gemini -> isRoot = true
    expect(geminiNode.data.isPoolLeader).toBe(true);
    expect(geminiNode.data.isRoot).toBe(true);

    // Claude facet is reserve of Pool-04-claude -> isChild = true, target of edge from claude leader
    expect(claudeNode.data.isPoolLeader).toBe(false);
    expect(claudeNode.data.isRoot).toBe(false);

    // Edge from claude leader to claude facet of shared account
    const claudeEdge = edges.find(
      (e) => e.source === 'antigravity-claude-leader.json' && e.target === 'antigravity-shared.json@claude'
    );
    expect(claudeEdge).toBeDefined();
  });
});

describe('sanitizeFileName Helper', () => {
  it('sanitizes control characters and preserves valid file names', () => {
    expect(sanitizeFileName('normal-account.json')).toBe('normal-account.json');
    expect(sanitizeFileName('antigravity account #1.json')).toBe('antigravity account #1.json');
    expect(sanitizeFileName('bad\x00file\x1fname.json')).toBe('badfilename.json');
    expect(sanitizeFileName('')).toBe('unknown');
    expect(sanitizeFileName(null)).toBe('unknown');
  });
});

describe('patchAuthFilePrefix - Management PATCH /v0/management/auth-files/fields', () => {
  it('sends PATCH request with exact physical filename and prefix', async () => {
    let capturedUrl = null;
    let capturedOptions = null;

    const mockFetch = vi.fn().mockImplementation((url, opts) => {
      capturedUrl = url;
      capturedOptions = opts;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ status: 'ok' }),
      });
    });

    const res = await patchAuthFilePrefix('account-1.json', 'agy_p1', {
      key: 'secret-mgmt-key-123',
      fetchFn: mockFetch,
    });

    expect(capturedUrl).toBe('/v0/management/auth-files/fields');
    expect(capturedOptions.method).toBe('PATCH');
    expect(capturedOptions.headers['Content-Type']).toBe('application/json');
    expect(capturedOptions.headers['Authorization']).toBe('Bearer secret-mgmt-key-123');

    const body = JSON.parse(capturedOptions.body);
    expect(body).toEqual({
      name: 'account-1.json',
      prefix: 'agy_p1',
    });

    expect(res).toEqual({
      name: 'account-1.json',
      prefix: 'agy_p1',
      status: 200,
    });
  });

  it('allows empty string prefix explicitly per API contract', async () => {
    let capturedBody = null;

    const mockFetch = vi.fn().mockImplementation((url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ status: 'ok' }),
      });
    });

    const res = await patchAuthFilePrefix('cleared.json', '', {
      key: 'test-key',
      fetchFn: mockFetch,
    });

    expect(capturedBody).toEqual({
      name: 'cleared.json',
      prefix: '',
    });
    expect(res.prefix).toBe('');
  });

  it('fails closed when filename is invalid or empty', async () => {
    await expect(patchAuthFilePrefix('', 'agy_p1', { key: 'k' })).rejects.toThrow(
      'Invalid auth file name: filename must be a non-empty string'
    );
    await expect(patchAuthFilePrefix(null, 'agy_p1', { key: 'k' })).rejects.toThrow(
      'Invalid auth file name: filename must be a non-empty string'
    );
  });

  it('handles 401 Unauthorized with sanitized error without leaking bearer key', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: 'unauthorized' }),
    });

    const promise = patchAuthFilePrefix('acc.json', 'p1', {
      key: 'super-sensitive-secret-token',
      fetchFn: mockFetch,
    });

    await expect(promise).rejects.toThrow(
      '401 Unauthorized: Invalid or expired management key for "acc.json"'
    );
    // Crucial check: verify that sensitive token does not leak in error message
    await expect(promise).rejects.not.toThrow('super-sensitive-secret-token');
  });

  it('handles 404 Not Found with sanitized error', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: 'not found' }),
    });

    await expect(
      patchAuthFilePrefix('missing.json', 'p1', {
        key: 'test-key',
        fetchFn: mockFetch,
      })
    ).rejects.toThrow('404 Not Found: Auth file "missing.json" not found');
  });

  it('handles 409 Conflict with sanitized error', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: 'conflict' }),
    });

    await expect(
      patchAuthFilePrefix('conflict.json', 'p1', {
        key: 'test-key',
        fetchFn: mockFetch,
      })
    ).rejects.toThrow('409 Conflict: Resource conflict for "conflict.json"');
  });

  it('strictly disallows options from overriding method, body, or Content-Type for patch', async () => {
    let capturedOptions = null;
    const mockFetch = vi.fn().mockImplementation((url, opts) => {
      capturedOptions = opts;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ status: 'ok' }),
      });
    });

    // Malicious caller attempts to override HTTP method, body, and Content-Type
    await patchAuthFilePrefix('legit-account.json', 'valid_prefix', {
      key: 'safe-mgmt-key',
      fetchFn: mockFetch,
      method: 'DELETE',
      body: '{"malicious_overwrite": true}',
      headers: {
        'content-type': 'text/plain',
        'Content-Type': 'application/xml',
        'X-Allowed-Audit': 'audit-999',
      },
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    // Method MUST be PATCH
    expect(capturedOptions.method).toBe('PATCH');
    // Body MUST be JSON string of legitimate record
    expect(JSON.parse(capturedOptions.body)).toEqual({
      name: 'legit-account.json',
      prefix: 'valid_prefix',
    });
    // Content-Type MUST be strictly application/json
    expect(capturedOptions.headers['Content-Type']).toBe('application/json');
    expect(capturedOptions.headers['content-type']).toBeUndefined();
    // Custom non-conflicting headers MUST be preserved
    expect(capturedOptions.headers['X-Allowed-Audit']).toBe('audit-999');
    // Authorization must be authoritative key
    expect(capturedOptions.headers.Authorization).toBe('Bearer safe-mgmt-key');
  });
});

describe('saveAuthFilePrefixes - Multi-File Staging and Non-Atomic Partial Failure Handling', () => {
  it('saves multiple files and returns successful records', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: 'ok' }),
    });

    const result = await saveAuthFilePrefixes(
      [
        { name: 'acc1.json', prefix: 'agy_p1' },
        { name: 'acc2.json', prefix: 'agy_p1_1' },
      ],
      { key: 'test-key', fetchFn: mockFetch }
    );

    expect(result.successful.length).toBe(2);
    expect(result.failed.length).toBe(0);
    expect(result.successful).toEqual([
      { name: 'acc1.json', prefix: 'agy_p1' },
      { name: 'acc2.json', prefix: 'agy_p1_1' },
    ]);
  });

  it('filters out synthetic nodes and never sends them to the Management API', async () => {
    const calls = [];
    const mockFetch = vi.fn().mockImplementation((url, opts) => {
      calls.push(JSON.parse(opts.body));
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ status: 'ok' }),
      });
    });

    const result = await saveAuthFilePrefixes(
      [
        { name: 'real-1.json', prefix: 'agy_p1', isSynthetic: false },
        { name: 'synthetic-node-1', prefix: 'syn_p1', isSynthetic: true },
        { name: 'real-2.json', prefix: 'agy_p1_1', isSynthetic: false },
      ],
      { key: 'test-key', fetchFn: mockFetch }
    );

    expect(calls.length).toBe(2);
    expect(calls.some((c) => c.name === 'synthetic-node-1')).toBe(false);
    expect(result.successful.length).toBe(2);
    expect(result.successful.map((s) => s.name)).toEqual(['real-1.json', 'real-2.json']);
  });

  it('permits saving duplicate prefixes for legitimate account rotation pools in CLIProxyAPI', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });

    const result = await saveAuthFilePrefixes(
      [
        { name: 'acc1.json', prefix: 'duplicate_pool' },
        { name: 'acc2.json', prefix: 'duplicate_pool' },
      ],
      { key: 'test-key', fetchFn: mockFetch }
    );

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.successful.length).toBe(2);
    expect(result.failed.length).toBe(0);
  });

  it('handles multi-file partial failure without claiming atomicity (Promise.allSettled)', async () => {
    const mockFetch = vi.fn().mockImplementation((url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.name === 'success.json') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ status: 'ok' }),
        });
      }
      if (body.name === 'conflict.json') {
        return Promise.resolve({
          ok: false,
          status: 409,
          json: async () => ({ error: 'duplicate prefix in backend' }),
        });
      }
      return Promise.reject(new Error('unknown'));
    });

    const result = await saveAuthFilePrefixes(
      [
        { name: 'success.json', prefix: 'agy_new' },
        { name: 'conflict.json', prefix: 'agy_conflict' },
      ],
      { key: 'test-key', fetchFn: mockFetch }
    );

    expect(result.successful).toEqual([{ name: 'success.json', prefix: 'agy_new' }]);
    expect(result.failed.length).toBe(1);
    expect(result.failed[0].name).toBe('conflict.json');
    expect(result.failed[0].error).toContain('409 Conflict');
  });

  describe('VP-7 Display Metadata, Type Fallback, and Masked Email Conventions', () => {
    it('abbreviates email with local part <= 6 characters unchanged matching cmd/cpamc-auto-switcher/main.go', () => {
      expect(abbreviateEmail('a@b.com')).toBe('a@b.com');
      expect(abbreviateEmail('user@test.org')).toBe('user@test.org');
      expect(abbreviateEmail('abcdef@domain.com')).toBe('abcdef@domain.com');
    });

    it('abbreviates email with local part > 6 characters to first3...last3 preserving domain', () => {
      expect(abbreviateEmail('abcdefg@domain.com')).toBe('abc...efg@domain.com');
      expect(abbreviateEmail('antigravity.account@gmail.com')).toBe('ant...unt@gmail.com');
      expect(abbreviateEmail('developer-john@corp.io')).toBe('dev...ohn@corp.io');
    });

    it('returns raw string if email lacks an at-sign', () => {
      expect(abbreviateEmail('not_an_email')).toBe('not_an_email');
      expect(abbreviateEmail('')).toBe('');
    });

    it('extracts and masks email safely when explicit email field is provided', () => {
      expect(extractSafeMaskedEmail('admin.superdeveloper@cluster.local', 'auth.json')).toBe(
        'adm...per@cluster.local'
      );
      expect(extractSafeMaskedEmail('simple@domain.com', 'auth.json')).toBe(
        'simple@domain.com'
      );
    });

    it('derives email from filename when email field is absent and filename contains an email pattern', () => {
      const derived = extractSafeMaskedEmail('', 'antigravity-user.name@provider.org.json');
      expect(derived).toBe('use...ame@provider.org');

      const derivedPlus = extractSafeMaskedEmail(
        null,
        'codex-myaccount@domain.co-plus.json'
      );
      expect(derivedPlus).toBe('mya...unt@domain.co');
    });

    it('avoids displaying full filename as email when filename lacks an email pattern', () => {
      expect(extractSafeMaskedEmail('', 'account-1.json')).toBe('');
      expect(extractSafeMaskedEmail(undefined, 'agy_profile_prod.json')).toBe('');
      expect(extractSafeMaskedEmail(null, 'default-auth.json')).toBe('');
    });

    it('propagates type, provider, and email safely through listAuthFiles', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          files: [
            {
              name: 'f1.json',
              type: 'antigravity',
              provider: 'antigravity',
              email: 'antigravity.corp@gmail.com',
            },
            {
              name: 'f2.json',
              type: '',
              provider: 'codex',
              email: 'short@codex.ai',
            },
          ],
        }),
      });

      const files = await listAuthFiles({ key: 'test-key', fetchFn: mockFetch });
      expect(files).toHaveLength(2);
      expect(files[0]).toEqual({
        name: 'f1.json',
        id: 'f1.json',
        type: 'antigravity',
        provider: 'antigravity',
        email: 'antigravity.corp@gmail.com',
        status: '',
        auth_index: '',
        project_id: '',
        unavailable: false,
        disabled: false,
        cooldowns: [],
        recent_requests: [],
        success: 0,
        failed: 0,
        next_retry_after: '',
      });
      expect(files[1]).toEqual({
        name: 'f2.json',
        id: 'f2.json',
        type: '',
        provider: 'codex',
        email: 'short@codex.ai',
        status: '',
        auth_index: '',
        project_id: '',
        unavailable: false,
        disabled: false,
        cooldowns: [],
        recent_requests: [],
        success: 0,
        failed: 0,
        next_retry_after: '',
      });
    });

    it('buildGraphFromAuthFiles applies type fallback provider and stores masked email only in node.data', () => {
      const authFiles = [
        {
          name: 'account1.json',
          prefix: 'agy_p1',
          type: 'antigravity',
          provider: 'google',
          email: 'very.long.email.account@domain.org',
        },
        {
          name: 'account2.json',
          prefix: 'agy_p1_1',
          type: '',
          provider: 'codex', // fallback to provider
          email: '', // will derive from filename if present or empty
        },
        {
          name: 'developer.user@openai.com.json',
          prefix: 'agy_p1_2',
          type: '',
          provider: '',
          email: '', // derived from filename
        },
      ];

      const { nodes, edges } = buildGraphFromAuthFiles(authFiles);
      expect(nodes).toHaveLength(3);
      expect(edges).toHaveLength(2);

      // Node 1: explicit type wins over provider, masked email stored
      const n1 = nodes[0];
      expect(n1.data.accountType).toBe('antigravity');
      expect(n1.data.maskedEmail).toBe('ver...unt@domain.org');
      expect(n1.data.email).toBe('ver...unt@domain.org');
      // Crucial: ensure raw full email is NEVER stored in node.data
      expect(n1.data).not.toHaveProperty('rawEmail');
      expect(JSON.stringify(n1.data)).not.toContain('very.long.email.account@domain.org');

      // Node 2: type empty, falls back to provider ('codex')
      const n2 = nodes[1];
      expect(n2.data.accountType).toBe('codex');
      expect(n2.data.maskedEmail).toBe('');

      // Node 3: derived email from filename
      const n3 = nodes[2];
      expect(n3.data.maskedEmail).toBe('dev...ser@openai.com');
      expect(n3.data.email).toBe('dev...ser@openai.com');
      // fileName preserves physical filename, but email fields are masked
      expect(n3.data.fileName).toBe('developer.user@openai.com.json');
    });

    describe('maskDisplayIdentifier Helper', () => {
      it('masks embedded email in filename while preserving suffix and extension', () => {
        expect(maskDisplayIdentifier('developer.user@openai.com.json')).toBe(
          'dev...ser@openai.com.json'
        );
        expect(maskDisplayIdentifier('antigravity-user.name@provider.org.json')).toBe(
          'antigravity-use...ame@provider.org.json'
        );
        expect(maskDisplayIdentifier('codex-myaccount@domain.co-plus.json')).toBe(
          'codex-mya...unt@domain.co-plus.json'
        );
      });

      it('leaves local parts <= 6 characters unchanged matching CPAMC convention', () => {
        expect(maskDisplayIdentifier('short@openai.com.json')).toBe('short@openai.com.json');
        expect(maskDisplayIdentifier('user@domain.com.json')).toBe('user@domain.com.json');
      });

      it('leaves non-email filenames unchanged', () => {
        expect(maskDisplayIdentifier('account-1.json')).toBe('account-1.json');
        expect(maskDisplayIdentifier('auth-root.json')).toBe('auth-root.json');
        expect(maskDisplayIdentifier('my_profile_prod.json')).toBe('my_profile_prod.json');
      });

      it('safely handles empty, null, or undefined values', () => {
        expect(maskDisplayIdentifier('')).toBe('');
        expect(maskDisplayIdentifier(null)).toBe('');
        expect(maskDisplayIdentifier(undefined)).toBe('');
      });

      it('masks embedded emails within error strings and candidate lists', () => {
        const errorMsg =
          'Cannot disconnect profile(s) [developer.user@openai.com.json] with attached descendants. Disconnect descendants first.';
        expect(maskDisplayIdentifier(errorMsg)).toBe(
          'Cannot disconnect profile(s) [dev...ser@openai.com.json] with attached descendants. Disconnect descendants first.'
        );

        const candidateList =
          'Candidates: acc1.json, antigravity-user.name@provider.org.json';
        expect(maskDisplayIdentifier(candidateList)).toBe(
          'Candidates: acc1.json, antigravity-use...ame@provider.org.json'
        );
      });
    });

    it('defensively skips subdirectories and backup folders containing / or \\', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          files: [
            { name: 'backup-6-accounts/antigravity-1.json' },
            { name: 'valid-account.json' },
            { name: 'nested\\backup\\file.json' },
          ],
        }),
      });

      const files = await listAuthFiles({ key: 'test-key', fetchFn: mockFetch });
      expect(files).toHaveLength(1);
      expect(files[0].name).toBe('valid-account.json');
    });
  });
});

describe('virtualizeAccount - POST /v0/management/auto-switcher-pro/virtualize', () => {
  it('posts the clone request and returns the created virtual file', async () => {
    let capturedUrl = null;
    let capturedOptions = null;
    const mockFetch = vi.fn().mockImplementation((url, opts) => {
      capturedUrl = url;
      capturedOptions = opts;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          name: 'acc.agy_clau.json',
          path: '/auth/acc.agy_clau.json',
          prefix: 'agy_clau',
        }),
      });
    });

    const res = await virtualizeAccount(
      {
        sourceFileName: 'acc.json',
        name: 'acc.agy_clau.json',
        prefix: 'agy_clau',
        targetModels: ['claude-sonnet-4-6'],
        targetPatterns: ['claude', 'gpt'],
        oppositeModels: ['gemini-3-flash'],
      },
      { key: 'secret-key', fetchFn: mockFetch }
    );

    expect(capturedUrl).toBe('/v0/management/auto-switcher-pro/virtualize');
    expect(capturedOptions.method).toBe('POST');
    expect(capturedOptions.headers['Authorization']).toBe('Bearer secret-key');
    expect(capturedOptions.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(capturedOptions.body)).toEqual({
      source_file_name: 'acc.json',
      name: 'acc.agy_clau.json',
      prefix: 'agy_clau',
      target_models: ['claude-sonnet-4-6'],
      target_patterns: ['claude', 'gpt'],
      opposite_models: ['gemini-3-flash'],
    });
    expect(res).toEqual({
      name: 'acc.agy_clau.json',
      path: '/auth/acc.agy_clau.json',
      prefix: 'agy_clau',
    });
  });

  it('derives a default target name when omitted', async () => {
    let capturedBody = null;
    const mockFetch = vi.fn().mockImplementation((url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, name: 'acc.agy_clau.json', prefix: 'agy_clau' }),
      });
    });

    await virtualizeAccount(
      { sourceFileName: 'acc.json', prefix: 'agy_clau' },
      { key: 'k', fetchFn: mockFetch }
    );

    expect(capturedBody.name).toBe('acc.agy_clau.json');
  });

  it('fails closed on missing source or prefix', async () => {
    await expect(virtualizeAccount({ prefix: 'agy_clau' }, { key: 'k' })).rejects.toThrow(
      /source/i
    );
    await expect(
      virtualizeAccount({ sourceFileName: 'acc.json' }, { key: 'k' })
    ).rejects.toThrow(/prefix/i);
  });

  it('surfaces the plugin error message when ok is false', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        ok: false,
        error: 'virtualize_failed',
        message: 'source auth file not found: missing.json',
      }),
    });

    await expect(
      virtualizeAccount(
        { sourceFileName: 'missing.json', prefix: 'agy_clau' },
        { key: 'k', fetchFn: mockFetch }
      )
    ).rejects.toThrow('source auth file not found: missing.json');
  });
});

describe('classifyAuthAccount, extractVirtualOrigin, and extractExclusionBadges', () => {
  it('extractVirtualOrigin correctly identifies origin master file and ignores non-virtual files', () => {
    expect(extractVirtualOrigin('antigravity-infosoytec@gmail.com.agy_son.json')).toBe(
      'antigravity-infosoytec@gmail.com.json'
    );
    expect(extractVirtualOrigin('antigravity-infosoytec@gmail.com.agy_son_1.json')).toBe(
      'antigravity-infosoytec@gmail.com.json'
    );
    expect(extractVirtualOrigin('antigravity-wilsonlavio11@gmail.com.agy_opus_2.json')).toBe(
      'antigravity-wilsonlavio11@gmail.com.json'
    );
    expect(extractVirtualOrigin('antigravity-infosoytec@gmail.com.json')).toBeNull();
    expect(extractVirtualOrigin('')).toBeNull();
  });

  it('classifyAuthAccount classifies physical master account without leaks', () => {
    const master = classifyAuthAccount('antigravity-infosoytec@gmail.com.json');
    expect(master.isVirtual).toBe(false);
    expect(master.isMaster).toBe(true);
    expect(master.role).toBe('master');
    expect(master.masterOrigin).toBeNull();
    expect(master.maskedEmail).toBe('inf...tec@gmail.com');
  });

  it('classifyAuthAccount classifies virtual derived accounts pointing to master origin', () => {
    const virtual1 = classifyAuthAccount('antigravity-infosoytec@gmail.com.agy_son.json');
    expect(virtual1.isVirtual).toBe(true);
    expect(virtual1.isMaster).toBe(false);
    expect(virtual1.role).toBe('virtual');
    expect(virtual1.masterOrigin).toBe('antigravity-infosoytec@gmail.com.json');
    expect(virtual1.maskedEmail).toBe('inf...tec@gmail.com');

    const virtualWithSuffix = classifyAuthAccount({
      name: 'antigravity-infosoytec@gmail.com.agy_son_1.json',
      prefix: 'agy_son_1',
    });
    expect(virtualWithSuffix.isVirtual).toBe(true);
    expect(virtualWithSuffix.isMaster).toBe(false);
    expect(virtualWithSuffix.masterOrigin).toBe('antigravity-infosoytec@gmail.com.json');
    expect(virtualWithSuffix.maskedEmail).toBe('inf...tec@gmail.com');
  });

  it('classifyAuthAccount handles node data and custom exclusion badges', () => {
    const node = {
      id: 'node-1',
      data: {
        fileName: 'antigravity-wilsonlavio9@gmail.com.agy_son_4.json',
        prefix: 'agy_son_4',
        excludedModels: ['gemini-1.5-pro', 'claude-sonnet-5-5-high'],
      },
    };
    const result = classifyAuthAccount(node);
    expect(result.isVirtual).toBe(true);
    expect(result.masterOrigin).toBe('antigravity-wilsonlavio9@gmail.com.json');
    expect(result.maskedEmail).toBe('wil...io9@gmail.com');
    expect(result.exclusionBadges).toContain('Excluye 5.5');
    expect(result.exclusionBadges).toContain('Excluye Gemini');
    expect(result.exclusionBadges).toContain('Excluye Claude');
  });

  it('extractExclusionBadges formats human-readable badges', () => {
    expect(extractExclusionBadges([])).toEqual([]);
    expect(extractExclusionBadges(['gemini-pro', 'claude-opus-5-5-high'])).toEqual([
      'Excluye 5.5',
      'Excluye Gemini',
      'Excluye Claude',
    ]);
    expect(extractExclusionBadges(['gemini-1.5-flash', 'gpt-4o'])).toEqual([
      'Excluye Gemini',
      'Excluye Codex',
      'Claude Only',
    ]);
  });
});

describe('deleteAuthFile', () => {
  it('sends authenticated DELETE request with sanitized URL parameter', async () => {
    let capturedUrl = null;
    let capturedOptions = null;
    const mockFetch = vi.fn().mockImplementation((url, opts) => {
      capturedUrl = url;
      capturedOptions = opts;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      });
    });

    const res = await deleteAuthFile('antigravity-infosoytec@gmail.com.agy_son.json', {
      key: 'del-secret-key',
      fetchFn: mockFetch,
    });

    expect(capturedUrl).toBe('/v0/management/auth-files?name=antigravity-infosoytec%40gmail.com.agy_son.json');
    expect(capturedOptions.method).toBe('DELETE');
    expect(capturedOptions.headers['Authorization']).toBe('Bearer del-secret-key');
    expect(res).toEqual({
      name: 'antigravity-infosoytec@gmail.com.agy_son.json',
      ok: true,
      status: 200,
    });
  });

  it('rejects path traversal and invalid filenames', async () => {
    await expect(deleteAuthFile('../evil.json', { key: 'k' })).rejects.toThrow(/traversal/i);
    await expect(deleteAuthFile('sub/dir/file.json', { key: 'k' })).rejects.toThrow(/traversal/i);
    await expect(deleteAuthFile('sub\\dir\\file.json', { key: 'k' })).rejects.toThrow(/traversal/i);
    await expect(deleteAuthFile('not-json.txt', { key: 'k' })).rejects.toThrow(/json/i);
    await expect(deleteAuthFile('', { key: 'k' })).rejects.toThrow(/required/i);
  });
});

describe('buildManagedPoolCards - Scalable N -> 2N Managed Pool Cards Model', () => {
  const physicalMasters4 = [
    {
      id: 'm1',
      data: {
        fileName: 'antigravity-infosoytec@gmail.com.json',
        email: 'infosoytec@gmail.com',
        prefix: 'agy',
        provider: 'antigravity',
      },
    },
    {
      id: 'm2',
      data: {
        fileName: 'antigravity-maribelluzbonitaaquinocastro@gmail.com.json',
        email: 'maribelluzbonitaaquinocastro@gmail.com',
        prefix: 'agy_1',
        provider: 'antigravity',
      },
    },
    {
      id: 'm3',
      data: {
        fileName: 'antigravity-wilsonlavio11@gmail.com.json',
        email: 'wilsonlavio11@gmail.com',
        prefix: 'agy_2',
        provider: 'antigravity',
      },
    },
    {
      id: 'm4',
      data: {
        fileName: 'antigravity-wilsonlavio9@gmail.com.json',
        email: 'wilsonlavio9@gmail.com',
        prefix: 'agy_3',
        provider: 'antigravity',
      },
    },
  ];

  it('generates exactly 8 managed cards (4 Gemini + 4 Claude) from 4 physical master nodes', () => {
    const cards = buildManagedPoolCards(physicalMasters4);
    expect(cards).toHaveLength(8);

    const geminiCards = cards.filter((c) => c.familyRole === 'gemini');
    const claudeCards = cards.filter((c) => c.familyRole === 'claude');
    expect(geminiCards).toHaveLength(4);
    expect(claudeCards).toHaveLength(4);

    // Gemini leader card m1
    const leaderCard = geminiCards.find((c) => c.masterFileName === 'antigravity-infosoytec@gmail.com.json');
    expect(leaderCard).toBeDefined();
    expect(leaderCard.assignedPrefix).toBe('agy');
    expect(leaderCard.poolRole).toBe('leader');
    expect(leaderCard.activePoolBase).toBe('agy');
    expect(leaderCard.maskedEmail).toBe('inf...tec@gmail.com');

    // Gemini reserve card m2
    const reserveCard = geminiCards.find((c) => c.masterFileName === 'antigravity-maribelluzbonitaaquinocastro@gmail.com.json');
    expect(reserveCard).toBeDefined();
    expect(reserveCard.assignedPrefix).toBe('agy_1');
    expect(reserveCard.poolRole).toBe('reserve');
    expect(reserveCard.activePoolBase).toBe('agy');
    expect(reserveCard.maskedEmail).toBe('mar...tro@gmail.com');

    // Unassigned Claude cards
    claudeCards.forEach((c) => {
      expect(c.assignedPrefix).toBe('');
      expect(c.poolRole).toBe('unassigned');
      expect(c.activePoolBase).toBe('');
      expect(c.virtualFileName).toBe('');
    });
  });

  it('merges active virtual credentials on disk into Claude cards without duplicating cards', () => {
    const nodesWithVirtuals = [
      ...physicalMasters4,
      {
        id: 'v1',
        data: {
          fileName: 'antigravity-infosoytec@gmail.com.agy_son.json',
          email: 'infosoytec@gmail.com',
          prefix: 'agy_son',
          provider: 'antigravity',
          excludedModels: ['gemini-1.5-pro', 'claude-sonnet-5-5-high'],
        },
      },
      {
        id: 'v2',
        data: {
          fileName: 'antigravity-maribelluzbonitaaquinocastro@gmail.com.agy_son_1.json',
          email: 'maribelluzbonitaaquinocastro@gmail.com',
          prefix: 'agy_son_1',
          provider: 'antigravity',
          excludedModels: ['gemini-2.0-flash'],
        },
      },
    ];

    const cards = buildManagedPoolCards(nodesWithVirtuals);
    // Still strictly 8 cards (4 masters -> 8 cards)
    expect(cards).toHaveLength(8);

    const claudeCards = cards.filter((c) => c.familyRole === 'claude');
    expect(claudeCards).toHaveLength(4);

    const sonnetLeader = claudeCards.find((c) => c.masterFileName === 'antigravity-infosoytec@gmail.com.json');
    expect(sonnetLeader.assignedPrefix).toBe('agy_son');
    expect(sonnetLeader.poolRole).toBe('leader');
    expect(sonnetLeader.activePoolBase).toBe('agy_son');
    expect(sonnetLeader.virtualFileName).toBe('antigravity-infosoytec@gmail.com.agy_son.json');
    expect(sonnetLeader.exclusionBadges).toContain('Excluye 5.5');
    expect(sonnetLeader.exclusionBadges).toContain('Excluye Gemini');

    const sonnetReserve = claudeCards.find((c) => c.masterFileName === 'antigravity-maribelluzbonitaaquinocastro@gmail.com.json');
    expect(sonnetReserve.assignedPrefix).toBe('agy_son_1');
    expect(sonnetReserve.poolRole).toBe('reserve');
    expect(sonnetReserve.activePoolBase).toBe('agy_son');
    expect(sonnetReserve.virtualFileName).toBe('antigravity-maribelluzbonitaaquinocastro@gmail.com.agy_son_1.json');
    expect(sonnetReserve.exclusionBadges).toContain('Excluye Gemini');
  });

  it('scales to exactly 10 cards (5 Gemini + 5 Claude) when a 5th master account is added', () => {
    const physicalMasters5 = [
      ...physicalMasters4,
      {
        id: 'm5',
        data: {
          fileName: 'antigravity-cuenta5@gmail.com.json',
          email: 'cuenta5@gmail.com',
          prefix: '',
          provider: 'antigravity',
        },
      },
    ];

    const cards = buildManagedPoolCards(physicalMasters5);
    expect(cards).toHaveLength(10);
    expect(cards.filter((c) => c.familyRole === 'gemini')).toHaveLength(5);
    expect(cards.filter((c) => c.familyRole === 'claude')).toHaveLength(5);

    const m5Gemini = cards.find((c) => c.masterFileName === 'antigravity-cuenta5@gmail.com.json' && c.familyRole === 'gemini');
    expect(m5Gemini.poolRole).toBe('unassigned');
    expect(m5Gemini.assignedPrefix).toBe('');
    expect(m5Gemini.maskedEmail).toBe('cue...ta5@gmail.com');
  });

  it('discards references to deleted physical accounts and prevents ghost cards when registeredPools are passed', () => {
    // Pool registrado con líder y 2 reservas
    const registeredPools = [
      {
        family: 'gemini_pure',
        base_prefix: 'agy',
        leader_auth: 'antigravity-leader.json',
        reserves: ['antigravity-alive-res.json', 'antigravity-deleted-res.json'],
        policy: { disable_isolation: false },
      },
    ];

    // Solo leader y alive-res existen en nodes (deleted-res fue eliminada de CPAMC)
    const nodes = [
      {
        id: 'n1',
        data: {
          fileName: 'antigravity-leader.json',
          email: 'leader@gmail.com',
          prefix: 'agy',
        },
      },
      {
        id: 'n2',
        data: {
          fileName: 'antigravity-alive-res.json',
          email: 'res@gmail.com',
          prefix: 'agy_1',
        },
      },
    ];

    const cards = buildManagedPoolCards(nodes, registeredPools);
    // Exactamente 2 cards (leader y alive-res), omitiendo estrictamente la borrada
    expect(cards).toHaveLength(2);
    expect(cards.map((c) => c.masterFileName)).toEqual([
      'antigravity-leader.json',
      'antigravity-alive-res.json',
    ]);
  });

  it('retains exclusion metadata so detectSpecialistState recognizes single-model specialist status', () => {
    const nodes = [
      {
        id: 'spec-node.json',
        data: {
          fileName: 'antigravity-user@gmail.com.json',
          prefix: 'agy',
          excluded_models: ['gemini-2.5-flash', 'gemini-2.0-flash'],
        },
      },
    ];
    const cards = buildManagedPoolCards(nodes);
    const geminiCard = cards.find((c) => c.familyRole === 'gemini');
    expect(geminiCard.excluded_models).toEqual(['gemini-2.5-flash', 'gemini-2.0-flash']);
    const catalog = ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'];
    const inherited = resolveInheritedCardModels(geminiCard, catalog);
    const state = detectSpecialistState(geminiCard, inherited);
    expect(state.isSpecialist).toBe(true);
    expect(state.activeSpecialistModel).toBe('gemini-2.5-pro');
  });
});

describe('Specialist Engine - computeSpecialistExclusions, resolveInheritedCardModels, patchAuthFileExclusions, detectSpecialistState', () => {
  describe('computeSpecialistExclusions', () => {
    it('returns a sorted, deduplicated array of all models except the target model', () => {
      const available = [
        'gemini-2.5-pro',
        'gemini-2.5-flash',
        'gemini-2.0-flash',
        'gemini-2.5-pro', // duplicate
      ];
      const target = 'gemini-2.5-pro';
      const result = computeSpecialistExclusions(available, target);
      expect(result).toEqual(['gemini-2.0-flash', 'gemini-2.5-flash']);
    });

    it('returns empty array when available models list is empty or invalid', () => {
      expect(computeSpecialistExclusions([], 'gemini-2.5-pro')).toEqual([]);
      expect(computeSpecialistExclusions(null, 'gemini-2.5-pro')).toEqual([]);
    });

    it('returns all sorted deduplicated models when target model is not in list', () => {
      const available = ['claude-3-7-sonnet', 'claude-3-5-haiku'];
      expect(computeSpecialistExclusions(available, 'other-model')).toEqual([
        'claude-3-5-haiku',
        'claude-3-7-sonnet',
      ]);
    });
  });

  describe('resolveInheritedCardModels', () => {
    const catalog = [
      'g1/gemini-2.5-pro',
      'g1/gemini-2.5-flash',
      'claude-3-7-sonnet',
      'agy_son/claude-3-5-sonnet',
      'codex-mini',
      'gpt-4o',
    ];

    it('resolves and strips route prefixes for gemini family', () => {
      const card = { familyRole: 'gemini' };
      const resolved = resolveInheritedCardModels(card, catalog);
      expect(resolved).toEqual(['gemini-2.5-flash', 'gemini-2.5-pro']);
    });

    it('resolves and strips route prefixes for claude family', () => {
      const card = { familyRole: 'claude' };
      const resolved = resolveInheritedCardModels(card, catalog);
      expect(resolved).toContain('claude-3-7-sonnet');
      expect(resolved).toContain('claude-3-5-sonnet');
      expect(resolved).not.toContain('gemini-2.5-pro');
    });

    it('resolves and strips route prefixes for codex family', () => {
      const card = { familyRole: 'codex' };
      const resolved = resolveInheritedCardModels(card, catalog);
      expect(resolved).toContain('codex-mini');
      expect(resolved).toContain('gpt-4o');
      expect(resolved).not.toContain('gemini-2.5-pro');
    });

    it('excludes models present in globalDisabledModels', () => {
      const card = { familyRole: 'gemini' };
      const globalDisabled = ['gemini-2.5-pro'];
      const resolved = resolveInheritedCardModels(card, catalog, globalDisabled);
      expect(resolved).toEqual(['gemini-2.5-flash']);
    });

    it('strictly filters out virtual pool facades (Pool-XX-*) from inherited card models', () => {
      const card = { familyRole: 'gemini' };
      const catalogWithPools = [
        'gemini-3.8-flash-high',
        'gemini-3-flash',
        'Pool-01-gemini',
        'Pool-02-gemini',
        'Pool-03-claude',
      ];
      const resolved = resolveInheritedCardModels(card, catalogWithPools);
      expect(resolved).toEqual(['gemini-3-flash', 'gemini-3.8-flash-high']);
      expect(resolved).not.toContain('Pool-01-gemini');
      expect(resolved).not.toContain('Pool-02-gemini');
    });

    it('resolves dynamic OmniAuth Pro provider models (nan, nvidia, deepseek) and NEVER contaminates with Gemini', () => {
      const nanCard = { familyRole: 'nan' };
      const omniCatalog = [
        'gemini-3.8-flash-high',
        'nan/deepseek-v4-flash',
        'nan/deepseek-chat',
        'nvidia/meta-llama-3.1-70b',
        'claude-3-7-sonnet',
      ];
      const nanResolved = resolveInheritedCardModels(nanCard, omniCatalog);
      expect(nanResolved).toContain('deepseek-v4-flash');
      expect(nanResolved).toContain('deepseek-chat');
      expect(nanResolved).not.toContain('gemini-3.8-flash-high');
      expect(nanResolved).not.toContain('claude-3-7-sonnet');

      // Fallback a modelos canónicos cuando el catálogo upstream está vacío
      const emptyCatalogCard = { familyRole: 'nan' };
      const fallbackResolved = resolveInheritedCardModels(emptyCatalogCard, []);
      expect(fallbackResolved.length).toBeGreaterThan(0);
      expect(fallbackResolved).toContain('deepseek-v4-flash');
      expect(fallbackResolved).not.toContain('gemini-3.8-flash-high');
    });
  });

  describe('patchAuthFileExclusions', () => {
    it('dispatches PATCH /v0/management/auth-files/fields with name and sorted excluded_models', async () => {
      let capturedUrl = '';
      let capturedBody = null;
      let capturedMethod = '';

      const mockFetch = vi.fn().mockImplementation((url, opts) => {
        capturedUrl = url;
        capturedMethod = opts.method;
        capturedBody = JSON.parse(opts.body);
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ status: 'ok' }),
        });
      });

      const res = await patchAuthFileExclusions(
        'antigravity-user@gmail.com.json',
        ['gemini-2.5-flash', 'gemini-2.0-flash'],
        { key: 'test-key', fetchFn: mockFetch }
      );

      expect(capturedUrl).toBe('/v0/management/auth-files/fields');
      expect(capturedMethod).toBe('PATCH');
      expect(capturedBody).toEqual({
        name: 'antigravity-user@gmail.com.json',
        excluded_models: ['gemini-2.0-flash', 'gemini-2.5-flash'],
      });
      expect(res.ok || res.status === 200).toBe(true);
      expect(res.excluded_models).toEqual(['gemini-2.0-flash', 'gemini-2.5-flash']);
    });

    it('rejects invalid or empty fileName with fail-closed error', async () => {
      await expect(patchAuthFileExclusions('', ['model-a'])).rejects.toThrow(
        'Invalid auth file name: filename must be a non-empty string'
      );
    });

    it('handles 401 Unauthorized with sanitized masked error', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ error: 'unauthorized' }),
      });

      await expect(
        patchAuthFileExclusions('antigravity-secret@domain.com.json', [], {
          key: 'top-secret',
          fetchFn: mockFetch,
        })
      ).rejects.toThrow('401 Unauthorized');
    });
  });

  describe('detectSpecialistState', () => {
    const inherited = ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'];

    it('detects specialist mode when exactly one model is not excluded', () => {
      const card = {
        excluded_models: ['gemini-2.5-flash', 'gemini-2.0-flash'],
      };
      const state = detectSpecialistState(card, inherited);
      expect(state.isSpecialist).toBe(true);
      expect(state.activeSpecialistModel).toBe('gemini-2.5-pro');
      expect(state.excludedCount).toBe(2);
    });

    it('detects multipurpose mode when no models are excluded', () => {
      const card = {
        excluded_models: [],
      };
      const state = detectSpecialistState(card, inherited);
      expect(state.isSpecialist).toBe(false);
      expect(state.activeSpecialistModel).toBeNull();
    });

    it('detects multipurpose mode when multiple models remain active', () => {
      const card = {
        excluded_models: ['gemini-2.0-flash'],
      };
      const state = detectSpecialistState(card, inherited);
      expect(state.isSpecialist).toBe(false);
      expect(state.activeSpecialistModel).toBeNull();
    });
  });

  describe('Quota Telemetry & Tier Summary Engine (MINI-003)', () => {
    it('parseAntigravityTierSummary parses g1-pro-tier as Pro', () => {
      const payload = {
        currentTier: { id: 'g1-pro-tier', name: 'Google One Pro' },
      };
      const res = parseAntigravityTierSummary(payload);
      expect(res.plan).toBe('Pro');
      expect(res.tierId).toBe('g1-pro-tier');
    });

    it('parseAntigravityTierSummary parses paidTier precedence and other tiers', () => {
      const ultraPayload = {
        currentTier: { id: 'free-tier' },
        paidTier: { id: 'g1-ultra-tier', name: 'Ultra' },
      };
      expect(parseAntigravityTierSummary(ultraPayload).plan).toBe('Ultra');

      const freePayload = {
        currentTier: { id: 'free-tier' },
      };
      expect(parseAntigravityTierSummary(freePayload).plan).toBe('Free');
    });

    it('parseAntigravityQuotaPayload unwraps Antigravity envelope and calculates 5h/weekly remaining percentages', () => {
      const quotaEnvelope = {
        statusCode: 200,
        body: {
          groups: [
            {
              displayName: 'Gemini Models',
              buckets: [
                {
                  displayName: 'Five Hour Limit',
                  remainingFraction: 1.0,
                  resetTime: '2026-10-09T20:00:00Z',
                },
                {
                  displayName: 'Weekly Limit',
                  remainingFraction: 0.98,
                  resetTime: '2026-10-16T20:00:00Z',
                },
              ],
            },
            {
              displayName: 'Claude and GPT models',
              buckets: [
                {
                  displayName: 'Five Hour Limit',
                  remainingFraction: 0.75,
                  resetTime: '2026-10-09T20:00:00Z',
                },
                {
                  displayName: 'Weekly Limit',
                  remainingFraction: 0.50,
                  resetTime: '2026-10-16T20:00:00Z',
                },
              ],
            },
          ],
        },
      };

      const groups = parseAntigravityQuotaPayload(quotaEnvelope);
      expect(groups).toHaveLength(2);

      const geminiGroup = groups.find((g) => g.title === 'GEMINI MODELS');
      expect(geminiGroup).toBeDefined();
      expect(geminiGroup.rows[0].label).toBe('Five Hour Limit');
      expect(geminiGroup.rows[0].percent).toBe(100);
      expect(geminiGroup.rows[0].percentLabel).toBe('Quota available');
      expect(geminiGroup.rows[1].label).toBe('Weekly Limit');
      expect(geminiGroup.rows[1].percent).toBe(98);
      expect(geminiGroup.rows[1].percentLabel).toBe('98% remaining');

      const claudeGroup = groups.find((g) => g.title === 'CLAUDE AND GPT MODELS');
      expect(claudeGroup).toBeDefined();
      expect(claudeGroup.rows[0].label).toBe('Five Hour Limit');
      expect(claudeGroup.rows[0].percent).toBe(75);
      expect(claudeGroup.rows[0].percentLabel).toBe('75% remaining');
      expect(claudeGroup.rows[1].label).toBe('Weekly Limit');
      expect(claudeGroup.rows[1].percent).toBe(50);
      expect(claudeGroup.rows[1].percentLabel).toBe('50% remaining');
    });

    it('fetchCardQuota queries /v0/management/api-call and returns plan and parsed groups', async () => {
      const mockFetch = vi.fn().mockImplementation((url, opts) => {
        const body = JSON.parse(opts.body);
        if (body.url.includes('loadCodeAssist')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              statusCode: 200,
              body: { currentTier: { id: 'g1-pro-tier' } },
            }),
          });
        }
        if (body.url.includes('retrieveUserQuotaSummary')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              statusCode: 200,
              body: {
                groups: [
                  {
                    displayName: 'Gemini Models',
                    buckets: [
                      { displayName: '5h', remainingFraction: 1.0 },
                      { displayName: 'Weekly', remainingFraction: 0.9 },
                    ],
                  },
                ],
              },
            }),
          });
        }
        return Promise.reject(new Error('Unknown url'));
      });

      const card = {
        fileName: 'antigravity-infosoytec@gmail.com.json',
        auth_index: '0',
      };

      const result = await fetchCardQuota(card, {
        key: 'test-key',
        fetchFn: mockFetch,
      });

      expect(result.plan).toBe('Pro');
      expect(result.groups).toHaveLength(1);
      expect(result.groups[0].title).toBe('GEMINI MODELS');
      expect(result.groups[0].rows[0].percent).toBe(100);
      expect(result.groups[0].rows[1].percent).toBe(90);
    });

    it('fetchCardQuota returns EMPTY groups (no fabricated mocks) when live quota endpoints are unreachable', async () => {
      const mockFetch = vi.fn().mockImplementation((url, opts) => {
        const body = JSON.parse(opts.body);
        if (body.url.includes('loadCodeAssist')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              statusCode: 200,
              body: { currentTier: { id: 'free-tier', name: 'Antigravity' } },
            }),
          });
        }
        // All quota summary endpoints fail (e.g. 403 SUBSCRIPTION_REQUIRED)
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            statusCode: 403,
            body: {
              error: {
                code: 403,
                status: 'PERMISSION_DENIED',
                reason: 'SUBSCRIPTION_REQUIRED',
              },
            },
          }),
        });
      });

      const result = await fetchCardQuota(
        { fileName: 'acc.json', auth_index: 'abc123', project_id: 'proj-1' },
        { key: 'test-key', fetchFn: mockFetch }
      );

      // Real tier from loadCodeAssist is preserved (free-tier -> Free)
      expect(result.plan).toBe('Free');
      // CRITICAL: no mock percentage groups are invented when live data fails
      expect(result.groups).toEqual([]);
      expect(result.live).toBe(false);
    });

    it('fetchCardQuota propagates real auth_index to api-call requests', async () => {
      clearQuotaCache();
      const calls = [];
      const mockFetch = vi.fn().mockImplementation((_url, opts) => {
        calls.push(JSON.parse(opts.body));
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ statusCode: 403, body: { error: { code: 403 } } }),
        });
      });

      await fetchCardQuota(
        { fileName: 'acc.json', auth_index: 'deadbeef01', project_id: 'proj-9' },
        { key: 'test-key', fetchFn: mockFetch }
      );

      expect(mockFetch).toHaveBeenCalled();
      expect(calls.length).toBeGreaterThanOrEqual(1);
      calls.forEach((c) => {
        expect(c.authIndex).toBe('deadbeef01');
      });
    });

    it('caches successful quota results for 5 minutes and skips external network calls unless force is true', async () => {
      clearQuotaCache();
      let callCount = 0;
      const mockFetch = vi.fn().mockImplementation((_url, opts) => {
        callCount++;
        const body = JSON.parse(opts.body);
        if (body.url.includes('loadCodeAssist')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              statusCode: 200,
              body: { currentTier: { id: 'g1-pro-tier' } },
            }),
          });
        }
        if (body.url.includes('retrieveUserQuotaSummary')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              statusCode: 200,
              body: {
                groups: [
                  {
                    displayName: 'Gemini Models',
                    buckets: [{ displayName: '5h', remainingFraction: 0.85 }],
                  },
                ],
              },
            }),
          });
        }
        return Promise.reject(new Error('Unknown url'));
      });

      const card = { fileName: 'cache-test-card.json', auth_index: 'idx-123' };

      // 1. Primera consulta: debe disparar llamadas en vivo
      const res1 = await fetchCardQuota(card, { key: 'test-key', fetchFn: mockFetch });
      expect(res1.plan).toBe('Pro');
      expect(res1.groups[0].rows[0].percent).toBe(85);
      expect(res1.cached).toBeUndefined();
      const initialCalls = callCount;
      expect(initialCalls).toBeGreaterThan(0);

      // 2. Segunda consulta antes de 5 minutos: debe devolver del caché al instante (0 llamadas nuevas)
      const res2 = await fetchCardQuota(card, { key: 'test-key', fetchFn: mockFetch });
      expect(res2.plan).toBe('Pro');
      expect(res2.cached).toBe(true);
      expect(callCount).toBe(initialCalls); // Cero llamadas adicionales

      // 3. Consulta con force: true: debe saltarse el caché y consultar en vivo
      const res3 = await fetchCardQuota(card, { key: 'test-key', fetchFn: mockFetch, force: true });
      expect(res3.plan).toBe('Pro');
      expect(res3.cached).toBeUndefined();
      expect(callCount).toBeGreaterThan(initialCalls);
    });
  });

  describe('Real CPAMC Native Telemetry Helpers', () => {
    it('computeAccountTelemetry sums real recent_requests buckets into reqs and ok percentage', () => {
      const buckets = [
        { time: '00:00-00:10', success: 45, failed: 0 },
        { time: '00:10-00:20', success: 14, failed: 0 },
        { time: '00:20-00:30', success: 1, failed: 1 },
      ];
      const t = computeAccountTelemetry(buckets);
      expect(t.reqs).toBe(61);
      expect(t.ok).toBe(60);
      expect(t.failed).toBe(1);
      expect(t.okPct).toBe(98);
    });

    it('computeAccountTelemetry returns 0 reqs and 100% ok for empty activity', () => {
      const t = computeAccountTelemetry([]);
      expect(t).toEqual({ reqs: 0, ok: 0, failed: 0, okPct: 100 });
    });

    it('classifyCooldowns separates gemini vs claude/gpt families and drops expired cooldowns', () => {
      const now = Date.now();
      const cooldowns = [
        {
          scope: 'model',
          model_key: 'gemini-3.8-flash-high',
          reason: 'quota',
          retry_at: new Date(now + 43 * 3600 * 1000).toISOString(),
          http_status: 429,
        },
        {
          scope: 'model',
          model_key: 'claude-sonnet-4-6',
          reason: 'quota',
          retry_at: new Date(now + 48 * 3600 * 1000).toISOString(),
          http_status: 429,
        },
        {
          scope: 'model',
          model_key: 'gemini-3.7-flash-high',
          reason: 'quota',
          retry_at: new Date(now - 3600 * 1000).toISOString(), // already expired
          http_status: 429,
        },
      ];

      const cd = classifyCooldowns(cooldowns, now);
      expect(cd.active).toHaveLength(2);
      expect(cd.hasGemini).toBe(true);
      expect(cd.hasClaudeGpt).toBe(true);
      expect(cd.gemini.modelKey).toBe('gemini-3.8-flash-high');
      expect(cd.claudeGpt.modelKey).toBe('claude-sonnet-4-6');
      // Expired cooldown is excluded from active set
      expect(cd.active.some((a) => a.modelKey === 'gemini-3.7-flash-high')).toBe(false);
    });

    it('formatRemainingDuration renders compact human-readable remaining time', () => {
      const now = Date.now();
      // Durations beyond 24h roll into days (consistent with formatQuotaDuration convention)
      expect(formatRemainingDuration(new Date(now + 43 * 3600 * 1000 + 51 * 60000).toISOString(), now)).toBe(
        '1d 19h'
      );
      expect(formatRemainingDuration(new Date(now + 5 * 3600 * 1000 + 30 * 60000).toISOString(), now)).toBe(
        '5h 30m'
      );
      expect(formatRemainingDuration(new Date(now + 2 * 86400 * 1000 + 11 * 3600 * 1000).toISOString(), now)).toBe(
        '2d 11h'
      );
      expect(formatRemainingDuration(new Date(now - 60000).toISOString(), now)).toBe('0m');
    });
  });
});

describe('Deterministic Pool Sorting Contract (extractPoolNumber & sortPoolsByNumber)', () => {
  it('extractPoolNumber accurately extracts integer indexes from various pool formats', () => {
    expect(extractPoolNumber('Pool-01-gemini')).toBe(1);
    expect(extractPoolNumber('Pool-02-gemini')).toBe(2);
    expect(extractPoolNumber('Pool-04-claude')).toBe(4);
    expect(extractPoolNumber('Pool-12-codex')).toBe(12);
    expect(extractPoolNumber({ id: 'Pool-03-codex' })).toBe(3);
    expect(extractPoolNumber({ base_prefix: 'agy' })).toBe(1);
    expect(extractPoolNumber({ base_prefix: 'agy2' })).toBe(2);
    expect(extractPoolNumber({ base_prefix: 'agy3' })).toBe(3);
    expect(extractPoolNumber({ base_prefix: 'agy_clau' })).toBe(1);
    expect(extractPoolNumber({ base_prefix: 'codex' })).toBe(1);
    expect(extractPoolNumber({ base_prefix: 'custom_pool_5' })).toBe(5);
  });

  it('sortPoolsByNumber stably sorts out-of-order pools by sovereign numerical index', () => {
    const disordered = [
      { id: 'Pool-04-claude', base_prefix: 'agy_clau' },
      { id: 'Pool-02-gemini', base_prefix: 'agy2' },
      { id: 'Pool-01-gemini', base_prefix: 'agy' },
      { id: 'Pool-03-codex', base_prefix: 'codex' },
    ];

    const sorted = sortPoolsByNumber(disordered);
    expect(sorted.map((p) => p.id)).toEqual([
      'Pool-01-gemini',
      'Pool-02-gemini',
      'Pool-03-codex',
      'Pool-04-claude',
    ]);
  });

  it('sortPoolsByNumber breaks ties predictably using pool ID and base_prefix', () => {
    const tied = [
      { id: 'Pool-02-b', base_prefix: 'prefix_b' },
      { id: 'Pool-02-a', base_prefix: 'prefix_a' },
      { id: 'Pool-01-gemini', base_prefix: 'agy' },
    ];

    const sorted = sortPoolsByNumber(tied);
    expect(sorted.map((p) => p.id)).toEqual([
      'Pool-01-gemini',
      'Pool-02-a',
      'Pool-02-b',
    ]);
  });
});


