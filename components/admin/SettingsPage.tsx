
import React, { useState, useEffect, useContext, useMemo } from 'react';
import { api } from '../../services/api';
import { AuthContext } from '../../contexts/AuthContext';
import { IconEye, IconEyeOff, IconCheckCircle, IconMail, IconWhatsapp, IconQrcode, IconPencil, IconInfo, IconChecklist, IconTrash, IconAlertTriangle, IconTruck, IconPrinter, IconSettings, IconLayoutDashboard, IconUsers, IconMap } from '../Icon';
import { useTheme } from '../../contexts/ThemeContext';
import DeleteDatabaseModal, { ResetType } from '../modals/DeleteDatabaseModal';
import { MessagingPlan, PickupMode, LabelFormat, Role } from '../../constants';
import CommuneManagement from './CommuneManagement';

const messagingPlanConfig = {
    [MessagingPlan.None]: { name: 'Sin Mensajería', description: 'No se envían notificaciones automáticas a clientes.' },
    [MessagingPlan.Email]: { name: 'Mensajería por Email', description: 'Notificaciones automáticas por correo electrónico.' },
    [MessagingPlan.WhatsApp]: { name: 'Mensajería por WhatsApp', description: 'Notificaciones automáticas vía WhatsApp.' },
};

const pickupModeConfig = {
    [PickupMode.Scan]: { name: 'Solo Escaneo', description: 'El retiro se cierra automáticamente con la cantidad de paquetes escaneados.', icon: <IconQrcode className="w-6 h-6 mx-auto mb-2 text-purple-500" /> },
    [PickupMode.Manual]: { name: 'Solo Ingreso Manual', description: 'El conductor ingresa manualmente la cantidad total. No se usa escáner.', icon: <IconPencil className="w-6 h-6 mx-auto mb-2 text-blue-500" /> },
    [PickupMode.ScanWithCount]: { name: 'Escaneo + Conteo', description: 'El conductor escanea, pero DEBE ingresar la cantidad final manualmente para cerrar.', icon: <IconChecklist className="w-6 h-6 mx-auto mb-2 text-orange-500" /> },
    [PickupMode.Colecta]: { name: 'Modo Colecta', description: 'Los conductores eligen qué retiros realizar de una lista global de clientes.', icon: <IconTruck className="w-6 h-6 mx-auto mb-2 text-emerald-500" /> },
};

interface SettingsState {
    companyName: string;
    isAppEnabled: boolean;
    requiredPhotos: number;
    messagingPlan: MessagingPlan;
    pickupMode: PickupMode;
    meliFlexValidation: boolean;
    meliAutoPromptPhotos: boolean;
    saveFlexLabelPhoto: boolean;
    meliAutoImport: boolean;
    shopifyAutoImport: boolean;
    woocommerceAutoImport: boolean;
    falabellaAutoImport: boolean;
    publicTrackingEnabled: boolean;
    isRutRequired: boolean;
    flexDiscrepancyReportEnabled: boolean;
    labelFormat: LabelFormat;
    circuitExportEnabled: boolean;
    timeFormat: '12h' | '24h';
    allowRedelivery: boolean;
    timezone: string;
    showPendingPaymentAlert: boolean;
    multiSelectEnabled: boolean;
    gisSectorsEnabled: boolean;
    fleetControlEnabled: boolean;
    pendingNotificationsEnabled: boolean;
    adminWhatsappNumber: string;
    adminCallmebotApiKey: string;
}

const SettingsPage: React.FC = () => {
    const [settings, setSettings] = useState<SettingsState>({ 
        companyName: '', 
        isAppEnabled: true, 
        requiredPhotos: 1,
        messagingPlan: MessagingPlan.None,
        pickupMode: PickupMode.Scan,
        meliFlexValidation: true,
        meliAutoPromptPhotos: false,
        saveFlexLabelPhoto: false,
        meliAutoImport: false,
        shopifyAutoImport: false,
        woocommerceAutoImport: false,
        falabellaAutoImport: false,
        publicTrackingEnabled: true,
        isRutRequired: true,
        flexDiscrepancyReportEnabled: true,
        labelFormat: LabelFormat.CompactThermal,
        circuitExportEnabled: false,
        timeFormat: '12h',
        allowRedelivery: false,
        timezone: 'America/Santiago',
        recipientNotificationsEnabled: false,
        showPendingPaymentAlert: false,
        multiSelectEnabled: true,
        gisSectorsEnabled: true,
        fleetControlEnabled: true,
        pendingNotificationsEnabled: false,
        adminWhatsappNumber: '',
        adminCallmebotApiKey: '',
    });
    const [originalSettings, setOriginalSettings] = useState<SettingsState | null>(null);
    const [password, setPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [successMessage, setSuccessMessage] = useState('');
    const [errorMessage, setErrorMessage] = useState('');
    const [isTestingWhatsapp, setIsTestingWhatsapp] = useState(false);
    const [showPassword, setShowPassword] = useState(false);
    const [showConfirmPassword, setShowConfirmPassword] = useState(false);
    const [isDeleteDbModalOpen, setIsDeleteDbModalOpen] = useState(false);
    const [resetType, setResetType] = useState<ResetType>('all');
    const [currentTime, setCurrentTime] = useState<Date>(new Date());
    const auth = useContext(AuthContext);
    const { theme, setTheme } = useTheme();
    const [activeTab, setActiveTab] = useState<'general' | 'impresion' | 'botones' | 'retiro' | 'mensajeria' | 'comunas' | 'apariencia' | 'seguridad'>('general');

    const isSuperUser = auth?.user?.email === 'admin' || auth?.user?.email === 'admin@admin.cl';

    useEffect(() => {
        if (auth?.systemSettings) {
            const loadedSettings: SettingsState = {
                companyName: auth.systemSettings.companyName,
                isAppEnabled: auth.systemSettings.isAppEnabled,
                requiredPhotos: auth.systemSettings.requiredPhotos || 1,
                messagingPlan: auth.systemSettings.messagingPlan || MessagingPlan.None,
                pickupMode: auth.systemSettings.pickupMode || PickupMode.Scan,
                meliFlexValidation: auth.systemSettings.meliFlexValidation ?? true,
                meliAutoPromptPhotos: auth.systemSettings.meliAutoPromptPhotos ?? false,
                saveFlexLabelPhoto: auth.systemSettings.saveFlexLabelPhoto ?? false,
                meliAutoImport: auth.systemSettings.meliAutoImport ?? false,
                shopifyAutoImport: auth.systemSettings.shopifyAutoImport ?? false,
                woocommerceAutoImport: auth.systemSettings.woocommerceAutoImport ?? false,
                falabellaAutoImport: auth.systemSettings.falabellaAutoImport ?? false,
                publicTrackingEnabled: auth.systemSettings.publicTrackingEnabled ?? true,
                isRutRequired: auth.systemSettings.isRutRequired ?? true,
                flexDiscrepancyReportEnabled: auth.systemSettings.flexDiscrepancyReportEnabled ?? true,
                labelFormat: auth.systemSettings.labelFormat || LabelFormat.CompactThermal,
                circuitExportEnabled: auth.systemSettings.circuitExportEnabled ?? false,
                timeFormat: auth.systemSettings.timeFormat || '12h',
                allowRedelivery: auth.systemSettings.allowRedelivery ?? false,
                timezone: auth.systemSettings.timezone || 'America/Santiago',
                recipientNotificationsEnabled: auth.systemSettings.recipientNotificationsEnabled ?? false,
                showPendingPaymentAlert: auth.systemSettings.showPendingPaymentAlert ?? false,
                multiSelectEnabled: auth.systemSettings.multiSelectEnabled ?? true,
                gisSectorsEnabled: auth.systemSettings.gisSectorsEnabled ?? true,
                fleetControlEnabled: auth.systemSettings.fleetControlEnabled ?? true,
                pendingNotificationsEnabled: auth.systemSettings.pendingNotificationsEnabled ?? false,
                adminWhatsappNumber: auth.systemSettings.adminWhatsappNumber || '',
                adminCallmebotApiKey: auth.systemSettings.adminCallmebotApiKey || '',
            };
            setSettings(loadedSettings);
            setOriginalSettings(loadedSettings);
        }
    }, [auth?.systemSettings]);
    
    useEffect(() => {
        const timer = setInterval(() => {
            // Use the configured timezone for the clock display
            const now = new Date();
            setCurrentTime(now);
        }, 1000);
        return () => clearInterval(timer);
    }, []);
    
    const showSuccess = (message: string) => {
        setSuccessMessage(message);
        setTimeout(() => setSuccessMessage(''), 3000);
    };

    const showError = (message: string) => {
        setErrorMessage(message);
        setTimeout(() => setErrorMessage(''), 3000);
    };
    
    const handleSettingsChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const { name, value, type, checked } = e.target;
        if (type === 'checkbox') {
             setSettings(prev => {
                 return { ...prev, [name]: checked };
             });
        } else if (type === 'number') {
            const numValue = parseInt(value, 10);
            setSettings(prev => ({ ...prev, [name]: isNaN(numValue) ? '' : numValue }));
        } else {
            setSettings(prev => ({ ...prev, [name]: value }));
        }
    };

    const handlePlanChange = (plan: MessagingPlan) => {
        setSettings(prev => ({ ...prev, messagingPlan: plan }));
    };

    const handlePickupModeChange = (mode: PickupMode) => {
        setSettings(prev => ({ ...prev, pickupMode: mode }));
    };

    const handleGeneralSettingsSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!auth) return;
        try {
            await auth.updateSystemSettings({ 
                companyName: settings.companyName,
                requiredPhotos: Number(settings.requiredPhotos),
                messagingPlan: settings.messagingPlan,
                pickupMode: settings.pickupMode,
                meliFlexValidation: settings.meliFlexValidation,
                meliAutoPromptPhotos: settings.meliAutoPromptPhotos,
                saveFlexLabelPhoto: settings.saveFlexLabelPhoto,
                meliAutoImport: settings.meliAutoImport,
                shopifyAutoImport: settings.shopifyAutoImport,
                woocommerceAutoImport: settings.woocommerceAutoImport,
                falabellaAutoImport: settings.falabellaAutoImport,
                publicTrackingEnabled: settings.publicTrackingEnabled,
                isRutRequired: settings.isRutRequired,
                flexDiscrepancyReportEnabled: settings.flexDiscrepancyReportEnabled,
                labelFormat: settings.labelFormat,
                circuitExportEnabled: settings.circuitExportEnabled,
                timeFormat: settings.timeFormat,
                allowRedelivery: settings.allowRedelivery,
                timezone: settings.timezone,
                showPendingPaymentAlert: settings.showPendingPaymentAlert,
                multiSelectEnabled: settings.multiSelectEnabled,
                gisSectorsEnabled: settings.gisSectorsEnabled,
                fleetControlEnabled: settings.fleetControlEnabled,
                pendingNotificationsEnabled: settings.pendingNotificationsEnabled,
                adminWhatsappNumber: settings.adminWhatsappNumber,
                adminCallmebotApiKey: settings.adminCallmebotApiKey,
            });
            setOriginalSettings(settings); 
            showSuccess('Configuración general y de plan actualizada con éxito.');
        } catch (error) {
            showError('Error al actualizar la configuración.');
        }
    };

    const handleTestWhatsapp = async () => {
        if (!settings.adminWhatsappNumber || !settings.adminCallmebotApiKey) {
            showError('Por favor ingresa el número de WhatsApp y el API Key de CallMeBot.');
            return;
        }
        setIsTestingWhatsapp(true);
        try {
            const res = await api.testWhatsapp(settings.adminWhatsappNumber, settings.adminCallmebotApiKey);
            showSuccess(res.message || 'Mensaje de prueba enviado con éxito. Revisa tu WhatsApp.');
        } catch (error: any) {
            showError(error.message || 'Error al enviar el mensaje de prueba.');
        } finally {
            setIsTestingWhatsapp(false);
        }
    };
    
    const handleAppStatusToggle = async () => {
        if (!auth) return;
        try {
            const newStatus = !settings.isAppEnabled;
            await auth.updateSystemSettings({ isAppEnabled: newStatus });
            const updatedSettings = { ...settings, isAppEnabled: newStatus };
            setSettings(updatedSettings);
            setOriginalSettings(prev => prev ? ({ ...prev, isAppEnabled: newStatus }) : null);
            showSuccess(`Aplicación ${newStatus ? 'habilitada' : 'deshabilitada'} con éxito.`);
        } catch (error) {
            showError('Error al cambiar el estado de la aplicación.');
        }
    };


    const handlePasswordSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (password !== confirmPassword) {
            showError('Las contraseñas no coinciden.');
            return;
        }
        if (password.length < 6) {
            showError('La nueva contraseña debe tener al menos 6 caracteres.');
            return;
        }
        if (!auth?.user) {
            showError('Usuario no autenticado.');
            return;
        }

        try {
            await api.updateUser(auth.user.id, { password });
            showSuccess('Contraseña actualizada con éxito.');
            setPassword('');
            setConfirmPassword('');
        } catch (error) {
            showError('Error al actualizar la contraseña.');
        }
    };
    
    const handleResetDatabase = async (password: string, type: ResetType) => {
        try {
            let result;
            switch(type) {
                case 'all':
                    result = await api.resetDatabase(password);
                    break;
                case 'packages':
                    result = await api.resetPackages(password);
                    break;
                case 'clients':
                    result = await api.resetClients(password);
                    break;
                case 'drivers':
                    result = await api.resetDrivers(password);
                    break;
                case 'zones':
                    result = await api.resetZones(password);
                    break;
                case 'invoices':
                    result = await api.resetInvoices(password);
                    break;
                default:
                    throw new Error('Tipo de reinicio no válido');
            }
            setIsDeleteDbModalOpen(false);
            if (type === 'all') {
                auth?.logout();
            } else {
                showSuccess(result.message);
                window.location.reload();
            }
        } catch (error: any) {
            showError(error.message || 'Hubo un error al procesar la solicitud.');
            console.error("Database reset failed", error);
        }
    };

    const openResetModal = (type: ResetType) => {
        setResetType(type);
        setIsDeleteDbModalOpen(true);
    };

    const hasChanges = useMemo(() => {
        if (!originalSettings) return false;
        return (
            settings.companyName !== originalSettings.companyName ||
            settings.requiredPhotos !== originalSettings.requiredPhotos ||
            settings.messagingPlan !== originalSettings.messagingPlan ||
            settings.pickupMode !== originalSettings.pickupMode ||
            settings.meliFlexValidation !== originalSettings.meliFlexValidation ||
            settings.meliAutoPromptPhotos !== originalSettings.meliAutoPromptPhotos ||
            settings.saveFlexLabelPhoto !== originalSettings.saveFlexLabelPhoto ||
            settings.meliAutoImport !== originalSettings.meliAutoImport ||
            settings.shopifyAutoImport !== originalSettings.shopifyAutoImport ||
            settings.woocommerceAutoImport !== originalSettings.woocommerceAutoImport ||
            settings.falabellaAutoImport !== originalSettings.falabellaAutoImport ||
            settings.publicTrackingEnabled !== originalSettings.publicTrackingEnabled ||
            settings.isRutRequired !== originalSettings.isRutRequired ||
            settings.flexDiscrepancyReportEnabled !== originalSettings.flexDiscrepancyReportEnabled ||
            settings.labelFormat !== originalSettings.labelFormat ||
            settings.circuitExportEnabled !== originalSettings.circuitExportEnabled ||
            settings.timeFormat !== originalSettings.timeFormat ||
            settings.allowRedelivery !== originalSettings.allowRedelivery ||
            settings.timezone !== originalSettings.timezone ||
            settings.recipientNotificationsEnabled !== originalSettings.recipientNotificationsEnabled ||
            settings.showPendingPaymentAlert !== originalSettings.showPendingPaymentAlert ||
            settings.multiSelectEnabled !== originalSettings.multiSelectEnabled ||
            settings.gisSectorsEnabled !== originalSettings.gisSectorsEnabled ||
            settings.fleetControlEnabled !== originalSettings.fleetControlEnabled ||
            settings.pendingNotificationsEnabled !== originalSettings.pendingNotificationsEnabled ||
            settings.adminWhatsappNumber !== originalSettings.adminWhatsappNumber ||
            settings.adminCallmebotApiKey !== originalSettings.adminCallmebotApiKey
        );
    }, [settings, originalSettings]);

    const inputClasses = "w-full px-3 py-2 border border-[var(--border-secondary)] rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-secondary)] bg-[var(--background-secondary)]";
    
    const ThemeButton: React.FC<{ name: 'default' | 'light' | 'dark' | 'corporate' | 'ocean' | 'nature' | 'midnight', label: string, colors: string[] }> = ({ name, label, colors }) => (
        <button
            onClick={() => setTheme(name)}
            className={`w-full p-4 border rounded-lg text-left relative transition-all ${theme === name ? 'border-[var(--brand-primary)] ring-2 ring-[var(--brand-primary)]' : 'border-[var(--border-secondary)] hover:border-[var(--brand-secondary)]'}`}
        >
            <div className="flex items-center justify-between">
                <span className="font-semibold text-[var(--text-primary)]">{label}</span>
                {theme === name && <IconCheckCircle className="w-5 h-5 text-[var(--brand-primary)]" />}
            </div>
            <div className="flex gap-2 mt-2">
                {colors.map((color, i) => <div key={i} className="w-6 h-6 rounded-full" style={{ backgroundColor: color }}></div>)}
            </div>
        </button>
    );

    return (
        <div className="space-y-8 max-w-4xl">
            {successMessage && <div className="bg-[var(--success-bg)] border border-[var(--success-border)] text-[var(--success-text)] px-4 py-3 rounded relative mb-4" role="alert">{successMessage}</div>}
            {errorMessage && <div className="bg-[var(--error-bg)] border border-[var(--error-border)] text-[var(--error-text)] px-4 py-3 rounded relative mb-4" role="alert">{errorMessage}</div>}

            {/* TAB NAVIGATION BAR */}
            <div className="flex flex-wrap border-b border-[var(--border-primary)] gap-1 pb-3">
                {[
                    { id: 'general', label: 'General', icon: <IconSettings className="w-3.5 h-3.5" /> },
                    { id: 'impresion', label: 'Impresión', icon: <IconPrinter className="w-3.5 h-3.5" /> },
                    { id: 'botones', label: 'Bot. Conf.', icon: <IconChecklist className="w-3.5 h-3.5" /> },
                    { id: 'retiro', label: 'Retiro', icon: <IconTruck className="w-3.5 h-3.5" /> },
                    { id: 'mensajeria', label: 'Mensajes', icon: <IconMail className="w-3.5 h-3.5" /> },
                    ...(auth?.user?.role === Role.Admin ? [{ id: 'comunas', label: 'Comunas', icon: <IconMap className="w-3.5 h-3.5" /> }] : []),
                    { id: 'apariencia', label: 'Temas', icon: <IconLayoutDashboard className="w-3.5 h-3.5" /> },
                    ...(auth?.user?.email === 'admin' ? [{ id: 'seguridad', label: 'Seguridad', icon: <IconAlertTriangle className="w-3.5 h-3.5 text-amber-500" /> }] : [])
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

            {/* SETTINGS CARD FORM */}
            {(activeTab === 'general' || activeTab === 'impresion' || activeTab === 'botones' || activeTab === 'retiro' || activeTab === 'mensajeria') && (
                <div className="bg-[var(--background-secondary)] shadow-md rounded-lg p-6">
                    <form onSubmit={handleGeneralSettingsSubmit} className="space-y-6">
                        
                        {/* GENERAL CONFIGURATION */}
                        {activeTab === 'general' && (
                            <div className="space-y-6">
                                <h2 className="text-xl font-bold text-[var(--text-primary)] mb-4 border-b border-[var(--border-primary)] pb-3">Configuración General</h2>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                    <div>
                                        <label htmlFor="companyName" className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Nombre de la Empresa</label>
                                        <input type="text" id="companyName" name="companyName" value={settings.companyName} onChange={handleSettingsChange} required className={`${inputClasses} text-[var(--text-primary)]`}/>
                                    </div>
                                    <div>
                                         <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Hora Local del Sistema</label>
                                         <div className="flex items-center gap-2">
                                            <input 
                                                type="text" 
                                                disabled 
                                                value={currentTime.toLocaleString('es-CL', { 
                                                    hour12: settings.timeFormat === '12h',
                                                    timeZone: settings.timezone 
                                                })} 
                                                className={`${inputClasses} bg-[var(--background-muted)] text-[var(--brand-primary)] font-mono font-black text-center flex-1`} 
                                            />
                                            <div className="flex border border-[var(--border-secondary)] rounded-md overflow-hidden shrink-0">
                                                <button 
                                                    type="button"
                                                    onClick={() => setSettings(prev => ({ ...prev, timeFormat: '12h' }))}
                                                    className={`px-3 py-2 text-sm font-bold ${settings.timeFormat === '12h' ? 'bg-[var(--brand-primary)] text-white' : 'bg-[var(--background-secondary)] text-[var(--text-secondary)] hover:bg-[var(--background-muted)]'}`}
                                                >12 hrs</button>
                                                <div className="w-px bg-[var(--border-secondary)]"></div>
                                                <button 
                                                    type="button"
                                                    onClick={() => setSettings(prev => ({ ...prev, timeFormat: '24h' }))}
                                                    className={`px-3 py-2 text-sm font-bold ${settings.timeFormat === '24h' ? 'bg-[var(--brand-primary)] text-white' : 'bg-[var(--background-secondary)] text-[var(--text-secondary)] hover:bg-[var(--background-muted)]'}`}
                                                >24 hrs</button>
                                            </div>
                                         </div>
                                         <p className="text-[10px] text-[var(--text-muted)] mt-1 uppercase tracking-widest">Zona Horaria: {settings.timezone}</p>
                                    </div>
                                    <div>
                                         <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Versión del Sistema</label>
                                         <div className="relative">
                                            <input 
                                                type="text" 
                                                disabled 
                                                value={`v${(import.meta as any).env.VITE_APP_VERSION} (Actualizado: ${(import.meta as any).env.VITE_BUILD_DATE || 'Desconocido'})`} 
                                                className={`${inputClasses} bg-[var(--background-muted)] text-[var(--text-muted)] cursor-not-allowed`} 
                                            />
                                            <div className="absolute inset-y-0 right-0 pr-3 flex items-center pointer-events-none">
                                                <IconInfo className="h-5 w-5 text-[var(--text-muted)]" />
                                            </div>
                                         </div>
                                    </div>
                                    <div>
                                        <label htmlFor="requiredPhotos" className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Fotos requeridas por Entrega</label>
                                        <input type="number" id="requiredPhotos" name="requiredPhotos" value={settings.requiredPhotos} onChange={handleSettingsChange} min="1" max="5" required className={`${inputClasses} text-[var(--text-primary)]`}/>
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* PRINT SETTINGS */}
                        {activeTab === 'impresion' && (
                            <div className="space-y-6">
                                <h2 className="text-xl font-bold text-[var(--text-primary)] mb-4 border-b border-[var(--border-primary)] pb-3">Ajustes de Impresión</h2>
                                <div className="bg-[var(--brand-muted)] p-6 rounded-2xl shadow-inner border-2 border-dashed border-black">
                                    <h3 className="text-xl font-black text-black flex items-center gap-2 mb-2">
                                         🎨 SISTEMA DE DISEÑO DE INFORMACIÓN
                                         <span className="text-[10px] bg-black text-white px-3 py-1 rounded-full animate-bounce">ACTIVO v2.4.8</span>
                                    </h3>
                                    <p className="text-sm text-gray-500 mb-6 italic">Selecciona cómo quieres que se organicen los datos en tus etiquetas. Este ajuste afectará a todas las impresiones por defecto.</p>
                                    
                                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                                        {[
                                            { id: LabelFormat.CompactThermal, name: 'Diseño 1', desc: 'Foco en Comuna XL', size: '100x150mm', icon: <div className="w-full h-24 bg-white border-4 border-black rounded-lg flex flex-col p-2"><div className="w-full h-1 bg-gray-100 mb-1"></div><div className="flex-1 border-4 border-black flex items-center justify-center font-black text-xl">MAIPÚ</div><div className="flex justify-between mt-1"><div className="w-6 h-6 border-2 border-black"></div><div className="w-10 h-2 bg-black self-end"></div></div></div> },
                                            { id: LabelFormat.FullThermal, name: 'Diseño 2', desc: 'Foco en Identidad Client', size: '100x150mm', icon: <div className="w-full h-24 bg-white border-4 border-black rounded-lg flex flex-col"><div className="bg-black h-4 w-full"></div><div className="flex-1 p-2 flex flex-col justify-center items-center"><div className="w-full h-4 border-b-2 border-black mb-1"></div><div className="w-3/4 h-2 bg-gray-100"></div></div><div className="flex justify-end p-1"><div className="w-4 h-4 border-2 border-black"></div></div></div> },
                                            { id: LabelFormat.ZebraZpl, name: 'Diseño 3', desc: 'Estilo Industrial (QR)', size: '4"x6"', icon: <div className="w-full h-24 bg-white border-4 border-black rounded-lg flex overflow-hidden"><div className="w-1/3 bg-black flex flex-col items-center p-1"><div className="w-full h-1/2 border border-white"></div><div className="w-4 h-4 bg-white mt-auto mb-1"></div></div><div className="flex-1 p-2 space-y-1"><div className="w-full h-2 bg-gray-200"></div><div className="w-full h-6 bg-gray-50"></div></div></div> },
                                            { id: LabelFormat.A4Single, name: 'Diseño 4', desc: 'Foco en Notas XL', size: 'Carta / A4', icon: <div className="w-full h-24 bg-gray-50 rounded flex items-center justify-center"><div className="w-12 h-16 bg-white border-2 border-black shadow-sm relative p-1"><div className="w-full h-6 bg-blue-50 border border-blue-100"></div><div className="absolute bottom-1 right-1 w-4 h-4 border border-black"></div></div></div> },
                                            { id: LabelFormat.A4Half, name: 'Diseño 5', desc: 'Foco en Tracking ID', size: 'Carta (x2)', icon: <div className="w-full h-24 bg-gray-50 rounded flex items-center justify-center"><div className="w-12 h-16 bg-white border-2 border-black shadow-sm flex flex-col overflow-hidden"><div className="flex-1 border-b-2 border-dashed border-black p-1"><div className="w-full h-full bg-slate-50"></div></div><div className="flex-1 p-1"><div className="w-full h-full bg-slate-50"></div></div></div></div> },
                                            { id: LabelFormat.MinimalSticker, name: 'Diseño 6', desc: 'Compacto Full Info', size: 'A6 / 105x148', icon: <div className="w-full h-24 bg-white border-2 border-slate-300 rounded flex flex-col p-1 gap-1"><div className="h-2 bg-slate-100 w-full"></div><div className="flex gap-1"><div className="flex-1 h-3 border border-black"></div><div className="flex-1 h-3 border border-black"></div></div><div className="h-8 border-4 border-black w-full"></div><div className="h-4 border border-black w-full"></div></div> },
                                            { id: LabelFormat.Thermal10x8, name: 'Diseño 7', desc: 'Térmica 10x8 (Rotada)', size: '100x80mm', icon: <div className="w-full h-24 bg-gray-50 rounded flex items-center justify-center"><div className="w-20 h-16 bg-white border-4 border-black rounded shadow-sm flex items-center justify-center overflow-hidden"><div className="w-12 h-16 border-2 border-black border-dashed flex flex-col rotate-90 origin-center p-1"><div className="w-full h-2 bg-black mb-1"></div><div className="flex-1 w-full bg-gray-100"></div></div></div></div> },
                                        ].map(fmt => (
                                            <button
                                                key={fmt.id}
                                                type="button"
                                                onClick={() => setSettings(prev => ({ ...prev, labelFormat: fmt.id as LabelFormat }))}
                                                className={`p-4 border-4 rounded-3xl text-left relative transition-all group ${settings.labelFormat === fmt.id ? 'border-black bg-white shadow-[8px_8px_0px_#000] scale-[1.02]' : 'border-transparent hover:border-black/10 bg-white/50'}`}
                                            >
                                                <div className="mb-4 transform group-hover:rotate-1 transition-transform">{fmt.icon}</div>
                                                <div className="flex justify-between items-start">
                                                    <span className="text-md font-black text-black">
                                                        {fmt.name}
                                                    </span>
                                                    {settings.labelFormat === fmt.id && <IconCheckCircle className="w-6 h-6 text-black" />}
                                                </div>
                                                <p className="text-[11px] font-bold text-gray-500 mt-1 uppercase tracking-tighter">{fmt.desc}</p>
                                                <p className="text-[10px] text-gray-400 mt-0.5">{fmt.size}</p>
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* CONFIGURATION TOGGLES */}
                        {activeTab === 'botones' && (
                            <div className="space-y-6">
                                <h2 className="text-xl font-bold text-[var(--text-primary)] mb-4 border-b border-[var(--border-primary)] pb-3">Botones de Configuración</h2>
                                <div className="space-y-4 division-y divide-[var(--border-primary)]">
                                    <div className="py-3">
                                        <label className="flex items-center justify-between cursor-pointer">
                                            <div>
                                                <h3 className="text-base font-semibold text-[var(--text-secondary)]">Forzar Cierre en App Flex</h3>
                                                <p className="text-xs text-[var(--text-muted)] mt-1 max-w-md">Si está activado, un conductor no podrá marcar como "Entregado" un paquete de Mercado Libre si no lo ha cerrado primero en la app de Flex.</p>
                                            </div>
                                            <div className="relative">
                                                <input
                                                    type="checkbox"
                                                    name="meliFlexValidation"
                                                    checked={settings.meliFlexValidation}
                                                    onChange={handleSettingsChange}
                                                    className="sr-only peer"
                                                />
                                                <div className="w-14 h-8 bg-gray-200 rounded-full peer peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-offset-2 peer-focus:ring-[var(--brand-secondary)] dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-1 after:left-1 after:bg-white after:border-gray-300 after:border after:rounded-full after:h-6 after:w-6 after:transition-all dark:border-gray-600 peer-checked:bg-[var(--brand-primary)]"></div>
                                            </div>
                                        </label>
                                    </div>

                                    <div className="pt-4 border-t border-[var(--border-primary)] py-3">
                                        <label className="flex items-center justify-between cursor-pointer">
                                            <div>
                                                <h3 className="text-base font-semibold text-[var(--text-secondary)]">Auto-abrir Confirmar Entrega en FullEnvíos</h3>
                                                <p className="text-xs text-[var(--text-muted)] mt-1 max-w-md">Si está activado, cuando un paquete se marque como entregado en Mercado Libre, se abrirá automáticamente el modal de Confirmar Entrega en FullEnvíos para que el conductor pueda seleccionar tomar foto con la cámara o subir desde la galería sin tener que buscar el paquete.</p>
                                            </div>
                                            <div className="relative">
                                                <input
                                                    type="checkbox"
                                                    name="meliAutoPromptPhotos"
                                                    checked={settings.meliAutoPromptPhotos}
                                                    onChange={handleSettingsChange}
                                                    className="sr-only peer"
                                                />
                                                <div className="w-14 h-8 bg-gray-200 rounded-full peer peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-offset-2 peer-focus:ring-[var(--brand-secondary)] dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-1 after:left-1 after:bg-white after:border-gray-300 after:border after:rounded-full after:h-6 after:w-6 after:transition-all dark:border-gray-600 peer-checked:bg-[var(--brand-primary)]"></div>
                                            </div>
                                        </label>
                                    </div>

                                    <div className="pt-4 border-t border-[var(--border-primary)] py-3">
                                        <label className="flex items-center justify-between cursor-pointer">
                                            <div>
                                                <h3 className="text-base font-semibold text-[var(--text-secondary)]">Respaldo de Etiqueta Flex</h3>
                                                <p className="text-xs text-[var(--text-muted)] mt-1 max-w-md">Si está activado, el sistema solicitará una foto de la etiqueta (QR) al momento de "Flexear" un paquete para tener un respaldo en caso de daño.</p>
                                            </div>
                                            <div className="relative">
                                                <input
                                                    type="checkbox"
                                                    name="saveFlexLabelPhoto"
                                                    checked={settings.saveFlexLabelPhoto}
                                                    onChange={handleSettingsChange}
                                                    className="sr-only peer"
                                                />
                                                <div className="w-14 h-8 bg-gray-200 rounded-full peer peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-offset-2 peer-focus:ring-[var(--brand-secondary)] dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-1 after:left-1 after:bg-white after:border-gray-300 after:border after:rounded-full after:h-6 after:w-6 after:transition-all dark:border-gray-600 peer-checked:bg-[var(--brand-primary)]"></div>
                                            </div>
                                        </label>
                                    </div>

                                    <div className="pt-4 border-t border-[var(--border-primary)] py-3">
                                        <label className="flex items-center justify-between cursor-pointer">
                                            <div>
                                                <h3 className="text-base font-semibold text-[var(--text-secondary)]">Importación Automática Flex</h3>
                                                <p className="text-xs text-[var(--text-muted)] mt-1 max-w-md">Si está activado, el sistema importará automáticamente los pedidos Flex de Mercado Libre para todos los vendedores configurados (Solo Santiago/RM).</p>
                                            </div>
                                            <div className="relative">
                                                <input
                                                    type="checkbox"
                                                    name="meliAutoImport"
                                                    checked={settings.meliAutoImport}
                                                    onChange={handleSettingsChange}
                                                    className="sr-only peer"
                                                />
                                                <div className="w-14 h-8 bg-gray-200 rounded-full peer peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-offset-2 peer-focus:ring-[var(--brand-secondary)] dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-1 after:left-1 after:bg-white after:border-gray-300 after:border after:rounded-full after:h-6 after:w-6 after:transition-all dark:border-gray-600 peer-checked:bg-[var(--brand-primary)]"></div>
                                            </div>
                                        </label>
                                    </div>

                                    <div className="pt-4 border-t border-[var(--border-primary)] py-3">
                                        <label className="flex items-center justify-between cursor-pointer">
                                            <div>
                                                <h3 className="text-base font-semibold text-[var(--text-secondary)]">Importación Automática Shopify</h3>
                                                <p className="text-xs text-[var(--text-muted)] mt-1 max-w-md">Si está activado, el sistema importará automáticamente los pedidos pagados de Shopify para todos los clientes configurados (Solo Santiago/RM).</p>
                                            </div>
                                            <div className="relative">
                                                <input
                                                    type="checkbox"
                                                    name="shopifyAutoImport"
                                                    checked={settings.shopifyAutoImport}
                                                    onChange={handleSettingsChange}
                                                    className="sr-only peer"
                                                />
                                                <div className="w-14 h-8 bg-gray-200 rounded-full peer peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-offset-2 peer-focus:ring-[var(--brand-secondary)] dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-1 after:left-1 after:bg-white after:border-gray-300 after:border after:rounded-full after:h-6 after:w-6 after:transition-all dark:border-gray-600 peer-checked:bg-[var(--brand-primary)]"></div>
                                            </div>
                                        </label>
                                    </div>

                                    <div className="pt-4 border-t border-[var(--border-primary)] py-3">
                                        <label className="flex items-center justify-between cursor-pointer">
                                            <div>
                                                <h3 className="text-base font-semibold text-[var(--text-secondary)]">Importación Automática WooCommerce</h3>
                                                <p className="text-xs text-[var(--text-muted)] mt-1 max-w-md">Si está activado, el sistema importará automáticamente los pedidos pagados de WooCommerce para todos los clientes configurados (Solo Santiago/RM).</p>
                                            </div>
                                            <div className="relative">
                                                <input
                                                    type="checkbox"
                                                    name="woocommerceAutoImport"
                                                    checked={settings.woocommerceAutoImport}
                                                    onChange={handleSettingsChange}
                                                    className="sr-only peer"
                                                />
                                                <div className="w-14 h-8 bg-gray-200 rounded-full peer peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-offset-2 peer-focus:ring-[var(--brand-secondary)] dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-1 after:left-1 after:bg-white after:border-gray-300 after:border after:rounded-full after:h-6 after:w-6 after:transition-all dark:border-gray-600 peer-checked:bg-[var(--brand-primary)]"></div>
                                            </div>
                                        </label>
                                    </div>

                                    <div className="pt-4 border-t border-[var(--border-primary)] py-3">
                                        <label className="flex items-center justify-between cursor-pointer">
                                            <div>
                                                <h3 className="text-base font-semibold text-[var(--text-secondary)]">Importación Automática Falabella</h3>
                                                <p className="text-xs text-[var(--text-muted)] mt-1 max-w-md">Si está activado, el sistema importará automáticamente los pedidos pendientes/listos para despacho de Falabella Seller Center para todos los clientes configurados (Solo Santiago/RM).</p>
                                            </div>
                                            <div className="relative">
                                                <input
                                                    type="checkbox"
                                                    name="falabellaAutoImport"
                                                    checked={settings.falabellaAutoImport}
                                                    onChange={handleSettingsChange}
                                                    className="sr-only peer"
                                                />
                                                <div className="w-14 h-8 bg-gray-200 rounded-full peer peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-offset-2 peer-focus:ring-[var(--brand-secondary)] dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-1 after:left-1 after:bg-white after:border-gray-300 after:border after:rounded-full after:h-6 after:w-6 after:transition-all dark:border-gray-600 peer-checked:bg-[var(--brand-primary)]"></div>
                                            </div>
                                        </label>
                                    </div>

                                    <div className="pt-4 border-t border-[var(--border-primary)] py-3">
                                        <label className="flex items-center justify-between cursor-pointer">
                                            <div>
                                                <h3 className="text-base font-semibold text-[var(--text-secondary)]">Habilitar Reentrega para Conductores</h3>
                                                <p className="text-xs text-[var(--text-muted)] mt-1 max-w-md">Si está activado, los conductores verán un botón para devolver a "En Tránsito" un paquete que haya sido reportado con "Problema".</p>
                                            </div>
                                            <div className="relative">
                                                <input
                                                    type="checkbox"
                                                    name="allowRedelivery"
                                                    checked={settings.allowRedelivery || false}
                                                    onChange={handleSettingsChange}
                                                    className="sr-only peer"
                                                />
                                                <div className="w-14 h-8 bg-gray-200 rounded-full peer peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-offset-2 peer-focus:ring-[var(--brand-secondary)] dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-1 after:left-1 after:bg-white after:border-gray-300 after:border after:rounded-full after:h-6 after:w-6 after:transition-all dark:border-gray-600 peer-checked:bg-[var(--brand-primary)]"></div>
                                            </div>
                                        </label>
                                    </div>

                                    <div className="pt-4 border-t border-[var(--border-primary)] py-3">
                                        <label className="flex items-center justify-between cursor-pointer">
                                            <div>
                                                <h3 className="text-base font-semibold text-[var(--text-secondary)]">Seguimiento Público para Clientes</h3>
                                                <p className="text-xs text-[var(--text-muted)] mt-1 max-w-md">Si está activado, los clientes finales podrán ver el estado de su pedido a través de un link público sin necesidad de iniciar sesión.</p>
                                            </div>
                                            <div className="relative">
                                                <input
                                                    type="checkbox"
                                                    name="publicTrackingEnabled"
                                                    checked={settings.publicTrackingEnabled}
                                                    onChange={handleSettingsChange}
                                                    className="sr-only peer"
                                                />
                                                <div className="w-14 h-8 bg-gray-200 rounded-full peer peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-offset-2 peer-focus:ring-[var(--brand-secondary)] dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-1 after:left-1 after:bg-white after:border-gray-300 after:border after:rounded-full after:h-6 after:w-6 after:transition-all dark:border-gray-600 peer-checked:bg-[var(--brand-primary)]"></div>
                                            </div>
                                        </label>
                                    </div>

                                    <div className="pt-4 border-t border-[var(--border-primary)] py-3">
                                        <label className="flex items-center justify-between cursor-pointer">
                                            <div>
                                                <h3 className="text-base font-semibold text-[var(--text-secondary)]">Notificaciones al Destinatario (Email)</h3>
                                                <p className="text-xs text-[var(--text-muted)] mt-1 max-w-md">Si está activado, se enviarán correos automáticos al destinatario sobre la creación del envío y actualizaciones de entrega (ej. "En Camino", "Entregado").</p>
                                            </div>
                                            <div className="relative">
                                                <input
                                                    type="checkbox"
                                                    name="recipientNotificationsEnabled"
                                                    checked={settings.recipientNotificationsEnabled ?? false}
                                                    onChange={handleSettingsChange}
                                                    className="sr-only peer"
                                                />
                                                <div className="w-14 h-8 bg-gray-200 rounded-full peer peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-offset-2 peer-focus:ring-[var(--brand-secondary)] dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-1 after:left-1 after:bg-white after:border-gray-300 after:border after:rounded-full after:h-6 after:w-6 after:transition-all dark:border-gray-600 peer-checked:bg-[var(--brand-primary)]"></div>
                                            </div>
                                        </label>
                                    </div>

                                    <div className="pt-4 border-t border-[var(--border-primary)] py-3">
                                        <label className="flex items-center justify-between cursor-pointer">
                                            <div>
                                                <h3 className="text-base font-semibold text-[var(--text-secondary)]">RUT Obligatorio en Entrega</h3>
                                                <p className="text-xs text-[var(--text-muted)] mt-1 max-w-md">Si está activado, el conductor DEBE ingresar el RUT de quien recibe el paquete para confirmar la entrega.</p>
                                            </div>
                                            <div className="relative">
                                                <input
                                                    type="checkbox"
                                                    name="isRutRequired"
                                                    checked={settings.isRutRequired}
                                                    onChange={handleSettingsChange}
                                                    className="sr-only peer"
                                                />
                                                <div className="w-14 h-8 bg-gray-200 rounded-full peer peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-offset-2 peer-focus:ring-[var(--brand-secondary)] dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-1 after:left-1 after:bg-white after:border-gray-300 after:border after:rounded-full after:h-6 after:w-6 after:transition-all dark:border-gray-600 peer-checked:bg-[var(--brand-primary)]"></div>
                                            </div>
                                        </label>
                                    </div>

                                    {isSuperUser && (
                                        <div className="pt-4 border-t border-indigo-200 bg-indigo-50/40 p-4 rounded-xl dark:bg-indigo-950/20 my-3">
                                            <label className="flex items-center justify-between cursor-pointer">
                                                <div>
                                                    <div className="flex items-center gap-2">
                                                        <h3 className="text-base font-bold text-indigo-900 dark:text-indigo-300">Control de Flotas & Cierres (Informes Operativos)</h3>
                                                        <span className="px-2 py-0.5 text-[9px] font-black bg-indigo-600 text-white rounded-full uppercase tracking-wider">Superadmin Exclusivo</span>
                                                    </div>
                                                    <p className="text-xs text-indigo-700 dark:text-indigo-400 mt-1 max-w-md">Habilita o deshabilita la visibilidad de la opción "Control de Flotas & Cierres" dentro del menú de Informes Operativos para todos los Administradores del sistema.</p>
                                                </div>
                                                <div className="relative">
                                                    <input
                                                        type="checkbox"
                                                        name="fleetControlEnabled"
                                                        checked={settings.fleetControlEnabled ?? true}
                                                        onChange={handleSettingsChange}
                                                        className="sr-only peer"
                                                    />
                                                    <div className="w-14 h-8 bg-gray-200 rounded-full peer peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-offset-2 peer-focus:ring-indigo-500 dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-1 after:left-1 after:bg-white after:border-gray-300 after:border after:rounded-full after:h-6 after:w-6 after:transition-all dark:border-gray-600 peer-checked:bg-indigo-600"></div>
                                                </div>
                                            </label>
                                        </div>
                                    )}

                                    {auth?.user?.role === Role.Admin && (
                                        <div className="pt-4 border-t border-[var(--border-primary)] py-3">
                                            <label className="flex items-center justify-between cursor-pointer">
                                                <div>
                                                    <h3 className="text-base font-semibold text-[var(--text-secondary)]">Reporte de Discrepancias Flex</h3>
                                                    <p className="text-xs text-[var(--text-muted)] mt-1 max-w-md">Si está activado, los administradores y operadores podrán ver el reporte de paquetes asignados pero no escaneados en bodega.</p>
                                                </div>
                                                <div className="relative">
                                                    <input
                                                        type="checkbox"
                                                        name="flexDiscrepancyReportEnabled"
                                                        checked={settings.flexDiscrepancyReportEnabled}
                                                        onChange={handleSettingsChange}
                                                        className="sr-only peer"
                                                    />
                                                    <div className="w-14 h-8 bg-gray-200 rounded-full peer peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-offset-2 peer-focus:ring-[var(--brand-secondary)] dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-1 after:left-1 after:bg-white after:border-gray-300 after:border after:rounded-full after:h-6 after:w-6 after:transition-all dark:border-gray-600 peer-checked:bg-[var(--brand-primary)]"></div>
                                                </div>
                                            </label>
                                        </div>
                                    )}

                                    <div className="pt-4 border-t border-[var(--border-primary)] py-3">
                                        <label className="flex items-center justify-between cursor-pointer">
                                            <div>
                                                <h3 className="text-base font-semibold text-[var(--text-secondary)]">Habilitar Selección Múltiple y Cierre Masivo para Conductores</h3>
                                                <p className="text-xs text-[var(--text-muted)] mt-1 max-w-md">Si está activado, los conductores podrán seleccionar y agrupar la entrega conjunta de múltiples paquetes que compartan el mismo destinatario y dirección. Si está desactivado, el conductor solo podrá confirmar entregas paquete por paquete.</p>
                                            </div>
                                            <div className="relative">
                                                <input
                                                    type="checkbox"
                                                    name="multiSelectEnabled"
                                                    checked={settings.multiSelectEnabled}
                                                    onChange={handleSettingsChange}
                                                    className="sr-only peer"
                                                />
                                                <div className="w-14 h-8 bg-gray-200 rounded-full peer peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-offset-2 peer-focus:ring-[var(--brand-secondary)] dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-1 after:left-1 after:bg-white after:border-gray-300 after:border after:rounded-full after:h-6 after:w-6 after:transition-all dark:border-gray-600 peer-checked:bg-[var(--brand-primary)]"></div>
                                            </div>
                                        </label>
                                    </div>

                                    <div className="pt-4 border-t border-[var(--border-primary)] py-3">
                                        <label className="flex items-center justify-between cursor-pointer p-3 bg-violet-50/50 dark:bg-violet-950/20 rounded-xl border border-violet-200/50">
                                            <div>
                                                <h3 className="text-base font-bold text-[var(--text-primary)] flex items-center gap-2">
                                                    🗺️ Habilitar Sectores GIS (Polígonos y Zonificación)
                                                </h3>
                                                <p className="text-xs text-[var(--text-muted)] mt-1 max-w-md">Si está activado, habilita el editor y dibujo de sectores GIS en el mapa por comunas y activa el módulo de Zonificación para los conductores.</p>
                                            </div>
                                            <div className="relative">
                                                <input
                                                    type="checkbox"
                                                    name="gisSectorsEnabled"
                                                    checked={settings.gisSectorsEnabled}
                                                    onChange={handleSettingsChange}
                                                    className="sr-only peer"
                                                />
                                                <div className="w-14 h-8 bg-gray-200 rounded-full peer peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-offset-2 peer-focus:ring-[var(--brand-secondary)] dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-1 after:left-1 after:bg-white after:border-gray-300 after:border after:rounded-full after:h-6 after:w-6 after:transition-all dark:border-gray-600 peer-checked:bg-[var(--brand-primary)]"></div>
                                            </div>
                                        </label>
                                    </div>

                                    {auth?.user?.email === 'admin' && (
                                        <div className="pt-4 border-t border-[var(--border-primary)] py-3">
                                            <label className="flex items-center justify-between cursor-pointer">
                                                <div>
                                                    <h3 className="text-base font-semibold text-[var(--text-secondary)]">Alertar Pagos Pendientes a Administradores</h3>
                                                    <p className="text-xs text-[var(--text-muted)] mt-1 max-w-md">Si está activado, los administradores verán una alerta temporal sobre pagos pendientes al ingresar a la plataforma.</p>
                                                </div>
                                                <div className="relative">
                                                    <input
                                                        type="checkbox"
                                                        name="showPendingPaymentAlert"
                                                        checked={settings.showPendingPaymentAlert || false}
                                                        onChange={handleSettingsChange}
                                                        className="sr-only peer"
                                                    />
                                                    <div className="w-14 h-8 bg-gray-200 rounded-full peer peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-offset-2 peer-focus:ring-[var(--brand-secondary)] dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-1 after:left-1 after:bg-white after:border-gray-300 after:border after:rounded-full after:h-6 after:w-6 after:transition-all dark:border-gray-600 peer-checked:bg-[var(--brand-primary)]"></div>
                                                </div>
                                            </label>
                                        </div>
                                    )}

                                    <div className="pt-4 border-t border-[var(--border-primary)] py-3">
                                        <label className="flex items-center justify-between cursor-pointer">
                                            <div>
                                                <h3 className="text-base font-semibold text-[var(--text-secondary)]">Exportación a Circuit Route Planner</h3>
                                                <p className="text-xs text-[var(--text-muted)] mt-1 max-w-md">Habilita el botón de exportación de rutas para conductores. Esto genera un archivo CSV compatible con Circuit.</p>
                                            </div>
                                            <div className="relative">
                                                <input
                                                    type="checkbox"
                                                    name="circuitExportEnabled"
                                                    checked={settings.circuitExportEnabled}
                                                    onChange={handleSettingsChange}
                                                    className="sr-only peer"
                                                />
                                                <div className="w-14 h-8 bg-gray-200 rounded-full peer peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-offset-2 peer-focus:ring-[var(--brand-secondary)] dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-1 after:left-1 after:bg-white after:border-gray-300 after:border after:rounded-full after:h-6 after:w-6 after:transition-all dark:border-gray-600 peer-checked:bg-[var(--brand-primary)]"></div>
                                            </div>
                                        </label>
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* PICKUP MODE */}
                        {activeTab === 'retiro' && (
                            <div className="space-y-6">
                                <h2 className="text-xl font-bold text-[var(--text-primary)] mb-4 border-b border-[var(--border-primary)] pb-3">Modo Retiro</h2>
                                <p className="text-xs text-[var(--text-muted)] mt-1 mb-3">Define el procedimiento que deben seguir los conductores al retirar.</p>
                                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                                   {(Object.values(PickupMode) as PickupMode[]).map(mode => (
                                        <button
                                            key={mode}
                                            type="button"
                                            onClick={() => handlePickupModeChange(mode)}
                                            className={`p-4 border rounded-lg text-center relative transition-all ${settings.pickupMode === mode ? 'border-[var(--brand-primary)] ring-2 ring-[var(--brand-primary)] bg-[var(--brand-muted)]' : 'border-[var(--border-secondary)] hover:border-[var(--brand-secondary)]'}`}
                                        >
                                            {pickupModeConfig[mode].icon}
                                            <span className="font-semibold text-sm text-[var(--text-primary)]">{pickupModeConfig[mode].name}</span>
                                            <p className="text-xs text-[var(--text-muted)] mt-1">{pickupModeConfig[mode].description}</p>
                                            {settings.pickupMode === mode && (
                                                <div className="absolute -top-2 -right-2 bg-[var(--brand-primary)] text-white rounded-full p-0.5">
                                                    <IconCheckCircle className="w-4 h-4" />
                                                </div>
                                            )}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* MESSAGING PLAN */}
                        {activeTab === 'mensajeria' && (
                            <div className="space-y-6">
                                <h2 className="text-xl font-bold text-[var(--text-primary)] mb-4 border-b border-[var(--border-primary)] pb-3">Plan de Mensajería</h2>
                                <p className="text-xs text-[var(--text-muted)] mt-1 mb-3">Selecciona el plan de notificaciones que regirá para toda la operación.</p>
                                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                                    {(Object.values(MessagingPlan) as MessagingPlan[]).map(plan => (
                                        <button
                                            key={plan}
                                            type="button"
                                            onClick={() => handlePlanChange(plan)}
                                            className={`p-4 border rounded-lg text-center relative transition-all ${settings.messagingPlan === plan ? 'border-[var(--brand-primary)] ring-2 ring-[var(--brand-primary)] bg-[var(--brand-muted)]' : 'border-[var(--border-secondary)] hover:border-[var(--brand-secondary)]'}`}
                                        >
                                            {plan === MessagingPlan.Email && <IconMail className="w-6 h-6 mx-auto mb-2 text-blue-500" />}
                                            {plan === MessagingPlan.WhatsApp && <IconWhatsapp className="w-6 h-6 mx-auto mb-2 text-green-500" />}
                                            {plan === MessagingPlan.None && <div className="w-6 h-6 mx-auto mb-2 border-2 border-dashed border-gray-300 rounded-full"></div>}
                                            <span className="font-semibold text-sm text-[var(--text-primary)]">{messagingPlanConfig[plan].name}</span>
                                            <p className="text-xs text-[var(--text-muted)] mt-1">{messagingPlanConfig[plan].description}</p>
                                            {settings.messagingPlan === plan && (
                                                <div className="absolute -top-2 -right-2 bg-[var(--brand-primary)] text-white rounded-full p-0.5">
                                                    <IconCheckCircle className="w-4 h-4" />
                                                </div>
                                            )}
                                        </button>
                                    ))}
                                </div>

                                <div className="pt-6 border-t border-[var(--border-primary)] space-y-4">
                                    <h3 className="text-base font-bold text-[var(--text-primary)]">Notificaciones de Pendientes al Administrador</h3>
                                    
                                    <div className="flex items-center justify-between cursor-pointer py-2">
                                        <div>
                                            <h4 className="text-sm font-semibold text-[var(--text-secondary)]">Habilitar Mensajes a Administrador</h4>
                                            <p className="text-xs text-[var(--text-muted)] max-w-md">Enviar una notificación automática vía WhatsApp al administrador cada vez que una entrega quede pendiente.</p>
                                        </div>
                                        <label className="relative inline-flex items-center cursor-pointer select-none">
                                            <input 
                                                type="checkbox" 
                                                className="sr-only peer" 
                                                checked={settings.pendingNotificationsEnabled}
                                                onChange={(e) => setSettings(prev => ({ ...prev, pendingNotificationsEnabled: e.target.checked }))}
                                            />
                                            <div className="w-14 h-8 bg-gray-200 rounded-full peer peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-offset-2 peer-focus:ring-[var(--brand-secondary)] dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-1 after:left-1 after:bg-white after:border-gray-300 after:border after:rounded-full after:h-6 after:w-6 after:transition-all dark:border-gray-600 peer-checked:bg-[var(--brand-primary)]"></div>
                                        </label>
                                    </div>

                                    {settings.pendingNotificationsEnabled && (
                                        <div className="space-y-4 animate-fade-in">
                                            <div className="space-y-2">
                                                <label className="block text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider">Número de WhatsApp del Administrador</label>
                                                <input
                                                    type="text"
                                                    name="adminWhatsappNumber"
                                                    value={settings.adminWhatsappNumber}
                                                    onChange={(e) => setSettings(prev => ({ ...prev, adminWhatsappNumber: e.target.value }))}
                                                    placeholder="Ej: +56912345678"
                                                    className="w-full max-w-md px-3 py-2 border border-[var(--border-secondary)] rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-secondary)] bg-[var(--background-secondary)] text-[var(--text-primary)] text-sm"
                                                />
                                                <p className="text-[11px] text-[var(--text-muted)]">Ingresa el número con el código de país (ej. +569...)</p>
                                            </div>

                                            <div className="space-y-2 pt-2">
                                                <label className="block text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider">API Key de CallMeBot del Administrador</label>
                                                <div className="flex gap-2 max-w-md">
                                                    <input
                                                        type="text"
                                                        name="adminCallmebotApiKey"
                                                        value={settings.adminCallmebotApiKey}
                                                        onChange={(e) => setSettings(prev => ({ ...prev, adminCallmebotApiKey: e.target.value }))}
                                                        placeholder="Ingresa tu apikey de CallMeBot"
                                                        className="flex-1 px-3 py-2 border border-[var(--border-secondary)] rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-secondary)] bg-[var(--background-secondary)] text-[var(--text-primary)] text-sm"
                                                    />
                                                    <button
                                                        type="button"
                                                        onClick={handleTestWhatsapp}
                                                        disabled={isTestingWhatsapp || !settings.adminWhatsappNumber || !settings.adminCallmebotApiKey}
                                                        className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-md text-sm font-semibold transition-colors disabled:opacity-50 flex items-center gap-1.5"
                                                    >
                                                        {isTestingWhatsapp ? 'Probando...' : 'Probar'}
                                                    </button>
                                                </div>
                                                <p className="text-[11px] text-[var(--text-muted)]">
                                                    Para obtener tu API Key gratuita, envía un mensaje de WhatsApp a <strong>+34 644 20 23 66</strong> (número oficial de CallMeBot) indicando: <code>I allow callmebot to send me messages</code>
                                                </p>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </div>
                        )}

                        {/* SUBMIT BUTTON */}
                        <div className="flex justify-end pt-4 border-t border-[var(--border-primary)]">
                            <button 
                                type="submit" 
                                disabled={!hasChanges}
                                title={!hasChanges ? "No hay cambios pendientes" : "Guardar configuración"}
                                className="px-6 py-2 text-sm font-bold text-[var(--text-on-brand)] bg-[var(--brand-primary)] border border-transparent rounded-md shadow-sm hover:bg-[var(--brand-secondary)] disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200"
                            >
                                {hasChanges ? 'Guardar Cambios' : 'Sin Cambios'}
                            </button>
                        </div>
                    </form>
                </div>
            )}

            {/* COMMUNE MANAGEMENT TAB */}
            {activeTab === 'comunas' && auth?.user?.role === Role.Admin && (
                <CommuneManagement />
            )}

            {/* APPEARANCE / THEME TAB */}
            {activeTab === 'apariencia' && (
                <div className="bg-[var(--background-secondary)] shadow-md rounded-lg p-6">
                    <h2 className="text-xl font-bold text-[var(--text-primary)] mb-4 border-b border-[var(--border-primary)] pb-3">Apariencia</h2>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                        <ThemeButton name="default" label="Default" colors={['#f8fafc', '#4f46e5', '#16a34a']} />
                        <ThemeButton name="light" label="Claro" colors={['#f8fafc', '#2563eb', '#166534']} />
                        <ThemeButton name="dark" label="Oscuro" colors={['#0f172a', '#60a5fa', '#bbf7d0']} />
                        <ThemeButton name="corporate" label="Corporativo" colors={['#f4f6f9', '#007bff', '#155724']} />
                        <ThemeButton name="ocean" label="Océano" colors={['#f0f9ff', '#0891b2', '#134e63']} />
                        <ThemeButton name="nature" label="Naturaleza" colors={['#fefce8', '#65a30d', '#166534']} />
                        <ThemeButton name="midnight" label="Medianoche" colors={['#111827', '#8b5cf6', '#6ee7b7']} />
                    </div>
                </div>
            )}

            {/* SECURITY & DATA MAINTENANCE TAB */}
            {activeTab === 'seguridad' && auth?.user?.email === 'admin' && (
                <div className="space-y-8">
                    {/* Maintenance Mode */}
                    <div className="bg-[var(--background-secondary)] shadow-md rounded-lg p-6">
                        <h2 className="text-xl font-bold text-[var(--text-primary)] mb-4 border-b border-[var(--border-primary)] pb-3">Estado de la Aplicación y Funciones</h2>
                        <div className="space-y-6">
                            <div className="flex items-center justify-between">
                                <div className="pr-4">
                                    <p className="font-bold text-[var(--text-primary)] flex items-center gap-2">
                                        <IconAlertTriangle className="w-5 h-5 text-amber-500" />
                                        Mantenimiento de la Aplicación
                                    </p>
                                    <p className="text-xs text-[var(--text-muted)] mt-1">
                                        {settings.isAppEnabled
                                            ? 'La aplicación está actualmente en línea y operativa para todos los usuarios.'
                                            : 'La aplicación está en modo mantenimiento. Solo el administrador puede iniciar sesión.'}
                                    </p>
                                </div>
                                <button
                                    onClick={handleAppStatusToggle}
                                    className={`px-4 py-2 text-xs font-black uppercase tracking-widest rounded-lg shadow-sm text-white transition-all ${
                                        settings.isAppEnabled ? 'bg-red-600 hover:bg-red-700' : 'bg-emerald-600 hover:bg-emerald-700'
                                    }`}
                                >
                                    {settings.isAppEnabled ? 'DESHABILITAR APP' : 'HABILITAR APP'}
                                </button>
                            </div>
                        </div>
                    </div>

                    {/* Change Password */}
                    <div className="bg-[var(--background-secondary)] shadow-md rounded-lg p-6">
                        <h2 className="text-xl font-bold text-[var(--text-primary)] mb-4 border-b border-[var(--border-primary)] pb-3">Seguridad (Superusuario)</h2>
                        <form onSubmit={handlePasswordSubmit} className="space-y-4">
                            <div>
                                <label htmlFor="newPassword" classname="block text-sm font-medium text-[var(--text-secondary)] mb-1">Nueva Contraseña</label>
                                <div className="relative">
                                    <input
                                        type={showPassword ? 'text' : 'password'}
                                        id="newPassword"
                                        value={password}
                                        onChange={(e) => setPassword(e.target.value)}
                                        required
                                        className={`${inputClasses} pr-10 text-[var(--text-primary)]`}
                                        placeholder="Mínimo 6 caracteres"
                                    />
                                    <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute inset-y-0 right-0 pr-3 flex items-center" aria-label={showPassword ? "Ocultar contraseña" : "Mostrar contraseña"}>
                                        {showPassword ? <IconEyeOff className="h-5 w-5 text-[var(--text-muted)]" /> : <IconEye className="h-5 w-5 text-[var(--text-muted)]" />}
                                    </button>
                                </div>
                            </div>
                            <div>
                                <label htmlFor="confirmPassword" className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Confirmar Nueva Contraseña</label>
                                <div className="relative">
                                <input
                                    type={showConfirmPassword ? 'text' : 'password'}
                                    id="confirmPassword"
                                    value={confirmPassword}
                                    onChange={(e) => setConfirmPassword(e.target.value)}
                                    required
                                    className={`${inputClasses} pr-10 text-[var(--text-primary)]`}
                                />
                                <button type="button" onClick={() => setShowConfirmPassword(!showConfirmPassword)} className="absolute inset-y-0 right-0 pr-3 flex items-center" aria-label={showConfirmPassword ? "Ocultar contraseña" : "Mostrar contraseña"}>
                                    {showConfirmPassword ? <IconEyeOff className="h-5 w-5 text-[var(--text-muted)]" /> : <IconEye className="h-5 w-5 text-[var(--text-muted)]" />}
                                </button>
                                </div>
                            </div>
                            <div className="flex justify-end">
                                <button type="submit" className="px-4 py-2 text-sm font-medium text-[var(--text-on-brand)] bg-[var(--brand-primary)] border border-transparent rounded-md shadow-sm hover:bg-[var(--brand-secondary)]">
                                    Cambiar Contraseña
                                </button>
                            </div>
                        </form>
                    </div>

                    {/* Danger Zone */}
                    <div className="bg-[var(--background-secondary)] shadow-md rounded-lg p-6 border-2 border-red-500">
                        <h2 className="text-xl font-bold text-red-600 mb-4 flex items-center gap-2">
                            <IconTrash className="w-6 h-6"/>
                            Zona de Peligro - Reinicio de Datos
                        </h2>
                        
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
                            <div className="p-4 border border-[var(--border-primary)] rounded-lg hover:bg-red-50 dark:hover:bg-red-900/10 transition-colors">
                                <h3 className="font-bold text-[var(--text-primary)] mb-1">Paquetes e Historial</h3>
                                <p className="text-xs text-[var(--text-muted)] mb-3">Elimina todos los paquetes y eventos de seguimiento.</p>
                                <button onClick={() => openResetModal('packages')} className="text-xs font-bold text-red-600 hover:underline">BORRAR PAQUETES</button>
                            </div>
                            
                            <div className="p-4 border border-[var(--border-primary)] rounded-lg hover:bg-red-50 dark:hover:bg-red-900/10 transition-colors">
                                <h3 className="font-bold text-[var(--text-primary)] mb-1">Clientes</h3>
                                <p className="text-xs text-[var(--text-muted)] mb-3">Elimina todos los usuarios con rol de Cliente.</p>
                                <button onClick={() => openResetModal('clients')} className="text-xs font-bold text-red-600 hover:underline">BORRAR CLIENTES</button>
                            </div>
                            
                            <div className="p-4 border border-[var(--border-primary)] rounded-lg hover:bg-red-50 dark:hover:bg-red-900/10 transition-colors">
                                <h3 className="font-bold text-[var(--text-primary)] mb-1">Conductores y Auxiliares</h3>
                                <p className="text-xs text-[var(--text-muted)] mb-3">Elimina conductores, auxiliares y rutas de retiro.</p>
                                <button onClick={() => openResetModal('drivers')} className="text-xs font-bold text-red-600 hover:underline">BORRAR CONDUCTORES</button>
                            </div>
                            
                            <div className="p-4 border border-[var(--border-primary)] rounded-lg hover:bg-red-50 dark:hover:bg-red-900/10 transition-colors">
                                <h3 className="font-bold text-[var(--text-primary)] mb-1">Zonas de Entrega</h3>
                                <p className="text-xs text-[var(--text-muted)] mb-3">Elimina todas las zonas configuradas.</p>
                                <button onClick={() => openResetModal('zones')} className="text-xs font-bold text-red-600 hover:underline">BORRAR ZONAS</button>
                            </div>

                            <div className="p-4 border border-[var(--border-primary)] rounded-lg hover:bg-red-50 dark:hover:bg-red-900/10 transition-colors">
                                <h3 className="font-bold text-[var(--text-primary)] mb-1">Facturación</h3>
                                <p className="text-xs text-[var(--text-muted)] mb-3">Reinicia el historial de facturas de los clientes.</p>
                                <button onClick={() => openResetModal('invoices')} className="text-xs font-bold text-red-600 hover:underline">REINICIAR FACTURACIÓN</button>
                            </div>
                        </div>

                        <div className="bg-blue-50 border-l-4 border-blue-500 p-5 rounded-r-xl mb-6 shadow-sm dark:bg-blue-900/30">
                            <div className="flex items-start">
                                <IconAlertTriangle className="w-6 h-6 text-blue-600 mr-3 flex-shrink-0 mt-0.5" />
                                <p className="text-base text-blue-900 dark:text-blue-100 leading-relaxed font-bold">
                                    <strong className="text-blue-700 dark:text-blue-400 font-black">Borrado Total:</strong> Restablecerá la aplicación a su estado inicial, eliminando <span className="underline">TODOS</span> los datos transaccionales y usuarios (excepto el administrador).
                                </p>
                            </div>
                        </div>
                        <div className="flex justify-end">
                            <button
                                onClick={() => openResetModal('all')}
                                className="px-4 py-2 text-sm font-bold text-white bg-red-600 border border-transparent rounded-md shadow-sm hover:bg-red-700 transition-colors"
                            >
                                Borrado Total del Sistema
                            </button>
                        </div>
                    </div>
                </div>
            )}
            
            {isDeleteDbModalOpen && (
                <DeleteDatabaseModal
                    onClose={() => setIsDeleteDbModalOpen(false)}
                    onConfirm={handleResetDatabase}
                    type={resetType}
                />
            )}
        </div>
    );
};

export default SettingsPage;