
import React, { useState, ReactNode } from 'react';
import { api, PackageCreationData } from '../../services/api';
import { User } from '../../types';
import { PackageSource, ShippingType } from '../../constants';
import { IconX, IconAlertTriangle, IconMercadoLibre, IconWoocommerce, IconInfo, IconFalabella, IconSearch, IconShopify, IconDownload, IconLoader, IconJumpseller, IconBan } from '../Icon';
import { AuthContext } from '../../contexts/AuthContext';
import { useContext } from 'react';
import { getLogicalDate } from '../../utils/dateUtils';

interface ExternalImportModalProps {
    client: User;
    source: PackageSource;
    onClose: () => void;
    onImport: (packages: Omit<PackageCreationData, 'creatorId' | 'origin'>[]) => Promise<any>;
}

// FALABELLA_DIRECTO is intentionally excluded — unlike the other sources here, it has no
// "fetch pending orders" flow; packages only enter the system via a physical-label QR scan.
const sourceConfig: { [key in Exclude<PackageSource, 'MANUAL' | 'FALABELLA_DIRECTO'>]: { title: string; icon: ReactNode; fetchFn: (clientId: string) => Promise<any[]>; orderIdField: 'meliOrderId' | 'wooOrderId' | 'shopifyOrderId' } } = {
    'MERCADO_LIBRE': {
        title: 'Mercado Libre',
        icon: <IconMercadoLibre className="w-8 h-8 text-yellow-500" />,
        fetchFn: api.fetchMeliOrders,
        orderIdField: 'meliOrderId',
    },
    'SHOPIFY': {
        title: 'Shopify',
        icon: <IconShopify className="w-8 h-8 text-green-500" />,
        fetchFn: api.fetchShopifyOrders,
        orderIdField: 'shopifyOrderId',
    },
    'WOOCOMMERCE': {
        title: 'WooCommerce',
        icon: <IconWoocommerce className="w-8 h-8 text-purple-600" />,
        fetchFn: api.fetchWooCommerceOrders,
        orderIdField: 'wooOrderId',
    },
    'FALABELLA': {
        title: 'Falabella',
        icon: <IconFalabella className="w-8 h-8 text-green-700" />,
        fetchFn: api.fetchFalabellaOrders,
        orderIdField: 'meliOrderId',
    },
    'JUMPSELLER': {
        title: 'Jumpseller',
        icon: <IconJumpseller className="w-8 h-8 text-sky-500" />,
        fetchFn: api.fetchJumpsellerOrders,
        orderIdField: 'shopifyOrderId',
    }
}

const ExternalImportModal: React.FC<ExternalImportModalProps> = ({ client, source, onClose, onImport }) => {
    const auth = useContext(AuthContext);
    const config = sourceConfig[source as Exclude<PackageSource, 'MANUAL' | 'FALABELLA_DIRECTO'>];
    const [orders, setOrders] = useState<any[]>([]);
    const [selectedOrderIds, setSelectedOrderIds] = useState<Set<string>>(new Set());
    const [isLoading, setIsLoading] = useState(false);
    const [isImporting, setIsImporting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [searchQuery, setSearchQuery] = useState('');
    const [syncInfo, setSyncInfo] = useState<{ lastSync: string | null; nextExpectedAt: string | null }>({ lastSync: null, nextExpectedAt: null });

    const fetchOrders = async () => {
        setIsLoading(true);
        setError(null);
        try {
            const data = await config.fetchFn(client.id);
            setOrders(data);
        } catch (err: any) {
            setError(err.message || 'Error al obtener las órdenes.');
        } finally {
            setIsLoading(false);
        }

        if (source === 'MERCADO_LIBRE') {
            try {
                const status = await api.fetchMeliSyncStatus(client.id);
                // Pick the account with the most recent lastSync, so the "last"
                // and "next" figures shown always refer to the same account.
                const withSync = status.accounts.filter(a => a.lastSync);
                const chosen = withSync.length > 0
                    ? withSync.reduce((a, b) => (a.lastSync! > b.lastSync! ? a : b))
                    : status.accounts[0];
                setSyncInfo({ lastSync: chosen?.lastSync ?? null, nextExpectedAt: chosen?.nextExpectedAt ?? null });
            } catch {
                setSyncInfo({ lastSync: null, nextExpectedAt: null }); // Non-critical — just skip showing the timestamps
            }
        }
    };

    // Initial fetch
    React.useEffect(() => {
        fetchOrders();
    }, [client.id, source]);

    const formatLastSync = (iso: string | null): string => {
        if (!iso) return 'Sin datos';
        const diffMin = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
        if (diffMin < 1) return 'hace instantes';
        if (diffMin < 60) return `hace ${diffMin} min`;
        const diffH = Math.floor(diffMin / 60);
        if (diffH < 24) return `hace ${diffH} h`;
        return new Date(iso).toLocaleString('es-CL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    };

    const formatNextImport = (iso: string | null): string => {
        if (!iso) return 'Sin datos';
        const diffMin = Math.ceil((new Date(iso).getTime() - Date.now()) / 60000);
        if (diffMin <= 0) return 'en breve';
        if (diffMin === 1) return 'en 1 min';
        return `en ${diffMin} min`;
    };

    const filteredOrders = orders.filter(order =>
        order.id.toLowerCase().includes(searchQuery.toLowerCase()) ||
        order.recipientName.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (order.address && order.address.toLowerCase().includes(searchQuery.toLowerCase())) ||
        (order.commune && order.commune.toLowerCase().includes(searchQuery.toLowerCase()))
    );

    const isCommuneActive = (communeName: string) => {
        if (!auth?.activeCommunes || auth.activeCommunes.length === 0) return true; // Fallback to all if not loaded
        return auth.activeCommunes.some(c => c.toUpperCase() === (communeName || '').toUpperCase());
    };

    const handleSelectOrder = (order: any) => {
        if (!isCommuneActive(order.commune)) return; // Prevents selection of inactive communes
        
        setSelectedOrderIds(prev => {
            const newSet = new Set(prev);
            if (newSet.has(order.id)) newSet.delete(order.id);
            else newSet.add(order.id);
            return newSet;
        });
    };

    const handleSelectAll = () => {
        const activeOrders = filteredOrders.filter(o => isCommuneActive(o.commune));
        if (selectedOrderIds.size === activeOrders.length && activeOrders.length > 0) {
            setSelectedOrderIds(new Set());
        } else {
            setSelectedOrderIds(new Set(activeOrders.map(o => o.id)));
        }
    };

    const handleImport = async () => {
        if (selectedOrderIds.size === 0) return;
        setIsImporting(true);
        
        try {
            const selectedOrdersList = orders.filter(o => selectedOrderIds.has(o.id));
            const packagesToCreate: Omit<PackageCreationData, 'creatorId' | 'origin'>[] = selectedOrdersList.map(order => {
                const pkg: any = {
                    recipientName: order.recipientName,
                    recipientPhone: order.recipientPhone || 'N/A',
                    recipientAddress: order.address,
                    recipientCommune: order.commune,
                    recipientCity: order.city,
                    notes: order.notes,
                    estimatedDelivery: getLogicalDate(), // Today (logical) by default
                    shippingType: ShippingType.SameDay, // Default
                    source: source,
                    sourceAccountId: order.sourceAccountId
                };
                if (source === 'FALABELLA') {
                    pkg.falabellaOrderId = order.id;
                    pkg.falabellaTrackingId = order.orderNumber;
                } else {
                    pkg[config.orderIdField] = order.id;
                }
                return pkg;
            });

            await onImport(packagesToCreate);
            onClose();
        } catch (err: any) {
            const msg = err?.message || err?.toString() || 'Error al importar las órdenes.';
            setError(msg);
        } finally {
            setIsImporting(false);
        }
    };

    return (
        <div className="fixed inset-0 bg-black bg-opacity-60 z-50 flex justify-center items-center p-4" onClick={onClose}>
            <div className="bg-[var(--background-secondary)] rounded-xl shadow-2xl w-full max-w-4xl h-[90vh] flex flex-col animate-fade-in-up" onClick={e => e.stopPropagation()}>
                <header className="flex items-center justify-between p-4 border-b border-[var(--border-primary)]">
                    <div className="flex items-center gap-3">
                        {config.icon}
                        <div>
                            <h3 className="text-lg font-bold text-[var(--text-primary)]">Importar desde {config.title}</h3>
                            <p className="text-sm text-[var(--text-muted)]">Cliente: {client.name}</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-4">
                        {source === 'MERCADO_LIBRE' && (
                            <span className="text-xs text-[var(--text-muted)] whitespace-nowrap text-right">
                                Última importación: <span className="font-semibold">{formatLastSync(syncInfo.lastSync)}</span>
                                <br />
                                Próxima: <span className="font-semibold">{formatNextImport(syncInfo.nextExpectedAt)}</span>
                            </span>
                        )}
                        <button onClick={onClose} className="p-2 rounded-full text-[var(--text-muted)] hover:bg-[var(--background-hover)]"><IconX className="w-6 h-6" /></button>
                    </div>
                </header>

                <div className="p-4 border-b border-[var(--border-primary)] flex gap-4">
                    <div className="relative flex-1">
                        <IconSearch className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-[var(--text-muted)]" />
                        <input 
                            type="text" 
                            placeholder="Buscar por ID, nombre o dirección..." 
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            className="w-full pl-10 pr-4 py-2 bg-[var(--background-muted)] border border-[var(--border-secondary)] rounded-md focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]"
                        />
                    </div>
                    <button onClick={fetchOrders} className="px-4 py-2 bg-[var(--background-secondary)] border border-[var(--border-secondary)] rounded-md hover:bg-[var(--background-hover)]" title="Recargar">
                        <IconLoader className={`w-5 h-5 text-[var(--text-muted)] ${isLoading ? 'animate-spin' : ''}`} />
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto custom-scrollbar p-4">
                    {error && (
                        <div className="mb-4 p-4 bg-red-100 text-red-700 rounded-md flex items-center gap-2">
                            <IconAlertTriangle className="w-5 h-5" />
                            {error}
                        </div>
                    )}

                    {isLoading ? (
                        <div className="flex flex-col items-center justify-center h-48 text-[var(--text-muted)]">
                            <IconLoader className="w-8 h-8 animate-spin mb-2" />
                            Cargando órdenes...
                        </div>
                    ) : filteredOrders.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-48 text-[var(--text-muted)]">
                            <IconInfo className="w-12 h-12 mb-2 opacity-50" />
                            No se encontraron órdenes pendientes.
                        </div>
                    ) : (
                        <table className="w-full text-sm text-left">
                            <thead className="bg-[var(--background-muted)] text-[var(--text-secondary)] font-semibold sticky top-0">
                                <tr>
                                    <th className="p-3 w-10">
                                        <input type="checkbox" checked={selectedOrderIds.size === filteredOrders.length && filteredOrders.length > 0} onChange={handleSelectAll} className="rounded border-gray-300 text-[var(--brand-primary)] focus:ring-[var(--brand-secondary)]" />
                                    </th>
                                    <th className="p-3">ID Orden</th>
                                    <th className="p-3">Tienda / Cuenta</th>
                                    <th className="p-3">Destinatario</th>
                                    <th className="p-3">Dirección</th>
                                    <th className="p-3">Comuna</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-[var(--border-primary)]">
                                {filteredOrders.map(order => {
                                    const isActive = isCommuneActive(order.commune);
                                    return (
                                        <tr 
                                            key={order.id} 
                                            className={`
                                                border-b border-[var(--border-primary)] transition-colors
                                                ${!isActive ? 'opacity-50 grayscale' : 'hover:bg-[var(--background-hover)] cursor-pointer'} 
                                                ${selectedOrderIds.has(order.id) ? 'bg-[var(--brand-muted)]' : ''}
                                            `} 
                                            onClick={() => handleSelectOrder(order)}
                                        >
                                            <td className="p-3" onClick={e => e.stopPropagation()}>
                                                <input 
                                                    type="checkbox" 
                                                    checked={selectedOrderIds.has(order.id)} 
                                                    onChange={() => handleSelectOrder(order)} 
                                                    disabled={!isActive}
                                                    className={`rounded border-gray-300 text-[var(--brand-primary)] focus:ring-[var(--brand-secondary)] ${!isActive ? 'cursor-not-allowed opacity-50' : ''}`} 
                                                />
                                            </td>
                                            <td className="p-3 font-mono text-[10px]">{order.id}</td>
                                            <td className="p-3">
                                                <div className="flex items-center gap-2">
                                                    <span className="text-[10px] font-black px-2 py-0.5 bg-gray-100 text-gray-600 rounded-full uppercase tracking-tighter">
                                                        {order.sourceAccountName || 'Principal'}
                                                    </span>
                                                </div>
                                            </td>
                                            <td className="p-3 font-medium">{order.recipientName}</td>
                                            <td className="p-3">{order.address}</td>
                                            <td className="p-3">
                                                <div className="flex items-center gap-2">
                                                    <span className={!isActive ? 'text-red-500 font-bold' : ''}>{order.commune}</span>
                                                    {!isActive && (
                                                        <span className="flex items-center gap-1 text-[9px] font-black bg-red-100 text-red-600 px-2 py-0.5 rounded-full uppercase tracking-widest border border-red-200">
                                                            <IconBan className="w-3 h-3" />
                                                            Inactiva
                                                        </span>
                                                    )}
                                                </div>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    )}
                </div>

                <footer className="p-4 border-t border-[var(--border-primary)] bg-[var(--background-muted)] rounded-b-xl flex justify-between items-center">
                    <span className="text-sm text-[var(--text-secondary)]">{selectedOrderIds.size} seleccionados</span>
                    <div className="flex gap-3">
                        <button onClick={onClose} className="px-4 py-2 text-sm font-medium text-[var(--text-secondary)] bg-[var(--background-secondary)] border border-[var(--border-secondary)] rounded-md hover:bg-[var(--background-hover)]">Cancelar</button>
                        <button 
                            onClick={handleImport} 
                            disabled={isImporting || selectedOrderIds.size === 0}
                            className="flex items-center gap-2 px-4 py-2 text-sm font-bold text-white bg-[var(--brand-primary)] rounded-md hover:bg-[var(--brand-secondary)] disabled:bg-slate-400 disabled:cursor-not-allowed"
                        >
                            {isImporting ? <IconLoader className="w-4 h-4 animate-spin" /> : <IconDownload className="w-4 h-4" />}
                            {isImporting ? 'Importando...' : 'Importar Seleccionados'}
                        </button>
                    </div>
                </footer>
            </div>
        </div>
    );
};

export default ExternalImportModal;
