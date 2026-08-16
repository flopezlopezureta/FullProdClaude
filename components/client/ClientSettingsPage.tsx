
import React from 'react';
import AccountManagement from './AccountManagement';
import LogoSettings from './LogoSettings';

const ClientSettingsPage: React.FC = () => {
    return (
        <div className="max-w-5xl mx-auto space-y-8 pb-12 animate-in fade-in duration-500">
            <header className="flex flex-col gap-2">
                <h1 className="text-3xl font-black text-[var(--text-primary)] uppercase tracking-tighter">Configuración de Cuenta</h1>
                <p className="text-[var(--text-secondary)] font-medium">Administra tus integraciones y preferencias de despacho.</p>
            </header>

            <div className="bg-[var(--background-secondary)] rounded-2xl shadow-xl border border-[var(--border-primary)] overflow-hidden">
                <div className="p-1 bg-gradient-to-r from-blue-600 to-indigo-600"></div>
                <div className="p-8">
                    <AccountManagement />
                </div>
            </div>

            <LogoSettings />

            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                <div className="bg-[var(--background-secondary)] rounded-2xl p-8 shadow-lg border border-[var(--border-primary)]">
                    <h3 className="text-lg font-black text-[var(--text-primary)] uppercase tracking-tight mb-4">Ayuda y Soporte</h3>
                    <p className="text-sm text-[var(--text-secondary)] mb-6">¿Necesitas ayuda para vincular tus cuentas o configurar los webhooks?</p>
                    <div className="space-y-3">
                        <a href="#" className="flex items-center gap-3 p-3 rounded-xl hover:bg-[var(--background-muted)] transition-colors border border-transparent hover:border-[var(--border-primary)]">
                            <div className="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center text-blue-600">
                                <span className="text-xl font-bold">?</span>
                            </div>
                            <div>
                                <h4 className="text-sm font-bold text-[var(--text-primary)]">Centro de Ayuda</h4>
                                <p className="text-xs text-[var(--text-muted)]">Tutoriales paso a paso.</p>
                            </div>
                        </a>
                        <a href="https://wa.me/569XXXXXXXX" target="_blank" className="flex items-center gap-3 p-3 rounded-xl hover:bg-[var(--background-muted)] transition-colors border border-transparent hover:border-[var(--border-primary)]">
                            <div className="w-10 h-10 rounded-full bg-green-100 flex items-center justify-center text-green-600">
                                <span className="text-xl font-bold">W</span>
                            </div>
                            <div>
                                <h4 className="text-sm font-bold text-[var(--text-primary)]">Soporte por WhatsApp</h4>
                                <p className="text-xs text-[var(--text-muted)]">Asistencia inmediata.</p>
                            </div>
                        </a>
                    </div>
                </div>

                <div className="bg-[var(--background-secondary)] rounded-2xl p-8 shadow-lg border border-[var(--border-primary)] flex flex-col justify-center">
                    <div className="p-4 bg-amber-50 border border-amber-100 rounded-xl mb-4">
                        <h4 className="text-xs font-black text-amber-800 uppercase tracking-widest mb-2">Importante</h4>
                        <p className="text-xs text-amber-700 leading-relaxed">
                            Al conectar tus cuentas, Full Envíos solo accederá a la información de despacho necesaria para procesar tus pedidos. No almacenamos credenciales bancarias ni información sensible.
                        </p>
                    </div>
                    <p className="text-[10px] text-[var(--text-muted)] text-center italic">Versión del Sistema: 2026.4.23</p>
                </div>
            </div>
        </div>
    );
};

export default ClientSettingsPage;
