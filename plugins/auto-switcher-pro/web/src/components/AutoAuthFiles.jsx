import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  classifyAuthAccount,
  deleteAuthFile,
  maskDisplayIdentifier,
  buildManagedPoolCards,
  resolveInheritedCardModels,
  detectSpecialistState,
  listModels,
  listPools,
  savePool,
  patchAuthFileExclusions,
  fetchCardQuota,
  computeAccountTelemetry,
  classifyCooldowns,
  formatRemainingDuration,
  CANONICAL_PROVIDER_MODELS,
  sortPoolsByNumber,
} from '../api/managementClient';
import SpecialistModal from './SpecialistModal';
import QuotaClock from './QuotaClock';
import { Icons } from './Icons';
import { HelpTooltip } from './HelpTooltip';
import './AutoAuthFiles.css';

// Computes deterministic pool group colors: unassigned cards stay neutral (no color glow),
// while assigned cards inherit the exclusive theme color of their pool group.
const getPoolGroupStyle = (assignedPrefix) => {
  if (!assignedPrefix || assignedPrefix.startsWith('unlinked_')) {
    return {
      className: 'badge-provider unassigned',
      primary: '#64748b',
      bg: 'rgba(51, 65, 85, 0.3)',
      border: 'rgba(100, 116, 139, 0.5)',
      color: '#94a3b8',
      style: {
        background: 'rgba(51, 65, 85, 0.3)',
        border: '1px dashed rgba(100, 116, 139, 0.5)',
        color: '#94a3b8',
      },
      cardStyle: {
        borderTop: '1px solid rgba(51, 65, 85, 0.6)',
        borderColor: 'rgba(51, 65, 85, 0.6)',
      },
      statusBadgeStyle: {
        background: 'rgba(51, 65, 85, 0.3)',
        border: '1px solid rgba(71, 85, 105, 0.5)',
        color: '#94a3b8',
      },
    };
  }

  const match = assignedPrefix.match(/^(.*)_(\d+)$/);
  const poolBase = match ? match[1] : assignedPrefix;

  const poolColors = {
    agy: { primary: '#0ea5e9', bg: 'rgba(14, 165, 233, 0.08)', border: '#0284c7', color: '#38bdf8' },
    agy2: { primary: '#9333ea', bg: 'rgba(147, 51, 234, 0.08)', border: '#7e22ce', color: '#c084fc' },
    agy_son: { primary: '#d97706', bg: 'rgba(217, 119, 6, 0.08)', border: '#b45309', color: '#f59e0b' },
    agy_opus: { primary: '#db2777', bg: 'rgba(219, 39, 119, 0.08)', border: '#be185d', color: '#f472b6' },
    agy_clau: { primary: '#059669', bg: 'rgba(5, 150, 105, 0.08)', border: '#047857', color: '#10b981' },
    clau: { primary: '#059669', bg: 'rgba(5, 150, 105, 0.08)', border: '#047857', color: '#10b981' },
    codex: { primary: '#4f46e5', bg: 'rgba(79, 70, 229, 0.08)', border: '#4338ca', color: '#818cf8' },
  };

  const scheme = poolColors[poolBase] || {
    primary: '#64748b',
    bg: 'rgba(100, 116, 139, 0.08)',
    border: '#475569',
    color: '#94a3b8',
  };

  return {
    className: 'badge-provider assigned-group',
    primary: scheme.primary,
    bg: scheme.bg,
    border: scheme.border,
    color: scheme.color,
    style: {
      background: scheme.bg,
      border: `1px solid ${scheme.border}`,
      color: scheme.color,
      fontWeight: '700',
    },
    cardStyle: {
      borderTop: `3px solid ${scheme.primary}`,
      borderColor: scheme.border,
    },
    statusBadgeStyle: {
      background: scheme.bg,
      border: `1px solid ${scheme.border}`,
      color: scheme.color,
      fontWeight: '700',
    },
  };
};

/**
 * AutoAuthFiles Component
 *
 * Dedicated control view establishing architectural separation between physical OAuth
 * master accounts and derived virtual pool cards (scalable N -> 2N managed card model).
 * Provides origin traceability, model exclusion indicators, individual card dissolution,
 * batch orphan purging, single-model specialist gear configuration (⚙️), hero active
 * model banner, and homologated quota telemetry (Plan Pro, Gemini & Claude limits).
 */
export default function AutoAuthFiles({
  nodes = [],
  catalogModels = [],
  initialQuotas = {},
  onReloadRequested,
}) {
  const [isProcessing, setIsProcessing] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [fetchedCatalog, setFetchedCatalog] = useState([]);
  const [quotasMap, setQuotasMap] = useState(initialQuotas || {});
  const [refreshingQuotaKeys, setRefreshingQuotaKeys] = useState(new Set());
  const [loadingQuotaKeys, setLoadingQuotaKeys] = useState(new Set());
  const [cardScale, setCardScale] = useState(1.0);
  const [detailModal, setDetailModal] = useState({ isOpen: false, card: null, telemetry: null, quota: null });
  const [specialistModal, setSpecialistModal] = useState({
    isOpen: false,
    card: null,
    inheritedModels: [],
  });
  // Modal de Adopción Rápida con 1 Clic para cuentas Standalone
  const [adoptModal, setAdoptModal] = useState({
    isOpen: false,
    card: null,
    targetPoolId: '',
    newPoolName: '',
  });
  // Pools registrados en el plugin PoolRegistry (auto-switcher-pro-state.json)
  const [registeredPools, setRegisteredPools] = useState([]);
  // Guard so live quota is auto-fetched once per physical master per mount cycle
  const autoFetchedMastersRef = useRef(new Set());
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Sync initialQuotas if prop updates
  useEffect(() => {
    if (initialQuotas && Object.keys(initialQuotas).length > 0) {
      setQuotasMap((prev) => ({ ...prev, ...initialQuotas }));
    }
  }, [initialQuotas]);

  // [registeredPools] Sincroniza el PoolRegistry del plugin (fuente única de verdad).
  // GroupManager es el único generador: 0 pools registrados ⇒ estrictamente 0 tarjetas.
  // Se resincroniza cada vez que cambian los nodos (p.ej. tras crear/disolver un pool
  // GroupManager dispara onReloadRequested → nuevos nodos → re-consulta del registro).
  useEffect(() => {
    let cancelled = false;
    listPools()
      .then((res) => {
        if (!cancelled) setRegisteredPools(sortPoolsByNumber(Array.isArray(res?.pools) ? res.pools : []));
      })
      .catch(() => {
        // Registro no disponible (sin key / plugin cargando): estrictamente 0 tarjetas
        if (!cancelled) setRegisteredPools([]);
      });
    return () => {
      cancelled = true;
    };
  }, [nodes]);

  // Load catalog models via GET /v1/models if not passed via props
  useEffect(() => {
    if (Array.isArray(catalogModels) && catalogModels.length > 0) return;
    let mounted = true;
    listModels()
      .then((res) => {
        if (mounted && Array.isArray(res?.models) && res.models.length > 0) {
          setFetchedCatalog(res.models);
        }
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, [catalogModels]);

  const effectiveCatalogModels = useMemo(() => {
    if (Array.isArray(catalogModels) && catalogModels.length > 0) return catalogModels;
    const fetched = Array.isArray(fetchedCatalog) && fetchedCatalog.length > 0 ? fetchedCatalog : [];
    const canonicalList = [
      ...CANONICAL_PROVIDER_MODELS.gemini,
      ...CANONICAL_PROVIDER_MODELS.claude,
      ...CANONICAL_PROVIDER_MODELS.codex,
    ];
    return Array.from(new Set([...canonicalList, ...fetched]));
  }, [catalogModels, fetchedCatalog]);

  const handleOpenSpecialist = useCallback(
    (targetCard) => {
      const inherited = resolveInheritedCardModels(targetCard, effectiveCatalogModels);
      const isUnassigned = !targetCard?.poolId && !targetCard?.activePoolBase;
      setSpecialistModal({
        isOpen: true,
        card: {
          ...targetCard,
          isUnassigned,
        },
        inheritedModels: inherited,
      });
    },
    [effectiveCatalogModels]
  );

  const handlePatchSpecialist = useCallback(
    async (targetFileName, exclusionsToSave, selectedModel) => {
      const currentCard = specialistModal.card;
      // Gobernanza 100% Virtual e Independencia Per-Cuenta:
      // Si la tarjeta pertenece a un pool registrado, actualizamos ÚNICAMENTE el modelo
      // especialista de esta cuenta física en member_models[targetFile], sin alterar
      // la política general del pool ni forzar a las demás tarjetas miembros.
      if (currentCard?.poolId || currentCard?.activePoolBase) {
        const targetPoolId = currentCard.poolId;
        const targetBase = currentCard.activePoolBase;
        const targetPool = registeredPools.find(
          (p) => p.id === targetPoolId || p.base_prefix === targetBase
        );
        if (targetPool) {
          const authKey = currentCard.masterFileName || targetFileName;
          const updatedMemberModels = {
            ...(targetPool.member_models || {}),
          };
          if (authKey && selectedModel) {
            updatedMemberModels[authKey] = selectedModel;
          }
          const updatedPool = {
            ...targetPool,
            policy: {
              ...(targetPool.policy || {}),
              disable_isolation: false,
              // Preservar target_models existente como fallback de familia,
              // o inicializarlo si estaba vacío.
              target_models:
                Array.isArray(targetPool.policy?.target_models) && targetPool.policy.target_models.length > 0
                  ? targetPool.policy.target_models
                  : (selectedModel ? [selectedModel] : []),
              excluded_models: [],
            },
            member_models: updatedMemberModels,
          };
          await savePool(updatedPool);
          // Refrescar la lista de pools localmente
          const poolsRes = await listPools();
          if (Array.isArray(poolsRes?.pools)) {
            setRegisteredPools(poolsRes.pools);
          }
          return { ok: true, name: targetFileName };
        }
      }
      // Salvaguarda Arquitectónica (Gobernanza Virtual Pura - Mandamiento III):
      // NUNCA inyectar listas masivas de exclusión en archivos físicos .json de cuentas libres.
      // Las credenciales físicas en disco deben preservar excluded_models: [] de fábrica
      // para que CPAMC nativo no mutile el catálogo en Auth Files Management.
      // Si la acción es restaurar/purgar (exclusionsToSave vacío []), permitimos sanear el disco.
      if (Array.isArray(exclusionsToSave) && exclusionsToSave.length === 0) {
        return await patchAuthFileExclusions(targetFileName, []);
      }
      return {
        ok: true,
        name: targetFileName,
        unassignedNotice: `ℹ️ La cuenta "${maskDisplayIdentifier(targetFileName)}" es una cuenta libre (no asignada a ningún pool). Sus credenciales se mantienen en modo nativo. Para fijar un especialista virtual, agrégala a un pool desde Group Manager.`,
      };
    },
    [specialistModal.card, registeredPools]
  );

  const handleSpecialistSaved = useCallback(
    async (result) => {
      if (result?.unassignedNotice) {
        setErrorMessage(result.unassignedNotice);
        setTimeout(() => setErrorMessage(''), 6000);
        return;
      }
      setSuccessMessage(
        `⚙️ Configuración de especialista actualizada para ${maskDisplayIdentifier(result.fileName)}.`
      );
      setTimeout(() => setSuccessMessage(''), 4000);
      if (typeof onReloadRequested === 'function') {
        await onReloadRequested();
      }
    },
    [onReloadRequested]
  );

  const handleExecuteAdopt = useCallback(
    async () => {
      const { card, targetPoolId, newPoolName } = adoptModal;
      if (!card || !card.fileName) return;

      setIsProcessing(true);
      try {
        if (targetPoolId) {
          // Sumar cuenta a un pool existente
          const pool = registeredPools.find((p) => p.id === targetPoolId || p.base_prefix === targetPoolId);
          if (!pool) throw new Error('Pool de destino no encontrado');
          const existingReserves = Array.isArray(pool.reserves) ? pool.reserves : [];
          if (!existingReserves.includes(card.fileName) && pool.leader_auth !== card.fileName) {
            existingReserves.push(card.fileName);
          }
          await savePool({
            ...pool,
            reserves: existingReserves,
          });
          setSuccessMessage(`✅ Cuenta ${maskDisplayIdentifier(card.fileName)} añadida exitosamente al pool ${pool.display_name || pool.id}.`);
        } else {
          // Crear un nuevo pool con esta cuenta como líder
          const baseName = newPoolName?.trim() || `Pool-${registeredPools.length + 1}-${card.family}`;
          const newPool = {
            id: baseName,
            display_name: baseName,
            base_prefix: card.prefix || (card.family === 'gemini' ? 'agy' : card.family === 'claude' ? 'clau' : 'codex'),
            family: card.family || 'gemini',
            leader_auth: card.fileName,
            reserves: [],
            policy: {
              disable_isolation: false,
              target_models: card.family === 'gemini' ? ['gemini-3.8-flash-high'] : card.family === 'claude' ? ['claude-3-7-sonnet'] : ['gpt-5.6-codex'],
              excluded_models: [],
            },
          };
          await savePool(newPool);
          setSuccessMessage(`🎉 Nuevo pool ${baseName} creado con ${maskDisplayIdentifier(card.fileName)} como líder.`);
        }

        setAdoptModal({ isOpen: false, card: null, targetPoolId: '', newPoolName: '' });
        const poolsRes = await listPools();
        if (Array.isArray(poolsRes?.pools)) {
          setRegisteredPools(poolsRes.pools);
        }
        if (typeof onReloadRequested === 'function') {
          await onReloadRequested();
        }
      } catch (err) {
        setErrorMessage(`Error al adoptar cuenta: ${err.message}`);
      } finally {
        setIsProcessing(false);
        setTimeout(() => {
          setSuccessMessage('');
          setErrorMessage('');
        }, 5000);
      }
    },
    [adoptModal, registeredPools, onReloadRequested]
  );

  const handleRefreshCardQuota = useCallback(
    async (masterKey, telemetry) => {
      setRefreshingQuotaKeys((prev) => new Set(prev).add(masterKey));
      setLoadingQuotaKeys((prev) => new Set(prev).add(masterKey));
      try {
        const result = await fetchCardQuota(
          {
            fileName: masterKey,
            auth_index: telemetry.authIndex || '',
            project_id: telemetry.projectId || '',
            prefix: telemetry.prefix || '',
            familyRole: telemetry.familyRole || '',
          },
          { force: true }
        );
        if (isMountedRef.current) {
          setQuotasMap((prev) => ({
            ...prev,
            [masterKey]: result,
          }));
        }
      } catch (err) {
        if (isMountedRef.current) {
          setErrorMessage(`Error al actualizar cuota: ${err.message}`);
        }
      } finally {
        if (isMountedRef.current) {
          setRefreshingQuotaKeys((prev) => {
            const next = new Set(prev);
            next.delete(masterKey);
            return next;
          });
          setLoadingQuotaKeys((prev) => {
            const next = new Set(prev);
            next.delete(masterKey);
            return next;
          });
        }
      }
    },
    []
  );

  // Normalizes real CPAMC-native telemetry from a master entry (node) or a
  // managed card (both carry the same physical account fields).
  const extractAccountTelemetry = useCallback((source) => {
    const nodeData = source?.node?.data || null;
    return {
      authIndex:
        source?.authIndex ||
        nodeData?.auth_index ||
        '',
      projectId: source?.projectId || nodeData?.project_id || '',
      unavailable: source?.unavailable === true || nodeData?.unavailable === true,
      disabled: source?.disabled === true || nodeData?.disabled === true,
      cooldowns: source?.cooldowns || nodeData?.cooldowns || [],
      recentRequests: source?.recentRequests || nodeData?.recent_requests || [],
      nextRetryAfter: source?.nextRetryAfter || nodeData?.next_retry_after || '',
    };
  }, []);

  // Honest quota groups derived from real CPAMC-native cooldown state.
  // Never fabricates percentages: exhausted families come from real 429
  // cooldowns with their true reset times; everything else is "sin datos" / "consultando".
  const deriveNativeQuotaGroups = useCallback((telemetry, isCardLoading = false) => {
    const cd = classifyCooldowns(telemetry.cooldowns);
    const noDataRow = (label) => ({
      label,
      percent: null,
      percentLabel: isCardLoading ? 'Consultando en vivo...' : 'Sin datos en vivo',
      resetLabel: '—',
      warning: false,
    });
    const exhaustedRows = (info) => {
      if (!info) return null;
      const remainingMs = info.retryAtMs !== null ? info.retryAtMs - Date.now() : null;
      const resetLabel = info.retryAt
        ? `Se libera en ${formatRemainingDuration(info.retryAt)}`
        : 'En cooldown';
      const exhaustedRow = {
        label: 'Weekly Limit',
        percent: 0,
        percentLabel: 'Agotada (429)',
        resetLabel,
        resetMs: info.retryAtMs,
        warning: true,
      };
      const fiveHourRow = {
        label: 'Five Hour Limit',
        percent: 0,
        percentLabel: 'Agotada (429)',
        resetLabel,
        resetMs: info.retryAtMs,
        warning: true,
      };
      // A cooldown resetting within ~6h indicates the 5-hour window is the
      // exhausted one; longer resets indicate the weekly quota.
      if (remainingMs !== null && remainingMs <= 6 * 60 * 60 * 1000) {
        return [fiveHourRow, noDataRow('Weekly Limit')];
      }
      return [noDataRow('Five Hour Limit'), exhaustedRow];
    };

    return [
      {
        title: 'GEMINI MODELS',
        rows: exhaustedRows(cd.gemini) || [
          noDataRow('Five Hour Limit'),
          noDataRow('Weekly Limit'),
        ],
      },
      {
        title: 'CLAUDE AND GPT MODELS',
        rows: exhaustedRows(cd.claudeGpt) || [
          noDataRow('Five Hour Limit'),
          noDataRow('Weekly Limit'),
        ],
      },
    ];
  }, []);

  // Effective quota for a physical master: cached live Google data wins when
  // available; otherwise the honest native-derived state is rendered.
  const getCardQuota = useCallback(
    (masterKey, telemetry) => {
      const cached = quotasMap[masterKey];
      if (cached && Array.isArray(cached.groups) && cached.groups.length > 0) {
        return { plan: cached.plan, groups: cached.groups, live: true, loading: false };
      }
      const isCardLoading = loadingQuotaKeys.has(masterKey);
      return {
        plan: cached?.plan || null,
        groups: deriveNativeQuotaGroups(telemetry, isCardLoading),
        live: false,
        loading: isCardLoading,
      };
    },
    [quotasMap, deriveNativeQuotaGroups, loadingQuotaKeys]
  );

  const renderHeroBanner = (specState, defaultModel, poolStyle, modelsCount = 0) => {
    const bannerStyle = poolStyle ? {
      borderColor: poolStyle.border,
      background: poolStyle.bg,
    } : {};

    const activeModelNameStyle = poolStyle ? {
      color: '#f6f4f1',
    } : {};

    if (specState.isSpecialist) {
      return (
        <div
          className="hero-model-banner specialist"
          style={bannerStyle}
          data-testid="hero-model-banner"
        >
          <div className="hero-model-badge-row">
            <span
              className="badge-specialist-active"
              style={poolStyle ? {
                background: poolStyle.bg,
                borderColor: poolStyle.border,
                color: poolStyle.color,
              } : {}}
            >
              🎯 MODELO ASIGNADO EN RAM
            </span>
          </div>
          <div
            className="hero-model-name"
            style={activeModelNameStyle}
            data-testid="hero-model-name"
          >
            {specState.activeSpecialistModel}
          </div>
          <div className="hero-model-helper">
            <span>Ruteo virtual activo en RAM</span>
            <HelpTooltip title="Aislamiento en RAM">
              El ruteo y las exclusiones se gobiernan 100% en memoria RAM por el plugin. Las credenciales físicas en disco permanecen intactas.
            </HelpTooltip>
          </div>
        </div>
      );
    }
    const countLabel = modelsCount > 0 ? ` (${modelsCount})` : '';
    return (
      <div className="hero-model-banner multipurpose" data-testid="hero-model-banner">
        <div className="hero-model-badge-row">
          <span className="badge-multipurpose-default">✨ MODELO PREDETERMINADO (MULTIPROPÓSITO)</span>
        </div>
        <div className="hero-model-name" data-testid="hero-model-name">
          Todos los modelos{countLabel}
        </div>
        <div className="hero-model-helper">
          Modo multipropósito abierto · Predeterminado preferente: {defaultModel}
        </div>
      </div>
    );
  };

  const renderQuotaTelemetry = (masterKey, source, familyRole) => {
    const telemetry = extractAccountTelemetry(source);
    const quota = getCardQuota(masterKey, telemetry);
    const isRefreshing = refreshingQuotaKeys.has(masterKey);
    const isCardLoading = quota.loading || isRefreshing;
    const activity = computeAccountTelemetry(telemetry.recentRequests);
    const cd = classifyCooldowns(telemetry.cooldowns);
    const planName = quota.plan;

    const earliestCooldown =
      cd.active.length > 0
        ? cd.active.reduce(
            (earliest, a) =>
              a.retryAtMs !== null && (!earliest || earliest.retryAtMs === null || a.retryAtMs < earliest.retryAtMs)
                ? a
                : earliest,
            null
          )
        : null;

    // Filtrar grupos de cuota para priorizar la familia activa de la tarjeta:
    // En Gemini cards, no saturar con Claude si ya hay Gemini models presentes
    const visibleGroups = (quota.groups || []).filter((group) => {
      if (familyRole === 'gemini') {
        // Si el grupo contiene Claude, solo mostrarlo si no hay grupo de Gemini
        const isClaudeGroup = group.title.toLowerCase().includes('claude');
        const hasGeminiGroup = quota.groups.some((g) => g.title.toLowerCase().includes('gemini'));
        if (isClaudeGroup && hasGeminiGroup) return false;
      }
      return true;
    });

    return (
      <div className="card-quota-telemetry" data-testid="card-quota-telemetry">
        {/* Real cooldown state from CPAMC native (429 quota exhaustion) */}
        {earliestCooldown && (
          <div className="card-cooldown-banner" data-testid="card-cooldown-banner">
            <span className="cooldown-icon"><Icons.Clock size={14} className="text-amber-500" /></span>
            <span className="cooldown-text">
              En cooldown (429): {earliestCooldown.modelKey}
              {earliestCooldown.retryAt ?
                ` · se libera en ${formatRemainingDuration(earliestCooldown.retryAt)}` : ''}
            </span>
          </div>
        )}

        <div className="plan-row">
          <span>Plan</span>
          <div className="plan-badges">
            {planName ? (
              <span className="plan-badge" data-testid="plan-badge">Plan {planName}</span>
            ) : isCardLoading ? (
              <span className="plan-badge plan-loading" data-testid="plan-badge">Plan: consultando...</span>
            ) : (
              <span className="plan-badge plan-unknown" data-testid="plan-badge">Plan: sin datos</span>
            )}
          </div>
        </div>

        {visibleGroups.map((group, gIdx) => {
          // Sort to always place 5-hour window on the left and weekly window on the right
          const sortedRows = [...(group.rows || [])].sort((a, b) => {
            const aIs5h =
              (a.label || '').toLowerCase().includes('5') ||
              (a.label || '').toLowerCase().includes('five');
            const bIs5h =
              (b.label || '').toLowerCase().includes('5') ||
              (b.label || '').toLowerCase().includes('five');
            if (aIs5h && !bIs5h) return -1;
            if (!aIs5h && bIs5h) return 1;
            return 0;
          });

          return (
            <div key={gIdx} className="quota-group">
              <div className="group-title">{group.title}</div>
              <div className="quota-clocks-row" data-testid={`quota-clocks-${gIdx}`}>
                {sortedRows.map((row, rIdx) => {
                  const isWeekly = (row.label || '').toLowerCase().includes('week');
                  const totalMinutes = isWeekly ? 10080 : 300;
                  const windowKey = isWeekly ? 'weekly' : '5h';
                  const consumedPercent =
                    row.percent === null || row.percent === undefined
                      ? null
                      : row.percent === 0
                      ? 100
                      : Math.max(0, Math.min(100, 100 - row.percent));
                  const remainingMinutes =
                    row.resetMs !== null && row.resetMs !== undefined
                      ? Math.max(0, Math.round((row.resetMs - Date.now()) / 60000))
                      : null;

                  return (
                    <QuotaClock
                      key={rIdx}
                      totalMinutes={totalMinutes}
                      remainingMinutes={remainingMinutes}
                      consumedPercent={consumedPercent}
                      label={row.label}
                      windowKey={windowKey}
                      resetLabel={row.resetLabel}
                      percentLabel={row.percentLabel}
                      isLoading={isCardLoading}
                      testId={`quota-clock-${windowKey}-${masterKey || 'card'}-${rIdx}`}
                    />
                  );
                })}
              </div>
            </div>
          );
        })}

        {/* Real Activity from CPAMC native recent_requests buckets */}
        <div className="card-activity-wrap">
          <div className="activity-header">
            <span className="activity-title">Activity (~3.3h)</span>
            <span
              className="activity-meta"
              data-testid="card-activity-meta"
            >
              {activity.reqs} reqs · <strong>{activity.okPct}% ok</strong>
            </span>
          </div>
        </div>

        {/* Card Refresh Footer */}
        <div className="card-quota-footer">
          <button
            type="button"
            className="btn-card-refresh"
            onClick={() => handleRefreshCardQuota(masterKey, telemetry)}
            disabled={isRefreshing}
            aria-label="Actualizar Cuota"
            data-testid={`btn-refresh-quota-${masterKey}`}
            title="Actualizar telemetría de cuota en vivo"
          >
            {isRefreshing ? (
              <Icons.Refresh size={13} className="spinning" style={{ marginRight: 4 }} />
            ) : (
              <Icons.Refresh size={13} style={{ marginRight: 4 }} />
            )}
            <span>Actualizar Cuota</span>
          </button>
        </div>
      </div>
    );
  };

  // 1. Scalable N -> 2N Managed Pool Cards (estrictamente desde el PoolRegistry del plugin)
  const managedCards = useMemo(
    () => buildManagedPoolCards(nodes, registeredPools),
    [nodes, registeredPools]
  );

  // 1c. Cuentas Directas / Standalone (Nativas de CPAMC no asignadas a ningún pool registrado)
  const standaloneCards = useMemo(() => {
    if (!Array.isArray(nodes) || nodes.length === 0) return [];

    const poolMasterFiles = new Set(
      managedCards.map((c) => c.masterFileName).filter(Boolean)
    );

    const standaloneList = [];
    nodes.forEach((node) => {
      if (!node) return;
      const classification = classifyAuthAccount(node);
      if (classification.isMaster && !poolMasterFiles.has(classification.fileName)) {
        standaloneList.push({
          node,
          classification,
          fileName: classification.fileName,
          prefix: classification.prefix || '',
          alias: node.alias || node.data?.alias || classification.alias || '',
          maskedEmail: classification.maskedEmail,
          provider: node.data?.provider || classification.provider || 'direct',
          exclusionBadges: classification.exclusionBadges || [],
          excludedModels: classification.excludedModels || [],
        });
      }
    });

    return standaloneList;
  }, [nodes, managedCards]);

  // Scalable N -> 2N Managed Pool Cards agrupadas por Pool
  const poolGroups = useMemo(() => {
    const groups = new Map();
    managedCards.forEach((card, idx) => {
      const poolKey = card.poolId || card.activePoolBase || 'sin-pool';
      if (!groups.has(poolKey)) {
        groups.set(poolKey, {
          poolId: card.poolId,
          activePoolBase: card.activePoolBase,
          cards: [],
        });
      }
      groups.get(poolKey).cards.push({ card, originalIdx: idx });
    });
    return Array.from(groups.values());
  }, [managedCards]);

  // 1b. Auto-fetch live quota/tier once per physical master on mount so cards
  // show real Google values when reachable (never fabricated defaults).
  useEffect(() => {
    const antigravityCards = managedCards.filter(
      (c) => (c.familyRole === 'gemini' || c.familyRole === 'claude') && c.masterFileName
    );
    const allTargets = [
      ...antigravityCards.map((c) => ({
        key: c.masterFileName,
        authIndex: c.authIndex || '',
        projectId: c.projectId || '',
        prefix: c.prefix || '',
        familyRole: c.familyRole || '',
      })),
      ...standaloneCards.map((sc) => ({
        key: sc.fileName,
        authIndex: sc.node.data?.authIndex || '',
        projectId: sc.node.data?.projectId || '',
        prefix: sc.prefix || '',
        familyRole: sc.provider === 'claude' ? 'claude' : 'gemini',
      })),
    ];

    allTargets.forEach((target) => {
      const key = target.key;
      if (!key || autoFetchedMastersRef.current.has(key)) return;
      autoFetchedMastersRef.current.add(key);
      setLoadingQuotaKeys((prev) => new Set(prev).add(key));
      fetchCardQuota({
        fileName: key,
        auth_index: target.authIndex,
        project_id: target.projectId,
        prefix: target.prefix,
        familyRole: target.familyRole,
      })
        .then((result) => {
          if (isMountedRef.current) {
            setQuotasMap((prev) => ({ ...prev, [key]: result }));
          }
        })
        .catch(() => {
          // Live quota unavailable: cards fall back to honest native-derived
          // state (cooldowns / sin datos) instead of mock values.
        })
        .finally(() => {
          if (isMountedRef.current) {
            setLoadingQuotaKeys((prev) => {
              const next = new Set(prev);
              next.delete(key);
              return next;
            });
          }
        });
    });
  }, [managedCards, standaloneCards]);

  // 2. Classify accounts and identify physical masters vs virtual accounts on disk
  const { masterAccounts, virtualAccounts, orphanAccounts } = useMemo(() => {
    const masters = [];
    const virtuals = [];
    const orphans = [];

    // Map of active virtual files referenced by valid managed cards
    const activeVirtualFiles = new Set(
      managedCards.map((c) => c.virtualFileName).filter(Boolean)
    );

    (nodes || []).forEach((node) => {
      if (!node) return;
      const classification = classifyAuthAccount(node);
      const entry = {
        node,
        classification,
        fileName: classification.fileName,
        prefix: classification.prefix,
        maskedEmail: classification.maskedEmail,
        masterOrigin: classification.masterOrigin,
        exclusionBadges: classification.exclusionBadges,
      };

      if (classification.isMaster) {
        masters.push(entry);
      } else if (classification.isVirtual) {
        virtuals.push(entry);
        // An orphan clone is a virtual account that is unlinked, has no active prefix,
        // or does not belong to the valid active managed cards
        const rawPrefix = (node.data?.prefix || node.prefix || '').trim();
        if (
          !rawPrefix ||
          rawPrefix.startsWith('unlinked_') ||
          !activeVirtualFiles.has(classification.fileName)
        ) {
          orphans.push(entry);
        }
      }
    });

    return {
      masterAccounts: masters,
      virtualAccounts: virtuals,
      orphanAccounts: orphans,
    };
  }, [nodes, managedCards]);

  // Active in live routing prefixes count
  const activeInPoolsCount = useMemo(() => {
    return managedCards.filter(
      (c) => c.assignedPrefix && !c.assignedPrefix.startsWith('unlinked_')
    ).length;
  }, [managedCards]);

  // Map master accounts to their derived virtual accounts on disk
  const masterToDerivedMap = useMemo(() => {
    const map = new Map();
    virtualAccounts.forEach((v) => {
      if (v.masterOrigin) {
        if (!map.has(v.masterOrigin)) {
          map.set(v.masterOrigin, []);
        }
        map.get(v.masterOrigin).push(v);
      }
    });
    return map;
  }, [virtualAccounts]);

  // Handle individual virtual clone dissolution/deletion
  const handleDeleteVirtual = useCallback(
    async (fileName) => {
      if (!fileName) return;
      const safeName = maskDisplayIdentifier(fileName);
      if (
        !window.confirm(
          `¿Liberar réplica virtual "${safeName}"? Tu cuenta física OAuth y credenciales maestras permanecen 100% intactas en Google/Anthropic.`
        )
      ) {
        return;
      }

      setIsProcessing(true);
      setErrorMessage('');
      try {
        await deleteAuthFile(fileName);
        setSuccessMessage(`🧹 Réplica virtual "${safeName}" liberada exitosamente (credencial maestra intacta).`);
        if (typeof onReloadRequested === 'function') {
          await onReloadRequested();
        }
        setTimeout(() => setSuccessMessage(''), 4000);
      } catch (err) {
        setErrorMessage(`Error al liberar réplica virtual: ${err.message}`);
      } finally {
        setIsProcessing(false);
      }
    },
    [onReloadRequested]
  );

  // Handle batch purge of orphan clones
  const handlePurgeOrphans = useCallback(async () => {
    if (orphanAccounts.length === 0) return;
    if (
      !window.confirm(
        `¿Seguro que deseas purgar ${orphanAccounts.length} clon(es) huérfano(s)? Se eliminarán permanentemente de CPAMC los archivos residuales.`
      )
    ) {
      return;
    }

    setIsProcessing(true);
    setErrorMessage('');
    try {
      const results = await Promise.allSettled(
        orphanAccounts.map((o) => deleteAuthFile(o.fileName))
      );
      const failed = results.filter((r) => r.status === 'rejected');
      if (failed.length > 0) {
        setErrorMessage(`Fallaron ${failed.length} de ${orphanAccounts.length} eliminaciones.`);
      } else {
        setSuccessMessage(
          `🧹 Se purgaron exitosamente ${orphanAccounts.length} archivo(s) clon huérfano(s).`
        );
      }
      if (typeof onReloadRequested === 'function') {
        await onReloadRequested();
      }
      setTimeout(() => setSuccessMessage(''), 4000);
    } catch (err) {
      setErrorMessage(`Error al purgar clones huérfanos: ${err.message}`);
    } finally {
      setIsProcessing(false);
    }
  }, [orphanAccounts, onReloadRequested]);

  // Virtual/Claude cards for backwards-compatible test queries
  const claudeCards = useMemo(() => {
    return managedCards.filter((c) => c.familyRole === 'claude');
  }, [managedCards]);

  return (
    <div className="auto-auth-container" data-testid="auto-auth-files-view">
      {/* Header */}
      <div className="auto-auth-header">
        <div className="auto-auth-title-row">
          <span className="auto-auth-icon">🗂️</span>
          <h2 className="auto-auth-title">Auto Auth Files & Trazabilidad</h2>
        </div>
        <p className="auto-auth-desc">
          Separación arquitectónica de cuentas físicas OAuth (Masters) y credenciales
          virtuales derivadas para pools de Claude y Gemini (Modelo escalable N → 2N).
          Supervisa origen, exclusiones y limpieza de clones residuales en CPAMC.
        </p>
      </div>

      {/* Metrics Ribbon */}
      <div className="auto-auth-metrics">
        <div className="auto-auth-metric-card">
          <span className="auto-auth-metric-label">Cards Gestionadas</span>
          <span
            className="auto-auth-metric-value"
            data-testid="metric-total-accounts"
          >
            {managedCards.length}
            <span
              className="auto-auth-metric-sub"
              data-testid="metric-managed-cards"
            >
              {virtualAccounts.length > 0 || claudeCards.length > 0
                ? `${managedCards.length} en pools (2N)`
                : `${managedCards.length} en pools`}
            </span>
          </span>
        </div>

        <div className="auto-auth-metric-card">
          <span className="auto-auth-metric-label">Cuentas Maestras (OAuth)</span>
          <span
            className="auto-auth-metric-value"
            style={{ color: '#fef08a' }}
            data-testid="metric-master-accounts"
          >
            {masterAccounts.length}
            <span className="auto-auth-metric-sub">físicas (N)</span>
          </span>
        </div>

        <div className="auto-auth-metric-card">
          <span className="auto-auth-metric-label">Cuentas Virtuales</span>
          <span
            className="auto-auth-metric-value"
            style={{ color: '#e9d5ff' }}
            data-testid="metric-virtual-accounts"
          >
            {virtualAccounts.length || claudeCards.length}
            <span className="auto-auth-metric-sub">derivadas (Claude)</span>
          </span>
        </div>

        <div
          className={`auto-auth-metric-card ${orphanAccounts.length > 0 ? 'alert' : ''}`}
        >
          <span className="auto-auth-metric-label">Clones Huérfanos</span>
          <span
            className="auto-auth-metric-value"
            style={{ color: orphanAccounts.length > 0 ? '#f87171' : '#6ee7b7' }}
            data-testid="metric-orphan-clones"
          >
            {orphanAccounts.length}
            <span className="auto-auth-metric-sub">a purgar</span>
          </span>
        </div>
      </div>

      {/* Feedback Alerts */}
      {errorMessage && (
        <div
          style={{
            background: 'rgba(239, 68, 68, 0.2)',
            border: '1px solid #ef4444',
            color: '#fca5a5',
            padding: '10px 16px',
            borderRadius: 8,
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          {errorMessage}
        </div>
      )}

      {successMessage && (
        <div
          style={{
            background: 'rgba(16, 185, 129, 0.2)',
            border: '1px solid #10b981',
            color: '#6ee7b7',
            padding: '10px 16px',
            borderRadius: 8,
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          {successMessage}
        </div>
      )}

      {/* Section: Purgar Clones Huérfanos Banner (if detected) */}
      {orphanAccounts.length > 0 && (
        <div className="auto-auth-orphan-banner" data-testid="orphan-purge-banner">
          <div className="auto-auth-orphan-info">
            <span className="auto-auth-orphan-icon">⚠️</span>
            <div className="auto-auth-orphan-text">
              <h4>Se detectaron {orphanAccounts.length} clones residuales huérfanos</h4>
              <p>
                Archivos virtuales desasociados o sin prefijo activo ocupando espacio en CPAMC.
                Púrgalos para mantener el entorno limpio y evitar deriva.
              </p>
            </div>
          </div>
          <button
            type="button"
            className="btn-purge-orphans"
            onClick={handlePurgeOrphans}
            disabled={isProcessing}
            data-testid="btn-purge-orphans"
          >
            <span>🧹</span>
            <span>Purgar Clones Huérfanos ({orphanAccounts.length})</span>
          </button>
        </div>
      )}

      {/* Managed Pool Cards Section (Model 2N: Gemini + Claude Cards) */}
      <div
        className="auto-auth-section"
        data-testid="section-managed-cards"
      >
        <div className="auto-auth-section-header">
          <h3 className="auto-auth-section-title">
            <Icons.Layers size={18} />
            <span>
              {claudeCards.length > 0
                ? 'Cards Gestionadas en Pools (Modelo 2N: Gemini + Claude)'
                : 'Cards Gestionadas en Pools (Cuentas Activas)'}
            </span>
          </h3>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div className="auto-auth-scale-controls" style={{ display: 'flex', alignItems: 'center', gap: 5, background: 'var(--bg-card, #262320)', padding: '2px 8px', borderRadius: 6, border: '1px solid var(--border-color, #3a3530)' }}>
              <span style={{ fontSize: 11, color: 'var(--text-tertiary, #9c958d)', fontWeight: 600 }}>Escala:</span>
              <button
                type="button"
                className="btn-scale-adjust"
                onClick={() => setCardScale((prev) => Math.max(0.75, Number((prev - 0.1).toFixed(2))))}
                title="Reducir tamaño de tarjetas (-)"
                style={{ padding: '2px 7px', borderRadius: 4, background: 'var(--bg-surface, #1d1b18)', border: '1px solid var(--border-color, #3a3530)', color: 'var(--text-primary, #f6f4f1)', cursor: 'pointer', fontSize: 12, fontWeight: 700, lineHeight: 1 }}
              >
                -
              </button>
              <span style={{ fontSize: 11, color: 'var(--text-secondary, #c9c3bb)', minWidth: 36, textAlign: 'center', fontFamily: 'monospace', fontWeight: 600 }}>
                {Math.round(cardScale * 100)}%
              </span>
              <button
                type="button"
                className="btn-scale-adjust"
                onClick={() => setCardScale((prev) => Math.min(1.4, Number((prev + 0.1).toFixed(2))))}
                title="Aumentar tamaño de tarjetas (+)"
                style={{ padding: '2px 7px', borderRadius: 4, background: 'var(--bg-surface, #1d1b18)', border: '1px solid var(--border-color, #3a3530)', color: 'var(--text-primary, #f6f4f1)', cursor: 'pointer', fontSize: 12, fontWeight: 700, lineHeight: 1 }}
              >
                +
              </button>
              {cardScale !== 1.0 && (
                <button
                  type="button"
                  className="btn-scale-reset"
                  onClick={() => setCardScale(1.0)}
                  title="Restablecer escala al 100%"
                  style={{ padding: '2px 5px', borderRadius: 4, background: 'transparent', border: 'none', color: 'var(--text-tertiary, #9c958d)', cursor: 'pointer', fontSize: 10, textDecoration: 'underline' }}
                >
                  100%
                </button>
              )}
            </div>
            <span className="auto-auth-section-count">{managedCards.length} cards</span>
          </div>
        </div>

        {managedCards.length === 0 ? (
          <div
            className="auto-auth-empty-alert"
            data-testid="auto-auth-empty-pools"
            style={{
              padding: '36px 20px',
              textAlign: 'center',
              background: 'rgba(15, 23, 42, 0.45)',
              borderRadius: '12px',
              border: '1px dashed rgba(100, 116, 139, 0.35)',
              margin: '16px 0',
            }}
          >
            <div style={{ fontSize: '30px', marginBottom: '8px' }}>🛠️</div>
            <h4 style={{ margin: '0 0 6px', color: '#f8fafc', fontSize: '15px', fontWeight: 700 }}>
              0 Cards Gestionadas en Auto Auth Files
            </h4>
            <p style={{ margin: 0, color: '#94a3b8', fontSize: '13px', maxWidth: '540px', display: 'inline-block' }}>
              Las tarjetas de pool deben generarse a través de{' '}
              <strong>"🛠️ Crear Group/Perfiles"</strong>. Una vez estructurados los pools de Gemini o Claude, sus tarjetas se reflejarán aquí automáticamente.
            </p>
          </div>
        ) : (
          <div className="auto-auth-section-groups" data-testid="section-virtuals">
            {poolGroups.map((group, gIdx) => {
              const groupPoolId = group.poolId || group.activePoolBase || `Pool-${gIdx + 1}`;
              const poolDef = registeredPools.find(
                (p) => p.id === group.poolId || p.base_prefix === group.activePoolBase
              );
              const groupTargetModel =
                poolDef?.policy?.target_models?.[0] ||
                group.cards[0]?.card?.specialistModel ||
                'Multimodelo';

              return (
                <div key={groupPoolId} className="auto-auth-pool-group" data-testid={`pool-group-${gIdx}`}>
                  <div className="auto-auth-pool-header">
                    <div className="auto-auth-pool-info">
                      <span className="auto-auth-pool-title">
                        <Icons.Box size={16} style={{ marginRight: 6, verticalAlign: 'middle' }} />
                        {groupPoolId}
                      </span>
                      {group.activePoolBase && (
                        <span className="auto-auth-pool-badge">
                          Base: [{group.activePoolBase}]
                        </span>
                      )}
                      <span className="auto-auth-pool-target">
                        <Icons.Target size={14} style={{ marginRight: 4, verticalAlign: 'middle' }} />
                        Objetivo: <strong>{groupTargetModel}</strong>
                      </span>
                    </div>
                    <span className="auto-auth-section-count">
                      {group.cards.length} cuenta(s) en rotación
                    </span>
                  </div>

                  <div className="auto-auth-grid" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${Math.round(350 * cardScale)}px, 1fr))` }}>
                    {group.cards.map(({ card, originalIdx: idx }) => {
                      const isGemini = card.familyRole === 'gemini';
                      const isCodex = card.familyRole === 'codex';
                      const roleBadgeClass = isGemini ? 'master' : isCodex ? 'codex' : 'virtual';
                      const familyTitle = isGemini ? 'Gemini' : isCodex ? 'Codex' : 'Claude';

                      const excludes55 = (card.exclusionBadges || []).includes('Excluye 5.5');
                      const virtualFileToDelete = card.virtualFileName;
                      const claudeIdx = claudeCards.indexOf(card);
                      const cardInherited = resolveInheritedCardModels(card, effectiveCatalogModels);
                      const specState = card.specialistModel
                        ? {
                            isSpecialist: true,
                            activeSpecialistModel: card.specialistModel,
                            excludedCount:
                              cardInherited.length > 1
                                ? cardInherited.length - 1
                                : (card.excludedModels || []).length,
                          }
                        : detectSpecialistState(card, cardInherited);
                      const poolGroupStyle = getPoolGroupStyle(card.assignedPrefix);
                      const cardTelemetry = extractAccountTelemetry(card);
                      const cardCd = classifyCooldowns(cardTelemetry.cooldowns);
                      const cardEarliestCooldown =
                        cardCd.active.length > 0
                          ? cardCd.active.reduce(
                              (earliest, a) =>
                                a.retryAtMs !== null && (!earliest || earliest.retryAtMs === null || a.retryAtMs < earliest.retryAtMs)
                                  ? a
                                  : earliest,
                              null
                            )
                          : null;

                      return (
                        <div
                          key={card.cardId || idx}
                          className={`auto-auth-card ${roleBadgeClass}`}
                          style={{
                            ...poolGroupStyle.cardStyle,
                            '--card-accent': poolGroupStyle.primary,
                            '--card-accent-bg': poolGroupStyle.bg,
                            '--card-accent-border': poolGroupStyle.border,
                            '--card-accent-color': poolGroupStyle.color,
                          }}
                          data-testid={isGemini ? `gemini-card-${idx}` : `virtual-card-${claudeIdx}`}
                        >
                          <div className="auto-auth-card-top">
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <span
                                className="badge-prefix-hero"
                                style={{
                                  background: poolGroupStyle.primary || '#0284c7',
                                  color: '#ffffff',
                                }}
                                data-testid={`badge-prefix-hero-${idx}`}
                              >
                                🏷️ [{card.assignedPrefix || card.activePoolBase || 'sin-prefijo'}]
                              </span>
                              <span className={`badge-role ${roleBadgeClass}`}>
                                {familyTitle}
                              </span>
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <button
                                type="button"
                                className="btn-card-inspect"
                                onClick={() => {
                                  const masterKey = card.masterFileName || card.fileName;
                                  const telem = extractAccountTelemetry(card);
                                  const q = getCardQuota(masterKey, telem);
                                  setDetailModal({ isOpen: true, card, telemetry: telem, quota: q });
                                }}
                                aria-label="Inspeccionar Cuenta"
                                title="Ver detalles y telemetría completa"
                                style={{ background: 'transparent', border: '1px solid var(--border-color, #3a3530)', borderRadius: 5, padding: '3px 6px', color: 'var(--text-secondary, #c9c3bb)', cursor: 'pointer', display: 'flex', alignItems: 'center' }}
                              >
                                <Icons.Info size={13} />
                              </button>
                              <button
                                type="button"
                                className="btn-card-gear"
                                onClick={() => handleOpenSpecialist(card)}
                                aria-label="Configurar Especialista"
                                data-testid={isGemini ? `btn-gear-gemini-${idx}` : `btn-gear-virtual-${claudeIdx}`}
                                title="Configurar Especialista (⚙️)"
                              >
                                ⚙️
                              </button>
                            </div>
                          </div>

                          <div className="auto-auth-identity">
                            <span
                              className="auto-auth-email"
                              title={card.email || card.maskedEmail}
                            >
                              {card.email || card.maskedEmail}
                            </span>
                            <span className="auto-auth-filename">
                              {card.virtualFileName
                                ? maskDisplayIdentifier(card.virtualFileName)
                                : maskDisplayIdentifier(card.masterFileName)}
                            </span>
                          </div>

                          {/* Origin Traceability Badge (derived cards linking to master) */}
                          {!isGemini && (
                            <div
                              className="auto-auth-origin-box"
                              data-testid="origin-traceability-badge"
                            >
                              <span className="auto-auth-origin-icon">🔗</span>
                              <span>
                                Origen: <strong>{card.maskedEmail}</strong> (Master)
                              </span>
                            </div>
                          )}

                          {/* Hero Active Model Banner (MINI-002) */}
                          {renderHeroBanner(
                            specState,
                            isGemini
                              ? cardInherited.includes('gemini-3.8-flash-high')
                                ? 'gemini-3.8-flash-high'
                                : cardInherited.find((m) => m.includes('3.8'))
                                || (cardInherited.includes('gemini-2.5-pro') ? 'gemini-2.5-pro' : cardInherited[0] || 'gemini-3.8-flash-high')
                              : cardInherited.includes('claude-3-7-sonnet')
                              ? 'claude-3-7-sonnet'
                              : cardInherited.find((m) => m.includes('3.7') || m.includes('sonnet'))
                              || cardInherited[0]
                              || 'claude-3-7-sonnet',
                            poolGroupStyle,
                            cardInherited.length
                          )}

                          <div className="auto-auth-badges-row">
                            <div className="status-pill-group">
                              {(() => {
                                const hasCooldown = Boolean(cardEarliestCooldown);
                                const isResting = hasCooldown;
                                const cooldownMinutes = cardEarliestCooldown?.retryAt
                                  ? formatRemainingDuration(cardEarliestCooldown.retryAt)
                                  : '';

                                if (card.isDynamicRAMLeader) {
                                  return (
                                    <>
                                      <span
                                        className="badge-pool-prefix badge-state-ram-leader"
                                        title="Esta cuenta es la que actualmente procesa las peticiones en caliente"
                                      >
                                        🟢 EN CALIENTE: DESPACHANDO EN RAM
                                      </span>
                                      <span className="badge-ram-leader" style={{ marginLeft: 4 }}>
                                        👑 Turno Activo (Líder en RAM)
                                      </span>
                                    </>
                                  );
                                }

                                if (isResting) {
                                  return (
                                    <span
                                      className="badge-pool-prefix badge-state-resting"
                                      title="Cuenta en descanso temporal por cuota o cooldown para recuperar ventana"
                                    >
                                      💤 EN REPOSO PREVENTIVO{cooldownMinutes ? ` · restan ${cooldownMinutes}` : ''}
                                    </span>
                                  );
                                }

                                return (
                                  <span
                                    className="badge-pool-prefix badge-state-reserve"
                                    title="Reserva sana con cuota disponible lista para relevo inmediato"
                                  >
                                    ⏸️ EN BANQUILLO: RESERVA LISTA
                                  </span>
                                );
                              })()}
                            </div>

                            <div className="isolation-pill-group">
                              {specState.isSpecialist ? (
                                <>
                                  <span
                                    className="badge-specialist-active"
                                    style={{ display: 'none' }}
                                    data-testid={`badge-specialist-active-${idx}`}
                                  >
                                    🎯 Modelo Activo: {specState.activeSpecialistModel}
                                  </span>
                                  <span
                                    className="badge-isolation-tag"
                                    data-testid={`badge-specialist-excluded-${idx}`}
                                  >
                                    Aislamiento Virtual en RAM (🚫 Excluidos: {specState.excludedCount} modelos)
                                  </span>
                                </>
                              ) : (
                                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                  {(card.exclusionBadges || []).map((badge, bIdx) => (
                                    <span key={bIdx} className="badge-exclusion">
                                      🚫 {badge}
                                    </span>
                                  ))}
                                  <span className="badge-target-family">
                                    {isGemini
                                      ? '✨ Gemini 3.x'
                                      : `✨ Claude ${excludes55 ? '4.6' : '4.6 & 5.5'}`}
                                  </span>
                                </div>
                              )}
                            </div>
                          </div>

                          {/* Quota Telemetry Homologation (MINI-003) */}
                          {renderQuotaTelemetry(card.masterFileName, card, card.familyRole)}

                          {/* Card actions: dissolution if virtual file exists */}
                          {virtualFileToDelete && (
                            <div className="auto-auth-card-actions">
                              <button
                                type="button"
                                className="btn-delete-clone"
                                onClick={() => handleDeleteVirtual(virtualFileToDelete)}
                                disabled={isProcessing}
                                data-testid={`btn-delete-virtual-${virtualFileToDelete}`}
                                title="Liberar réplica virtual de disco (la cuenta maestra física OAuth permanece intacta)"
                              >
                                <span>🧹</span>
                                <span>Liberar Réplica Virtual</span>
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Cuentas Directas / Standalone (Solo Lectura) Section */}
      {standaloneCards.length > 0 && (
        <div
          className="auto-auth-section"
          data-testid="section-standalone-cards"
          style={{ marginTop: 24 }}
        >
          <div className="auto-auth-section-header">
            <h3 className="auto-auth-section-title">
              <span>⚡</span>
              <span>Cuentas Directas / Standalone (Solo Lectura)</span>
            </h3>
            <span className="auto-auth-section-count" data-testid="metric-standalone-count">
              {standaloneCards.length} cuenta(s) fija(s)
            </span>
          </div>

          <div className="auto-auth-section-groups" data-testid="section-standalones">
            <div className="auto-auth-pool-group" style={{ borderColor: 'rgba(100, 116, 139, 0.4)' }}>
              <div className="auto-auth-pool-header" style={{ background: 'rgba(30, 41, 59, 0.5)' }}>
                <div className="auto-auth-pool-info">
                  <span className="auto-auth-pool-title" style={{ color: '#94a3b8' }}>
                    🔒 MODO SOLO LECTURA · ASISTIDO
                  </span>
                  <span className="auto-auth-pool-badge" style={{ background: 'rgba(234, 179, 8, 0.2)', color: '#facc15', border: '1px solid rgba(234, 179, 8, 0.4)' }}>
                    [CUENTA FIJA · SIN FAILOVER]
                  </span>
                  <span className="auto-auth-pool-target" style={{ color: '#cbd5e1' }}>
                    🛡️ Telemetría en vivo activa · Credenciales en disco intactas
                  </span>
                </div>
                <span className="auto-auth-section-count" style={{ color: '#94a3b8' }}>
                  {standaloneCards.length} disponible(s) en /model
                </span>
              </div>

              <div className="auto-auth-grid" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${Math.round(350 * cardScale)}px, 1fr))` }}>
                {standaloneCards.map((scard, sIdx) => {
                  const isClaude = scard.provider === 'claude' || scard.fileName.includes('claude');
                  const isCodex = scard.provider === 'codex' || scard.provider === 'openai';
                  const isGemini = !isClaude && !isCodex;
                  const familyTitle = isGemini ? 'Google Directo' : isCodex ? 'OpenAI Directo' : 'Claude Directo';
                  const roleBadgeClass = isGemini ? 'master' : isCodex ? 'codex' : 'virtual';

                  return (
                    <div
                      key={scard.fileName || sIdx}
                      className={`auto-auth-card standalone ${roleBadgeClass}`}
                      style={{
                        borderColor: 'rgba(100, 116, 139, 0.4)',
                        background: 'rgba(15, 23, 42, 0.65)',
                      }}
                      data-testid={`standalone-card-${sIdx}`}
                    >
                      <div className="auto-auth-card-top">
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span
                            className="badge-prefix-hero"
                            style={{
                              background: scard.alias ? 'rgba(56, 189, 248, 0.25)' : '#475569',
                              color: scard.alias ? '#38bdf8' : '#ffffff',
                              border: scard.alias ? '1px solid rgba(56, 189, 248, 0.4)' : 'none',
                              fontWeight: 700,
                            }}
                          >
                            🏷️ [{scard.alias || scard.prefix || 'directo'}]
                          </span>
                          <span className={`badge-role ${roleBadgeClass}`}>
                            {familyTitle}
                          </span>
                        </div>
                        <span
                          style={{
                            fontSize: 11,
                            fontWeight: 600,
                            padding: '2px 8px',
                            borderRadius: 6,
                            background: 'rgba(234, 179, 8, 0.15)',
                            color: '#facc15',
                            border: '1px solid rgba(234, 179, 8, 0.3)',
                          }}
                        >
                          CUENTA FIJA · SIN FAILOVER
                        </span>
                      </div>

                      <div className="auto-auth-card-body">
                        <div className="card-email-row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                          <span className="card-email" title={scard.fileName}>
                            {scard.maskedEmail || scard.fileName}
                          </span>
                          <span style={{ fontSize: 11, color: '#94a3b8', fontStyle: 'italic' }}>
                            Solo Lectura
                          </span>
                        </div>

                        <div className="hero-model-banner multipurpose" style={{ borderColor: 'rgba(100, 116, 139, 0.3)' }}>
                          <div className="hero-model-badge-row">
                            <span className="badge-multipurpose-default" style={{ background: 'rgba(100, 116, 139, 0.2)', color: '#94a3b8' }}>
                              ⚡ ENRUTAMIENTO DIRECTO NATIVO
                            </span>
                          </div>
                          <div className="hero-model-name" style={{ fontSize: 13, color: '#f1f5f9' }}>
                            {scard.prefix ? `${scard.prefix}/*` : 'Modelos nativos CPAMC'}
                          </div>
                          <div className="hero-model-helper" style={{ color: '#94a3b8' }}>
                            Sin rotación de pool · Conexión fija a cuenta física
                          </div>
                        </div>

                        <div className="card-state-pill-row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                          <span
                            className="badge-pool-prefix badge-state-fixed"
                            style={{ background: 'rgba(51, 65, 85, 0.6)', color: '#cbd5e1', border: '1px solid #64748b' }}
                            title="Cuenta física fija sin conmutación"
                          >
                            ⚡ CUENTA FIJA DIRECTA
                          </span>
                          <button
                            type="button"
                            className="btn-card-adopt"
                            data-testid={`btn-adopt-${scard.fileName}`}
                            onClick={() =>
                              setAdoptModal({
                                isOpen: true,
                                card: { ...scard, family: isGemini ? 'gemini' : isClaude ? 'claude' : 'codex' },
                                targetPoolId: registeredPools.length > 0 ? (registeredPools[0].id || registeredPools[0].base_prefix) : '',
                                newPoolName: '',
                              })
                            }
                            style={{
                              background: 'linear-gradient(135deg, rgba(16, 185, 129, 0.2), rgba(5, 150, 105, 0.3))',
                              color: '#34d399',
                              border: '1px solid rgba(16, 185, 129, 0.4)',
                              borderRadius: 6,
                              padding: '3px 8px',
                              fontSize: 11,
                              fontWeight: 600,
                              cursor: 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              gap: 4,
                            }}
                            title="Adoptar cuenta en un Pool para otorgarle failover 24/7 y rotación transparente"
                          >
                            🛡️ Adoptar en Pool
                          </button>
                        </div>
                      </div>

                      {/* Quota Telemetry */}
                      {renderQuotaTelemetry(scard.fileName, scard.node, isGemini ? 'gemini' : isClaude ? 'claude' : 'codex')}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Specialist Configuration Modal */}
      <SpecialistModal
        isOpen={specialistModal.isOpen}
        card={specialistModal.card}
        inheritedModels={specialistModal.inheritedModels}
        allCatalogModels={effectiveCatalogModels}
        onClose={() => setSpecialistModal((prev) => ({ ...prev, isOpen: false, card: null }))}
        onSaved={handleSpecialistSaved}
        patchFn={handlePatchSpecialist}
      />

      {/* Modal de Adopción Rápida con 1 Clic */}
      {adoptModal.isOpen && adoptModal.card && (
        <div
          className="modal-backdrop"
          data-testid="modal-adopt-backdrop"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.75)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 9999,
          }}
        >
          <div
            className="modal-card"
            data-testid="modal-adopt-card"
            style={{
              background: '#0f172a',
              border: '1px solid #334155',
              borderRadius: 12,
              padding: 24,
              maxWidth: 480,
              width: '90%',
              boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <h3 style={{ margin: 0, fontSize: 16, color: '#f8fafc', display: 'flex', alignItems: 'center', gap: 8 }}>
                🛡️ Adoptar Cuenta en Pool de Failover
              </h3>
              <button
                type="button"
                onClick={() => setAdoptModal({ isOpen: false, card: null, targetPoolId: '', newPoolName: '' })}
                style={{ background: 'transparent', border: 'none', color: '#94a3b8', fontSize: 18, cursor: 'pointer' }}
              >
                ✕
              </button>
            </div>

            <p style={{ fontSize: 13, color: '#cbd5e1', lineHeight: 1.5, marginBottom: 16 }}>
              Otorga resiliencia 24/7 y rotación transparente a la cuenta fija{' '}
              <strong style={{ color: '#38bdf8' }}>{adoptModal.card.maskedEmail || adoptModal.card.fileName}</strong>.
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 20 }}>
              {registeredPools.length > 0 && (
                <div>
                  <label style={{ display: 'block', fontSize: 12, color: '#94a3b8', marginBottom: 6 }}>
                    Sumar a un Pool existente:
                  </label>
                  <select
                    value={adoptModal.targetPoolId}
                    onChange={(e) => setAdoptModal((prev) => ({ ...prev, targetPoolId: e.target.value }))}
                    style={{
                      width: '100%',
                      background: '#1e293b',
                      border: '1px solid #475569',
                      borderRadius: 6,
                      color: '#f8fafc',
                      padding: '8px 12px',
                      fontSize: 13,
                    }}
                    data-testid="select-adopt-target-pool"
                  >
                    {registeredPools.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.display_name || p.id} ({p.family || 'multipurpose'})
                      </option>
                    ))}
                    <option value="">➕ O crear un nuevo Pool independiente</option>
                  </select>
                </div>
              )}

              {(!registeredPools.length || !adoptModal.targetPoolId) && (
                <div>
                  <label style={{ display: 'block', fontSize: 12, color: '#94a3b8', marginBottom: 6 }}>
                    Nombre del nuevo Pool:
                  </label>
                  <input
                    type="text"
                    placeholder={`Pool-${registeredPools.length + 1}-${adoptModal.card.family || 'gemini'}`}
                    value={adoptModal.newPoolName}
                    onChange={(e) => setAdoptModal((prev) => ({ ...prev, newPoolName: e.target.value }))}
                    style={{
                      width: '100%',
                      background: '#1e293b',
                      border: '1px solid #475569',
                      borderRadius: 6,
                      color: '#f8fafc',
                      padding: '8px 12px',
                      fontSize: 13,
                    }}
                    data-testid="input-adopt-new-pool-name"
                  />
                </div>
              )}
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button
                type="button"
                onClick={() => setAdoptModal({ isOpen: false, card: null, targetPoolId: '', newPoolName: '' })}
                style={{
                  background: 'transparent',
                  border: '1px solid #475569',
                  borderRadius: 6,
                  color: '#cbd5e1',
                  padding: '8px 16px',
                  fontSize: 13,
                  cursor: 'pointer',
                }}
              >
                Cancelar
              </button>
              <button
                type="button"
                data-testid="btn-confirm-adopt"
                onClick={handleExecuteAdopt}
                disabled={isProcessing}
                style={{
                  background: 'linear-gradient(135deg, #10b981, #059669)',
                  border: 'none',
                  borderRadius: 6,
                  color: '#ffffff',
                  padding: '8px 16px',
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: isProcessing ? 'not-allowed' : 'pointer',
                  opacity: isProcessing ? 0.7 : 1,
                }}
              >
                {isProcessing ? 'Adoptando...' : 'Confirmar Adopción'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal de Inspección Detallada de Cuenta */}
      {detailModal.isOpen && detailModal.card && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.75)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 9999,
            padding: 16,
          }}
          onClick={() => setDetailModal({ isOpen: false, card: null, telemetry: null, quota: null })}
        >
          <div
            style={{
              background: 'var(--bg-surface, #1d1b18)',
              border: '1px solid var(--border-color, #3a3530)',
              borderRadius: 12,
              width: '100%',
              maxWidth: 620,
              padding: 24,
              color: 'var(--text-primary, #f6f4f1)',
              boxShadow: '0 20px 40px rgba(0,0,0,0.6)',
              maxHeight: '90vh',
              overflowY: 'auto',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-color, #3a3530)', paddingBottom: 12, marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Icons.Layers size={18} />
                <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>
                  Detalles de Cuenta: {detailModal.card.email || detailModal.card.maskedEmail}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setDetailModal({ isOpen: false, card: null, telemetry: null, quota: null })}
                style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary, #c9c3bb)', cursor: 'pointer', padding: 4 }}
              >
                <Icons.X size={18} />
              </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ background: 'var(--bg-card, #262320)', padding: 12, borderRadius: 8, border: '1px solid var(--border-color, #3a3530)' }}>
                <div style={{ fontSize: 11, color: 'var(--text-tertiary, #9c958d)', textTransform: 'uppercase', marginBottom: 4 }}>Archivo Físico / Virtual</div>
                <div style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--text-secondary, #c9c3bb)' }}>
                  {detailModal.card.virtualFileName || detailModal.card.masterFileName || detailModal.card.fileName}
                </div>
              </div>

              <div style={{ background: 'var(--bg-card, #262320)', padding: 12, borderRadius: 8, border: '1px solid var(--border-color, #3a3530)' }}>
                <div style={{ fontSize: 11, color: 'var(--text-tertiary, #9c958d)', textTransform: 'uppercase', marginBottom: 4 }}>Modelo Asignado en RAM</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: '#f6f4f1' }}>
                  {detailModal.card.specialistModel || 'Predeterminado'}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary, #c9c3bb)', marginTop: 4 }}>
                  Prefijo: <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{detailModal.card.assignedPrefix || 'sin-prefijo'}</span> · Estado: {detailModal.card.isDynamicRAMLeader ? 'Líder en caliente' : 'En reserva'}
                </div>
              </div>

              {detailModal.quota && (
                <div style={{ background: 'var(--bg-card, #262320)', padding: 12, borderRadius: 8, border: '1px solid var(--border-color, #3a3530)' }}>
                  <div style={{ fontSize: 11, color: 'var(--text-tertiary, #9c958d)', textTransform: 'uppercase', marginBottom: 6 }}>Cuotas y Ventanas Activas</div>
                  <div style={{ display: 'flex', gap: 16 }}>
                    <div>Plan: <strong style={{ color: '#10b981' }}>{detailModal.quota.plan || 'Estándar'}</strong></div>
                    <div>Estado: <strong>{detailModal.quota.loading ? 'Actualizando...' : 'Sincronizado'}</strong></div>
                  </div>
                </div>
              )}

              {detailModal.telemetry && detailModal.telemetry.recentRequests && (
                <div style={{ background: 'var(--bg-card, #262320)', padding: 12, borderRadius: 8, border: '1px solid var(--border-color, #3a3530)' }}>
                  <div style={{ fontSize: 11, color: 'var(--text-tertiary, #9c958d)', textTransform: 'uppercase', marginBottom: 6 }}>Actividad Reciente (~3.3h)</div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary, #c9c3bb)' }}>
                    Peticiones registradas: <strong>{detailModal.telemetry.recentRequests.length}</strong>
                  </div>
                </div>
              )}
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
              <button
                type="button"
                onClick={() => setDetailModal({ isOpen: false, card: null, telemetry: null, quota: null })}
                style={{
                  background: 'var(--bg-card, #262320)',
                  border: '1px solid var(--border-color, #3a3530)',
                  color: 'var(--text-primary, #f6f4f1)',
                  padding: '8px 16px',
                  borderRadius: 6,
                  cursor: 'pointer',
                  fontWeight: 600,
                  fontSize: 13,
                }}
              >
                Cerrar
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
