import React, { useState } from 'react';
import { IconX, IconEye, IconEyeOff, IconLock, IconAlertTriangle } from '../Icon';
import { api } from '../../services/api';
import type { Package } from '../../types';
import { allowedTargets, changeBlocker, reasonProblem, statusLabel, REOPEN_STATUS, MAX_REASON_LENGTH, TARGET_HINTS } from '../../utils/closedStatusChange';

interface ChangeClosedStatusModalProps {
  pkg: Package;
  onClose: () => void;
  /** Se llama con el paquete ya cambiado; quien lo abrió cierra el modal y recarga la lista. */
  onChanged: (updated: Package) => void | Promise<void>;
}

/**
 * Un administrador corrige el estado de un paquete CERRADO (entregado, devuelto o cancelado). Para autorizarlo reingresa SU PROPIA contraseña y escribe el motivo; el servidor vuelve a
 * revisar todo (services/closedStatusChange.js). Queda en el historial del paquete y en la auditoría, y no se avisa al comprador.
 */
const ChangeClosedStatusModal: React.FC<ChangeClosedStatusModalProps> = ({ pkg, onClose, onChanged }) => {
  const targets = allowedTargets(pkg.status);
  const [target, setTarget] = useState<string>(targets.includes(REOPEN_STATUS) ? REOPEN_STATUS : (targets[0] || ''));
  const [reason, setReason] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const blocker = changeBlocker(pkg);
  // Mercado Libre decide cuándo un envío está «entregado»: cambiar el estado aquí no lo toca. Se avisa antes de pedir la clave.
  const mlDelivered = pkg.source === 'MERCADO_LIBRE' && pkg.meliStatus === 'delivered';
  const canSubmit = !blocker && targets.length > 0 && !loading;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    const reasonMessage = reasonProblem(reason);
    if (reasonMessage) { setError(reasonMessage); return; }
    if (!adminPassword) { setError('Ingresa tu contraseña de administrador para autorizar el cambio.'); return; }
    setError('');
    setLoading(true);
    try {
      const updated = await api.changeClosedPackageStatus(pkg.id, { status: target, reason: reason.trim(), adminPassword });
      await onChanged(updated);
    } catch (err: any) {
      setError(err?.message || 'No se pudo cambiar el estado del paquete.');
      setLoading(false);
    }
  };

  const inputClasses = 'w-full px-3 py-2 border border-[var(--border-secondary)] rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-secondary)] bg-[var(--background-secondary)] text-[var(--text-primary)]';

  return (
    <div className="fixed inset-0 bg-black bg-opacity-60 z-50 flex justify-center items-center p-4" onClick={onClose}>
      <div className="bg-[var(--background-secondary)] rounded-xl shadow-2xl w-full max-w-md max-h-[92vh] overflow-y-auto animate-fade-in-up" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="closed-status-title">
        <header className="flex items-center justify-between p-4 border-b border-[var(--border-primary)]">
          <h3 id="closed-status-title" className="text-lg font-bold text-[var(--text-primary)]">Cambiar estado de un paquete cerrado</h3>
          <button type="button" onClick={onClose} className="p-2 rounded-full text-[var(--text-muted)] hover:bg-[var(--background-hover)]" aria-label="Cerrar modal">
            <IconX className="w-6 h-6" />
          </button>
        </header>

        <form onSubmit={handleSubmit}>
          <div className="p-6 space-y-4">
            <div className="flex items-start">
              <div className="flex-shrink-0 flex items-center justify-center h-10 w-10 rounded-full bg-[var(--brand-primary-bg,theme(colors.blue.50))]">
                <IconLock className="h-6 w-6 text-[var(--brand-primary)]" />
              </div>
              <p className="ml-4 text-sm text-[var(--text-secondary)]">
                Este paquete está cerrado. Para cambiar su estado debes autorizarlo con tu contraseña de administrador. El cambio queda registrado con tu nombre y no se avisa al comprador.
              </p>
            </div>

            <div className="rounded-md bg-[var(--background-muted)] px-3 py-2 text-sm text-[var(--text-secondary)]" data-testid="closed-status-summary">
              <p className="font-mono text-xs break-all text-[var(--text-primary)]">{pkg.id}{pkg.meliFlexCode ? ` · Flex ${pkg.meliFlexCode}` : ''}</p>
              <p className="mt-1">Estado actual: <span className="font-semibold text-[var(--text-primary)]">{statusLabel(pkg.status)}</span></p>
            </div>

            {blocker && (
              <div role="alert" data-testid="closed-status-blocker" className="flex items-start gap-2 text-sm text-[var(--error-text)] bg-[var(--error-bg)] border border-[var(--error-border)] p-3 rounded-md">
                <IconAlertTriangle className="h-5 w-5 flex-shrink-0 mt-0.5" />
                <span>{blocker}</span>
              </div>
            )}
            {mlDelivered && !blocker && (
              <div role="status" data-testid="closed-status-ml-note" className="text-sm text-amber-800 bg-amber-50 border border-amber-200 p-3 rounded-md">
                Mercado Libre ya muestra este envío como entregado. Ese estado es de Mercado Libre y no cambia desde aquí: solo cambia el estado dentro de Full Envíos.
              </div>
            )}

            <div>
              <label htmlFor="closed-status-target" className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Nuevo estado</label>
              <select id="closed-status-target" value={target} onChange={(e) => { setTarget(e.target.value); setError(''); }} disabled={!!blocker || loading} className={inputClasses}>
                {targets.map((s) => <option key={s} value={s}>{s === REOPEN_STATUS ? `${statusLabel(s)} (reabrir)` : statusLabel(s)}</option>)}
              </select>
              {target && <p className="mt-1 text-xs text-[var(--text-muted)]" data-testid="closed-status-hint">{TARGET_HINTS[target]}</p>}
            </div>

            <div>
              <label htmlFor="closed-status-reason" className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Motivo del cambio</label>
              <textarea
                id="closed-status-reason"
                value={reason}
                onChange={(e) => { setReason(e.target.value); setError(''); }}
                maxLength={MAX_REASON_LENGTH}
                rows={3}
                disabled={!!blocker || loading}
                placeholder="Ej.: el conductor lo canceló por error; el comprador sí lo espera"
                className={inputClasses}
              />
            </div>

            <div>
              <label htmlFor="closed-status-password" className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Tu contraseña de administrador</label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  id="closed-status-password"
                  value={adminPassword}
                  onChange={(e) => { setAdminPassword(e.target.value); setError(''); }}
                  autoComplete="off"
                  disabled={!!blocker || loading}
                  className={`${inputClasses} pr-10`}
                />
                <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute inset-y-0 right-0 pr-3 flex items-center" aria-label={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}>
                  {showPassword ? <IconEyeOff className="h-5 w-5 text-[var(--text-muted)]" /> : <IconEye className="h-5 w-5 text-[var(--text-muted)]" />}
                </button>
              </div>
            </div>

            {error && <p role="alert" data-testid="closed-status-error" className="text-sm text-red-600">{error}</p>}
          </div>

          <footer className="px-6 py-4 bg-[var(--background-muted)] rounded-b-xl flex justify-end space-x-3">
            <button type="button" onClick={onClose} disabled={loading} className="px-4 py-2 text-sm font-medium text-[var(--text-secondary)] bg-[var(--background-secondary)] border border-[var(--border-secondary)] rounded-md hover:bg-[var(--background-hover)] disabled:opacity-50">Cancelar</button>
            <button type="submit" disabled={!canSubmit} className="px-4 py-2 text-sm font-medium text-white bg-[var(--brand-primary)] border border-transparent rounded-md shadow-sm hover:bg-[var(--brand-secondary)] disabled:opacity-50">
              {loading ? 'Verificando...' : 'Autorizar y cambiar'}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
};

export default ChangeClosedStatusModal;
