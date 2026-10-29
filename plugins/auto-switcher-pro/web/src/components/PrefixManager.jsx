import React, { useState, useMemo, useEffect } from 'react';
import { saveAuthFilePrefixes, listPools, classifyAuthAccount } from '../api/managementClient';
import '../PrefixManager.css';

/**
 * Helper para clasificar el rol del prefijo según la convención de Auto Switcher:
 * - Líder de Pool Soberano
 * - Reserva de Pool Soberano (con índice de suplente)
 * - Root / Principal clásico en disco (ej: agy, agy2, codex)
 * - Reserva clásica en disco (ej: agy_1, agy2_1, codex_1)
 * - Libre / Sin Asignar (únicamente si no pertenece a ningún pool)
 */
function classifyPrefixRole(prefix = '', memberPool = null, fileName = '') {
  const p = prefix.trim();

  // Si la cuenta pertenece a un Pool Soberano registrado (máxima prioridad de verdad):
  if (memberPool) {
    const isLeader = memberPool.leader_auth === fileName;
    if (isLeader) {
      return {
        role: 'leader',
        label: `👑 LÍDER (${memberPool.id})`,
        badgeClass: 'pm-role-leader',
      };
    }
    // Si es reserva del pool, calcular su orden de suplente
    const reserveList = Array.isArray(memberPool.reserves)
      ? memberPool.reserves
      : (Array.isArray(memberPool.members) ? memberPool.members.filter((m) => m !== memberPool.leader_auth) : []);
    const resIdx = reserveList.indexOf(fileName);
    const orderNum = resIdx >= 0 ? resIdx + 1 : 1;
    return {
      role: 'reserve',
      label: `🛡️ RESERVA #${orderNum} (${memberPool.id})`,
      badgeClass: 'pm-role-reserve',
    };
  }

  // Cuentas fuera de pools (libres o con prefijos legacy)
  if (!p || p.startsWith('unlinked_')) {
    return {
      role: 'free',
      label: '⚪ CUENTA LIBRE (Disponible)',
      badgeClass: 'pm-role-free',
    };
  }
  if (p === 'nv' || p === 'ocgo') {
    return {
      role: 'specialist',
      label: '⚡ SALVAVIDAS PERMANENTE',
      badgeClass: 'pm-role-specialist',
    };
  }
  if (/_([0-9]+)$/.test(p)) {
    const match = p.match(/_([0-9]+)$/);
    return {
      role: 'reserve',
      label: `🛡️ RESERVA ${match[1]} (Disco)`,
      badgeClass: 'pm-role-reserve',
    };
  }
  return {
    role: 'leader',
    label: '👑 CUENTA PRINCIPAL (Disco)',
    badgeClass: 'pm-role-leader',
  };
}

export default function PrefixManager({ nodes = [], onReloadRequested }) {
  const [searchQuery, setSearchQuery] = useState('');
  const [filterCategory, setFilterCategory] = useState('all'); // all | gemini | claude | codex | free | antigravity | others
  const [drafts, setDrafts] = useState({});
  const [savingRowId, setSavingRowId] = useState(null);
  const [isSavingBatch, setIsSavingBatch] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [registeredPools, setRegisteredPools] = useState([]);

  // Paginación adaptable
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(25); // 15 | 25 | 50 | 0 (0 = Ver todo)

  // Reseteo de página al buscar o cambiar filtro
  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, filterCategory, pageSize]);

  useEffect(() => {
    let cancelled = false;
    listPools()
      .then((res) => {
        if (!cancelled && Array.isArray(res?.pools)) {
          setRegisteredPools(res.pools);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Inicializar o sincronizar borradores
  const effectiveDrafts = useMemo(() => {
    const map = {};
    nodes.forEach((n) => {
      map[n.id] = drafts[n.id] !== undefined ? drafts[n.id] : (n.data?.prefix || '');
    });
    return map;
  }, [nodes, drafts]);

  // Manejo de cambio en el input de prefijo
  const handleDraftChange = (nodeId, val) => {
    setDrafts((prev) => ({
      ...prev,
      [nodeId]: val,
    }));
  };

  // Cuentas con modificaciones pendientes
  const dirtyNodes = useMemo(() => {
    return nodes.filter((n) => {
      const orig = (n.data?.prefix || '').trim();
      const current = (effectiveDrafts[n.id] || '').trim();
      return orig !== current;
    });
  }, [nodes, effectiveDrafts]);

  // Mapa de conteo de prefijos para detectar colisiones en tiempo real
  const prefixCounts = useMemo(() => {
    const counts = {};
    Object.values(effectiveDrafts).forEach((p) => {
      const trimmed = p.trim();
      if (trimmed && !trimmed.startsWith('unlinked_')) {
        counts[trimmed] = (counts[trimmed] || 0) + 1;
      }
    });
    return counts;
  }, [effectiveDrafts]);

  // Filtrado reactivo por categoría y búsqueda
  const filteredNodes = useMemo(() => {
    return nodes.filter((n) => {
      const email = (n.data?.email || n.id).toLowerCase();
      const fileName = (n.data?.fileName || n.id).toLowerCase();
      const prefix = (effectiveDrafts[n.id] || '').toLowerCase();
      const prov = (n.data?.provider || n.data?.accountType || '').toLowerCase();

      // 1. Filtro de búsqueda
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        const match = email.includes(q) || fileName.includes(q) || prefix.includes(q);
        if (!match) return false;
      }

      // 2. Filtro por categoría / familia (compatible con prefijos en disco y con membresía en PoolRegistry)
      const memberPool = registeredPools.find(
        (p) =>
          p.leader_auth === fileName ||
          (Array.isArray(p.members) && p.members.includes(fileName)) ||
          (Array.isArray(p.reserves) && p.reserves.includes(fileName))
      );
      const poolFam = (memberPool?.family || '').toLowerCase();

      if (filterCategory === 'all') return true;
      if (filterCategory === 'gemini') {
        if (poolFam.startsWith('gemini_pure')) return true;
        // Gemini puro: agy, agy2, agy_1, agy2_1, g1, g2, g3, gemini
        // Exclude agy_clau (Claude del paquete)
        return (
          prefix.includes('g1') || prefix.includes('g2') || prefix.includes('g3') || prefix.includes('gemini') ||
          /^agy\d*$/.test(prefix) || /^agy\d*_\d+$/.test(prefix)
        );
      }
      if (filterCategory === 'claude') {
        if (poolFam.includes('claude') || poolFam.includes('sonnet') || poolFam.includes('opus')) return true;
        return (
          prefix.includes('son') ||
          prefix.includes('claude') ||
          prefix.includes('clau') ||
          prefix.includes('opus')
        );
      }
      if (filterCategory === 'agy_son') {
        if (poolFam.includes('sonnet')) return true;
        return (
          prefix.startsWith('agy_son') ||
          fileName.includes('agy_son')
        );
      }
      if (filterCategory === 'agy_opus') {
        if (poolFam.includes('opus')) return true;
        return (
          prefix.startsWith('agy_opus') ||
          fileName.includes('agy_opus')
        );
      }
      if (filterCategory === 'agy_clau') {
        if (poolFam.includes('gemini_claude')) return true;
        return (
          prefix.startsWith('agy_clau') ||
          fileName.includes('agy_clau')
        );
      }
      if (filterCategory === 'codex') {
        if (poolFam.includes('codex')) return true;
        return prov === 'codex' || prefix.includes('codex');
      }
      if (filterCategory === 'free') {
        return !memberPool && (!prefix || prefix.startsWith('unlinked_'));
      }
      if (filterCategory === 'antigravity') {
        return prov === 'antigravity';
      }
      if (filterCategory === 'others') {
        return prov !== 'antigravity' && prov !== 'codex';
      }
      return true;
    });
  }, [nodes, effectiveDrafts, searchQuery, filterCategory, registeredPools]);

  // Paginación sobre los nodos filtrados
  const totalPages = pageSize === 0 ? 1 : Math.max(1, Math.ceil(filteredNodes.length / pageSize));
  const safeCurrentPage = Math.min(currentPage, totalPages);

  // Normalizar página activa si el total de páginas disminuye
  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [totalPages, currentPage]);

  const paginatedNodes = useMemo(() => {
    if (pageSize === 0) return filteredNodes;
    const start = (safeCurrentPage - 1) * pageSize;
    return filteredNodes.slice(start, start + pageSize);
  }, [filteredNodes, safeCurrentPage, pageSize]);

  // Guardar cambio de una sola fila mediante PATCH
  const handleSaveRow = async (node) => {
    const fileName = node.data?.fileName || node.id;
    const newPrefix = (effectiveDrafts[node.id] || '').trim();
    setSavingRowId(node.id);
    setStatusMessage('');
    setErrorMessage('');

    try {
      const res = await saveAuthFilePrefixes([{ name: fileName, prefix: newPrefix }]);
      if (res.successful && res.successful.length > 0) {
        setStatusMessage(`✓ Prefijo "${newPrefix}" guardado para ${fileName}`);
        if (typeof onReloadRequested === 'function') {
          onReloadRequested();
        }
      } else {
        throw new Error('Error al guardar en el servidor');
      }
    } catch (err) {
      setErrorMessage(`Error guardando ${fileName}: ${err.message}`);
    } finally {
      setSavingRowId(null);
    }
  };

  // Guardar todo en lote
  const handleSaveBatch = async () => {
    if (dirtyNodes.length === 0) return;
    setIsSavingBatch(true);
    setStatusMessage('');
    setErrorMessage('');

    const filesToPatch = dirtyNodes.map((n) => ({
      name: n.data?.fileName || n.id,
      prefix: (effectiveDrafts[n.id] || '').trim(),
    }));

    try {
      const res = await saveAuthFilePrefixes(filesToPatch);
      if (res.successful && res.successful.length > 0) {
        setStatusMessage(`✓ ${res.successful.length} prefijos guardados con éxito.`);
        if (typeof onReloadRequested === 'function') {
          onReloadRequested();
        }
      }
      if (res.failed && res.failed.length > 0) {
        setErrorMessage(`⚠️ ${res.failed.length} archivos fallaron al actualizarse.`);
      }
    } catch (err) {
      setErrorMessage(`Fallo general al guardar en lote: ${err.message}`);
    } finally {
      setIsSavingBatch(false);
    }
  };

  return (
    <div className="pm-container" data-testid="prefix-manager-view">
      {/* 1. Hero & Guía de Enrutamiento */}
      <div className="pm-hero-bar">
        <div>
          <h2 className="pm-hero-title">
            <span>📋</span>
            <span>Directorio de Cuentas & Auditoría de Prefijos</span>
          </h2>
          <p className="pm-hero-desc">
            Consulta el estado de tus cuentas vinculadas. La asignación normal y balanceo de prefijos se gestiona de forma automática en <strong>🛠️ Crear Group/Perfiles</strong>. La edición manual en esta tabla está reservada para ajustes avanzados o casos de emergencia.
          </p>
        </div>

        <div className="pm-guide-box">
          <div>• <strong>Creación Automática:</strong> Usa siempre <code>🛠️ Crear Group/Perfiles</code> para balanceo ordenado de Líder (ej: <code>agy</code>, <code>agy_clau</code>, <code>codex</code>) y Reservas (ej: <code>agy_1</code>, <code>agy_clau_1</code>).</div>
          <div>• <strong>Edición Manual de Emergencia:</strong> Puedes forzar un prefijo en disco aquí si necesitas un rescate técnico manual.</div>
        </div>
      </div>

      {/* Alertas efímeras */}
      {statusMessage && (
        <div style={{ padding: '8px 14px', background: 'rgba(16, 185, 129, 0.2)', border: '1px solid #10b981', color: '#6ee7b7', borderRadius: 8, fontSize: 12, fontWeight: 700 }}>
          {statusMessage}
        </div>
      )}
      {errorMessage && (
        <div style={{ padding: '8px 14px', background: 'rgba(239, 68, 68, 0.2)', border: '1px solid #ef4444', color: '#fca5a5', borderRadius: 8, fontSize: 12, fontWeight: 700 }}>
          {errorMessage}
        </div>
      )}

      {/* 2. Barra de Búsqueda y Filtros Rápidos */}
      <div className="pm-toolbar">
        <div className="pm-search-row">
          <div className="pm-search-input-wrap">
            <span className="pm-search-icon">🔍</span>
            <input
              type="text"
              placeholder="Buscar por correo, prefijo o archivo .json..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pm-search-input"
              data-testid="input-search-prefix"
            />
          </div>

          <div className="pm-filter-chips">
            <button
              type="button"
              className={`pm-filter-chip ${filterCategory === 'all' ? 'active' : ''}`}
              onClick={() => setFilterCategory('all')}
            >
              🌐 Todos ({nodes.length})
            </button>
            <button
              type="button"
              className={`pm-filter-chip ${filterCategory === 'gemini' ? 'active' : ''}`}
              onClick={() => setFilterCategory('gemini')}
              data-testid="filter-chip-gemini"
            >
              ♊ Gemini
            </button>
            <button
              type="button"
              className={`pm-filter-chip ${filterCategory === 'claude' ? 'active' : ''}`}
              onClick={() => setFilterCategory('claude')}
              data-testid="filter-chip-claude"
            >
              🟣 Claude
            </button>
            <button
              type="button"
              className={`pm-filter-chip ${filterCategory === 'agy_clau' ? 'active' : ''}`}
              onClick={() => setFilterCategory('agy_clau')}
              data-testid="filter-chip-agy-clau"
            >
              🎭 Claude Suite (agy_son/opus)
            </button>
            <button
              type="button"
              className={`pm-filter-chip ${filterCategory === 'agy_son' ? 'active' : ''}`}
              onClick={() => setFilterCategory('agy_son')}
              data-testid="filter-chip-agy-son"
            >
              🔶 Sonnet (agy_son)
            </button>
            <button
              type="button"
              className={`pm-filter-chip ${filterCategory === 'agy_opus' ? 'active' : ''}`}
              onClick={() => setFilterCategory('agy_opus')}
              data-testid="filter-chip-agy-opus"
            >
              🔮 Opus (agy_opus)
            </button>
            <button
              type="button"
              className={`pm-filter-chip ${filterCategory === 'codex' ? 'active' : ''}`}
              onClick={() => setFilterCategory('codex')}
            >
              🔵 Codex
            </button>
            <button
              type="button"
              className={`pm-filter-chip ${filterCategory === 'free' ? 'active' : ''}`}
              onClick={() => setFilterCategory('free')}
            >
              ⚪ Sin Prefijo
            </button>
            <button
              type="button"
              className={`pm-filter-chip ${filterCategory === 'antigravity' ? 'active' : ''}`}
              onClick={() => setFilterCategory('antigravity')}
            >
              🟢 Antigravity
            </button>
            <button
              type="button"
              className={`pm-filter-chip ${filterCategory === 'others' ? 'active' : ''}`}
              onClick={() => setFilterCategory('others')}
            >
              🛠️ Especialistas
            </button>
          </div>
        </div>
      </div>

      {/* 3. Tabla Maestra de Cuentas y Prefijos */}
      <div className="pm-table-card">
        <div className="pm-table-responsive-wrapper">
          <table className="pm-table">
          <thead>
            <tr>
              <th>PROVEEDOR</th>
              <th>CUENTA / CORREO</th>
              <th>ARCHIVO FÍSICO (.JSON)</th>
              <th>ROL / TOPOLOGÍA</th>
              <th>POOL ASIGNADO</th>
              <th>PREFIJO ASIGNADO</th>
              <th>ACCIÓN</th>
            </tr>
          </thead>
          <tbody>
            {paginatedNodes.map((n) => {
              const fileName = n.data?.fileName || n.id;
              const classification = classifyAuthAccount(n);
              const email = classification.email || n.data?.email || n.data?.account || fileName;
              const prov = (n.data?.provider || n.data?.accountType || 'ANTIGRAVITY').toUpperCase();
              const currentVal = effectiveDrafts[n.id] || '';
              const origVal = (n.data?.prefix || '').trim();
              const isDirty = currentVal.trim() !== origVal;
              const isCollision = (prefixCounts[currentVal.trim()] || 0) > 1;
              // Buscar si pertenece a un pool registrado
              const memberPool = registeredPools.find(
                (p) =>
                  p.leader_auth === fileName ||
                  (Array.isArray(p.members) && p.members.includes(fileName)) ||
                  (Array.isArray(p.reserves) && p.reserves.includes(fileName))
              );
              const isRAMLeader = memberPool?.active_leader === fileName;
              const assignedModel = memberPool?.member_models?.[fileName] || memberPool?.policy?.target_models?.[0] || '';
              const roleInfo = classifyPrefixRole(currentVal, memberPool, fileName);
              const isSavingThis = savingRowId === n.id;

              return (
                <tr key={n.id} data-testid={`prefix-row-${n.id}`}>
                  <td>
                    <span className="pm-provider-badge" style={{
                      fontWeight: 800,
                      color: prov === 'CODEX' ? '#79c0ff' : prov === 'ANTIGRAVITY' ? '#4ade80' : '#c084fc',
                      background: prov === 'CODEX' ? 'rgba(56, 189, 248, 0.12)' : prov === 'ANTIGRAVITY' ? 'rgba(74, 222, 128, 0.12)' : 'rgba(192, 132, 252, 0.12)',
                    }}>
                      {prov}
                    </span>
                  </td>
                  <td>
                    <div className="pm-email-cell" title={email}>{email}</div>
                  </td>
                  <td>
                    <div className="pm-filename-cell" title={fileName}>{fileName}</div>
                  </td>
                  <td>
                    <span className={`pm-role-badge ${roleInfo.badgeClass}`}>
                      {roleInfo.label}
                    </span>
                  </td>
                  <td>
                    {memberPool ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <span style={{ fontSize: 12, fontWeight: 700, color: '#38bdf8' }}>
                          📦 {memberPool.id}
                        </span>
                        {isRAMLeader && (
                          <span style={{ fontSize: 10, fontWeight: 700, color: '#fde047', background: 'rgba(234, 179, 8, 0.15)', padding: '2px 6px', borderRadius: 4, width: 'fit-content' }}>
                            👑 Activo en RAM
                          </span>
                        )}
                        {assignedModel && (
                          <span style={{ fontSize: 10, fontWeight: 600, color: '#a78bfa', background: 'rgba(167, 139, 250, 0.12)', padding: '2px 6px', borderRadius: 4, width: 'fit-content', border: '1px solid rgba(167, 139, 250, 0.25)' }}>
                            🎯 {assignedModel}
                          </span>
                        )}
                      </div>
                    ) : (
                      <span style={{ fontSize: 12, color: '#64748b' }}>—</span>
                    )}
                  </td>
                  <td>
                    {memberPool ? (
                      <div className="pm-prefix-readonly-box" data-testid={`prefix-readonly-${n.id}`}>
                        {roleInfo.role === 'leader' ? (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span style={{
                              fontFamily: 'ui-monospace, monospace',
                              fontSize: 12.5,
                              fontWeight: 700,
                              color: '#38bdf8',
                              background: 'rgba(56, 189, 248, 0.15)',
                              padding: '4px 9px',
                              borderRadius: 5,
                              border: '1px solid rgba(56, 189, 248, 0.35)',
                            }}>
                              🏷️ {currentVal || memberPool.base_prefix}
                            </span>
                            <span style={{ fontSize: 11, color: '#94a3b8' }}>Ruta activa</span>
                          </div>
                        ) : (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span style={{
                              fontFamily: 'ui-monospace, monospace',
                              fontSize: 12.5,
                              fontWeight: 600,
                              color: '#cbd5e1',
                              background: 'rgba(51, 65, 85, 0.4)',
                              padding: '4px 9px',
                              borderRadius: 5,
                              border: '1px solid rgba(71, 85, 105, 0.5)',
                            }}>
                              🔒 {memberPool.base_prefix}_{roleInfo.label.match(/#(\d+)/)?.[1] || '1'} (Virtual)
                            </span>
                            <span style={{ fontSize: 11, color: '#64748b' }}>Failover en RAM</span>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="pm-prefix-input-group">
                        <input
                          type="text"
                          value={currentVal}
                          onChange={(e) => handleDraftChange(n.id, e.target.value)}
                          placeholder="e.g. agy, agy_1, codex"
                          className={`pm-prefix-input ${isCollision ? 'collision' : ''} ${isDirty ? 'dirty' : ''}`}
                          data-testid={`input-prefix-${n.id}`}
                        />
                        {isCollision && (
                          <span title="¡Atención! Este prefijo está repetido en más de una cuenta" style={{ fontSize: 13, cursor: 'help' }}>
                            ⚠️
                          </span>
                        )}
                      </div>
                    )}
                  </td>
                  <td>
                    {memberPool ? (
                      <span
                        style={{
                          fontSize: 12,
                          fontWeight: 700,
                          color: '#34d399',
                          background: 'rgba(16, 185, 129, 0.15)',
                          padding: '5px 12px',
                          borderRadius: 6,
                          border: '1px solid rgba(16, 185, 129, 0.3)',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 5,
                          whiteSpace: 'nowrap',
                        }}
                        title="Gestión automatizada por Auto Switcher Pro. No requiere ni admite edición manual."
                      >
                        🛡️ Blindado por Pool
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => handleSaveRow(n)}
                        disabled={!isDirty || isSavingThis || isSavingBatch}
                        className="pm-btn-save-row"
                        data-testid={`btn-save-row-${n.id}`}
                      >
                        {isSavingThis ? '...' : isDirty ? '💾 Guardar' : '✓'}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
            {filteredNodes.length === 0 && (
              <tr>
                <td colSpan={7} style={{ textAlign: 'center', padding: '30px', color: '#64748b' }}>
                  No se encontraron cuentas que coincidan con el filtro seleccionado.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        </div>
      </div>

      {/* 4. Barra Inferior de Guardado y Paginación */}
      <div className="pm-footer-bar">
        <div className="pm-footer-stats">
          <span>Total Cuentas: <strong>{nodes.length}</strong></span>
          <span style={{ margin: '0 8px', color: '#475569' }}>•</span>
          <span>Filtradas: <strong>{filteredNodes.length}</strong></span>
          <span style={{ margin: '0 8px', color: '#475569' }}>•</span>
          <span>Modificadas: <strong style={{ color: dirtyNodes.length > 0 ? '#fde047' : '#94a3b8' }}>{dirtyNodes.length}</strong></span>
        </div>

        {/* Controles de Paginación */}
        <div className="pm-pagination-controls" data-testid="pm-pagination-controls">
          <div className="pm-page-size-wrap">
            <span>Mostrar:</span>
            <select
              value={pageSize}
              onChange={(e) => setPageSize(Number(e.target.value))}
              className="pm-page-size-select"
              data-testid="pm-page-size-select"
            >
              <option value={15}>15 por pág</option>
              <option value={25}>25 por pág</option>
              <option value={50}>50 por pág</option>
              <option value={0}>Ver todo ({filteredNodes.length})</option>
            </select>
          </div>

          {pageSize > 0 && totalPages > 1 && (
            <div className="pm-pagination-buttons">
              <button
                type="button"
                className="pm-btn-page"
                onClick={() => setCurrentPage(1)}
                disabled={safeCurrentPage <= 1}
                title="Primera página"
                data-testid="pm-btn-first-page"
              >
                «
              </button>
              <button
                type="button"
                className="pm-btn-page"
                onClick={() => setCurrentPage(Math.max(1, safeCurrentPage - 1))}
                disabled={safeCurrentPage <= 1}
                title="Página anterior"
                data-testid="pm-btn-prev-page"
              >
                ‹
              </button>
              <span className="pm-page-indicator" data-testid="pm-page-indicator">
                Pág <strong>{safeCurrentPage}</strong> de <strong>{totalPages}</strong>
              </span>
              <button
                type="button"
                className="pm-btn-page"
                onClick={() => setCurrentPage(Math.min(totalPages, safeCurrentPage + 1))}
                disabled={safeCurrentPage >= totalPages}
                title="Página siguiente"
                data-testid="pm-btn-next-page"
              >
                ›
              </button>
              <button
                type="button"
                className="pm-btn-page"
                onClick={() => setCurrentPage(totalPages)}
                disabled={safeCurrentPage >= totalPages}
                title="Última página"
                data-testid="pm-btn-last-page"
              >
                »
              </button>
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {dirtyNodes.length > 0 && (
            <button
              type="button"
              onClick={handleSaveBatch}
              disabled={isSavingBatch}
              className="pm-btn-batch-save"
              data-testid="btn-save-batch-prefixes"
            >
              <span>💾</span>
              <span>{isSavingBatch ? 'Guardando...' : `Guardar Todo en Lote (${dirtyNodes.length})`}</span>
            </button>
          )}

          {typeof onReloadRequested === 'function' && (
            <button
              type="button"
              onClick={onReloadRequested}
              className="btn btn-outline"
              style={{ fontSize: 12, padding: '7px 14px' }}
            >
              🔄 Recargar Cuentas
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
