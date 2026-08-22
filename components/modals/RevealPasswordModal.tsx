import React, { useState } from 'react';
import { IconX, IconEye, IconEyeOff, IconLock } from '../Icon';
import { api } from '../../services/api';

interface RevealPasswordModalProps {
  userId: string;
  userName: string;
  onClose: () => void;
}

const RevealPasswordModal: React.FC<RevealPasswordModalProps> = ({ userId, userName, onClose }) => {
  const [adminPassword, setAdminPassword] = useState('');
  const [showAdminPassword, setShowAdminPassword] = useState(false);
  const [revealedPassword, setRevealedPassword] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!adminPassword.trim()) {
      setError('Debes ingresar tu contraseña de administrador.');
      return;
    }
    setError('');
    setLoading(true);
    try {
      const response = await api.revealUserPassword(userId, adminPassword);
      setRevealedPassword(response.plainPassword);
    } catch (err: any) {
      setError(err.message || 'No se pudo verificar la contraseña.');
    } finally {
      setLoading(false);
    }
  };

  const inputClasses = "w-full px-3 py-2 font-mono border border-[var(--border-secondary)] rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-secondary)] bg-[var(--background-secondary)] text-[var(--text-primary)]";

  return (
    <div className="fixed inset-0 bg-black bg-opacity-60 z-50 flex justify-center items-center p-4" onClick={onClose}>
      <div className="bg-[var(--background-secondary)] rounded-xl shadow-2xl w-full max-w-sm animate-fade-in-up" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center justify-between p-4 border-b border-[var(--border-primary)]">
          <h3 className="text-lg font-bold text-[var(--text-primary)]">Ver contraseña de {userName}</h3>
          <button onClick={onClose} className="p-2 rounded-full text-[var(--text-muted)] hover:bg-[var(--background-hover)]" aria-label="Cerrar modal">
            <IconX className="w-6 h-6" />
          </button>
        </header>

        {revealedPassword === undefined ? (
          <form onSubmit={handleSubmit}>
            <div className="p-6 space-y-4">
              <div className="flex items-start">
                <div className="mx-auto flex-shrink-0 flex items-center justify-center h-10 w-10 rounded-full bg-[var(--brand-primary-bg,theme(colors.blue.50))] sm:mx-0">
                  <IconLock className="h-6 w-6 text-[var(--brand-primary)]" />
                </div>
                <div className="mt-1 text-center sm:mt-0 sm:ml-4 sm:text-left">
                  <p className="text-sm text-[var(--text-secondary)]">Para ver esta contraseña, confirma reingresando tu propia contraseña de administrador. Esta acción queda registrada.</p>
                </div>
              </div>
              <div>
                <label htmlFor="reveal-admin-password" className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Tu contraseña</label>
                <div className="relative">
                  <input
                    type={showAdminPassword ? 'text' : 'password'}
                    id="reveal-admin-password"
                    value={adminPassword}
                    onChange={(e) => { setAdminPassword(e.target.value); setError(''); }}
                    autoFocus
                    required
                    className={`${inputClasses} pr-10`}
                  />
                  <button type="button" onClick={() => setShowAdminPassword(!showAdminPassword)} className="absolute inset-y-0 right-0 pr-3 flex items-center" aria-label={showAdminPassword ? "Ocultar contraseña" : "Mostrar contraseña"}>
                    {showAdminPassword ? <IconEyeOff className="h-5 w-5 text-[var(--text-muted)]" /> : <IconEye className="h-5 w-5 text-[var(--text-muted)]" />}
                  </button>
                </div>
              </div>
              {error && <p className="text-sm text-red-600">{error}</p>}
            </div>
            <footer className="px-6 py-4 bg-[var(--background-muted)] rounded-b-xl flex justify-end space-x-3">
              <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium text-[var(--text-secondary)] bg-[var(--background-secondary)] border border-[var(--border-secondary)] rounded-md hover:bg-[var(--background-hover)]">Cancelar</button>
              <button type="submit" disabled={loading} className="px-4 py-2 text-sm font-medium text-white bg-[var(--brand-primary)] border border-transparent rounded-md shadow-sm hover:bg-[var(--brand-secondary)] disabled:opacity-60">
                {loading ? 'Verificando...' : 'Ver contraseña'}
              </button>
            </footer>
          </form>
        ) : (
          <div className="p-6 space-y-4">
            {revealedPassword ? (
              <div className="text-center">
                <p className="text-sm text-[var(--text-secondary)] mb-2">Contraseña de {userName}:</p>
                <p className="text-2xl font-mono font-bold text-[var(--brand-primary)] bg-[var(--background-muted)] rounded-md py-3 px-4 select-all">{revealedPassword}</p>
              </div>
            ) : (
              <p className="text-sm text-[var(--text-secondary)] text-center">Este usuario no tiene una contraseña en texto plano guardada (por ejemplo, si fue creado antes de esta función). Puedes definirle una nueva desde "Editar".</p>
            )}
            <div className="flex justify-end">
              <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium text-white bg-[var(--brand-primary)] border border-transparent rounded-md shadow-sm hover:bg-[var(--brand-secondary)]">Cerrar</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default RevealPasswordModal;
