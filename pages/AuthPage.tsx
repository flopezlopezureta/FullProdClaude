import React, { useState, useContext, useEffect } from 'react';
import { AuthContext } from '../contexts/AuthContext';
import { IconEye, IconEyeOff } from '../components/Icon';
import { api, RegisterData } from '../services/api';
import { Role } from '../constants';

type FormMode = 'login' | 'register' | 'forgot';

// --- RUT Validation and Formatting Utilities ---
const validateRut = (rutCompleto: string): boolean => {
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

const AuthPage: React.FC<{ onBack?: () => void }> = ({ onBack }) => {
  const [mode, setMode] = useState<FormMode>('login');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  
  // Common fields
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  
  // Registration specific fields
  const [role, setRole] = useState<Role>(Role.Client);
  const [rut, setRut] = useState('');
  const [address, setAddress] = useState('');
  const [pickupAddress, setPickupAddress] = useState('');
  const [useSameAddress, setUseSameAddress] = useState(true);
  const [storesInfo, setStoresInfo] = useState('');
  
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const auth = useContext(AuthContext);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const initialMode = params.get('mode') as FormMode;
    // 'register' deliberately excluded — self-registration is closed (accounts are created by
    // an admin now), and this URL param used to be a direct way to reach the form even without
    // the link on the page.
    if (initialMode && ['login', 'forgot'].includes(initialMode)) {
      setMode(initialMode);
    }
    const initialEmail = params.get('email');
    if (initialEmail) {
      setEmail(initialEmail);
    }
  }, []);

  useEffect(() => {
    if (useSameAddress) {
      setPickupAddress(address);
    }
  }, [address, useSameAddress]);

  const resetFormFields = () => {
    setEmail('');
    setPassword('');
    setConfirmPassword('');
    setName('');
    setPhone('');
    setRole(Role.Client);
    setRut('');
    setAddress('');
    setPickupAddress('');
    setUseSameAddress(true);
    setStoresInfo('');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    if (!auth) throw new Error("Auth context is not available");

    try {
        if (mode === 'login') {
            await auth.login({ email, password });
        } else if (mode === 'register') {
            if (password !== confirmPassword) {
                setError('Las contraseñas no coinciden.');
                return;
            }

            const registerData: RegisterData = { name, email, password, role, phone };

            if (role === Role.Client) {
                if (!rut || !address || !phone) {
                    setError('RUT, Teléfono y Dirección son obligatorios para clientes.');
                    return;
                }
                if (!validateRut(rut)) {
                    setError('El RUT ingresado no es válido.');
                    return;
                }
                registerData.rut = rut;
                registerData.address = address;
                registerData.pickupAddress = useSameAddress ? address : pickupAddress;
                registerData.storesInfo = storesInfo;
            }

            await auth.register(registerData);
            setSuccess('¡Registro exitoso! Su cuenta está pendiente de aprobación por un administrador.');
            switchMode('login', false); // Don't reset fields, just switch view

        } else { // mode === 'forgot'
            await api.requestPasswordRecovery(email);
            setSuccess('Si tu correo está registrado, recibirás un WhatsApp con las instrucciones para recuperar tu cuenta.');
            switchMode('login');
        }
    } catch (err: any) {
      setError(err.message || 'Ocurrió un error.');
    }
  };

  const switchMode = (newMode: FormMode, shouldReset: boolean = true) => {
    setMode(newMode);
    setError(null);
    if (shouldReset) {
      setSuccess(null);
      resetFormFields();
    }
  }

  const getTitle = () => {
      switch(mode) {
          case 'login': return 'Iniciar Sesión';
          case 'register': return 'Crear Cuenta';
          case 'forgot': return 'Recuperar Contraseña';
      }
  }

  const getButtonText = () => {
      switch(mode) {
          case 'login': return 'Ingresar';
          case 'register': return 'Registrarse';
          case 'forgot': return 'Enviar Instrucciones';
      }
  }

  const inputClasses = "shadow-sm appearance-none border rounded w-full py-2 px-3 leading-tight focus:outline-none focus:ring-2 focus:ring-[var(--brand-secondary)] bg-[var(--background-secondary)] text-[var(--text-primary)] border-[var(--border-secondary)]";

  return (
    <div className="min-h-screen flex flex-col justify-center items-center p-4 bg-[var(--background-primary)]">
      <div className="max-w-md w-full mx-auto">
        <div className="flex justify-center items-center space-x-3 mb-6">
            <img src="/logo.png" alt="Logo" className="h-12 w-auto drop-shadow-md" />
            <h1 className="text-3xl font-bold text-center text-[var(--text-primary)]">
              FULL ENVIOS
            </h1>
        </div>
        <div className="bg-[var(--background-secondary)] p-8 rounded-xl shadow-md">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-2xl font-bold text-[var(--text-primary)]">
              {getTitle()}
            </h2>
            {onBack && (
              <button 
                onClick={onBack}
                className="text-sm font-semibold text-[var(--text-muted)] hover:text-[var(--brand-primary)] flex items-center gap-1 group transition-colors"
                type="button"
              >
                <span className="group-hover:-translate-x-1 transition-transform">←</span> Volver
              </button>
            )}
          </div>

          {error && <div className="bg-[var(--error-bg)] border border-[var(--error-border)] text-[var(--error-text)] px-4 py-3 rounded relative mb-4" role="alert">{error}</div>}
          {success && <div className="bg-[var(--success-bg)] border border-[var(--success-border)] text-[var(--success-text)] px-4 py-3 rounded relative mb-4" role="alert">{success}</div>}

          <form onSubmit={handleSubmit} className="space-y-4">
            {mode === 'register' && (
              <>
                <div>
                    <label className="block text-[var(--text-secondary)] text-sm font-bold mb-2">Tipo de Usuario</label>
                    <div className="flex gap-4">
                        <label className="flex items-center">
                            <input type="radio" name="role" value={Role.Client} checked={role === Role.Client} onChange={() => setRole(Role.Client)} className="form-radio h-4 w-4 text-[var(--brand-primary)]"/>
                            <span className="ml-2 text-[var(--text-secondary)]">Cliente</span>
                        </label>
                        <label className="flex items-center">
                            <input type="radio" name="role" value={Role.Driver} checked={role === Role.Driver} onChange={() => setRole(Role.Driver)} className="form-radio h-4 w-4 text-[var(--brand-primary)]"/>
                            <span className="ml-2 text-[var(--text-secondary)]">Conductor</span>
                        </label>
                    </div>
                </div>
                <div>
                    <label className="block text-[var(--text-secondary)] text-sm font-bold mb-2" htmlFor="name">
                    Nombre Completo
                    </label>
                    <input id="name" type="text" value={name} onChange={(e) => setName(e.target.value)} required className={inputClasses}/>
                </div>
              </>
            )}
            
            <div>
              <label className="block text-[var(--text-secondary)] text-sm font-bold mb-2" htmlFor="email">
                Nombre de Usuario
              </label>
              <input id="email" type="text" value={email} onChange={(e) => setEmail(e.target.value)} required className={inputClasses} />
            </div>

            {mode !== 'forgot' && (
                <>
                <div>
                    <label className="block text-[var(--text-secondary)] text-sm font-bold mb-2" htmlFor="password">
                        Contraseña
                    </label>
                    <div className="relative">
                      <input id="password" type={showPassword ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} required className={`${inputClasses} pr-10`} />
                      <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute inset-y-0 right-0 pr-3 flex items-center" aria-label={showPassword ? "Ocultar contraseña" : "Mostrar contraseña"}>
                          {showPassword ? <IconEyeOff className="h-5 w-5 text-[var(--text-muted)]" /> : <IconEye className="h-5 w-5 text-[var(--text-muted)]" />}
                      </button>
                    </div>
                </div>
                 {mode === 'login' && (
                    <div className="text-right -mt-2 mb-2">
                        <button type="button" onClick={() => switchMode('forgot')} className="text-xs font-semibold text-[var(--brand-primary)] hover:text-[var(--brand-secondary)]">
                            ¿Olvidaste tu contraseña?
                        </button>
                    </div>
                )}
                </>
            )}

            {mode === 'register' && (
                <>
                <div>
                    <label className="block text-[var(--text-secondary)] text-sm font-bold mb-2" htmlFor="confirm-password">
                        Confirmar Contraseña
                    </label>
                    <div className="relative">
                      <input id="confirm-password" type={showConfirmPassword ? 'text' : 'password'} value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required className={`${inputClasses} pr-10`} />
                      <button type="button" onClick={() => setShowConfirmPassword(!showConfirmPassword)} className="absolute inset-y-0 right-0 pr-3 flex items-center" aria-label={showConfirmPassword ? "Ocultar contraseña" : "Mostrar contraseña"}>
                          {showConfirmPassword ? <IconEyeOff className="h-5 w-5 text-[var(--text-muted)]" /> : <IconEye className="h-5 w-5 text-[var(--text-muted)]" />}
                      </button>
                    </div>
                </div>
                <div>
                  <label className="block text-[var(--text-secondary)] text-sm font-bold mb-2" htmlFor="phone">Teléfono de Contacto</label>
                  <input id="phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} required className={inputClasses} placeholder="+56912345678" />
                </div>
                </>
            )}

            {mode === 'register' && role === Role.Client && (
                <div className="space-y-4 pt-4 border-t border-[var(--border-primary)]">
                  <h3 className="text-md font-bold text-[var(--text-secondary)]">Información del Cliente</h3>
                  <div>
                    <label className="block text-[var(--text-secondary)] text-sm font-bold mb-2" htmlFor="rut">RUT</label>
                    <input id="rut" type="text" value={rut} onChange={(e) => setRut(e.target.value)} onBlur={(e) => setRut(formatRut(e.target.value))} required className={inputClasses} placeholder="12.345.678-9"/>
                  </div>
                  <div>
                    <label className="block text-[var(--text-secondary)] text-sm font-bold mb-2" htmlFor="address">Dirección Principal</label>
                    <input id="address" type="text" value={address} onChange={(e) => setAddress(e.target.value)} required className={inputClasses} placeholder="Calle Falsa 123, Comuna"/>
                  </div>
                  <div>
                      <label className="flex items-center">
                          <input type="checkbox" checked={useSameAddress} onChange={(e) => setUseSameAddress(e.target.checked)} className="form-checkbox h-4 w-4 text-[var(--brand-primary)]" />
                          <span className="ml-2 text-sm text-[var(--text-secondary)]">Usar misma dirección para retiro de paquetes</span>
                      </label>
                  </div>
                  {!useSameAddress && (
                      <div>
                          <label className="block text-[var(--text-secondary)] text-sm font-bold mb-2" htmlFor="pickupAddress">Dirección de Retiro</label>
                          <input id="pickupAddress" type="text" value={pickupAddress} onChange={(e) => setPickupAddress(e.target.value)} required={!useSameAddress} className={inputClasses} placeholder="Bodega Central, etc."/>
                      </div>
                  )}
                  <div>
                    <label className="block text-[var(--text-secondary)] text-sm font-bold mb-2" htmlFor="storesInfo">Locales / Sucursales (Opcional)</label>
                    <textarea id="storesInfo" value={storesInfo} onChange={(e) => setStoresInfo(e.target.value)} className={inputClasses} rows={2} placeholder="Ej: Tienda Costanera Center, Local 123..."/>
                  </div>
                </div>
            )}
            
            {mode === 'forgot' && (
                <p className="text-sm text-[var(--text-muted)] my-6">
                    Ingresa tu nombre de usuario y te enviaremos las instrucciones por WhatsApp (si tienes un teléfono registrado).
                </p>
            )}

            <div className="pt-2">
              <button type="submit" className="bg-[var(--brand-primary)] hover:bg-[var(--brand-secondary)] text-[var(--text-on-brand)] font-bold py-2 px-4 rounded focus:outline-none focus:shadow-outline w-full">
                {getButtonText()}
              </button>
            </div>
          </form>

          {mode === 'forgot' && (
            <p className="text-center text-[var(--text-muted)] text-sm mt-6">
              ¿Recordaste tu contraseña?
              <button onClick={() => switchMode('login')} className="font-bold text-[var(--brand-primary)] hover:text-[var(--brand-secondary)] ml-2">
                 Inicia Sesión
              </button>
            </p>
          )}
          {mode === 'login' && (
            <p className="text-center text-[var(--text-muted)] text-sm mt-6">
              ¿Eres cliente o conductor nuevo? Contacta a un administrador para que cree tu cuenta.
            </p>
          )}
          <p className="text-center text-xs text-[var(--text-muted)] opacity-50 mt-6">
            by SELCOM | v{(import.meta as any).env.VITE_APP_VERSION}
          </p>
        </div>
      </div>
    </div>
  );
};

export default AuthPage;