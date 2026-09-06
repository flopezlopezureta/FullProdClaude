import React, { useState, useEffect } from 'react';
import { IconAlertTriangle, IconRefresh, IconTruck } from '../Icon';
import { getLocalDateString } from '../../utils/dateUtils';

interface MeliStuckPackage {
    id: string;
    recipientAddress: string;
    recipientCommune: string;
    status: string;
    assignedAt: string;
    source: string;
    driverName: string | null;
    clientName: string | null;
    daysPending: number;
    totalMatching: number;
    meliStuckReviewed: boolean;
}

const formatDate = (iso: string) => new Date(iso).toLocaleDateString('es-CL', { day: '2-digit', month: '2-digit', year: '2-digit' });

// Vista por defecto: mes en curso (dia 1 hasta hoy). Sigue siendo editable - "Quitar filtro" lleva
// a la vista sin limite de antiguedad, no a este default.
const getFirstOfMonth = () => {
    const now = new Date();
    return getLocalDateString(new Date(now.getFullYear(), now.getMonth(), 1));
};

const MeliConfirmedStuckReport: React.FC = () => {
    const [data, setData] = useState<MeliStuckPackage[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [startDate, setStartDate] = useState(getFirstOfMonth);
    const [endDate, setEndDate] = useState(getLocalDateString);

    const fetchData = async () => {
        setIsLoading(true);
        setError(null);
        try {
            const params = startDate && endDate ? `?startDate=${startDate}&endDate=${endDate}` : '';
            const response = await fetch(`/api/reports/meli-confirmed-stuck${params}`, {
                headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
            });
            const result = await response.json();
            if (response.ok) {
                setData(result);
            } else {
                setError(result?.message || `Error del servidor (${response.status}).`);
            }
        } catch (error: any) {
            console.error('Error fetching meli-confirmed-stuck report:', error);
            setError('No se pudo cargar el reporte: falló la conexión con el servidor.');
        } finally {
            setIsLoading(false);
        }
    };

    const totalMatching = data[0]?.totalMatching ?? data.length;
    const hasDateFilter = !!(startDate && endDate);
    const clearDateFilter = () => { setStartDate(''); setEndDate(''); };

    const toggleReviewed = async (pkg: MeliStuckPackage) => {
        const nextValue = !pkg.meliStuckReviewed;
        setData(prev => prev.map(p => p.id === pkg.id ? { ...p, meliStuckReviewed: nextValue } : p));
        try {
            const response = await fetch(`/api/reports/meli-confirmed-stuck/${pkg.id}/reviewed`, {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${localStorage.getItem('token')}`
                },
                body: JSON.stringify({ reviewed: nextValue })
            });
            if (!response.ok) throw new Error('No se pudo guardar');
        } catch (err) {
            console.error('Error al marcar como revisado:', err);
            setData(prev => prev.map(p => p.id === pkg.id ? { ...p, meliStuckReviewed: !nextValue } : p));
        }
    };

    useEffect(() => {
        fetchData();
    }, [startDate, endDate]);

    return (
        <div className="space-y-6">
            {error ? (
                <div className="bg-red-50 border-l-4 border-red-500 p-6 rounded-2xl flex items-center gap-4">
                    <div className="p-3 bg-red-100 text-red-600 rounded-full">
                        <IconAlertTriangle className="w-8 h-8" />
                    </div>
                    <div>
                        <h3 className="text-lg font-black text-red-900">No se pudo cargar el reporte</h3>
                        <p className="text-sm text-red-700 font-medium">{error}</p>
                    </div>
                </div>
            ) : (
                <div className="bg-amber-50 border-l-4 border-amber-500 p-6 rounded-2xl flex items-center gap-4">
                    <div className="p-3 bg-amber-100 text-amber-600 rounded-full">
                        <IconAlertTriangle className="w-8 h-8" />
                    </div>
                    <div>
                        <h3 className="text-lg font-black text-amber-900">Pendientes confirmados por Mercado Libre</h3>
                        <p className="text-sm text-amber-700 font-medium">
                            <span className="font-black">{totalMatching} paquete{totalMatching === 1 ? '' : 's'}</span> que Mercado Libre ya reportó como entregado{totalMatching === 1 ? '' : 's'}, pero que siguen abiertos en el sistema y asignados a un conductor{hasDateFilter ? ' en el rango seleccionado' : ' — sin límite de antigüedad'}. Estos no aparecen en los avisos normales del conductor (acotados a 7 días).
                            {data.length > 0 && data.length < totalMatching && (
                                <> Mostrando los {data.length} más antiguos.</>
                            )}
                        </p>
                    </div>
                </div>
            )}

            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
                <div className="p-6 border-b border-gray-100 flex items-center justify-between">
                    <h3 className="text-lg font-black text-gray-900 flex items-center gap-2">
                        <IconTruck className="w-5 h-5 text-indigo-500" />
                        Listado
                        <span className="px-2.5 py-1 text-xs font-black bg-indigo-100 text-indigo-700 rounded-full">
                            {totalMatching} encontrado{totalMatching === 1 ? '' : 's'}
                        </span>
                    </h3>
                    <div className="flex items-center gap-2">
                        <div className="flex items-center gap-1.5 bg-gray-50 px-3 py-1.5 rounded-lg border border-gray-200">
                            <span className="text-[10px] font-black text-gray-400 uppercase">Desde</span>
                            <input
                                type="date"
                                value={startDate}
                                onChange={(e) => setStartDate(e.target.value)}
                                className="bg-transparent text-xs font-bold text-gray-900 border-none outline-none focus:ring-0 cursor-pointer"
                            />
                            <span className="text-[10px] font-black text-gray-400 uppercase">Hasta</span>
                            <input
                                type="date"
                                value={endDate}
                                onChange={(e) => setEndDate(e.target.value)}
                                className="bg-transparent text-xs font-bold text-gray-900 border-none outline-none focus:ring-0 cursor-pointer"
                            />
                        </div>
                        {hasDateFilter && (
                            <button onClick={clearDateFilter} className="px-3 py-2 text-[10px] font-black uppercase text-gray-500 hover:text-gray-900 transition-colors">
                                Quitar filtro
                            </button>
                        )}
                        <button onClick={fetchData} disabled={isLoading} className="px-6 py-2 bg-gray-900 text-white rounded-xl font-bold text-xs hover:bg-gray-800 flex items-center gap-2 transition-all">
                            <IconRefresh className={`w-3 h-3 ${isLoading ? 'animate-spin' : ''}`} />
                            Actualizar
                        </button>
                    </div>
                </div>
                <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-gray-100">
                        <thead className="bg-gray-50">
                            <tr>
                                <th className="px-6 py-4 text-left text-xs font-bold text-gray-400 uppercase tracking-wider">#</th>
                                <th className="px-6 py-4 text-left text-xs font-bold text-gray-400 uppercase tracking-wider">ID</th>
                                <th className="px-6 py-4 text-left text-xs font-bold text-gray-400 uppercase tracking-wider">Cliente</th>
                                <th className="px-6 py-4 text-left text-xs font-bold text-gray-400 uppercase tracking-wider">Conductor</th>
                                <th className="px-6 py-4 text-left text-xs font-bold text-gray-400 uppercase tracking-wider">Dirección</th>
                                <th className="px-6 py-4 text-center text-xs font-bold text-gray-400 uppercase tracking-wider">Pendiente desde</th>
                                <th className="px-6 py-4 text-right text-xs font-bold text-gray-400 uppercase tracking-wider">Días</th>
                                <th className="px-6 py-4 text-center text-xs font-bold text-gray-400 uppercase tracking-wider">Revisado</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-50">
                            {data.map((pkg, index) => (
                                <tr key={pkg.id} className={`hover:bg-gray-50/50 transition-colors text-sm ${pkg.meliStuckReviewed ? 'bg-emerald-50/40' : ''}`}>
                                    <td className="px-6 py-4 text-gray-400 font-bold">{index + 1}</td>
                                    <td className="px-6 py-4 font-bold text-gray-900">{pkg.id}</td>
                                    <td className="px-6 py-4 text-gray-600">{pkg.clientName || '—'}</td>
                                    <td className="px-6 py-4 text-gray-600">{pkg.driverName || 'Sin asignar'}</td>
                                    <td className="px-6 py-4 text-gray-600">{pkg.recipientAddress}, {pkg.recipientCommune}</td>
                                    <td className="px-6 py-4 text-center text-gray-500">{formatDate(pkg.assignedAt)}</td>
                                    <td className="px-6 py-4 text-right">
                                        <span className={`px-3 py-1 rounded-full text-[10px] font-black uppercase ${pkg.daysPending > 14 ? 'bg-red-100 text-red-600' : 'bg-amber-100 text-amber-600'}`}>
                                            {pkg.daysPending} día{pkg.daysPending === 1 ? '' : 's'}
                                        </span>
                                    </td>
                                    <td className="px-6 py-4 text-center">
                                        <input
                                            type="checkbox"
                                            checked={pkg.meliStuckReviewed}
                                            onChange={() => toggleReviewed(pkg)}
                                            className="w-4 h-4 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500 cursor-pointer"
                                        />
                                    </td>
                                </tr>
                            ))}
                            {data.length === 0 && isLoading && (
                                <tr><td colSpan={8} className="px-6 py-10 text-center text-gray-400 text-sm">Cargando...</td></tr>
                            )}
                            {data.length === 0 && !isLoading && !error && (
                                <tr><td colSpan={8} className="px-6 py-10 text-center text-gray-400 text-sm">No hay pendientes confirmados por Mercado Libre sin cerrar.</td></tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
};

export default MeliConfirmedStuckReport;
