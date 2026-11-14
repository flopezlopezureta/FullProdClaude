
import React, { useState, useEffect } from 'react';
import { api } from '../../services/api';
import { 
    IconMercadoLibre, 
    IconShopify, 
    IconWoocommerce, 
    IconJumpseller, 
    IconPlugConnected, 
    IconTrash, 
    IconPencil, 
    IconCheckCircle, 
    IconAlertTriangle, 
    IconLoader, 
    IconPlus, 
    IconRefresh,
    IconX,
    IconCheck,
    IconDownload,
    IconInfo,
    IconFileText,
    IconFalabella
} from '../Icon';

import { IntegrationAccount } from '../../types';

const AccountManagement: React.FC = () => {
    const [accounts, setAccounts] = useState<IntegrationAccount[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isSaving, setIsSaving] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [editingAccount, setEditingAccount] = useState<string | null>(null);
    const [newName, setNewName] = useState('');
    const [showShopifyModal, setShowShopifyModal] = useState(false);
    const [showJumpsellerModal, setShowJumpsellerModal] = useState(false);
    const [showFalabellaModal, setShowFalabellaModal] = useState(false);
    const [showWooModal, setShowWooModal] = useState(false);
    const [shopifyUrl, setShopifyUrl] = useState('');
    const [shopifyAccessToken, setShopifyAccessToken] = useState('');
    const [isTestingShopify, setIsTestingShopify] = useState(false);
    const [shopifyTestResult, setShopifyTestResult] = useState<{ type: 'success' | 'error', message: string } | null>(null);
    const [wooUrl, setWooUrl] = useState('');
    const [wooConsumerKey, setWooConsumerKey] = useState('');
    const [wooConsumerSecret, setWooConsumerSecret] = useState('');
    const [jumpsellerToken, setJumpsellerToken] = useState('');
    const [jumpsellerLogin, setJumpsellerLogin] = useState('');
    const [falabellaApiKey, setFalabellaApiKey] = useState('');
    const [falabellaSellerId, setFalabellaSellerId] = useState('');

    const fetchAccounts = async () => {
        setIsLoading(true);
        setError(null);
        try {
            const data = await api.getIntegrationAccounts();
            setAccounts(data);
        } catch (err: any) {
            setError('Error al cargar las cuentas: ' + (err.message || 'Error desconocido'));
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        fetchAccounts();
    }, []);

    const handleRename = async (accountId: string) => {
        if (!newName.trim()) return;
        setIsSaving(accountId);
        try {
            await api.updateIntegrationAccount(accountId, { nickname: newName });
            setEditingAccount(null);
            fetchAccounts();
        } catch (err: any) {
            alert('Error al renombrar cuenta: ' + (err.message || 'Error desconocido'));
        } finally {
            setIsSaving(null);
        }
    };

    const handleDelete = async (accountId: string) => {
        if (!confirm('¿Estás seguro de que deseas desconectar esta cuenta?')) return;
        setIsSaving(accountId);
        try {
            await api.deleteIntegrationAccount(accountId);
            fetchAccounts();
        } catch (err: any) {
            alert('Error al eliminar cuenta: ' + (err.message || 'Error desconocido'));
        } finally {
            setIsSaving(null);
        }
    };

    const toggleAutoImport = async (accountId: string, current: boolean) => {
        setIsSaving(accountId);
        try {
            await api.updateIntegrationAccount(accountId, { settings: { autoImport: !current } });
            fetchAccounts();
        } catch (err: any) {
            alert('Error al actualizar configuración: ' + (err.message || 'Error desconocido'));
        } finally {
            setIsSaving(null);
        }
    };

    const getIcon = (type: string) => {
        switch (type) {
            case 'MERCADO_LIBRE': return <IconMercadoLibre className="w-6 h-6 text-yellow-500" />;
            case 'SHOPIFY': return <IconShopify className="w-6 h-6 text-green-500" />;
            case 'WOOCOMMERCE': return <IconWoocommerce className="w-6 h-6 text-purple-600" />;
            case 'FALABELLA': return <IconFalabella className="w-6 h-6 text-lime-600" />;
            case 'JUMPSELLER': return <IconJumpseller className="w-6 h-6 text-sky-600" />;
            default: return <IconPlugConnected className="w-6 h-6 text-gray-500" />;
        }
    };

    if (isLoading) {
        return (
            <div className="flex flex-col items-center justify-center p-12 text-[var(--text-muted)]">
                <IconLoader className="w-10 h-10 animate-spin mb-4 text-blue-500" />
                <p className="font-bold">Cargando tus cuentas vinculadas...</p>
            </div>
        );
    }

    return (
        <div className="space-y-6">
            <div className="flex justify-between items-center">
                <div>
                    <h2 className="text-xl font-black text-[var(--text-primary)] uppercase tracking-tight">Cuentas Vinculadas</h2>
                    <p className="text-sm text-[var(--text-muted)]">Gestiona tus múltiples tiendas e integraciones en un solo lugar.</p>
                </div>
                <div className="flex items-center gap-2">
                    <button 
                        onClick={fetchAccounts}
                        className="p-2 rounded-full hover:bg-[var(--background-hover)] transition-colors text-[var(--text-muted)]"
                        title="Actualizar"
                    >
                        <IconRefresh className="w-5 h-5" />
                    </button>
                </div>
            </div>

            {error && (
                <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm flex items-center gap-3">
                    <IconAlertTriangle className="w-5 h-5 flex-shrink-0" />
                    {error}
                </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {accounts.map(acc => (
                    <div key={acc.id} className="bg-white border border-[var(--border-primary)] rounded-xl shadow-sm hover:shadow-md transition-all overflow-hidden flex flex-col">
                        <div className="p-5 flex-1">
                            <div className="flex justify-between items-start mb-4">
                                <div className="flex items-center gap-3">
                                    <div className="p-2 bg-gray-50 rounded-lg border border-gray-100">
                                        {getIcon(acc.type)}
                                    </div>
                                    <div>
                                        {editingAccount === acc.id ? (
                                            <div className="flex items-center gap-2">
                                                <input 
                                                    type="text" 
                                                    value={newName} 
                                                    onChange={(e) => setNewName(e.target.value)}
                                                    className="text-sm font-bold border border-blue-500 rounded px-2 py-1 outline-none"
                                                    autoFocus
                                                />
                                                <button onClick={() => handleRename(acc.id)} className="text-green-600 hover:text-green-700">
                                                    <IconCheck className="w-5 h-5" />
                                                </button>
                                                <button onClick={() => setEditingAccount(null)} className="text-red-600 hover:text-red-700">
                                                    <IconX className="w-5 h-5" />
                                                </button>
                                            </div>
                                        ) : (
                                            <div className="flex items-center gap-2 group">
                                                <h3 className="font-bold text-[var(--text-primary)]">{acc.nickname || acc.name || 'Sin nombre'}</h3>
                                                <button 
                                                    onClick={() => { setEditingAccount(acc.id); setNewName(acc.nickname || acc.name || ''); }}
                                                    className="opacity-0 group-hover:opacity-100 transition-opacity p-1 text-gray-400 hover:text-blue-500"
                                                >
                                                    <IconPencil className="w-3.5 h-3.5" />
                                                </button>
                                            </div>
                                        )}
                                        <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest">{acc.type.replace('_', ' ')}</p>
                                    </div>
                                </div>
                                <div className="flex items-center gap-1">
                                    <span className={`flex items-center gap-1 text-[10px] font-black px-2 py-0.5 rounded-full uppercase tracking-widest ${acc.status === 'CONNECTED' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                                        <div className={`w-1.5 h-1.5 rounded-full ${acc.status === 'CONNECTED' ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`}></div>
                                        {acc.status === 'CONNECTED' ? 'Conectado' : 'Error'}
                                    </span>
                                </div>
                            </div>

                            <div className="space-y-3 pt-3 border-t border-gray-50">
                                <div className="flex items-center justify-between">
                                    <div className="flex flex-col">
                                        <span className="text-xs font-bold text-gray-700">Sincronización Automática</span>
                                        <div className="flex items-center gap-1 mt-0.5">
                                            <span className="text-[10px] text-gray-400">Cada</span>
                                            <select 
                                                value={acc.settings?.syncInterval || 30}
                                                onChange={(e) => {
                                                    const val = parseInt(e.target.value);
                                                    api.updateIntegrationAccount(acc.id, { settings: { ...acc.settings, syncInterval: val } })
                                                        .then(() => fetchAccounts())
                                                        .catch(err => alert('Error: ' + err.message));
                                                }}
                                                className="text-[10px] font-bold text-indigo-600 bg-indigo-50 border-none rounded px-1 py-0.5 outline-none cursor-pointer hover:bg-indigo-100 transition-colors"
                                            >
                                                <option value="5">5 min</option>
                                                <option value="10">10 min</option>
                                                <option value="15">15 min</option>
                                                <option value="30">30 min</option>
                                                <option value="60">60 min</option>
                                            </select>
                                        </div>
                                    </div>
                                    <button 
                                        onClick={() => toggleAutoImport(acc.id, acc.settings?.autoImport)}
                                        disabled={isSaving === acc.id}
                                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none ${acc.settings?.autoImport ? 'bg-blue-600' : 'bg-gray-200'}`}
                                    >
                                        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${acc.settings?.autoImport ? 'translate-x-6' : 'translate-x-1'}`} />
                                    </button>
                                </div>
                                {acc.settings?.lastSync && (
                                    <div className="text-[10px] text-gray-400 italic">
                                        Última sincronización: {new Date(acc.settings.lastSync).toLocaleString()}
                                    </div>
                                )}
                            </div>
                        </div>
                        
                        <div className="px-5 py-3 bg-gray-50 border-t border-gray-100 flex justify-between items-center">
                            <span className="text-[10px] text-gray-400 font-medium">Vinculado el {new Date(acc.connectedAt).toLocaleDateString()}</span>
                            <button 
                                onClick={() => handleDelete(acc.id)}
                                disabled={isSaving === acc.id}
                                className="flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-black uppercase tracking-widest text-red-600 hover:bg-red-100 rounded-md transition-colors"
                            >
                                {isSaving === acc.id ? <IconLoader className="w-3 h-3 animate-spin" /> : <IconTrash className="w-3 h-3" />}
                                Desconectar
                            </button>
                        </div>
                    </div>
                ))}
                               {/* Add Account Card */}
                <div
                    className="group relative overflow-hidden bg-white border-2 border-dashed border-gray-200 rounded-2xl p-8 flex flex-col items-center justify-center text-center hover:border-indigo-400 hover:bg-indigo-50/30 transition-all duration-300 shadow-sm hover:shadow-xl"
                >
                    <div className="absolute inset-0 bg-gradient-to-br from-indigo-500/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
                    
                    <div className="relative w-16 h-16 rounded-2xl bg-indigo-100 text-indigo-600 flex items-center justify-center mb-5 group-hover:scale-110 transition-transform duration-500 shadow-inner">
                        <IconPlus className="w-8 h-8" />
                    </div>
                    
                    <h3 className="relative font-bold text-gray-800 text-lg mb-2">Vincular Nueva Cuenta</h3>
                    <p className="relative text-sm text-gray-500 mb-6 max-w-[260px]">Elige la plataforma que quieres conectar:</p>
                    
                    <div className="relative flex flex-wrap items-stretch justify-center gap-3">
                        <button 
                            onClick={() => {
                                const token = localStorage.getItem('token');
                                window.location.href = `/api/integrations/meli/auth?token=${token}`;
                            }}
                            className="flex flex-col items-center gap-1 px-3 py-2 min-w-[88px] bg-white border border-gray-200 rounded-xl hover:border-yellow-500 hover:text-yellow-600 hover:shadow-md transition-all active:scale-95"
                            title="Vincular Mercado Libre"
                        >
                            <IconMercadoLibre className="w-6 h-6" />
                            <span className="text-[10px] font-bold text-gray-600">Mercado Libre</span>
                        </button>
                        <button 
                            onClick={() => setShowShopifyModal(true)}
                            className="flex flex-col items-center gap-1 px-3 py-2 min-w-[88px] bg-white border border-gray-200 rounded-xl hover:border-green-500 hover:text-green-600 hover:shadow-md transition-all active:scale-95"
                            title="Vincular Shopify"
                        >
                            <IconShopify className="w-6 h-6" />
                            <span className="text-[10px] font-bold text-gray-600">Shopify</span>
                        </button>
                        <button 
                            onClick={() => setShowWooModal(true)}
                            className="flex flex-col items-center gap-1 px-3 py-2 min-w-[88px] bg-white border border-gray-200 rounded-xl hover:border-purple-500 hover:text-purple-600 hover:shadow-md transition-all active:scale-95"
                            title="Vincular WooCommerce"
                        >
                            <IconWoocommerce className="w-6 h-6" />
                            <span className="text-[10px] font-bold text-gray-600">WooCommerce</span>
                        </button>
                        <button 
                            onClick={() => setShowFalabellaModal(true)}
                            className="flex flex-col items-center gap-1 px-3 py-2 min-w-[88px] bg-white border border-gray-200 rounded-xl hover:border-lime-500 hover:text-lime-600 hover:shadow-md transition-all active:scale-95"
                            title="Vincular Falabella"
                        >
                            <IconFalabella className="w-6 h-6" />
                            <span className="text-[10px] font-bold text-gray-600">Falabella</span>
                        </button>
                        <button 
                            onClick={() => setShowJumpsellerModal(true)}
                            className="flex flex-col items-center gap-1 px-3 py-2 min-w-[88px] bg-white border border-gray-200 rounded-xl hover:border-sky-500 hover:text-sky-600 hover:shadow-md transition-all active:scale-95"
                            title="Vincular Jumpseller"
                        >
                            <IconJumpseller className="w-6 h-6" />
                            <span className="text-[10px] font-bold text-gray-600">Jumpseller</span>
                        </button>
                    </div>
                </div>
            </div>

            {/* Shopify Installation Modal */}
            {showShopifyModal && (
                <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[60] flex items-center justify-center p-4 animate-fade-in" onClick={() => setShowShopifyModal(false)}>
                    <div className="bg-white rounded-3xl shadow-2xl w-full max-w-md overflow-hidden animate-zoom-in" onClick={e => e.stopPropagation()}>
                        <div className="bg-indigo-600 p-6 text-white relative">
                            <button onClick={() => setShowShopifyModal(false)} className="absolute top-4 right-4 p-2 hover:bg-white/20 rounded-full transition-colors">
                                <IconX className="w-5 h-5" />
                            </button>
                            <div className="w-12 h-12 bg-white/20 rounded-2xl flex items-center justify-center mb-4">
                                <IconShopify className="w-7 h-7 text-white" />
                            </div>
                            <h3 className="text-xl font-bold">Vincular Tienda Shopify</h3>
                            <p className="text-indigo-100 text-sm mt-1">Conecta tu tienda en dos pasos.</p>
                        </div>
                        
                        <div className="p-8 space-y-4">
                            <div>
                                <label className="block text-sm font-semibold text-gray-700 mb-2">Dominio de la Tienda</label>
                                <input 
                                    type="text" 
                                    placeholder="mi-tienda.myshopify.com"
                                    value={shopifyUrl}
                                    onChange={(e) => setShopifyUrl(e.target.value)}
                                    className="w-full px-4 py-4 bg-gray-50 border-2 border-gray-100 rounded-2xl focus:border-indigo-500 focus:bg-white outline-none transition-all text-gray-800 font-medium placeholder:text-gray-300"
                                />
                            </div>

                            <div>
                                <button
                                    type="button"
                                    onClick={() => {
                                        if (!shopifyUrl.trim()) {
                                            alert("Por favor ingresa el dominio de tu tienda (ej: mi-tienda.myshopify.com)");
                                            return;
                                        }
                                        const shopClean = shopifyUrl.trim().replace(/^https?:\/\//, '').split('/')[0];
                                        // Ruta pública (no pide sesión): lleva a Shopify a autorizar la app y termina en una página con el token para copiarlo.
                                        window.open(`/api/integrations/shopify/install?shop=${encodeURIComponent(shopClean)}`, '_blank');
                                    }}
                                    className="w-full py-4 text-sm font-bold text-green-700 hover:bg-green-50 rounded-2xl transition-all flex items-center justify-center gap-2 border-2 border-green-200"
                                >
                                    <IconShopify className="w-5 h-5" />
                                    1. Autorizar en Shopify y obtener el token
                                </button>
                            </div>

                            <div>
                                <label className="block text-sm font-semibold text-gray-700 mb-2">2. Token de acceso</label>
                                <input
                                    type="password"
                                    placeholder="Pega aquí el token de la página «Conexión exitosa»"
                                    value={shopifyAccessToken}
                                    onChange={(e) => setShopifyAccessToken(e.target.value)}
                                    className="w-full px-4 py-4 bg-gray-50 border-2 border-gray-100 rounded-2xl focus:border-indigo-500 focus:bg-white outline-none transition-all text-gray-800 font-medium placeholder:text-gray-300"
                                />
                                <p className="text-[10px] text-gray-400 mt-1 italic">Al autorizar, Shopify te lleva a una página con tu token: cópialo y pégalo aquí. Si usas una app personalizada propia, pega su token (shpat_…).</p>
                            </div>
                            
                            {shopifyTestResult && (
                                <div className={`p-4 rounded-2xl text-xs flex gap-3 ${shopifyTestResult.type === 'success' ? 'bg-green-50 text-green-700 border border-green-100' : 'bg-red-50 text-red-700 border border-red-100'}`}>
                                    {shopifyTestResult.type === 'success' ? <IconCheckCircle className="w-5 h-5 shrink-0" /> : <IconAlertTriangle className="w-5 h-5 shrink-0" />}
                                    <p className="font-bold">{shopifyTestResult.message}</p>
                                </div>
                            )}

                            
                            
                            <div className="grid grid-cols-1 gap-3 pt-4">
                                <button 
                                    onClick={async () => {
                                        if (!shopifyUrl.trim() || !shopifyAccessToken.trim()) return;
                                        setIsTestingShopify(true);
                                        setShopifyTestResult(null);
                                        try {
                                            await api.createIntegrationAccount({
                                                type: 'SHOPIFY',
                                                nickname: `Shopify (${shopifyUrl})`,
                                                credentials: { shopUrl: shopifyUrl, accessToken: shopifyAccessToken }
                                            });
                                            setShopifyTestResult({ type: 'success', message: '¡Tienda vinculada correctamente!' });
                                            setTimeout(() => {
                                                setShowShopifyModal(false);
                                                fetchAccounts();
                                            }, 1500);
                                        } catch (err: any) {
                                            setShopifyTestResult({ type: 'error', message: err.message || 'Error al conectar' });
                                        } finally {
                                            setIsTestingShopify(false);
                                        }
                                    }}
                                    disabled={isTestingShopify || !shopifyUrl.trim() || !shopifyAccessToken.trim()}
                                    className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold py-4 rounded-2xl shadow-lg transition-all active:scale-[0.98] flex items-center justify-center gap-2"
                                >
                                    {isTestingShopify ? <IconLoader className="w-5 h-5 animate-spin" /> : <IconPlugConnected className="w-5 h-5" />}
                                    Vincular tienda
                                </button>

                                
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Jumpseller Modal */}
            {showJumpsellerModal && (
                <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[60] flex items-center justify-center p-4 animate-fade-in" onClick={() => setShowJumpsellerModal(false)}>
                    <div className="bg-white rounded-3xl shadow-2xl w-full max-w-md overflow-hidden animate-zoom-in" onClick={e => e.stopPropagation()}>
                        <div className="bg-sky-600 p-6 text-white relative">
                            <button onClick={() => setShowJumpsellerModal(false)} className="absolute top-4 right-4 p-2 hover:bg-white/20 rounded-full transition-colors">
                                <IconX className="w-5 h-5" />
                            </button>
                            <div className="w-12 h-12 bg-white/20 rounded-2xl flex items-center justify-center mb-4">
                                <IconJumpseller className="w-7 h-7 text-white" />
                            </div>
                            <h3 className="text-xl font-bold">Vincular Jumpseller</h3>
                            <p className="text-sky-100 text-sm mt-1">Conecta tu tienda usando tu API Token.</p>
                        </div>
                        
                        <div className="p-8 space-y-4">
                            <div>
                                <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">Email de acceso (Login)</label>
                                <input 
                                    type="text" 
                                    placeholder="email@ejemplo.com"
                                    value={jumpsellerLogin}
                                    onChange={(e) => setJumpsellerLogin(e.target.value)}
                                    className="w-full px-4 py-3 bg-gray-50 border-2 border-gray-100 rounded-xl focus:border-sky-500 outline-none transition-all"
                                />
                            </div>
                            <div>
                                <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">API Token</label>
                                <input 
                                    type="password" 
                                    placeholder="Tu token de Jumpseller"
                                    value={jumpsellerToken}
                                    onChange={(e) => setJumpsellerToken(e.target.value)}
                                    className="w-full px-4 py-3 bg-gray-50 border-2 border-gray-100 rounded-xl focus:border-sky-500 outline-none transition-all"
                                />
                            </div>
                            
                            <button 
                                onClick={async () => {
                                    if (!jumpsellerLogin || !jumpsellerToken) return;
                                    setIsLoading(true);
                                    try {
                                        await api.createIntegrationAccount({
                                            type: 'JUMPSELLER',
                                            nickname: `Tienda Jumpseller (${jumpsellerLogin})`,
                                            credentials: { login: jumpsellerLogin, token: jumpsellerToken }
                                        });
                                        setShowJumpsellerModal(false);
                                        fetchAccounts();
                                    } catch (err: any) {
                                        alert(err.message || 'Error al conectar Jumpseller');
                                    } finally {
                                        setIsLoading(false);
                                    }
                                }}
                                className="w-full mt-4 bg-sky-600 hover:bg-sky-700 text-white font-bold py-4 rounded-2xl shadow-lg shadow-sky-200 transition-all active:scale-[0.98]"
                            >
                                Conectar Jumpseller
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* WooCommerce Modal */}
            {showWooModal && (
                <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[60] flex items-center justify-center p-4 animate-fade-in" onClick={() => setShowWooModal(false)}>
                    <div className="bg-white rounded-3xl shadow-2xl w-full max-w-md overflow-hidden animate-zoom-in" onClick={e => e.stopPropagation()}>
                        <div className="bg-purple-600 p-6 text-white relative">
                            <button onClick={() => setShowWooModal(false)} className="absolute top-4 right-4 p-2 hover:bg-white/20 rounded-full transition-colors">
                                <IconX className="w-5 h-5" />
                            </button>
                            <div className="w-12 h-12 bg-white/20 rounded-2xl flex items-center justify-center mb-4">
                                <IconWoocommerce className="w-7 h-7 text-white" />
                            </div>
                            <h3 className="text-xl font-bold">Vincular WooCommerce</h3>
                            <p className="text-purple-100 text-sm mt-1">Conecta tu tienda WordPress vía API REST.</p>
                        </div>
                        
                        <div className="p-8 space-y-4">
                            <div>
                                <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">URL del Sitio</label>
                                <input 
                                    type="text" 
                                    placeholder="https://tu-tienda.cl"
                                    value={wooUrl}
                                    onChange={(e) => setWooUrl(e.target.value)}
                                    className="w-full px-4 py-3 bg-gray-50 border-2 border-gray-100 rounded-xl focus:border-purple-500 outline-none transition-all"
                                />
                            </div>
                            <div>
                                <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">Consumer Key</label>
                                <input 
                                    type="text" 
                                    placeholder="ck_..."
                                    value={wooConsumerKey}
                                    onChange={(e) => setWooConsumerKey(e.target.value)}
                                    className="w-full px-4 py-3 bg-gray-50 border-2 border-gray-100 rounded-xl focus:border-purple-500 outline-none transition-all"
                                />
                            </div>
                            <div>
                                <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">Consumer Secret</label>
                                <input 
                                    type="password" 
                                    placeholder="cs_..."
                                    value={wooConsumerSecret}
                                    onChange={(e) => setWooConsumerSecret(e.target.value)}
                                    className="w-full px-4 py-3 bg-gray-50 border-2 border-gray-100 rounded-xl focus:border-purple-500 outline-none transition-all"
                                />
                            </div>
                            
                            <button 
                                onClick={async () => {
                                    if (!wooUrl || !wooConsumerKey || !wooConsumerSecret) return;
                                    setIsLoading(true);
                                    try {
                                        await api.createIntegrationAccount({
                                            type: 'WOOCOMMERCE',
                                            nickname: `WooCommerce (${wooUrl})`,
                                            credentials: { wooUrl, wooConsumerKey, wooConsumerSecret }
                                        });
                                        setShowWooModal(false);
                                        fetchAccounts();
                                    } catch (err: any) {
                                        alert(err.message || 'Error al conectar WooCommerce');
                                    } finally {
                                        setIsLoading(false);
                                    }
                                }}
                                className="w-full mt-4 bg-purple-600 hover:bg-purple-700 text-white font-bold py-4 rounded-2xl shadow-lg shadow-purple-200 transition-all active:scale-[0.98]"
                            >
                                Conectar WooCommerce
                            </button>
                        </div>
                    </div>
                </div>
            )}
            {showFalabellaModal && (
                <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[60] flex items-center justify-center p-4 animate-fade-in" onClick={() => setShowFalabellaModal(false)}>
                    <div className="bg-white rounded-3xl shadow-2xl w-full max-w-md overflow-hidden animate-zoom-in" onClick={e => e.stopPropagation()}>
                        <div className="bg-lime-600 p-6 text-white relative">
                            <button onClick={() => setShowFalabellaModal(false)} className="absolute top-4 right-4 p-2 hover:bg-white/20 rounded-full transition-colors">
                                <IconX className="w-5 h-5" />
                            </button>
                            <div className="w-12 h-12 bg-white/20 rounded-2xl flex items-center justify-center mb-4">
                                <IconFalabella className="w-7 h-7 text-white" />
                            </div>
                            <h3 className="text-xl font-bold">Vincular Falabella</h3>
                            <p className="text-lime-100 text-sm mt-1">Usa tus credenciales de Seller Center.</p>
                        </div>
                        
                        <div className="p-8 space-y-4">
                            <div>
                                <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">API Key</label>
                                <input 
                                    type="text" 
                                    placeholder="Tu API Key de Falabella"
                                    value={falabellaApiKey}
                                    onChange={(e) => setFalabellaApiKey(e.target.value)}
                                    className="w-full px-4 py-3 bg-gray-50 border-2 border-gray-100 rounded-xl focus:border-lime-500 outline-none transition-all"
                                />
                            </div>
                            <div>
                                <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">Seller ID / Email</label>
                                <input 
                                    type="text" 
                                    placeholder="Tu ID de vendedor"
                                    value={falabellaSellerId}
                                    onChange={(e) => setFalabellaSellerId(e.target.value)}
                                    className="w-full px-4 py-3 bg-gray-50 border-2 border-gray-100 rounded-xl focus:border-lime-500 outline-none transition-all"
                                />
                            </div>
                            
                            <button 
                                onClick={async () => {
                                    if (!falabellaApiKey || !falabellaSellerId) return;
                                    setIsLoading(true);
                                    try {
                                        await api.createIntegrationAccount({
                                            type: 'FALABELLA',
                                            nickname: `Falabella (${falabellaSellerId})`,
                                            credentials: { falabellaApiKey, falabellaSellerId }
                                        });
                                        setShowFalabellaModal(false);
                                        fetchAccounts();
                                    } catch (err: any) {
                                        alert(err.message || 'Error al conectar Falabella');
                                    } finally {
                                        setIsLoading(false);
                                    }
                                }}
                                className="w-full mt-4 bg-lime-600 hover:bg-lime-700 text-white font-bold py-4 rounded-2xl shadow-lg shadow-lime-200 transition-all active:scale-[0.98]"
                            >
                                Conectar Falabella
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {accounts.length === 0 && !isLoading && (
                <div className="bg-blue-50 border border-blue-100 rounded-xl p-10 flex flex-col items-center text-center">
                    <div className="w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center mb-4">
                        <IconPlugConnected className="w-8 h-8 text-blue-600" />
                    </div>
                    <h3 className="text-lg font-bold text-blue-900 mb-2">No tienes cuentas vinculadas</h3>
                    <p className="text-sm text-blue-700 max-w-md">Conecta tus cuentas de ventas para que Full Envíos pueda importar automáticamente tus pedidos y generar etiquetas de despacho.</p>
                </div>
            )}

            {/* Help & Manuals Section */}
            <div className="mt-12 pt-8 border-t border-gray-100">
                <div className="flex items-center gap-3 mb-6">
                    <div className="p-2 bg-indigo-100 text-indigo-600 rounded-lg">
                        <IconInfo className="w-5 h-5" />
                    </div>
                    <div>
                        <h3 className="font-bold text-gray-800">Centro de Ayuda</h3>
                        <p className="text-xs text-gray-500">Descarga los manuales paso a paso para tus integraciones.</p>
                    </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
                    <a 
                        href="/manuals/meli_guide.html" 
                        target="_blank" 
                        className="group p-4 bg-white border border-gray-200 rounded-2xl hover:border-yellow-500 hover:shadow-md transition-all flex items-center justify-between"
                    >
                        <div className="flex items-center gap-3">
                            <div className="p-2 bg-yellow-50 text-yellow-600 rounded-xl group-hover:bg-yellow-500 group-hover:text-white transition-colors">
                                <IconMercadoLibre className="w-6 h-6" />
                            </div>
                            <div>
                                <h4 className="text-sm font-bold text-gray-700">Guía Meli</h4>
                                <p className="text-[10px] text-gray-400">Estrategia Multi-Cuenta</p>
                            </div>
                        </div>
                        <IconDownload className="w-5 h-5 text-gray-300 group-hover:text-yellow-500" />
                    </a>

                    <a 
                        href="/manuals/shopify_guide.html" 
                        target="_blank" 
                        className="group p-4 bg-white border border-gray-200 rounded-2xl hover:border-green-500 hover:shadow-md transition-all flex items-center justify-between"
                    >
                        <div className="flex items-center gap-3">
                            <div className="p-2 bg-green-50 text-green-600 rounded-xl group-hover:bg-green-600 group-hover:text-white transition-colors">
                                <IconShopify className="w-6 h-6" />
                            </div>
                            <div>
                                <h4 className="text-sm font-bold text-gray-700">Guía Shopify</h4>
                                <p className="text-[10px] text-gray-400">Configuración OAuth 2.0</p>
                            </div>
                        </div>
                        <IconDownload className="w-5 h-5 text-gray-300 group-hover:text-green-500" />
                    </a>

                    <a 
                        href="/manuals/falabella_guide.html" 
                        target="_blank" 
                        className="group p-4 bg-white border border-gray-200 rounded-2xl hover:border-lime-500 hover:shadow-md transition-all flex items-center justify-between"
                    >
                        <div className="flex items-center gap-3">
                            <div className="p-2 bg-lime-50 text-lime-600 rounded-xl group-hover:bg-lime-600 group-hover:text-white transition-colors">
                                <IconFalabella className="w-6 h-6" />
                            </div>
                            <div>
                                <h4 className="text-sm font-bold text-gray-700">Guía Falabella</h4>
                                <p className="text-[10px] text-gray-400">Credenciales API Key</p>
                            </div>
                        </div>
                        <IconDownload className="w-5 h-5 text-gray-300 group-hover:text-lime-500" />
                    </a>

                    <a 
                        href="/manuals/woocommerce_guide.html" 
                        target="_blank" 
                        className="group p-4 bg-white border border-gray-200 rounded-2xl hover:border-purple-500 hover:shadow-md transition-all flex items-center justify-between"
                    >
                        <div className="flex items-center gap-3">
                            <div className="p-2 bg-purple-50 text-purple-600 rounded-xl group-hover:bg-purple-600 group-hover:text-white transition-colors">
                                <IconWoocommerce className="w-6 h-6" />
                            </div>
                            <div>
                                <h4 className="text-sm font-bold text-gray-700">Guía WooCommerce</h4>
                                <p className="text-[10px] text-gray-400">Instalación del Plugin</p>
                            </div>
                        </div>
                        <IconDownload className="w-5 h-5 text-gray-300 group-hover:text-purple-500" />
                    </a>

                    <a 
                        href="/manuals/jumpseller_guide.html" 
                        target="_blank" 
                        className="group p-4 bg-white border border-gray-200 rounded-2xl hover:border-sky-500 hover:shadow-md transition-all flex items-center justify-between"
                    >
                        <div className="flex items-center gap-3">
                            <div className="p-2 bg-sky-50 text-sky-600 rounded-xl group-hover:bg-sky-600 group-hover:text-white transition-colors">
                                <IconJumpseller className="w-6 h-6" />
                            </div>
                            <div>
                                <h4 className="text-sm font-bold text-gray-700">Guía Jumpseller</h4>
                                <p className="text-[10px] text-gray-400">Configuración de Webhooks</p>
                            </div>
                        </div>
                        <IconDownload className="w-5 h-5 text-gray-300 group-hover:text-sky-500" />
                    </a>
                </div>
            </div>
        </div>
    );
};

export default AccountManagement;
