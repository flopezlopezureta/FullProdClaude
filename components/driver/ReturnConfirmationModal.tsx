import React, { useState, useRef, useEffect, useContext } from 'react';
import { Package } from '../../types';
import { DeliveryConfirmationData } from '../../services/api';
import { IconX, IconUser, IconId, IconCamera, IconAlertTriangle, IconCheckCircle, IconPhoto } from '../Icon';
import { AuthContext } from '../../contexts/AuthContext';
import imageCompression from 'browser-image-compression';

interface ReturnConfirmationModalProps {
  pkg: Package;
  onClose: () => void;
  onConfirm: (pkgId: string, data: DeliveryConfirmationData) => Promise<void>;
}

const CameraView: React.FC<{ onCapture: (dataUrl: string) => void, onCancel: () => void }> = ({ onCapture, onCancel }) => {
    const videoRef = useRef<HTMLVideoElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [cameraError, setCameraError] = useState<string | null>(null);

    useEffect(() => {
        let mediaStream: MediaStream | null = null;
        const startCamera = async () => {
            try {
                try {
                    mediaStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
                } catch (err) {
                    mediaStream = await navigator.mediaDevices.getUserMedia({ video: true });
                }
                const video = videoRef.current;
                if (video) {
                    video.srcObject = mediaStream;
                }
            } catch (err: any) {
                let message = "No se pudo acceder a la cámara. Revisa los permisos.";
                if (err.name === "NotAllowedError") message = "Permiso de cámara denegado.";
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
            
            const dataUrl = canvas.toDataURL('image/jpeg', 0.4);

            // Guardar también en la galería del teléfono (respaldo local del conductor).
            // window.AndroidApp solo existe dentro del wrapper Android.
            // @ts-ignore
            if (window.AndroidApp && window.AndroidApp.saveImageToGallery) {
                try {
                    // @ts-ignore
                    window.AndroidApp.saveImageToGallery(dataUrl, `FullEnvios_${Date.now()}.jpg`);
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
                    <p>{cameraError}</p>
                    <button onClick={onCancel} className="mt-4 px-4 py-2 text-black bg-white rounded-lg">Volver</button>
                </div>
            ) : (
                <>
                    <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover" />
                    <canvas ref={canvasRef} className="hidden" />
                    <div className="absolute bottom-0 left-0 right-0 p-4 bg-black bg-opacity-50 flex justify-center space-x-4">
                        <button onClick={onCancel} className="px-4 py-2 text-white bg-slate-600 rounded-md">Cancelar</button>
                        <button onClick={handleCapture} className="px-4 py-2 text-white bg-blue-600 rounded-md">Capturar</button>
                    </div>
                </>
            )}
        </div>
    );
};

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


const ReturnConfirmationModal: React.FC<ReturnConfirmationModalProps> = ({ pkg, onClose, onConfirm }) => {
  const [receiverName, setReceiverName] = useState('');
  const [receiverId, setReceiverId] = useState('');
  const [photosBase64, setPhotosBase64] = useState<string[]>([]);
  const [isCameraOpen, setIsCameraOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rutError, setRutError] = useState<string | null>(null);
  const [isCompressing, setIsCompressing] = useState(false);
  const [isRestored, setIsRestored] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const auth = useContext(AuthContext);

  // --- PERSISTENCE LOGIC ---
  const STORAGE_KEY_PREFIX = `return_draft_${pkg.id}_`;

  const clearDraft = () => {
    localStorage.removeItem(`${STORAGE_KEY_PREFIX}name`);
    localStorage.removeItem(`${STORAGE_KEY_PREFIX}id`);
    localStorage.removeItem(`${STORAGE_KEY_PREFIX}photos`);
  };

  useEffect(() => {
    const savedName = localStorage.getItem(`${STORAGE_KEY_PREFIX}name`);
    const savedId = localStorage.getItem(`${STORAGE_KEY_PREFIX}id`);
    const savedPhotos = localStorage.getItem(`${STORAGE_KEY_PREFIX}photos`);

    if (savedName) setReceiverName(savedName);
    if (savedId) setReceiverId(savedId);
    if (savedPhotos) {
        try { setPhotosBase64(JSON.parse(savedPhotos)); } catch(e) { console.error(e); }
    }

    if (savedName || savedId || savedPhotos) {
        setIsRestored(true);
        setTimeout(() => setIsRestored(false), 3000);
    }
  }, [pkg.id]);

  useEffect(() => { localStorage.setItem(`${STORAGE_KEY_PREFIX}name`, receiverName); }, [receiverName, STORAGE_KEY_PREFIX]);
  useEffect(() => { localStorage.setItem(`${STORAGE_KEY_PREFIX}id`, receiverId); }, [receiverId, STORAGE_KEY_PREFIX]);
  // Photo persistence disabled to prevent localStorage quota issues in mobile
  
  const requiredPhotos = auth?.systemSettings.requiredPhotos || 1;
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
    setReceiverId(formatRut(e.target.value));
    if (rutError) setRutError(null);
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
              // Web Workers created from a blob: URL aren't reliably supported by every Android
              // System WebView version drivers run — on the ones that don't, compression fails
              // silently for every photo. Running on the main thread costs a brief pause instead
              // of a background thread, but works everywhere.
              useWebWorker: false,
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
          alert("Imágenes optimizadas con éxito para una carga fluida.");
      } catch (err: any) {
          console.error("Image processing error [ReturnModal]:", err);
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

  const isFormValid = receiverName.trim() !== '' && receiverId.trim() !== '' && photosBase64.length >= requiredPhotos && !rutError;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isFormValid) return;
    setIsLoading(true);
    setError(null);
    try {
      await onConfirm(pkg.id, {
        receiverName,
        receiverId,
        photosBase64,
      });
      clearDraft();
    } catch (err: any) {
      setError(err.message || 'Ocurrió un error inesperado.');
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-60 z-50 flex justify-center items-center p-4" onClick={onClose}>
      <div className="bg-[var(--background-secondary)] rounded-xl shadow-2xl w-full max-w-lg animate-fade-in-up" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-start justify-between p-4 border-b border-[var(--border-primary)]">
            <div>
                <h3 className="text-lg font-bold text-[var(--text-primary)]">Confirmar Devolución: <span className="text-[var(--brand-primary)]">{pkg.id}</span></h3>
                <p className="text-sm text-[var(--text-muted)]">A: {pkg.origin}</p>
                {isRestored && (
                    <div className="mt-1 flex items-center text-[10px] text-green-600 font-bold bg-green-50 px-2 py-0.5 rounded-full w-fit animate-pulse">
                        <IconCheckCircle className="w-3 h-3 mr-1" /> Datos recuperados automáticamente
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
            
            <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                    <IconUser className="h-5 w-5 text-[var(--text-muted)]" />
                </div>
                <input type="text" value={receiverName} onChange={(e) => setReceiverName(e.target.value)} placeholder="Nombre de quien recibe" required className="w-full pl-10 pr-3 py-2 border border-[var(--border-secondary)] rounded-md bg-[var(--background-secondary)] text-[var(--text-primary)]"/>
            </div>
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

            <div className="p-4 bg-[var(--background-muted)] rounded-lg text-center">
                {photosBase64.length > 0 && (
                    <div className="space-y-2">
                        <div className="grid grid-cols-3 gap-2">
                            {photosBase64.map((photo, index) => (
                                <div key={index} className="relative aspect-square">
                                    <img src={photo} alt={`Prueba de devolución ${index + 1}`} className="rounded-md w-full h-full object-cover" />
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
                            <button type="button" onClick={() => fileInputRef.current?.click()} className={`flex flex-col items-center justify-center p-4 border-2 border-dashed border-[var(--border-secondary)] rounded-lg text-[var(--text-muted)] hover:bg-[var(--background-hover)] hover:border-[var(--brand-primary)] hover:text-[var(--brand-primary)] transition-colors`}>
                                <IconPhoto className="w-8 h-8 mb-2" />
                                <span className="text-sm font-semibold">Galería</span>
                            </button>
                        </div>
                        <input 
                            type="file" 
                            ref={fileInputRef} 
                            onChange={handleFileChange}
                            accept="image/*"
                            multiple
                            className="hidden"
                        />
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
                {isCameraOpen && <CameraView onCapture={(dataUrl) => { setPhotosBase64(prev => [...prev, dataUrl]); setIsCameraOpen(false); }} onCancel={() => setIsCameraOpen(false)} />}
            </div>
          </div>

          <footer className="px-6 py-4 bg-[var(--background-muted)] rounded-b-xl flex justify-end space-x-3 border-t border-[var(--border-primary)]">
            <button type="button" onClick={() => { clearDraft(); onClose(); }} className="px-4 py-2 text-sm font-medium text-[var(--text-secondary)] bg-[var(--background-secondary)] border border-[var(--border-secondary)] rounded-md hover:bg-[var(--background-hover)]">Cancelar</button>
            <button type="submit" disabled={!isFormValid || isLoading} className="px-4 py-2 text-sm font-medium text-white bg-blue-600 border border-transparent rounded-md shadow-sm hover:bg-blue-700 disabled:bg-slate-400 disabled:cursor-not-allowed">
              {isLoading ? 'Confirmando...' : 'Confirmar Devolución'}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
};

export default ReturnConfirmationModal;
