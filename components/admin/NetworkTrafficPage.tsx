import React, { useState, useEffect, useCallback } from 'react';
import { Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Line, ComposedChart } from 'recharts';
import { IconRefresh, IconLoader, IconAlertTriangle, IconWifi } from '../Icon';
import { api } from '../../services/api';

interface IpEntry {
    ip: string;
    requestCount: number;
    avgMs: number;
    maxMs: number;
    errorRate: number;
    errorCount: number;
    firstSeen: number;
    lastSeen: number;
    isp?: string | null;
    org?: string | null;
    city?: string | null;
}

interface HourEntry {
    hour: number;
    requestCount: number;
    avgMs: number;
    errorRate: number;
}

interface Report {
    byIp: IpEntry[];
    byHour: HourEntry[];
    totalRecords: number;
    windowStart: number | null;
    windowEnd: number | null;
}

const fmtTime = (ts: number) => new Date(ts).toLocaleString('es-CL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

const severityColor = (avgMs: number, errorRate: number) => {
    if (errorRate >= 10 || avgMs >= 2000) return 'text-red-600 bg-red-50 border-red-100';
    if (errorRate >= 3 || avgMs >= 800) return 'text-amber-600 bg-amber-50 border-amber-100';
    return 'text-green-600 bg-green-50 border-green-100';
};

const NetworkTrafficPage: React.FC = () => {
    const [report, setReport] = useState<Report | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const data = await api.getNetworkMetricsReport();
            setReport(data);
        } catch (e: any) {
            setError(e.message || 'No se pudo cargar el reporte.');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { load(); }, [load]);

    return (
        <div className="max-w-5xl mx-auto">
            <div className="flex items-center justify-between mb-4">
                <p className="text-sm text-[var(--text-muted)] max-w-2xl">
                    Registro de todas las peticiones al servidor, agrupadas por dirección IP de origen — sirve para demostrar si una intermitencia viene de una red específica (por ejemplo, la wifi de un cliente saturada en horas pico) en vez del sistema.
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

            {report && report.totalRecords === 0 && !loading && (
                <div className="p-6 text-center text-[var(--text-muted)] bg-[var(--background-secondary)] border border-[var(--border-primary)] rounded-xl">
                    Todavía no hay tráfico registrado en esta ventana (se reinicia con cada despliegue del servidor). Vuelve a revisar después de un rato de uso normal.
                </div>
            )}

            {report && report.totalRecords > 0 && (
                <>
                    <div className="flex flex-wrap gap-4 mb-5 text-xs text-[var(--text-muted)]">
                        <span>{report.totalRecords.toLocaleString('es-CL')} peticiones registradas</span>
                        {report.windowStart && report.windowEnd && (
                            <span>Ventana: {fmtTime(report.windowStart)} — {fmtTime(report.windowEnd)}</span>
                        )}
                    </div>

                    {/* Gráfico por hora del día */}
                    <div className="bg-[var(--background-secondary)] border border-[var(--border-primary)] rounded-xl p-4 mb-6">
                        <h3 className="text-sm font-bold text-[var(--text-primary)] mb-3">Tiempo de respuesta y errores por hora del día</h3>
                        <ResponsiveContainer width="100%" height={220}>
                            <ComposedChart data={report.byHour} margin={{ top: 5, right: 10, left: -10, bottom: 5 }}>
                                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-primary)" />
                                <XAxis dataKey="hour" tickFormatter={(h) => `${h}h`} fontSize={11} stroke="var(--text-muted)" />
                                <YAxis yAxisId="left" fontSize={11} stroke="var(--text-muted)" label={{ value: 'ms', angle: -90, position: 'insideLeft', fontSize: 10 }} />
                                <YAxis yAxisId="right" orientation="right" fontSize={11} stroke="var(--text-muted)" label={{ value: '% error', angle: 90, position: 'insideRight', fontSize: 10 }} />
                                <Tooltip
                                    formatter={(value: any, name: any) => [name === 'avgMs' ? `${value} ms` : `${value}%`, name === 'avgMs' ? 'Tiempo promedio' : 'Tasa de error']}
                                    labelFormatter={(h: any) => `${h}:00 - ${h}:59`}
                                />
                                <Bar yAxisId="left" dataKey="avgMs" fill="#3b82f6" radius={[3, 3, 0, 0]} />
                                <Line yAxisId="right" type="monotone" dataKey="errorRate" stroke="#ef4444" strokeWidth={2} dot={false} />
                            </ComposedChart>
                        </ResponsiveContainer>
                    </div>

                    {/* Tabla por IP */}
                    <div className="bg-[var(--background-secondary)] border border-[var(--border-primary)] rounded-xl overflow-hidden">
                        <div className="p-4 border-b border-[var(--border-primary)]">
                            <h3 className="text-sm font-bold text-[var(--text-primary)] flex items-center gap-2">
                                <IconWifi className="w-4 h-4" /> Tráfico por IP de origen
                            </h3>
                            <p className="text-xs text-[var(--text-muted)] mt-1">Ordenado de peor a mejor (peor tiempo de respuesta combinado con tasa de error).</p>
                        </div>
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="text-left text-xs text-[var(--text-muted)] border-b border-[var(--border-primary)]">
                                        <th className="p-3">IP</th>
                                        <th className="p-3">Proveedor / Red</th>
                                        <th className="p-3 text-right">Peticiones</th>
                                        <th className="p-3 text-right">Prom.</th>
                                        <th className="p-3 text-right">Máx.</th>
                                        <th className="p-3 text-right">% Error</th>
                                        <th className="p-3 text-right">Última actividad</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {report.byIp.map(row => (
                                        <tr key={row.ip} className="border-b border-[var(--border-primary)] last:border-0">
                                            <td className="p-3 font-mono text-xs">{row.ip}</td>
                                            <td className="p-3 text-xs text-[var(--text-muted)]">
                                                {row.isp || row.org ? (
                                                    <span>{row.isp || row.org}{row.city ? ` (${row.city})` : ''}</span>
                                                ) : (
                                                    <span className="italic">—</span>
                                                )}
                                            </td>
                                            <td className="p-3 text-right">{row.requestCount}</td>
                                            <td className="p-3 text-right">
                                                <span className={`px-2 py-0.5 rounded-full text-xs font-semibold border ${severityColor(row.avgMs, row.errorRate)}`}>
                                                    {row.avgMs} ms
                                                </span>
                                            </td>
                                            <td className="p-3 text-right text-xs text-[var(--text-muted)]">{row.maxMs} ms</td>
                                            <td className="p-3 text-right">
                                                <span className={`px-2 py-0.5 rounded-full text-xs font-semibold border ${severityColor(row.avgMs, row.errorRate)}`}>
                                                    {row.errorRate}%
                                                </span>
                                            </td>
                                            <td className="p-3 text-right text-xs text-[var(--text-muted)]">{fmtTime(row.lastSeen)}</td>
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

export default NetworkTrafficPage;
