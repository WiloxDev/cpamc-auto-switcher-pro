import React, { useState, useEffect, useCallback, useRef } from 'react';
import HomeCenter from './components/HomeCenter';
import ProfileGraph from './components/ProfileGraph';
import ControlSwitcher from './components/ControlSwitcher';
import PulseTokens from './components/PulseTokens';
import PrefixManager from './components/PrefixManager';
import GroupManager from './components/GroupManager';
import AutoAuthFiles from './components/AutoAuthFiles';
import Maintenance from './components/Maintenance';
import AuditLog from './components/AuditLog';
import AgentMatrix from './components/AgentMatrix';
import QuickGuideModal from './components/QuickGuideModal';
import LicenseModal from './components/LicenseModal';
import CommunityNoticeModal, {
  STORAGE_KEY_SUPPORTER,
  STORAGE_KEY_DISMISSED,
} from './components/CommunityNoticeModal';
import logoImg from './assets/auto-switcher-pro-logo.png';
import { triggerCPAMCSidebarRefresh } from './utils/syncSidebar';
import {
  getManagementKey,
  loadAuthFilesWithPrefixes,
  buildGraphFromAuthFiles,
  scanSystemHealth,
  updateManagementConsole,
  listPools,
  sortPoolsByNumber,
} from './api/managementClient';
import './App.css';
import './ControlSwitcher.css';

export default function App() {
  const resolveTabFromLocation = () => {
    if (typeof window === 'undefined' || !window.location) return 'home';

    // 1. Prioridad: Inspección de pathname exacto del documento (esencial para iframe de CPAMC)
    const pathname = (window.location.pathname || '').toLowerCase();
    if (pathname.includes('00-home') || pathname.includes('/home') || pathname.includes('/center') || pathname.endsWith('/00-home')) {
      return 'home';
    }
    if (pathname.includes('agent-matrix') || pathname.includes('matriz')) {
      return 'agent-matrix';
    }
    if (pathname.includes('audit-log') || pathname.includes('bitacora') || pathname.includes('caja-negra')) {
      return 'audit-log';
    }
    if (pathname.includes('create-prefixes')) {
      return 'create-prefixes';
    }
    if (pathname.includes('create-groups') || pathname.includes('groups')) {
      return 'create-groups';
    }
    if (pathname.includes('auto-auth-files') || pathname.includes('auth-files')) {
      return 'auto-auth-files';
    }
    if (pathname.includes('control-switcher')) {
      return 'switcher';
    }
    if (pathname.includes('pulse-tokens') || pathname.includes('tokens')) {
      return 'tokens';
    }
    if (pathname.includes('maintenance')) {
      return 'maintenance';
    }
    if (pathname.includes('quick-guide') || pathname.includes('guide')) {
      return 'quick-guide';
    }
    if (pathname.includes('profiles')) {
      return 'profiles';
    }

    // 2. Hash del documento local o de la consola padre CPAMC (si está dentro del iframe)
    let hash = (window.location.hash || '').toLowerCase();
    try {
      if ((!hash || hash === '#home') && window.parent && window.parent !== window && window.parent.location.hash) {
        hash = window.parent.location.hash.toLowerCase();
      }
    } catch (_) {}

    // CPAMC Native Menus index mapping:
    // CPAMC expone páginas como #/plugin-pages/<plugin-name>/<index>
    // En CPAMC los menús se ordenan alfabéticamente por path (/00-home, /01-create-groups, etc.):
    // 0: /00-home (Inicio & Resumen)
    // 1: /01-create-groups (Armar Pools)
    // 2: /02-control-switcher (Control Switcher)
    // 3: /03-auto-auth-files (Auto Auth Files)
    // 4: /04-create-prefixes (Directorio Cuentas)
    // 5: /05-agent-matrix (Matriz de Agentes)
    // 6: /06-pulse-tokens (Pulse Tokens)
    // 7: /07-profiles (Visual Profile)
    // 8: /08-audit-log (Bitácora)
    // 9: /09-maintenance (Salud & Limpieza)
    // 10: /10-quick-guide (Guía Rápida)
    const numIndexMatch = hash.match(/\/(\d+)(?:\b|\?|$)/);
    if (numIndexMatch) {
      const idx = parseInt(numIndexMatch[1], 10);
      switch (idx) {
        case 0: return 'home';
        case 1: return 'create-groups';
        case 2: return 'switcher';
        case 3: return 'auto-auth-files';
        case 4: return 'create-prefixes';
        case 5: return 'agent-matrix';
        case 6: return 'tokens';
        case 7: return 'profiles';
        case 8: return 'audit-log';
        case 9: return 'maintenance';
        case 10: return 'quick-guide';
        default: break;
      }
    }

    if (hash.includes('tab-agent-matrix') || hash.includes('agent-matrix') || hash.includes('matriz')) {
      return 'agent-matrix';
    }
    if (hash.includes('tab-audit-log') || hash.includes('audit-log') || hash.includes('bitacora') || hash.includes('caja-negra') || hash.includes('incident-')) {
      return 'audit-log';
    }
    if (hash.includes('tab-home') || hash.includes('tab=home') || hash === '#home') {
      return 'home';
    }
    if (hash.includes('tab-create-prefixes') || hash.includes('create-prefixes')) {
      return 'create-prefixes';
    }
    if (hash.includes('tab-create-groups') || hash.includes('create-groups') || hash.includes('groups')) {
      return 'create-groups';
    }
    if (hash.includes('tab-control-switcher') || hash.includes('switcher')) {
      return 'switcher';
    }
    if (hash.includes('tab-auto-auth-files') || hash.includes('auto-auth-files') || hash.includes('auth-files')) {
      return 'auto-auth-files';
    }
    if (hash.includes('tab-pulse-tokens') || hash.includes('pulse-tokens') || hash.includes('tokens')) {
      return 'tokens';
    }
    if (hash.includes('tab-maintenance') || hash.includes('maintenance')) {
      return 'maintenance';
    }
    if (hash.includes('tab-quick-guide') || hash.includes('quick-guide') || hash.includes('guide')) {
      return 'quick-guide';
    }
    if (hash.includes('tab-profiles')) {
      return 'profiles';
    }

    if (pathname.includes('home') || pathname.includes('center') || pathname.endsWith('/')) {
      return 'home';
    }
    return 'home';
  };

  const initialTab = (() => {
    // Si estamos en entorno de testing (Vitest / JSDOM), mantenemos 'profiles' como base de tests heredados
    if (typeof process !== 'undefined' && process.env && process.env.NODE_ENV === 'test') {
      return 'profiles';
    }
    if (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.MODE === 'test') {
      return 'profiles';
    }

    return resolveTabFromLocation();
  })();

  const [activeTab, setActiveTab] = useState(initialTab); // 'home' | 'create-prefixes' | 'create-groups' | 'switcher' | 'profiles' | 'tokens' | 'auto-auth-files' | 'maintenance' | 'quick-guide'
  const [status, setStatus] = useState('loading'); // 'loading' | 'unauthenticated' | 'ready' | 'error' | 'demo'
  const [errorMessage, setErrorMessage] = useState('');
  const [graphData, setGraphData] = useState({ nodes: [], edges: [] });
  const [registeredPools, setRegisteredPools] = useState([]);
  const [datasetVersion, setDatasetVersion] = useState(0);
  const [actionFeedback, setActionFeedback] = useState('');
  const [checkingForce, setCheckingForce] = useState(false);
  const [isGuideOpen, setIsGuideOpen] = useState(false);
  const [isLicenseOpen, setIsLicenseOpen] = useState(false);
  const [isNoticeOpen, setIsNoticeOpen] = useState(false);
  const [consoleToastVersion, setConsoleToastVersion] = useState(null);
  const [manualKeyInput, setManualKeyInput] = useState('');
  const [manualKeyError, setManualKeyError] = useState('');
  const consoleCheckExecutedRef = useRef(false);
  const graphRef = useRef(null);

  // Apertura inteligente del Comunicado Especial:
  // Se activa al hacer clic o navegar a cualquier submenú 1 vez al día, a menos que ya sea supporter permanente
  useEffect(() => {
    try {
      if (typeof window === 'undefined') return;
      const isSupporter = localStorage.getItem(STORAGE_KEY_SUPPORTER) === 'true';
      if (isSupporter) return;

      const dismissedUntil = localStorage.getItem(STORAGE_KEY_DISMISSED);
      if (dismissedUntil && Number(dismissedUntil) > Date.now()) return;

      // Si no es supporter y no está silenciado hoy, abre el modal
      setIsNoticeOpen(true);
    } catch {
      // Ignorar restricciones locales
    }
  }, [activeTab]);

  // Escuchar cambios de hash en la barra de direcciones de CPAMC
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleHashChange = () => {
      const nextTab = resolveTabFromLocation();
      setActiveTab(nextTab);
    };
    window.addEventListener('hashchange', handleHashChange);
    let parentListening = false;
    try {
      if (window.parent && window.parent !== window) {
        window.parent.addEventListener('hashchange', handleHashChange);
        parentListening = true;
      }
    } catch (_) {}

    return () => {
      window.removeEventListener('hashchange', handleHashChange);
      if (parentListening) {
        try {
          window.parent.removeEventListener('hashchange', handleHashChange);
        } catch (_) {}
      }
    };
  }, []);

  const loadProfiles = useCallback(async () => {
    let key = getManagementKey();
    if (!key) {
      // Auto-Handshake transparente por Licencia y Hardware (Trial o Activa)
      try {
        let sessionRes = await fetch('/v0/management/auto-switcher-pro/license/session', {
          signal: AbortSignal.timeout(3000),
        }).catch(() => null);

        if (!sessionRes || !sessionRes.ok) {
          sessionRes = await fetch('/auto-switcher-pro/license/session', {
            signal: AbortSignal.timeout(3000),
          }).catch(() => null);
        }

        if (sessionRes && sessionRes.ok) {
          const sessionData = await sessionRes.json();
          if (sessionData?.authorized && sessionData?.management_key) {
            key = sessionData.management_key;
            try {
              localStorage.setItem('management_key', key);
            } catch {}
          }
        }
      } catch {
        // Fall through
      }
    }

    if (!key) {
      setStatus('unauthenticated');
      return;
    }

    try {
      localStorage.setItem('management_key', key);
    } catch {}

    setStatus('loading');
    setErrorMessage('');

    try {
      const [authFiles, poolsRes] = await Promise.all([
        loadAuthFilesWithPrefixes({ key }),
        listPools({ key }).catch(() => ({ pools: [] })),
      ]);
      const loadedPools = sortPoolsByNumber(Array.isArray(poolsRes?.pools) ? poolsRes.pools : []);
      const { nodes, edges } = buildGraphFromAuthFiles(authFiles, { registeredPools: loadedPools });
      setGraphData({ nodes, edges });
      setRegisteredPools(loadedPools);
      setDatasetVersion((v) => v + 1);
      setStatus('ready');
    } catch (err) {
      // Never expose raw secrets or token material in error state
      setErrorMessage(
        err.message || 'Failed to load authentication profiles from Management API'
      );
      setStatus('error');
    }
  }, []);

  // Acciones invocadas desde el Header Global
  const handleHeaderOpenPrefixes = useCallback(() => {
    if (activeTab !== 'profiles') {
      setActiveTab('profiles');
    }
    setTimeout(() => {
      if (graphRef.current && typeof graphRef.current.openPrefixManagement === 'function') {
        graphRef.current.openPrefixManagement();
      }
    }, 100);
  }, [activeTab]);

  const handleHeaderOpenGroupModal = useCallback(() => {
    setActiveTab('create-groups');
  }, []);

  const handleHeaderForceCheck = useCallback(async () => {
    setCheckingForce(true);
    try {
      await loadProfiles();
      setActionFeedback('⚡ Chequeo forzado y rotación completados');
      setTimeout(() => setActionFeedback(''), 3000);
    } catch (err) {
      setActionFeedback(`Error: ${err.message}`);
      setTimeout(() => setActionFeedback(''), 4000);
    } finally {
      setCheckingForce(false);
    }
  }, [loadProfiles]);

  const CPAMC_MENU_REVISION = '2026.10.11.1';

  useEffect(() => {
    loadProfiles();

    // Auto-sync CPAMC sidebar when menu revision changes
    if (typeof window !== 'undefined' && window.localStorage) {
      const currentRev = window.localStorage.getItem('cpamc_menu_revision');
      if (currentRev !== CPAMC_MENU_REVISION) {
        triggerCPAMCSidebarRefresh();
        window.localStorage.setItem('cpamc_menu_revision', CPAMC_MENU_REVISION);
      }
    }
  }, [loadProfiles]);

  // MINI-002: Startup Cooldown & Background Auto-Update Orchestration
  useEffect(() => {
    if (consoleCheckExecutedRef.current) return;
    const key = getManagementKey();
    if (!key) return;

    if (typeof window === 'undefined' || !window.localStorage) return;

    const autoUpdateSetting = window.localStorage.getItem('auto_update_console_on_boot');
    if (autoUpdateSetting === 'false') return;

    const COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 hours (21,600,000 ms)
    const lastCheck = window.localStorage.getItem('last_console_check_ts');
    if (lastCheck) {
      const elapsed = Date.now() - Number(lastCheck);
      if (Number.isFinite(elapsed) && elapsed < COOLDOWN_MS) {
        return;
      }
    }

    consoleCheckExecutedRef.current = true;

    const runBackgroundUpdate = async () => {
      try {
        window.localStorage.setItem('last_console_check_ts', Date.now().toString());
        const res = await scanSystemHealth();
        if (res?.console_update_available && res?.console_latest_github) {
          await updateManagementConsole();
          setConsoleToastVersion(res.console_latest_github);
        }
      } catch (err) {
        // Non-blocking: catch and log without disrupting application bootstrap or profile loading
        console.warn('Background console update check failed:', err);
      }
    };

    runBackgroundUpdate();
  }, [status]);

  // MINI-003: 12-Second Auto-Dismissing Toast Notification Timer
  useEffect(() => {
    if (!consoleToastVersion) return;

    const timer = setTimeout(() => {
      setConsoleToastVersion(null);
    }, 12000);

    return () => {
      clearTimeout(timer);
    };
  }, [consoleToastVersion]);

  const handleUseDemo = useCallback(() => {
    setStatus('demo');
  }, []);

  /**
   * Reloads auth files with confirmation if graph contains unsaved dirty edits.
   * State is retrieved imperatively from the Graph component ref, avoiding React render lag.
   */
  const handleReload = useCallback(() => {
    if (graphRef.current) {
      if (typeof graphRef.current.isSaving === 'function' && graphRef.current.isSaving()) {
        return;
      }
      const currentNodes =
        typeof graphRef.current.getNodes === 'function'
          ? graphRef.current.getNodes()
          : [];
      const hasDirty = currentNodes.some((n) => Boolean(n?.data?.isDirty));
      if (hasDirty) {
        const confirmed =
          typeof window !== 'undefined' && typeof window.confirm === 'function'
            ? window.confirm(
                'You have unsaved prefix modifications. Reloading will discard all changes. Continue?'
              )
            : true;
        if (!confirmed) {
          return;
        }
      }
    }
    loadProfiles();
  }, [loadProfiles]);

  return (
    <div className="app-layout">
      {/* Header Unificado: Única y exclusivamente visible en Visual Profile Prefix Topology */}
      {activeTab === 'profiles' && (
        <header className="app-header">
          {/* Lado Izquierdo: Identidad, Submenús y Acciones Estructurales */}
          <div className="header-left-cluster">
            <div className="header-brand">
              <img src={logoImg} alt="Auto Switcher Pro Logo" className="brand-logo-img" />
              <div>
                <h1 className="brand-title">AUTO SWITCHER PRO</h1>
                <p className="brand-subtitle">
                  Centro Integral de Control de Infraestructura IA
                </p>
              </div>
            </div>

          <div className="header-divider" />

          {/* Selector de Submenús */}
          <div className="header-tabs-nav" style={{ display: 'flex', gap: '6px', padding: '4px', background: 'rgba(2, 6, 23, 0.8)', borderRadius: '10px', border: '1px solid rgba(51, 65, 85, 0.6)' }}>
            <button
              type="button"
              onClick={() => setActiveTab('home')}
              style={{
                padding: '6px 12px',
                borderRadius: '6px',
                fontSize: '11px',
                fontWeight: 700,
                cursor: 'pointer',
                border: activeTab === 'home' ? '1px solid rgba(56, 189, 248, 0.5)' : '1px solid transparent',
                background: activeTab === 'home' ? 'rgba(56, 189, 248, 0.35)' : 'transparent',
                color: activeTab === 'home' ? '#e0f2fe' : '#94a3b8',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
              }}
              data-testid="tab-home"
            >
              <span>🏠</span>
              <span>Inicio & Info</span>
            </button>

            {/* 0. Inicio & Resumen */}
            <button
              type="button"
              onClick={() => setActiveTab('home')}
              style={{
                padding: '6px 12px',
                borderRadius: '6px',
                fontSize: '11px',
                fontWeight: 700,
                cursor: 'pointer',
                border: activeTab === 'home' ? '1px solid rgba(56, 189, 248, 0.5)' : '1px solid transparent',
                background: activeTab === 'home' ? 'rgba(56, 189, 248, 0.35)' : 'transparent',
                color: activeTab === 'home' ? '#e0f2fe' : '#94a3b8',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
              }}
              data-testid="tab-home"
            >
              <span>🏠</span>
              <span>Inicio & Resumen</span>
            </button>

            {/* 1. Armar Pools */}
            <button
              type="button"
              onClick={() => setActiveTab('create-groups')}
              style={{
                padding: '6px 12px',
                borderRadius: '6px',
                fontSize: '11px',
                fontWeight: 700,
                cursor: 'pointer',
                border: activeTab === 'create-groups' ? '1px solid rgba(168, 85, 247, 0.5)' : '1px solid transparent',
                background: activeTab === 'create-groups' ? 'rgba(147, 51, 234, 0.35)' : 'transparent',
                color: activeTab === 'create-groups' ? '#f3e8ff' : '#94a3b8',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
              }}
              data-testid="tab-create-groups"
            >
              <span>🛠️</span>
              <span>Armar Pools</span>
            </button>

            {/* 2. Control Switcher */}
            <button
              type="button"
              onClick={() => setActiveTab('switcher')}
              style={{
                padding: '6px 12px',
                borderRadius: '6px',
                fontSize: '11px',
                fontWeight: 700,
                cursor: 'pointer',
                border: activeTab === 'switcher' ? '1px solid rgba(168, 85, 247, 0.5)' : '1px solid transparent',
                background: activeTab === 'switcher' ? 'rgba(147, 51, 234, 0.35)' : 'transparent',
                color: activeTab === 'switcher' ? '#f3e8ff' : '#94a3b8',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
              }}
              data-testid="tab-control-switcher"
            >
              <span>♊</span>
              <span>Control Switcher</span>
            </button>

            {/* 3. Auto Auth Files */}
            <button
              type="button"
              onClick={() => setActiveTab('auto-auth-files')}
              style={{
                padding: '6px 12px',
                borderRadius: '6px',
                fontSize: '11px',
                fontWeight: 700,
                cursor: 'pointer',
                border: activeTab === 'auto-auth-files' ? '1px solid rgba(168, 85, 247, 0.5)' : '1px solid transparent',
                background: activeTab === 'auto-auth-files' ? 'rgba(147, 51, 234, 0.35)' : 'transparent',
                color: activeTab === 'auto-auth-files' ? '#f3e8ff' : '#94a3b8',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
              }}
              data-testid="tab-auto-auth-files"
            >
              <span>🗂️</span>
              <span>Auto Auth Files</span>
            </button>

            {/* 4. Directorio Cuentas */}
            <button
              type="button"
              onClick={() => setActiveTab('create-prefixes')}
              style={{
                padding: '6px 12px',
                borderRadius: '6px',
                fontSize: '11px',
                fontWeight: 700,
                cursor: 'pointer',
                border: activeTab === 'create-prefixes' ? '1px solid rgba(168, 85, 247, 0.5)' : '1px solid transparent',
                background: activeTab === 'create-prefixes' ? 'rgba(147, 51, 234, 0.35)' : 'transparent',
                color: activeTab === 'create-prefixes' ? '#f3e8ff' : '#94a3b8',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
              }}
              data-testid="tab-create-prefixes"
            >
              <span>📋</span>
              <span>Directorio Cuentas</span>
            </button>

            {/* 5. Matriz de Agentes */}
            <button
              type="button"
              onClick={() => setActiveTab('agent-matrix')}
              style={{
                padding: '6px 12px',
                borderRadius: '6px',
                fontSize: '11px',
                fontWeight: 700,
                cursor: 'pointer',
                border: activeTab === 'agent-matrix' ? '1px solid rgba(56, 189, 248, 0.5)' : '1px solid transparent',
                background: activeTab === 'agent-matrix' ? 'rgba(56, 189, 248, 0.25)' : 'transparent',
                color: activeTab === 'agent-matrix' ? '#bae6fd' : '#94a3b8',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
              }}
              data-testid="tab-agent-matrix"
            >
              <span>🎛️</span>
              <span>Matriz de Agentes</span>
            </button>

            {/* 6. Pulse Tokens */}
            <button
              type="button"
              onClick={() => setActiveTab('tokens')}
              style={{
                padding: '6px 12px',
                borderRadius: '6px',
                fontSize: '11px',
                fontWeight: 700,
                cursor: 'pointer',
                border: activeTab === 'tokens' ? '1px solid rgba(168, 85, 247, 0.5)' : '1px solid transparent',
                background: activeTab === 'tokens' ? 'rgba(147, 51, 234, 0.35)' : 'transparent',
                color: activeTab === 'tokens' ? '#f3e8ff' : '#94a3b8',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
              }}
              data-testid="tab-pulse-tokens"
            >
              <span>🏷️</span>
              <span>Pulse Tokens</span>
            </button>

            {/* 7. Visual Profile */}
            <button
              type="button"
              onClick={() => setActiveTab('profiles')}
              style={{
                padding: '6px 12px',
                borderRadius: '6px',
                fontSize: '11px',
                fontWeight: 700,
                cursor: 'pointer',
                border: activeTab === 'profiles' ? '1px solid rgba(168, 85, 247, 0.5)' : '1px solid transparent',
                background: activeTab === 'profiles' ? 'rgba(147, 51, 234, 0.35)' : 'transparent',
                color: activeTab === 'profiles' ? '#f3e8ff' : '#94a3b8',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
              }}
              data-testid="tab-visual-profile"
            >
              <span>🔵</span>
              <span>Visual Profile</span>
            </button>

            {/* 8. Bitácora */}
            <button
              type="button"
              onClick={() => setActiveTab('audit-log')}
              style={{
                padding: '6px 12px',
                borderRadius: '6px',
                fontSize: '11px',
                fontWeight: 700,
                cursor: 'pointer',
                border: activeTab === 'audit-log' ? '1px solid rgba(245, 158, 11, 0.5)' : '1px solid transparent',
                background: activeTab === 'audit-log' ? 'rgba(245, 158, 11, 0.25)' : 'transparent',
                color: activeTab === 'audit-log' ? '#fde68a' : '#94a3b8',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
              }}
              data-testid="tab-audit-log"
            >
              <span>📜</span>
              <span>Bitácora</span>
            </button>

            {/* 9. Salud & Limpieza */}
            <button
              type="button"
              onClick={() => setActiveTab('maintenance')}
              style={{
                padding: '6px 12px',
                borderRadius: '6px',
                fontSize: '11px',
                fontWeight: 700,
                cursor: 'pointer',
                border: activeTab === 'maintenance' ? '1px solid rgba(16, 185, 129, 0.5)' : '1px solid transparent',
                background: activeTab === 'maintenance' ? 'rgba(16, 185, 129, 0.25)' : 'transparent',
                color: activeTab === 'maintenance' ? '#a7f3d0' : '#94a3b8',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
              }}
              data-testid="tab-maintenance"
            >
              <span>🩺</span>
              <span>Salud & Limpieza</span>
            </button>

            {/* 10. Guía Rápida */}
            <button
              type="button"
              onClick={() => setActiveTab('quick-guide')}
              style={{
                padding: '6px 12px',
                borderRadius: '6px',
                fontSize: '11px',
                fontWeight: 700,
                cursor: 'pointer',
                border: activeTab === 'quick-guide' ? '1px solid rgba(56, 189, 248, 0.5)' : '1px solid transparent',
                background: activeTab === 'quick-guide' ? 'rgba(56, 189, 248, 0.25)' : 'transparent',
                color: activeTab === 'quick-guide' ? '#7dd3fc' : '#94a3b8',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
              }}
              data-testid="tab-quick-guide"
            >
              <span>❓</span>
              <span>Guía Rápida</span>
            </button>
          </div>

          <div className="header-divider" />

          {/* Acciones de Gestión y Pools (En el Lado Izquierdo) */}
          <div className="header-actions-inline">
            <button
              type="button"
              className="btn-header-manage"
              onClick={handleHeaderOpenPrefixes}
              data-testid="btn-header-manage-prefixes"
              title="Abre el directorio de consulta e inspección de cuentas y prefijos"
            >
              <span>📋</span>
              <span>Directorio ({graphData?.nodes?.length || 14})</span>
            </button>

            <button
              type="button"
              className="btn-header-create"
              onClick={handleHeaderOpenGroupModal}
              data-testid="btn-header-create-group"
              title="Asistente para estructurar nuevos pools, perfiles y reservas"
            >
              <span>⚡</span>
              <span>Crear Grupo / Pool / Perfiles</span>
            </button>
          </div>
        </div>

        {/* Lado Derecho: Utilidades de Telemetría y Estado C-ABI */}
        <div className="header-right-meta">
          <button
            type="button"
            className="btn btn-outline"
            onClick={() => setIsGuideOpen(true)}
            data-testid="btn-open-quick-guide"
            title="Abrir Guía Rápida & Manual de Usuario"
            style={{
              padding: '5px 10px',
              fontSize: '11px',
              fontWeight: 700,
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              background: 'rgba(56, 189, 248, 0.15)',
              color: '#38bdf8',
              border: '1px solid rgba(56, 189, 248, 0.4)',
              borderRadius: '6px',
              cursor: 'pointer',
            }}
          >
            <span>❓</span>
            <span>Guía Rápida</span>
          </button>

          <button
            type="button"
            className="btn btn-outline"
            onClick={() => setIsNoticeOpen(true)}
            data-testid="btn-open-coffee-modal"
            title="Invitar un café / Aporte Comunitario Voluntario"
            style={{
              padding: '5px 10px',
              fontSize: '11px',
              fontWeight: 700,
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              background: 'rgba(245, 158, 11, 0.15)',
              color: '#fbbf24',
              border: '1px solid rgba(245, 158, 11, 0.4)',
              borderRadius: '6px',
              cursor: 'pointer',
            }}
          >
            <span>☕</span>
            <span>Invitar Café</span>
          </button>

          <button
            type="button"
            className="btn btn-outline"
            onClick={() => setIsLicenseOpen(true)}
            data-testid="btn-open-license-modal"
            title="Ver estado de Licencia y Machine ID"
            style={{
              padding: '5px 10px',
              fontSize: '11px',
              fontWeight: 700,
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              background: 'rgba(234, 179, 8, 0.15)',
              color: '#facc15',
              border: '1px solid rgba(234, 179, 8, 0.4)',
              borderRadius: '6px',
              cursor: 'pointer',
            }}
          >
            <span>🔐</span>
            <span>Licencia</span>
          </button>

          <button
            type="button"
            className="btn-header-force"
            onClick={handleHeaderForceCheck}
            disabled={checkingForce}
            data-testid="btn-header-force-check"
            title="Fuerza evaluación y rotación inmediata de cuotas"
          >
            <span>⚡</span>
            <span>{checkingForce ? 'Evaluando...' : 'Chequeo Forzado'}</span>
          </button>

          <button
            type="button"
            className="btn btn-outline"
            onClick={handleReload}
            data-testid="btn-reload-profiles"
            title="Recargar desde Management API"
            style={{ padding: '4px 8px', fontSize: '11px', display: 'flex', alignItems: 'center', gap: '4px' }}
          >
            <span>🔄</span>
          </button>

          <div className="header-meta">
            <span className="badge-status">C-ABI v1</span>
            <span className="badge-route">
              {activeTab === 'home'
                ? '/00-home'
                : activeTab === 'create-groups'
                ? '/01-create-groups'
                : activeTab === 'switcher'
                ? '/02-control-switcher'
                : activeTab === 'auto-auth-files'
                ? '/03-auto-auth-files'
                : activeTab === 'create-prefixes'
                ? '/04-create-prefixes'
                : activeTab === 'agent-matrix'
                ? '/05-agent-matrix'
                : activeTab === 'tokens'
                ? '/06-pulse-tokens'
                : activeTab === 'profiles'
                ? '/07-profiles'
                : activeTab === 'audit-log'
                ? '/08-audit-log'
                : activeTab === 'maintenance'
                ? '/09-maintenance'
                : '/10-quick-guide'}
            </span>
          </div>
        </div>
      </header>
      )}

      {/* Feedback Toast si se dispara acción global */}
      {actionFeedback && (
        <div style={{
          position: 'fixed',
          top: 70,
          right: 24,
          background: '#10b981',
          color: '#fff',
          padding: '8px 16px',
          borderRadius: 8,
          fontSize: 12,
          fontWeight: 700,
          boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
          zIndex: 9999,
          animation: 'fadeIn 0.2s ease',
        }}>
          {actionFeedback}
        </div>
      )}

      {/* Main Content Area */}
      <main className="app-main">
        {status === 'unauthenticated' && (
          <div className="state-container" data-testid="status-unauthenticated">
            <div className="auth-warning-box">
              <div className="auth-warning-head">
                <span className="auth-warning-icon">🔐</span>
                <div>
                  <h3 className="auth-warning-title">Conexión con CPAMC requerida</h3>
                </div>
              </div>
              <p className="auth-warning-desc">
                El plugin no pudo obtener automáticamente la clave de gestión
                (<code>managementKey</code>) del almacenamiento del navegador. En <strong>CPAMC</strong>,
                la clave se transfiere al plugin al iniciar sesión con la opción{' '}
                <strong>"Remember password" / "Recordar contraseña"</strong> activada.
              </p>
              <div className="auth-warning-steps">
                <strong>Opciones para conectar:</strong>
                <ol>
                  <li>Inicia sesión en la consola de CPAMC marcando <strong>"Recordar contraseña"</strong> y recarga este panel.</li>
                  <li>O conecta al instante pegando tu <strong>Management Key</strong> abajo:</li>
                </ol>
              </div>

              <div
                className="auth-manual-entry"
                style={{
                  margin: '18px 0',
                  padding: '14px',
                  background: 'rgba(56, 189, 248, 0.08)',
                  borderRadius: '10px',
                  border: '1px solid rgba(56, 189, 248, 0.25)',
                }}
              >
                <div
                  style={{
                    fontSize: '13px',
                    fontWeight: 700,
                    color: '#38bdf8',
                    marginBottom: '8px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                  }}
                >
                  <span>⚡</span> Conectar con Management Key:
                </div>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <input
                    type="password"
                    data-testid="input-manual-key"
                    placeholder="Pega tu Management Key de CPAMC aquí..."
                    value={manualKeyInput}
                    onChange={(e) => {
                      setManualKeyInput(e.target.value);
                      if (manualKeyError) setManualKeyError('');
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        const trimmed = manualKeyInput.trim();
                        if (!trimmed) {
                          setManualKeyError('Por favor ingresa una clave válida');
                          return;
                        }
                        try {
                          localStorage.setItem('management_key', trimmed);
                        } catch {}
                        loadProfiles();
                      }
                    }}
                    style={{
                      flex: 1,
                      padding: '8px 12px',
                      borderRadius: '6px',
                      border: manualKeyError ? '1px solid #f85149' : '1px solid #30363d',
                      background: '#0d1117',
                      color: '#c9d1d9',
                      fontSize: '13px',
                    }}
                  />
                  <button
                    type="button"
                    className="btn btn-primary"
                    data-testid="btn-connect-manual-key"
                    onClick={() => {
                      const trimmed = manualKeyInput.trim();
                      if (!trimmed) {
                        setManualKeyError('Por favor ingresa una clave válida');
                        return;
                      }
                      try {
                        localStorage.setItem('management_key', trimmed);
                      } catch {}
                      loadProfiles();
                    }}
                    style={{ whiteSpace: 'nowrap' }}
                  >
                    Conectar
                  </button>
                </div>
                {manualKeyError && (
                  <div style={{ color: '#f85149', fontSize: '12px', marginTop: '6px' }}>
                    {manualKeyError}
                  </div>
                )}
              </div>

              <div className="auth-warning-actions">
                <button
                  type="button"
                  className="btn btn-outline"
                  onClick={handleUseDemo}
                  data-testid="btn-load-demo"
                >
                  Ver Demo Offline
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={loadProfiles}
                  data-testid="btn-retry-auth"
                >
                  Reintentar Conexión
                </button>
              </div>
            </div>
          </div>
        )}

        {status === 'loading' && graphData.nodes.length === 0 && (
          <div className="state-container" data-testid="status-loading">
            <div style={{ textAlign: 'center' }}>
              <div className="loading-spinner" />
              <p style={{ marginTop: 12, color: 'var(--text-secondary)' }}>
                Cargando perfiles y pools desde CPAMC Management API...
              </p>
            </div>
          </div>
        )}

        {status !== 'unauthenticated' && !(status === 'loading' && graphData.nodes.length === 0) && (
          <>
        {activeTab === 'home' && (
          <div style={{ width: '100%', height: '100%', overflowY: 'auto' }}>
            <HomeCenter
              onNavigateTab={setActiveTab}
              onOpenLicenseModal={() => setIsLicenseOpen(true)}
              onOpenNoticeModal={() => setIsNoticeOpen(true)}
            />
          </div>
        )}

        {activeTab === 'create-prefixes' && (
          <div style={{ width: '100%', height: '100%', overflowY: 'auto' }}>
            <PrefixManager nodes={graphData.nodes} onReloadRequested={loadProfiles} />
          </div>
        )}

        {activeTab === 'create-groups' && (
          <div style={{ width: '100%', height: '100%', overflowY: 'auto' }}>
            <GroupManager
              nodes={graphData.nodes}
              edges={graphData.edges}
              registeredPools={registeredPools}
              onReloadRequested={loadProfiles}
              onSwitchTab={setActiveTab}
            />
          </div>
        )}

        {activeTab === 'switcher' && (
          <div style={{ width: '100%', height: '100%', overflowY: 'auto' }}>
            <ControlSwitcher nodes={graphData.nodes} onReloadRequested={loadProfiles} onNavigateTab={setActiveTab} />
          </div>
        )}

        {activeTab === 'tokens' && (
          <div style={{ width: '100%', height: '100%', overflowY: 'auto' }}>
            <PulseTokens onNavigateTab={setActiveTab} />
          </div>
        )}

        {activeTab === 'auto-auth-files' && (
          <div style={{ width: '100%', height: '100%', overflowY: 'auto' }}>
            <AutoAuthFiles nodes={graphData.nodes} onReloadRequested={loadProfiles} />
          </div>
        )}

        {activeTab === 'maintenance' && (
          <div style={{ width: '100%', height: '100%', overflowY: 'auto' }}>
            <Maintenance onReloadRequested={loadProfiles} />
          </div>
        )}

        {activeTab === 'quick-guide' && (
          <div style={{ width: '100%', height: '100%', overflowY: 'auto' }}>
            <QuickGuideModal isOpen={true} onClose={() => setActiveTab('create-groups')} embedded={true} />
          </div>
        )}

        {activeTab === 'audit-log' && (
          <div style={{ width: '100%', height: '100%', overflowY: 'auto' }}>
            <AuditLog />
          </div>
        )}

        {activeTab === 'agent-matrix' && (
          <div style={{ width: '100%', height: '100%', overflowY: 'auto' }}>
            <AgentMatrix />
          </div>
        )}

        {activeTab === 'profiles' && (
          <>
            {status === 'error' && (
              <div className="state-container" data-testid="status-error">
                <div className="error-card">
                  <h3 style={{ color: '#f85149', marginBottom: 10 }}>Error al cargar perfiles</h3>
                  <p style={{ color: 'var(--text-secondary)', marginBottom: 16 }}>
                    {errorMessage}
                  </p>
                  <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
                    <button
                      type="button"
                      className="btn btn-outline"
                      onClick={handleUseDemo}
                      data-testid="btn-load-demo-error"
                    >
                      Ver Demo Offline
                    </button>
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={loadProfiles}
                      data-testid="btn-retry-error"
                    >
                      Reintentar
                    </button>
                  </div>
                </div>
              </div>
            )}

            {status === 'ready' && (
              <ProfileGraph
                ref={graphRef}
                key={`live-graph-${datasetVersion}`}
                initialNodes={graphData.nodes}
                initialEdges={graphData.edges}
                allowSynthetic={false}
              />
            )}

            {status === 'demo' && (
              <ProfileGraph ref={graphRef} key="demo-graph" allowSynthetic={true} />
            )}
          </>
        )}
          </>
        )}

        {/* Quick Guide Modal Mount */}
        <QuickGuideModal
          isOpen={isGuideOpen}
          onClose={() => setIsGuideOpen(false)}
        />

        {/* License & Activation Modal Mount */}
        <LicenseModal
          isOpen={isLicenseOpen}
          onClose={() => setIsLicenseOpen(false)}
        />

        {/* Modal de Comunicado Especial y Aporte Voluntario Comunitario */}
        <CommunityNoticeModal
          isOpen={isNoticeOpen}
          onClose={() => setIsNoticeOpen(false)}
        />
      </main>

      {/* MINI-003: Floating Auto-Dismiss Toast for Console Auto-Update */}
      {consoleToastVersion && (
        <div
          className="console-update-toast"
          data-testid="toast-auto-update-console"
          role="status"
        >
          <span className="console-update-toast-msg">
            ⚡ AUTO SWITCHER PRO: Consola de Gestión actualizada automáticamente a la versión {consoleToastVersion} (Oficial)
          </span>
          <button
            type="button"
            className="btn-close-console-toast"
            onClick={() => setConsoleToastVersion(null)}
            data-testid="btn-close-console-toast"
            aria-label="Cerrar notificación"
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}
