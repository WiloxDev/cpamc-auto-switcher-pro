import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import LicenseModal from './LicenseModal';

describe('LicenseModal Component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn().mockImplementation((url) => {
      if (url.includes('/status')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              machine_id: 'CPA-1111-2222-3333',
              status: 'trial',
              days_remaining: 29,
              tier: 'DEMO (30 DÍAS)',
              can_rotate: true,
            }),
        });
      }
      if (url.includes('/activate')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              success: true,
              message: 'Licencia activada con éxito',
              license: {
                machine_id: 'CPA-1111-2222-3333',
                status: 'active',
                days_remaining: 365,
                tier: 'PRO',
                can_rotate: true,
              },
            }),
        });
      }
      return Promise.resolve({ ok: false });
    });
  });

  it('renders correctly when open and loads status', async () => {
    render(<LicenseModal isOpen={true} onClose={vi.fn()} />);

    expect(screen.getByText(/Licencia Comunitaria 100% Libre & Gratuita/i)).toBeTruthy();

    await waitFor(() => {
      expect(screen.getByText('CPA-1111-2222-3333')).toBeTruthy();
      expect(screen.getByText('29')).toBeTruthy();
    });
  });

  it('allows activating with key and updates state', async () => {
    render(<LicenseModal isOpen={true} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('CPA-1111-2222-3333')).toBeTruthy();
    });

    const input = screen.getByPlaceholderText(/Pega aquí la clave/i);
    fireEvent.change(input, { target: { value: 'test.signed.key' } });

    const btnActivate = screen.getByRole('button', { name: /Activar Licencia/i });
    fireEvent.click(btnActivate);

    await waitFor(() => {
      expect(screen.getByText(/Licencia activada con éxito/i)).toBeTruthy();
    });
  });
});
