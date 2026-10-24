import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  fetchAgentMatrix,
  saveAgentMatrix,
  testAgentRoute,
  scanAgentEnvironment,
  triggerTriageWarmup,
  fetchHarnessVersion,
} from '../api/managementClient';
import './AgentMatrix.css';

const UNIVERSE_STORAGE_KEY = 'agent_matrix_active_universe';

const isWriterAgent = (agent) => {
  if (!agent) return false;
  if (agent.is_orchestrator) return true;
  const id = (agent.agent_id || '').toLowerCase();
  const role = (agent.role_type || '').toLowerCase();
  return role === 'apply' || id.includes('apply') || id.includes('worker') || id.includes('fix');
};

const getAgentHumanMeta = (agent) => {
  const id = (agent.agent_id || '').toLowerCase();
  switch (id) {
    case '00-discovery':
      return {
        badge: 'FASE 0 · LECTURA',
        badgeClass: 'badge-discovery',
        summary: 'Exploración y recolección de evidencia sin modificar código.',
      };
    case '01-planning':
      return {
        badge: 'FASE 1 · ARQUITECTURA',
        badgeClass: 'badge-planning',
        summary: 'Diseño técnico de contratos plan.md y estrategia TDD.',
      };
    case '02-apply':
      return {
        badge: 'FASE 2 · IMPLEMENTACIÓN',
        badgeClass: 'badge-apply',
        summary: 'Edición quirúrgica de código y resolución guiada de tareas.',
      };
    case '03-verify':
      return {
        badge: 'FASE 3 · AUDITORÍA',
        badgeClass: 'badge-verify',
        summary: 'Auditoría independiente con suites de pruebas y regresión.',
      };
    case 'gentle-ai-worker':
      return {
        badge: 'WORKER · EDICIÓN',
        badgeClass: 'badge-apply',
        summary: 'Implementador fullstack senior de Gentle-Shell y OpenCode.',
      };
    case 'gentle-ai-explore':
      return {
        badge: 'EXPLORADOR',
        badgeClass: 'badge-discovery',
        summary: 'Análisis previo e inspección segura de repositorios.',
      };
    case 'gentle-ai-verify':
      return {
        badge: 'VERIFICADOR',
        badgeClass: 'badge-verify',
        summary: 'Verificación técnica independiente de suites de tests.',
      };
    case 'deep-researcher':
      return {
        badge: 'RESEARCH EXTERNO',
        badgeClass: 'badge-research',
        summary: 'Investigación técnica en internet, GitHub y documentación.',
      };
    case 'news-researcher':
      return {
        badge: 'INTELIGENCIA',
        badgeClass: 'badge-news',
        summary: 'Radar de novedades y briefings tecnológicos periódicos.',
      };
    case 'tool-smoke':
      return {
        badge: 'DIAGNÓSTICO',
        badgeClass: 'badge-smoke',
        summary: 'Comprobación de herramientas y permisos del entorno.',
      };
    case 'ui-designer':
      return {
        badge: '🎨 DIRECCIÓN DE ARTE',
        badgeClass: 'badge-ui-design',
        summary: 'Arquitectura UX/UI, tokens 2027, prototipos interactivos y auditoría Afina Esto.',
      };
    default:
      return {
        badge: agent.role_type ? agent.role_type.toUpperCase() : 'AGENTE',
        badgeClass: 'badge-generic',
        summary: agent.description || 'Subagente especializado de desarrollo.',
      };
  }
};

export default function AgentMatrix() {
  const [activeUniverse, setActiveUniverse] = useState(() => {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage.getItem(UNIVERSE_STORAGE_KEY) || 'all';
    }
    return 'all';
  });

  const [harnesses, setHarnesses] = useState([]);
  const [availablePools, setAvailablePools] = useState([]);
  const [poolCapabilities, setPoolCapabilities] = useState({});
  const [modelThinkingLevels, setModelThinkingLevels] = useState({});
  const [poolDetails, setPoolDetails] = useState({});
  const [upstreamModels, setUpstreamModels] = useState([]);
  const [totalRequests, setTotalRequests] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [warming, setWarming] = useState(false);
  const [feedback, setFeedback] = useState({ text: '', type: '' });
  const [pingStates, setPingStates] = useState({});
  const [dirtyHarnesses, setDirtyHarnesses] = useState({}); // { [agentKey]: { loading: bool, latency: number, text: string, ok: bool } }
  const [expandedAgents, setExpandedAgents] = useState(() => new Set()); // Set of agentKey strings
  const [expandedHarnessVersions, setExpandedHarnessVersions] = useState(() => new Set()); // Set of harness.id
  const [harnessVersionData, setHarnessVersionData] = useState({}); // { [harnessId]: { loading, data, error } }

  const toggleHarnessVersion = async (harnessId) => {
    setExpandedHarnessVersions((prev) => {
      const next = new Set(prev);
      if (next.has(harnessId)) {
        next.delete(harnessId);
      } else {
        next.add(harnessId);
      }
      return next;
    });

    if (!harnessVersionData[harnessId]?.data && !harnessVersionData[harnessId]?.loading) {
      setHarnessVersionData((prev) => ({
        ...prev,
        [harnessId]: { loading: true, data: null, error: null },
      }));
      try {
        const ver = await fetchHarnessVersion(harnessId);
        setHarnessVersionData((prev) => ({
          ...prev,
          [harnessId]: { loading: false, data: ver, error: null },
        }));
      } catch (err) {
        setHarnessVersionData((prev) => ({
          ...prev,
          [harnessId]: { loading: false, data: null, error: err.message },
        }));
      }
    }
  };

  const toggleAgentExpanded = (agentKey) => {
    setExpandedAgents((prev) => {
      const next = new Set(prev);
      if (next.has(agentKey)) {
        next.delete(agentKey);
      } else {
        next.add(agentKey);
      }
      return next;
    });
  };

  const handleUniverseChange = (univ) => {
    setActiveUniverse(univ);
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(UNIVERSE_STORAGE_KEY, univ);
    }
  };

  const processPayload = useCallback((data) => {
    if (!data?.ok) return;

    let detected = [];
    if (Array.isArray(data.harnesses) && data.harnesses.length > 0) {
      detected = data.harnesses;
    } else {
      // Fallback: build harnesses array from legacy gentle_agents / jok3r_agents if provided
      if (data.gentle_agents && data.gentle_agents.length > 0) {
        detected.push({
          id: 'gentle_shell',
          name: 'Gentle-Shell CLI',
          icon: '📟',
          badge: '📟 Gentle-Shell Terminal CLI',
          config_path: '~/.gentle-shell/agent/profiles.json',
          subtitle: '⚡ Terminal CLI Soberana: Arnés independiente para desarrollo ágil en consola con streaming nativo.',
          agents: data.gentle_agents,
        });
      }
      if (data.jok3r_detected && data.jok3r_agents && data.jok3r_agents.length > 0) {
        detected.push({
          id: 'jok3r_pi',
          name: 'j0k3r-pi',
          icon: '⚡',
          badge: '⚡ j0k3r-pi Orchestrator',
          config_path: '~/.pi/agent-j0k3r/subagents.json',
          subtitle: '⚡ Suite Todo-en-Uno Soberana: Orquestador interactivo de terminal y escuadrón de subagentes Planned Workflow.',
          agents: data.jok3r_agents,
        });
      }
    }

    setHarnesses(detected);
    setAvailablePools(data.available_pools || []);
    setPoolCapabilities(data.pool_capabilities || {});
    setModelThinkingLevels(data.model_thinking_levels || {});
    setPoolDetails(data.pool_details || {});
    setUpstreamModels(data.upstream_models || []);
    setTotalRequests(typeof data.total_requests === 'number' ? data.total_requests : 0);

    // Ensure activeUniverse matches an available harness or 'all'
    setActiveUniverse((prev) => {
      if (detected.length === 1) {
        return detected[0].id;
      }
      if (detected.length > 1) {
        const exists = detected.some((h) => h.id === prev);
        return exists || prev === 'all' ? prev : 'all';
      }
      return 'all';
    });
  }, []);

  const loadMatrix = useCallback(async () => {
    try {
      setLoading(true);
      const data = await fetchAgentMatrix();
      processPayload(data);
    } catch (err) {
      setFeedback({ text: `Error al cargar matriz: ${err.message}`, type: 'error' });
    } finally {
      setLoading(false);
    }
  }, [processPayload]);

  useEffect(() => {
    loadMatrix();
  }, [loadMatrix]);

  const handleScanEnvironment = async () => {
    try {
      setScanning(true);
      const data = await scanAgentEnvironment();
      if (data?.ok) {
        processPayload(data);
        const count = Array.isArray(data.harnesses) ? data.harnesses.length : (data.jok3r_detected ? 2 : 1);
        const names = Array.isArray(data.harnesses) ? data.harnesses.map((h) => h.name).join(' y ') : 'Arneses activos';
        setFeedback({
          text: `✅ Entorno escaneado: ${count} arnés(es) detectado(s) (${names})`,
          type: 'success',
        });
        setTimeout(() => setFeedback({ text: '', type: '' }), 4500);
      }
    } catch (err) {
      setFeedback({ text: `Error al escanear entorno: ${err.message}`, type: 'error' });
    } finally {
      setScanning(false);
    }
  };

  const handleTriggerWarmup = async () => {
    try {
      setWarming(true);
      await triggerTriageWarmup(['Pool-01-gemini', 'Pool-04-claude']);
      setFeedback({
        text: '⚡ Shadow Warmup ejecutado: Sockets TLS y Prompt Cache precalentados',
        type: 'success',
      });
      setTimeout(() => setFeedback({ text: '', type: '' }), 4000);
    } catch (err) {
      setFeedback({ text: `Error en warmup: ${err.message}`, type: 'error' });
    } finally {
      setWarming(false);
    }
  };

  const isClaudeFamily = useCallback((poolId) => {
    if (!poolId) return false;
    const lower = poolId.toLowerCase();
    if (lower.includes('claude') || lower.includes('sonnet') || lower.includes('opus')) {
      return true;
    }
    const detail = poolDetails[poolId];
    if (detail && detail.target_model) {
      const mLower = detail.target_model.toLowerCase();
      if (mLower.includes('claude') || mLower.includes('sonnet') || mLower.includes('opus')) {
        return true;
      }
    }
    return false;
  }, [poolDetails]);

  // Resolver dinámicamente los niveles soportados por un modelo o pool
  const getThinkingLevelsForTarget = useCallback(
    (targetId) => {
      if (!targetId) return [];

      // 1. Si el backend envió directamente los niveles para este target
      if (modelThinkingLevels[targetId]) {
        return modelThinkingLevels[targetId];
      }

      // 2. Si es un pool registrado, verificar el target model del pool
      if (poolDetails[targetId]?.target_model) {
        const mod = poolDetails[targetId].target_model;
        if (modelThinkingLevels[mod]) {
          return modelThinkingLevels[mod];
        }
      }

      // 3. Si en upstreamModels viene declarada la capacidad
      const foundUp = upstreamModels.find((u) => u.id === targetId);
      if (foundUp) {
        if (foundUp.supports_thinking === false) return [];
        if (Array.isArray(foundUp.thinking_levels) && foundUp.thinking_levels.length > 0) {
          return foundUp.thinking_levels;
        }
      }

      // 4. Si poolCapabilities marcó false explícitamente
      if (poolCapabilities[targetId] === false) {
        return [];
      }

      const lower = targetId.toLowerCase();

      // Modelos explícitamente sin thinking
      if (
        lower.includes('codex') &&
        !lower.includes('sol') &&
        !lower.includes('astra') &&
        !lower.includes('luna') &&
        !lower.includes('o3') &&
        !lower.includes('o1')
      ) {
        return [];
      }
      if (
        lower.includes('gpt-4o') ||
        lower.includes('legacy') ||
        lower.includes('gpt-3.5') ||
        lower.includes('gpt-5.4') ||
        lower.includes('gpt-5.3-codex')
      ) {
        return [];
      }

      // 5 niveles: Luna, Opus, Haiku 5.5, Claude 3.7
      if (
        lower.includes('luna') ||
        lower.includes('opus') ||
        lower.includes('haiku-5-5') ||
        lower.includes('claude-3-7')
      ) {
        return ['minimal', 'low', 'medium', 'high', 'max'];
      }

      // 4 niveles: Gemini
      if (lower.includes('gemini')) {
        return ['low', 'medium', 'high', 'xhigh'];
      }

      // DeepSeek Reasoner
      if (lower.includes('deepseek-reasoner') || lower.includes('deepseek-r1') || lower.includes('deepseek-v4')) {
        return ['low', 'high', 'max'];
      }

      // 3 niveles estándar para reasoning
      if (
        lower.includes('o1') ||
        lower.includes('o3') ||
        lower.includes('o4') ||
        lower.includes('astra') ||
        lower.includes('sol') ||
        lower.includes('terra') ||
        lower.includes('sonnet') ||
        lower.includes('claude') ||
        lower.includes('gpt-5.5') ||
        lower.includes('gpt-5.6') ||
        lower.includes('gpt-6')
      ) {
        return ['low', 'medium', 'high'];
      }

      return [];
    },
    [modelThinkingLevels, poolDetails, upstreamModels, poolCapabilities]
  );

  const formatThinkingLevelBadge = (lvl) => {
    switch (lvl) {
      case 'minimal':
        return { short: 'MIN', label: 'Minimal (Mínimo)', full: 'MINIMAL' };
      case 'low':
        return { short: 'L', label: 'Low (Bajo)', full: 'LOW' };
      case 'medium':
        return { short: 'M', label: 'Medium (Medio)', full: 'MEDIUM' };
      case 'high':
        return { short: 'H', label: 'High (Alto)', full: 'HIGH' };
      case 'xhigh':
        return { short: 'XH', label: 'X-High (Muy Alto)', full: 'X-HIGH' };
      case 'max':
        return { short: 'MAX', label: 'Max (Máximo)', full: 'MAX' };
      default:
        return { short: lvl.toUpperCase().slice(0, 3), label: lvl, full: lvl.toUpperCase() };
    }
  };

  const isPoolTarget = (targetId) => {
    if (!targetId) return false;
    return availablePools.includes(targetId);
  };

  const handleApplyPreset = (preset) => {
    setHarnesses((prev) =>
      prev.map((h) => ({
        ...h,
        agents: h.agents?.map((a) => {
          if (a.is_orchestrator) return a;
          if (isWriterAgent(a)) {
            return { ...a, concurrency: 1 };
          }
          if (preset === 'safe') return { ...a, concurrency: 1 };
          if (preset === 'turbo') return { ...a, concurrency: 3 };
          // pro / balanced:
          return { ...a, concurrency: 2 };
        }),
      }))
    );
    setFeedback({
      text:
        preset === 'safe'
          ? '🛡️ Modo Seguro activado: Concurrencia en 1 tarea para todos los agentes.'
          : preset === 'turbo'
          ? '🚀 Modo Turbo activado: Exploradores y auditores a 3 tareas en ráfaga (Escritores protegidos en 1).'
          : '⚡ Modo Pro activado: Balance óptimo (Escritores en 1, Lectores en 2).',
      type: 'success',
    });
    setTimeout(() => setFeedback({ text: '', type: '' }), 4000);
  };

  const handlePoolChange = (universe, agentId, field, value) => {
    setDirtyHarnesses((prev) => ({ ...prev, [universe]: true }));
    setHarnesses((prev) =>
      prev.map((h) => {
        if (h.id !== universe) return h;
        const updatedAgents = h.agents.map((a) => {
          if (a.agent_id !== agentId) return a;
          const updated = { ...a, [field]: value };

          // Cascada y Exclusión Mutua por Fila
          if (field === 'primary_pool') {
            // 1. Dynamic thinking capability and levels sync
            const suppLevels = getThinkingLevelsForTarget(value);
            if (!suppLevels || suppLevels.length === 0) {
              updated.thinking_level = 'none';
            } else if (updated.thinking_level === 'none' || !updated.thinking_level) {
              updated.thinking_level = 'medium';
            } else if (!suppLevels.includes(updated.thinking_level)) {
              updated.thinking_level = suppLevels.includes('medium') ? 'medium' : suppLevels[suppLevels.length - 1];
            }

            // 2. Si el nuevo primario colisiona con el rescate actual, reasignar el rescate automáticamente
            if (updated.fallback_pool === value) {
              // Obtener todos los candidatos disponibles
              const allCandidates = [
                ...availablePools,
                ...upstreamModels.map((u) => u.id),
              ];
              // Elige el primer candidato que sea diferente al nuevo primario
              const alternative = allCandidates.find((c) => c !== value);
              updated.fallback_pool = alternative || '';
            }
          } else if (field === 'fallback_pool') {
            // Si intenta elegir el mismo que el primario, revertir o bloquear
            if (value === updated.primary_pool) {
              const allCandidates = [
                ...availablePools,
                ...upstreamModels.map((u) => u.id),
              ];
              const alternative = allCandidates.find((c) => c !== updated.primary_pool);
              updated.fallback_pool = alternative || '';
            }
          }

          return updated;
        });
        return { ...h, agents: updatedAgents };
      })
    );
  };

  const handleTestRoute = async (agent, harnessId) => {
    const agentKey = `${harnessId || agent.universe}_${agent.agent_id}`;
    setPingStates((prev) => ({
      ...prev,
      [agentKey]: { loading: true, latency: 0, text: 'Verificando...', ok: true },
    }));

    try {
      const res = await testAgentRoute(agent.primary_pool, poolDetails[agent.primary_pool]?.target_model);
      setPingStates((prev) => ({
        ...prev,
        [agentKey]: {
          loading: false,
          latency: res.latency_ms,
          text: `⚡ OK (${res.latency_ms}ms) · ${res.pool_id || agent.primary_pool} · ${res.account_email}`,
          ok: true,
        },
      }));
    } catch (err) {
      setPingStates((prev) => ({
        ...prev,
        [agentKey]: {
          loading: false,
          latency: 0,
          text: `❌ Fallo: ${err.message || 'Error'}`,
          ok: false,
        },
      }));
    }
  };

  const handleSaveHarness = async (harnessId) => {
    const harness = harnesses.find((h) => h.id === harnessId);
    if (!harness) return;
    try {
      setSaving(true);
      const agentsToSave = (harness.agents || []).map((a) => ({
        ...a,
        universe: harness.id,
      }));
      const res = await saveAgentMatrix(agentsToSave);
      setDirtyHarnesses((prev) => ({ ...prev, [harnessId]: false }));
      setFeedback({
        text: `✓ ${harness.name}: ${res?.message || 'Guardado exitosamente en disco'}`,
        type: 'success',
      });
      setTimeout(() => setFeedback({ text: '', type: '' }), 5000);
    } catch (err) {
      setFeedback({ text: `Error al guardar ${harness.name}: ${err.message}`, type: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const handleSave = async () => {
    try {
      setSaving(true);
      const allAgents = harnesses.flatMap((h) =>
        (h.agents || []).map((a) => ({
          ...a,
          universe: h.id, // Normalización quirúrgica: previene fragmentación en SQLite
        }))
      );
      const res = await saveAgentMatrix(allAgents);
      setDirtyHarnesses({});
      setFeedback({ text: res?.message || 'Matriz guardada y sincronizada con éxito en disco', type: 'success' });
      setTimeout(() => setFeedback({ text: '', type: '' }), 5000);
    } catch (err) {
      setFeedback({ text: `Error al guardar: ${err.message}`, type: 'error' });
    } finally {
      setSaving(false);
    }
  };

  // Semáforo de Estrés de Cuota ("Token Burn Gauge")
  const stress = useMemo(() => {
    let claudePressure = 0;
    for (const h of harnesses) {
      for (const a of h.agents || []) {
        const isClaude = (a.primary_pool || '').toLowerCase().includes('claude') || (a.primary_pool || '').toLowerCase().includes('sonnet');
        const thinkWeight = a.thinking_level === 'high' ? 3 : (a.thinking_level === 'medium' ? 2 : (a.thinking_level === 'low' ? 1 : 0));
        const concurrency = a.concurrency || 1;

        if (isClaude) {
          claudePressure += concurrency * (thinkWeight === 0 ? 1 : thinkWeight);
        }
      }
    }

    // Si no se registra tráfico previo observado en SQLite (instalación limpia / inicio en reposo),
    // reportar estado en espera/teórico para evitar falsas alarmas de agotamiento.
    if (totalRequests === 0) {
      return {
        level: 'idle',
        badge: '⚪ Modo Standby / Sin Tráfico',
        autonomy: 'En espera de ejecuciones',
        desc: 'Topología configurada. La autonomía y el estrés se computarán al registrar tráfico real.',
        claudePressure,
      };
    }

    if (claudePressure <= 4) {
      return {
        level: 'optimal',
        badge: '🟢 Distribución Óptima',
        shortBadge: '🟢 Óptima',
        autonomy: '> 8 horas continuas',
        shortAutonomy: '>8h',
        desc: 'Cargas balanceadas hacia Gemini; cuota de Claude reservada para tareas críticas.',
        claudePressure,
      };
    } else if (claudePressure <= 8) {
      return {
        level: 'moderate',
        badge: '🟡 Carga Moderada',
        shortBadge: '🟡 Moderada',
        autonomy: '3 - 5 horas continuas',
        shortAutonomy: '3-5h',
        desc: 'Uso activo de Claude; vigilar ráfagas de subagentes concurrentes en paralelo.',
        claudePressure,
      };
    } else {
      return {
        level: 'critical',
        badge: '🔴 Estrés Crítico de Cuota',
        shortBadge: '🔴 Crítica',
        autonomy: '< 30 minutos',
        shortAutonomy: '<30m',
        desc: 'Riesgo de agotar la ventana de 5h. Se recomienda desviar discovery/verify a Gemini o activar Auto-Downgrade T2+.',
        claudePressure,
      };
    }
  }, [harnesses]);

  if (loading) {
    return (
      <div className="agent-matrix-container" style={{ textAlign: 'center', paddingTop: 60 }}>
        <div className="loading-spinner" />
        <p style={{ marginTop: 12, color: '#94a3b8' }}>Cargando matriz de orquestación y perfiles...</p>
      </div>
    );
  }

  const formatPoolLabel = (poolId) => {
    const detail = poolDetails[poolId];
    if (detail?.target_model) {
      return `${poolId} (${detail.target_model})`;
    }
    return poolId;
  };

  const formatUpstreamLabel = (u) => {
    if ((u.id || '').startsWith('account/')) {
      const parts = u.id.split('/');
      if (parts.length >= 3) {
        const email = parts[1];
        const model = parts.slice(2).join('/');
        return `${model} (${email})`;
      }
    }
    if (u.provider === 'local_harness' || (u.id || '').includes('/')) {
      const parts = (u.id || '').split('/');
      if (parts.length > 1) {
        const prov = parts[0].toUpperCase();
        const model = parts.slice(1).join('/');
        return `${model} (${prov})`;
      }
    }
    return u.display_name || u.displayName || u.id;
  };

  const renderDropdownOptions = (excludedValue = null) => {
    const pools = excludedValue ? availablePools.filter((p) => p !== excludedValue) : availablePools;
    const freeAccounts = (upstreamModels || []).filter((u) => u.provider !== 'local_harness' && u.id !== excludedValue);
    const localLogins = (upstreamModels || []).filter((u) => u.provider === 'local_harness' && u.id !== excludedValue);

    const totalCount = pools.length + freeAccounts.length + localLogins.length;
    if (totalCount === 0) {
      return <option value="">(Sin opciones disponibles)</option>;
    }

    return (
      <>
        {pools.length > 0 && (
          <optgroup label="── 🛡️ POOLS DE BALANCEO ACTIVO ──">
            {pools.map((p) => (
              <option key={p} value={p}>
                {formatPoolLabel(p)}
              </option>
            ))}
          </optgroup>
        )}
        {freeAccounts.length > 0 && (
          <optgroup label="── 📋 CUENTAS LIBRES CPAMC (SIN POOL) ──">
            {freeAccounts.map((u) => (
              <option key={u.id} value={u.id}>
                {formatUpstreamLabel(u)}
              </option>
            ))}
          </optgroup>
        )}
        {localLogins.length > 0 && (
          <optgroup label="── 📟 MODELOS DE LOGINS LOCALES (NVIDIA, ETC.) ──">
            {localLogins.map((u) => (
              <option key={u.id} value={u.id}>
                {formatUpstreamLabel(u)}
              </option>
            ))}
          </optgroup>
        )}
      </>
    );
  };

  const renderPoolTransparencyPill = (poolId, isFallback = false) => {
    if (!poolId) return null;
    const detail = poolDetails[poolId];
    if (!detail) {
      if (poolId.includes('/')) {
        return (
          <div className="pool-transparency-pill upstream-pill" title={`Modelo upstream directo: ${poolId}`}>
            <span className="dot-active">🌐</span>
            <span className="pill-model">Direct Upstream: {poolId}</span>
          </div>
        );
      }
      return null;
    }

    if (isFallback) {
      return (
        <div
          className="pool-transparency-pill fallback-pill"
          title={`Pool de Relevo: ${poolId}\nModelo: ${detail.target_model}\nCuentas preparadas: ${detail.total_members}\nConsumo actual: 0% tokens (en espera de 429)`}
        >
          <span className="dot-standby">⚪</span>
          <span className="pill-model">Relevo: {detail.target_model}</span>
          <span className="pill-accounts">({detail.total_members} cuentas en espera)</span>
        </div>
      );
    }

    return (
      <div
        className="pool-transparency-pill"
        title={`Pool Primario: ${poolId}\nModelo en ejecución: ${detail.target_model}\nLíder activo en RAM: ${detail.leader_email}\nCuentas en rotación: ${detail.total_members} (1 líder + ${detail.reserves_count} reservas)`}
      >
        <span className="dot-active">🟢</span>
        <span className="pill-model">Modelo: {detail.target_model}</span>
        <span className="pill-accounts">({detail.total_members} cuentas activas)</span>
      </div>
    );
  };

  const renderOrchestrator = (agent, harnessId) => {
    if (!agent) return null;
    const agentKey = `${harnessId}_${agent.agent_id}`;
    const ping = pingStates[agentKey];

    return (
      <div className="orchestrator-card" key={agent.agent_id}>
        <div className="orchestrator-info">
          <div className="orchestrator-title">
            <span>{agent.displayName || agent.agent_id}</span>
            <button
              type="button"
              className="btn-ping-route"
              onClick={() => handleTestRoute(agent, harnessId)}
              disabled={ping?.loading}
              title="Prueba de Fuego (Dry-Run Ping): Verifica la latencia y la salud del líder activo en RAM"
            >
              {ping?.loading ? '⏳ Verificando...' : '⚡ Test Route'}
            </button>
            {ping?.text && (
              <span className={`ping-result-badge ${ping.ok ? 'ok' : 'err'}`}>
                {ping.text}
              </span>
            )}
          </div>
          <div className="orchestrator-desc">{agent.description}</div>
        </div>
        <div className="orchestrator-controls">
          <div>
            <span style={{ fontSize: 11, color: '#94a3b8', display: 'block', marginBottom: 4 }}>
              POOL PRIMARIO
            </span>
            <select
              className="matrix-select"
              value={agent.primary_pool}
              onChange={(e) => handlePoolChange(harnessId, agent.agent_id, 'primary_pool', e.target.value)}
            >
              {renderDropdownOptions()}
            </select>
            {isClaudeFamily(agent.primary_pool) && (
              <div
                className="claude-contextual-controls"
                style={{ marginTop: 6 }}
                title="Protector de cuota Claude: tope de intentos antes de pasar a Gemini"
              >
                <div className="claude-contextual-row">
                  <span className="claude-shield-icon">🛡️</span>
                  <span className="claude-shield-label">Freno:</span>
                  <select
                    className="matrix-select claude-turns-select"
                    value={agent.max_claude_turns ?? 3}
                    onChange={(e) => handlePoolChange(harnessId, agent.agent_id, 'max_claude_turns', parseInt(e.target.value, 10))}
                    title="Protector de cuota Claude: tope de intentos antes de pasar a Gemini"
                  >
                    <option value={2}>2 (Ahorro)</option>
                    <option value={3}>3 (Recomendado)</option>
                    <option value={5}>5 (Paciencia)</option>
                    <option value={0}>Sin límite</option>
                  </select>
                </div>
              </div>
            )}
          </div>

          <span
            className="relay-arrow"
            title="Relevo automático: Solo toma el control si el pool primario recibe 429 o fallo de red"
          >
            →
          </span>

          <div>
            <span
              style={{ fontSize: 11, color: '#94a3b8', display: 'block', marginBottom: 4 }}
              title="Rescate Pasivo: Permanece en espera con 0% de consumo hasta que el pool primario agote cuota o reciba 429"
            >
              POOL DE RESCATE (FAILOVER)
            </span>
            <select
              className="matrix-select"
              value={agent.fallback_pool}
              onChange={(e) => handlePoolChange(harnessId, agent.agent_id, 'fallback_pool', e.target.value)}
              disabled={availablePools.length + upstreamModels.length <= 1}
            >
              {availablePools.length + upstreamModels.length <= 1 ? (
                <option value="">🚫 Sin failover (Requiere 2+ pools/cuentas)</option>
              ) : (
                renderDropdownOptions(agent.primary_pool)
              )}
            </select>
            {renderPoolTransparencyPill(agent.fallback_pool, true)}
          </div>

          <div>
            <span style={{ fontSize: 11, color: '#94a3b8', display: 'block', marginBottom: 4 }}>
              THINKING
            </span>
            {(() => {
              const suppLevels = getThinkingLevelsForTarget(agent.primary_pool);
              if (!suppLevels || suppLevels.length === 0) {
                return (
                  <span
                    className="thinking-na-badge"
                    title="Este modelo no requiere ni admite parámetros de razonamiento/thinking"
                  >
                    🚫 N/A - Sin Razonamiento
                  </span>
                );
              }
              return (
                <div className="thinking-toggle">
                  {suppLevels.map((lvl) => {
                    const info = formatThinkingLevelBadge(lvl);
                    return (
                      <button
                        key={lvl}
                        type="button"
                        className={`thinking-btn ${agent.thinking_level === lvl ? `active ${lvl}` : ''}`}
                        onClick={() => handlePoolChange(harnessId, agent.agent_id, 'thinking_level', lvl)}
                        title={info.label}
                      >
                        {info.full}
                      </button>
                    );
                  })}
                </div>
              );
            })()}
          </div>
        </div>
      </div>
    );
  };

  const renderTable = (agents, harnessId) => {
    if (!agents || agents.length === 0) return null;

    // Colocar el orquestador como la Fila de Honor (Fila 1) en la tabla
    const orch = agents.find((a) => a.is_orchestrator);
    const subagents = agents.filter((a) => !a.is_orchestrator);
    const orderedAgents = orch ? [orch, ...subagents] : subagents;

    return (
      <table className="agents-table">
        <thead>
          <tr>
            <th>
              <div className="th-title">ROL / AGENTE</div>
              <div className="th-sub">Misión en el ciclo</div>
            </th>
            <th>
              <div className="th-title">PRIMARIO</div>
              <div className="th-sub">Ruta activa de ejecución</div>
            </th>
            <th>
              <div className="th-title">THINKING</div>
              <div className="th-sub">Nivel de razonamiento</div>
            </th>
            <th>
              <div className="th-title">TEST</div>
              <div className="th-sub">Sonda de red y token</div>
            </th>
          </tr>
        </thead>
        <tbody>
          {orderedAgents.map((a) => {
            const agentKey = `${harnessId}_${a.agent_id}`;
            const ping = pingStates[agentKey];
            const meta = getAgentHumanMeta(a);
            const isWriter = isWriterAgent(a);
            const isOrch = a.is_orchestrator;
            const agentDesc = a.description || meta.summary;
            const isExpanded = expandedAgents.has(agentKey);

            return (
              <React.Fragment key={a.agent_id}>
                <tr className={`${isOrch ? 'orchestrator-row' : ''} ${isExpanded ? 'agent-row-expanded' : ''}`}>
                  <td
                    className="agent-name-cell"
                    title="Haz clic para ver/ocultar configuración de rescate y concurrencia"
                    onClick={() => toggleAgentExpanded(agentKey)}
                  >
                    <div className="agent-name-wrap">
                      <span className={`agent-accordion-chevron ${isExpanded ? 'open' : ''}`}>▶</span>
                      <span className="agent-title-text" style={{ color: isOrch ? '#f59e0b' : '#e2e8f0' }}>
                        {a.displayName || a.agent_id}
                      </span>
                      <span className={`agent-role-chip ${meta.badgeClass}`}>{meta.badge}</span>
                      <span className="agent-info-tip" title={agentDesc} onClick={(e) => e.stopPropagation()}>ℹ️</span>
                    </div>
                  </td>
                  <td>
                    <select
                      className="matrix-select"
                      value={a.primary_pool}
                      onChange={(e) => handlePoolChange(harnessId, a.agent_id, 'primary_pool', e.target.value)}
                    >
                      {renderDropdownOptions()}
                    </select>
                    {isClaudeFamily(a.primary_pool) && (
                      <div
                        className="claude-contextual-controls"
                        title="Protector de cuota Claude: tope de intentos en Claude antes de pasar a Gemini"
                      >
                        <div className="claude-contextual-row">
                          <span className="claude-shield-icon">🛡️</span>
                          <span className="claude-shield-label">Freno Anti-Bucle:</span>
                          <select
                            className="matrix-select claude-turns-select"
                            value={a.max_claude_turns ?? 3}
                            onChange={(e) => handlePoolChange(harnessId, a.agent_id, 'max_claude_turns', parseInt(e.target.value, 10))}
                            title="Protector de cuota Claude: tope de intentos antes de pasar a Gemini"
                          >
                            <option value={2}>2 (Ahorro)</option>
                            <option value={3}>3 (Recomendado)</option>
                            <option value={5}>5 (Paciencia)</option>
                            <option value={0}>Sin límite</option>
                          </select>
                          {!isOrch && (
                            <button
                              type="button"
                              className={`btn-downgrade-chip ${a.auto_downgrade ? 'active' : ''}`}
                              onClick={() => handlePoolChange(harnessId, a.agent_id, 'auto_downgrade', !a.auto_downgrade)}
                              title="Mitigación T2+: reduce tokens de pensamiento a partir del 2do turno"
                            >
                              {a.auto_downgrade ? '🟢 T2+' : '⚪ T2+ Off'}
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </td>
                  <td>
                    {(() => {
                      const suppLevels = getThinkingLevelsForTarget(a.primary_pool);
                      if (!suppLevels || suppLevels.length === 0) {
                        return (
                          <span
                            className="thinking-na-badge"
                            title="Este modelo no requiere ni admite parámetros de razonamiento/thinking"
                          >
                            🚫 N/A
                          </span>
                        );
                      }
                      return (
                        <div className="thinking-toggle">
                          {suppLevels.map((lvl) => {
                            const info = formatThinkingLevelBadge(lvl);
                            return (
                              <button
                                key={lvl}
                                type="button"
                                className={`thinking-btn ${a.thinking_level === lvl ? `active ${lvl}` : ''}`}
                                onClick={() => handlePoolChange(harnessId, a.agent_id, 'thinking_level', lvl)}
                                title={info.label}
                              >
                                {info.short}
                              </button>
                            );
                          })}
                        </div>
                      );
                    })()}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn-ping-route"
                      onClick={() => handleTestRoute(a, harnessId)}
                      disabled={ping?.loading}
                      title="Test rápido de conectividad y latencia con el líder del pool"
                    >
                      {ping?.loading ? '⏳...' : '⚡ Test'}
                    </button>
                    {ping?.text && (
                      <div
                        style={{
                          fontSize: 10,
                          color: ping.ok ? '#10b981' : '#ef4444',
                          marginTop: 4,
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {ping.text}
                      </div>
                    )}
                  </td>
                </tr>

                {/* Acordeón Desplegable con SECUNDARIO (Failover) y CONCURRENCIA (Read-Only) */}
                {isExpanded && (
                  <tr className="agent-accordion-row">
                    <td colSpan={4} className="agent-accordion-cell">
                      <div className="agent-accordion-content">
                        {/* Bloque 1: Secundario / Failover */}
                        <div className="accordion-block accordion-block-failover">
                          <div className="accordion-block-header">
                            <span className="accordion-block-icon">🛡️</span>
                            <span className="accordion-block-title">SECUNDARIO</span>
                            <span className="accordion-block-subtitle">Relevo por agotamiento o 429</span>
                          </div>
                          <div className="accordion-block-body">
                            {isPoolTarget(a.primary_pool) ? (
                              <div
                                className="pool-self-covered-badge"
                                title="Este agente está respaldado por un Pool Soberano con rotación automática de cuentas en RAM. No requiere rescate secundario externo."
                              >
                                <span className="self-covered-icon">🛡️</span>
                                <span className="self-covered-text">Autocubierto en Pool</span>
                                <span className="self-covered-detail">
                                  ({poolDetails[a.primary_pool]?.total_members || 2} cuentas en rotación RAM)
                                </span>
                              </div>
                            ) : (
                              <div className="accordion-fallback-selector-wrap">
                                <select
                                  className="matrix-select accordion-fallback-select"
                                  value={a.fallback_pool}
                                  onChange={(e) => handlePoolChange(harnessId, a.agent_id, 'fallback_pool', e.target.value)}
                                  disabled={availablePools.length + upstreamModels.length <= 1}
                                >
                                  {availablePools.length + upstreamModels.length <= 1 ? (
                                    <option value="">🚫 Sin failover (Requiere 2+ pools/cuentas)</option>
                                  ) : (
                                    renderDropdownOptions(a.primary_pool)
                                  )}
                                </select>
                                {renderPoolTransparencyPill(a.fallback_pool, true)}
                              </div>
                            )}
                          </div>
                        </div>

                        {/* Bloque 2: Concurrencia (Solo Lectura) */}
                        <div className="accordion-block accordion-block-concurrency">
                          <div className="accordion-block-header">
                            <span className="accordion-block-icon">⚡</span>
                            <span className="accordion-block-title">CONCURRENCIA</span>
                            <span className="accordion-block-subtitle">Capacidad paralela segura (Solo Lectura)</span>
                          </div>
                          <div className="accordion-block-body">
                            {isWriter || isOrch ? (
                              <div
                                className="concurrency-readonly-badge writer-mode"
                                title={isOrch ? "Orquestador Soberano: Atiende en consola interactiva con concurrencia fija en 1" : "Candado de Seguridad: Agente con permisos de escritura y edición de código. Bloqueado en 1 tarea para evitar corrupción de código."}
                              >
                                <span className="lock-icon">🔒</span>
                                <span className="concurrency-val">1 tarea</span>
                                <span className="concurrency-tag">{isOrch ? "Líder" : "Seguro"}</span>
                                <span className="concurrency-desc">
                                  {isOrch ? "Consola interactiva" : "Edición secuencial anti-corrupción"}
                                </span>
                              </div>
                            ) : (
                              <div
                                className="concurrency-readonly-badge reader-mode"
                                title="Agente seguro de lectura y análisis sin riesgo de mutación"
                              >
                                <span className="lock-icon">⚡</span>
                                <span className="concurrency-val">{a.concurrency || 2} {a.concurrency === 1 ? 'tarea' : 'tareas'}</span>
                                <span className="concurrency-tag">Lectura Rápida</span>
                                <span className="concurrency-desc">
                                  Análisis paralelo seguro
                                </span>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    );
  };

  return (
    <div className="agent-matrix-container">
      {/* Cockpit Toolbar en 1 sola línea (Glassmorphic Cyberpunk 2027) */}
      <div className="matrix-cockpit-bar">
        {/* 1. Identidad */}
        <div className="cockpit-brand" title="Control unificado de orquestadores y subagentes detectados dinámicamente en el equipo">
          <span className="cockpit-logo">🎛️</span>
          <span className="cockpit-title">Matriz de Agentes & Orquestación</span>
        </div>

        <div className="cockpit-divider" />

        {/* 2. Semáforo Telemetría (Micro-Pill Interactiva con Tooltip Rico) */}
        <div
          className={`cockpit-gauge ${stress.level}`}
          data-testid="token-burn-gauge"
          title={`${stress.badge} · Autonomía estimada: ${stress.autonomy}\n${stress.desc}`}
        >
          <span className="gauge-dot" />
          <span className="gauge-badge">{stress.shortBadge || stress.badge} · {stress.shortAutonomy || stress.autonomy}</span>
          <span className="gauge-desc-hidden">Autonomía estimada: {stress.autonomy} - {stress.desc}</span>
        </div>

        <div className="cockpit-divider" />

        {/* 3. Estrategia de Ejecución (Segmented Control Minimalista) */}
        <div className="cockpit-presets" title="Estrategia global de concurrencia y límites por rol">
          <div className="cockpit-segmented-control">
            <button
              type="button"
              className="preset-btn safe"
              onClick={() => handleApplyPreset('safe')}
              title="Modo Seguro: Concurrencia en 1 tarea para todos los agentes. Máximo ahorro de cuota y cero riesgo."
            >
              🛡️ Seguro
            </button>
            <button
              type="button"
              className="preset-btn pro"
              onClick={() => handleApplyPreset('pro')}
              title="Modo Pro: Escritores en 1 tarea fija, lectores y exploradores en 2 tareas simultáneas. Velocidad 2x recomendada."
            >
              ⚡ Pro
            </button>
            <button
              type="button"
              className="preset-btn turbo"
              onClick={() => handleApplyPreset('turbo')}
              title="Modo Turbo: Escritores protegidos en 1 tarea, exploradores a 3 tareas en ráfaga para proyectos gigantes."
            >
              🚀 Turbo
            </button>
          </div>
        </div>

        <div className="cockpit-divider" />

        {/* 4. Switcher de Universos / Arneses */}
        <div className="cockpit-tabs-wrapper">
          {harnesses.length > 1 ? (
            <div className="cockpit-tabs">
              <button
                type="button"
                className={`cockpit-tab-btn ${activeUniverse === 'all' ? 'active' : ''}`}
                onClick={() => handleUniverseChange('all')}
                title="Mostrar todos los arneses y agentes en una vista unificada"
              >
                <span>🌐</span>
                <span>Vista Global Completa</span>
              </button>
              {harnesses.map((h) => (
                <button
                  key={h.id}
                  type="button"
                  className={`cockpit-tab-btn ${activeUniverse === h.id ? 'active' : ''}`}
                  onClick={() => handleUniverseChange(h.id)}
                  title={`Filtrar exclusivamente agentes de ${h.name}`}
                >
                  <span>{h.icon}</span>
                  <span>{h.name}</span>
                  <span className="tab-count-pill">{h.agents?.filter((a) => !a.is_orchestrator).length || 0}</span>
                </button>
              ))}
            </div>
          ) : harnesses.length === 1 ? (
            <div className="cockpit-single-harness-badge" title="Arnés detectado">
              <span>{harnesses[0].icon} {harnesses[0].name}</span>
              <span className="tab-count-pill">({harnesses[0].agents?.filter((a) => !a.is_orchestrator).length || 0} agentes detectados en disco)</span>
            </div>
          ) : (
            <div className="cockpit-no-harness">
              <span>⚠️ Sin arneses detectados</span>
            </div>
          )}
        </div>

        {/* 5. Acciones Rápidas */}
        <div className="cockpit-actions">
          {feedback.text && (
            <span
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: feedback.type === 'error' ? '#ef4444' : '#10b981',
                whiteSpace: 'nowrap',
              }}
            >
              {feedback.text}
            </span>
          )}
          <button
            type="button"
            className="cockpit-action-btn warmup"
            onClick={handleTriggerWarmup}
            disabled={warming || loading}
            title="Disparar Shadow Warmup predictivo para pre-calentar conexiones y prompt cache"
          >
            <span>{warming ? '⏳' : '⚡'}</span>
            <span className="btn-label-text">{warming ? 'Calentando...' : 'Warmup Triage'}</span>
          </button>
          <button
            type="button"
            className="cockpit-action-btn scan"
            onClick={handleScanEnvironment}
            disabled={scanning || loading}
            title="Escanear y detectar los arneses instalados en el equipo"
          >
            <span>{scanning ? '⏳' : '🔍'}</span>
            <span className="btn-label-text">{scanning ? 'Escaneando...' : 'Detectar Arneses'}</span>
          </button>
          <button
            type="button"
            className="cockpit-action-btn save"
            onClick={handleSave}
            disabled={saving || loading}
            title="Guardar y sincronizar la configuración en todos los arneses"
          >
            <span>💾</span>
            <span className="btn-label-text">{saving ? 'Guardando...' : 'Guardar Todo'}</span>
          </button>
        </div>
      </div>

      {/* Harness Sections (100% Dinámicas) */}
      {harnesses.map((harness) => {
        if (activeUniverse !== 'all' && activeUniverse !== harness.id) {
          return null;
        }

        const orch = harness.agents?.find((a) => a.is_orchestrator);
        const subagents = harness.agents?.filter((a) => !a.is_orchestrator) || [];
        const isVerExpanded = expandedHarnessVersions.has(harness.id);
        const verInfo = harnessVersionData[harness.id];

        return (
          <div key={harness.id} className="universe-section">
            <div
              className={`universe-header universe-header-clickable ${isVerExpanded ? 'expanded' : ''}`}
              title="Haz clic para inspeccionar auditoría de versión y actualizaciones oficiales de Gentleman"
              onClick={() => toggleHarnessVersion(harness.id)}
            >
              <div className="universe-header-left">
                <span className={`universe-accordion-chevron ${isVerExpanded ? 'open' : ''}`}>▶</span>
                <span className="universe-icon">{harness.icon}</span>
                <span className="universe-title">{harness.name.toUpperCase()}</span>
                <span className="universe-meta" title={`Ruta de configuración: ${harness.config_path}`} onClick={(e) => e.stopPropagation()}>
                  📁 {harness.config_path}
                </span>
                <span className="universe-clarity-callout" style={{ display: 'none' }}>
                  {harness.subtitle}
                </span>
              </div>
              <div className="universe-header-right" onClick={(e) => e.stopPropagation()}>
                <button
                  type="button"
                  className={`matrix-save-harness-btn ${dirtyHarnesses[harness.id] ? 'dirty' : ''}`}
                  onClick={() => handleSaveHarness(harness.id)}
                  disabled={saving || loading}
                  title={`Guardar cambios y persistir en ${harness.config_path}`}
                >
                  <span>{saving ? '⏳' : '💾'}</span>
                  <span>
                    {saving
                      ? 'Guardando...'
                      : dirtyHarnesses[harness.id]
                      ? `Guardar Cambios (${harness.name})`
                      : `Guardar ${harness.name}`}
                  </span>
                </button>
              </div>
            </div>

            {/* Panel Acordeón de Auditoría de Versión (100% Dinámico de Fuentes Oficiales) */}
            {isVerExpanded && (
              <div className="harness-version-audit-panel">
                <div className="audit-panel-header">
                  <span className="audit-panel-icon">📊</span>
                  <span className="audit-panel-title">
                    Auditoría de Versión & Telemetría Upstream ({harness.name})
                  </span>
                  {verInfo?.loading && (
                    <span className="audit-panel-spinner">⏳ Consultando npm y GitHub...</span>
                  )}
                  {verInfo?.data?.checked_at && (
                    <span className="audit-panel-sync">
                      Sincronizado: {verInfo.data.checked_at.slice(11, 19)} UTC
                    </span>
                  )}
                </div>

                {verInfo?.error ? (
                  <div className="audit-panel-error">
                    <span>⚠️ Error al obtener telemetría: {verInfo.error}</span>
                  </div>
                ) : verInfo?.loading ? (
                  <div className="audit-panel-loading">
                    <div className="loading-spinner" />
                    <span>Conectando con registry oficial y repositorio...</span>
                  </div>
                ) : verInfo?.data ? (
                  <div className="audit-table-wrapper">
                    <table className="audit-table">
                      <thead>
                        <tr>
                          <th>Entorno / Origen</th>
                          <th>Versión</th>
                          <th>Fecha / Commit</th>
                          <th>Estado</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr>
                          <td className="audit-cell-source">
                            <span className="audit-env-icon">💻</span>
                            <span>Instalación Local (en este equipo)</span>
                          </td>
                          <td className="audit-cell-version local-val">
                            <code>{verInfo.data.local_version || 'N/A'}</code>
                          </td>
                          <td className="audit-cell-date">
                            <code>{verInfo.data.local_date || '-'}</code>
                          </td>
                          <td className="audit-cell-status">
                            <span className={`audit-badge ${verInfo.data.local_version && verInfo.data.local_version !== 'No detectado' ? 'active' : 'warn'}`}>
                              {verInfo.data.local_status || 'Activa en disco'}
                            </span>
                          </td>
                        </tr>
                        <tr>
                          <td className="audit-cell-source">
                            <span className="audit-env-icon">📦</span>
                            <span>Último Release Oficial (npm registry)</span>
                          </td>
                          <td className="audit-cell-version npm-val">
                            <code>{verInfo.data.npm_version || 'N/A'}</code>
                          </td>
                          <td className="audit-cell-date">
                            <code>{verInfo.data.npm_date || '-'}</code>
                          </td>
                          <td className="audit-cell-status">
                            <span className="audit-badge release">
                              {verInfo.data.npm_status || 'Disponible en npm'}
                            </span>
                          </td>
                        </tr>
                        <tr>
                          <td className="audit-cell-source">
                            <span className="audit-env-icon">🌐</span>
                            <span>Rama main (GitHub upstream)</span>
                          </td>
                          <td className="audit-cell-version gh-val">
                            <code>{verInfo.data.github_version || 'N/A'}</code>
                          </td>
                          <td className="audit-cell-date">
                            <code>{verInfo.data.github_commit || '-'}</code>
                          </td>
                          <td className="audit-cell-status">
                            <span className="audit-badge upstream">
                              {verInfo.data.github_status || 'Gentleman-Programming'}
                            </span>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                ) : null}
              </div>
            )}

            {renderTable(harness.agents || [], harness.id)}
          </div>
        );
      })}

      {/* Footer Banner: Cache & Token Optimization */}
      <div className="matrix-cache-footer">
        <div className="cache-info">
          <h4>
            <span>🧹</span>
            <span>Reglas Transversales de Compactación Asimétrica & Prompt Cache</span>
          </h4>
          <p>
            Los resúmenes de sesión se desvían a <code>cpamc/gemini-3.8-flash-high</code> (0$ en cuota de Claude).
            El Prompt Cache se mantiene caliente vía Ghost Warmup y afinidad universal de IP/Token.
          </p>
        </div>

        <div className="cache-metrics">
          <div className="cache-pill">
            <span className="cache-pill-label">Ahorro en Compactación</span>
            <span className="cache-pill-value">100% GRATIS</span>
          </div>
          <div className="cache-pill">
            <span className="cache-pill-label">Hit Rate KV-Cache</span>
            <span className="cache-pill-value">&gt; 90%</span>
          </div>
        </div>
      </div>
    </div>
  );
}
