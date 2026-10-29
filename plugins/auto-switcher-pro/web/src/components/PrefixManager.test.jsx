import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import PrefixManager from './PrefixManager';
import * as managementClient from '../api/managementClient';

describe('PrefixManager Component - Full Screen Prefix & Accounts Engine', () => {
  const mockNodes = [
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
    {
      id: 'acc3',
      data: {
        fileName: 'antigravity-son-infowilsonlavio.json',
        email: 'inf...vio@gmail.com',
        prefix: 'agy_son',
        provider: 'antigravity',
      },
    },
    {
      id: 'acc4',
      data: {
        fileName: 'unlinked-account.json',
        email: 'free@test.com',
        prefix: '',
        provider: 'antigravity',
      },
    },
    {
      id: 'acc5',
      data: {
        fileName: 'antigravity-clau-wilox.json',
        email: 'wil...clau@gmail.com',
        prefix: 'agy_clau',
        provider: 'antigravity',
      },
    },
    {
      id: 'acc6',
      data: {
        fileName: 'antigravity-clau-res1.json',
        email: 'res...clau@gmail.com',
        prefix: 'agy_clau_1',
        provider: 'antigravity',
      },
    },
  ];

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders all accounts and filters dynamically by Gemini and Claude families', () => {
    render(<PrefixManager nodes={mockNodes} />);

    expect(screen.getByTestId('prefix-manager-view')).toBeTruthy();
    expect(screen.getByText('wil...io7@gmail.com')).toBeTruthy();
    expect(screen.getByText('mar...tro@gmail.com')).toBeTruthy();
    expect(screen.getByText('inf...vio@gmail.com')).toBeTruthy();

    // Filtro por Gemini
    fireEvent.click(screen.getByTestId('filter-chip-gemini'));
    expect(screen.getByText('wil...io7@gmail.com')).toBeTruthy();
    expect(screen.getByText('mar...tro@gmail.com')).toBeTruthy();
    expect(screen.queryByText('inf...vio@gmail.com')).toBeNull();

    // Filtro por Claude
    fireEvent.click(screen.getByTestId('filter-chip-claude'));
    expect(screen.getByText('inf...vio@gmail.com')).toBeTruthy();
    expect(screen.getByText('wil...clau@gmail.com')).toBeTruthy();
    expect(screen.getByText('res...clau@gmail.com')).toBeTruthy();
    expect(screen.queryByText('wil...io7@gmail.com')).toBeNull();

    // Filtro exclusivo por agy_clau y derivados
    fireEvent.click(screen.getByTestId('filter-chip-agy-clau'));
    expect(screen.getByText('wil...clau@gmail.com')).toBeTruthy();
    expect(screen.getByText('res...clau@gmail.com')).toBeTruthy();
    expect(screen.queryByText('inf...vio@gmail.com')).toBeNull();
    expect(screen.queryByText('wil...io7@gmail.com')).toBeNull();
  });

  it('allows editing an individual prefix and saves via PATCH API', async () => {
    const patchSpy = vi.spyOn(managementClient, 'saveAuthFilePrefixes').mockResolvedValue({
      successful: [{ name: 'unlinked-account.json', prefix: 'agy_g2' }],
      failed: [],
    });

    render(<PrefixManager nodes={mockNodes} />);

    const input = screen.getByTestId('input-prefix-acc4');
    fireEvent.change(input, { target: { value: 'agy_g2' } });

    const saveBtn = screen.getByTestId('btn-save-row-acc4');
    expect(saveBtn.disabled).toBe(false);

    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(patchSpy).toHaveBeenCalledWith([
        { name: 'unlinked-account.json', prefix: 'agy_g2' },
      ]);
    });
  });

  it('filters agy_clau tab and allows editing prefixes for agy_clau accounts', async () => {
    const patchSpy = vi.spyOn(managementClient, 'saveAuthFilePrefixes').mockResolvedValue({
      successful: [{ name: 'antigravity-clau-res1.json', prefix: 'agy_clau_2' }],
      failed: [],
    });

    render(<PrefixManager nodes={mockNodes} />);

    fireEvent.click(screen.getByTestId('filter-chip-agy-clau'));
    expect(screen.getByText('wil...clau@gmail.com')).toBeTruthy();
    expect(screen.getByText('res...clau@gmail.com')).toBeTruthy();

    const inputRes = screen.getByTestId('input-prefix-acc6');
    expect(inputRes.value).toBe('agy_clau_1');

    fireEvent.change(inputRes, { target: { value: 'agy_clau_2' } });

    const saveBtn = screen.getByTestId('btn-save-row-acc6');
    expect(saveBtn.disabled).toBe(false);

    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(patchSpy).toHaveBeenCalledWith([
        { name: 'antigravity-clau-res1.json', prefix: 'agy_clau_2' },
      ]);
    });
  });

  it('Gemini filter captures agy and agy2 pools (not only g1/g2/g3)', () => {
    const realPoolNodes = [
      {
        id: 'a1',
        data: { fileName: 'antigravity-main-maribelluz.json', email: 'mar...tro@gmail.com', prefix: 'agy', provider: 'antigravity' },
      },
      {
        id: 'a2',
        data: { fileName: 'antigravity-main-infosoytec.json', email: 'inf...tec@gmail.com', prefix: 'agy_1', provider: 'antigravity' },
      },
      {
        id: 'a3',
        data: { fileName: 'antigravity-main-wilsonlavio11.json', email: 'wil...o11@gmail.com', prefix: 'agy2', provider: 'antigravity' },
      },
      {
        id: 'a4',
        data: { fileName: 'antigravity-main-wilsonlavio9.json', email: 'wil...io9@gmail.com', prefix: 'agy2_1', provider: 'antigravity' },
      },
      {
        id: 'a5',
        data: { fileName: 'antigravity-clau-infosoytec.json', email: 'inf...tec2@gmail.com', prefix: 'agy_clau', provider: 'antigravity' },
      },
      {
        id: 'a6',
        data: { fileName: 'antigravity-clau-maribelluz.json', email: 'mar...tro2@gmail.com', prefix: 'agy_clau_1', provider: 'antigravity' },
      },
    ];

    render(<PrefixManager nodes={realPoolNodes} />);

    // Click Gemini filter
    fireEvent.click(screen.getByTestId('filter-chip-gemini'));

    // agy and agy_1 (Gemini pure) MUST be visible
    expect(screen.getByText('mar...tro@gmail.com')).toBeTruthy();
    expect(screen.getByText('inf...tec@gmail.com')).toBeTruthy();

    // agy2 and agy2_1 (Gemini pure 2) MUST be visible
    expect(screen.getByText('wil...o11@gmail.com')).toBeTruthy();
    expect(screen.getByText('wil...io9@gmail.com')).toBeTruthy();

    // agy_clau accounts must NOT be visible under Gemini filter
    expect(screen.queryByText('inf...tec2@gmail.com')).toBeNull();
    expect(screen.queryByText('mar...tro2@gmail.com')).toBeNull();
  });

  it('detects batch changes and enables Save Batch button', async () => {
    const patchSpy = vi.spyOn(managementClient, 'saveAuthFilePrefixes').mockResolvedValue({
      successful: [
        { name: 'antigravity-g1-wilsonlavio7.json', prefix: 'agy_g1_custom' },
      ],
      failed: [],
    });

    render(<PrefixManager nodes={mockNodes} />);

    const input1 = screen.getByTestId('input-prefix-acc1');
    fireEvent.change(input1, { target: { value: 'agy_g1_custom' } });

    const batchSaveBtn = screen.getByTestId('btn-save-batch-prefixes');
    expect(batchSaveBtn).toBeTruthy();

    fireEvent.click(batchSaveBtn);

    await waitFor(() => {
      expect(patchSpy).toHaveBeenCalled();
    });
  });

  it('renders specialist model badge for member accounts of registered pools', async () => {
    vi.spyOn(managementClient, 'listPools').mockResolvedValue({
      ok: true,
      pools: [
        {
          id: 'Pool-01-gemini',
          base_prefix: 'agy',
          active_leader: 'antigravity-g1-wilsonlavio7.json',
          leader_auth: 'antigravity-g1-wilsonlavio7.json',
          members: ['antigravity-g1-wilsonlavio7.json', 'antigravity-g1-maribelluz.json'],
          member_models: {
            'antigravity-g1-wilsonlavio7.json': 'gemini-3.8-flash-high',
            'antigravity-g1-maribelluz.json': 'gemini-3.7-flash-high',
          },
          policy: { target_models: ['gemini-3.8-flash-high'] },
        },
      ],
    });

    render(<PrefixManager nodes={mockNodes} />);

    await waitFor(() => {
      expect(screen.getAllByText('📦 Pool-01-gemini').length).toBe(2);
    });

    expect(screen.getByText('🎯 gemini-3.8-flash-high')).toBeTruthy();
    expect(screen.getByText('🎯 gemini-3.7-flash-high')).toBeTruthy();
  });

  it('keeps navigation and page state consistent when accounts shrink and grow', () => {
    vi.spyOn(managementClient, 'listPools').mockResolvedValue({ ok: true, pools: [] });
    const accounts = Array.from({ length: 125 }, (_, i) => ({
      id: `account-${i}`,
      data: { fileName: `account-${i}.json`, email: `user${i}@example.com`, prefix: `agy_${i}`, provider: 'antigravity' },
    }));
    const { rerender } = render(<PrefixManager nodes={accounts} />);
    fireEvent.click(screen.getByTestId('pm-btn-last-page'));
    expect(screen.getByTestId('pm-page-indicator').textContent).toContain('Pág 5 de 5');
    act(() => {
      rerender(<PrefixManager nodes={accounts.slice(0, 75)} />);
    });
    expect(screen.getByTestId('pm-page-indicator').textContent).toContain('Pág 3 de 3');
    fireEvent.click(screen.getByTestId('pm-btn-prev-page'));
    expect(screen.getByTestId('pm-page-indicator').textContent).toContain('Pág 2 de 3');
    act(() => {
      rerender(<PrefixManager nodes={accounts.slice(0, 10)} />);
    });
    act(() => {
      rerender(<PrefixManager nodes={accounts} />);
    });
    expect(screen.getByTestId('pm-page-indicator').textContent).toContain('Pág 1 de 5');
  });

  it('supports pagination controls and showing all items at once', () => {
    // Generar 35 cuentas mock para probar la paginación
    const manyNodes = Array.from({ length: 35 }, (_, i) => ({
      id: `acc_${i + 1}`,
      data: {
        fileName: `antigravity-account-${i + 1}.json`,
        email: `user${i + 1}@gmail.com`,
        prefix: `agy_${i + 1}`,
        provider: 'antigravity',
      },
    }));

    render(<PrefixManager nodes={manyNodes} />);

    // Por defecto el pageSize es 25: deben haber 25 filas en pantalla
    expect(screen.getByTestId('pm-page-indicator').textContent).toContain('Pág 1 de 2');
    expect(screen.getByText('user1@gmail.com')).toBeTruthy();
    expect(screen.getByText('user25@gmail.com')).toBeTruthy();
    expect(screen.queryByText('user26@gmail.com')).toBeNull();

    // Navegar a la página siguiente
    fireEvent.click(screen.getByTestId('pm-btn-next-page'));
    expect(screen.getByTestId('pm-page-indicator').textContent).toContain('Pág 2 de 2');
    expect(screen.queryByText('user1@gmail.com')).toBeNull();
    expect(screen.getByText('user26@gmail.com')).toBeTruthy();
    expect(screen.getByText('user35@gmail.com')).toBeTruthy();

    // Cambiar selector a "Ver todo"
    const select = screen.getByTestId('pm-page-size-select');
    fireEvent.change(select, { target: { value: '0' } });

    // Ahora todas las 35 cuentas deben estar visibles
    expect(screen.getByText('user1@gmail.com')).toBeTruthy();
    expect(screen.getByText('user35@gmail.com')).toBeTruthy();
    expect(screen.queryByTestId('pm-page-indicator')).toBeNull(); // Se oculta el paginador si es 1 página / ver todo
  });
});
