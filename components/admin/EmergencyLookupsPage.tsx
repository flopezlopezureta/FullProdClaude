import React, { useState, useEffect, useCallback } from 'react';
import { IconRefresh, IconLoader, IconAlertTriangle, IconSearch } from '../Icon';
import { api } from '../../services/api';

interface LookupEntry {
    id: number;
    searchedCode: string;
    driverId: string | null;
    driverName: string | null;
    clientId: string | null;
    clientName: string | null;
    success: boolean;
    durationMs: number | null;
    createdAt: string;
}

const fmtTime = (iso: string) => new Date(iso).toLocaleString('es-CL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });

const durationColor = (ms: number | null) => {
    if (ms === null) return 'text-[var(--text-muted)] bg-[var(--background-muted)] border-[var(--border-primary)]';
    if (ms >= 8000) return 'text-red-600 bg-red-50 border-red-100';
    if (ms >= 3000) return 'text-amber-600 bg-amber-50 border-amber-100';
    return 'text-green-600 bg-green-50 border-green-100';
};

const EmergencyLookupsPage: React.FC = () => {
    const [entries, setEntries] = useState<LookupEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const data = await api.getEmergencyLookups();
            setEntries(data);
        } catch (e: any) {
            setError(e.message || 'No se pudo cargar el registro.');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { load(); }, [load]);

    const failedCount = entries.filter(e => !e.success).length;
    const avgDuration = entries.length > 0
        ? Math.round(entries.reduce((sum, e) => sum + (e.durationMs || 0), 0) / entries.length)
        : 0;

    return (
        <div className="max-w-5xl mx-auto">
            <div className="flex items-center justify-between mb-4">
                <p className="text-sm text-[var(--text-muted)] max-w-2xl">
                    Cada vez que un conductor escanea un paquete al momento de asignarlo/despacharlo y el sistema no lo encuentra en la base local, intenta traerlo de emergencia desde Mercado Libre en el momento. Este registro muestra cuándo pasa esto, para qué cliente, y cuánto tardó la búsqueda — sirve para diagnosticar por qué la asignación se puede sentir "pegada".
                </p>
                <button
                    onClick={load}
                    disabled={loading}
                    className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--brand-primary)] text-white text-sm font-semibold disabled:opacity-50 flex-shrink-0"
                >
                    {loading ? <IconLoader className="w-4 h-4 animate-spin" /> : <IconRefresh className="w-4 h-4" />}
                    Actualizar
                </button>
            </div>

            {error && (
                <div className="flex items-center gap-2 p-4 bg-red-50 border border-red-100 rounded-lg text-red-700 text-sm mb-4">
                    <IconAlertTriangle className="w-4 h-4 flex-shrink-0" /> {error}
                </div>
            )}

            {!loading && !error && entries.length === 0 && (
                <div className="p-6 text-center text-[var(--text-muted)] bg-[var(--background-secondary)] border border-[var(--border-primary)] rounded-xl">
                    Sin registros todavía — no ha ocurrido ninguna búsqueda de emergencia desde que se activó este registro.
                </div>
            )}

            {entries.length > 0 && (
                <>
                    <div className="flex flex-wrap gap-4 mb-5 text-xs text-[var(--text-muted)]">
                        <span>{entries.length.toLocaleString('es-CL')} búsquedas registradas (últimas 500)</span>
                        <span>{failedCount} no encontradas</span>
                        <span>Duración promedio: {avgDuration.toLocaleString('es-CL')} ms</span>
                    </div>

                    <div className="bg-[var(--background-secondary)] border border-[var(--border-primary)] rounded-xl overflow-hidden">
                        <div className="p-4 border-b border-[var(--border-primary)]">
                            <h3 className="text-sm font-bold text-[var(--text-primary)] flex items-center gap-2">
                                <IconSearch className="w-4 h-4" /> Búsquedas de emergencia (más recientes primero)
                            </h3>
                        </div>
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="text-left text-xs text-[var(--text-muted)] border-b border-[var(--border-primary)]">
                                        <th className="p-3">Fecha / Hora</th>
                                        <th className="p-3">Código Buscado</th>
                                        <th className="p-3">Conductor</th>
                                        <th className="p-3">Cliente</th>
                                        <th className="p-3">Resultado</th>
                                        <th className="p-3 text-right">Duración</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {entries.map(row => (
                                        <tr key={row.id} className="border-b border-[var(--border-primary)] last:border-0">
                                            <td className="p-3 text-xs text-[var(--text-muted)] whitespace-nowrap">{fmtTime(row.createdAt)}</td>
                                            <td className="p-3 font-mono text-xs">{row.searchedCode}</td>
                                            <td className="p-3 text-xs">{row.driverName || <span className="italic text-[var(--text-muted)]">—</span>}</td>
                                            <td className="p-3 text-xs">
                                                {row.clientName
                                                    ? <span className="font-medium text-[var(--text-primary)]">{row.clientName}</span>
                                                    : <span className="italic text-[var(--text-muted)]">Sin identificar</span>}
                                            </td>
                                            <td className="p-3">
                                                <span className={`px-2 py-0.5 rounded-full text-xs font-semibold border ${row.success ? 'text-green-600 bg-green-50 border-green-100' : 'text-red-600 bg-red-50 border-red-100'}`}>
                                                    {row.success ? 'Encontrado' : 'No encontrado'}
                                                </span>
                                            </td>
                                            <td className="p-3 text-right">
                                                <span className={`px-2 py-0.5 rounded-full text-xs font-semibold border ${durationColor(row.durationMs)}`}>
                                                    {row.durationMs !== null ? `${row.durationMs.toLocaleString('es-CL')} ms` : '—'}
                                                </span>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </>
            )}
        </div>
    );
};

export default EmergencyLookupsPage;
