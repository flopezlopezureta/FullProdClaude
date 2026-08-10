
import React, { useState, useEffect, useContext } from 'react';
import { api } from '../../services/api';
import type { IntegrationSettings } from '../../types';
import { IconCheckCircle, IconLoader, IconAlertTriangle, IconPlugConnected, IconEye, IconEyeOff, IconShopify, IconMercadoLibre, IconGithub, IconDownload, IconWoocommerce, IconFalabella, IconMail, IconJumpseller, IconInfo } from '../Icon';
import { AuthContext } from '../../contexts/AuthContext';

const IntegrationSettingsPage: React.FC = () => {
    const auth = useContext(AuthContext);
    const [settings, setSettings] = useState<Partial<IntegrationSettings>>({
        meliAppId: '',
        meliClientSecret: '',
        shopifyShopUrl: '',
        shopifyAccessToken: '',
        shopifyAutoImport: false,
        shopifySyncInterval: 5,
        shopifyWebhookSecret: '',
        shopifyClientId: '',
        shopifyClientSecret: '',
        githubToken: '',
        githubRepo: '',
        githubOwner: '',
        wooUrl: '',
        wooConsumerKey: '',
        wooConsumerSecret: '',
        wooAutoImport: false,
        wooSyncInterval: 30,
        falabellaApiKey: '',
        falabellaSellerId: '',
        falabellaDirectClientId: '',
        falabellaDirectClientSecret: '',
        falabellaDirectEnvironment: 'UAT',
        smtpHost: '',
        smtpPort: '',
        smtpUser: '',
        smtpPassword: '',
        smtpFrom: '',
        jumpsellerLogin: '',
        jumpsellerToken: '',
        jumpsellerAutoImport: false,
        jumpsellerSyncInterval: 10,
    });
    const [passwordVisibility, setPasswordVisibility] = useState({
        meliClientSecret: false,
        shopifyAccessToken: false,
        shopifyClientSecret: false,
        shopifyWebhookSecret: false,
        githubToken: false,
        wooConsumerSecret: false,
        falabellaApiKey: false,
        falabellaDirectClientSecret: false,
        smtpPassword: false,
        jumpsellerToken: false,
    });
    const [isLoading, setIsLoading] = useState(true);
    
    // Independent Loading States
    const [isSavingMeli, setIsSavingMeli] = useState(false);
    const [isSavingShopify, setIsSavingShopify] = useState(false);
    const [isSavingGithub, setIsSavingGithub] = useState(false);
    const [isSavingWoo, setIsSavingWoo] = useState(false);
    const [isSavingFalabella, setIsSavingFalabella] = useState(false);
    const [isSavingFalabellaDirect, setIsSavingFalabellaDirect] = useState(false);
    const [isSavingJumpseller, setIsSavingJumpseller] = useState(false);
    const [isSavingSmtp, setIsSavingSmtp] = useState(false);
    const [isBackingUp, setIsBackingUp] = useState(false);
    
    // Meli Test State
    const [isTestingMeli, setIsTestingMeli] = useState(false);
    const [meliTestResult, setMeliTestResult] = useState<{ type: 'success' | 'error', message: string } | null>(null);
    const [meliDebugLog, setMeliDebugLog] = useState<string[]>([]);

    // Shopify Test State
    const [isTestingShopify, setIsTestingShopify] = useState(false);
    const [shopifyTestResult, setShopifyTestResult] = useState<{ type: 'success' | 'error', message: string } | null>(null);

    // WooCommerce Test State
    const [isTestingWoo, setIsTestingWoo] = useState(false);
    const [wooTestResult, setWooTestResult] = useState<{ type: 'success' | 'error', message: string } | null>(null);

    // Falabella Test State
    const [isTestingFalabella, setIsTestingFalabella] = useState(false);
    const [falabellaTestResult, setFalabellaTestResult] = useState<{ type: 'success' | 'error', message: string } | null>(null);

    // Falabella Directo (Courier) Test State
    const [isTestingFalabellaDirect, setIsTestingFalabellaDirect] = useState(false);
    const [falabellaDirectTestResult, setFalabellaDirectTestResult] = useState<{ type: 'success' | 'error', message: string } | null>(null);

    // GitHub Backup State
    const [backupResult, setBackupResult] = useState<{ type: 'success' | 'error', message: string } | null>(null);

    // SMTP Test State
    const [isTestingSmtp, setIsTestingSmtp] = useState(false);
    const [smtpTestResult, setSmtpTestResult] = useState<{ type: 'success' | 'error', message: string } | null>(null);

    // Jumpseller Test State
    const [isTestingJumpseller, setIsTestingJumpseller] = useState(false);
    const [jumpsellerTestResult, setJumpsellerTestResult] = useState<{ type: 'success' | 'error', message: string } | null>(null);
    const [jumpsellerActiveTab, setJumpsellerActiveTab] = useState<'connect' | 'sync' | 'manual'>('connect');
    const [shopifyActiveTab, setShopifyActiveTab] = useState<'connect' | 'sync' | 'manual'>('connect');
    const [wooActiveTab, setWooActiveTab] = useState<'connect' | 'sync' | 'manual'>('connect');
    const [isAuthorizingGoogle, setIsAuthorizingGoogle] = useState(false);
    const [activeTab, setActiveTab] = useState<'help' | 'meli' | 'shopify' | 'woocommerce' | 'falabella' | 'falabella-direct' | 'jumpseller' | 'smtp' | 'github'>('help');
    const isSuperUser = auth?.user?.email === 'admin' || auth?.user?.email === 'admin@admin.cl';

    useEffect(() => {
        const fetchSettings = async () => {
            setIsLoading(true);
            try {
                const fetchedSettings = await api.getIntegrationSettings();
                setSettings(prev => ({
                    ...prev,
                    ...fetchedSettings
                }));
            } catch (err: any) {
                console.error(err);
            } finally {
                setIsLoading(false);
            }
        };
        fetchSettings();

        // [NUEVO] Escuchar el mensaje de éxito desde el popup de Google
        const handleMessage = (event: MessageEvent) => {
            if (event.data.type === 'GOOGLE_AUTH_SUCCESS') {
                setSettings(prev => ({
                    ...prev,
                    hasGoogleSmtp: true,
                    smtpGoogleEmail: event.data.email
                }));
                setSmtpTestResult({ type: 'success', message: `Cuenta ${event.data.email} vinculada con éxito.` });
            }
        };
        window.addEventListener('message', handleMessage);
        return () => window.removeEventListener('message', handleMessage);
    }, []);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
        const { name, value } = e.target;
        setSettings(prev => ({ ...prev, [name]: value }));
    };

    const togglePasswordVisibility = (key: keyof typeof passwordVisibility) => {
        setPasswordVisibility(prev => ({ ...prev, [key]: !prev[key] }));
    };

    const handleSaveMeli = async () => {
        setIsSavingMeli(true);
        setMeliTestResult(null);
        try {
            await api.updateIntegrationSettings({
                meliAppId: settings.meliAppId,
                meliClientSecret: settings.meliClientSecret
            });
            alert('Configuración de Mercado Libre guardada con éxito.');
        } catch (err: any) {
            alert('Error al guardar configuración de Mercado Libre.');
        } finally {
            setIsSavingMeli(false);
        }
    };

    const handleSaveShopify = async () => {
        setIsSavingShopify(true);
        setShopifyTestResult(null);
        try {
            await api.updateIntegrationSettings({
                shopifyShopUrl: settings.shopifyShopUrl,
                shopifyAccessToken: settings.shopifyAccessToken,
                shopifyClientId: settings.shopifyClientId,
                shopifyClientSecret: settings.shopifyClientSecret,
                shopifyAutoImport: settings.shopifyAutoImport,
                shopifySyncInterval: settings.shopifySyncInterval,
                shopifyWebhookSecret: settings.shopifyWebhookSecret
            });
            alert('Configuración de Shopify guardada con éxito.');
        } catch (err: any) {
            alert('Error al guardar configuración de Shopify.');
        } finally {
            setIsSavingShopify(false);
        }
    };

    const handleSaveGithub = async () => {
        setIsSavingGithub(true);
        setBackupResult(null);
        try {
            await api.updateIntegrationSettings({
                githubToken: settings.githubToken,
                githubRepo: settings.githubRepo,
                githubOwner: settings.githubOwner
            });
            alert('Configuración de GitHub guardada con éxito.');
        } catch (err: any) {
            alert('Error al guardar configuración de GitHub.');
        } finally {
            setIsSavingGithub(false);
        }
    };

    const handleSaveWoo = async () => {
        setIsSavingWoo(true);
        setWooTestResult(null);
        try {
            await api.updateIntegrationSettings({
                wooUrl: settings.wooUrl,
                wooConsumerKey: settings.wooConsumerKey,
                wooConsumerSecret: settings.wooConsumerSecret,
                wooAutoImport: settings.wooAutoImport,
                wooSyncInterval: settings.wooSyncInterval,
            });
            alert('Configuración de WooCommerce guardada con éxito.');
        } catch (err: any) {
            alert('Error al guardar configuración de WooCommerce.');
        } finally {
            setIsSavingWoo(false);
        }
    };

    const handleSaveFalabella = async () => {
        setIsSavingFalabella(true);
        setFalabellaTestResult(null);
        try {
            await api.updateIntegrationSettings({
                falabellaApiKey: settings.falabellaApiKey,
                falabellaSellerId: settings.falabellaSellerId
            });
            alert('Configuración de Falabella guardada con éxito.');
        } catch (err: any) {
            alert('Error al guardar configuración de Falabella.');
        } finally {
            setIsSavingFalabella(false);
        }
    };

    const handleSaveFalabellaDirect = async () => {
        setIsSavingFalabellaDirect(true);
        setFalabellaDirectTestResult(null);
        try {
            await api.updateIntegrationSettings({
                falabellaDirectClientId: settings.falabellaDirectClientId,
                falabellaDirectClientSecret: settings.falabellaDirectClientSecret,
                falabellaDirectEnvironment: settings.falabellaDirectEnvironment,
            });
            alert('Configuración de Falabella Directo guardada con éxito.');
        } catch (err: any) {
            alert('Error al guardar configuración de Falabella Directo.');
        } finally {
            setIsSavingFalabellaDirect(false);
        }
    };

    const handleSaveJumpseller = async () => {
        setIsSavingJumpseller(true);
        setJumpsellerTestResult(null);
        try {
            await api.updateIntegrationSettings({
                jumpsellerLogin: settings.jumpsellerLogin,
                jumpsellerToken: settings.jumpsellerToken,
                jumpsellerAutoImport: settings.jumpsellerAutoImport,
                jumpsellerSyncInterval: settings.jumpsellerSyncInterval,
            });
            alert('Configuración de Jumpseller guardada con éxito.');
        } catch (err: any) {
            alert('Error al guardar configuración de Jumpseller.');
        } finally {
            setIsSavingJumpseller(false);
        }
    };
    
    const handleGoogleAuth = async () => {
        setIsAuthorizingGoogle(true);
        try {
            const { url } = await api.getGoogleAuthUrl();
            const width = 500;
            const height = 600;
            const left = window.screenX + (window.outerWidth - width) / 2;
            const top = window.screenY + (window.outerHeight - height) / 2;
            window.open(url, 'google-auth', `width=${width},height=${height},left=${left},top=${top}`);
        } catch (err: any) {
            alert('Error al iniciar flujo de Google: ' + err.message);
        } finally {
            setIsAuthorizingGoogle(false);
        }
    };

    const handleDisconnectGoogle = async () => {
        if (!confirm('¿Estás seguro de que deseas desconectar la cuenta de Google? El envío de correos dejará de funcionar hasta que configures SMTP manual.')) return;
        try {
            await api.disconnectGoogleSmtp();
            setSettings(prev => ({
                ...prev,
                hasGoogleSmtp: false,
                smtpGoogleEmail: undefined
            }));
            alert('Cuenta de Google desconectada.');
        } catch (err: any) {
            alert('Error al desconectar: ' + err.message);
        }
    };

    const handleSaveSmtp = async () => {
        setIsSavingSmtp(true);
        setSmtpTestResult(null);
        try {
            await api.updateIntegrationSettings({
                smtpHost: settings.smtpHost,
                smtpPort: settings.smtpPort,
                smtpUser: settings.smtpUser,
                smtpPassword: settings.smtpPassword,
                smtpFrom: settings.smtpFrom
            });
            alert('Configuración SMTP guardada con éxito.');
        } catch (err: any) {
            alert('Error al guardar configuración SMTP.');
        } finally {
            setIsSavingSmtp(false);
        }
    };

    const handleTestSmtpConnection = async () => {
        if (!settings.smtpHost || !settings.smtpPort || !settings.smtpUser || !settings.smtpPassword) {
            setSmtpTestResult({ type: 'error', message: 'Por favor completa todos los campos SMTP para realizar la prueba.' });
            return;
        }

        setIsTestingSmtp(true);
        setSmtpTestResult(null);
        try {
            const result = await api.testSmtpConnection({
                smtpHost: settings.smtpHost,
                smtpPort: settings.smtpPort,
                smtpUser: settings.smtpUser,
                smtpPassword: settings.smtpPassword
            });
            setSmtpTestResult({ type: 'success', message: result.message });
        } catch (err: any) {
            setSmtpTestResult({ type: 'error', message: err.message || 'Error en la prueba de conexión SMTP.' });
        } finally {
            setIsTestingSmtp(false);
        }
    };

    const handleManualBackup = async () => {
        if (!settings.githubToken || !settings.githubRepo || !settings.githubOwner) {
            alert('Por favor, configure GitHub antes de realizar un respaldo.');
            return;
        }

        setIsBackingUp(true);
        setBackupResult(null);
        try {
            const response = await fetch('/api/settings/github-backup', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${localStorage.getItem('token')}`,
                    'Content-Type': 'application/json'
                }
            });
            const data = await response.json();
            if (response.ok) {
                setBackupResult({ type: 'success', message: data.message });
            } else {
                setBackupResult({ type: 'error', message: data.message || 'Error al realizar el respaldo.' });
            }
        } catch (err) {
            console.error(err);
            setBackupResult({ type: 'error', message: 'Error de conexión al realizar el respaldo.' });
        } finally {
            setIsBackingUp(false);
        }
    };

    const handleTestMeliConnection = async () => {
        setIsTestingMeli(true);
        setMeliTestResult(null);
        setMeliDebugLog(['[1/4] Iniciando prueba de conexión...']);

        try {
            const appId = settings.meliAppId || '';
            const clientSecret = settings.meliClientSecret || '';

            await new Promise(resolve => setTimeout(resolve, 300));
            setMeliDebugLog(prev => [...prev, `[2/4] Credenciales enviadas...`]);
            
            await new Promise(resolve => setTimeout(resolve, 500));
            setMeliDebugLog(prev => [...prev, '[3/4] Contactando a la API de Mercado Libre...']);

            const result = await api.testMeliConnection({ 
                meliAppId: appId, 
                meliClientSecret: clientSecret 
            });
            
            await new Promise(resolve => setTimeout(resolve, 300));
            setMeliDebugLog(prev => [...prev, '[4/4] ✅ Conexión exitosa.']);
            setMeliTestResult({ type: 'success', message: result.message });

        } catch (err: any) {
            const errorMessage = err.message || 'Error de conexión desconocido.';
            await new Promise(resolve => setTimeout(resolve, 300));
            setMeliDebugLog(prev => [...prev, `[4/4] ❌ Error: ${errorMessage}`]);
            setMeliTestResult({ type: 'error', message: errorMessage });
        } finally {
            setIsTestingMeli(false);
        }
    };

    const handleTestShopifyConnection = async () => {
        setIsTestingShopify(true);
        setShopifyTestResult(null);

        try {
            const result = await api.testShopifyConnection({
                shopifyShopUrl: settings.shopifyShopUrl || '',
                shopifyAccessToken: settings.shopifyAccessToken || ''
            });
            
            setShopifyTestResult({ 
                type: 'success', 
                message: result.shopName ? `${result.message} (Tienda: ${result.shopName})` : result.message 
            });

        } catch (err: any) {
            setShopifyTestResult({ type: 'error', message: err.message || 'Error de conexión' });
        } finally {
            setIsTestingShopify(false);
        }
    };

    const handleTestWooConnection = async () => {
        setIsTestingWoo(true);
        setWooTestResult(null);

        try {
            const result = await api.testWooCommerceConnection({
                wooUrl: settings.wooUrl || '',
                wooConsumerKey: settings.wooConsumerKey || '',
                wooConsumerSecret: settings.wooConsumerSecret || ''
            });
            setWooTestResult({ type: 'success', message: result.message });
        } catch (err: any) {
            setWooTestResult({ type: 'error', message: err.message || 'Error de conexión' });
            setIsTestingWoo(false);
        }
    };

    const handleTestFalabellaConnection = async () => {
        setIsTestingFalabella(true);
        setFalabellaTestResult(null);

        try {
            const result = await api.testFalabellaConnection({
                falabellaApiKey: settings.falabellaApiKey || '',
                falabellaSellerId: settings.falabellaSellerId || ''
            });
            setFalabellaTestResult({ type: 'success', message: result.message });
        } catch (err: any) {
            setFalabellaTestResult({ type: 'error', message: err.message || 'Error de conexión' });
        } finally {
            setIsTestingFalabella(false);
        }
    };

    const handleTestFalabellaDirectConnection = async () => {
        setIsTestingFalabellaDirect(true);
        setFalabellaDirectTestResult(null);

        try {
            const result = await api.testFalabellaDirectConnection({
                falabellaDirectClientId: settings.falabellaDirectClientId || '',
                falabellaDirectClientSecret: settings.falabellaDirectClientSecret || '',
                falabellaDirectEnvironment: settings.falabellaDirectEnvironment || 'UAT',
            });
            setFalabellaDirectTestResult({ type: 'success', message: result.message });
        } catch (err: any) {
            setFalabellaDirectTestResult({ type: 'error', message: err.message || 'Error de conexión' });
        } finally {
            setIsTestingFalabellaDirect(false);
        }
    };

    const handleTestJumpsellerConnection = async () => {
        setIsTestingJumpseller(true);
        setJumpsellerTestResult(null);

        try {
            const result = await api.testJumpsellerConnection({
                jumpsellerLogin: settings.jumpsellerLogin || '',
                jumpsellerToken: settings.jumpsellerToken || ''
            });
            setJumpsellerTestResult({ type: 'success', message: result.message });
        } catch (err: any) {
            setJumpsellerTestResult({ type: 'error', message: err.message || 'Error de conexión' });
        } finally {
            setIsTestingJumpseller(false);
        }
    };
    
    const inputClasses = "w-full px-3 py-2 border border-[var(--border-secondary)] rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-secondary)] bg-[var(--background-secondary)] text-[var(--text-primary)]";

    if (isLoading) {
        return <div className="text-center p-8 text-[var(--text-muted)]">Cargando configuración...</div>;
    }

    return (
        <div className="max-w-3xl space-y-8 pb-12">
            <h1 className="text-2xl font-bold text-[var(--text-primary)]">Configuración de Integraciones</h1>

            {/* TAB NAVIGATION BAR */}
            <div className="flex flex-wrap border-b border-[var(--border-primary)] gap-1 pb-3">
                {[
                    { id: 'help', label: 'Ayuda', icon: <IconInfo className="w-3.5 h-3.5" /> },
                    { id: 'meli', label: 'Meli', icon: <IconMercadoLibre className="w-3.5 h-3.5 text-yellow-500" /> },
                    { id: 'shopify', label: 'Shopify', icon: <IconShopify className="w-3.5 h-3.5 text-green-500" /> },
                    { id: 'woocommerce', label: 'WooCommerce', icon: <IconWoocommerce className="w-3.5 h-3.5 text-purple-500" /> },
                    { id: 'falabella', label: 'Falabella', icon: <IconFalabella className="w-3.5 h-3.5 text-lime-500" /> },
                    { id: 'jumpseller', label: 'Jumpseller', icon: <IconJumpseller className="w-3.5 h-3.5 text-sky-500" /> },
                    ...(isSuperUser ? [
                        { id: 'smtp', label: 'Correo', icon: <IconMail className="w-3.5 h-3.5 text-blue-500" /> },
                        { id: 'github', label: 'GitHub', icon: <IconGithub className="w-3.5 h-3.5 text-gray-900 dark:text-white" /> },
                        // Hidden until validated in UAT — super admin only for now.
                        { id: 'falabella-direct', label: 'Falabella Directo', icon: <IconFalabella className="w-3.5 h-3.5 text-rose-500" /> }
                    ] : [])
                ].map(tab => (
                    <button
                        key={tab.id}
                        type="button"
                        onClick={() => setActiveTab(tab.id as any)}
                        className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-bold rounded-lg whitespace-nowrap shrink-0 transition-all duration-200 ${activeTab === tab.id ? 'bg-[var(--brand-primary)] text-white shadow-md' : 'text-[var(--text-secondary)] hover:bg-[var(--background-muted)]'}`}
                    >
                        {tab.icon}
                        {tab.label}
                    </button>
                ))}
            </div>

            {/* Help & Manuals Section */}
            {activeTab === 'help' && (
                <div className="bg-white shadow-md rounded-lg border border-[var(--border-primary)] p-6 mb-6">
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
            )}

            {/* Mercado Libre Card */}
            {activeTab === 'meli' && (
                <div className="bg-[var(--background-secondary)] shadow-md rounded-lg border border-[var(--border-primary)]">
                    <div className="p-6">
                        <div className="flex items-center justify-between mb-4">
                            <div className="flex items-center gap-2">
                                <IconMercadoLibre className="w-6 h-6 text-yellow-500" />
                                <h3 className="text-lg font-bold text-[var(--text-primary)]">Mercado Libre</h3>
                            </div>
                            <button
                                onClick={handleSaveMeli}
                                disabled={isSavingMeli}
                                className="flex items-center justify-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-yellow-500 hover:bg-yellow-600 disabled:bg-slate-400 transition-colors"
                            >
                                {isSavingMeli ? <IconLoader className="w-4 h-4 mr-2 animate-spin"/> : <IconCheckCircle className="w-4 h-4 mr-2"/>}
                                Guardar ML
                            </button>
                        </div>
                        
                        <p className="text-sm text-[var(--text-muted)] mb-4">Credenciales globales para la API de Mercado Libre.</p>
                        <div className="space-y-4">
                            <div>
                                <label htmlFor="meliAppId" className="block text-sm font-medium text-[var(--text-secondary)] mb-1">App ID</label>
                                <input
                                    type="text"
                                    id="meliAppId"
                                    name="meliAppId"
                                    value={settings.meliAppId || ''}
                                    onChange={handleChange}
                                    className={inputClasses}
                                    placeholder="Ej: 1234567890123456"
                                />
                            </div>
                            <div>
                                <label htmlFor="meliClientSecret" className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Client Secret</label>
                                <div className="relative">
                                    <input
                                        type={passwordVisibility.meliClientSecret ? 'text' : 'password'}
                                        id="meliClientSecret"
                                        name="meliClientSecret"
                                        value={settings.meliClientSecret || ''}
                                        onChange={handleChange}
                                        className={`${inputClasses} pr-10`}
                                        placeholder="************************"
                                    />
                                    <button type="button" onClick={() => togglePasswordVisibility('meliClientSecret')} className="absolute inset-y-0 right-0 pr-3 flex items-center">
                                        {passwordVisibility.meliClientSecret ? <IconEyeOff className="h-5 w-5 text-[var(--text-muted)]"/> : <IconEye className="h-5 w-5 text-[var(--text-muted)]"/>}
                                    </button>
                                </div>
                            </div>
                            
                            <div className="flex items-center justify-end pt-2 border-t border-[var(--border-secondary)] mt-4">
                                 <button
                                    type="button"
                                    onClick={handleTestMeliConnection}
                                    disabled={isTestingMeli}
                                    className="flex items-center px-4 py-2 border border-[var(--border-secondary)] text-sm font-medium rounded-md text-[var(--text-secondary)] bg-[var(--background-secondary)] hover:bg-[var(--background-hover)] disabled:opacity-50 transition-colors"
                                >
                                    {isTestingMeli ? <IconLoader className="w-4 h-4 mr-2 animate-spin"/> : <IconPlugConnected className="w-4 h-4 mr-2"/>}
                                    Probar Conexión ML
                                </button>
                            </div>

                            {meliTestResult && (
                                <div className={`p-3 rounded-md flex items-center text-sm font-medium ${meliTestResult.type === 'success' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
                                    {meliTestResult.type === 'success' ? <IconCheckCircle className="w-5 h-5 mr-2"/> : <IconAlertTriangle className="w-5 h-5 mr-2"/>}
                                    {meliTestResult.message}
                                </div>
                            )}
                            {meliDebugLog.length > 0 && (
                                <div className="p-4 bg-slate-800 rounded-md font-mono text-xs text-white max-h-40 overflow-y-auto">
                                    <div className="space-y-1">
                                        {meliDebugLog.map((log, index) => (
                                            <p key={index} className={`${log.includes('❌') ? 'text-red-400' : log.includes('✅') ? 'text-green-400' : 'text-slate-300'}`}>
                                                {log}
                                            </p>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* Shopify Card */}
            {activeTab === 'shopify' && (
                <div className="bg-[var(--background-secondary)] shadow-md rounded-lg border border-[var(--border-primary)] flex flex-col overflow-hidden">
                    <div className="bg-green-600 p-4 text-white flex items-center justify-between">
                        <div className="flex items-center gap-3">
                            <IconShopify className="w-8 h-8" />
                            <div>
                                <h3 className="text-lg font-black uppercase tracking-tighter leading-none">Shopify</h3>
                                <p className="text-[10px] text-green-100 font-bold uppercase tracking-widest mt-0.5">Gestión Global</p>
                            </div>
                        </div>
                    </div>

                    {/* Tab Navigation */}
                    <div className="flex bg-[var(--background-muted)] border-b border-[var(--border-primary)]">
                        {[
                            { id: 'connect', label: 'Conexión', icon: <IconShopify className="w-4 h-4" /> },
                            { id: 'sync', label: 'Automatización', icon: <IconLoader className="w-4 h-4" /> },
                            { id: 'manual', label: 'Ayuda', icon: <IconPlugConnected className="w-4 h-4" /> }
                        ].map((tab) => (
                            <button
                                key={tab.id}
                                type="button"
                                onClick={() => setShopifyActiveTab(tab.id as any)}
                                className={`flex-1 py-3 px-2 text-[11px] font-black uppercase tracking-widest flex items-center justify-center gap-1.5 transition-all ${
                                    shopifyActiveTab === tab.id 
                                    ? 'bg-[var(--background-secondary)] text-green-600 border-b-2 border-green-600' 
                                    : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--background-secondary)]/50'
                                }`}
                            >
                                {tab.icon}
                                {tab.label}
                            </button>
                        ))}
                    </div>

                    <div className="p-6 min-h-[350px]">
                        {shopifyActiveTab === 'connect' && (
                            <div className="space-y-4 animate-fade-in-up">
                                <p className="text-sm text-[var(--text-muted)] mb-4">Credenciales globales para la integración con Shopify (Legacy y OAuth 2026).</p>
                                
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                    <div>
                                        <label htmlFor="shopifyShopUrl" className="block text-sm font-medium text-[var(--text-secondary)] mb-1">URL Base (ejemplo.myshopify.com)</label>
                                        <input
                                            type="text"
                                            id="shopifyShopUrl"
                                            name="shopifyShopUrl"
                                            value={settings.shopifyShopUrl || ''}
                                            onChange={handleChange}
                                            className={inputClasses}
                                            placeholder="ejemplo.myshopify.com"
                                        />
                                    </div>
                                    <div>
                                        <label htmlFor="shopifyAccessToken" className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Admin API Access Token</label>
                                        <div className="relative">
                                            <input
                                                type={passwordVisibility.shopifyAccessToken ? 'text' : 'password'}
                                                id="shopifyAccessToken"
                                                name="shopifyAccessToken"
                                                value={settings.shopifyAccessToken || ''}
                                                onChange={handleChange}
                                                className={`${inputClasses} pr-10`}
                                                placeholder="shpat_xxxxxxxxxxxxxxxx"
                                            />
                                            <button type="button" onClick={() => togglePasswordVisibility('shopifyAccessToken')} className="absolute inset-y-0 right-0 pr-3 flex items-center">
                                                {passwordVisibility.shopifyAccessToken ? <IconEyeOff className="h-5 w-5 text-[var(--text-muted)]"/> : <IconEye className="h-5 w-5 text-[var(--text-muted)]"/>}
                                            </button>
                                        </div>
                                    </div>
                                    <div>
                                        <label htmlFor="shopifyClientId" className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Client ID (OAuth 2026)</label>
                                        <input
                                            type="text"
                                            id="shopifyClientId"
                                            name="shopifyClientId"
                                            value={settings.shopifyClientId || ''}
                                            onChange={handleChange}
                                            className={inputClasses}
                                            placeholder="Ingresa el Client ID de tu App Pública de Shopify"
                                        />
                                    </div>
                                    <div>
                                        <label htmlFor="shopifyClientSecret" className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Client Secret (OAuth 2026)</label>
                                        <div className="relative">
                                            <input
                                                type={passwordVisibility.shopifyClientSecret ? 'text' : 'password'}
                                                id="shopifyClientSecret"
                                                name="shopifyClientSecret"
                                                value={settings.shopifyClientSecret || ''}
                                                onChange={handleChange}
                                                className={`${inputClasses} pr-10`}
                                                placeholder="Ingresa el Client Secret de tu App Pública de Shopify"
                                            />
                                            <button type="button" onClick={() => togglePasswordVisibility('shopifyClientSecret')} className="absolute inset-y-0 right-0 pr-3 flex items-center">
                                                {passwordVisibility.shopifyClientSecret ? <IconEyeOff className="h-5 w-5 text-[var(--text-muted)]"/> : <IconEye className="h-5 w-5 text-[var(--text-muted)]"/>}
                                            </button>
                                        </div>
                                    </div>
                                    <div>
                                        <label htmlFor="shopifyWebhookSecret" className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Webhook Secret (Opcional)</label>
                                        <div className="relative">
                                            <input
                                                type={passwordVisibility.shopifyWebhookSecret ? 'text' : 'password'}
                                                id="shopifyWebhookSecret"
                                                name="shopifyWebhookSecret"
                                                value={settings.shopifyWebhookSecret || ''}
                                                onChange={handleChange}
                                                className={`${inputClasses} pr-10`}
                                                placeholder="Webhook Secret"
                                            />
                                            <button type="button" onClick={() => togglePasswordVisibility('shopifyWebhookSecret')} className="absolute inset-y-0 right-0 pr-3 flex items-center">
                                                {passwordVisibility.shopifyWebhookSecret ? <IconEyeOff className="h-5 w-5 text-[var(--text-muted)]"/> : <IconEye className="h-5 w-5 text-[var(--text-muted)]"/>}
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        )}

                        {shopifyActiveTab === 'sync' && (
                            <div className="space-y-6 animate-fade-in-up">
                                <div className="p-4 bg-green-50 border border-green-100 rounded-xl">
                                    <div className="flex items-center justify-between">
                                        <div>
                                            <h5 className="text-[11px] font-black text-green-950 uppercase tracking-widest">Importación Global</h5>
                                            <p className="text-[12px] text-green-800 font-bold opacity-80">Habilitar el polling automático para todos los clientes.</p>
                                        </div>
                                        <label className="relative inline-flex items-center cursor-pointer">
                                            <input 
                                                type="checkbox" 
                                                className="sr-only peer" 
                                                checked={settings.shopifyAutoImport}
                                                onChange={(e) => setSettings(prev => ({ ...prev, shopifyAutoImport: e.target.checked }))}
                                            />
                                            <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-green-600"></div>
                                        </label>
                                    </div>
                                </div>

                                <div className="bg-white p-4 rounded-xl border border-gray-100 shadow-sm">
                                    <label className="block text-[10px] font-black text-gray-400 mb-3 uppercase tracking-widest opacity-70">Frecuencia de Polling (Minutos)</label>
                                    <div className="grid grid-cols-4 gap-2">
                                        {[5, 15, 30, 60].map((interval) => (
                                            <button
                                                key={interval}
                                                type="button"
                                                onClick={() => setSettings(prev => ({ ...prev, shopifySyncInterval: interval }))}
                                                className={`py-2 text-[13px] font-black rounded-lg border transition-all ${
                                                    settings.shopifySyncInterval === interval 
                                                    ? 'bg-green-600 text-white border-green-600 shadow-md transform scale-[1.02]' 
                                                    : 'bg-white text-gray-700 border-gray-200 hover:border-gray-300'
                                                }`}
                                            >
                                                {interval} min
                                            </button>
                                        ))}
                                    </div>
                                </div>

                                <div className="p-4 bg-[var(--background-muted)] rounded-md border border-dashed border-[var(--border-secondary)]">
                                    <h4 className="text-sm font-bold text-[var(--text-primary)] mb-2">Endpoint de Webhook</h4>
                                    <div className="flex items-center gap-2 mt-1">
                                        <code className="flex-1 text-xs bg-[var(--background-secondary)] p-2 rounded border border-[var(--border-primary)] break-all select-all">https://fullenvios.selcom.cl/api/integrations/shopify/webhook</code>
                                    </div>
                                </div>
                            </div>
                        )}

                        {shopifyActiveTab === 'manual' && (
                            <div className="animate-fade-in-up max-h-[350px] overflow-y-auto pr-2 custom-scrollbar space-y-4">
                                <a 
                                    href="/manuals/shopify_guide.html" 
                                    target="_blank" 
                                    rel="noopener noreferrer"
                                    className="block p-4 bg-green-600 hover:bg-green-700 text-white rounded-xl shadow-md transition-all transform hover:scale-[1.02] active:scale-95 group"
                                >
                                    <div className="flex items-center justify-between">
                                        <div className="flex items-center gap-3">
                                            <div className="p-2 bg-white/20 rounded-lg">
                                                <IconShopify className="w-6 h-6 text-white" />
                                            </div>
                                            <div>
                                                <h4 className="text-[14px] font-black uppercase tracking-tight">Descargar Guía Shopify</h4>
                                                <p className="text-[11px] text-green-100 font-medium">Manual paso a paso en PDF</p>
                                            </div>
                                        </div>
                                        <div className="w-8 h-8 bg-white/20 rounded-full flex items-center justify-center group-hover:bg-white/30 transition-colors">
                                            <span className="text-xl">↓</span>
                                        </div>
                                    </div>
                                </a>

                                <div className="p-4 bg-gray-50 rounded-xl border border-gray-100">
                                    <h4 className="text-[12px] font-black text-gray-800 uppercase mb-3 tracking-widest flex items-center gap-2">
                                        <div className="w-2 h-2 bg-green-500 rounded-full"></div>
                                        Guía Rápida
                                    </h4>
                                    <ol className="text-[12px] text-gray-600 space-y-3 font-medium">
                                        <li className="flex gap-2"><span className="text-green-600 font-black">1.</span> En Shopify, ve a <b>Apps &gt; Desarrollar apps</b>.</li>
                                        <li className="flex gap-2"><span className="text-green-600 font-black">2.</span> Configura los <b>Admin API Scopes</b> requeridos.</li>
                                        <li className="flex gap-2"><span className="text-green-600 font-black">3.</span> Habilita <b>read_orders</b>, <b>read_products</b> and <b>read_inventory</b>.</li>
                                        <li className="flex gap-2"><span className="text-green-600 font-black">4.</span> Instala la app y obtén el <b>Access Token</b>.</li>
                                    </ol>
                                </div>
                            </div>
                        )}
                    </div>

                    <div className="p-4 bg-[var(--background-muted)]/50 border-t border-[var(--border-secondary)] flex justify-between items-center">
                        <button
                            type="button"
                            onClick={handleTestShopifyConnection}
                            disabled={isTestingShopify}
                            className="px-4 py-2 border border-[var(--border-secondary)] bg-white text-[var(--text-primary)] hover:bg-[var(--background-muted)] text-[10px] font-black uppercase tracking-widest rounded-md shadow-sm disabled:opacity-50 flex items-center gap-2 transition-all"
                        >
                            {isTestingShopify ? <IconLoader className="w-3 h-3 animate-spin"/> : <IconPlugConnected className="w-3 h-3 text-green-600"/>}
                            Probar
                        </button>
                        <button
                            onClick={handleSaveShopify}
                            disabled={isSavingShopify}
                            className="px-6 py-2 bg-green-600 hover:bg-green-700 text-white text-[10px] font-black uppercase tracking-widest rounded-md shadow-lg disabled:opacity-50 transition-all transform active:scale-95"
                        >
                            {isSavingShopify ? 'Guardando...' : 'Guardar Global'}
                        </button>
                    </div>

                    {shopifyTestResult && shopifyActiveTab === 'connect' && (
                        <div className="mx-6 mb-6">
                            <div className={`p-3 rounded-md flex items-center text-sm font-medium ${shopifyTestResult.type === 'success' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
                                {shopifyTestResult.type === 'success' ? <IconCheckCircle className="w-5 h-5 mr-2"/> : <IconAlertTriangle className="w-5 h-5 mr-2"/>}
                                {shopifyTestResult.message}
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* WooCommerce Card */}
            {activeTab === 'woocommerce' && (
                <div className="bg-[var(--background-secondary)] shadow-md rounded-lg border border-[var(--border-primary)] flex flex-col overflow-hidden">
                    <div className="bg-purple-600 p-4 text-white flex items-center justify-between">
                        <div className="flex items-center gap-3">
                            <IconWoocommerce className="w-8 h-8" />
                            <div>
                                <h3 className="text-lg font-black uppercase tracking-tighter leading-none">WooCommerce</h3>
                                <p className="text-[10px] text-purple-100 font-bold uppercase tracking-widest mt-0.5">Tienda WordPress</p>
                            </div>
                        </div>
                    </div>

                    {/* Tab Navigation */}
                    <div className="flex bg-[var(--background-muted)] border-b border-[var(--border-primary)]">
                        {[
                            { id: 'connect', label: 'Conexión', icon: <IconWoocommerce className="w-4 h-4" /> },
                            { id: 'sync', label: 'Automatización', icon: <IconLoader className="w-4 h-4" /> },
                            { id: 'manual', label: 'Ayuda', icon: <IconPlugConnected className="w-4 h-4" /> }
                        ].map((tab) => (
                            <button
                                key={tab.id}
                                type="button"
                                onClick={() => setWooActiveTab(tab.id as any)}
                                className={`flex-1 py-3 px-2 text-[11px] font-black uppercase tracking-widest flex items-center justify-center gap-1.5 transition-all ${
                                    wooActiveTab === tab.id 
                                    ? 'bg-[var(--background-secondary)] text-purple-600 border-b-2 border-purple-600' 
                                    : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--background-secondary)]/50'
                                }`}
                            >
                                {tab.icon}
                                {tab.label}
                            </button>
                        ))}
                    </div>

                    <div className="p-6 min-h-[350px]">
                        {wooActiveTab === 'connect' && (
                            <div className="space-y-4 animate-fade-in-up">
                                <p className="text-sm text-[var(--text-muted)] mb-4">Credenciales globales para la API de WooCommerce.</p>
                                <div>
                                    <label htmlFor="wooUrl" className="block text-sm font-medium text-[var(--text-secondary)] mb-1">URL de la Tienda</label>
                                    <input
                                        type="text"
                                        id="wooUrl"
                                        name="wooUrl"
                                        value={settings.wooUrl || ''}
                                        onChange={handleChange}
                                        className={inputClasses}
                                        placeholder="https://mitienda.com"
                                    />
                                </div>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                    <div>
                                        <label htmlFor="wooConsumerKey" className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Consumer Key</label>
                                        <input
                                            type="text"
                                            id="wooConsumerKey"
                                            name="wooConsumerKey"
                                            value={settings.wooConsumerKey || ''}
                                            onChange={handleChange}
                                            className={inputClasses}
                                            placeholder="ck_xxxxxxxxxxxxxxxx"
                                        />
                                    </div>
                                    <div>
                                        <label htmlFor="wooConsumerSecret" className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Consumer Secret</label>
                                        <div className="relative">
                                            <input
                                                type={passwordVisibility.wooConsumerSecret ? 'text' : 'password'}
                                                id="wooConsumerSecret"
                                                name="wooConsumerSecret"
                                                value={settings.wooConsumerSecret || ''}
                                                onChange={handleChange}
                                                className={`${inputClasses} pr-10`}
                                                placeholder="cs_xxxxxxxxxxxxxxxx"
                                            />
                                            <button type="button" onClick={() => togglePasswordVisibility('wooConsumerSecret')} className="absolute inset-y-0 right-0 pr-3 flex items-center">
                                                {passwordVisibility.wooConsumerSecret ? <IconEyeOff className="h-5 w-5 text-[var(--text-muted)]"/> : <IconEye className="h-5 w-5 text-[var(--text-muted)]"/>}
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        )}

                        {wooActiveTab === 'sync' && (
                            <div className="space-y-6 animate-fade-in-up">
                                <div className="p-4 bg-purple-50 border border-purple-100 rounded-xl">
                                    <div className="flex items-center justify-between">
                                        <div>
                                            <h5 className="text-[11px] font-black text-purple-950 uppercase tracking-widest">Sincronización Global</h5>
                                            <p className="text-[12px] text-purple-800 font-bold opacity-80">Habilitar la importación automática de pedidos para WooCommerce.</p>
                                        </div>
                                        <label className="relative inline-flex items-center cursor-pointer">
                                            <input 
                                                type="checkbox" 
                                                className="sr-only peer" 
                                                checked={settings.wooAutoImport}
                                                onChange={(e) => setSettings(prev => ({ ...prev, wooAutoImport: e.target.checked }))}
                                            />
                                            <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-purple-600 shadow-inner"></div>
                                        </label>
                                    </div>
                                </div>

                                <div className="bg-white p-4 rounded-xl border border-gray-100 shadow-sm">
                                    <label className="block text-[10px] font-black text-gray-400 mb-3 uppercase tracking-widest opacity-70">Frecuencia de Sync (Minutos)</label>
                                    <div className="grid grid-cols-4 gap-2">
                                        {[5, 15, 30, 60].map((interval) => (
                                            <button
                                                key={interval}
                                                type="button"
                                                onClick={() => setSettings(prev => ({ ...prev, wooSyncInterval: interval }))}
                                                className={`py-2 text-[13px] font-black rounded-lg border transition-all ${
                                                    settings.wooSyncInterval === interval 
                                                    ? 'bg-purple-600 text-white border-purple-600 shadow-md transform scale-[1.02]' 
                                                    : 'bg-white text-gray-700 border-gray-200 hover:border-gray-300'
                                                }`}
                                            >
                                                {interval} min
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            </div>
                        )}

                        {wooActiveTab === 'manual' && (
                            <div className="animate-fade-in-up max-h-[350px] overflow-y-auto pr-2 custom-scrollbar space-y-4">
                                <a 
                                    href="/manuals/woocommerce_guide.html" 
                                    target="_blank" 
                                    rel="noopener noreferrer"
                                    className="block p-4 bg-purple-600 hover:bg-purple-700 text-white rounded-xl shadow-md transition-all transform hover:scale-[1.02] active:scale-95 group"
                                >
                                    <div className="flex items-center justify-between">
                                        <div className="flex items-center gap-3">
                                            <div className="p-2 bg-white/20 rounded-lg">
                                                <IconWoocommerce className="w-6 h-6 text-white" />
                                            </div>
                                            <div>
                                                <h4 className="text-[14px] font-black uppercase tracking-tight">Descargar Guía WooCommerce</h4>
                                                <p className="text-[11px] text-purple-100 font-medium">Manual paso a paso en PDF</p>
                                            </div>
                                        </div>
                                        <div className="w-8 h-8 bg-white/20 rounded-full flex items-center justify-center group-hover:bg-white/30 transition-colors">
                                            <span className="text-xl">↓</span>
                                        </div>
                                    </div>
                                </a>

                                <div className="p-4 bg-gray-50 rounded-xl border border-gray-100">
                                    <h4 className="text-[12px] font-black text-gray-800 uppercase mb-3 tracking-widest flex items-center gap-2">
                                        <div className="w-2 h-2 bg-purple-500 rounded-full"></div>
                                        Guía Rápida
                                    </h4>
                                    <ol className="text-[12px] text-gray-600 space-y-3 font-medium">
                                        <li className="flex gap-2"><span className="text-purple-600 font-black">1.</span> En WordPress: <b>WooCommerce &gt; Ajustes &gt; Avanzado</b>.</li>
                                        <li className="flex gap-2"><span className="text-purple-600 font-black">2.</span> Ve a <b>REST API</b> y haz clic en <b>Añadir clave</b>.</li>
                                        <li className="flex gap-2"><span className="text-purple-600 font-black">3.</span> Permisos: <b>Lectura/Escritura</b>.</li>
                                        <li className="flex gap-2"><span className="text-purple-600 font-black">4.</span> Copia el <b>Consumer Key</b> y el <b>Consumer Secret</b>.</li>
                                    </ol>
                                </div>
                            </div>
                        )}
                    </div>

                    <div className="p-4 bg-[var(--background-muted)]/50 border-t border-[var(--border-secondary)] flex justify-between items-center">
                        <button
                            type="button"
                            onClick={handleTestWooConnection}
                            disabled={isTestingWoo}
                            className="px-4 py-2 border border-[var(--border-secondary)] bg-white text-[var(--text-primary)] hover:bg-[var(--background-muted)] text-[10px] font-black uppercase tracking-widest rounded-md shadow-sm disabled:opacity-50 flex items-center gap-2 transition-all"
                        >
                            {isTestingWoo ? <IconLoader className="w-3 h-3 animate-spin"/> : <IconPlugConnected className="w-3 h-3 text-purple-600"/>}
                            Probar
                        </button>
                        <button
                            onClick={handleSaveWoo}
                            disabled={isSavingWoo}
                            className="px-6 py-2 bg-purple-600 hover:bg-purple-700 text-white text-[10px] font-black uppercase tracking-widest rounded-md shadow-lg disabled:opacity-50 transition-all transform active:scale-95"
                        >
                            {isSavingWoo ? 'Guardando...' : 'Guardar Global'}
                        </button>
                    </div>

                    {wooTestResult && wooActiveTab === 'connect' && (
                        <div className="mx-6 mb-6">
                            <div className={`p-3 rounded-md flex items-center text-sm font-medium ${wooTestResult.type === 'success' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
                                {wooTestResult.type === 'success' ? <IconCheckCircle className="w-5 h-5 mr-2"/> : <IconAlertTriangle className="w-5 h-5 mr-2"/>}
                                {wooTestResult.message}
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* Falabella Card */}
            {activeTab === 'falabella' && (
                <div className="bg-[var(--background-secondary)] shadow-md rounded-lg border border-[var(--border-primary)] mb-8 overflow-hidden">
                    <div className="bg-lime-600 p-4 text-white flex items-center justify-between">
                        <div className="flex items-center gap-3">
                            <IconFalabella className="w-8 h-8" />
                            <div>
                                <h3 className="text-lg font-black uppercase tracking-tighter leading-none">Falabella / Linio</h3>
                                <p className="text-[10px] text-lime-100 font-bold uppercase tracking-widest mt-0.5">Seller Center</p>
                            </div>
                        </div>
                    </div>

                    <div className="p-6">
                        <p className="text-sm text-[var(--text-muted)] mb-4">Configuración global para la API de Falabella Seller Center.</p>
                        <div className="space-y-4">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div>
                                    <label htmlFor="falabellaSellerId" className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Seller ID / Email</label>
                                    <input
                                        type="text"
                                        id="falabellaSellerId"
                                        name="falabellaSellerId"
                                        value={settings.falabellaSellerId || ''}
                                        onChange={handleChange}
                                        className={inputClasses}
                                        placeholder="ejemplo@correo.com"
                                    />
                                </div>
                                <div>
                                    <label htmlFor="falabellaApiKey" className="block text-sm font-medium text-[var(--text-secondary)] mb-1">API Key</label>
                                    <div className="relative">
                                        <input
                                            type={passwordVisibility.falabellaApiKey ? 'text' : 'password'}
                                            id="falabellaApiKey"
                                            name="falabellaApiKey"
                                            value={settings.falabellaApiKey || ''}
                                            onChange={handleChange}
                                            className={`${inputClasses} pr-10`}
                                            placeholder="************************"
                                        />
                                        <button type="button" onClick={() => togglePasswordVisibility('falabellaApiKey')} className="absolute inset-y-0 right-0 pr-3 flex items-center">
                                            {passwordVisibility.falabellaApiKey ? <IconEyeOff className="h-5 w-5 text-[var(--text-muted)]"/> : <IconEye className="h-5 w-5 text-[var(--text-muted)]"/>}
                                        </button>
                                    </div>
                                </div>
                            </div>

                            <div className="flex items-center justify-between pt-6 border-t border-[var(--border-secondary)] mt-6">
                                 <button
                                    type="button"
                                    onClick={handleTestFalabellaConnection}
                                    disabled={isTestingFalabella}
                                    className="flex items-center px-4 py-2 border border-[var(--border-secondary)] text-sm font-medium rounded-md text-[var(--text-secondary)] bg-[var(--background-secondary)] hover:bg-[var(--background-hover)] disabled:opacity-50 transition-colors"
                                >
                                    {isTestingFalabella ? <IconLoader className="w-4 h-4 mr-2 animate-spin"/> : <IconPlugConnected className="w-4 h-4 mr-2 text-lime-600"/>}
                                    Probar Conexión
                                </button>
                                <button
                                    onClick={handleSaveFalabella}
                                    disabled={isSavingFalabella}
                                    className="px-6 py-2 bg-lime-600 hover:bg-lime-700 text-white text-xs font-black uppercase tracking-widest rounded-md shadow-lg disabled:opacity-50 transition-all transform active:scale-95 flex items-center gap-2"
                                >
                                    {isSavingFalabella ? 'Guardando...' : 'Guardar Global'}
                                </button>
                            </div>

                            {falabellaTestResult && (
                                <div className={`p-3 rounded-md flex items-center text-sm font-medium ${falabellaTestResult.type === 'success' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
                                    {falabellaTestResult.type === 'success' ? <IconCheckCircle className="w-5 h-5 mr-2"/> : <IconAlertTriangle className="w-5 h-5 mr-2"/>}
                                    {falabellaTestResult.message}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* Falabella Directo (Courier) Card — super admin only, UAT-only for now */}
            {activeTab === 'falabella-direct' && isSuperUser && (
                <div className="bg-[var(--background-secondary)] shadow-md rounded-lg border border-[var(--border-primary)] mb-8 overflow-hidden">
                    <div className="bg-rose-600 p-4 text-white flex items-center justify-between">
                        <div className="flex items-center gap-3">
                            <IconFalabella className="w-8 h-8" />
                            <div>
                                <h3 className="text-lg font-black uppercase tracking-tighter leading-none">Falabella Directo</h3>
                                <p className="text-[10px] text-rose-100 font-bold uppercase tracking-widest mt-0.5">Courier API — Ambiente de prueba</p>
                            </div>
                        </div>
                    </div>

                    <div className="p-6">
                        <p className="text-sm text-[var(--text-muted)] mb-1">
                            Integración directa como transportista de los pedidos "Directo" de Falabella — distinta de la integración Seller Center de arriba.
                        </p>
                        <p className="text-xs text-amber-600 font-semibold mb-4">
                            Esta sección solo la ves tú (super admin) mientras se valida en UAT.
                        </p>
                        <div className="space-y-4">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div>
                                    <label htmlFor="falabellaDirectClientId" className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Client ID</label>
                                    <input
                                        type="text"
                                        id="falabellaDirectClientId"
                                        name="falabellaDirectClientId"
                                        value={settings.falabellaDirectClientId || ''}
                                        onChange={handleChange}
                                        className={inputClasses}
                                        placeholder="client_id proporcionado por Falabella"
                                    />
                                </div>
                                <div>
                                    <label htmlFor="falabellaDirectClientSecret" className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Client Secret</label>
                                    <div className="relative">
                                        <input
                                            type={passwordVisibility.falabellaDirectClientSecret ? 'text' : 'password'}
                                            id="falabellaDirectClientSecret"
                                            name="falabellaDirectClientSecret"
                                            value={settings.falabellaDirectClientSecret || ''}
                                            onChange={handleChange}
                                            className={`${inputClasses} pr-10`}
                                            placeholder="************************"
                                        />
                                        <button type="button" onClick={() => togglePasswordVisibility('falabellaDirectClientSecret')} className="absolute inset-y-0 right-0 pr-3 flex items-center">
                                            {passwordVisibility.falabellaDirectClientSecret ? <IconEyeOff className="h-5 w-5 text-[var(--text-muted)]"/> : <IconEye className="h-5 w-5 text-[var(--text-muted)]"/>}
                                        </button>
                                    </div>
                                </div>
                            </div>

                            <div>
                                <label htmlFor="falabellaDirectEnvironment" className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Ambiente</label>
                                <select
                                    id="falabellaDirectEnvironment"
                                    name="falabellaDirectEnvironment"
                                    value={settings.falabellaDirectEnvironment || 'UAT'}
                                    onChange={handleChange}
                                    className={inputClasses}
                                >
                                    <option value="UAT">UAT (Pruebas)</option>
                                    <option value="PROD">PROD (Producción)</option>
                                </select>
                            </div>

                            <div className="flex items-center justify-between pt-6 border-t border-[var(--border-secondary)] mt-6">
                                 <button
                                    type="button"
                                    onClick={handleTestFalabellaDirectConnection}
                                    disabled={isTestingFalabellaDirect}
                                    className="flex items-center px-4 py-2 border border-[var(--border-secondary)] text-sm font-medium rounded-md text-[var(--text-secondary)] bg-[var(--background-secondary)] hover:bg-[var(--background-hover)] disabled:opacity-50 transition-colors"
                                >
                                    {isTestingFalabellaDirect ? <IconLoader className="w-4 h-4 mr-2 animate-spin"/> : <IconPlugConnected className="w-4 h-4 mr-2 text-rose-600"/>}
                                    Probar Conexión
                                </button>
                                <button
                                    onClick={handleSaveFalabellaDirect}
                                    disabled={isSavingFalabellaDirect}
                                    className="px-6 py-2 bg-rose-600 hover:bg-rose-700 text-white text-xs font-black uppercase tracking-widest rounded-md shadow-lg disabled:opacity-50 transition-all transform active:scale-95 flex items-center gap-2"
                                >
                                    {isSavingFalabellaDirect ? 'Guardando...' : 'Guardar Global'}
                                </button>
                            </div>

                            {falabellaDirectTestResult && (
                                <div className={`p-3 rounded-md flex items-center text-sm font-medium ${falabellaDirectTestResult.type === 'success' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
                                    {falabellaDirectTestResult.type === 'success' ? <IconCheckCircle className="w-5 h-5 mr-2"/> : <IconAlertTriangle className="w-5 h-5 mr-2"/>}
                                    {falabellaDirectTestResult.message}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* Jumpseller Card */}
            {activeTab === 'jumpseller' && (
                <div className="bg-[var(--background-secondary)] shadow-md rounded-lg border border-[var(--border-primary)] mb-8 overflow-hidden">
                    <div className="bg-sky-600 p-4 text-white flex items-center justify-between">
                        <div className="flex items-center gap-3">
                            <IconJumpseller className="w-8 h-8" />
                            <div>
                                <h3 className="text-lg font-black uppercase tracking-tighter leading-none">Jumpseller</h3>
                                <p className="text-[10px] text-sky-100 font-bold uppercase tracking-widest mt-0.5">Integración Directa</p>
                            </div>
                        </div>
                    </div>

                    {/* Tab Navigation */}
                    <div className="flex bg-[var(--background-muted)] border-b border-[var(--border-primary)]">
                        {[
                            { id: 'connect', label: 'Conexión', icon: <IconPlugConnected className="w-4 h-4" /> },
                            { id: 'sync', label: 'Automatización', icon: <IconLoader className="w-4 h-4" /> },
                            { id: 'manual', label: 'Manual', icon: <IconAlertTriangle className="w-4 h-4" /> }
                        ].map((tab) => (
                            <button
                                key={tab.id}
                                type="button"
                                onClick={() => setJumpsellerActiveTab(tab.id as any)}
                                className={`flex-1 py-3 px-2 text-[11px] font-black uppercase tracking-widest flex items-center justify-center gap-1.5 transition-all ${
                                    jumpsellerActiveTab === tab.id 
                                    ? 'bg-[var(--background-secondary)] text-sky-600 border-b-2 border-sky-600' 
                                    : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--background-secondary)]/50'
                                }`}
                            >
                                {tab.icon}
                                {tab.label}
                            </button>
                        ))}
                    </div>

                    <div className="p-6 flex-1 flex flex-col min-h-[380px]">
                        {jumpsellerActiveTab === 'connect' && (
                            <div className="space-y-4 animate-fade-in-up">
                                <p className="text-sm text-[var(--text-muted)] mb-4">Configuración global para la API de Jumpseller.</p>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                    <div>
                                        <label htmlFor="jumpsellerLogin" className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Login (API User)</label>
                                        <input
                                            type="text"
                                            id="jumpsellerLogin"
                                            name="jumpsellerLogin"
                                            value={settings.jumpsellerLogin || ''}
                                            onChange={handleChange}
                                            className={inputClasses}
                                            placeholder="Ingresa tu Login de API"
                                        />
                                    </div>
                                    <div className="relative">
                                        <label htmlFor="jumpsellerToken" className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Auth Token</label>
                                        <div className="relative">
                                            <input
                                                type={passwordVisibility.jumpsellerToken ? 'text' : 'password'}
                                                id="jumpsellerToken"
                                                name="jumpsellerToken"
                                                value={settings.jumpsellerToken || ''}
                                                onChange={handleChange}
                                                className={`${inputClasses} pr-10`}
                                                placeholder="************************"
                                            />
                                            <button type="button" onClick={() => togglePasswordVisibility('jumpsellerToken')} className="absolute inset-y-0 right-0 pr-3 flex items-center">
                                                {passwordVisibility.jumpsellerToken ? <IconEyeOff className="h-5 w-5 text-[var(--text-muted)]"/> : <IconEye className="h-5 w-5 text-[var(--text-muted)]"/>}
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        )}

                        {jumpsellerActiveTab === 'sync' && (
                            <div className="space-y-6 animate-fade-in-up">
                                <div className="flex items-center justify-between p-4 bg-[var(--background-muted)] rounded-lg border border-[var(--border-secondary)]">
                                    <div>
                                        <h4 className="text-sm font-bold text-[var(--text-primary)]">Sincronización Automática</h4>
                                        <p className="text-xs text-[var(--text-muted)]">Importar pedidos automáticamente desde Jumpseller.</p>
                                    </div>
                                    <label className="relative inline-flex items-center cursor-pointer">
                                        <input 
                                            type="checkbox" 
                                            className="sr-only peer" 
                                            checked={!!settings.jumpsellerAutoImport}
                                            onChange={(e) => setSettings(prev => ({ ...prev, jumpsellerAutoImport: e.target.checked }))}
                                        />
                                        <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-sky-600"></div>
                                    </label>
                                </div>

                                <div>
                                    <label className="block text-xs font-black text-[var(--text-muted)] uppercase tracking-widest mb-3">Intervalo de Sincronización</label>
                                    <div className="grid grid-cols-4 gap-3">
                                        {[5, 10, 30, 60].map((interval) => (
                                            <button
                                                key={interval}
                                                type="button"
                                                onClick={() => setSettings(prev => ({ ...prev, jumpsellerSyncInterval: interval }))}
                                                className={`py-3 text-sm font-black rounded-lg border transition-all ${
                                                    settings.jumpsellerSyncInterval === interval 
                                                    ? 'bg-sky-600 text-white border-sky-600 shadow-md' 
                                                    : 'bg-[var(--background-secondary)] text-[var(--text-secondary)] border-[var(--border-primary)] hover:border-sky-400'
                                                }`}
                                            >
                                                {interval} min
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            </div>
                        )}

                        {jumpsellerActiveTab === 'manual' && (
                            <div className="animate-fade-in-up max-h-[350px] overflow-y-auto pr-2 custom-scrollbar space-y-4">
                                <a 
                                    href="/manuals/jumpseller_guide.html" 
                                    target="_blank" 
                                    rel="noopener noreferrer"
                                    className="block p-4 bg-sky-600 hover:bg-sky-700 text-white rounded-xl shadow-md transition-all transform hover:scale-[1.02] active:scale-95 group"
                                >
                                    <div className="flex items-center justify-between">
                                        <div className="flex items-center gap-3">
                                            <div className="p-2 bg-white/20 rounded-lg">
                                                <IconJumpseller className="w-6 h-6 text-white" />
                                            </div>
                                            <div>
                                                <h4 className="text-[14px] font-black uppercase tracking-tight">Descargar Guía Jumpseller</h4>
                                                <p className="text-[11px] text-sky-100 font-medium">Manual paso a paso en PDF</p>
                                            </div>
                                        </div>
                                        <div className="w-8 h-8 bg-white/20 rounded-full flex items-center justify-center group-hover:bg-white/30 transition-colors">
                                            <span className="text-xl">↓</span>
                                        </div>
                                    </div>
                                </a>

                                <div className="p-4 bg-gray-50 rounded-xl border border-gray-100">
                                    <h4 className="text-[12px] font-black text-gray-800 uppercase mb-3 tracking-widest flex items-center gap-2">
                                        <div className="w-2 h-2 bg-sky-500 rounded-full"></div>
                                        Instrucciones de Webhook
                                    </h4>
                                    <p className="text-[12px] text-gray-600 mb-2 font-medium">Configura un Webhook en Jumpseller (Ajustes &gt; Checkout &gt; API) para recibir pedidos al instante:</p>
                                    <div className="bg-white p-2 rounded border border-sky-100 font-mono text-[10px] break-all mb-2 text-sky-700">
                                        https://api.fullenvios.cl/api/integrations/jumpseller/webhook
                                    </div>
                                    <p className="text-[11px] text-sky-600 font-bold italic">* Evento recomendado: Order Created / Order Paid</p>
                                </div>

                                <div className="p-4 border border-[var(--border-secondary)] rounded-xl">
                                    <h4 className="text-[12px] font-black text-gray-800 uppercase mb-2 tracking-widest">Reglas de Importación</h4>
                                    <ul className="text-xs text-[var(--text-secondary)] space-y-1 list-disc pl-4 font-medium">
                                        <li>Solo pedidos en estado <span className="font-bold text-sky-600 text-[11px]">Paid/Ready</span>.</li>
                                        <li>Solo direcciones en la <span className="font-bold">Región Metropolitana</span>.</li>
                                    </ul>
                                </div>
                            </div>
                        )}

                        <div className="mt-6 pt-6 border-t border-[var(--border-secondary)] flex items-center justify-between">
                            {jumpsellerActiveTab === 'connect' ? (
                                <button
                                    type="button"
                                    onClick={handleTestJumpsellerConnection}
                                    disabled={isTestingJumpseller}
                                    className="flex items-center px-4 py-2 border border-[var(--border-secondary)] text-sm font-medium rounded-md text-[var(--text-secondary)] bg-[var(--background-secondary)] hover:bg-[var(--background-hover)] disabled:opacity-50 transition-colors"
                                >
                                    {isTestingJumpseller ? <IconLoader className="w-4 h-4 mr-2 animate-spin"/> : <IconPlugConnected className="w-4 h-4 mr-2 text-sky-600"/>}
                                    Probar Conexión
                                </button>
                            ) : <div></div>}
                            
                            <button
                                onClick={handleSaveJumpseller}
                                disabled={isSavingJumpseller}
                                className="flex items-center px-6 py-2 bg-sky-600 hover:bg-sky-700 text-white text-sm font-bold rounded-md shadow-lg disabled:opacity-50 transition-all active:scale-95"
                            >
                                {isSavingJumpseller ? <IconLoader className="w-4 h-4 mr-2 animate-spin"/> : <IconCheckCircle className="w-4 h-4 mr-2"/>}
                                {isSavingJumpseller ? 'Guardando...' : 'Guardar Cambios Jumpseller'}
                            </button>
                        </div>

                        {jumpsellerTestResult && jumpsellerActiveTab === 'connect' && (
                            <div className={`mt-4 p-3 rounded-md flex items-center text-sm font-medium ${jumpsellerTestResult.type === 'success' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
                                {jumpsellerTestResult.type === 'success' ? <IconCheckCircle className="w-5 h-5 mr-2"/> : <IconAlertTriangle className="w-5 h-5 mr-2"/>}
                                {jumpsellerTestResult.message}
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* SMTP Card - Restricted to Super Admin */}
            {activeTab === 'smtp' && (auth?.user?.email === 'admin' || auth?.user?.email === 'admin@admin.cl') && (
                <div className="bg-[var(--background-secondary)] shadow-md rounded-lg border border-[var(--border-primary)] mb-8">
                    <div className="p-6">
                        <div className="flex items-center justify-between mb-4">
                            <div className="flex items-center gap-2">
                                <IconMail className="w-6 h-6 text-blue-500" />
                                <h3 className="text-lg font-bold text-[var(--text-primary)]">Servidor de Correo (SMTP)</h3>
                            </div>
                            <button
                                onClick={handleSaveSmtp}
                                disabled={isSavingSmtp}
                                className="flex items-center justify-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-blue-600 hover:bg-blue-700 disabled:bg-slate-400 transition-colors"
                            >
                                {isSavingSmtp ? <IconLoader className="w-4 h-4 mr-2 animate-spin"/> : <IconCheckCircle className="w-4 h-4 mr-2"/>}
                                Guardar SMTP
                            </button>
                        </div>

                        <p className="text-sm text-[var(--text-muted)] mb-4">Configura tu servidor SMTP para el envío de notificaciones automáticas a clientes finales.</p>
                        <div className="space-y-4">
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                <div className="md:col-span-2">
                                    <label htmlFor="smtpHost" className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Host SMTP</label>
                                    <input
                                        type="text"
                                        id="smtpHost"
                                        name="smtpHost"
                                        value={settings.smtpHost || ''}
                                        onChange={handleChange}
                                        className={inputClasses}
                                        placeholder="smtp.ejemplo.com"
                                    />
                                </div>
                                <div>
                                    <label htmlFor="smtpPort" className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Puerto</label>
                                    <input
                                        type="text"
                                        id="smtpPort"
                                        name="smtpPort"
                                        value={settings.smtpPort || ''}
                                        onChange={handleChange}
                                        className={inputClasses}
                                        placeholder="465 o 587"
                                    />
                                </div>
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div>
                                    <label htmlFor="smtpUser" className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Nombre de Usuario / Email</label>
                                    <input
                                        type="text"
                                        id="smtpUser"
                                        name="smtpUser"
                                        value={settings.smtpUser || ''}
                                        onChange={handleChange}
                                        className={inputClasses}
                                        placeholder="usuario@dominio.com"
                                    />
                                </div>
                                <div>
                                    <label htmlFor="smtpPassword" className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Contraseña</label>
                                    <div className="relative">
                                        <input
                                            type={passwordVisibility.smtpPassword ? 'text' : 'password'}
                                            id="smtpPassword"
                                            name="smtpPassword"
                                            value={settings.smtpPassword || ''}
                                            onChange={handleChange}
                                            className={`${inputClasses} pr-10`}
                                            placeholder="************************"
                                        />
                                        <button type="button" onClick={() => togglePasswordVisibility('smtpPassword')} className="absolute inset-y-0 right-0 pr-3 flex items-center">
                                            {passwordVisibility.smtpPassword ? <IconEyeOff className="h-5 w-5 text-[var(--text-muted)]"/> : <IconEye className="h-5 w-5 text-[var(--text-muted)]"/>}
                                        </button>
                                    </div>
                                </div>
                            </div>
                            <div>
                                <label htmlFor="smtpFrom" className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Email Remitente (De:)</label>
                                <input
                                    type="text"
                                    id="smtpFrom"
                                    name="smtpFrom"
                                    value={settings.smtpFrom || ''}
                                    onChange={handleChange}
                                    className={inputClasses}
                                    placeholder="Notificaciones Full Envíos <noreply@dominio.com>"
                                />
                            </div>

                            {/* [NUEVO] Sección de Google Auth */}
                            <div className="pt-4 border-t border-[var(--border-secondary)]">
                                <div className="bg-[var(--background-muted)] rounded-lg p-4 border border-[var(--border-primary)] shadow-inner">
                                    <div className="flex flex-col md:flex-row items-center justify-between gap-4">
                                        <div className="flex items-center gap-3">
                                            <div className="bg-white p-2 rounded-full shadow-sm">
                                                <svg className="w-6 h-6" viewBox="0 0 24 24">
                                                    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                                                    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-1 .67-2.28 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                                                    <path fill="#FBBC05" d="M5.84 14.09c-.22-.67-.35-1.39-.35-2.09s.13-1.42.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/>
                                                    <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                                                </svg>
                                            </div>
                                            <div>
                                                <h4 className="text-sm font-bold text-[var(--text-primary)]">Google OAuth2</h4>
                                                <p className="text-[11px] text-[var(--text-muted)] font-medium leading-tight">Autoriza el envío de correos iniciando sesión directamente con Google.</p>
                                            </div>
                                        </div>

                                        {!settings.hasGoogleSmtp ? (
                                            <button
                                                type="button"
                                                onClick={handleGoogleAuth}
                                                disabled={isAuthorizingGoogle}
                                                className="bg-white hover:bg-gray-50 text-gray-700 font-bold py-2 px-4 rounded-md border border-gray-300 shadow-md flex items-center gap-2 transition-all active:scale-95 disabled:opacity-50"
                                            >
                                                {isAuthorizingGoogle ? <IconLoader className="w-4 h-4 animate-spin text-blue-600" /> : null}
                                                Iniciar sesión con Google
                                            </button>
                                        ) : (
                                            <div className="flex items-center gap-2">
                                                <div className="bg-green-100 text-green-700 px-3 py-1.5 rounded-full text-[11px] font-black uppercase tracking-wider flex items-center gap-2 border border-green-200">
                                                    <IconCheckCircle className="w-3 h-3" />
                                                    Conectado: {settings.smtpGoogleEmail}
                                                </div>
                                                <button
                                                    type="button"
                                                    onClick={handleDisconnectGoogle}
                                                    className="text-red-500 hover:text-red-700 text-[11px] font-black uppercase tracking-widest hover:underline transition-all"
                                                >
                                                    Desconectar
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                    
                                    {settings.hasGoogleSmtp && (
                                        <div className="mt-3 p-2 bg-blue-50 border border-blue-100 rounded text-[10px] text-blue-700 font-medium">
                                            <strong>Nota:</strong> Al usar Google OAuth2, los campos manuales de host y contraseña son ignorados. El sistema priorizará la conexión segura de Google.
                                        </div>
                                    )}
                                </div>
                            </div>

                            <div className="flex items-center justify-end pt-2 border-t border-[var(--border-secondary)] mt-4">
                                <button
                                    type="button"
                                    onClick={handleTestSmtpConnection}
                                    disabled={isTestingSmtp}
                                    className="flex items-center px-4 py-2 border border-[var(--border-secondary)] text-sm font-medium rounded-md text-[var(--text-secondary)] bg-[var(--background-secondary)] hover:bg-[var(--background-hover)] disabled:opacity-50 transition-colors"
                                >
                                    {isTestingSmtp ? <IconLoader className="w-4 h-4 mr-2 animate-spin"/> : <IconPlugConnected className="w-4 h-4 mr-2"/>}
                                    Probar Conexión SMTP
                                </button>
                            </div>

                            {smtpTestResult && (
                                <div className={`p-3 rounded-md flex items-center text-sm font-medium ${smtpTestResult.type === 'success' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
                                    {smtpTestResult.type === 'success' ? <IconCheckCircle className="w-5 h-5 mr-2"/> : <IconAlertTriangle className="w-5 h-5 mr-2"/>}
                                    {smtpTestResult.message}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* GitHub Backup Section */}
            {activeTab === 'github' && auth?.user?.email === 'admin' && (
                <div className="bg-[var(--background-paper)] rounded-xl shadow-sm border border-[var(--border-color)] overflow-hidden">
                    <div className="p-6 border-b border-[var(--border-color)] flex items-center justify-between bg-gray-50 dark:bg-gray-800/50">
                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-lg bg-gray-900 flex items-center justify-center text-white">
                                <IconGithub className="w-6 h-6" />
                            </div>
                            <div>
                                <h2 className="text-lg font-bold text-[var(--text-primary)]">Respaldo en GitHub</h2>
                                <p className="text-sm text-[var(--text-secondary)]">Respalda tus datos en un repositorio de GitHub (main y developer)</p>
                            </div>
                        </div>
                    </div>

                    <div className="p-6 space-y-6">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                            <div className="space-y-2">
                                <label className="text-sm font-medium text-[var(--text-secondary)]">GitHub Owner (Usuario o Org)</label>
                                <input
                                    type="text"
                                    name="githubOwner"
                                    value={settings.githubOwner || ''}
                                    onChange={handleChange}
                                    className="w-full px-4 py-2 rounded-lg border border-[var(--border-color)] bg-[var(--background-muted)] text-[var(--text-primary)] focus:ring-2 focus:ring-blue-500 outline-none transition-all"
                                    placeholder="ej: mi-usuario"
                                />
                            </div>
                            <div className="space-y-2">
                                <label className="text-sm font-medium text-[var(--text-secondary)]">GitHub Repository Name</label>
                                <input
                                    type="text"
                                    name="githubRepo"
                                    value={settings.githubRepo || ''}
                                    onChange={handleChange}
                                    className="w-full px-4 py-2 rounded-lg border border-[var(--border-color)] bg-[var(--background-muted)] text-[var(--text-primary)] focus:ring-2 focus:ring-blue-500 outline-none transition-all"
                                    placeholder="ej: mi-repo-respaldo"
                                />
                            </div>
                            <div className="space-y-2 md:col-span-2">
                                <label className="text-sm font-medium text-[var(--text-secondary)]">GitHub Personal Access Token</label>
                                <div className="relative">
                                    <input
                                        type={passwordVisibility.githubToken ? 'text' : 'password'}
                                        name="githubToken"
                                        value={settings.githubToken || ''}
                                        onChange={handleChange}
                                        className="w-full pl-4 pr-12 py-2 rounded-lg border border-[var(--border-color)] bg-[var(--background-muted)] text-[var(--text-primary)] focus:ring-2 focus:ring-blue-500 outline-none transition-all"
                                        placeholder="ghp_xxxxxxxxxxxx"
                                    />
                                    <button
                                        type="button"
                                        onClick={() => togglePasswordVisibility('githubToken')}
                                        className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                                    >
                                        {passwordVisibility.githubToken ? <IconEyeOff className="w-5 h-5" /> : <IconEye className="w-5 h-5" />}
                                    </button>
                                </div>
                                <p className="text-xs text-[var(--text-secondary)]">Requiere permisos de 'repo' o 'contents:write'.</p>
                            </div>
                        </div>

                        <div className="flex flex-wrap items-center gap-4 pt-4 border-t border-[var(--border-color)]">
                            <button
                                onClick={handleSaveGithub}
                                disabled={isSavingGithub}
                                className="px-6 py-2 bg-gray-900 hover:bg-black text-white rounded-lg font-medium transition-all flex items-center gap-2 disabled:opacity-50"
                            >
                                {isSavingGithub ? <IconLoader className="w-5 h-5 animate-spin" /> : <IconCheckCircle className="w-5 h-5" />}
                                Guardar Configuración GitHub
                            </button>

                            <button
                                onClick={handleManualBackup}
                                disabled={isBackingUp}
                                className="px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition-all flex items-center gap-2 disabled:opacity-50"
                            >
                                {isBackingUp ? <IconLoader className="w-5 h-5 animate-spin" /> : <IconDownload className="w-5 h-5" />}
                                Realizar Respaldo Manual
                            </button>
                        </div>

                        {backupResult && (
                            <div className={`p-4 rounded-lg flex items-center gap-3 ${backupResult.type === 'success' ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'}`}>
                                {backupResult.type === 'success' ? <IconCheckCircle className="w-5 h-5" /> : <IconAlertTriangle className="w-5 h-5" />}
                                <span className="text-sm font-medium">{backupResult.message}</span>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};

export default IntegrationSettingsPage;
