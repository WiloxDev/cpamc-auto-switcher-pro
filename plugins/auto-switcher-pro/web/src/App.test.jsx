import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import App from './App';
import * as managementClient from './api/managementClient';

// Mock resize observer for JSDOM
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

describe('App Host Component Integration', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders unauthenticated warning when management key is missing', async () => {
    vi.spyOn(managementClient, 'getManagementKey').mockReturnValue('');

    render(<App />);

    expect(await screen.findByTestId('status-unauthenticated')).toBeTruthy();
    expect(screen.getByText('Conexión con CPAMC requerida')).toBeTruthy();
    expect(screen.getByTestId('btn-retry-auth')).toBeTruthy();
    expect(screen.getByTestId('btn-load-demo')).toBeTruthy();
    expect(screen.getByTestId('input-manual-key')).toBeTruthy();
    expect(screen.getByTestId('btn-connect-manual-key')).toBeTruthy();
  });

  it('allows entering management key manually and unlocks the application', async () => {
    let mockKey = '';
    vi.spyOn(managementClient, 'getManagementKey').mockImplementation(() => mockKey);
    vi.spyOn(managementClient, 'loadAuthFilesWithPrefixes').mockImplementation(async () => {
      if (!mockKey) throw new Error('Unauthenticated');
      return [{ name: 'account-1.json', prefix: 'agy' }];
    });

    render(<App />);

    expect(await screen.findByTestId('status-unauthenticated')).toBeTruthy();

    const input = screen.getByTestId('input-manual-key');
    const connectBtn = screen.getByTestId('btn-connect-manual-key');

    // Introduce la clave y pulsa conectar
    fireEvent.change(input, { target: { value: 'custom-secret-key-456' } });
    mockKey = 'custom-secret-key-456';
    fireEvent.click(connectBtn);

    // Debe cargar los nodos y salir del estado no autenticado
    expect(await screen.findByText('agy')).toBeTruthy();
  });

  it('automatically authenticates via hardware license handshake when key is not cached', async () => {
    vi.spyOn(managementClient, 'getManagementKey').mockReturnValue('');
    const origFetch = global.fetch;
    global.fetch = vi.fn().mockImplementation(async (url) => {
      if (typeof url === 'string' && url.includes('/license/session')) {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            authorized: true,
            status: 'trial',
            management_key: 'handshake-key-789',
          }),
        };
      }
      return origFetch ? origFetch(url) : { ok: false };
    });

    vi.spyOn(managementClient, 'loadAuthFilesWithPrefixes').mockResolvedValue([
      { name: 'auto-account.json', prefix: 'agy_auto' },
    ]);

    render(<App />);

    // Verifica que entra directo sin pedir clave gracias al handshake de hardware
    expect(await screen.findByText('agy_auto')).toBeTruthy();
    expect(screen.queryByTestId('status-unauthenticated')).toBeNull();

    global.fetch = origFetch;
  });

  it('switches to offline demo graph when user clicks View Offline Demo', async () => {
    vi.spyOn(managementClient, 'getManagementKey').mockReturnValue('');

    render(<App />);

    const demoBtn = await screen.findByTestId('btn-load-demo');
    fireEvent.click(demoBtn);

    // In demo mode, allowSynthetic is true, so btn-add-root is available
    expect(await screen.findByTestId('btn-add-root')).toBeTruthy();
    expect(screen.getByText('Editor Only — Local Graph')).toBeTruthy();
  });

  it('loads real auth files into ProfileGraph when management key is present', async () => {
    vi.spyOn(managementClient, 'getManagementKey').mockReturnValue('valid-key-123');
    vi.spyOn(managementClient, 'loadAuthFilesWithPrefixes').mockResolvedValue([
      { name: 'antigravity-1.json', prefix: 'agy_p1' },
      { name: 'antigravity-2.json', prefix: 'agy_p1_1' },
    ]);

    render(<App />);

    // Wait for nodes to load into graph
    expect(await screen.findByText('agy_p1')).toBeTruthy();
    expect(screen.getByText('agy_p1_1')).toBeTruthy();

    // Verify production mode avoids arbitrary unbound synthetic nodes
    expect(screen.getByTestId('badge-live-auth')).toBeTruthy();
    expect(screen.queryByTestId('btn-add-root')).toBeNull();
    expect(screen.queryByTestId('btn-add-child')).toBeNull();

    // Header reload button is available
    expect(screen.getByTestId('btn-reload-profiles')).toBeTruthy();
  });

  it('fails closed on 404 download failure and displays sanitized error without rendering editable graph', async () => {
    vi.spyOn(managementClient, 'getManagementKey').mockReturnValue('valid-key-123');
    vi.spyOn(managementClient, 'loadAuthFilesWithPrefixes').mockRejectedValue(
      new Error('Failed to load auth file "corrupted-account.json": 404 Not Found')
    );

    render(<App />);

    expect(await screen.findByTestId('status-error')).toBeTruthy();
    expect(screen.getByText('Error al cargar perfiles')).toBeTruthy();
    expect(
      screen.getByText('Failed to load auth file "corrupted-account.json": 404 Not Found')
    ).toBeTruthy();

    // MUST NOT render ProfileGraph or any editable node
    expect(screen.queryByTestId('rf-wrapper')).toBeNull();
    expect(screen.queryByTestId('btn-add-root')).toBeNull();
    expect(screen.getByTestId('btn-retry-error')).toBeTruthy();
  });

  it('fails closed on 401 unauthorized download failure with sanitized status', async () => {
    vi.spyOn(managementClient, 'getManagementKey').mockReturnValue('valid-key-123');
    vi.spyOn(managementClient, 'loadAuthFilesWithPrefixes').mockRejectedValue(
      new Error('Failed to load auth file "account.json": 401 Unauthorized')
    );

    render(<App />);

    expect(await screen.findByTestId('status-error')).toBeTruthy();
    expect(screen.getByText('Error al cargar perfiles')).toBeTruthy();
    expect(
      screen.getByText('Failed to load auth file "account.json": 401 Unauthorized')
    ).toBeTruthy();
    expect(screen.queryByTestId('rf-wrapper')).toBeNull();
  });

  it('prompts confirmation when reloading with dirty edits and aborts if cancelled', async () => {
    vi.spyOn(managementClient, 'getManagementKey').mockReturnValue('valid-key-123');
    const loadSpy = vi.spyOn(managementClient, 'loadAuthFilesWithPrefixes').mockResolvedValue([
      { name: 'acc1.json', prefix: 'agy_p1' },
    ]);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    render(<App />);

    expect(await screen.findByText('agy_p1')).toBeTruthy();
    expect(loadSpy).toHaveBeenCalledTimes(1);

    // Make node dirty via inline edit
    fireEvent.click(screen.getByTestId('btn-edit-prefix-acc1.json'));
    const input = screen.getByTestId('input-prefix-acc1.json');
    fireEvent.change(input, { target: { value: 'custom_dirty_val' } });
    fireEvent.click(screen.getByTestId('btn-save-prefix-acc1.json'));
    expect(screen.getByText('custom_dirty_val')).toBeTruthy();

    // Click Reload button: confirm prompt appears and returns false
    const reloadBtn = screen.getByTestId('btn-reload-profiles');
    fireEvent.click(reloadBtn);

    expect(confirmSpy).toHaveBeenCalled();
    // loadAuthFilesWithPrefixes must NOT be called again
    expect(loadSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByText('custom_dirty_val')).toBeTruthy();

    // Now confirm reload
    confirmSpy.mockReturnValue(true);
    await act(async () => {
      fireEvent.click(reloadBtn);
    });

    expect(loadSpy).toHaveBeenCalledTimes(2);
  });

  it('renders Auto Switcher Pro brand and switches to Pulso Tokens tab', async () => {
    vi.spyOn(managementClient, 'getManagementKey').mockReturnValue('valid-key-123');
    vi.spyOn(managementClient, 'loadAuthFilesWithPrefixes').mockResolvedValue([]);

    render(<App />);

    expect(await screen.findByText('AUTO SWITCHER PRO')).toBeTruthy();
    const tokensTab = screen.getByTestId('tab-pulse-tokens');
    expect(tokensTab).toBeTruthy();

    fireEvent.click(tokensTab);

    // After clicking Pulso Tokens, view is rendered (header is hidden on submenus)
    expect(await screen.findByTestId('pulse-tokens-view')).toBeTruthy();
  });

  it('renders high-visibility action buttons on the right side of the header', async () => {
    vi.spyOn(managementClient, 'getManagementKey').mockReturnValue('valid-key-123');
    vi.spyOn(managementClient, 'loadAuthFilesWithPrefixes').mockResolvedValue([]);

    render(<App />);

    const manageBtn = await screen.findByTestId('btn-header-manage-prefixes');
    expect(manageBtn).toBeTruthy();
    expect(manageBtn.textContent).toContain('Directorio');

    const createBtn = screen.getByTestId('btn-header-create-group');
    expect(createBtn).toBeTruthy();
    expect(createBtn.textContent).toContain('Crear Grupo / Pool / Perfiles');

    const forceBtn = screen.getByTestId('btn-header-force-check');
    expect(forceBtn).toBeTruthy();
    expect(forceBtn.textContent).toContain('Chequeo Forzado');
  });

  it('switches to Crear Group/Perfiles tab and renders GroupManager view', async () => {
    vi.spyOn(managementClient, 'getManagementKey').mockReturnValue('valid-key-123');
    vi.spyOn(managementClient, 'loadAuthFilesWithPrefixes').mockResolvedValue([]);

    render(<App />);

    const groupTab = await screen.findByTestId('tab-create-groups');
    expect(groupTab).toBeTruthy();

    fireEvent.click(groupTab);

    expect(await screen.findByTestId('group-manager-view')).toBeTruthy();
  });

  it('switches to Auto Auth Files tab and renders AutoAuthFiles view', async () => {
    vi.spyOn(managementClient, 'getManagementKey').mockReturnValue('valid-key-123');
    vi.spyOn(managementClient, 'loadAuthFilesWithPrefixes').mockResolvedValue([]);

    render(<App />);

    const autoAuthTab = await screen.findByTestId('tab-auto-auth-files');
    expect(autoAuthTab).toBeTruthy();

    fireEvent.click(autoAuthTab);

    expect(await screen.findByTestId('auto-auth-files-view')).toBeTruthy();
  });

  describe('MINI-002: Startup Cooldown & Background Auto-Update Orchestration', () => {
    beforeEach(() => {
      window.localStorage.clear();
    });

    it('does not call scanSystemHealth or updateManagementConsole if auto_update_console_on_boot is "false"', async () => {
      window.localStorage.setItem('auto_update_console_on_boot', 'false');
      vi.spyOn(managementClient, 'getManagementKey').mockReturnValue('valid-key-123');
      vi.spyOn(managementClient, 'loadAuthFilesWithPrefixes').mockResolvedValue([]);
      const scanSpy = vi.spyOn(managementClient, 'scanSystemHealth');
      const updateSpy = vi.spyOn(managementClient, 'updateManagementConsole');

      render(<App />);

      await screen.findByTestId('btn-reload-profiles');
      expect(scanSpy).not.toHaveBeenCalled();
      expect(updateSpy).not.toHaveBeenCalled();
    });

    it('does not call scanSystemHealth or updateManagementConsole if last check occurred within 6 hours', async () => {
      const recentTs = (Date.now() - 3600 * 1000).toString();
      window.localStorage.setItem('last_console_check_ts', recentTs);
      vi.spyOn(managementClient, 'getManagementKey').mockReturnValue('valid-key-123');
      vi.spyOn(managementClient, 'loadAuthFilesWithPrefixes').mockResolvedValue([]);
      const scanSpy = vi.spyOn(managementClient, 'scanSystemHealth');
      const updateSpy = vi.spyOn(managementClient, 'updateManagementConsole');

      render(<App />);

      await screen.findByTestId('btn-reload-profiles');
      expect(scanSpy).not.toHaveBeenCalled();
      expect(updateSpy).not.toHaveBeenCalled();
    });

    it('calls scanSystemHealth and updateManagementConsole when preference is enabled and cooldown elapsed, updating last_console_check_ts', async () => {
      const oldTs = (Date.now() - 7 * 3600 * 1000).toString();
      window.localStorage.setItem('last_console_check_ts', oldTs);
      vi.spyOn(managementClient, 'getManagementKey').mockReturnValue('valid-key-123');
      vi.spyOn(managementClient, 'loadAuthFilesWithPrefixes').mockResolvedValue([]);
      const scanSpy = vi.spyOn(managementClient, 'scanSystemHealth').mockResolvedValue({
        ok: true,
        console_update_available: true,
        console_latest_github: 'v1.28.0',
      });
      const updateSpy = vi.spyOn(managementClient, 'updateManagementConsole').mockResolvedValue({ ok: true });

      render(<App />);

      await waitFor(() => {
        expect(scanSpy).toHaveBeenCalledTimes(1);
        expect(updateSpy).toHaveBeenCalledTimes(1);
      });

      const updatedTs = Number(window.localStorage.getItem('last_console_check_ts'));
      expect(updatedTs).toBeGreaterThan(Number(oldTs));
    });

    it('does not break app status or throw if background scan fails with an exception', async () => {
      vi.spyOn(managementClient, 'getManagementKey').mockReturnValue('valid-key-123');
      vi.spyOn(managementClient, 'loadAuthFilesWithPrefixes').mockResolvedValue([
        { name: 'antigravity-1.json', prefix: 'agy_p1' },
      ]);
      vi.spyOn(managementClient, 'scanSystemHealth').mockRejectedValue(new Error('Network error or rate limit'));

      render(<App />);

      expect(await screen.findByText('agy_p1')).toBeTruthy();
      expect(screen.queryByTestId('status-error')).toBeNull();
    });
  });

  describe('MINI-003: 12-Second Auto-Dismissing Toast Notification', () => {
    beforeEach(() => {
      window.localStorage.clear();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('displays toast with exact message and target version, and dismisses immediately on manual close click', async () => {
      vi.spyOn(managementClient, 'getManagementKey').mockReturnValue('valid-key-123');
      vi.spyOn(managementClient, 'loadAuthFilesWithPrefixes').mockResolvedValue([]);
      vi.spyOn(managementClient, 'scanSystemHealth').mockResolvedValue({
        ok: true,
        console_update_available: true,
        console_latest_github: 'v1.28.0',
      });
      vi.spyOn(managementClient, 'updateManagementConsole').mockResolvedValue({ ok: true });

      render(<App />);

      const toast = await screen.findByTestId('toast-auto-update-console');
      expect(toast).toBeTruthy();
      expect(toast.textContent).toContain(
        '⚡ AUTO SWITCHER PRO: Consola de Gestión actualizada automáticamente a la versión v1.28.0 (Oficial)'
      );

      const closeBtn = screen.getByTestId('btn-close-console-toast');
      fireEvent.click(closeBtn);

      expect(screen.queryByTestId('toast-auto-update-console')).toBeNull();
    });

    it('automatically dismisses toast notification after 12 seconds with fake timers', async () => {
      vi.useFakeTimers();
      vi.spyOn(managementClient, 'getManagementKey').mockReturnValue('valid-key-123');
      vi.spyOn(managementClient, 'loadAuthFilesWithPrefixes').mockResolvedValue([]);
      vi.spyOn(managementClient, 'scanSystemHealth').mockResolvedValue({
        ok: true,
        console_update_available: true,
        console_latest_github: 'v1.28.0',
      });
      vi.spyOn(managementClient, 'updateManagementConsole').mockResolvedValue({ ok: true });

      render(<App />);

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(screen.getByTestId('toast-auto-update-console')).toBeTruthy();

      act(() => {
        vi.advanceTimersByTime(11900);
      });
      expect(screen.getByTestId('toast-auto-update-console')).toBeTruthy();

      act(() => {
        vi.advanceTimersByTime(100);
      });
      expect(screen.queryByTestId('toast-auto-update-console')).toBeNull();
    });
  });

  describe('CommunityNoticeModal Trigger Integration on Submenu Click', () => {
    beforeEach(() => {
      window.localStorage.clear();
      vi.spyOn(managementClient, 'getManagementKey').mockReturnValue('valid-key-123');
      vi.spyOn(managementClient, 'loadAuthFilesWithPrefixes').mockResolvedValue([]);
    });

    it('renders the coffee support button in the global header and allows manual opening', async () => {
      // Si ya es supporter, no abre solo
      window.localStorage.setItem('asp_is_supporter', 'true');
      render(<App />);

      const coffeeBtn = await screen.findByTestId('btn-open-coffee-modal');
      expect(coffeeBtn).toBeTruthy();

      expect(screen.queryByTestId('community-notice-modal')).toBeNull();
      fireEvent.click(coffeeBtn);
      expect(screen.getByTestId('community-notice-modal')).toBeTruthy();
    });

    it('triggers community notice modal on submenu navigation when not supporter and not dismissed today', async () => {
      render(<App />);

      // Abre el modal al navegar/cambiar de pestaña
      const modal = await screen.findByTestId('community-notice-modal');
      expect(modal).toBeTruthy();

      // Al cerrar continuando gratis, se oculta
      fireEvent.click(screen.getByTestId('btn-free-action'));
      expect(screen.queryByTestId('community-notice-modal')).toBeNull();
    });

    it('does not trigger modal if user already marked supporter permanently', async () => {
      window.localStorage.setItem('asp_is_supporter', 'true');
      render(<App />);

      await screen.findByTestId('btn-reload-profiles');
      expect(screen.queryByTestId('community-notice-modal')).toBeNull();
    });

    it('does not trigger modal if user dismissed it for today (within 24h)', async () => {
      const tomorrow = Date.now() + 12 * 3600 * 1000;
      window.localStorage.setItem('asp_notice_dismissed_until', String(tomorrow));
      render(<App />);

      await screen.findByTestId('btn-reload-profiles');
      expect(screen.queryByTestId('community-notice-modal')).toBeNull();
    });
  });
});
