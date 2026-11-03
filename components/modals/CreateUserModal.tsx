import React, { useState, useEffect, useRef } from 'react';
import { IconX, IconEye, IconEyeOff } from '../Icon';
import { api, ApiError, UserCreationData, UserProfileConflict } from '../../services/api';
import { Role } from '../../constants';
import type { UserPricing, OperatorPermissions } from '../../types';
import OperatorPermissionsForm from './OperatorPermissionsForm';

interface CreateUserModalProps {
  onClose: () => void;
  onCreate: (data: UserCreationData) => void;
  defaultRole: Role;
}

const ROLE_LABELS: Record<string, string> = {
  [Role.Admin]: 'Administrador', [Role.Driver]: 'Conductor', [Role.Client]: 'Cliente', [Role.Auxiliar]: 'Auxiliar',
  [Role.Retiros]: 'Retiros', [Role.Facturacion]: 'Facturación', [Role.OperadorSistemas]: 'Operador de sistemas',
};

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


const CreateUserModal: React.FC<CreateUserModalProps> = ({ onClose, onCreate, defaultRole }) => {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [personalRut, setPersonalRut] = useState('');

  // Client billing fields
  const [billingName, setBillingName] = useState('');
  const [billingRut, setBillingRut] = useState('');
  const [billingAddress, setBillingAddress] = useState('');
  const [billingCommune, setBillingCommune] = useState('');
  const [billingGiro, setBillingGiro] = useState('');
  const [pickupCost, setPickupCost] = useState<number>(0);
  const [pricing, setPricing] = useState<UserPricing>({ sameDay: 0, express: 0, nextDay: 0 });
  
  const [operatorPermissions, setOperatorPermissions] = useState<OperatorPermissions>({
    canManageDrivers: true,
    canManageClients: true,
    canManagePackages: true,
    canDeletePackages: false,
    canManageZones: false,
    canManageSettings: false,
    canManageIntegrations: false,
    canViewReports: true,
    canBulkActions: true,
  });

  const [error, setError] = useState('');
  // Los mensajes salen arriba del formulario: si quien lo llena está abajo (contraseña, botón), el formulario sube solo para que los vea.
  const bodyRef = useRef<HTMLDivElement>(null);
  const showError = (message: string) => { setError(message); bodyRef.current?.scrollTo({ top: 0, behavior: 'smooth' }); };
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  // Perfiles que ya existen y se parecen a este: "blocking" impide crearlo (mismo nombre o RUT en el mismo rol, correo en uso); "warnings" es la misma persona en otro rol
  // (o un perfil eliminado) y se puede crear si quien lo hace lo confirma.
  const [blocking, setBlocking] = useState<UserProfileConflict[]>([]);
  const [warnings, setWarnings] = useState<UserProfileConflict[]>([]);
  const [confirmDuplicate, setConfirmDuplicate] = useState(false);

  const warningsKey = useRef('');
  const applyConflicts = (nextBlocking: UserProfileConflict[], nextWarnings: UserProfileConflict[]) => {
    setBlocking(nextBlocking);
    // La casilla de confirmación solo se conserva mientras los avisos sean los mismos.
    const nextKey = nextWarnings.map(c => `${c.type}:${c.profile.id}`).join('|');
    if (nextKey !== warningsKey.current) { warningsKey.current = nextKey; setWarnings(nextWarnings); setConfirmDuplicate(false); }
  };

  // Mientras se escribe, revisa si ya existe un perfil parecido (el servidor lo vuelve a revisar al crear). Si la consulta falla no estorba: se ignora.
  useEffect(() => {
    const hasSomethingToCheck = name.trim().length >= 3 || /.+@.+/.test(email) || personalRut.replace(/[^0-9kK]/g, '').length >= 7;
    if (!hasSomethingToCheck) { applyConflicts([], []); return; }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const result = await api.checkUserDuplicates({ name, role: defaultRole, email: email || undefined, personalRut: personalRut || undefined });
        if (!cancelled) applyConflicts(result.blocking, result.warnings);
      } catch (e) { /* sin aviso previo; al crear el servidor decide */ }
    }, 600);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [name, email, personalRut, defaultRole]);

  const passwordRequirements = [
    { label: "Mínimo 8 caracteres", test: (p: string) => p.length >= 8 },
    { label: "Al menos una mayúscula", test: (p: string) => /[A-Z]/.test(p) },
    { label: "Al menos una minúscula", test: (p: string) => /[a-z]/.test(p) },
    { label: "Al menos un número", test: (p: string) => /[0-9]/.test(p) },
  ];

  const isPasswordValid = passwordRequirements.every(req => req.test(password));

  const formatCurrency = (value: number) => {
    if (isNaN(value)) return '0';
    return value.toLocaleString('es-CL');
  };

  const handlePricingChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    const numericString = value.replace(/\D/g, '');
    const numValue = parseInt(numericString, 10) || 0;

    if (name === 'pickupCost') {
        setPickupCost(numValue);
    } else {
        setPricing(prev => ({ ...prev, [name]: numValue }));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    
    // Base validation
    if (!name || !email || !password || !phone) {
        showError("Nombre, correo, teléfono y contraseña son obligatorios.");
        return;
    }

    if (!isPasswordValid) {
        showError("La contraseña no cumple con los requisitos mínimos de seguridad.");
        return;
    }

    // Perfil repetido: lo que ya existe en el mismo rol no se crea otra vez; la misma persona en otro rol (o un perfil eliminado) se crea solo si se confirma.
    if (blocking.length > 0) {
        showError(blocking[0].message);
        return;
    }
    if (warnings.length > 0 && !confirmDuplicate) {
        showError("Marca la casilla «Crear este perfil de todos modos» si es otro perfil de la misma persona; si no, revisa los avisos de arriba.");
        return;
    }

    // Role-specific validation
    if (defaultRole === Role.Driver) {
        if (!personalRut) {
            showError("El RUT personal es obligatorio para los conductores.");
            return;
        }
        if (personalRut && !validateRut(personalRut)) {
            showError("El RUT personal ingresado no es válido.");
            return;
        }
    } else if (defaultRole === Role.Client) {
        if (!billingName || !billingRut || !billingAddress || !billingCommune || !billingGiro) {
            showError("Todos los campos de facturación son obligatorios para clientes.");
            return;
        }
        if (billingRut && !validateRut(billingRut)) {
            showError("El RUT de facturación ingresado no es válido.");
            return;
        }
    }

    const creationData: UserCreationData = { 
        name, 
        email, 
        phone, 
        password, 
        role: defaultRole, 
        personalRut,
        driverPermissions: defaultRole === Role.Driver ? {
            canDeliver: true,
            canPickup: true,
            canDispatch: true,
            canReturn: true,
            canViewHistory: true,
            canBulkPickup: false,
            canColecta: false,
            canAuxiliar: false,
            canZoning: false,
            meliAutoPromptPhotos: false
        } : undefined
    };
    if (defaultRole === Role.Client) {
        creationData.billingName = billingName;
        creationData.billingRut = billingRut;
        creationData.billingAddress = billingAddress;
        creationData.billingCommune = billingCommune;
        creationData.billingGiro = billingGiro;
        creationData.pickupCost = Number(pickupCost) || 0;
        creationData.pricing = pricing;
    }

    if (defaultRole === Role.OperadorSistemas) {
        creationData.operatorPermissions = operatorPermissions;
    }
    if (warnings.length > 0 && confirmDuplicate) creationData.confirmDuplicateWarning = true;

    setIsSubmitting(true);
    try {
        await onCreate(creationData);
    } catch (err: any) {
        // El servidor revisa otra vez al crear: si apareció un perfil parecido que la consulta previa no vio, se muestra igual que arriba.
        const body = err instanceof ApiError ? err.body : null;
        if (body && Array.isArray(body.conflicts)) {
            if (body.code === 'DUPLICATE_PROFILE') applyConflicts(body.conflicts, []);
            if (body.code === 'CONFIRM_DUPLICATE') applyConflicts([], body.conflicts);
        }
        showError(body && body.code === 'CONFIRM_DUPLICATE'
            ? "Antes de crearlo, confirma con la casilla de arriba que es otro perfil de la misma persona."
            : (err.message || "Ocurrió un error al crear el usuario."));
        setIsSubmitting(false);
    }
  };

  const handlePhoneChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    let value = e.target.value;
    const cleanValue = value.replace(/[^\d+]/g, '');
    if (!cleanValue) {
      setPhone('');
      return;
    }
    if (/^\d{8}$/.test(cleanValue)) {
      setPhone(`+569${cleanValue}`);
    } else if (/^9\d{8}$/.test(cleanValue)) {
      setPhone(`+56${cleanValue}`);
    } else {
      setPhone(cleanValue);
    }
  };

  const handlePhoneBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    const phoneNumber = e.target.value.replace(/\s+/g, '');
    if (phoneNumber.length === 9 && phoneNumber.startsWith('9')) {
      setPhone(`+56${phoneNumber}`);
    } else if (phoneNumber.length === 8 && /^\d+$/.test(phoneNumber)) {
      setPhone(`+569${phoneNumber}`);
    }
  };

  const inputClasses = "w-full px-3 py-2 border border-[var(--border-secondary)] rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-secondary)] bg-[var(--background-secondary)] text-[var(--text-primary)]";

  return (
    <div
      className="fixed inset-0 bg-black bg-opacity-60 z-50 flex justify-center items-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-[var(--background-secondary)] rounded-xl shadow-2xl w-full max-w-lg animate-fade-in-up"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between p-4 border-b border-[var(--border-primary)]">
          <h3 className="text-lg font-bold text-[var(--text-primary)]">Crear Nuevo Usuario ({defaultRole})</h3>
          <button onClick={onClose} className="p-2 rounded-full text-[var(--text-muted)] hover:bg-[var(--background-hover)]" aria-label="Cerrar modal">
            <IconX className="w-6 h-6" />
          </button>
        </header>

        <form onSubmit={handleSubmit}>
          <div ref={bodyRef} className="p-6 space-y-4 max-h-[70vh] overflow-y-auto custom-scrollbar">
            {error && <p className="text-sm text-[var(--error-text)] bg-[var(--error-bg)] p-3 rounded-md">{error}</p>}
            <div>
              <label htmlFor="userName" className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Nombre Completo</label>
              <input type="text" id="userName" value={name} onChange={(e) => setName(e.target.value.toUpperCase())} required className={`${inputClasses} uppercase`} />
            </div>
            {blocking.length > 0 && (
              <div role="alert" data-testid="duplicate-blocking" className="text-sm text-[var(--error-text)] bg-[var(--error-bg)] border border-[var(--error-border)] p-3 rounded-md space-y-1">
                {blocking.map((c, i) => <p key={`${c.type}-${c.profile.id}-${i}`}>{c.message}</p>)}
              </div>
            )}
            {warnings.length > 0 && (
              <div role="status" data-testid="duplicate-warning" className="text-sm text-amber-800 bg-amber-50 border border-amber-200 p-3 rounded-md space-y-2">
                {warnings.map((c, i) => <p key={`${c.type}-${c.profile.id}-${i}`}>{c.message}</p>)}
                <label className="flex items-start gap-2 font-semibold cursor-pointer">
                  <input type="checkbox" checked={confirmDuplicate} onChange={(e) => setConfirmDuplicate(e.target.checked)} className="mt-0.5 h-4 w-4" />
                  <span>Crear este perfil de {ROLE_LABELS[defaultRole] || defaultRole} de todos modos</span>
                </label>
              </div>
            )}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                    <label htmlFor="userEmail" className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Correo Electrónico</label>
                    <input type="email" id="userEmail" value={email} onChange={(e) => setEmail(e.target.value.toLowerCase())} required className={inputClasses} />
                </div>
                <div>
                    <label htmlFor="userPhone" className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Teléfono</label>
                    <input type="tel" id="userPhone" value={phone} onChange={handlePhoneChange} onBlur={handlePhoneBlur} required className={inputClasses} placeholder="+56912345678" />
                </div>
            </div>
             {defaultRole === Role.Driver && (
              <div>
                <label htmlFor="personalRut" className="block text-sm font-medium text-[var(--text-secondary)] mb-1">RUT Personal</label>
                <input 
                  type="text" 
                  id="personalRut" 
                  value={personalRut} 
                  onChange={(e) => setPersonalRut(e.target.value)} 
                  onBlur={(e) => setPersonalRut(formatRut(e.target.value))}
                  required 
                  className={inputClasses}
                  placeholder="12.345.678-9"
                />
              </div>
            )}
             {defaultRole === Role.Client && (
                <>
                <div className="pt-4 mt-4 border-t border-[var(--border-primary)] space-y-4">
                    <h4 className="text-md font-semibold text-[var(--text-secondary)]">Información de Facturación</h4>
                    <input value={billingName} onChange={e => setBillingName(e.target.value)} placeholder="Razón Social" required className={inputClasses} />
                     <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <input value={billingRut} onChange={e => setBillingRut(e.target.value)} onBlur={e => setBillingRut(formatRut(e.target.value))} placeholder="RUT Empresa" required className={inputClasses} />
                        <input value={billingGiro} onChange={e => setBillingGiro(e.target.value)} placeholder="Giro" required className={inputClasses} />
                    </div>
                     <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <input value={billingAddress} onChange={e => setBillingAddress(e.target.value)} placeholder="Dirección de Facturación" required className={inputClasses} />
                        <input value={billingCommune} onChange={e => setBillingCommune(e.target.value)} placeholder="Comuna" required className={inputClasses} />
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
                                <input type="text" inputMode="numeric" id="sameDay" name="sameDay" value={formatCurrency(pricing.sameDay)} onChange={handlePricingChange} className={`${inputClasses} pl-7`} />
                            </div>
                        </div>
                        <div>
                            <label htmlFor="express" className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Valor Envío Express</label>
                            <div className="relative">
                                <span className="absolute inset-y-0 left-0 pl-3 flex items-center text-[var(--text-muted)] pointer-events-none">$</span>
                                <input type="text" inputMode="numeric" id="express" name="express" value={formatCurrency(pricing.express)} onChange={handlePricingChange} className={`${inputClasses} pl-7`} />
                            </div>
                        </div>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div>
                            <label htmlFor="nextDay" className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Valor Envío Next Day</label>
                            <div className="relative">
                                <span className="absolute inset-y-0 left-0 pl-3 flex items-center text-[var(--text-muted)] pointer-events-none">$</span>
                                <input type="text" inputMode="numeric" id="nextDay" name="nextDay" value={formatCurrency(pricing.nextDay)} onChange={handlePricingChange} className={`${inputClasses} pl-7`} />
                            </div>
                        </div>
                        <div>
                            <label htmlFor="pickupCost" className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Valor por Retiro</label>
                            <div className="relative">
                                <span className="absolute inset-y-0 left-0 pl-3 flex items-center text-[var(--text-muted)] pointer-events-none">$</span>
                                <input type="text" inputMode="numeric" id="pickupCost" name="pickupCost" value={formatCurrency(pickupCost)} onChange={handlePricingChange} className={`${inputClasses} pl-7`} />
                            </div>
                        </div>
                    </div>
                </div>
                </>
            )}
            {defaultRole === Role.OperadorSistemas && (
                <OperatorPermissionsForm 
                    permissions={operatorPermissions} 
                    onChange={setOperatorPermissions} 
                />
            )}
            <div className="pt-4 mt-4 border-t border-[var(--border-primary)]">
                 <h4 className="text-md font-semibold text-[var(--text-secondary)]">Credenciales de Acceso</h4>
                 <div className="relative mt-2">
                    <label htmlFor="userPassword" title="Contraseña" className="sr-only">Contraseña</label>
                    <input type={showPassword ? 'text' : 'password'} id="userPassword" placeholder="Contraseña" value={password} onChange={(e) => setPassword(e.target.value)} required className={`${inputClasses} pr-10`} />
                    <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute inset-y-0 right-0 pr-3 flex items-center">
                        {showPassword ? <IconEyeOff className="h-5 w-5 text-[var(--text-muted)]" /> : <IconEye className="h-5 w-5 text-[var(--text-muted)]" />}
                    </button>
                 </div>
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
            </div>
          </div>
          <footer className="px-6 py-4 bg-[var(--background-muted)] rounded-b-xl flex justify-end space-x-3">
            <button type="button" onClick={onClose} disabled={isSubmitting} className="px-4 py-2 text-sm font-medium text-[var(--text-secondary)] bg-[var(--background-secondary)] border border-[var(--border-secondary)] rounded-md hover:bg-[var(--background-hover)] disabled:opacity-50">Cancelar</button>
            <button type="submit" disabled={isSubmitting || blocking.length > 0} className="px-4 py-2 text-sm font-medium text-white bg-[var(--brand-primary)] border border-transparent rounded-md shadow-sm hover:bg-[var(--brand-secondary)] disabled:opacity-50 flex items-center">
                {isSubmitting ? (
                    <>
                        <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                        </svg>
                        Creando...
                    </>
                ) : 'Crear Usuario'}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
};

export default CreateUserModal;