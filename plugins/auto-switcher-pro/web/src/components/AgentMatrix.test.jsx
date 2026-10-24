import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import AgentMatrix from './AgentMatrix';
import * as managementClient from '../api/managementClient';

describe('AgentMatrix Component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders loading state initially and then displays orchestrators, subagents, and clarity badges', async () => {
    vi.spyOn(managementClient, 'fetchAgentMatrix').mockResolvedValue({
      ok: true,
      jok3r_detected: true,
      available_pools: ['Pool-01-gemini', 'Pool-03-codex', 'Pool-04-claude'],
      pool_capabilities: {
        'Pool-01-gemini': true,
        'Pool-03-codex': false,
        'Pool-04-claude': true,
      },
      pool_details: {
        'Pool-01-gemini': {
          id: 'Pool-01-gemini',
          target_model: 'gemini-3.8-flash-high',
          leader_email: 'antigravity-master1@gmail.com',
          total_members: 4,
          reserves_count: 3,
        },
        'Pool-03-codex': {
          id: 'Pool-03-codex',
          target_model: 'gpt-4o',
          leader_email: 'codex-master.json',
          total_members: 2,
          reserves_count: 1,
        },
        'Pool-04-claude': {
          id: 'Pool-04-claude',
          target_model: 'claude-sonnet-4-6',
          leader_email: 'antigravity-claude@gmail.com',
          total_members: 4,
          reserves_count: 3,
        },
      },
      gentle_agents: [
        {
          universe: 'gentle_ai',
          agent_id: 'orchestrator',
          displayName: '👑 ORQUESTADOR GENTLE',
          is_orchestrator: true,
          primary_pool: 'Pool-04-claude',
          fallback_pool: 'Pool-01-gemini',
          thinking_level: 'high',
          description: 'Cerebro senior de Gentle-AI',
        },
        {
          universe: 'gentle_ai',
          agent_id: 'gentle-ai-worker',
          displayName: '🛠️ gentle-ai-worker',
          is_orchestrator: false,
          primary_pool: 'Pool-03-codex', // Non-reasoning pool
          fallback_pool: 'Pool-01-gemini',
          thinking_level: 'none',
          concurrency: 1,
          auto_downgrade: true,
          description: 'Implementador fullstack',
        },
      ],
      jok3r_agents: [
        {
          universe: 'jok3r_pi',
          agent_id: 'orchestrator',
          displayName: '👑 ORQUESTADOR J0K3R',
          is_orchestrator: true,
          primary_pool: 'Pool-04-claude',
          fallback_pool: 'Pool-01-gemini',
          thinking_level: 'high',
          description: 'Cerebro de j0k3r-pi',
        },
      ],
    });

    render(<AgentMatrix />);

    await waitFor(() => {
      expect(screen.getByText('Matriz de Agentes & Orquestación')).toBeDefined();
    });

    // 1. Check Orchestrator and Agent Rendering
    expect(screen.getByText('👑 ORQUESTADOR GENTLE')).toBeDefined();
    expect(screen.getByText('👑 ORQUESTADOR J0K3R')).toBeDefined();
    expect(screen.getByText('🛠️ gentle-ai-worker')).toBeDefined();

    // 2. Check Dynamic Harness clarity badges
    expect(screen.getByText('GENTLE-SHELL CLI')).toBeDefined();
    expect(screen.getByText(/Terminal CLI Soberana/i)).toBeDefined();

    // 3. Columns in primary table view: ROL/AGENTE, PRIMARIO, THINKING, TEST
    expect(screen.getAllByText('Misión en el ciclo').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Ruta activa de ejecución').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Nivel de razonamiento').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Sonda de red y token').length).toBeGreaterThan(0);

    // 4. Check Non-reasoning Thinking N/A Badge
    expect(screen.getByText('🚫 N/A')).toBeDefined();

    // 5. Check Dry-Run Ping button existence
    expect(screen.getAllByText('⚡ Test').length).toBeGreaterThan(0);

    // 6. Check Token Burn Gauge & Stress Semaphore
    const gauge = screen.getByTestId('token-burn-gauge');
    expect(gauge).toBeDefined();
    expect(screen.getByText(/Autonomía estimada:/i)).toBeDefined();

    // 7. Check Warmup Triage button
    expect(screen.getByText('Warmup Triage')).toBeDefined();

    // 8. Agnostic Architecture: Claude-centric fixed headers are ELIMINATED from the universal table
    expect(screen.queryByText('AUTO-DOWNGRADE')).toBeNull();
    expect(screen.queryByText('TOPE BUCLE (CLAUDE)')).toBeNull();

    // 9. Clicking an agent row opens the accordion displaying SECUNDARIO & Read-only CONCURRENCY
    const gentleRowCell = screen.getByText('👑 ORQUESTADOR GENTLE').closest('td');
    fireEvent.click(gentleRowCell);

    await waitFor(() => {
      expect(screen.getAllByText(/SECUNDARIO/i).length).toBeGreaterThan(0);
      expect(screen.getAllByText(/Autocubierto en Pool/i).length).toBeGreaterThan(0);
      expect(screen.getAllByText(/CONCURRENCIA/i).length).toBeGreaterThan(0);
      expect(screen.getAllByText(/1 tarea/i).length).toBeGreaterThan(0);
      expect(screen.getAllByText(/Líder/i).length).toBeGreaterThan(0);
    });

    // 10. Check Global Preset Buttons (Seguro, Pro, Turbo)
    expect(screen.getByText('🛡️ Seguro')).toBeDefined();
    expect(screen.getByText('⚡ Pro')).toBeDefined();
    expect(screen.getByText('🚀 Turbo')).toBeDefined();

    // 11. Check Harness Version Audit Accordion on header click
    vi.spyOn(managementClient, 'fetchHarnessVersion').mockResolvedValue({
      harness_id: 'gentle_shell',
      harness_name: 'Gentle-Shell CLI',
      local_version: '4.0.0',
      local_date: '2026-10-01',
      local_status: '🟢 Activa en host',
      npm_version: '4.3.0',
      npm_date: '2026-10-16',
      npm_status: '🚀 Disponible en npm (gentle-pi)',
      github_version: '4.3.0',
      github_commit: '195b8d9',
      github_status: '🔗 GitHub Upstream (Gentleman-Programming)',
      is_up_to_date: false,
      checked_at: '2026-10-23T22:00:00Z',
    });

    const gentleHeader = screen.getByText('GENTLE-SHELL CLI').closest('.universe-header');
    fireEvent.click(gentleHeader);

    await waitFor(() => {
      expect(screen.getByText(/Auditoría de Versión & Telemetría Upstream/i)).toBeDefined();
      expect(screen.getByText('Instalación Local (en este equipo)')).toBeDefined();
      expect(screen.getByText('Último Release Oficial (npm registry)')).toBeDefined();
      expect(screen.getByText('Rama main (GitHub upstream)')).toBeDefined();
      expect(screen.getByText('4.0.0')).toBeDefined();
      expect(screen.getAllByText('4.3.0').length).toBeGreaterThan(0);
    });
  });

  it('renders strictly Gentle-AI by default and completely hides j0k3r-pi when not detected', async () => {
    vi.spyOn(managementClient, 'fetchAgentMatrix').mockResolvedValue({
      ok: true,
      jok3r_detected: false,
      available_pools: ['Pool-01-gemini', 'Pool-04-claude'],
      pool_capabilities: {
        'Pool-01-gemini': true,
        'Pool-04-claude': true,
      },
      pool_details: {
        'Pool-01-gemini': {
          id: 'Pool-01-gemini',
          target_model: 'gemini-3.8-flash-high',
          leader_email: 'antigravity-leader@gmail.com',
          total_members: 4,
          reserves_count: 3,
        },
      },
      gentle_agents: [
        {
          universe: 'gentle_ai',
          agent_id: 'orchestrator',
          displayName: '👑 ORQUESTADOR GENTLE',
          is_orchestrator: true,
          primary_pool: 'Pool-04-claude',
          fallback_pool: 'Pool-01-gemini',
          thinking_level: 'high',
          description: 'Cerebro senior de Gentle-AI',
        },
        {
          universe: 'gentle_ai',
          agent_id: 'gentle-ai-worker',
          displayName: '🛠️ gentle-ai-worker',
          is_orchestrator: false,
          primary_pool: 'Pool-01-gemini',
          fallback_pool: 'Pool-04-claude',
          thinking_level: 'medium',
          concurrency: 1,
          description: 'Implementador',
        },
      ],
      jok3r_agents: [],
    });

    render(<AgentMatrix />);

    await waitFor(() => {
      expect(screen.getByText('Matriz de Agentes & Orquestación')).toBeDefined();
    });

    // 1. Gentle-AI / Gentle-Shell must be displayed
    expect(screen.getByText('👑 ORQUESTADOR GENTLE')).toBeDefined();
    expect(screen.getByText('🛠️ gentle-ai-worker')).toBeDefined();
    expect(screen.getByText('GENTLE-SHELL CLI')).toBeDefined();

    // 2. j0k3r-pi MUST NOT be displayed in tabs or body
    expect(screen.queryByText('👑 ORQUESTADOR J0K3R')).toBeNull();
    expect(screen.queryByText('UNIVERSO J0K3R-PI')).toBeNull();
    expect(screen.queryByText('⚡ j0k3r-pi')).toBeNull();
    expect(screen.queryByText('Vista Global Completa')).toBeNull();

    // 3. Single active universe badge must be visible with detected agent count
    expect(screen.getAllByText(/Gentle-Shell CLI/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/1 agentes detectados en disco/i)).toBeDefined();
  });

  it('respeta las variaciones de pool por agente y ejecuta testAgentRoute con el pool dinámico seleccionado (no hardcodeado)', async () => {
    vi.spyOn(managementClient, 'fetchAgentMatrix').mockResolvedValue({
      ok: true,
      jok3r_detected: false,
      available_pools: ['Pool-01-gemini', 'Pool-03-codex', 'Pool-04-claude'],
      pool_capabilities: {
        'Pool-01-gemini': true,
        'Pool-03-codex': false,
        'Pool-04-claude': true,
      },
      pool_details: {
        'Pool-01-gemini': {
          id: 'Pool-01-gemini',
          target_model: 'gemini-3.8-flash-high',
          leader_email: 'antigravity-gemini@gmail.com',
          total_members: 4,
          reserves_count: 3,
        },
        'Pool-03-codex': {
          id: 'Pool-03-codex',
          target_model: 'gpt-4o',
          leader_email: 'codex-master.json',
          total_members: 2,
          reserves_count: 1,
        },
        'Pool-04-claude': {
          id: 'Pool-04-claude',
          target_model: 'claude-sonnet-4-6',
          leader_email: 'antigravity-claude@gmail.com',
          total_members: 4,
          reserves_count: 3,
        },
      },
      gentle_agents: [
        {
          universe: 'gentle_ai',
          agent_id: 'orchestrator',
          displayName: '👑 ORQUESTADOR GENTLE',
          is_orchestrator: true,
          primary_pool: 'Pool-01-gemini',
          fallback_pool: 'Pool-04-claude',
          thinking_level: 'medium',
          description: 'Cerebro senior de Gentle-AI',
        },
        {
          universe: 'gentle_ai',
          agent_id: 'gentle-ai-worker',
          displayName: '🛠️ gentle-ai-worker',
          is_orchestrator: false,
          primary_pool: 'Pool-01-gemini',
          fallback_pool: 'Pool-04-claude',
          thinking_level: 'medium',
          concurrency: 1,
          description: 'Implementador',
        },
      ],
      jok3r_agents: [],
    });

    const spyPing = vi.spyOn(managementClient, 'testAgentRoute').mockResolvedValue({
      ok: true,
      pool_id: 'Pool-04-claude',
      latency_ms: 38,
      account_email: 'antigravity-claude@gmail.com',
    });

    render(<AgentMatrix />);

    await waitFor(() => {
      expect(screen.getByText('Matriz de Agentes & Orquestación')).toBeDefined();
    });

    // Cambiamos el selector del worker a 'Pool-04-claude'
    const selects = screen.getAllByRole('combobox');
    // selects[0] = orchestrator primary, selects[1] = worker primary (los pools usan badge de autocubierto)
    fireEvent.change(selects[1], { target: { value: 'Pool-04-claude' } });

    // Hacemos clic en el botón Test del worker (segundo botón de test)
    const testBtns = screen.getAllByTitle('Test rápido de conectividad y latencia con el líder del pool');
    fireEvent.click(testBtns[1]);

    // Verificamos que testAgentRoute se llamó con el pool y modelo dinámicos seleccionados
    await waitFor(() => {
      expect(spyPing).toHaveBeenCalledWith('Pool-04-claude', 'claude-sonnet-4-6');
    });

    // Verificamos que en la fila del agente aparece el resultado del test con el pool y cuenta dinámicos
    await waitFor(() => {
      expect(screen.getByText(/antigravity-claude@gmail.com/i)).toBeDefined();
    });
  });

  it('permite cambiar estrategias globales de concurrencia protegiendo siempre a los agentes de escritura en 1', async () => {
    vi.spyOn(managementClient, 'fetchAgentMatrix').mockResolvedValue({
      ok: true,
      jok3r_detected: true,
      available_pools: ['Pool-01-gemini', 'Pool-04-claude'],
      pool_capabilities: {
        'Pool-01-gemini': true,
        'Pool-04-claude': true,
      },
      pool_details: {
        'Pool-01-gemini': { id: 'Pool-01-gemini', target_model: 'gemini-3.8-flash-high', leader_email: 'gem@gmail.com', total_members: 2, reserves_count: 1 },
      },
      gentle_agents: [
        {
          universe: 'gentle_ai',
          agent_id: 'gentle-ai-worker',
          displayName: '🛠️ gentle-ai-worker',
          is_orchestrator: false,
          role_type: 'apply',
          primary_pool: 'Pool-01-gemini',
          fallback_pool: 'Pool-01-gemini',
          concurrency: 1,
        },
        {
          universe: 'gentle_ai',
          agent_id: 'gentle-ai-explore',
          displayName: '🔍 gentle-ai-explore',
          is_orchestrator: false,
          role_type: 'discovery',
          primary_pool: 'Pool-01-gemini',
          fallback_pool: 'Pool-01-gemini',
          concurrency: 1,
        },
      ],
      jok3r_agents: [],
    });

    render(<AgentMatrix />);

    await waitFor(() => {
      expect(screen.getByText('Matriz de Agentes & Orquestación')).toBeDefined();
    });

    // Abrir acordeón de gentle-ai-worker haciendo clic en su celda
    const workerCell = screen.getByText('🛠️ gentle-ai-worker').closest('td');
    fireEvent.click(workerCell);

    // Worker debe mostrar candado de seguridad (1 tarea fija) en su acordeón
    await waitFor(() => {
      expect(screen.getByText('Seguro')).toBeDefined();
      expect(screen.getByText('Edición secuencial anti-corrupción')).toBeDefined();
    });

    const turboBtn = screen.getByText('🚀 Turbo');
    fireEvent.click(turboBtn);

    // Tras activar turbo, worker sigue protegido en 1 tarea (Seguro)
    expect(screen.getByText('Seguro')).toBeDefined();
    expect(screen.getByText(/🚀 Modo Turbo activado/i)).toBeDefined();
  });

  it('elimina sesgo de Claude: tabla con 6 columnas universales y protector contextual solo cuando el agente usa Claude', async () => {
    vi.spyOn(managementClient, 'fetchAgentMatrix').mockResolvedValue({
      ok: true,
      jok3r_detected: false,
      available_pools: ['Pool-01-gemini', 'Pool-04-claude'],
      pool_capabilities: {
        'Pool-01-gemini': true,
        'Pool-04-claude': true,
      },
      pool_details: {
        'Pool-01-gemini': { id: 'Pool-01-gemini', target_model: 'gemini-3.8-flash-high', leader_email: 'gem@gmail.com', total_members: 2, reserves_count: 1 },
        'Pool-04-claude': { id: 'Pool-04-claude', target_model: 'claude-sonnet-4-6', leader_email: 'clau@gmail.com', total_members: 2, reserves_count: 1 },
      },
      gentle_agents: [
        {
          universe: 'gentle_ai',
          agent_id: 'gentle-ai-worker',
          displayName: '🛠️ gentle-ai-worker',
          is_orchestrator: false,
          role_type: 'apply',
          primary_pool: 'Pool-01-gemini', // Usando Gemini
          fallback_pool: 'Pool-01-gemini',
          concurrency: 1,
        },
      ],
      jok3r_agents: [],
    });

    render(<AgentMatrix />);

    await waitFor(() => {
      expect(screen.getByText('Matriz de Agentes & Orquestación')).toBeDefined();
    });

    // 1. Columnas estáticas de Claude NO existen
    expect(screen.queryByText('AUTO-DOWNGRADE')).toBeNull();
    expect(screen.queryByText('TOPE BUCLE (CLAUDE)')).toBeNull();

    // 2. Con Gemini, el agente no muestra selector de turnos de Claude
    expect(screen.queryByTitle(/Tope de turnos consecutivos en Claude/i)).toBeNull();

    // 3. Cambiamos el worker a Claude
    const workerSelect = screen.getAllByRole('combobox')[0]; // primer select en subagents
    fireEvent.change(workerSelect, { target: { value: 'Pool-04-claude' } });

    // 4. Ahora aparece el protector contextual de cuota exclusivo para Claude
    await waitFor(() => {
      expect(screen.getAllByTitle(/Protector de cuota Claude/i).length).toBeGreaterThan(0);
      expect(screen.getByText('Freno Anti-Bucle:')).toBeDefined();
    });
  });

  it('renders dynamic thinking levels according to selected model and provider capabilities', async () => {
    vi.spyOn(managementClient, 'fetchAgentMatrix').mockResolvedValue({
      ok: true,
      jok3r_detected: true,
      available_pools: ['Pool-01-gemini', 'Pool-03-codex'],
      pool_capabilities: {
        'Pool-01-gemini': true,
        'Pool-03-codex': false,
      },
      model_thinking_levels: {
        'Pool-01-gemini': ['low', 'medium', 'high', 'xhigh'],
        'Pool-03-codex': [],
        'openai/gpt-6-luna': ['minimal', 'low', 'medium', 'high', 'max'],
        'openai/o3-mini': ['low', 'medium', 'high'],
      },
      pool_details: {
        'Pool-01-gemini': { id: 'Pool-01-gemini', target_model: 'gemini-3.8-flash-high' },
        'Pool-03-codex': { id: 'Pool-03-codex', target_model: 'gpt-4o' },
      },
      upstream_models: [
        {
          id: 'openai/gpt-6-luna',
          provider: 'openai',
          display_name: 'GPT-6 Luna (OPENAI)',
          supports_thinking: true,
          thinking_levels: ['minimal', 'low', 'medium', 'high', 'max'],
        },
        {
          id: 'openai/o3-mini',
          provider: 'openai',
          display_name: 'o3-mini (OPENAI)',
          supports_thinking: true,
          thinking_levels: ['low', 'medium', 'high'],
        },
      ],
      gentle_agents: [
        {
          universe: 'gentle_shell',
          agent_id: 'orchestrator',
          displayName: '👑 ORQUESTADOR GENTLE',
          is_orchestrator: true,
          primary_pool: 'Pool-01-gemini', // 4 levels
          fallback_pool: 'Pool-03-codex',
          thinking_level: 'high',
        },
        {
          universe: 'gentle_shell',
          agent_id: '02-apply',
          displayName: '⚡ 02-apply',
          role_type: 'apply',
          primary_pool: 'Pool-03-codex', // Non-reasoning (0 levels)
          fallback_pool: 'Pool-01-gemini',
          thinking_level: 'none',
          concurrency: 1,
        },
        {
          universe: 'gentle_shell',
          agent_id: '01-planning',
          displayName: '📐 01-planning',
          role_type: 'planning',
          primary_pool: 'openai/gpt-6-luna', // 5 levels
          fallback_pool: 'Pool-01-gemini',
          thinking_level: 'medium',
          concurrency: 1,
        },
      ],
      jok3r_agents: [],
    });

    render(<AgentMatrix />);

    await waitFor(() => {
      expect(screen.getByText('Matriz de Agentes & Orquestación')).toBeDefined();
    });

    // 1. Non-reasoning model (Pool-03-codex) renders N/A badge
    expect(screen.getByText('🚫 N/A')).toBeDefined();

    // 2. Gemini model (Pool-01-gemini) renders 4 levels: L, M, H, XH in table
    expect(screen.getByTitle('X-High (Muy Alto)')).toBeDefined();

    // 3. 5-level model (GPT-6 Luna) renders MIN, L, M, H, MAX in table
    expect(screen.getByTitle('Minimal (Mínimo)')).toBeDefined();
    expect(screen.getByTitle('Max (Máximo)')).toBeDefined();
  });

  it('reporta estado Standby cuando no hay tráfico registrado (instalación limpia)', async () => {
    vi.spyOn(managementClient, 'fetchAgentMatrix').mockResolvedValue({
      ok: true,
      jok3r_detected: false,
      available_pools: ['Pool-01-gemini', 'Pool-04-claude'],
      pool_capabilities: { 'Pool-01-gemini': true, 'Pool-04-claude': true },
      pool_details: {
        'Pool-04-claude': { id: 'Pool-04-claude', target_model: 'claude-sonnet-4-6', total_members: 4, reserves_count: 3 },
      },
      gentle_agents: [
        {
          universe: 'gentle_ai',
          agent_id: 'orchestrator',
          displayName: '👑 ORQUESTADOR GENTLE',
          is_orchestrator: true,
          primary_pool: 'Pool-04-claude',
          thinking_level: 'high',
          concurrency: 1,
        },
      ],
      total_requests: 0,
    });

    render(<AgentMatrix />);

    await waitFor(() => {
      expect(screen.getByText('Matriz de Agentes & Orquestación')).toBeDefined();
    });

    expect(screen.getByText(/Modo Standby \/ Sin Tráfico/i)).toBeDefined();
    expect(screen.getByText(/En espera de ejecuciones/i)).toBeDefined();
    expect(screen.queryByText(/Estrés Crítico de Cuota/i)).toBeNull();
  });
});
