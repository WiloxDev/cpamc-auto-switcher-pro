import React, { useState, useEffect } from 'react';
import './LicenseModal.css';

export default function LicenseModal({ isOpen, onClose }) {
  const [activeTab, setActiveTab] = useState('activate'); // 'activate' | 'restore'
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [keyInput, setKeyInput] = useState('');
  const [activating, setActivating] = useState(false);
  const [message, setMessage] = useState(null);
  const [copied, setCopied] = useState(false);

  // Estados para restauración por correo
  const [restoreEmail, setRestoreEmail] = useState('');
  const [restorePin, setRestorePin] = useState('');
  const [pinSent, setPinSent] = useState(false);
  const [requestingPin, setRequestingPin] = useState(false);
  const [verifyingPin, setVerifyingPin] = useState(false);

  const fetchStatus = async () => {
    setLoading(true);
    try {
      const res = await fetch('/auto-switcher-pro/license/status');
      if (res.ok) {
        const data = await res.json();
        setStatus(data);
      }
    } catch {
      // Fallback
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchStatus();
      setMessage(null);
      setPinSent(false);
      setRestorePin('');
    }
  }, [isOpen]);

  const copyMachineID = () => {
    if (!status?.machine_id) return;
    navigator.clipboard?.writeText(status.machine_id);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  const handleActivate = async () => {
    if (!keyInput.trim()) {
      setMessage({ type: 'error', text: 'Por favor ingresa tu clave de activación' });
      return;
    }
    setActivating(true);
    setMessage(null);
    try {
      const res = await fetch('/auto-switcher-pro/license/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: keyInput.trim() }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setMessage({ type: 'success', text: data.message || '¡Licencia activada con éxito!' });
        setStatus(data.license);
        setKeyInput('');
      } else {
        setMessage({ type: 'error', text: data.message || 'Clave de activación inválida' });
      }
    } catch {
      setMessage({ type: 'error', text: 'Error de conexión con el servidor' });
    } finally {
      setActivating(false);
    }
  };

  const handleRequestPin = async () => {
    if (!restoreEmail.trim() || !restoreEmail.includes('@')) {
      setMessage({ type: 'error', text: 'Ingresa un correo electrónico válido' });
      return;
    }
    setRequestingPin(true);
    setMessage(null);
    try {
      const res = await fetch('/auto-switcher-pro/license/request-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: restoreEmail.trim() }),
      });
      const data = await res.json();
      if (data.ok) {
        setPinSent(true);
        let info = data.message || 'Código PIN de 6 dígitos enviado a tu correo.';
        if (data.dev_pin) {
          info += ` (Código: ${data.dev_pin})`;
        }
        setMessage({ type: 'success', text: info });
      } else {
        setMessage({ type: 'error', text: data.message || 'No se pudo enviar el código.' });
      }
    } catch {
      setMessage({ type: 'error', text: 'Error conectando con el servidor de licencias' });
    } finally {
      setRequestingPin(false);
    }
  };

  const handleVerifyPin = async () => {
    if (!restorePin.trim()) {
      setMessage({ type: 'error', text: 'Por favor ingresa el PIN de 6 dígitos' });
      return;
    }
    setVerifyingPin(true);
    setMessage(null);
    try {
      const res = await fetch('/auto-switcher-pro/license/verify-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: restoreEmail.trim(),
          pin: restorePin.trim(),
        }),
      });
      const data = await res.json();
      if (data.success) {
        setMessage({ type: 'success', text: '¡Licencia transferida y activada con éxito en este equipo!' });
        setStatus(data.license);
        setPinSent(false);
        setRestorePin('');
      } else {
        setMessage({ type: 'error', text: data.message || 'Código PIN inválido' });
      }
    } catch {
      setMessage({ type: 'error', text: 'Error al verificar PIN' });
    } finally {
      setVerifyingPin(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="license-modal-overlay" onClick={onClose} data-testid="license-modal-overlay">
      <div className="license-modal-content" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="license-modal-header">
          <div className="license-title-row">
            <span className="license-badge-icon">🔐</span>
            <div>
              <h3 className="license-modal-title">Licencia Comunitaria 100% Libre & Gratuita</h3>
              <div className="license-modal-subtitle">Auto Switcher Pro es software libre sostenido por la comunidad (Coffee-ware)</div>
            </div>
          </div>
          <button type="button" className="license-close-btn" onClick={onClose}>✕</button>
        </div>

        {/* Body */}
        <div className="license-modal-body">
          {/* Tarjeta de Estado Actual */}
          <div className="license-status-card">
            <div className="license-status-header">
              <span className="status-label">ESTADO ACTUAL:</span>
              <span className={`status-pill pill-${status?.status === 'expired' ? 'expired' : 'active'}`}>
                {status?.status === 'expired'
                  ? '⚠️ EXPIRADO'
                  : status?.tier?.includes('COMMUNITY') || status?.tier?.includes('GRATUITO')
                  ? '☕ COMUNIDAD (100% LIBRE)'
                  : status?.status === 'active'
                  ? '⭐ PRO ACTIVADO'
                  : '⏳ DEMO (30 DÍAS)'}
              </span>
            </div>

            <div className="license-metrics-grid">
              <div className="license-metric-item">
                <span className="metric-label">Días Restantes</span>
                <span className="metric-val">{status?.days_remaining != null && status.days_remaining > 365 ? '∞' : (status?.days_remaining ?? '--')}</span>
              </div>
              <div className="license-metric-item">
                <span className="metric-label">Nivel de Cuenta</span>
                <span className="metric-val">{status?.tier || 'COMMUNITY (100% GRATUITO)'}</span>
              </div>
              <div className="license-metric-item">
                <span className="metric-label">Vigencia</span>
                <span className="metric-val" style={{ fontSize: 11 }}>{status?.expires_at || 'De por vida (Coffee-ware)'}</span>
              </div>
            </div>

            {/* Machine ID Box */}
            <div className="machine-id-container">
              <div className="machine-id-header">
                <span className="machine-id-title">🔑 Tu Machine ID único:</span>
                <button type="button" className="btn-copy-machine" onClick={copyMachineID}>
                  {copied ? '✓ Copiado' : 'Copiar Machine ID'}
                </button>
              </div>
              <div className="machine-id-value">
                <code>{status?.machine_id || 'Calculando...'}</code>
              </div>
              <div className="machine-id-hint">
                Identificador de hardware para vinculación segura.
              </div>
            </div>
          </div>

          {/* Selector de Pestañas: Activar Clave vs Transferir por Correo */}
          <div style={{ display: 'flex', gap: 8, borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: 6 }}>
            <button
              type="button"
              onClick={() => { setActiveTab('activate'); setMessage(null); }}
              style={{
                background: activeTab === 'activate' ? '#0284c7' : 'transparent',
                color: activeTab === 'activate' ? '#fff' : '#94a3b8',
                border: 'none',
                borderRadius: 6,
                padding: '6px 12px',
                fontSize: 12,
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              🔑 Activar con Clave
            </button>
            <button
              type="button"
              onClick={() => { setActiveTab('restore'); setMessage(null); }}
              style={{
                background: activeTab === 'restore' ? '#0284c7' : 'transparent',
                color: activeTab === 'restore' ? '#fff' : '#94a3b8',
                border: 'none',
                borderRadius: 6,
                padding: '6px 12px',
                fontSize: 12,
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              🔄 Restablecer / Transferir Equipo
            </button>
          </div>

          {message && (
            <div className={`license-alert alert-${message.type}`}>
              {message.text}
            </div>
          )}

          {activeTab === 'activate' ? (
            /* Formulario de Activación con Clave */
            <div className="license-activation-box">
              <h4 className="activation-box-title">Ingresar Clave de Activación</h4>
              <textarea
                className="license-key-input"
                rows={3}
                placeholder="Pega aquí la clave de activación entregada (ej: eyJtYWNoaW5lX2lk...)"
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
              />
              <button
                type="button"
                className="btn-activate-license"
                onClick={handleActivate}
                disabled={activating || !keyInput.trim()}
              >
                {activating ? 'Verificando firma digital...' : '🔓 Activar Licencia'}
              </button>
            </div>
          ) : (
            /* Formulario de Transferencia / Restablecimiento Automático por Correo */
            <div className="license-activation-box">
              <h4 className="activation-box-title">Transferencia Automática de Licencia</h4>
              <p style={{ fontSize: 11, color: '#94a3b8', margin: 0, lineHeight: 1.4 }}>
                ¿Formateaste tu equipo o cambiaste de computadora? Ingresa el correo con el que adquiriste tu licencia para transferirla automáticamente a esta máquina (desactivando la anterior).
              </p>

              {!pinSent ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <input
                    type="email"
                    className="modal-input"
                    style={{ background: '#020617', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 6, padding: '8px 12px', color: '#fff', fontSize: 12 }}
                    placeholder="tu-correo@ejemplo.com"
                    value={restoreEmail}
                    onChange={(e) => setRestoreEmail(e.target.value)}
                  />
                  <button
                    type="button"
                    className="btn-activate-license"
                    onClick={handleRequestPin}
                    disabled={requestingPin || !restoreEmail.trim()}
                  >
                    {requestingPin ? 'Verificando cuenta...' : '📨 Solicitar Código PIN de Seguridad'}
                  </button>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ fontSize: 11, color: '#38bdf8' }}>
                    Correo verificado: <strong>{restoreEmail}</strong>
                  </div>
                  <input
                    type="text"
                    maxLength={6}
                    className="modal-input"
                    style={{ background: '#020617', border: '1px solid rgba(56,189,248,0.4)', borderRadius: 6, padding: '8px 12px', color: '#fff', fontSize: 16, textAlign: 'center', letterSpacing: '4px', fontFamily: 'monospace' }}
                    placeholder="123456"
                    value={restorePin}
                    onChange={(e) => setRestorePin(e.target.value)}
                  />
                  <button
                    type="button"
                    className="btn-activate-license"
                    onClick={handleVerifyPin}
                    disabled={verifyingPin || restorePin.length < 6}
                  >
                    {verifyingPin ? 'Transfiriendo asiento...' : '⚡ Confirmar y Transferir Licencia a Este Equipo'}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Opciones de Apoyo Voluntario (Café / Donación) */}
          <div className="license-payment-info">
            <h5 className="payment-title">☕ Apoyo al Proyecto Libre (Invitar un Café)</h5>
            <div className="payment-badges">
              <span className="pay-badge pay-binance">🟡 Binance Pay (USDT / Crypto)</span>
              <span className="pay-badge pay-paypal">🔵 PayPal (USD / EUR)</span>
            </div>
            <p className="payment-note">
              Este proyecto es <strong>100% gratuito y sin bloqueos de rotación</strong>. Si te ahorra errores 429 y cuida tus tokens, cualquier aporte voluntario para un café ayuda a seguir manteniendo los parches al día.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
