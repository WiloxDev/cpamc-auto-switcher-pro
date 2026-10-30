import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import GroupManager, { getNodeProvider, getPoolProvider } from './GroupManager';
import {
  STORAGE_KEY_SUPPORTER,
  STORAGE_KEY_DISMISSED,
} from './CommunityNoticeModal';
import * as managementClient from '../api/managementClient';

describe('GroupManager Component - Dedicated Full Screen Pool & Group Engine', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    // En pruebas unitarias estándar marcamos supporter para evaluar guardado directo salvo en tests específicos de modal
    localStorage.setItem(STORAGE_KEY_SUPPORTER, 'true');
  });

  const mockFullyAssignedNodes = [
    {
      id: 'acc1',
      data: {
        fileName: 'antigravity-g1-wilsonlavio7.json',
        email: 'wil...io7@gmail.com',
        prefix: 'agy_g1',
        provider: 'antigravity',
      },
    },
    {
      id: 'acc2',
      data: {
        fileName: 'antigravity-g1-maribelluz.json',
        email: 'mar...tro@gmail.com',
        prefix: 'agy_g1_1',
        provider: 'antigravity',
      },
    },
  ];

  it('renders the exact high-contrast empty notice when no free accounts and no antigravity accounts exist', () => {
    const codexOnlyNodes = [
      { id: 'cx1', data: { fileName: 'codex-1.json', email: 'c...1@test.com', prefix: 'codex_p1', provider: 'codex' } },
      { id: 'cx2', data: { fileName: 'codex-2.json', email: 'c...2@test.com', prefix: 'codex_p1_1', provider: 'codex' } },
    ];
    render(<GroupManager nodes={codexOnlyNodes} />);

    expect(screen.getByTestId('empty-free-nodes-alert')).toBeTruthy();
    expect(screen.getByText('No hay cuentas libres disponibles')).toBeTruthy();
    expect(
      screen.getByText(/Todas las cuentas están asignadas a grupos existentes/i)
    ).toBeTruthy();
  });

  it('offers assigned antigravity accounts as candidates for in-place re-assignment to the sibling Gemini subtype', async () => {
    const pureNodes = [
      { id: 'acc1', data: { fileName: 'antigravity-acc1.json', email: 'a...1@x.com', prefix: 'agy', provider: 'antigravity' } },
      { id: 'acc2', data: { fileName: 'antigravity-acc2.json', email: 'a...2@x.com', prefix: 'agy_1', provider: 'antigravity' } },
    ];

    vi.spyOn(managementClient, 'listModels').mockResolvedValue({
      models: ['agy/gemini-3.8-flash-high', 'claude-sonnet-4-6'],
    });
    const patchPrefixesSpy = vi
      .spyOn(managementClient, 'saveAuthFilePrefixes')
      .mockResolvedValue({
        successful: [],
        failed: [],
      });
    vi.spyOn(managementClient, 'patchAuthFileExclusions').mockResolvedValue({ ok: true });
    const savePoolSpy = vi
      .spyOn(managementClient, 'savePool')
      .mockResolvedValue({
        ok: true,
        pool: { id: 'pool-1', base_prefix: 'agy_clau' },
        message: 'Pool agy_clau saved',
      });

    render(<GroupManager nodes={pureNodes} />);

    fireEvent.click(screen.getByTestId('family-gemini'));
    fireEvent.click(screen.getByTestId('subfamily-gemini-claude'));

    const selectActive = screen.getByTestId('select-active-account');
    const optionIds = Array.from(selectActive.options).map((o) => o.value);
    expect(optionIds).toContain('acc1');
    expect(optionIds).toContain('acc2');

    fireEvent.change(selectActive, { target: { value: 'acc1' } });
    fireEvent.change(screen.getByTestId('input-group-base-prefix'), { target: { value: 'agy_clau' } });
    fireEvent.click(screen.getByTestId('reserve-item-acc2'));
    fireEvent.click(screen.getByTestId('btn-save-group'));

    // Los pools se guardan en el registro del plugin (savePool), sin clonar archivos físicos en disco
    await waitFor(() => expect(savePoolSpy).toHaveBeenCalledTimes(1));

    const savedPool = savePoolSpy.mock.calls[0][0];
    expect(savedPool.base_prefix).toBe('agy_clau');
    expect(savedPool.leader_auth).toBe('antigravity-acc1.json');
    expect(savedPool.reserves).toContain('antigravity-acc2.json');
  });

  it('allows structuring a new pool when free accounts exist and generates cascade previews', async () => {
    const nodesWithFree = [
      ...mockFullyAssignedNodes,
      {
        id: 'free1',
        data: {
          fileName: 'account-free-1.json',
          email: 'free1@test.com',
          prefix: '',
          provider: 'antigravity',
        },
      },
      {
        id: 'free2',
        data: {
          fileName: 'account-free-2.json',
          email: 'free2@test.com',
          prefix: '',
          provider: 'antigravity',
        },
      },
    ];

    const patchSpy = vi.spyOn(managementClient, 'saveAuthFilePrefixes').mockResolvedValue({
      successful: [{ name: 'account-free-1.json', prefix: 'g3' }],
      failed: [],
    });

    render(<GroupManager nodes={nodesWithFree} />);

    // Family is now mandatory: pick Gemini first
    fireEvent.click(screen.getByTestId('family-gemini'));

    // Renders builder card
    expect(screen.getByTestId('input-group-base-prefix')).toBeTruthy();

    // Fill base prefix (family convention: g*)
    const baseInput = screen.getByTestId('input-group-base-prefix');
    fireEvent.change(baseInput, { target: { value: 'g3' } });

    // Select Principal / Root account
    const selectActive = screen.getByTestId('select-active-account');
    fireEvent.change(selectActive, { target: { value: 'free1' } });

    // Check Live Preview displays root
    expect(screen.getByTestId('preview-node-root')).toBeTruthy();

    // Select free2 as reserve
    const reserveItem = screen.getByTestId('reserve-item-free2');
    fireEvent.click(reserveItem);

    // Live preview shows reserve with _1
    expect(screen.getByTestId('preview-node-reserve-0')).toBeTruthy();

    // Submit group
    const saveBtn = screen.getByTestId('btn-save-group');
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(patchSpy).toHaveBeenCalledWith([
        { name: 'account-free-1.json', prefix: 'g3' },
        { name: 'account-free-2.json', prefix: 'g3_1' },
      ]);
    });
  });

  it('displays prominent prompt box until a family is chosen and reveals structuring controls dynamically', () => {
    const dynNodes = [
      { id: 'free1', data: { fileName: 'free1.json', email: 'free1@test.com', prefix: '', provider: 'antigravity' } },
      { id: 'free2', data: { fileName: 'free2.json', email: 'free2@test.com', prefix: '', provider: 'antigravity' } },
      { id: 'codex1', data: { fileName: 'codex1.json', email: 'codex1@test.com', prefix: '', provider: 'codex' } },
    ];
    render(<GroupManager nodes={dynNodes} />);

    // Prompt box is visible asking to choose a provider above, controls are not mounted yet
    expect(screen.getByTestId('family-prompt-box')).toBeTruthy();
    expect(screen.queryByTestId('select-active-account')).toBeNull();

    // Selecting a provider dismisses the prompt box and mounts structuring controls
    fireEvent.click(screen.getByTestId('family-gemini'));
    expect(screen.queryByTestId('family-prompt-box')).toBeNull();

    const selectActive = screen.getByTestId('select-active-account');
    expect(selectActive).toBeTruthy();

    // Gemini family: only antigravity accounts, codex hidden
    fireEvent.change(selectActive, { target: { value: 'free1' } });
    expect(selectActive.value).toBe('free1');
    const reserveList = screen.getByTestId('reserves-container');
    expect(reserveList.textContent).not.toContain('free1@test.com'); // current leader never listed as its own reserve
    expect(reserveList.textContent).toContain('free2@test.com');
    expect(reserveList.textContent).not.toContain('codex1@test.com');

    // Switching the leader swaps the lists dynamically: free1 comes back as reserve candidate
    fireEvent.change(selectActive, { target: { value: 'free2' } });
    expect(screen.getByTestId('reserves-container').textContent).not.toContain('free2@test.com');
    expect(screen.getByTestId('reserves-container').textContent).toContain('free1@test.com');

    // Changing family invalidates the previous account selection; since codex only has 1 account, it shows the one-account notice
    fireEvent.click(screen.getByTestId('family-codex'));
    expect(screen.queryByTestId('select-active-account')).toBeNull();
    expect(screen.getByTestId('capacity-notice-one')).toBeTruthy();
    expect(screen.getByTestId('detected-account-email').textContent).toContain('codex1@test.com');
  });

  it('allows switching to dissolve tab and releasing existing pool accounts', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const patchSpy = vi.spyOn(managementClient, 'saveAuthFilePrefixes').mockResolvedValue({
      successful: [],
      failed: [],
    });

    render(<GroupManager nodes={mockFullyAssignedNodes} />);

    // Click on dissolve tab
    fireEvent.click(screen.getByTestId('tab-disolver-pools'));

    expect(screen.getByTestId('dissolve-pools-grid')).toBeTruthy();
    expect(screen.getByTestId('pool-card-agy_g1')).toBeTruthy();

    const dissolveBtn = screen.getByTestId('btn-dissolve-pool-agy_g1');
    fireEvent.click(dissolveBtn);

    await waitFor(() => {
      expect(patchSpy).toHaveBeenCalledWith([
        { name: 'antigravity-g1-wilsonlavio7.json', prefix: '' },
        { name: 'antigravity-g1-maribelluz.json', prefix: '' },
      ]);
    });
  });

  it('displays the actual parent/root prefix (e.g. [sonet]) with leader badge instead of bare literal [leader]', () => {
    const mockSonetPoolNodes = [
      {
        id: 'acc1',
        data: {
          fileName: 'antigravity-son-infosoytec.json',
          email: 'infosoytec@gmail.com',
          prefix: 'sonet',
          provider: 'antigravity',
        },
      },
      {
        id: 'acc2',
        data: {
          fileName: 'antigravity-son-infowilsonlavio.json',
          email: 'infowilsonlavio@gmail.com',
          prefix: 'sonet_1',
          provider: 'antigravity',
        },
      },
      {
        id: 'acc3',
        data: {
          fileName: 'antigravity-son-maribelluz.json',
          email: 'maribelluzbonita@gmail.com',
          prefix: 'sonet_2',
          provider: 'antigravity',
        },
      },
    ];

    render(<GroupManager nodes={mockSonetPoolNodes} />);

    fireEvent.click(screen.getByTestId('tab-disolver-pools'));

    // Debe mostrar la tarjeta del pool "sonet"
    expect(screen.getByTestId('pool-card-sonet')).toBeTruthy();

    // El padre debe mostrar su prefijo explícito [sonet] y NO el texto plano [leader]
    expect(screen.getByText('[sonet]')).toBeTruthy();
    expect(screen.getByText('LEADER')).toBeTruthy();
    expect(screen.queryByText('[leader]')).toBeNull();

    // Las reservas deben mostrar sus prefijos respectivos
    expect(screen.getByText('[sonet_1]')).toBeTruthy();
    expect(screen.getByText('[sonet_2]')).toBeTruthy();
  });
});

describe('GroupManager - family-aware pools, honest failures & isolated routes', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const makeFreeNode = (id, email, provider = 'antigravity') => ({
    id,
    data: {
      fileName: `${id}.json`,
      email,
      prefix: '',
      provider,
    },
  });

  const baseNodes = [
    makeFreeNode('free1', 'free1@test.com'),
    makeFreeNode('free2', 'free2@test.com'),
    makeFreeNode('free3', 'free3@test.com'),
    makeFreeNode('codex1', 'codex1@test.com', 'codex'),
  ];

  it('shows family hint validation and hides incompatible provider accounts from the selectors', () => {
    render(<GroupManager nodes={baseNodes} />);

    // Select Gemini family via segmented control
    fireEvent.click(screen.getByTestId('family-gemini'));

    // Name that does not honor the g* convention triggers an inline warning
    const baseInput = screen.getByTestId('input-group-base-prefix');
    fireEvent.change(baseInput, { target: { value: 'team1' } });
    expect(screen.getByTestId('prefix-family-warning')).toBeTruthy();

    // Honor the convention -> warning disappears
    fireEvent.change(baseInput, { target: { value: 'g7' } });
    expect(screen.queryByTestId('prefix-family-warning')).toBeNull();

    // Codex accounts are excluded from the active-account selector for a Gemini family
    const options = Array.from(screen.getByTestId('select-active-account').options);
    expect(options.some((o) => o.value === 'codex1')).toBe(false);
    expect(options.some((o) => o.value === 'free1')).toBe(true);
  });

  it('skips reserve numbers whose prefixes already exist in the system', async () => {
    const nodesWithOrphanReserve = [
      {
        id: 'taken',
        data: { fileName: 'taken.json', email: 'taken@test.com', prefix: 'g9_1', provider: 'antigravity' },
      },
      makeFreeNode('free1', 'free1@test.com'),
      makeFreeNode('free2', 'free2@test.com'),
    ];

    const patchSpy = vi.spyOn(managementClient, 'saveAuthFilePrefixes').mockResolvedValue({
      successful: [],
      failed: [],
    });

    render(<GroupManager nodes={nodesWithOrphanReserve} />);

    fireEvent.click(screen.getByTestId('family-gemini'));
    fireEvent.change(screen.getByTestId('input-group-base-prefix'), { target: { value: 'g9' } });
    fireEvent.change(screen.getByTestId('select-active-account'), { target: { value: 'free1' } });
    fireEvent.click(screen.getByTestId('reserve-item-free2'));

    // Live preview shows the collision-free number _2 (g9_1 already taken)
    expect(screen.getByTestId('preview-node-reserve-0').textContent).toContain('g9_2');

    fireEvent.click(screen.getByTestId('btn-save-group'));

    await waitFor(() => {
      expect(patchSpy).toHaveBeenCalledWith([
        { name: 'free1.json', prefix: 'g9' },
        { name: 'free2.json', prefix: 'g9_2' },
      ]);
    });
  });

  it('reports per-account failures with retry instead of fake success', async () => {
    const patchSpy = vi
      .spyOn(managementClient, 'saveAuthFilePrefixes')
      .mockResolvedValueOnce({
        successful: [{ name: 'free1.json', prefix: 'g8' }],
        failed: [{ name: 'free2.json', prefix: 'g8_1', error: '401 Unauthorized: key expired' }],
      })
      .mockResolvedValueOnce({
        successful: [
          { name: 'free1.json', prefix: 'g8' },
          { name: 'free2.json', prefix: 'g8_1' },
        ],
        failed: [],
      });

    render(<GroupManager nodes={baseNodes} />);

    fireEvent.click(screen.getByTestId('family-gemini'));
    fireEvent.change(screen.getByTestId('input-group-base-prefix'), { target: { value: 'g8' } });
    fireEvent.change(screen.getByTestId('select-active-account'), { target: { value: 'free1' } });
    fireEvent.click(screen.getByTestId('reserve-item-free2'));
    fireEvent.click(screen.getByTestId('btn-save-group'));

    // Honest partial-failure panel appears; no fake success message
    await waitFor(() => {
      expect(screen.getByTestId('pool-save-errors')).toBeTruthy();
    });
    expect(screen.getByTestId('pool-save-errors').textContent).toContain('free2.json');
    expect(screen.queryByText(/creado y guardado con éxito/i)).toBeNull();

    // Retry only re-sends the failed accounts
    fireEvent.click(screen.getByTestId('btn-retry-failed'));
    await waitFor(() => {
      expect(patchSpy).toHaveBeenLastCalledWith([{ name: 'free2.json', prefix: 'g8_1' }]);
    });
    await waitFor(() => {
      expect(screen.getByText(/creado y guardado con éxito/i)).toBeTruthy();
    });
  });

  it('dissolves deep descendants (grandchildren) together with direct members to avoid ghost pools', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const patchSpy = vi.spyOn(managementClient, 'saveAuthFilePrefixes').mockResolvedValue({
      successful: [],
      failed: [],
    });

    const nodesWithGrandchild = [
      {
        id: 'root',
        data: { fileName: 'root.json', email: 'root@test.com', prefix: 'g1', provider: 'antigravity' },
      },
      {
        id: 'res1',
        data: { fileName: 'res1.json', email: 'res1@test.com', prefix: 'g1_1', provider: 'antigravity' },
      },
      {
        id: 'grand1',
        data: { fileName: 'grand1.json', email: 'grand1@test.com', prefix: 'g1_1_1', provider: 'antigravity' },
      },
      {
        id: 'other',
        data: { fileName: 'other.json', email: 'other@test.com', prefix: 'son1', provider: 'antigravity' },
      },
    ];

    render(<GroupManager nodes={nodesWithGrandchild} />);
    fireEvent.click(screen.getByTestId('tab-disolver-pools'));
    fireEvent.click(screen.getByTestId('btn-dissolve-pool-g1'));

    await waitFor(() => {
      expect(patchSpy).toHaveBeenCalledWith([
        { name: 'root.json', prefix: '' },
        { name: 'res1.json', prefix: '' },
        { name: 'grand1.json', prefix: '' },
      ]);
    });

    // Unrelated pool (son1) must remain untouched
    expect(patchSpy.mock.calls[0][0].some((u) => u.name === 'other.json')).toBe(false);
  });

  it('smoke: with live-like data (no free antigravity accounts) the builder shows the info alert and never crashes', () => {
    const consoleErrors = [];
    const errSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      consoleErrors.push(args.map(String).join(' '));
    });

    const liveNodes = [
      { id: 'a1', data: { fileName: 'antigravity-maribelluz@gmail.com.json', email: 'maribelluz@gmail.com', prefix: 'g1', provider: 'antigravity' } },
      { id: 'a2', data: { fileName: 'antigravity-wilsonlavio7@gmail.com.json', email: 'wilsonlavio7@gmail.com', prefix: 'son1', provider: 'antigravity' } },
      { id: 'oc1', data: { fileName: 'opencode-go-e86ad5f80809.json', email: '', prefix: '', provider: 'opencode' } },
    ];

    render(
      <React.StrictMode>
        <GroupManager nodes={liveNodes} edges={[]} />
      </React.StrictMode>
    );

    // Sin cuentas gemini libres: solo 1 tarjeta Gemini LIBRE del master claude (modelo 2N)
    // Al haber solo 1 cuenta libre (a2), se oculta el select y se muestra el recuadro prominente con a2 detectada
    fireEvent.click(screen.getByTestId('family-gemini'));
    expect(screen.queryByTestId('no-compatible-accounts-alert')).toBeNull();
    expect(screen.queryByTestId('select-active-account')).toBeNull();
    expect(screen.getByTestId('capacity-notice-one')).toBeTruthy();
    expect(screen.getByTestId('detected-account-email').textContent).toContain('wilsonlavio7@gmail.com');

    // Y no hay errores de consola reales
    const realErrors = consoleErrors.filter(
      (e) => !e.includes('not wrapped in act') && !e.includes('Each child in a list')
    );
    expect(realErrors).toEqual([]);
    errSpy.mockRestore();
  });

  it('smoke: full real sequence (family -> leader -> reserve -> save -> routes) with free accounts logs no console errors', async () => {
    const consoleErrors = [];
    const errSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      consoleErrors.push(args.map(String).join(' '));
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Escenario armable: líder ocupado + dos cuentas antigravity libres (mínimo 2 requeridas)
    const liveNodes = [
      { id: 'a2', data: { fileName: 'antigravity-wilsonlavio7@gmail.com.json', email: 'wilsonlavio7@gmail.com', prefix: 'son1', provider: 'antigravity' } },
      { id: 'free1', data: { fileName: 'antigravity-newaccount@gmail.com.json', email: 'newaccount@gmail.com', prefix: '', provider: 'antigravity' } },
      { id: 'free2', data: { fileName: 'antigravity-newaccount2@gmail.com.json', email: 'newaccount2@gmail.com', prefix: '', provider: 'antigravity' } },
      { id: 'oc1', data: { fileName: 'opencode-go-e86ad5f80809.json', email: '', prefix: '', provider: 'opencode' } },
    ];

    const patchSpy = vi.spyOn(managementClient, 'saveAuthFilePrefixes').mockResolvedValue({
      successful: [
        { name: 'antigravity-newaccount@gmail.com.json', prefix: 'agy' },
        { name: 'antigravity-newaccount2@gmail.com.json', prefix: 'agy_1' },
      ],
      failed: [],
    });
    vi.spyOn(managementClient, 'listModels').mockResolvedValue({
      models: ['agy/gemini-3.8-flash-high', 'gemini-3.8-flash-high'],
    });

    const { unmount } = render(
      <React.StrictMode>
        <GroupManager nodes={liveNodes} edges={[]} onReloadRequested={async () => {}} />
      </React.StrictMode>
    );

    // Secuencia completa del usuario cumpliendo la regla de mínimo 2 cuentas
    fireEvent.click(screen.getByTestId('family-gemini'));
    fireEvent.change(screen.getByTestId('select-active-account'), { target: { value: 'free1' } });
    fireEvent.click(screen.getByTestId('reserve-item-free2'));
    fireEvent.click(screen.getByTestId('btn-save-group'));

    await waitFor(() => {
      expect(patchSpy).toHaveBeenCalled();
    });

    unmount();
    const realErrors = consoleErrors.filter(
      (e) => !e.includes('not wrapped in act') && !e.includes('Each child in a list')
    );
    expect(realErrors).toEqual([]);

    errSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('reserves list stays empty until a leader is selected (family chosen but no leader yet)', () => {
    render(<GroupManager nodes={baseNodes} />);

    fireEvent.click(screen.getByTestId('family-gemini'));

    // Familia elegida pero SIN líder: no debe listarse ninguna reserva
    expect(screen.queryByTestId('reserves-container')).toBeNull();
    expect(screen.getByText('Selecciona primero una cuenta principal.')).toBeTruthy();

    // Tras elegir líder, las reservas compatibles aparecen (sin incluir al líder)
    fireEvent.change(screen.getByTestId('select-active-account'), { target: { value: 'free1' } });
    const reserveList = screen.getByTestId('reserves-container');
    expect(reserveList.textContent).toContain('free2@test.com');
    expect(reserveList.textContent).not.toContain('free1@test.com');
  });

  it('shows isolated prefix/model routes after a fully successful save', async () => {
    vi.spyOn(managementClient, 'saveAuthFilePrefixes').mockResolvedValue({
      successful: [{ name: 'free1.json', prefix: 'g5' }],
      failed: [],
    });
    vi.spyOn(managementClient, 'listModels').mockResolvedValue({
      models: [
        'g5/gemini-3.8-flash-high',
        'g5/gemini-3.7-flash-high',
        'g5/claude-opus-5-5-high',
        'g5/claude-sonnet-5-5-high',
        'gemini-3.8-flash-high',
        'son1/claude-sonnet-4-5',
      ],
    });

    render(<GroupManager nodes={baseNodes} />);

    fireEvent.click(screen.getByTestId('family-gemini'));
    fireEvent.change(screen.getByTestId('input-group-base-prefix'), { target: { value: 'g5' } });
    fireEvent.change(screen.getByTestId('select-active-account'), { target: { value: 'free1' } });
    fireEvent.click(screen.getByTestId('reserve-item-free2')); // Cumple regla de mínimo 2 cuentas
    fireEvent.click(screen.getByTestId('btn-save-group'));

    await waitFor(() => {
      expect(screen.getByTestId('model-routes-panel')).toBeTruthy();
    });
    expect(screen.getByTestId('model-routes-panel').textContent).toContain('g5/gemini-3.8-flash-high');
    expect(screen.getByTestId('model-routes-panel').textContent).toContain('g5/gemini-3.7-flash-high');
    expect(screen.getByTestId('model-routes-panel').textContent).not.toContain('g5/claude'); // rutas filtradas por familia Gemini
    expect(screen.getByTestId('model-routes-panel').textContent).not.toContain('son1/claude');
    expect(screen.getByText(/la cuota NO se aísla/i)).toBeTruthy();
  });

  it('renders Gemini sub-families in the same column, switches to agy_clau and auto-increments for N groups', () => {
    const nodesWithExistingAgyClau = [
      { id: 'leader1', data: { fileName: 'ac1.json', email: 'ac1@test.com', prefix: 'agy_clau', provider: 'antigravity' } },
      { id: 'res1', data: { fileName: 'ac2.json', email: 'ac2@test.com', prefix: 'agy_clau_1', provider: 'antigravity' } },
      { id: 'free1', data: { fileName: 'free1.json', email: 'free1@test.com', prefix: '', provider: 'antigravity' } },
      { id: 'free2', data: { fileName: 'free2.json', email: 'free2@test.com', prefix: '', provider: 'antigravity' } },
    ];

    render(<GroupManager nodes={nodesWithExistingAgyClau} />);

    // Al seleccionar Gemini, se renderiza el sub-selector dentro de la misma columna
    fireEvent.click(screen.getByTestId('family-gemini'));
    expect(screen.getByTestId('gemini-subfamily-container')).toBeTruthy();
    expect(screen.getByTestId('subfamily-gemini-pure')).toBeTruthy();
    expect(screen.getByTestId('subfamily-gemini-claude')).toBeTruthy();

    // Por defecto es Gemini Puro -> sugiere agy
    expect(screen.getByTestId('input-group-base-prefix').value).toBe('agy');

    // Cambiar a Claude del Paquete en la misma columna
    fireEvent.click(screen.getByTestId('subfamily-gemini-claude'));
    // Como 'agy_clau' ya existe en nodes, autoincrementa inteligentemente a 'agy_clau2'
    expect(screen.getByTestId('input-group-base-prefix').value).toBe('agy_clau2');
  });

  it('provides model policy checkboxes to exclude 5.5 versions or disable isolation (wildcard mode)', async () => {
    let capturedExclusions = [];
    vi.spyOn(managementClient, 'saveAuthFilePrefixes').mockResolvedValue({
      successful: [{ name: 'leader.json', prefix: 'agy_son' }],
      failed: [],
    });
    vi.spyOn(managementClient, 'patchAuthFileExclusions').mockImplementation((fileName, oppositeModels) => {
      capturedExclusions = oppositeModels;
      return Promise.resolve({ ok: true });
    });
    const savePoolSpy = vi.spyOn(managementClient, 'savePool').mockResolvedValue({
      ok: true,
      pool: { id: 'pool-1', base_prefix: 'agy_son' },
      message: 'Pool agy_son saved',
    });
    vi.spyOn(managementClient, 'listModels').mockResolvedValue({
      models: [
        'claude-sonnet-4-6',
        'claude-sonnet-5-5-high',
        'claude-opus-4-6-thinking',
        'claude-opus-5-5-high',
        'gemini-3.8-flash-high',
      ],
    });

    const testNodes = [
      { id: 'leader', data: { fileName: 'leader.json', email: 'leader@test.com', prefix: '', provider: 'antigravity' } },
      { id: 'occup', data: { fileName: 'occup.json', email: 'occup@test.com', prefix: 'agy', provider: 'antigravity' } },
    ];

    render(<GroupManager nodes={testNodes} />);

    fireEvent.click(screen.getByTestId('family-gemini'));
    fireEvent.click(screen.getByTestId('subfamily-gemini-sonnet'));

    const chk55 = screen.getByTestId('checkbox-exclude-55');
    const selectSpec = screen.getByTestId('select-specialist-model');
    expect(chk55.checked).toBe(false);
    expect(selectSpec).toBeTruthy();

    fireEvent.click(chk55);
    expect(chk55.checked).toBe(true);

    fireEvent.change(screen.getByTestId('select-active-account'), { target: { value: 'leader' } });
    fireEvent.click(screen.getByTestId('reserve-item-occup'));

    fireEvent.click(screen.getByTestId('btn-save-group'));

    await waitFor(() => {
      expect(screen.getByText(/creado y guardado con éxito/i)).toBeTruthy();
    });

    // En gobernanza virtual pura, las exclusiones de modelos no mutilan el archivo físico
    // sino que se guardan en la definición del pool en el registro del plugin
    await waitFor(() => expect(savePoolSpy).toHaveBeenCalledTimes(1));
    const savedPool = savePoolSpy.mock.calls[0][0];
    expect(savedPool.base_prefix).toBe('agy_son');
    expect(savedPool.policy.exclude_55).toBe(true);
    expect(savedPool.policy.excluded_models).toContain('claude-sonnet-5-5-high');
  });

  it('enforces specialist model selection (1 Pool = 1 Specialist Model) and computes opposite models in pool policy', async () => {
    vi.spyOn(managementClient, 'saveAuthFilePrefixes').mockResolvedValue({
      successful: [{ name: 'leader.json', prefix: 'agy_son' }],
      failed: [],
    });
    const patchExclusionsSpy = vi.spyOn(managementClient, 'patchAuthFileExclusions').mockResolvedValue({ ok: true });
    const savePoolSpy = vi.spyOn(managementClient, 'savePool').mockResolvedValue({
      ok: true,
      pool: { id: 'pool-1', base_prefix: 'agy_son' },
      message: 'Pool agy_son saved',
    });
    vi.spyOn(managementClient, 'listModels').mockResolvedValue({
      models: [
        'claude-sonnet-4-6',
        'claude-sonnet-5-5-high',
        'claude-opus-4-6-thinking',
        'claude-opus-5-5-high',
        'gemini-3.8-flash-high',
      ],
    });

    const testNodes = [
      { id: 'leader', data: { fileName: 'leader.json', email: 'leader@test.com', prefix: '', provider: 'antigravity' } },
      { id: 'occup', data: { fileName: 'occup.json', email: 'occup@test.com', prefix: 'agy', provider: 'antigravity' } },
    ];

    render(<GroupManager nodes={testNodes} />);

    fireEvent.click(screen.getByTestId('family-gemini'));
    fireEvent.click(screen.getByTestId('subfamily-gemini-sonnet'));

    const selectSpec = screen.getByTestId('select-specialist-model');
    fireEvent.change(selectSpec, { target: { value: 'claude-sonnet-4-6' } });
    expect(selectSpec.value).toBe('claude-sonnet-4-6');

    fireEvent.change(screen.getByTestId('select-active-account'), { target: { value: 'leader' } });
    fireEvent.click(screen.getByTestId('reserve-item-occup'));

    fireEvent.click(screen.getByTestId('btn-save-group'));

    await waitFor(() => {
      expect(screen.getByText(/creado y guardado con éxito/i)).toBeTruthy();
    });

    // En gobernanza virtual pura, NO se parchea excluded_models en el disco para no mutilar
    // las credenciales nativas de CPAMC
    expect(patchExclusionsSpy).not.toHaveBeenCalled();

    // Y el registro del pool guarda target_models con exactamente 1 modelo y disable_isolation: false
    await waitFor(() => expect(savePoolSpy).toHaveBeenCalledTimes(1));
    const savedPool = savePoolSpy.mock.calls[0][0];
    expect(savedPool.policy.disable_isolation).toBe(false);
    expect(savedPool.policy.target_models).toEqual(['claude-sonnet-4-6']);
    expect(savedPool.policy.excluded_models).toContain('claude-sonnet-5-5-high');
  });

  it('creates a Codex pool with its selected specialist model and never falls back to Gemini', async () => {
    vi.spyOn(managementClient, 'saveAuthFilePrefixes').mockResolvedValue({
      successful: [{ name: 'codex-lead.json', prefix: 'codex' }],
      failed: [],
    });
    const savePoolSpy = vi.spyOn(managementClient, 'savePool').mockResolvedValue({
      ok: true,
      pool: { id: 'Pool-02-codex', base_prefix: 'codex' },
      message: 'Pool codex saved',
    });
    vi.spyOn(managementClient, 'listModels').mockResolvedValue({
      models: [
        'gpt-5.4',
        'gpt-4o',
        'o3-mini',
        'gemini-3.8-flash-high',
      ],
    });

    const codexNodes = [
      { id: 'c1', data: { fileName: 'codex-lead.json', email: 'cx1@test.com', prefix: '', provider: 'codex' } },
      { id: 'c2', data: { fileName: 'codex-res.json', email: 'cx2@test.com', prefix: '', provider: 'codex' } },
    ];

    render(<GroupManager nodes={codexNodes} />);

    fireEvent.click(screen.getByTestId('family-codex'));
    fireEvent.change(screen.getByTestId('select-active-account'), { target: { value: 'c1' } });
    fireEvent.click(screen.getByTestId('reserve-item-c2'));

    const selectSpec = screen.getByTestId('select-specialist-model');
    fireEvent.change(selectSpec, { target: { value: 'gpt-5.4' } });

    fireEvent.click(screen.getByTestId('btn-save-group'));

    await waitFor(() => {
      expect(screen.getByText(/creado y guardado con éxito/i)).toBeTruthy();
    });

    expect(savePoolSpy).toHaveBeenCalledTimes(1);
    const savedPool = savePoolSpy.mock.calls[0][0];
    expect(savedPool.family).toBe('codex');
    expect(savedPool.policy.target_models).toEqual(['gpt-5.4']);
    expect(savedPool.member_models['codex-lead.json']).toBe('gpt-5.4');
    expect(savedPool.member_models['codex-res.json']).toBe('gpt-5.4');
    expect(savedPool.policy.target_models).not.toContain('gemini-3.8-flash-high');
  });

  it('unifies capacity calculation combining free and available accounts with accurate group count', () => {
    const occupiedNodes = [
      { id: 'a1', data: { fileName: 'a1.json', email: 'a1@test.com', prefix: 'agy', provider: 'antigravity' } },
      { id: 'a2', data: { fileName: 'a2.json', email: 'a2@test.com', prefix: 'agy_1', provider: 'antigravity' } },
      { id: 'a3', data: { fileName: 'a3.json', email: 'a3@test.com', prefix: 'agy2', provider: 'antigravity' } },
      { id: 'a4', data: { fileName: 'a4.json', email: 'a4@test.com', prefix: 'agy2_1', provider: 'antigravity' } },
    ];

    render(<GroupManager nodes={occupiedNodes} />);

    fireEvent.click(screen.getByTestId('family-gemini'));
    fireEvent.click(screen.getByTestId('subfamily-gemini-opus'));

    const capacityBadge = screen.getByTestId('capacity-badge');
    expect(capacityBadge.textContent).toContain('Puedes armar hasta 2 pools de rotación');
    expect(capacityBadge.textContent).toContain('4 cuentas listas');
  });

  it('preserves user typed prefix when selecting a virtual source account (no input clobbering)', () => {
    const occupiedNodes = [
      { id: 'a1', data: { fileName: 'a1.json', email: 'a1@test.com', prefix: 'agy', provider: 'antigravity' } },
      { id: 'a2', data: { fileName: 'a2.json', email: 'a2@test.com', prefix: 'agy_1', provider: 'antigravity' } },
    ];

    render(<GroupManager nodes={occupiedNodes} />);

    fireEvent.click(screen.getByTestId('family-gemini'));
    fireEvent.click(screen.getByTestId('subfamily-gemini-opus'));

    // Usuario escribe su propio prefijo deseado
    const prefixInput = screen.getByTestId('input-group-base-prefix');
    fireEvent.change(prefixInput, { target: { value: 'mi_opus_custom' } });
    expect(prefixInput.value).toBe('mi_opus_custom');

    // Luego selecciona cuenta líder virtual
    fireEvent.change(screen.getByTestId('select-active-account'), { target: { value: 'a1' } });

    // NO debe machacar el input si ya tenía texto
    expect(screen.getByTestId('input-group-base-prefix').value).toBe('mi_opus_custom');
  });

  it('hides 5.5 exclusion checkbox on Gemini Puro and displays dynamic reactive note on Claude', () => {
    render(<GroupManager nodes={baseNodes} />);

    fireEvent.click(screen.getByTestId('family-gemini'));

    // 1. En Gemini Puro: NO debe mostrar checkbox 5.5
    fireEvent.click(screen.getByTestId('subfamily-gemini-pure'));
    expect(screen.queryByTestId('checkbox-exclude-55')).toBeNull();

    // 2. En Claude Opus: SÍ debe mostrar checkbox 5.5
    fireEvent.click(screen.getByTestId('subfamily-gemini-opus'));
    const chk55 = screen.getByTestId('checkbox-exclude-55');
    expect(chk55).toBeTruthy();

    // Nota antes de marcar
    expect(screen.getByTestId('group-family-note').textContent).toContain('claude-opus-5-5-high');

    // Al marcar checkbox 5.5: nota reacciona dinámicamente
    fireEvent.click(chk55);
    expect(screen.getByTestId('group-family-note').textContent).toContain('(versión 5.5 excluida)');
  });

  it('supports specialized sonnet and opus subtypes in Antigravity package with dedicated models including 5.5 versions', () => {
    render(<GroupManager nodes={baseNodes} />);

    fireEvent.click(screen.getByTestId('family-gemini'));
    expect(screen.getByTestId('subfamily-gemini-sonnet')).toBeTruthy();
    expect(screen.getByTestId('subfamily-gemini-opus')).toBeTruthy();

    // Select Claude Sonnet -> suggests agy_son
    fireEvent.click(screen.getByTestId('subfamily-gemini-sonnet'));
    expect(screen.getByTestId('input-group-base-prefix').value).toBe('agy_son');

    // Note should highlight Sonnet 4.6 & 5.5
    expect(screen.getAllByText(/claude-sonnet/i).length).toBeGreaterThanOrEqual(1);

    // Select Claude Opus -> suggests agy_opus
    fireEvent.click(screen.getByTestId('subfamily-gemini-opus'));
    expect(screen.getByTestId('input-group-base-prefix').value).toBe('agy_opus');

    // Note should highlight Opus 4.6 Thinking & Opus 5.5 High
    expect(screen.getAllByText(/claude-opus/i).length).toBeGreaterThanOrEqual(1);
  });

  it('enforces strict minimum 2 accounts rule (1 leader + >=1 reserve) with visual warnings', () => {
    render(<GroupManager nodes={baseNodes} />);

    fireEvent.click(screen.getByTestId('family-gemini'));
    const saveBtn = screen.getByTestId('btn-save-group');

    // Sin líder seleccionado -> botón deshabilitado
    expect(saveBtn.disabled).toBe(true);

    // Con líder seleccionado pero 0 reservas -> botón sigue deshabilitado con advertencia de mínimo 2
    fireEvent.change(screen.getByTestId('select-active-account'), { target: { value: 'free1' } });
    expect(saveBtn.disabled).toBe(true);
    expect(screen.getByTestId('min-reserves-warning')).toBeTruthy();
    expect(screen.queryByTestId('pool-ready-banner')).toBeNull();

    // Al marcar al menos 1 reserva -> cumple regla (1 líder + 1 reserva = 2), se habilita botón y muestra banner listo
    fireEvent.click(screen.getByTestId('reserve-item-free2'));
    expect(saveBtn.disabled).toBe(false);
    expect(screen.queryByTestId('min-reserves-warning')).toBeNull();
    expect(screen.getByTestId('pool-ready-banner')).toBeTruthy();
    expect(screen.getByTestId('pool-ready-banner').textContent).toContain('1 líder + 1 reserva(s)');
  });

  it('dissolving pool agy never dissolves pool agy_clau (strict numeric descendant rule)', async () => {
    const mixedNodes = [
      { id: 'ag1', data: { fileName: 'ag1.json', email: 'ag1@test.com', prefix: 'agy', provider: 'antigravity' } },
      { id: 'ag2', data: { fileName: 'ag2.json', email: 'ag2@test.com', prefix: 'agy_1', provider: 'antigravity' } },
      { id: 'cl1', data: { fileName: 'cl1.json', email: 'cl1@test.com', prefix: 'agy_clau', provider: 'antigravity' } },
      { id: 'cl2', data: { fileName: 'cl2.json', email: 'cl2@test.com', prefix: 'agy_clau_1', provider: 'antigravity' } },
    ];

    const patchSpy = vi.spyOn(managementClient, 'saveAuthFilePrefixes').mockResolvedValue({
      successful: [{ name: 'ag1.json', prefix: '' }, { name: 'ag2.json', prefix: '' }],
      failed: [],
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<GroupManager nodes={mixedNodes} />);

    // Ir a pestaña Disolver
    fireEvent.click(screen.getByTestId('tab-disolver-pools'));

    // Disolver pool agy
    const dissolveAgyBtn = screen.getByTestId('btn-dissolve-pool-agy');
    fireEvent.click(dissolveAgyBtn);

    await waitFor(() => {
      expect(patchSpy).toHaveBeenCalledWith([
        { name: 'ag1.json', prefix: '' },
        { name: 'ag2.json', prefix: '' },
      ]);
    });
    // Verificamos que cl1 (agy_clau) y cl2 (agy_clau_1) NUNCA fueron incluidos en la disolución de agy
    expect(patchSpy).not.toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ name: 'cl1.json' })
    ]));
  });

  it('dissolving pool with 2 master and 2 virtual accounts deletes virtual files from disk and resets master accounts', async () => {
    const mixedPoolNodes = [
      { id: 'm1', data: { fileName: 'antigravity-m1@gmail.com.json', email: 'm1@gmail.com', prefix: 'agy_mix', provider: 'antigravity' } },
      { id: 'm2', data: { fileName: 'antigravity-m2@gmail.com.json', email: 'm2@gmail.com', prefix: 'agy_mix_1', provider: 'antigravity' } },
      { id: 'v1', data: { fileName: 'antigravity-m1@gmail.com.agy_mix_2.json', email: 'm1@gmail.com', prefix: 'agy_mix_2', provider: 'antigravity' } },
      { id: 'v2', data: { fileName: 'antigravity-m2@gmail.com.agy_mix_3.json', email: 'm2@gmail.com', prefix: 'agy_mix_3', provider: 'antigravity' } },
    ];

    const patchSpy = vi.spyOn(managementClient, 'saveAuthFilePrefixes').mockResolvedValue({
      successful: [{ name: 'antigravity-m1@gmail.com.json', prefix: '' }, { name: 'antigravity-m2@gmail.com.json', prefix: '' }],
      failed: [],
    });
    const deleteSpy = vi.spyOn(managementClient, 'deleteAuthFile').mockResolvedValue({ ok: true });
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<GroupManager nodes={mixedPoolNodes} />);
    fireEvent.click(screen.getByTestId('tab-disolver-pools'));
    fireEvent.click(screen.getByTestId('btn-dissolve-pool-agy_mix'));

    await waitFor(() => {
      expect(deleteSpy).toHaveBeenCalledWith('antigravity-m1@gmail.com.agy_mix_2.json');
      expect(deleteSpy).toHaveBeenCalledWith('antigravity-m2@gmail.com.agy_mix_3.json');
      expect(patchSpy).toHaveBeenCalledWith([
        { name: 'antigravity-m1@gmail.com.json', prefix: '' },
        { name: 'antigravity-m2@gmail.com.json', prefix: '' },
      ]);
    });
  });

  it('MINI-003 acceptance: for 4 master accounts, Gemini and Claude dropdowns show strictly 4 candidates with zero duplicates', () => {
    // 4 physical master accounts
    const fourMasters = [
      { id: 'm1', data: { fileName: 'antigravity-u1@gmail.com.json', email: 'u1@gmail.com', prefix: '', provider: 'antigravity' } },
      { id: 'm2', data: { fileName: 'antigravity-u2@gmail.com.json', email: 'u2@gmail.com', prefix: '', provider: 'antigravity' } },
      { id: 'm3', data: { fileName: 'antigravity-u3@gmail.com.json', email: 'u3@gmail.com', prefix: '', provider: 'antigravity' } },
      { id: 'm4', data: { fileName: 'antigravity-u4@gmail.com.json', email: 'u4@gmail.com', prefix: '', provider: 'antigravity' } },
    ];

    const { rerender } = render(<GroupManager nodes={fourMasters} />);

    // 1. When selecting Gemini (gemini_pure)
    fireEvent.click(screen.getByTestId('family-gemini'));
    fireEvent.click(screen.getByTestId('subfamily-gemini-pure'));

    const geminiSelect = screen.getByTestId('select-active-account');
    const geminiOptions = Array.from(geminiSelect.options).filter((o) => o.value !== '');
    // Exactly 4 candidates (m1, m2, m3, m4)
    expect(geminiOptions).toHaveLength(4);
    expect(geminiOptions.map((o) => o.value)).toEqual(['m1', 'm2', 'm3', 'm4']);

    // 2. When selecting Claude (gemini_opus / sonnet)
    fireEvent.click(screen.getByTestId('subfamily-gemini-opus'));

    const claudeSelect = screen.getByTestId('select-active-account');
    const claudeOptions = Array.from(claudeSelect.options).filter((o) => o.value !== '');
    // Exactly 4 candidates (1 per physical master account)
    expect(claudeOptions).toHaveLength(4);
    expect(claudeOptions.map((o) => o.value)).toEqual(['m1', 'm2', 'm3', 'm4']);

    // 3. Even with 4 derived virtual files already on disk (8 total files in CPAMC)
    const nodes8 = [
      ...fourMasters,
      { id: 'v1', data: { fileName: 'antigravity-u1@gmail.com.agy_son.json', email: 'u1@gmail.com', prefix: '', provider: 'antigravity' } },
      { id: 'v2', data: { fileName: 'antigravity-u2@gmail.com.agy_son_1.json', email: 'u2@gmail.com', prefix: '', provider: 'antigravity' } },
      { id: 'v3', data: { fileName: 'antigravity-u3@gmail.com.agy_son_2.json', email: 'u3@gmail.com', prefix: '', provider: 'antigravity' } },
      { id: 'v4', data: { fileName: 'antigravity-u4@gmail.com.agy_son_3.json', email: 'u4@gmail.com', prefix: '', provider: 'antigravity' } },
    ];

    rerender(<GroupManager nodes={nodes8} />);

    // In Gemini: Virtual Claude files are completely hidden
    fireEvent.click(screen.getByTestId('subfamily-gemini-pure'));
    const gemini8Options = Array.from(screen.getByTestId('select-active-account').options).filter((o) => o.value !== '');
    expect(gemini8Options).toHaveLength(4);
    expect(gemini8Options.some((o) => o.value.startsWith('v'))).toBe(false);

    // In Claude: all 4 claude cards are now assigned to agy_son virtuals → zero free candidates
    fireEvent.click(screen.getByTestId('subfamily-gemini-opus'));
    expect(screen.queryByTestId('select-active-account')).toBeNull();
    expect(screen.getByTestId('capacity-notice-zero')).toBeTruthy();
    expect(screen.getByTestId('no-compatible-accounts-alert')).toBeTruthy();
  });
});

describe('GroupManager - PoolRegistry como fuente única de verdad', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const mastersWithoutPrefix = [
    { id: 'm1', data: { fileName: 'antigravity-infosoytec@gmail.com.json', email: 'inf...tec@gmail.com', prefix: '', provider: 'antigravity' } },
    { id: 'm2', data: { fileName: 'antigravity-maribelluzbonitaaquinocastro@gmail.com.json', email: 'mar...tro@gmail.com', prefix: '', provider: 'antigravity' } },
    { id: 'm3', data: { fileName: 'antigravity-wilsonlavio11@gmail.com.json', email: 'wil...io11@gmail.com', prefix: '', provider: 'antigravity' } },
    { id: 'm4', data: { fileName: 'antigravity-wilsonlavio9@gmail.com.json', email: 'wil...io9@gmail.com', prefix: '', provider: 'antigravity' } },
  ];

  const clauMastersWithoutPrefix = [
    { id: 'cm1', data: { fileName: 'claude-account-1.json', email: 'clau1@test.com', prefix: '', provider: 'claude' } },
    { id: 'cm2', data: { fileName: 'claude-account-2.json', email: 'clau2@test.com', prefix: '', provider: 'claude' } },
    { id: 'cm3', data: { fileName: 'claude-account-3.json', email: 'clau3@test.com', prefix: '', provider: 'claude' } },
    { id: 'cm4', data: { fileName: 'claude-account-4.json', email: 'clau4@test.com', prefix: '', provider: 'claude' } },
  ];

  const clauMastersWithAssignedGemini = [
    ...clauMastersWithoutPrefix,
    { id: 'gm1', data: { fileName: 'antigravity-test.json', email: 'gemini@test.com', prefix: 'agy', provider: 'antigravity' } },
  ];

  const registryClauPool = [
    {
      family: 'claude',
      base_prefix: 'clau',
      leader_auth: 'claude-account-1.json',
      reserves: [
        'claude-account-2.json',
        'claude-account-3.json',
        'claude-account-4.json',
      ],
      policy: { disable_isolation: false, exclude_55: false },
    },
  ];

  it('shows registry pools in the Dissolve tab even when disk prefixes are empty (registry is source of truth)', async () => {
    vi.spyOn(managementClient, 'listPools').mockResolvedValue({
      ok: true,
      pools: registryClauPool,
      count: 1,
    });

    render(<GroupManager nodes={clauMastersWithoutPrefix} />);

    fireEvent.click(screen.getByTestId('tab-disolver-pools'));

    // Esperar a que el registro se sincronice y mostrar 1 pool en Disolver
    await waitFor(() => {
      expect(screen.getByTestId('pool-card-clau')).toBeTruthy();
    });
    expect(screen.getByText(/Disolver \/ ➕ Sumar \/ Adoptar Reservas \(1\)/)).toBeTruthy();
  });

  it('excludes registry pool members from free candidates (prevents duplicate assignment)', async () => {
    vi.spyOn(managementClient, 'listPools').mockResolvedValue({
      ok: true,
      pools: registryClauPool,
      count: 1,
    });

    render(<GroupManager nodes={clauMastersWithAssignedGemini} />);

    // Las 4 cuentas son miembros del pool clau registrado → cero candidatos libres
    await waitFor(() => {
      expect(screen.getByText(/Disolver \/ ➕ Sumar \/ Adoptar Reservas \(1\)/)).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('family-claude'));
    expect(screen.queryByTestId('select-active-account')).toBeNull();
    expect(screen.getByTestId('capacity-notice-zero')).toBeTruthy();
    expect(screen.getByTestId('no-compatible-accounts-alert')).toBeTruthy();
  });

  it('degrades gracefully to disk-derived pools when the registry is unreachable', async () => {
    vi.spyOn(managementClient, 'listPools').mockRejectedValue(
      new Error('Management key not found.')
    );

    const legacyNodes = mastersWithoutPrefix.map((n, idx) => ({
      ...n,
      data: { ...n.data, prefix: idx === 0 ? 'legacy' : `legacy_${idx}` },
    }));

    render(<GroupManager nodes={legacyNodes} />);

    fireEvent.click(screen.getByTestId('tab-disolver-pools'));

    // Sin registro: el pool legacy derivado de prefijos en disco sigue visible
    await waitFor(() => {
      expect(screen.getByTestId('pool-card-legacy')).toBeTruthy();
    });
  });
});

describe('GroupManager - Homologación 2N (dual-familia por rol de cuota)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const mastersWithoutPrefix = [
    { id: 'm1', data: { fileName: 'antigravity-infosoytec@gmail.com.json', email: 'inf...tec@gmail.com', prefix: '', provider: 'antigravity' } },
    { id: 'm2', data: { fileName: 'antigravity-maribelluzbonitaaquinocastro@gmail.com.json', email: 'mar...tro@gmail.com', prefix: '', provider: 'antigravity' } },
    { id: 'm3', data: { fileName: 'antigravity-wilsonlavio11@gmail.com.json', email: 'wil...io11@gmail.com', prefix: '', provider: 'antigravity' } },
    { id: 'm4', data: { fileName: 'antigravity-wilsonlavio9@gmail.com.json', email: 'wil...io9@gmail.com', prefix: '', provider: 'antigravity' } },
  ];

  const geminiPooledNodes = mastersWithoutPrefix.map((n, idx) => ({
    ...n,
    data: { ...n.data, prefix: idx === 0 ? 'agy' : `agy_${idx}` },
  }));

  const registryGeminiPool = [{
    family: 'gemini_pure',
    base_prefix: 'agy',
    leader_auth: 'antigravity-infosoytec@gmail.com.json',
    reserves: [
      'antigravity-maribelluzbonitaaquinocastro@gmail.com.json',
      'antigravity-wilsonlavio11@gmail.com.json',
      'antigravity-wilsonlavio9@gmail.com.json',
    ],
    policy: {
      disable_isolation: false,
      exclude_55: false,
      target_models: ['gemini-3-flash', 'gemini-3.8-flash-high'],
    },
  }];

  const registryClaudePool = [{
    family: 'claude',
    base_prefix: 'clau',
    leader_auth: 'antigravity-infosoytec@gmail.com.json',
    reserves: [
      'antigravity-maribelluzbonitaaquinocastro@gmail.com.json',
      'antigravity-wilsonlavio11@gmail.com.json',
      'antigravity-wilsonlavio9@gmail.com.json',
    ],
    policy: { disable_isolation: false, exclude_55: false },
  }];

  it('builds a second-family pool with accounts already serving another family (2N) without cloning or overwriting prefixes', async () => {
    vi.spyOn(managementClient, 'listPools').mockResolvedValue({
      ok: true, pools: registryGeminiPool, count: 1,
    });
    // Catálogo base: 3 targets de familias (2 gemini del pool existente + 1 claude nuevo) + 1 foreign antigravity junk
    vi.spyOn(managementClient, 'listModels').mockResolvedValue({
      models: ['agy/gemini-3-flash', 'agy/gemini-3.8-flash-high', 'agy_clau/claude-sonnet-4-6', 'agy/gemini-junk-model-1'],
    });
    const savePoolSpy = vi.spyOn(managementClient, 'savePool').mockResolvedValue({
      ok: true, pool: { base_prefix: 'agy_clau' }, message: 'Pool agy_clau saved',
    });
    const patchPrefixesSpy = vi.spyOn(managementClient, 'saveAuthFilePrefixes').mockResolvedValue({ successful: [], failed: [] });
    const patchExclusionsSpy = vi.spyOn(managementClient, 'patchAuthFileExclusions').mockResolvedValue({ ok: true });
    const virtualizeSpy = vi.spyOn(managementClient, 'virtualizeAccount').mockResolvedValue({ name: 'x.json', prefix: 'agy_clau' });

    render(<GroupManager nodes={geminiPooledNodes} />);

    await waitFor(() => {
      expect(screen.getByText(/Disolver \/ ➕ Sumar \/ Adoptar Reservas \(1\)/)).toBeTruthy();
    });

    // Subfamilia Claude de Antigravity (2N): los masters del pool Gemini DEBEN aparecer como candidatos
    fireEvent.click(screen.getByTestId('family-gemini'));
    fireEvent.click(screen.getByTestId('subfamily-gemini-claude'));
    await waitFor(() => {
      const opts = Array.from(screen.getByTestId('select-active-account').options).filter((o) => o.value !== '');
      expect(opts.length).toBe(4);
    });

    fireEvent.change(screen.getByTestId('select-active-account'), { target: { value: 'm1' } });
    fireEvent.click(screen.getByTestId('reserve-item-m2'));
    fireEvent.change(screen.getByTestId('input-group-base-prefix'), { target: { value: 'agy_clau' } });
    fireEvent.click(screen.getByTestId('btn-save-group'));

    await waitFor(() => expect(savePoolSpy).toHaveBeenCalledTimes(1));
    const payload = savePoolSpy.mock.calls[0][0];
    expect(payload.family).toBe('gemini_claude');
    expect(payload.base_prefix).toBe('agy_clau');
    expect(payload.leader_auth).toBe('antigravity-infosoytec@gmail.com.json');
    expect(payload.reserves).toContain('antigravity-maribelluzbonitaaquinocastro@gmail.com.json');

    // Zero clones / zero prefix overwrite: la familia Gemini en disco queda intacta
    expect(virtualizeSpy).not.toHaveBeenCalled();
    expect(patchPrefixesSpy).not.toHaveBeenCalled();

    // En gobernanza virtual pura, no mutamos los excluded_models en disco para no mutilar
    // las credenciales nativas de CPAMC
    expect(patchExclusionsSpy).not.toHaveBeenCalled();
  });

  it('still blocks accounts already in a same-family registered pool (gemini side)', async () => {
    vi.spyOn(managementClient, 'listPools').mockResolvedValue({
      ok: true, pools: registryGeminiPool, count: 1,
    });

    render(<GroupManager nodes={mastersWithoutPrefix} />);

    await waitFor(() => {
      expect(screen.getByText(/Disolver \/ ➕ Sumar \/ Adoptar Reservas \(1\)/)).toBeTruthy();
    });

    // Familia Gemini (puro por defecto): los 4 masters ya están en el pool agy → 0 candidatos
    fireEvent.click(screen.getByTestId('family-gemini'));
    await waitFor(() => {
      expect(screen.queryByTestId('select-active-account')).toBeNull();
      expect(screen.getByTestId('capacity-notice-zero')).toBeTruthy();
    });
    expect(screen.getByTestId('no-compatible-accounts-alert')).toBeTruthy();
  });

  it('dissolving a registry-only second-family pool does not touch other-family disk prefixes', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.spyOn(managementClient, 'listPools').mockResolvedValue({
      ok: true, pools: registryClaudePool, count: 1,
    });
    const dissolveSpy = vi.spyOn(managementClient, 'dissolvePool').mockResolvedValue({ ok: true });
    const patchPrefixesSpy = vi.spyOn(managementClient, 'saveAuthFilePrefixes').mockResolvedValue({ successful: [], failed: [] });
    const deleteSpy = vi.spyOn(managementClient, 'deleteAuthFile').mockResolvedValue({ ok: true });

    render(<GroupManager nodes={geminiPooledNodes} />);

    await waitFor(() => {
      expect(screen.getByText(/Disolver \/ ➕ Sumar \/ Adoptar Reservas \(1\)/)).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('tab-disolver-pools'));
    fireEvent.click(screen.getByTestId('btn-dissolve-pool-clau'));

    await waitFor(() => expect(dissolveSpy).toHaveBeenCalledWith('clau'));

    // Los prefijos agy* del pool Gemini quedan intactos (solo se libera la membresía claude)
    expect(patchPrefixesSpy).not.toHaveBeenCalled();
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it('allows adopting a single newly added free account into an existing pool as an extra reserve', async () => {
    const existingPoolsData = [
      {
        id: 'pool-agy-1',
        family: 'gemini_pure',
        base_prefix: 'agy',
        leader_auth: 'antigravity-leader@gmail.com.json',
        reserves: ['antigravity-res1@gmail.com.json'],
        policy: { disable_isolation: false, target_models: ['gemini-3.8-flash-high'] },
      },
    ];
    vi.spyOn(managementClient, 'listPools').mockResolvedValue({
      ok: true,
      pools: existingPoolsData,
      count: 1,
    });
    const savePoolSpy = vi.spyOn(managementClient, 'savePool').mockResolvedValue({ ok: true });
    const patchSpy = vi.spyOn(managementClient, 'saveAuthFilePrefixes').mockResolvedValue({
      successful: [{ name: 'antigravity-newfree@gmail.com.json', prefix: 'agy_2' }],
      failed: [],
    });

    const nodesWithNewFree = [
      {
        id: 'antigravity-leader@gmail.com.json',
        data: { fileName: 'antigravity-leader@gmail.com.json', email: 'leader@gmail.com', prefix: 'agy', provider: 'antigravity' },
      },
      {
        id: 'antigravity-res1@gmail.com.json',
        data: { fileName: 'antigravity-res1@gmail.com.json', email: 'res1@gmail.com', prefix: 'agy_1', provider: 'antigravity' },
      },
      {
        id: 'antigravity-newfree@gmail.com.json',
        data: { fileName: 'antigravity-newfree@gmail.com.json', email: 'newfree@gmail.com', prefix: '', provider: 'antigravity' },
      },
    ];

    render(<GroupManager nodes={nodesWithNewFree} />);

    // Ir a la pestaña unificada de Disolver / Sumar / Adoptar Reservas
    await waitFor(() => {
      expect(screen.getByTestId('tab-disolver-pools')).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId('tab-disolver-pools'));

    await waitFor(() => {
      expect(screen.getByTestId('card-adopt-section-agy')).toBeTruthy();
      expect(screen.getByTestId('select-card-adopt-agy')).toBeTruthy();
      expect(screen.getByTestId('btn-card-adopt-agy')).toBeTruthy();
    });

    // Selecciona la cuenta libre y hace click en sumar reserva en la fila final de la tarjeta
    const selectFree = screen.getByTestId('select-card-adopt-agy');
    fireEvent.change(selectFree, { target: { value: 'antigravity-newfree@gmail.com.json' } });
    fireEvent.click(screen.getByTestId('btn-card-adopt-agy'));

    await waitFor(() => {
      expect(patchSpy).toHaveBeenCalledWith([
        { name: 'antigravity-newfree@gmail.com.json', prefix: 'agy_2' },
      ]);
      expect(savePoolSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          base_prefix: 'agy',
          reserves: ['antigravity-res1@gmail.com.json', 'antigravity-newfree@gmail.com.json'],
          policy: expect.objectContaining({
            target_models: ['gemini-3.8-flash-high'],
          }),
        })
      );
    });
  });

  it('allows releasing an individual reserve account from a pool in the Dissolve tab', async () => {
    const existingPoolsData = [
      {
        id: 'pool-agy-1',
        family: 'gemini_pure',
        base_prefix: 'agy',
        leader_auth: 'acc-leader.json',
        reserves: ['acc-res1.json', 'acc-res2.json'],
        members: ['acc-leader.json', 'acc-res1.json', 'acc-res2.json'],
        member_models: {
          'acc-leader.json': 'gemini-3.8-flash-high',
          'acc-res1.json': 'gemini-3.7-flash-high',
          'acc-res2.json': 'gemini-2.5-flash',
        },
      },
    ];
    vi.spyOn(managementClient, 'listPools').mockResolvedValue({
      ok: true,
      pools: existingPoolsData,
      count: 1,
    });
    const savePoolSpy = vi.spyOn(managementClient, 'savePool').mockResolvedValue({ ok: true });
    const patchSpy = vi.spyOn(managementClient, 'saveAuthFilePrefixes').mockResolvedValue({
      successful: [{ name: 'acc-res1.json', prefix: '' }],
      failed: [],
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    const poolNodes = [
      { id: 'acc-leader.json', data: { fileName: 'acc-leader.json', email: 'leader@test.com', prefix: 'agy', provider: 'antigravity' } },
      { id: 'acc-res1.json', data: { fileName: 'acc-res1.json', email: 'res1@test.com', prefix: 'agy_1', provider: 'antigravity' } },
      { id: 'acc-res2.json', data: { fileName: 'acc-res2.json', email: 'res2@test.com', prefix: 'agy_2', provider: 'antigravity' } },
    ];

    render(<GroupManager nodes={poolNodes} />);

    fireEvent.click(screen.getByTestId('tab-disolver-pools'));
    await waitFor(() => {
      expect(screen.getByTestId('pool-card-agy')).toBeTruthy();
    });

    const releaseBtn = screen.getByTestId('btn-release-reserve-agy-acc-res1.json');
    expect(releaseBtn).toBeTruthy();
    fireEvent.click(releaseBtn);

    await waitFor(() => {
      expect(patchSpy).toHaveBeenCalledWith([{ name: 'acc-res1.json', prefix: '' }]);
      expect(savePoolSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          base_prefix: 'agy',
          reserves: ['acc-res2.json'],
          members: ['acc-leader.json', 'acc-res2.json'],
          member_models: expect.not.objectContaining({
            'acc-res1.json': expect.anything(),
          }),
        })
      );
    });
  });

  it('excludes single-account standalone entries from disk (0 reserves) from existing pools list', async () => {
    vi.spyOn(managementClient, 'listPools').mockResolvedValue({
      ok: true,
      pools: [],
      count: 0,
    });

    const standaloneAndPoolNodes = [
      // Cuenta standalone / fija con prefijo "nan" en CPAMC pero 0 reservas -> NO es pool
      { id: 'nan1', data: { fileName: 'nan-4332.json', email: 'nan@test.com', prefix: 'nan', provider: 'nan' } },
      // Pool legítimo legacy con 1 líder y 1 reserva -> SI es pool
      { id: 'nim1', data: { fileName: 'nvidia-1.json', email: 'nim1@test.com', prefix: 'nim', provider: 'nvidia' } },
      { id: 'nim2', data: { fileName: 'nvidia-2.json', email: 'nim2@test.com', prefix: 'nim_1', provider: 'nvidia' } },
    ];

    render(<GroupManager nodes={standaloneAndPoolNodes} />);

    fireEvent.click(screen.getByTestId('tab-disolver-pools'));

    await waitFor(() => {
      // El pool legítimo de 2 cuentas sí aparece
      expect(screen.getByTestId('pool-card-nim')).toBeTruthy();
      // La cuenta suelta de 1 sola cuenta (nan) queda totalmente excluida porque no es pool
      expect(screen.queryByTestId('pool-card-nan')).toBeNull();
    });
  });

  it('isolates card adopt to matching provider and hides adopt section when no compatible accounts exist', async () => {
    vi.spyOn(managementClient, 'listPools').mockResolvedValue({
      ok: true,
      pools: [
        {
          id: 'Pool-01-nan',
          family: 'nan',
          base_prefix: 'nan',
          leader_auth: 'nan-leader.json',
          reserves: ['nan-res1.json'],
          members: ['nan-leader.json', 'nan-res1.json'],
        },
      ],
      count: 1,
    });

    const crossProviderNodes = [
      // Miembros del pool NaN
      { id: 'nan-leader.json', data: { fileName: 'nan-leader.json', email: 'nan1@test.com', prefix: 'nan', provider: 'nan' } },
      { id: 'nan-res1.json', data: { fileName: 'nan-res1.json', email: 'nan2@test.com', prefix: 'nan_1', provider: 'nan' } },
      // Cuenta libre pero de GOOGLE (antigravity), NO de NaN
      { id: 'free-google.json', data: { fileName: 'antigravity-free@gmail.com.json', email: 'free@gmail.com', prefix: '', provider: 'antigravity' } },
    ];

    render(<GroupManager nodes={crossProviderNodes} />);

    fireEvent.click(screen.getByTestId('tab-disolver-pools'));

    await waitFor(() => {
      expect(screen.getByTestId('pool-card-nan')).toBeTruthy();
    });

    // Como la única cuenta libre es de Google, el pool de NaN NO debe mostrar la sección de sumar reserva
    expect(screen.queryByTestId('card-adopt-section-nan')).toBeNull();
  });

  it('strictly isolates adopt reserve section: only matching provider pools show the section and non-matching are completely hidden', async () => {
    vi.spyOn(managementClient, 'listPools').mockResolvedValue({
      ok: true,
      pools: [
        {
          id: 'Pool-01-gemini',
          family: 'gemini_pure',
          base_prefix: 'agy',
          leader_auth: 'agy-leader.json',
          reserves: ['agy-res.json'],
          members: ['agy-leader.json', 'agy-res.json'],
        },
        {
          id: 'Pool-02-codex',
          family: 'codex',
          base_prefix: 'codex',
          leader_auth: 'codex-leader.json',
          reserves: ['codex-res.json'],
          members: ['codex-leader.json', 'codex-res.json'],
        },
        {
          id: 'Pool-03-nim',
          family: 'nim',
          base_prefix: 'nim',
          leader_auth: 'nvidia-nim-1.json',
          reserves: ['nvidia-nim-2.json'],
          members: ['nvidia-nim-1.json', 'nvidia-nim-2.json'],
        },
      ],
      count: 3,
    });

    // Escenario de prueba: Hay 1 cuenta libre disponible de CODEX únicamente
    const mixedPoolNodes = [
      // Miembros de Gemini
      { id: 'agy-leader.json', data: { fileName: 'agy-leader.json', email: 'agy1@test.com', prefix: 'agy', provider: 'antigravity' } },
      { id: 'agy-res.json', data: { fileName: 'agy-res.json', email: 'agy2@test.com', prefix: 'agy_1', provider: 'antigravity' } },
      // Miembros de Codex
      { id: 'codex-leader.json', data: { fileName: 'codex-leader.json', email: 'codex1@test.com', prefix: 'codex', provider: 'codex' } },
      { id: 'codex-res.json', data: { fileName: 'codex-res.json', email: 'codex2@test.com', prefix: 'codex_1', provider: 'codex' } },
      // Miembros de NVIDIA NIM
      { id: 'nvidia-nim-1.json', data: { fileName: 'nvidia-nim-1.json', email: 'nim1@test.com', prefix: 'nim', provider: 'nim' } },
      { id: 'nvidia-nim-2.json', data: { fileName: 'nvidia-nim-2.json', email: 'nim2@test.com', prefix: 'nim_1', provider: 'nim' } },
      // ÚNICA CUENTA LIBRE: pertenencia estricta a CODEX
      { id: 'codex-free.json', data: { fileName: 'codex-free.json', email: 'codex_free@test.com', prefix: '', provider: 'codex' } },
    ];

    render(<GroupManager nodes={mixedPoolNodes} />);

    fireEvent.click(screen.getByTestId('tab-disolver-pools'));

    await waitFor(() => {
      expect(screen.getByTestId('pool-card-agy')).toBeTruthy();
      expect(screen.getByTestId('pool-card-codex')).toBeTruthy();
      expect(screen.getByTestId('pool-card-nim')).toBeTruthy();
    });

    // 1. El pool de CODEX debe MOSTRAR la sección de sumar reserva porque tiene 1 cuenta libre de su proveedor
    expect(screen.getByTestId('card-adopt-section-codex')).toBeTruthy();
    expect(screen.getByTestId('select-card-adopt-codex').textContent).toContain('codex_free@test.com');

    // 2. Los pools de GEMINI y NIM NO deben mostrar NINGÚN control ni dato de sumar reserva (deben estar 100% ocultos)
    expect(screen.queryByTestId('card-adopt-section-agy')).toBeNull();
    expect(screen.queryByTestId('card-adopt-section-nim')).toBeNull();
  });

  it('allows releasing the leader account and promotes first reserve to leader', async () => {
    const existingPoolsData = [
      {
        id: 'pool-agy-1',
        family: 'gemini_pure',
        base_prefix: 'agy',
        leader_auth: 'acc-leader.json',
        reserves: ['acc-res1.json', 'acc-res2.json'],
        members: ['acc-leader.json', 'acc-res1.json', 'acc-res2.json'],
        member_models: {
          'acc-leader.json': 'gemini-3.8-flash-high',
          'acc-res1.json': 'gemini-3.7-flash-high',
          'acc-res2.json': 'gemini-2.5-flash',
        },
      },
    ];
    vi.spyOn(managementClient, 'listPools').mockResolvedValue({
      ok: true,
      pools: existingPoolsData,
      count: 1,
    });
    const savePoolSpy = vi.spyOn(managementClient, 'savePool').mockResolvedValue({ ok: true });
    const patchSpy = vi.spyOn(managementClient, 'saveAuthFilePrefixes').mockResolvedValue({
      successful: [],
      failed: [],
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    const poolNodes = [
      { id: 'acc-leader.json', data: { fileName: 'acc-leader.json', email: 'leader@test.com', prefix: 'agy', provider: 'antigravity' } },
      { id: 'acc-res1.json', data: { fileName: 'acc-res1.json', email: 'res1@test.com', prefix: 'agy_1', provider: 'antigravity' } },
      { id: 'acc-res2.json', data: { fileName: 'acc-res2.json', email: 'res2@test.com', prefix: 'agy_2', provider: 'antigravity' } },
    ];

    render(<GroupManager nodes={poolNodes} />);

    fireEvent.click(screen.getByTestId('tab-disolver-pools'));
    await waitFor(() => {
      expect(screen.getByTestId('pool-card-agy')).toBeTruthy();
    });

    const releaseLeaderBtn = screen.getByTestId('btn-release-leader-agy');
    expect(releaseLeaderBtn).toBeTruthy();
    fireEvent.click(releaseLeaderBtn);

    await waitFor(() => {
      // Leader becomes free, res1 promoted to agy, res2 remains agy_1
      expect(patchSpy).toHaveBeenCalledWith([
        { name: 'acc-leader.json', prefix: '' },
        { name: 'acc-res1.json', prefix: 'agy' },
        { name: 'acc-res2.json', prefix: 'agy_1' },
      ]);
      expect(savePoolSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          base_prefix: 'agy',
          leader_auth: 'acc-res1.json',
          active_leader: 'acc-res1.json',
          members: ['acc-res1.json', 'acc-res2.json'],
          reserves: ['acc-res2.json'],
          member_models: expect.not.objectContaining({
            'acc-leader.json': expect.anything(),
          }),
        })
      );
    });
  });

  it('renders pools in deterministic numerical order (Pool-01, Pool-02, Pool-04) in Dissolve tab regardless of backend map order', async () => {
    const disorderedPools = [
      {
        id: 'Pool-04-claude',
        display_name: 'Pool-04-claude',
        base_prefix: 'agy_clau',
        family: 'gemini_claude',
        leader_auth: 'clau-leader.json',
        reserves: ['clau-res.json'],
        members: ['clau-leader.json', 'clau-res.json'],
      },
      {
        id: 'Pool-02-gemini',
        display_name: 'Pool-02-gemini',
        base_prefix: 'agy2',
        family: 'gemini_pure',
        leader_auth: 'gem2-leader.json',
        reserves: ['gem2-res.json'],
        members: ['gem2-leader.json', 'gem2-res.json'],
      },
      {
        id: 'Pool-01-gemini',
        display_name: 'Pool-01-gemini',
        base_prefix: 'agy',
        family: 'gemini_pure',
        leader_auth: 'gem1-leader.json',
        reserves: ['gem1-res.json'],
        members: ['gem1-leader.json', 'gem1-res.json'],
      },
    ];

    vi.spyOn(managementClient, 'listPools').mockResolvedValue({
      ok: true,
      pools: disorderedPools,
      count: 3,
    });

    const poolNodes = [
      { id: 'gem1-leader.json', data: { fileName: 'gem1-leader.json', email: 'gem1@test.com', prefix: 'agy', provider: 'antigravity' } },
      { id: 'gem1-res.json', data: { fileName: 'gem1-res.json', email: 'gem1-res@test.com', prefix: 'agy_1', provider: 'antigravity' } },
      { id: 'gem2-leader.json', data: { fileName: 'gem2-leader.json', email: 'gem2@test.com', prefix: 'agy2', provider: 'antigravity' } },
      { id: 'gem2-res.json', data: { fileName: 'gem2-res.json', email: 'gem2-res@test.com', prefix: 'agy2_1', provider: 'antigravity' } },
      { id: 'clau-leader.json', data: { fileName: 'clau-leader.json', email: 'clau@test.com', prefix: 'agy_clau', provider: 'antigravity' } },
      { id: 'clau-res.json', data: { fileName: 'clau-res.json', email: 'clau-res@test.com', prefix: 'agy_clau_1', provider: 'antigravity' } },
    ];

    render(<GroupManager nodes={poolNodes} />);

    fireEvent.click(screen.getByTestId('tab-disolver-pools'));

    await waitFor(() => {
      expect(screen.getByTestId('pool-card-agy')).toBeTruthy();
      expect(screen.getByTestId('pool-card-agy2')).toBeTruthy();
      expect(screen.getByTestId('pool-card-agy_clau')).toBeTruthy();
    });

    // Check DOM order of the cards: agy (Pool-01) first, agy2 (Pool-02) second, agy_clau (Pool-04) third
    const cards = document.querySelectorAll('.group-pool-card');
    expect(cards).toHaveLength(3);
    expect(cards[0].getAttribute('data-testid')).toBe('pool-card-agy');
    expect(cards[1].getAttribute('data-testid')).toBe('pool-card-agy2');
    expect(cards[2].getAttribute('data-testid')).toBe('pool-card-agy_clau');
  });

  describe('GroupManager - Dynamic OmniAuth Pro Provider Families', () => {
    it('dynamically appends OmniAuth Pro family chips after Codex when accounts exist', () => {
      const nodesWithDeepSeek = [
        {
          id: 'antigravity-1.json',
          name: 'antigravity-1.json',
          data: {
            fileName: 'antigravity-1.json',
            prefix: '',
            provider: 'antigravity',
            email: 'gemini@example.com',
          },
        },
        {
          id: 'deepseek-acc1.json',
          name: 'deepseek-acc1.json',
          data: {
            fileName: 'deepseek-acc1.json',
            prefix: '',
            provider: 'deepseek',
            email: 'deepseek-user1@example.com',
          },
        },
        {
          id: 'deepseek-acc2.json',
          name: 'deepseek-acc2.json',
          data: {
            fileName: 'deepseek-acc2.json',
            prefix: '',
            provider: 'deepseek',
            email: 'deepseek-user2@example.com',
          },
        },
      ];

      render(<GroupManager nodes={nodesWithDeepSeek} />);

      // Core families: Gemini exists because antigravity accounts are logged in
      expect(screen.getByTestId('family-gemini')).toBeTruthy();
      // Families with 0 accounts (Claude and Codex) are dynamically hidden
      expect(screen.queryByTestId('family-claude')).toBeNull();
      expect(screen.queryByTestId('family-codex')).toBeNull();

      // DeepSeek dynamic family chip must appear appended
      const deepseekChip = screen.getByTestId('family-deepseek');
      expect(deepseekChip).toBeTruthy();
      expect(deepseekChip.textContent).toContain('DeepSeek');
      expect(deepseekChip.textContent).toContain('DeepSeek Chat & Reasoner');

      // Unused providers (e.g. Groq, Cerebras) must NOT pollute the UI
      expect(screen.queryByTestId('family-groq')).toBeNull();
      expect(screen.queryByTestId('family-cerebras')).toBeNull();
    });

    it('filters leader and reserve candidates strictly to the chosen dynamic provider and suggests prefix', async () => {
      const mixedNodes = [
        {
          id: 'deepseek-acc1.json',
          name: 'deepseek-acc1.json',
          data: {
            fileName: 'deepseek-acc1.json',
            prefix: '',
            provider: 'deepseek',
            email: 'deepseek-user1@example.com',
          },
        },
        {
          id: 'deepseek-acc2.json',
          name: 'deepseek-acc2.json',
          data: {
            fileName: 'deepseek-acc2.json',
            prefix: '',
            provider: 'deepseek',
            email: 'deepseek-user2@example.com',
          },
        },
        {
          id: 'nvidia-acc1.json',
          name: 'nvidia-acc1.json',
          data: {
            fileName: 'nvidia-acc1.json',
            prefix: '',
            provider: 'nvidia',
            email: 'nvidia-user@example.com',
          },
        },
      ];

      render(<GroupManager nodes={mixedNodes} />);

      // Select DeepSeek family
      const deepseekChip = screen.getByTestId('family-deepseek');
      fireEvent.click(deepseekChip);

      // Verify prefix auto-suggestion
      const prefixInput = screen.getByTestId('input-group-base-prefix');
      expect(prefixInput.value).toBe('deepseek');

      // Check leader select: must contain both DeepSeek accounts, but NEVER the NVIDIA account
      const selectLeader = screen.getByTestId('select-active-account');
      const options = Array.from(selectLeader.querySelectorAll('option')).map((o) => o.value);
      expect(options).toContain('deepseek-acc1.json');
      expect(options).toContain('deepseek-acc2.json');
      expect(options).not.toContain('nvidia-acc1.json');

      // Select deepseek-acc1 as leader
      fireEvent.change(selectLeader, { target: { value: 'deepseek-acc1.json' } });

      // Reserve list should now show deepseek-acc2 as the only available candidate
      await waitFor(() => {
        expect(screen.getByTestId('reserve-item-deepseek-acc2.json')).toBeTruthy();
      });
      expect(screen.queryByTestId('reserve-item-deepseek-acc1.json')).toBeNull();
      expect(screen.queryByTestId('reserve-item-nvidia-acc1.json')).toBeNull();
    });

    it('isolates specialist models strictly to chosen OmniAuth Pro provider (e.g. nan) without defaulting or contaminating with Gemini', async () => {
      const nanNodes = [
        {
          id: 'nan-acc1.json',
          name: 'nan-acc1.json',
          data: {
            fileName: 'nan-acc1.json',
            prefix: '',
            provider: 'nan',
            email: 'nan-user1@example.com',
          },
        },
        {
          id: 'nan-acc2.json',
          name: 'nan-acc2.json',
          data: {
            fileName: 'nan-acc2.json',
            prefix: '',
            provider: 'nan',
            email: 'nan-user2@example.com',
          },
        },
        {
          id: 'antigravity-acc.json',
          name: 'antigravity-acc.json',
          data: {
            fileName: 'antigravity-acc.json',
            prefix: '',
            provider: 'antigravity',
            email: 'gemini-user@example.com',
          },
        },
      ];

      render(<GroupManager nodes={nanNodes} />);

      // Select NaN Builders family
      const nanChip = screen.getByTestId('family-nan');
      fireEvent.click(nanChip);

      const specialistSelect = screen.getByTestId('select-specialist-model');
      // Antes de seleccionar cuenta titular, el selector está deshabilitado
      expect(specialistSelect.disabled).toBe(true);

      // Al seleccionar la cuenta titular, se habilita dinámicamente
      fireEvent.change(screen.getByTestId('select-active-account'), { target: { value: 'nan-acc1.json' } });
      expect(specialistSelect.disabled).toBe(false);

      const specialistOptions = Array.from(specialistSelect.querySelectorAll('option')).map((o) => o.value);

      // Verify specialist models are strictly NaN models, never Gemini
      expect(specialistOptions).toContain('deepseek-v4-flash');
      expect(specialistOptions).not.toContain('gemini-3.8-flash-high');
      expect(specialistOptions).not.toContain('gemini-3.7-flash-high');

      // Comienza sin ningún valor preseleccionado arbitrario (vacío)
      expect(specialistSelect.value).toBe('');
      const optionsTexts = Array.from(specialistSelect.querySelectorAll('option')).map((o) => o.textContent);
      expect(optionsTexts.some((t) => t.includes('deepseek-v4-flash') && t.includes('⭐ (Recomendado)'))).toBe(true);
    });

    it('does not render family chip when family has no logged-in accounts (e.g. OpenAI Codex)', () => {
      // Setup nodes with ONLY Gemini and NaN accounts (NO OpenAI Codex accounts)
      const nodesWithoutCodex = [
        {
          id: 'nan-acc1.json',
          name: 'nan-acc1.json',
          data: {
            fileName: 'nan-acc1.json',
            prefix: '',
            provider: 'nan',
            email: 'nan-user@example.com',
          },
        },
        {
          id: 'antigravity-acc.json',
          name: 'antigravity-acc.json',
          data: {
            fileName: 'antigravity-acc.json',
            prefix: '',
            provider: 'antigravity',
            email: 'gemini-user@example.com',
          },
        },
      ];

      render(<GroupManager nodes={nodesWithoutCodex} />);

      // OpenAI Codex has 0 accounts logged in -> chip is dynamically hidden
      expect(screen.queryByTestId('family-codex')).toBeNull();
    });

    it('does not render Anthropic Claude chip when ONLY Antigravity accounts are logged in (zero official clau* accounts)', () => {
      // Setup nodes with ONLY Antigravity accounts (no direct Anthropic Claude accounts)
      const nodesWithOnlyAntigravity = [
        {
          id: 'antigravity-infosoytec@gmail.com.json',
          name: 'antigravity-infosoytec@gmail.com.json',
          data: {
            fileName: 'antigravity-infosoytec@gmail.com.json',
            prefix: '',
            provider: 'antigravity',
            email: 'infosoytec@gmail.com',
          },
        },
        {
          id: 'antigravity-infowilsonlavio@gmail.com.json',
          name: 'antigravity-infowilsonlavio@gmail.com.json',
          data: {
            fileName: 'antigravity-infowilsonlavio@gmail.com.json',
            prefix: '',
            provider: 'antigravity',
            email: 'infowilsonlavio@gmail.com',
          },
        },
      ];

      render(<GroupManager nodes={nodesWithOnlyAntigravity} />);

      // Anthropic Claude has 0 direct clau* accounts logged in -> chip is dynamically hidden
      expect(screen.queryByTestId('family-claude')).toBeNull();
    });

    it('renders the header title with canonical providers Google Gemini / Anthropic Claude / OpenAI Codex / Otros', () => {
      const nodesWithGemini = [
        {
          id: 'antigravity-test.json',
          data: { fileName: 'antigravity-test.json', prefix: '', provider: 'antigravity', email: 'test@example.com' },
        },
      ];

      render(<GroupManager nodes={nodesWithGemini} />);

      const titleEl = screen.getByTestId('group-card-title');
      expect(titleEl.textContent).toContain('Estructuración de Grupo & Pool');
      expect(titleEl.textContent).toContain('Google Gemini');
      expect(titleEl.textContent).toContain('Anthropic Claude');
      expect(titleEl.textContent).toContain('OpenAI Codex');
      expect(titleEl.textContent).toContain('Otros');
    });
  });

  describe('Provider Isolation & Agnostic Resolution Contract (getNodeProvider & getPoolProvider)', () => {
    it('strictly classifies Codex accounts as codex even when filename or email contains @gmail.com', () => {
      const codexNode = {
        id: 'codex-ba780c88-infosoytec@gmail.com-plus.json',
        data: {
          fileName: 'codex-ba780c88-infosoytec@gmail.com-plus.json',
          prefix: '',
          provider: 'codex',
          email: 'infosoytec@gmail.com',
        },
      };

      expect(getNodeProvider(codexNode)).toBe('codex');
    });

    it('strictly classifies Claude accounts as claude and Antigravity accounts as antigravity', () => {
      const claudeNode = {
        id: 'claude-account.json',
        data: {
          fileName: 'claude-account.json',
          prefix: '',
          provider: 'claude',
          email: 'claude.user@gmail.com',
        },
      };
      const antigravityNode = {
        id: 'antigravity-maribelluz.json',
        data: {
          fileName: 'antigravity-maribelluz.json',
          prefix: 'agy',
          provider: 'antigravity',
          email: 'maribelluz@gmail.com',
        },
      };

      expect(getNodeProvider(claudeNode)).toBe('claude');
      expect(getNodeProvider(antigravityNode)).toBe('antigravity');
    });

    it('classifies NVIDIA NIM accounts correctly with prefix nim or nvidia-nim filename', () => {
      const nimNode = {
        id: 'nvidia-nim-107ccbf0ed71.json',
        data: {
          fileName: 'nvidia-nim-107ccbf0ed71.json',
          prefix: 'nim',
          provider: 'nvidia',
          email: 'nvidia-account',
        },
      };

      expect(getNodeProvider(nimNode)).toBe('nvidia');
      expect(getPoolProvider({ basePrefix: 'nim' })).toBe('nvidia');
    });

    it('hides SUMAR NUEVA RESERVA AL POOL in Gemini pools when the only free account belongs to Codex', async () => {
      vi.spyOn(managementClient, 'listPools').mockResolvedValue({
        ok: true,
        count: 1,
        pools: [
          {
            id: 'Pool-01-gemini',
            display_name: 'Pool-01-gemini',
            base_prefix: 'agy',
            family: 'gemini_pure',
            leader_auth: 'antigravity-lead.json',
            reserves: ['antigravity-res.json'],
            members: ['antigravity-lead.json', 'antigravity-res.json'],
            policy: { target_models: ['gemini-3.8-flash-high'] },
          },
        ],
      });

      const nodes = [
        {
          id: 'antigravity-lead.json',
          data: { fileName: 'antigravity-lead.json', prefix: 'agy', provider: 'antigravity', email: 'lead@gmail.com' },
        },
        {
          id: 'antigravity-res.json',
          data: { fileName: 'antigravity-res.json', prefix: 'agy_1', provider: 'antigravity', email: 'res@gmail.com' },
        },
        {
          id: 'codex-ba780c88-infosoytec@gmail.com-plus.json',
          data: {
            fileName: 'codex-ba780c88-infosoytec@gmail.com-plus.json',
            prefix: '',
            provider: 'codex',
            email: 'infosoytec@gmail.com',
          },
        },
      ];

      render(<GroupManager nodes={nodes} />);

      const tabDissolve = await screen.findByTestId('tab-disolver-pools');
      fireEvent.click(tabDissolve);

      await waitFor(() => {
        expect(screen.getByTestId('pool-card-agy')).toBeTruthy();
      });

      // Because the only free account is Codex, the Gemini pool MUST NOT show the reserve addition box
      expect(screen.queryByTestId('card-adopt-section-agy')).toBeNull();
      expect(screen.queryByTestId('select-card-adopt-agy')).toBeNull();
    });

    it('renders legacy nim pools as Pool-XX-nim with NVIDIA model instead of defaulting to gemini', async () => {
      vi.spyOn(managementClient, 'listPools').mockResolvedValue({
        ok: true,
        count: 0,
        pools: [],
      });

      const nodes = [
        {
          id: 'nvidia-nim-107ccbf0ed71.json',
          data: {
            fileName: 'nvidia-nim-107ccbf0ed71.json',
            prefix: 'nim',
            provider: 'nvidia',
            email: 'nim-lead@nvidia.com',
          },
        },
        {
          id: 'nvidia-nim-292a6c8db7ea.json',
          data: {
            fileName: 'nvidia-nim-292a6c8db7ea.json',
            prefix: 'nim_1',
            provider: 'nvidia',
            email: 'nim-res@nvidia.com',
          },
        },
      ];

      render(<GroupManager nodes={nodes} />);

      const tabDissolve = await screen.findByTestId('tab-disolver-pools');
      fireEvent.click(tabDissolve);

      await waitFor(() => {
        const poolCard = screen.getByTestId('pool-card-nim');
        expect(poolCard).toBeTruthy();
        expect(poolCard.textContent).toContain('Pool-01-nim');
        expect(poolCard.textContent).not.toContain('Pool-01-gemini');
        expect(poolCard.textContent).toContain('meta/llama-3.3-70b-instruct');
        expect(poolCard.textContent).not.toContain('gemini-3.8-flash-high');
      });
    });

    it('intercepts Armar y Guardar Pool with CommunityNoticeModal when not supporter and saves upon continuing', async () => {
      localStorage.clear(); // Limpiar supporter status
      const dynNodes = [
        { id: 'free1', data: { fileName: 'free1.json', email: 'free1@test.com', prefix: '', provider: 'antigravity' } },
        { id: 'free2', data: { fileName: 'free2.json', email: 'free2@test.com', prefix: '', provider: 'antigravity' } },
      ];

      const patchSpy = vi.spyOn(managementClient, 'saveAuthFilePrefixes').mockResolvedValue({
        successful: [{ name: 'free1.json', prefix: 'g1' }, { name: 'free2.json', prefix: 'g1_1' }],
        failed: [],
      });

      render(<GroupManager nodes={dynNodes} />);

      fireEvent.click(screen.getByTestId('family-gemini'));
      fireEvent.change(screen.getByTestId('input-group-base-prefix'), { target: { value: 'g1' } });
      fireEvent.change(screen.getByTestId('select-active-account'), { target: { value: 'free1' } });
      fireEvent.click(screen.getByTestId('reserve-item-free2'));

      // Clic en Guardar: no debe guardar de inmediato sino abrir el modal
      fireEvent.click(screen.getByTestId('btn-save-group'));

      const modal = await screen.findByTestId('community-notice-modal');
      expect(modal).toBeTruthy();
      expect(patchSpy).not.toHaveBeenCalled();

      // Clic en continuar gratis: se cierra el modal y se ejecuta el guardado del pool
      fireEvent.click(screen.getByTestId('btn-free-action'));

      await waitFor(() => {
        expect(patchSpy).toHaveBeenCalledWith([
          { name: 'free1.json', prefix: 'g1' },
          { name: 'free2.json', prefix: 'g1_1' },
        ]);
      });
    });
  });
});
