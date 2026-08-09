import React, { useState, useRef, useEffect, useContext } from 'react';
import { Package } from '../../types';
import { DeliveryConfirmationData } from '../../services/api';
import { IconX, IconUser, IconId, IconCamera, IconAlertTriangle, IconCheckCircle, IconPhoto } from '../Icon';
import { AuthContext } from '../../contexts/AuthContext';
import imageCompression from 'browser-image-compression';
import { storageUtils } from '../../utils/storageUtils';

interface DeliveryConfirmationModalProps {
  pkg?: Package;
  packages?: Package[];
  onClose: () => void;
  onConfirm: (pkgIds: string[], data: DeliveryConfirmationData) => Promise<void>;
}

const CameraView: React.FC<{ pkgId: string, onCapture: (dataUrl: string) => void, onCancel: () => void }> = ({ pkgId, onCapture, onCancel }) => {
    const videoRef = useRef<HTMLVideoElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [cameraError, setCameraError] = useState<string | null>(null);

    useEffect(() => {
        let mediaStream: MediaStream | null = null;
        const startCamera = async () => {
            try {
                // Simplificado exactamente como indicaste para arranque inmediato
                try {
                    mediaStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
                } catch (err) {
                    // Fallback rápido si el teléfono no detecta explícitamente "environment"
                    mediaStream = await navigator.mediaDevices.getUserMedia({ video: true });
                }
                const video = videoRef.current;
                if (video) {
                    video.srcObject = mediaStream;
                    // Ya tiene autoPlay en la etiqueta, así que arrancará de inmediato.
                }
            } catch (err: any) {
                console.error("Camera Error:", err.name, err.message);
                let message = "No se pudo acceder a la cámara. Revisa los permisos.";
                if (err.name === "NotAllowedError") {
                    message = "Permiso de cámara denegado. Habilítalo en la configuración del navegador.";
                } else if (err.name === "NotFoundError" || err.name === "DevicesNotFoundError") {
                    message = "No se encontró una cámara en este dispositivo.";
                } else if (err.name === "NotReadableError" || err.name === "TrackStartError") {
                    message = "La cámara está ocupada o no se puede leer. Cierra otras apps que la usen.";
                }
                setCameraError(message);
            }
        };
        startCamera();
        return () => {
            mediaStream?.getTracks().forEach(track => track.stop());
        };
    }, []);

    const handleCapture = () => {
        if (videoRef.current && canvasRef.current) {
            const video = videoRef.current;
            const canvas = canvasRef.current;
            
            const maxDim = 800;
            let width = video.videoWidth;
            let height = video.videoHeight;
            if (width > maxDim || height > maxDim) {
                if (width > height) {
                    height = Math.round((height * maxDim) / width);
                    width = maxDim;
                } else {
                    width = Math.round((width * maxDim) / height);
                    height = maxDim;
                }
            }
            
            canvas.width = width;
            canvas.height = height;
            const context = canvas.getContext('2d');
            context?.drawImage(video, 0, 0, width, height);
            
            // 1. Generar la imagen para la App (con calidad reducida para subir)
            const dataUrl = canvas.toDataURL('image/jpeg', 0.4);

            // 2. Guardar también en la galería del teléfono (respaldo local del conductor).
            // Solo existe window.AndroidApp dentro del wrapper Android; en un navegador normal
            // este bloque simplemente no hace nada.
            // @ts-ignore
            if (window.AndroidApp && window.AndroidApp.saveImageToGallery) {
                try {
                    // @ts-ignore
                    window.AndroidApp.saveImageToGallery(dataUrl, `FullEnvios_${pkgId}_${Date.now()}.jpg`);
                } catch (e) {
                    console.warn('No se pudo guardar la foto en la galería', e);
                }
            }

            onCapture(dataUrl);
        }
    };

    return (
        <div className="absolute inset-0 bg-black z-10 flex flex-col items-center justify-center">
            {cameraError ? (
                <div className="text-white text-center p-8">
                    <IconAlertTriangle className="w-12 h-12 mx-auto mb-4 text-yellow-300" />
                    <p className="font-semibold text-lg">Error de Cámara</p>
                    <p className="text-sm mt-2">{cameraError}</p>
                    <button onClick={onCancel} className="mt-6 px-6 py-2 text-sm font-medium text-black bg-white rounded-lg">Volver</button>
                </div>
            ) : (
                <>
                    <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover" />
                    <canvas ref={canvasRef} className="hidden" />
                    <div className="absolute bottom-0 left-0 right-0 p-4 bg-black bg-opacity-50 flex justify-center space-x-4">
                        <button onClick={onCancel} className="px-4 py-2 text-sm font-medium text-white bg-slate-600 rounded-md">Cancelar</button>
                        <button onClick={handleCapture} className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md">Capturar Foto</button>
                    </div>
                </>
            )}
        </div>
    );
};

const validateRut = (rutCompleto: string): boolean => {
    rutCompleto = rutCompleto.replace(/\./g, '').replace('-', '');
    if (!/^[0-9]+[0-9kK]{1}$/.test(rutCompleto)) {
        return false;
    }
    const rut = rutCompleto.slice(0, -1);
    const dv = rutCompleto.slice(-1).toUpperCase();
    let suma = 0;
    let multiplo = 2;
    for (let i = rut.length - 1; i >= 0; i--) {
        suma += parseInt(rut.charAt(i), 10) * multiplo;
        if (multiplo < 7) {
            multiplo++;
        } else {
            multiplo = 2;
        }
    }
    const dvEsperado = 11 - (suma % 11);
    const dvCalculado = (dvEsperado === 11) ? '0' : (dvEsperado === 10) ? 'K' : dvEsperado.toString();

    return dv === dvCalculado;
};

const DeliveryConfirmationModal: React.FC<DeliveryConfirmationModalProps> = ({ pkg, packages, onClose, onConfirm }) => {
  const pkgList = packages && packages.length > 0 ? packages : (pkg ? [pkg] : []);
  const mainPkg = pkgList[0];

  if (!mainPkg) return null;

  const [receiverName, setReceiverName] = useState('');
  const [receiverId, setReceiverId] = useState('');
  const [photosBase64, setPhotosBase64] = useState<string[]>([]);
  const [isCameraOpen, setIsCameraOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isConfirmingMultiple, setIsConfirmingMultiple] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rutError, setRutError] = useState<string | null>(null);
  const [isCompressing, setIsCompressing] = useState(false);
  const [isRestored, setIsRestored] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const auth = useContext(AuthContext);

  // --- PERSISTENCE LOGIC ---
  const STORAGE_KEY_PREFIX = `delivery_draft_${mainPkg.id}_`;

  // Hydration on mount
  useEffect(() => {
    const savedName = storageUtils.getItem(`${STORAGE_KEY_PREFIX}name`, '');
    const savedId = storageUtils.getItem(`${STORAGE_KEY_PREFIX}id`, '');
    const savedPhotos = storageUtils.getItem<string[]>(`${STORAGE_KEY_PREFIX}photos`, []);

    if (savedName) setReceiverName(savedName);
    if (savedId) setReceiverId(savedId);
    if (savedPhotos && savedPhotos.length > 0) {
        setPhotosBase64(savedPhotos);
    }
    
    if (savedName || savedId || (savedPhotos && savedPhotos.length > 0)) {
        setIsRestored(true);
        // Clear the "restored" message after 3 seconds
        setTimeout(() => setIsRestored(false), 3000);
    }
  }, [mainPkg.id, STORAGE_KEY_PREFIX]);

  // Auto-save on changes
  useEffect(() => {
    storageUtils.safeSetItem(`${STORAGE_KEY_PREFIX}name`, receiverName);
  }, [receiverName, STORAGE_KEY_PREFIX]);

  useEffect(() => {
    storageUtils.safeSetItem(`${STORAGE_KEY_PREFIX}id`, receiverId);
  }, [receiverId, STORAGE_KEY_PREFIX]);

  useEffect(() => {
    storageUtils.safeSetItem(`${STORAGE_KEY_PREFIX}photos`, photosBase64);
  }, [photosBase64, STORAGE_KEY_PREFIX]);
  

  // Cleanup helper
  const clearDraft = () => {
    storageUtils.removeItem(`${STORAGE_KEY_PREFIX}name`);
    storageUtils.removeItem(`${STORAGE_KEY_PREFIX}id`);
    storageUtils.removeItem(`${STORAGE_KEY_PREFIX}photos`);
  };
  const requiredPhotos = auth?.systemSettings.requiredPhotos || 1;
  const isRutRequired = auth?.systemSettings.isRutRequired ?? true;
  const photosRemaining = requiredPhotos - photosBase64.length;

  const formatRut = (rut: string) => {
    rut = rut.replace(/[^0-9kK]/g, '');
    let result = '';
    let i = rut.length - 1;
    if (i >= 0) {
      result = '-' + rut[i];
      i--;
    }
    let count = 0;
    for (; i >= 0; i--) {
      result = rut[i] + result;
      count++;
      if (count === 3 && i > 0) {
        result = '.' + result;
        count = 0;
      }
    }
    return result.toUpperCase();
  };

  const handleRutChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    const rawValue = value.replace(/[^0-9kK]/g, '');

    let finalRawValue = rawValue;

    if (rawValue.endsWith('1') && (rawValue.length >= 8 && rawValue.length <= 9)) {
        const numberPart = rawValue.slice(0, -1);
        const rutWithOne = numberPart + '1';
        const rutWithK = numberPart + 'K';
        const isOneValid = validateRut(rutWithOne);
        const isKValid = validateRut(rutWithK);
        if (isKValid && !isOneValid) {
             finalRawValue = rutWithK;
        }
    }
    
    setReceiverId(formatRut(finalRawValue));
    
    if (rutError) {
        setRutError(null);
    }
  };

  const handleRutBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    const rut = e.target.value;
    if (rut.trim() !== '' && !validateRut(rut)) {
        setRutError('El RUT ingresado no es válido.');
    } else {
        setRutError(null);
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      setIsCompressing(true);
      setError(null);
      
      const fileList = Array.from(files);
      
      try {
          const compressionOptions = {
              maxSizeMB: 1,
              maxWidthOrHeight: 1200,
              useWebWorker: true,
              initialQuality: 0.8
          };

           for (const file of fileList) {
               try {
                   const compressedFile = await imageCompression(file, compressionOptions);
                   
                   const base64 = await new Promise<string>((resolve, reject) => {
                       const reader = new FileReader();
                       reader.onloadend = () => resolve(reader.result as string);
                       reader.onerror = () => reject(new Error("Error al leer archivo comprimido"));
                       reader.readAsDataURL(compressedFile);
                   });

                   setPhotosBase64(prev => [...prev, base64]);
               } catch (innerErr: any) {
                   console.error(`Error procesando archivo ${file.name}:`, innerErr);
               }
           }
      } catch (err: any) {
          console.error("Image processing error [DeliveryModal]:", err);
          setError('Ocurrió un error al procesar las imágenes seleccionadas.');
      } finally {
          setIsCompressing(false);
          if (e.target) e.target.value = '';
      }
    }
  };
  
  const handleRemovePhoto = (indexToRemove: number) => {
      setPhotosBase64(prev => prev.filter((_, index) => index !== indexToRemove));
  };

  const isFormValid = receiverName.trim() !== '' && (!isRutRequired || (receiverId.trim() !== '' && !rutError)) && photosBase64.length >= requiredPhotos && !isCompressing;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isFormValid) return;
    
    // Si son múltiples paquetes y no han confirmado la advertencia, la mostramos
    if (pkgList.length > 1 && !isConfirmingMultiple) {
      setIsConfirmingMultiple(true);
      return;
    }

    setIsLoading(true);
    setError(null);
    try {
      await onConfirm(pkgList.map(p => p.id), {
        receiverName,
        receiverId,
        photosBase64,
      });
      clearDraft();
    } catch (err: any) {
      if (err.status === 404) {
        setError('Uno de los paquetes ya no está disponible para entrega (puede haber sido reasignado o cancelado).');
      } else {
        setError(err.message || 'Ocurrió un error inesperado al confirmar la entrega.');
      }
      setIsLoading(false);
      setIsConfirmingMultiple(false);
    }
  };

  const handleBackdropClick = (e: React.MouseEvent) => {
    e.stopPropagation();
  };

  if (isConfirmingMultiple) {
    return (
      <div className="fixed inset-0 bg-black bg-opacity-60 z-50 flex justify-center items-center p-4" onClick={handleBackdropClick}>
        <div className="bg-[var(--background-secondary)] rounded-xl shadow-2xl w-full max-w-md animate-fade-in-up p-6 text-center" onClick={(e) => e.stopPropagation()}>
          <IconAlertTriangle className="w-16 h-16 mx-auto mb-4 text-orange-500 animate-pulse" />
          <h3 className="text-xl font-bold text-[var(--text-primary)] mb-2">¡Atención! Entrega Múltiple</h3>
          <p className="text-sm text-[var(--text-muted)] mb-6">
            Estás a punto de confirmar la entrega de <strong className="text-[var(--brand-primary)]">{pkgList.length} paquetes</strong> de forma simultánea. Todos se registrarán con la misma firma y datos de recepción.
          </p>
          <div className="flex flex-col space-y-2">
            <button
              onClick={(e) => {
                handleSubmit(e);
              }}
              disabled={isLoading}
              className="w-full py-3 px-4 text-sm font-bold text-white bg-orange-600 rounded-xl hover:bg-orange-700 shadow-md transition-all"
            >
              {isLoading ? 'Confirmando...' : 'Sí, confirmar múltiples entregas'}
            </button>
            <button
              type="button"
              onClick={() => setIsConfirmingMultiple(false)}
              disabled={isLoading}
              className="w-full py-3 px-4 text-sm font-semibold text-[var(--text-secondary)] bg-[var(--background-muted)] rounded-xl hover:bg-[var(--background-hover)] transition-all"
            >
              Volver y revisar
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-60 z-50 flex justify-center items-center p-4" onClick={handleBackdropClick}>
      <div className="bg-[var(--background-secondary)] rounded-xl shadow-2xl w-full max-w-lg animate-fade-in-up" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-start justify-between p-4 border-b border-[var(--border-primary)]">
            <div>
                <h3 className="text-lg font-bold text-[var(--text-primary)]">
                  {pkgList.length > 1 ? `Confirmar Entrega de ${pkgList.length} Paquetes` : `Confirmar Entrega: `}
                  {pkgList.length === 1 && <span className="text-[var(--brand-primary)]">{mainPkg.id}</span>}
                </h3>
                <p className="text-sm text-[var(--text-muted)]">
                  {pkgList.length > 1
                    ? `Destinos: ${pkgList.map(p => p.id).join(', ')}`
                    : `Para: ${mainPkg.recipientName}`}
                </p>
                {isRestored && (
                    <div className="mt-1 flex items-center text-[10px] text-green-600 font-bold bg-green-50 px-2 py-0.5 rounded-full w-fit animate-pulse">
                        <IconCheckCircle className="w-3 h-3 mr-1" /> Datos recuperados automáticamente
                    </div>
                )}
                {mainPkg?.meliDeliveredNeedsPhotos && (
                    <div className="mt-1 flex items-center text-[10px] text-amber-700 font-bold bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full w-fit animate-pulse">
                        <IconAlertTriangle className="w-3 h-3 mr-1 text-amber-500" /> Entrega detectada en Mercado Libre. Toma las fotos de respaldo.
                    </div>
                )}
            </div>
          <button onClick={() => { clearDraft(); onClose(); }} className="p-2 rounded-full text-[var(--text-muted)] hover:bg-[var(--background-hover)]" aria-label="Cerrar modal">
            <IconX className="w-6 h-6" />
          </button>
        </header>

        <form onSubmit={handleSubmit}>
          <div className="p-6 space-y-4 max-h-[65vh] overflow-y-auto no-scrollbar">
            {error && <p className="text-sm text-[var(--error-text)] bg-[var(--error-bg)] p-3 rounded-md flex items-center"><IconAlertTriangle className="w-4 h-4 mr-2"/> {error}</p>}

            {pkgList.length === 1 && mainPkg.recipientAddress && (
                <div className="text-xs text-[var(--text-secondary)] bg-[var(--background-muted)] px-3 py-2 rounded-md">
                    <span className="font-semibold">{mainPkg.recipientName}</span> — {mainPkg.recipientAddress}
                </div>
            )}

            <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                    <IconUser className="h-5 w-5 text-[var(--text-muted)]" />
                </div>
                <input type="text" value={receiverName} onChange={(e) => setReceiverName(e.target.value)} placeholder="Nombre de quien recibe" required className="w-full pl-10 pr-3 py-2 border border-[var(--border-secondary)] rounded-md bg-[var(--background-secondary)] text-[var(--text-primary)]"/>
            </div>
            {isRutRequired && (
                <div>
                    <div className="relative">
                        <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                            <IconId className="h-5 w-5 text-[var(--text-muted)]" />
                        </div>
                        <input 
                            type="tel"
                            value={receiverId} 
                            onChange={handleRutChange}
                            onBlur={handleRutBlur}
                            placeholder="RUT de quien recibe" 
                            required 
                            className={`w-full pl-10 pr-3 py-2 border rounded-md bg-[var(--background-secondary)] text-[var(--text-primary)] ${rutError ? 'border-red-500' : 'border-[var(--border-secondary)]'}`}
                            aria-invalid={!!rutError}
                        />
                    </div>
                    {rutError && <p className="text-xs text-red-600 mt-1 ml-1">{rutError}</p>}
                </div>
            )}

            <div className="p-4 bg-[var(--background-muted)] rounded-lg text-center">
                {photosBase64.length > 0 && (
                    <div className="space-y-2">
                        <div className="grid grid-cols-3 gap-2">
                            {photosBase64.map((photo, index) => (
                                <div key={index} className="relative aspect-square">
                                    <img src={photo} alt={`Prueba de entrega ${index + 1}`} className="rounded-md w-full h-full object-cover" />
                                    <button type="button" onClick={() => handleRemovePhoto(index)} className="absolute top-1 right-1 p-1 bg-black bg-opacity-60 text-white rounded-full hover:bg-opacity-80" aria-label={`Quitar foto ${index + 1}`}>
                                        <IconX className="w-3 h-3" />
                                    </button>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
                {photosRemaining > 0 ? (
                    <div className="space-y-3">
                        <div className="grid grid-cols-2 gap-3">
                            <button type="button" onClick={() => setIsCameraOpen(true)} className={`flex flex-col items-center justify-center p-4 border-2 border-dashed border-[var(--border-secondary)] rounded-lg text-[var(--text-muted)] hover:bg-[var(--background-hover)] hover:border-[var(--brand-primary)] hover:text-[var(--brand-primary)] transition-colors`}>
                                <IconCamera className="w-8 h-8 mb-2" />
                                <span className="text-sm font-semibold">Cámara</span>
                            </button>
                            <button type="button" onClick={() => fileInputRef.current?.click()} className="flex flex-col items-center justify-center p-4 border-2 border-dashed border-[var(--border-secondary)] rounded-lg text-[var(--text-muted)] hover:bg-[var(--background-hover)] hover:border-[var(--brand-primary)] hover:text-[var(--brand-primary)] transition-colors cursor-pointer relative">
                                <IconPhoto className="w-8 h-8 mb-2" />
                                <span className="text-sm font-semibold">Galería</span>
                            </button>
                            <input
                                type="file"
                                ref={fileInputRef}
                                onChange={handleFileChange}
                                accept="image/*"
                                multiple
                                className="hidden"
                            />
                        </div>
                        {isCompressing && (
                            <div className="flex items-center justify-center space-x-2 text-indigo-600 animate-pulse py-2">
                                <div className="w-4 h-4 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin"></div>
                                <span className="text-xs font-bold">Optimizando imágenes...</span>
                            </div>
                        )}
                        <p className="text-xs text-[var(--text-muted)]">
                            {photosRemaining > 1 ? 'Faltan' : 'Falta'} {photosRemaining} foto{photosRemaining > 1 ? 's' : ''} requerida{photosRemaining > 1 ? 's' : ''}
                        </p>
                    </div>
                ) : (
                    <p className="text-xs text-green-600 flex items-center justify-center mt-3"><IconCheckCircle className="w-4 h-4 mr-1.5"/> Todas las fotos requeridas han sido capturadas.</p>
                )}
                {isCameraOpen && <CameraView pkgId={mainPkg.id} onCapture={(dataUrl) => { setPhotosBase64(prev => [...prev, dataUrl]); setIsCameraOpen(false); }} onCancel={() => setIsCameraOpen(false)} />}
            </div>
          </div>

          <footer className="px-6 py-4 bg-[var(--background-muted)] rounded-b-xl flex justify-end space-x-3 border-t border-[var(--border-primary)]">
            <button type="button" onClick={() => { clearDraft(); onClose(); }} className="px-4 py-2 text-sm font-medium text-[var(--text-secondary)] bg-[var(--background-secondary)] border border-[var(--border-secondary)] rounded-md hover:bg-[var(--background-hover)]">Cancelar</button>
            <button type="submit" disabled={!isFormValid || isLoading} className="px-4 py-2 text-sm font-medium text-white bg-blue-600 border border-transparent rounded-md shadow-sm hover:bg-blue-700 disabled:bg-slate-400 disabled:cursor-not-allowed">
              {isLoading ? 'Confirmando...' : 'Confirmar Entrega'}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
};

export default DeliveryConfirmationModal;