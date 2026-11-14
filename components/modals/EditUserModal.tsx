
import React, { useState, useEffect } from 'react';
import { IconX, IconEye, IconEyeOff, IconTruck, IconPencil, IconTrash, IconPlus, IconMercadoLibre, IconLoader, IconCheckCircle, IconShopify, IconWoocommerce, IconFalabella, IconPlugConnected, IconAlertTriangle, IconJumpseller } from '../Icon';
import type { User, Vehicle, UserPricing, IntegrationSettings, OperatorPermissions } from '../../types';
import OperatorPermissionsForm from './OperatorPermissionsForm';
import { Role } from '../../constants';
import { UserUpdateData, api } from '../../services/api';

interface EditUserModalProps {
  user: User;
  onClose: () => void;
  onUpdate: (userId: string, data: UserUpdateData) => void;
  currentUserRole?: Role;
  isSuperUser?: boolean;
}

const validateRut = (rutCompleto: string): boolean => {
    if (!rutCompleto) return true; // Allow empty
    rutCompleto = rutCompleto.replace(/\./g, '').replace('-', '');
    if (!/^[0-9]+[0-9kK]{1}$/.test(rutCompleto)) return false;
    const rut = rutCompleto.slice(0, -1);
    const dv = rutCompleto.slice(-1).toUpperCase();
    let suma = 0;
    let multiplo = 2;
    for (let i = rut.length - 1; i >= 0; i--) {
        suma += parseInt(rut.charAt(i), 10) * multiplo;
        multiplo = multiplo < 7 ? multiplo + 1 : 2;
    }
    const dvEsperado = 11 - (suma % 11);
    const dvCalculado = (dvEsperado === 11) ? '0' : (dvEsperado === 10) ? 'K' : dvEsperado.toString();
    return dv === dvCalculado;
};

const formatRut = (value: string): string => {
  if (!value) return '';
  const cleanRut = value.replace(/[^0-9kK]/g, '').toUpperCase();
  if (cleanRut.length < 2) return cleanRut;

  const dv = cleanRut.slice(-1);
  const body = cleanRut.slice(0, -1);
  
  const bodyFormatted = body.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  
  return `${bodyFormatted}-${dv}`;
};

const VehicleForm: React.FC<{
    vehicle: Partial<Vehicle>;
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
    onSave: () => void;
    onCancel: () => void;
}> = ({ vehicle, onChange, onSave, onCancel }) => {
    const inputClasses = "w-full px-3 py-2 border border-[var(--border-secondary)] rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-secondary)] bg-[var(--background-secondary)] text-[var(--text-primary)]";
    return (
      <div className="p-4 bg-[var(--background-muted)] rounded-lg mt-4 space-y-4">
        <h5 className="font-semibold text-[var(--text-primary)]">{vehicle.id ? 'Editando Vehículo' : 'Nuevo Vehículo'}</h5>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <input name="plate" value={vehicle.plate || ''} onChange={onChange} placeholder="Patente (Ej: ABCD12)" required className={`${inputClasses} uppercase`}/>
            <input name="brand" value={vehicle.brand || ''} onChange={onChange} placeholder="Marca" required className={inputClasses}/>
            <input name="model" value={vehicle.model || ''} onChange={onChange} placeholder="Modelo" required className={inputClasses}/>
            <input name="year" value={vehicle.year || ''} onChange={onChange} type="number" placeholder="Año" required className={inputClasses}/>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
                <label className="text-xs text-[var(--text-muted)]">Venc. Revisión Técnica</label>
                <input name="technicalReviewExpiry" value={vehicle.technicalReviewExpiry || ''} onChange={onChange} type="date" className={inputClasses}/>
            </div>
            <div>
                <label className="text-xs text-[var(--text-muted)]">Venc. Permiso Circulación</label>
                <input name="circulationPermitExpiry" value={vehicle.circulationPermitExpiry || ''} onChange={onChange} type="date" className={inputClasses}/>
            </div>
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="px-3 py-1 text-sm bg-[var(--background-secondary)] border rounded-md">Cancelar</button>
          <button type="button" onClick={onSave} className="px-3 py-1 text-sm bg-[var(--brand-primary)] text-white rounded-md">Guardar Vehículo</button>
        </div>
      </div>
    );
};

type ConnectionSource = 'meli' | 'woocommerce';

const EditUserModal: React.FC<EditUserModalProps> = ({ user, onClose, onUpdate, currentUserRole, isSuperUser = false }) => {
    const [formData, setFormData] = useState<Partial<User>>({});
    const [integrationSettings, setIntegrationSettings] = useState<Partial<IntegrationSettings>>({});
    const [isLoadingSettings, setIsLoadingSettings] = useState(true);
    
    // Client specific shopify fields
    const [clientShopifyUrl, setClientShopifyUrl] = useState('');
    const [clientShopifyToken, setClientShopifyToken] = useState('');
    const [showShopifyToken, setShowShopifyToken] = useState(false);

    // Client specific WooCommerce fields
    const [clientWooUrl, setClientWooUrl] = useState('');
    const [clientWooKey, setClientWooKey] = useState('');
    const [clientWooSecret, setClientWooSecret] = useState('');
    const [showWooSecret, setShowWooSecret] = useState(false);

    // Client specific Falabella fields
    const [clientFalabellaSellerId, setClientFalabellaSellerId] = useState('');
    const [clientFalabellaApiKey, setClientFalabellaApiKey] = useState('');
    const [showFalabellaApiKey, setShowFalabellaApiKey] = useState(false);

    // Client specific Jumpseller fields
    const [clientJumpsellerLogin, setClientJumpsellerLogin] = useState('');
    const [clientJumpsellerToken, setClientJumpsellerToken] = useState('');
    const [showJumpsellerToken, setShowJumpsellerToken] = useState(false);
    
    const [password, setPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    
    const [useSameAddress, setUseSameAddress] = useState(true);
    const [editingVehicle, setEditingVehicle] = useState<(Partial<Vehicle> & { index?: number }) | null>(null);
    const [error, setError] = useState('');
    const [showPassword, setShowPassword] = useState(false);
    const [showConfirmPassword, setShowConfirmPassword] = useState(false);
    const [isSubmitting, setIsSubmitting] = useState(false);
    
    // Test States for Admin Editing
    const [isTestingShopify, setIsTestingShopify] = useState(false);
    const [shopifyTestResult, setShopifyTestResult] = useState<{ type: 'success' | 'error', message: string } | null>(null);
    const [isTestingWoo, setIsTestingWoo] = useState(false);
    const [wooTestResult, setWooTestResult] = useState<{ type: 'success' | 'error', message: string } | null>(null);
    const [isTestingJumpseller, setIsTestingJumpseller] = useState(false);
    const [jumpsellerTestResult, setJumpsellerTestResult] = useState<{ type: 'success' | 'error', message: string } | null>(null);


    const passwordRequirements = [
        { label: "Mínimo 8 caracteres", test: (p: string) => p.length >= 8 },
        { label: "Al menos una mayúscula", test: (p: string) => /[A-Z]/.test(p) },
        { label: "Al menos una minúscula", test: (p: string) => /[a-z]/.test(p) },
        { label: "Al menos un número", test: (p: string) => /[0-9]/.test(p) },
    ];

    const isPasswordValid = !password || passwordRequirements.every(req => req.test(password));

    useEffect(() => {
        if (user) {
            setFormData({
                name: user.name || '',
                email: user.email || '',
                phone: user.phone || '',
                personalRut: user.personalRut || '',
                hasCompany: user.hasCompany || false,
                companyName: user.companyName || '',
                companyRut: user.companyRut || '',
                companyAddress: user.companyAddress || '',
                licenseExpiry: user.licenseExpiry || '',
                licenseType: user.licenseType || '',
                backgroundCheckNotes: user.backgroundCheckNotes || '',
                vehicles: user.vehicles || [],
                rut: user.rut || '',
                address: user.address || '',
                pickupAddress: user.pickupAddress || '',
                storesInfo: user.storesInfo || '',
                billingName: user.billingName || user.name || '',
                billingRut: user.billingRut || user.rut || '',
                billingAddress: user.billingAddress || user.address || '',
                billingCommune: user.billingCommune || '',
                billingGiro: user.billingGiro || '',
                pickupCost: user.pickupCost || 0,
                integrations: user.integrations,
                pricing: user.pricing || { sameDay: 0, express: 0, nextDay: 0 },
                operatorPermissions: user.operatorPermissions || {
                    canManageDrivers: true,
                    canManageClients: true,
                    canManagePackages: true,
                    canDeletePackages: false,
                    canManageZones: false,
                    canManageSettings: false,
                    canManageIntegrations: false,
                    canViewReports: true,
                    canBulkActions: true,
                }
            });
            setUseSameAddress(!user.pickupAddress || user.address === user.pickupAddress);
            
            if (user.integrations?.shopify) {
                setClientShopifyUrl(user.integrations.shopify.shopUrl || '');
                setClientShopifyToken(user.integrations.shopify.accessToken || '');
            }
            if (user.integrations?.woocommerce) {
                setClientWooUrl(user.integrations.woocommerce.storeUrl || '');
                setClientWooKey(user.integrations.woocommerce.consumerKey || '');
                setClientWooSecret(user.integrations.woocommerce.consumerSecret || '');
            }
            if (user.integrations?.falabella) {
                setClientFalabellaSellerId(user.integrations.falabella.sellerId || '');
                setClientFalabellaApiKey(user.integrations.falabella.apiKey || '');
            }
            if (user.integrations?.jumpseller) {
                setClientJumpsellerLogin(user.integrations.jumpseller.login || '');
                setClientJumpsellerToken(user.integrations.jumpseller.token || '');
            }
        }
        
        const fetchSettings = async () => {
            if (user.role === Role.Client) {
                setIsLoadingSettings(true);
                try {
                    const settings = await api.getIntegrationSettings();
                    setIntegrationSettings(settings);
                } catch (err) {
                    console.error("Failed to load integration settings", err);
                    setError("No se pudo cargar la configuración de integración.");
                } finally {
                    setIsLoadingSettings(false);
                }
            }
        };
        fetchSettings();

    }, [user]);

    useEffect(() => {
        if (useSameAddress) {
            setFormData(prev => ({...prev, pickupAddress: prev.address}));
        }
    }, [formData.address, useSameAddress]);
    
    const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        const { name, value, type } = e.target;
        
        if (type === 'checkbox') {
             const { checked } = e.target as HTMLInputElement;
             setFormData(prev => ({ ...prev, [name]: checked }));
        } else {
            setFormData(prev => ({ ...prev, [name]: value }));
        }
    };

    const formatCurrency = (value: number) => {
        if (isNaN(value)) return '0';
        return value.toLocaleString('es-CL');
    };

    const handlePricingChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const { name, value } = e.target;
        const numericString = value.replace(/\D/g, '');
        const numValue = parseInt(numericString, 10) || 0;

        if (name === 'pickupCost') {
            setFormData(prev => ({ ...prev, pickupCost: numValue }));
        } else if (name === 'sameDay' || name === 'express' || name === 'nextDay') {
            setFormData(prev => ({
                ...prev,
                pricing: {
                    ...(prev.pricing as UserPricing),
                    [name]: numValue,
                },
            }));
        }
    };
    
    const handleRutBlur = (e: React.FocusEvent<HTMLInputElement>) => {
        const { name, value } = e.target;
        setFormData(prev => ({ ...prev, [name]: formatRut(value) }));
    };

    const handleConnectIntegration = (type: ConnectionSource | 'shopify') => {
        if (isLoadingSettings) return;

        if (type === 'meli') {
            if (!integrationSettings.meliAppId) {
                alert("El App ID de Mercado Libre no está configurado. Por favor, configúrelo en la sección de Integraciones.");
                return;
            }
            const redirectUri = `${window.location.origin}/api/integrations/meli/callback`;
            const authUrl = `https://auth.mercadolibre.com/authorization?response_type=code&client_id=${integrationSettings.meliAppId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${user.id}`;
            window.location.href = authUrl;
        } else {
            alert(`La conexión con ${type} aún no está implementada.`);
        }
    };

    const handleTestShopify = async () => {
        setIsTestingShopify(true);
        setShopifyTestResult(null);
        try {
            const result = await api.testShopifyConnection({
                shopifyShopUrl: clientShopifyUrl,
                shopifyAccessToken: clientShopifyToken
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

    const handleTestWoo = async () => {
        setIsTestingWoo(true);
        setWooTestResult(null);
        try {
            const result = await api.testWooCommerceConnection({
                wooUrl: clientWooUrl,
                wooConsumerKey: clientWooKey,
                wooConsumerSecret: clientWooSecret
            });
            setWooTestResult({ type: 'success', message: result.message });
        } catch (err: any) {
            setWooTestResult({ type: 'error', message: err.message || 'Error de conexión' });
        } finally {
            setIsTestingWoo(false);
        }
    };

    const handleTestJumpseller = async () => {
        setIsTestingJumpseller(true);
        setJumpsellerTestResult(null);
        try {
            const result = await api.testJumpsellerConnection({
                jumpsellerLogin: clientJumpsellerLogin,
                jumpsellerToken: clientJumpsellerToken
            });
            setJumpsellerTestResult({ type: 'success', message: result.message });
        } catch (err: any) {
            setJumpsellerTestResult({ type: 'error', message: err.message || 'Error de conexión' });
        } finally {
            setIsTestingJumpseller(false);
        }
    };


    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
         if (!formData.name || !formData.email || !formData.phone) {
            setError("Nombre, correo y teléfono son obligatorios.");
            return;
        }
        if (password && password !== confirmPassword) {
            setError("Las contraseñas no coinciden.");
            return;
        }
        if (password && !isPasswordValid) {
            setError("La nueva contraseña no cumple con los requisitos mínimos de seguridad.");
            return;
        }
        if (!validateRut(formData.personalRut || '') || !validateRut(formData.companyRut || '') || !validateRut(formData.billingRut || '')) {
            setError("Uno de los RUT ingresados no es válido.");
            return;
        }
        setError('');
        
        const updateData: UserUpdateData = { ...formData };
        if (password) {
            updateData.password = password;
        }
        
        if (user.role === Role.Driver && !formData.hasCompany) {
            updateData.companyName = '';
            updateData.companyRut = '';
            updateData.companyAddress = '';
        }
        
        if(user.role === Role.Client && useSameAddress) {
            updateData.pickupAddress = formData.address;
        }
        
        // Update integrations with shopify data
        if (user.role === Role.Client) {
            updateData.integrations = {
                ...formData.integrations,
                shopify: (clientShopifyUrl && clientShopifyToken) ? {
                    shopUrl: clientShopifyUrl,
                    accessToken: clientShopifyToken
                } : undefined,
                woocommerce: (clientWooUrl && clientWooKey && clientWooSecret) ? {
                    storeUrl: clientWooUrl,
                    consumerKey: clientWooKey,
                    consumerSecret: clientWooSecret
                } : undefined,
                falabella: (clientFalabellaSellerId && clientFalabellaApiKey) ? {
                    sellerId: clientFalabellaSellerId,
                    apiKey: clientFalabellaApiKey
                } : undefined,
                jumpseller: (clientJumpsellerLogin && clientJumpsellerToken) ? {
                    login: clientJumpsellerLogin,
                    token: clientJumpsellerToken
                } : undefined
            };
        }

        setIsSubmitting(true);
        try {
            await onUpdate(user.id, updateData);
        } catch (err: any) {
            setError(err.message || "Ocurrió un error al actualizar el usuario.");
            setIsSubmitting(false);
        }
    };

    const handlePhoneChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        let value = e.target.value;
        const cleanValue = value.replace(/[^\d+]/g, '');
        if (!cleanValue) {
            setFormData(prev => ({...prev, phone: ''}));
            return;
        }
        if (/^\d{8}$/.test(cleanValue)) {
            setFormData(prev => ({...prev, phone: `+569${cleanValue}`}));
        } else if (/^9\d{8}$/.test(cleanValue)) {
            setFormData(prev => ({...prev, phone: `+56${cleanValue}`}));
        } else {
            setFormData(prev => ({...prev, phone: cleanValue}));
        }
    };

    const handlePhoneBlur = (e: React.FocusEvent<HTMLInputElement>) => {
        let phoneNumber = e.target.value.replace(/\s+/g, '');
        if (phoneNumber.length === 9 && phoneNumber.startsWith('9')) {
            phoneNumber = `+56${phoneNumber}`;
        } else if (phoneNumber.length === 8 && /^\d+$/.test(phoneNumber)) {
            phoneNumber = `+569${phoneNumber}`;
        }
        setFormData(prev => ({...prev, phone: phoneNumber}));
    };
  
    const handleStartAddVehicle = () => setEditingVehicle({});
    const handleStartEditVehicle = (vehicle: Vehicle, index: number) => setEditingVehicle({ ...vehicle, index });
    const handleCancelEditVehicle = () => setEditingVehicle(null);
  
    const handleSaveVehicle = () => {
        if (!editingVehicle || !editingVehicle.plate) return;
        const vehicleToSave = { ...editingVehicle };
        delete vehicleToSave.index;

        const finalizedVehicle: Vehicle = {
            id: vehicleToSave.id || `vehicle-${Date.now()}`,
            plate: vehicleToSave.plate || '',
            brand: vehicleToSave.brand || '',
            model: vehicleToSave.model || '',
            year: vehicleToSave.year || new Date().getFullYear(),
            technicalReviewExpiry: vehicleToSave.technicalReviewExpiry || '',
            circulationPermitExpiry: vehicleToSave.circulationPermitExpiry || '',
        };
        
        const currentVehicles = formData.vehicles || [];
        if (editingVehicle.index !== undefined) {
            const updatedVehicles = [...currentVehicles];
            updatedVehicles[editingVehicle.index] = finalizedVehicle;
            setFormData(prev => ({ ...prev, vehicles: updatedVehicles }));
        } else {
            setFormData(prev => ({ ...prev, vehicles: [...currentVehicles, finalizedVehicle] }));
        }
        setEditingVehicle(null);
    };

    const handleDeleteVehicle = (index: number) => {
        if(window.confirm('¿Estás seguro?')) {
            const currentVehicles = formData.vehicles || [];
            setFormData(prev => ({ ...prev, vehicles: currentVehicles.filter((_, i) => i !== index) }));
        }
    };

    const handleVehicleFormChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const { name, value, type } = e.target;
        setEditingVehicle(prev => ({
            ...prev,
            [name]: type === 'number' ? (value ? parseInt(value, 10) : '') : value.toUpperCase()
        }));
    };

    const inputClasses = "w-full px-3 py-2 border border-[var(--border-secondary)] rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-secondary)] bg-[var(--background-secondary)] text-[var(--text-primary)]";

    return (
        <div className="fixed inset-0 bg-black bg-opacity-60 z-50 flex justify-center items-center p-4" onClick={onClose}>
            <div className="bg-[var(--background-secondary)] rounded-xl shadow-2xl w-full max-w-2xl animate-fade-in-up relative" onClick={(e) => e.stopPropagation()}>
                <header className="flex items-center justify-between p-4 border-b border-[var(--border-primary)]">
                    <h3 className="text-lg font-bold text-[var(--text-primary)]">Editar Usuario</h3>
                    <button onClick={onClose} className="p-2 rounded-full text-[var(--text-muted)] hover:bg-[var(--background-hover)]" aria-label="Cerrar modal"><IconX className="w-6 h-6" /></button>
                </header>
                <form onSubmit={handleSubmit}>
                    <div className="p-6 space-y-4 max-h-[70vh] overflow-y-auto custom-scrollbar">
                        {error && <p className="text-sm text-[var(--error-text)] bg-[var(--error-bg)] p-3 rounded-md">{error}</p>}
                        <div><label htmlFor="name" className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Nombre Completo</label><input type="text" id="name" name="name" value={formData.name || ''} onChange={handleChange} required className={inputClasses} /></div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div><label htmlFor="email" className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Correo Electrónico</label><input type="email" id="email" name="email" value={formData.email || ''} onChange={handleChange} required className={inputClasses} /></div>
                            <div><label htmlFor="phone" className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Teléfono</label><input type="tel" id="phone" name="phone" value={formData.phone || ''} onChange={handlePhoneChange} onBlur={handlePhoneBlur} required className={inputClasses} /></div>
                        </div>
                        {user.role === Role.Client && (
                            <>
                                <div className="pt-4 mt-4 border-t border-[var(--border-primary)] space-y-4">
                                    <h4 className="text-md font-semibold text-[var(--text-secondary)]">Información Principal del Cliente</h4>
                                    <div><label htmlFor="rut" className="block text-sm font-medium text-[var(--text-secondary)] mb-1">RUT</label><input id="rut" type="text" name="rut" value={formData.rut || ''} onChange={handleChange} onBlur={handleRutBlur} required className={inputClasses} placeholder="12.345.678-9"/></div>
                                    <div><label htmlFor="address" className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Dirección Principal</label><input id="address" type="text" name="address" value={formData.address || ''} onChange={handleChange} required className={inputClasses} placeholder="Calle Falsa 123, Comuna"/></div>
                                    <div><label className="flex items-center"><input type="checkbox" checked={useSameAddress} onChange={(e) => setUseSameAddress(e.target.checked)} className="h-4 w-4 rounded border-[var(--border-secondary)] text-[var(--brand-primary)] focus:ring-[var(--brand-primary)]" /><span className="ml-2 text-sm text-[var(--text-secondary)]">Usar misma dirección para retiro de paquetes</span></label></div>
                                    {!useSameAddress && (<div><label htmlFor="pickupAddress" className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Dirección de Retiro</label><input id="pickupAddress" type="text" name="pickupAddress" value={formData.pickupAddress || ''} onChange={handleChange} required={!useSameAddress} className={inputClasses} placeholder="Bodega Central, etc."/></div>)}
                                    <div><label htmlFor="storesInfo" className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Locales / Sucursales (Opcional)</label><textarea id="storesInfo" name="storesInfo" value={formData.storesInfo || ''} onChange={handleChange} className={inputClasses} rows={2} placeholder="Ej: Tienda Costanera Center, Local 123..."/></div>
                                </div>
                                <div className="pt-4 mt-4 border-t border-[var(--border-primary)] space-y-4">
                                    <h4 className="text-md font-semibold text-[var(--text-secondary)]">Información de Facturación</h4>
                                    <input name="billingName" value={formData.billingName || ''} onChange={handleChange} placeholder="Razón Social" className={inputClasses} />
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                        <input name="billingRut" value={formData.billingRut || ''} onChange={handleChange} onBlur={handleRutBlur} placeholder="RUT Empresa" className={inputClasses} />
                                        <input name="billingGiro" value={formData.billingGiro || ''} onChange={handleChange} placeholder="Giro" className={inputClasses} />
                                    </div>
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                        <input name="billingAddress" value={formData.billingAddress || ''} onChange={handleChange} placeholder="Dirección de Facturación" className={inputClasses} />
                                        <input name="billingCommune" value={formData.billingCommune || ''} onChange={handleChange} placeholder="Comuna" className={inputClasses} />
                                    </div>
                                </div>
                                <div className="pt-4 mt-4 border-t border-[var(--border-primary)] space-y-4">
                                    <h4 className="text-md font-semibold text-[var(--text-secondary)]">Tarifas Personalizadas de Envío y Retiro</h4>
                                    <p className="text-xs text-[var(--text-muted)] -mt-2">
                                        Define valores específicos para este cliente. Si dejas en 0, se usarán las tarifas de la zona.
                                    </p>
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                        <div>
                                            <label htmlFor="sameDay" className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Valor Envío en el Día</label>
                                            <div className="relative">
                                                <span className="absolute inset-y-0 left-0 pl-3 flex items-center text-[var(--text-muted)] pointer-events-none">$</span>
                                                <input type="text" inputMode="numeric" id="sameDay" name="sameDay" value={formatCurrency((formData.pricing as UserPricing)?.sameDay || 0)} onChange={handlePricingChange} className={`${inputClasses} pl-7`} />
                                            </div>
                                        </div>
                                        <div>
                                            <label htmlFor="express" className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Valor Envío Express</label>
                                            <div className="relative">
                                                <span className="absolute inset-y-0 left-0 pl-3 flex items-center text-[var(--text-muted)] pointer-events-none">$</span>
                                                <input type="text" inputMode="numeric" id="express" name="express" value={formatCurrency((formData.pricing as UserPricing)?.express || 0)} onChange={handlePricingChange} className={`${inputClasses} pl-7`} />
                                            </div>
                                        </div>
                                    </div>
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                        <div>
                                            <label htmlFor="nextDay" className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Valor Envío Next Day</label>
                                            <div className="relative">
                                                <span className="absolute inset-y-0 left-0 pl-3 flex items-center text-[var(--text-muted)] pointer-events-none">$</span>
                                                <input type="text" inputMode="numeric" id="nextDay" name="nextDay" value={formatCurrency((formData.pricing as UserPricing)?.nextDay || 0)} onChange={handlePricingChange} className={`${inputClasses} pl-7`} />
                                            </div>
                                        </div>
                                        <div>
                                            <label htmlFor="pickupCost" className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Valor por Retiro</label>
                                            <div className="relative">
                                                <span className="absolute inset-y-0 left-0 pl-3 flex items-center text-[var(--text-muted)] pointer-events-none">$</span>
                                                <input type="text" inputMode="numeric" id="pickupCost" name="pickupCost" value={formatCurrency(formData.pickupCost || 0)} onChange={handlePricingChange} className={`${inputClasses} pl-7`} />
                                            </div>
                                        </div>
                                    </div>
                                </div>
                                <div className="pt-4 mt-4 border-t border-[var(--border-primary)]">
                                    <h4 className="text-md font-semibold text-[var(--text-secondary)] mb-3">Integraciones de E-commerce</h4>
                                    
                                    {/* --- Mercado Libre --- */}
                                    <div className="mb-4">
                                        <div className="flex items-center mb-2">
                                            <IconMercadoLibre className="w-5 h-5 text-yellow-500 mr-2" />
                                            <h5 className="font-medium text-[var(--text-primary)]">Mercado Libre</h5>
                                        </div>
                                        {formData.integrations?.meli && (
                                            <div className="mb-2 p-2 bg-green-50 border border-green-200 rounded-md flex items-center text-green-700 text-xs">
                                                <IconCheckCircle className="w-4 h-4 mr-1.5"/>
                                                Cuenta Conectada
                                            </div>
                                        )}
                                        <button type="button" onClick={() => handleConnectIntegration('meli')} disabled={!!formData.integrations?.meli || isLoadingSettings} className={`w-full flex items-center justify-center p-2 border rounded text-sm disabled:opacity-50 disabled:cursor-not-allowed ${formData.integrations?.meli ? 'bg-gray-100 text-gray-500 border-gray-300' : 'border-yellow-400 hover:bg-yellow-50 text-slate-700'}`}>
                                            {isLoadingSettings ? <IconLoader className="w-4 h-4 animate-spin"/> : null}
                                            {formData.integrations?.meli ? 'Ya Conectado' : 'Conectar Mercado Libre'}
                                        </button>
                                    </div>

                                    {/* --- Shopify --- */}
                                    <div className="pt-4 border-t border-[var(--border-secondary)]">
                                        <div className="flex items-center mb-3">
                                            <IconShopify className="w-5 h-5 text-green-600 mr-2" />
                                            <h5 className="font-medium text-[var(--text-primary)]">Shopify</h5>
                                        </div>

                                        <p className="text-[10px] text-[var(--text-muted)] mb-3">
                                            Para conectar con la app de Full Envíos, el cliente lo hace desde su portal: Configuración → Cuentas Vinculadas → Shopify. Aquí puedes pegar el token de una app personalizada.
                                        </p>

                                        <div className="space-y-3 mt-2">
                                            <div>
                                                <label className="block text-xs font-medium text-[var(--text-secondary)] mb-1">URL de la Tienda (ej: mitienda.myshopify.com)</label>
                                                <input 
                                                    type="text" 
                                                    value={clientShopifyUrl} 
                                                    onChange={(e) => setClientShopifyUrl(e.target.value)} 
                                                    className={inputClasses}
                                                    placeholder="tutienda.myshopify.com"
                                                />
                                            </div>
                                            <div>
                                                <label className="block text-xs font-medium text-[var(--text-secondary)] mb-1">Admin API Access Token (shpat_...)</label>
                                                <div className="relative">
                                                    <input 
                                                        type={showShopifyToken ? "text" : "password"} 
                                                        value={clientShopifyToken} 
                                                        onChange={(e) => setClientShopifyToken(e.target.value)} 
                                                        className={`${inputClasses} pr-10`}
                                                        placeholder="shpat_xxxxxxxxxxxx"
                                                    />
                                                    <button type="button" onClick={() => setShowShopifyToken(!showShopifyToken)} className="absolute inset-y-0 right-0 pr-3 flex items-center text-[var(--text-muted)]">
                                                        {showShopifyToken ? <IconEyeOff className="w-4 h-4"/> : <IconEye className="w-4 h-4"/>}
                                                    </button>
                                                </div>
                                            </div>
                                            <div className="text-xs text-[var(--text-muted)] italic">
                                                Estos datos se guardarán al hacer clic en "Guardar Cambios" abajo.
                                            </div>

                                            {/* Shopify Test Results */}
                                            {shopifyTestResult && (
                                                <div className={`p-3 rounded-md text-sm ${shopifyTestResult.type === 'success' ? 'bg-green-100 text-green-800 border border-green-200' : 'bg-red-100 text-red-800 border border-red-200'}`}>
                                                    <div className="flex items-center gap-2">
                                                        {shopifyTestResult.type === 'success' ? <IconCheckCircle className="w-4 h-4" /> : <IconAlertTriangle className="w-4 h-4" />}
                                                        {shopifyTestResult.message}
                                                    </div>
                                                </div>
                                            )}

                                            <button
                                                type="button"
                                                onClick={handleTestShopify}
                                                disabled={isTestingShopify || !clientShopifyUrl || !clientShopifyToken}
                                                className="w-full flex items-center justify-center gap-2 px-4 py-2 border border-[var(--border-secondary)] bg-white text-[var(--text-primary)] hover:bg-[var(--background-muted)] text-xs font-bold rounded-md shadow-sm disabled:opacity-50 transition-colors"
                                            >
                                                {isTestingShopify ? <IconLoader className="w-4 h-4 animate-spin" /> : <IconPlugConnected className="w-4 h-4 text-[var(--brand-primary)]" />}
                                                Probar Conexión Shopify
                                            </button>
                                        </div>
                                    </div>


                                    {/* --- WooCommerce --- */}
                                    <div className="pt-4 border-t border-[var(--border-secondary)]">
                                        <div className="flex items-center mb-3">
                                            <IconWoocommerce className="w-5 h-5 text-purple-600 mr-2" />
                                            <h5 className="font-medium text-[var(--text-primary)]">WooCommerce</h5>
                                        </div>
                                        <div className="space-y-3">
                                            <div>
                                                <label className="block text-xs font-medium text-[var(--text-secondary)] mb-1">URL de la Tienda (ej: https://mitienda.com)</label>
                                                <input 
                                                    type="text" 
                                                    value={clientWooUrl} 
                                                    onChange={(e) => setClientWooUrl(e.target.value)} 
                                                    className={inputClasses}
                                                    placeholder="https://tutienda.com"
                                                />
                                            </div>
                                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                                <div>
                                                    <label className="block text-xs font-medium text-[var(--text-secondary)] mb-1">Consumer Key (ck_...)</label>
                                                    <input 
                                                        type="text" 
                                                        value={clientWooKey} 
                                                        onChange={(e) => setClientWooKey(e.target.value)} 
                                                        className={inputClasses}
                                                        placeholder="ck_xxxxxxxxxxxx"
                                                    />
                                                </div>
                                                <div>
                                                    <label className="block text-xs font-medium text-[var(--text-secondary)] mb-1">Consumer Secret (cs_...)</label>
                                                    <div className="relative">
                                                        <input 
                                                            type={showWooSecret ? "text" : "password"} 
                                                            value={clientWooSecret} 
                                                            onChange={(e) => setClientWooSecret(e.target.value)} 
                                                            className={`${inputClasses} pr-10`}
                                                            placeholder="cs_xxxxxxxxxxxx"
                                                        />
                                                        <button type="button" onClick={() => setShowWooSecret(!showWooSecret)} className="absolute inset-y-0 right-0 pr-3 flex items-center text-[var(--text-muted)]">
                                                            {showWooSecret ? <IconEyeOff className="w-4 h-4"/> : <IconEye className="w-4 h-4"/>}
                                                        </button>
                                                    </div>
                                                </div>
                                            </div>
                                            
                                        {/* WooCommerce Test Results */}
                                        {wooTestResult && (
                                            <div className={`mt-3 p-3 rounded-md text-sm ${wooTestResult.type === 'success' ? 'bg-green-100 text-green-800 border border-green-200' : 'bg-red-100 text-red-800 border border-red-200'}`}>
                                                <div className="flex items-center gap-2">
                                                    {wooTestResult.type === 'success' ? <IconCheckCircle className="w-4 h-4" /> : <IconAlertTriangle className="w-4 h-4" />}
                                                    {wooTestResult.message}
                                                </div>
                                            </div>
                                        )}

                                        <button
                                            type="button"
                                            onClick={handleTestWoo}
                                            disabled={isTestingWoo || !clientWooUrl || !clientWooKey || !clientWooSecret}
                                            className="mt-3 w-full flex items-center justify-center gap-2 px-4 py-2 border border-[var(--border-secondary)] bg-white text-[var(--text-primary)] hover:bg-[var(--background-muted)] text-xs font-bold rounded-md shadow-sm disabled:opacity-50 transition-colors"
                                        >
                                            {isTestingWoo ? <IconLoader className="w-4 h-4 animate-spin" /> : <IconPlugConnected className="w-4 h-4 text-purple-600" />}
                                            Probar Conexión WooCommerce
                                        </button>
                                    </div>
                                </div>

                                {/* --- Jumpseller --- */}
                                    <div className="pt-4 border-t border-[var(--border-secondary)]">
                                        <div className="flex items-center mb-3">
                                            <IconJumpseller className="w-5 h-5 text-sky-600 mr-2" />
                                            <h5 className="font-medium text-[var(--text-primary)]">Jumpseller</h5>
                                        </div>
                                        <div className="space-y-3">
                                            <div>
                                                <label className="block text-xs font-medium text-[var(--text-secondary)] mb-1">Login (User Email / API User)</label>
                                                <input 
                                                    type="text" 
                                                    value={clientJumpsellerLogin} 
                                                    onChange={(e) => setClientJumpsellerLogin(e.target.value)} 
                                                    className={inputClasses}
                                                    placeholder="usuario@jumpseller.com"
                                                />
                                            </div>
                                            <div>
                                                <label className="block text-xs font-medium text-[var(--text-secondary)] mb-1">API Token</label>
                                                <div className="relative">
                                                    <input 
                                                        type={showJumpsellerToken ? "text" : "password"} 
                                                        value={clientJumpsellerToken} 
                                                        onChange={(e) => setClientJumpsellerToken(e.target.value)} 
                                                        className={`${inputClasses} pr-10`}
                                                        placeholder="Token de Jumpseller"
                                                    />
                                                    <button type="button" onClick={() => setShowJumpsellerToken(!showJumpsellerToken)} className="absolute inset-y-0 right-0 pr-3 flex items-center text-[var(--text-muted)]">
                                                        {showJumpsellerToken ? <IconEyeOff className="w-4 h-4"/> : <IconEye className="w-4 h-4"/>}
                                                    </button>
                                                </div>
                                            </div>
                                            
                                            {/* Jumpseller Test Results */}
                                            {jumpsellerTestResult && (
                                                <div className={`p-3 rounded-md text-sm ${jumpsellerTestResult.type === 'success' ? 'bg-green-100 text-green-800 border border-green-200' : 'bg-red-100 text-red-800 border border-red-200'}`}>
                                                    <div className="flex items-center gap-2">
                                                        {jumpsellerTestResult.type === 'success' ? <IconCheckCircle className="w-4 h-4" /> : <IconAlertTriangle className="w-4 h-4" />}
                                                        {jumpsellerTestResult.message}
                                                    </div>
                                                </div>
                                            )}

                                            <button
                                                type="button"
                                                onClick={handleTestJumpseller}
                                                disabled={isTestingJumpseller || !clientJumpsellerLogin || !clientJumpsellerToken}
                                                className="w-full flex items-center justify-center gap-2 px-4 py-2 border border-[var(--border-secondary)] bg-white text-[var(--text-primary)] hover:bg-[var(--background-muted)] text-xs font-bold rounded-md shadow-sm disabled:opacity-50 transition-colors"
                                            >
                                                {isTestingJumpseller ? <IconLoader className="w-4 h-4 animate-spin" /> : <IconPlugConnected className="w-4 h-4 text-sky-600" />}
                                                Probar Conexión Jumpseller
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            </>
                        )}
                        {user.role === Role.Driver && (
                            <div className="pt-4 mt-4 border-t border-[var(--border-primary)] space-y-4">
                                <h4 className="text-md font-semibold text-[var(--text-secondary)]">Información Conductor</h4>
                                <div><label htmlFor="personalRut" className="block text-sm font-medium text-[var(--text-secondary)] mb-1">RUT Personal</label><input type="text" id="personalRut" name="personalRut" value={formData.personalRut || ''} onChange={handleChange} onBlur={handleRutBlur} required className={inputClasses} /></div>
                                <div className="flex items-center"><input type="checkbox" id="hasCompany" name="hasCompany" checked={formData.hasCompany || false} onChange={handleChange} className="h-4 w-4 rounded border-[var(--border-secondary)] text-[var(--brand-primary)]" /><label htmlFor="hasCompany" className="ml-2 block text-sm text-[var(--text-primary)]">Emite factura (tiene empresa)</label></div>
                                {formData.hasCompany && (<div className="p-4 bg-[var(--background-muted)] rounded-lg space-y-4 border"><input name="companyName" value={formData.companyName || ''} onChange={handleChange} placeholder="Razón Social" className={inputClasses} /><input name="companyRut" value={formData.companyRut || ''} onChange={handleChange} onBlur={handleRutBlur} placeholder="RUT Empresa" className={inputClasses} /><input name="companyAddress" value={formData.companyAddress || ''} onChange={handleChange} placeholder="Dirección Empresa" className={inputClasses} /></div>)}
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4"><input name="licenseType" value={formData.licenseType || ''} onChange={handleChange} placeholder="Tipo de Licencia (Ej: Clase B)" className={inputClasses} /><div><label className="text-xs text-[var(--text-muted)]">Vencimiento Licencia</label><input name="licenseExpiry" value={formData.licenseExpiry || ''} onChange={handleChange} type="date" className={inputClasses} /></div></div>
                                <textarea name="backgroundCheckNotes" value={formData.backgroundCheckNotes || ''} onChange={handleChange} placeholder="Notas de antecedentes (opcional)" className={inputClasses} rows={2}></textarea>
                                <div className="pt-4 mt-4 border-t"><h4 className="text-md font-semibold text-[var(--text-secondary)]">Vehículos</h4>{ (formData.vehicles || []).length > 0 && (<div className="space-y-2 mt-2">{ (formData.vehicles || []).map((v, i) => (<div key={v.id} className="flex items-center justify-between p-2 bg-[var(--background-muted)] border rounded-md"><div className="flex items-center gap-3"><IconTruck className="w-5 h-5 text-[var(--text-muted)]"/><div><p className="font-semibold">{v.plate} <span className="font-normal text-sm">{v.brand} {v.model} ({v.year})</span></p><p className="text-xs text-[var(--text-muted)]">Rev. Téc: {v.technicalReviewExpiry} / P. Circ: {v.circulationPermitExpiry}</p></div></div><div><button type="button" onClick={() => handleStartEditVehicle(v, i)} className="p-1.5"><IconPencil className="w-4 h-4"/></button><button type="button" onClick={() => handleDeleteVehicle(i)} className="p-1.5"><IconTrash className="w-4 h-4"/></button></div></div>))}</div>)}{editingVehicle ? (<VehicleForm vehicle={editingVehicle} onChange={handleVehicleFormChange} onSave={handleSaveVehicle} onCancel={handleCancelEditVehicle} />) : (<button type="button" onClick={handleStartAddVehicle} className="mt-2 text-sm font-semibold flex items-center gap-1"><IconPlus className="w-4 h-4"/> Agregar Vehículo</button>)}</div>
                            </div>
                        )}
                        {user.role === Role.OperadorSistemas && (
                            <OperatorPermissionsForm 
                                permissions={formData.operatorPermissions as OperatorPermissions}
                                onChange={(permissions) => setFormData(prev => ({ ...prev, operatorPermissions: permissions }))}
                            />
                        )}
                        {currentUserRole === Role.Admin && (
                            <div className="pt-4 mt-4 border-t border-[var(--border-primary)]">
                                {user.plainPassword && (user.email !== 'admin' && user.email !== 'admin@admin.cl') && (
                                    <div className="mb-4 p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-md">
                                        <p className="text-xs text-blue-600 dark:text-blue-400 font-medium mb-1">Contraseña Actual:</p>
                                        <p className="text-sm font-mono text-blue-800 dark:text-blue-200">{user.plainPassword}</p>
                                    </div>
                                )}
                                
                                {((user.email !== 'admin' && user.email !== 'admin@admin.cl') || isSuperUser) ? (
                                    <>
                                        <h4 className="text-md font-semibold text-[var(--text-secondary)]">Cambiar Contraseña (Opcional)</h4>
                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-2">
                                            <div><div className="relative"><input type={showPassword ? 'text' : 'password'} placeholder="Nueva Contraseña" value={password} onChange={(e) => setPassword(e.target.value)} className={`${inputClasses} pr-10`} /><button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute inset-y-0 right-0 pr-3 flex items-center">{showPassword ? <IconEyeOff className="h-5 w-5 text-[var(--text-muted)]" /> : <IconEye className="h-5 w-5 text-[var(--text-muted)]" />}</button></div></div>
                                            <div><div className="relative"><input type={showConfirmPassword ? 'text' : 'password'} placeholder="Confirmar" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} className={`${inputClasses} pr-10`} /><button type="button" onClick={() => setShowConfirmPassword(!showConfirmPassword)} className="absolute inset-y-0 right-0 pr-3 flex items-center">{showConfirmPassword ? <IconEyeOff className="h-5 w-5 text-[var(--text-muted)]" /> : <IconEye className="h-5 w-5 text-[var(--text-muted)]" />}</button></div></div>
                                        </div>
                                        {password && (
                                            <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
                                                {passwordRequirements.map((req, idx) => (
                                                    <div key={idx} className="flex items-center gap-2">
                                                        <div className={`w-2 h-2 rounded-full ${req.test(password) ? 'bg-green-500' : 'bg-[var(--border-primary)]'}`} />
                                                        <span className={`text-xs ${req.test(password) ? 'text-green-600 font-medium' : 'text-[var(--text-muted)]'}`}>
                                                            {req.label}
                                                        </span>
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </>
                                ) : (
                                    <div className="p-3 bg-yellow-50 border border-yellow-200 rounded-md">
                                        <p className="text-sm text-yellow-700">No tienes permisos para cambiar la contraseña de este usuario.</p>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                    <footer className="px-6 py-4 bg-[var(--background-muted)] rounded-b-xl flex justify-end space-x-3">
                        <button type="button" onClick={onClose} disabled={isSubmitting} className="px-4 py-2 text-sm font-medium text-[var(--text-secondary)] bg-[var(--background-secondary)] border rounded-md hover:bg-[var(--background-hover)] disabled:opacity-50">Cancelar</button>
                        <button type="submit" disabled={isSubmitting} className="px-4 py-2 text-sm font-medium text-white bg-[var(--brand-primary)] border rounded-md shadow-sm hover:bg-[var(--brand-secondary)] disabled:opacity-50 flex items-center">
                            {isSubmitting ? (
                                <>
                                    <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                    </svg>
                                    Guardando...
                                </>
                            ) : 'Guardar Cambios'}
                        </button>
                    </footer>
                </form>
            </div>
        </div>
    );
};

export default EditUserModal;
