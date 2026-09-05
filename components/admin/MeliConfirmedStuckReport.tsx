import React, { useState, useEffect } from 'react';
import { IconAlertTriangle, IconRefresh, IconTruck } from '../Icon';

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
}

const formatDate = (iso: string) => new Date(iso).toLocaleDateString('es-CL', { day: '2-digit', month: '2-digit', year: '2-digit' });

const MeliConfirmedStuckReport: React.FC = () => {
    const [data, setData] = useState<MeliStuckPackage[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const fetchData = async () => {
        setIsLoading(true);
        setError(null);
        try {
            const response = await fetch('/api/reports/meli-confirmed-stuck', {
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

    useEffect(() => {
        fetchData();
    }, []);

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
                            <span className="font-black">{totalMatching} paquete{totalMatching === 1 ? '' : 's'}</span> que Mercado Libre ya reportó como entregado{totalMatching === 1 ? '' : 's'}, pero que siguen abiertos en el sistema y asignados a un conductor — sin límite de antigüedad. Estos no aparecen en los avisos normales del conductor (acotados a 7 días).
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
                    </h3>
                    <button onClick={fetchData} disabled={isLoading} className="px-6 py-2 bg-gray-900 text-white rounded-xl font-bold text-xs hover:bg-gray-800 flex items-center gap-2 transition-all">
                        <IconRefresh className={`w-3 h-3 ${isLoading ? 'animate-spin' : ''}`} />
                        Actualizar
                    </button>
                </div>
                <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-gray-100">
                        <thead className="bg-gray-50">
                            <tr>
                                <th className="px-6 py-4 text-left text-xs font-bold text-gray-400 uppercase tracking-wider">ID</th>
                                <th className="px-6 py-4 text-left text-xs font-bold text-gray-400 uppercase tracking-wider">Cliente</th>
                                <th className="px-6 py-4 text-left text-xs font-bold text-gray-400 uppercase tracking-wider">Conductor</th>
                                <th className="px-6 py-4 text-left text-xs font-bold text-gray-400 uppercase tracking-wider">Dirección</th>
                                <th className="px-6 py-4 text-center text-xs font-bold text-gray-400 uppercase tracking-wider">Pendiente desde</th>
                                <th className="px-6 py-4 text-right text-xs font-bold text-gray-400 uppercase tracking-wider">Días</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-50">
                            {data.map(pkg => (
                                <tr key={pkg.id} className="hover:bg-gray-50/50 transition-colors text-sm">
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
                                </tr>
                            ))}
                            {data.length === 0 && isLoading && (
                                <tr><td colSpan={6} className="px-6 py-10 text-center text-gray-400 text-sm">Cargando...</td></tr>
                            )}
                            {data.length === 0 && !isLoading && !error && (
                                <tr><td colSpan={6} className="px-6 py-10 text-center text-gray-400 text-sm">No hay pendientes confirmados por Mercado Libre sin cerrar.</td></tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
};

export default MeliConfirmedStuckReport;
