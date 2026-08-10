import React, { useState, useEffect, useRef, useCallback, useMemo, useContext } from 'react';
import jsQR from 'jsqr';
import { api } from '../../services/api';
import { IconCheckCircle, IconAlertTriangle, IconChevronRight, IconSearch, IconTruck, IconChevronDown, IconLoader } from '../Icon';
import type { User } from '../../types';
import { Role } from '../../constants';
import { AuthContext } from '../../contexts/AuthContext';

const playBeep = () => {
    if (window.AudioContext || (window as any).webkitAudioContext) {
        const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
        const oscillator = audioCtx.createOscillator();
        const gainNode = audioCtx.createGain();
        gainNode.connect(audioCtx.destination);
        gainNode.gain.setValueAtTime(0.5, audioCtx.currentTime);
        oscillator.connect(gainNode);
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(880, audioCtx.currentTime);
        oscillator.start();
        oscillator.stop(audioCtx.currentTime + 0.1);
    }
};

interface ScannerViewProps {
    initialDriver: User;
    allDrivers: User[];
    onBack: () => void;
}

const ScannerView: React.FC<ScannerViewProps> = ({ initialDriver, allDrivers, onBack }) => {
    const auth = useContext(AuthContext);
    const saveFlexLabelPhoto = auth?.systemSettings?.saveFlexLabelPhoto ?? false;

    const [currentDriverId, setCurrentDriverId] = useState(initialDriver.id);
    const [stream, setStream] = useState<MediaStream | null>(null);
    const [scanResult, setScanResult] = useState<{ type: 'success' | 'error'; message: string; package?: any } | null>(null);
    const [isScanning, setIsScanning] = useState(true);
    const videoRef = useRef<HTMLVideoElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const requestRef = useRef<number | null>(null);
    const [cameraError, setCameraError] = useState<string | null>(null);
    const [scannedCount, setScannedCount] = useState(0);
    const scanLock = useRef(false);
    const [lastScannedPhoto, setLastScannedPhoto] = useState<string | null>(null);
    const [lastScannedRaw, setLastScannedRaw] = useState<string>('');
    const [manualId, setManualId] = useState('');
    const [isManualProcessing, setIsManualProcessing] = useState(false);
    const [reassignConfirm, setReassignConfirm] = useState<{
        message: string;
        codeToUse: string;
        rawCode: string;
        isManual: boolean;
    } | null>(null);

    const currentDriver = allDrivers.find(d => d.id === currentDriverId) || initialDriver;

    const handleScan = useCallback(async (rawCode: string, isManual = false, forceReassign = false) => {
        const cleanRawCode = rawCode.trim();
        if (!isManual) setLastScannedRaw(cleanRawCode);
        
        // Capture photo from canvas if not manual and saveFlexLabelPhoto is enabled
        let photoBase64: string | undefined;
        if (!isManual && saveFlexLabelPhoto) {
            const video = videoRef.current;
            if (video) {
                const photoCanvas = document.createElement('canvas');
                const maxDim = 600;
                let width = video.videoWidth;
                let height = video.videoHeight;
                if (width > maxDim) {
                    height = Math.round((height * maxDim) / width);
                    width = maxDim;
                }
                photoCanvas.width = width;
                photoCanvas.height = height;
                const pCtx = photoCanvas.getContext('2d');
                if (pCtx) {
                    pCtx.drawImage(video, 0, 0, width, height);
                    photoBase64 = photoCanvas.toDataURL('image/jpeg', 0.3);
                }
            }
            setLastScannedPhoto(photoBase64 || null);
        }

        let extractedId: string | null = null;
        // Falabella Directo labels are a distinct QR payload ({origin:"Falabella", url, sellerId})
        // rather than a scannable ID — treated as just another package source here, same scanner,
        // same driver-assignment flow, no separate screen.
        let isFalabellaDirect = false;

        // Try to parse JSON (official ML labels, or Falabella Directo labels)
        try {
            if (cleanRawCode.startsWith('{')) {
                const parsed = JSON.parse(cleanRawCode);
                if (parsed.origin === 'Falabella' && parsed.url) {
                    isFalabellaDirect = true;
                } else if (parsed.id) {
                    extractedId = parsed.id.toString();
                }
            }
        } catch (e) {}

        if (!isFalabellaDirect && !extractedId) {
            // Priority 1: Check for Alphanumeric 'SCA...' format
            const scaMatch = cleanRawCode.match(/[A-Z]{3}\d{2}-[A-Z0-9]{12}/);
            if (scaMatch && scaMatch[0]) {
                extractedId = scaMatch[0];
            } 
            // Priority 2: Check for long numeric string (typical tracking ID)
            else {
                const numericMatches = cleanRawCode.match(/\d+/g);
                if (numericMatches) {
                    const longestNumber = numericMatches.sort((a, b) => b.length - a.length)[0];
                    if (longestNumber && longestNumber.length >= 10) {
                        extractedId = longestNumber;
                    }
                }
            }
        }
        
        const codeToUse = extractedId || cleanRawCode;

        if (!isManual && !forceReassign && (!isScanning || scanLock.current)) return;

        if (!isManual) {
            setIsScanning(false);
            scanLock.current = true;
        } else {
            setIsManualProcessing(true);
        }

        const performDispatch = async (force = false) => {
            try {
              let resultPackage: any;
              let successMessage: string;

              if (isFalabellaDirect) {
                  // Falabella Directo has no pre-existing package to dispatch — the scan itself
                  // creates it already assigned to currentDriverId, in one step.
                  const res = await api.importFalabellaDirectScanned(rawCode, currentDriverId, photoBase64);
                  resultPackage = res.pkg;
                  successMessage = res.message;
              } else {
                  const res = await api.scanPackageForDispatch(codeToUse, currentDriverId, rawCode, undefined, force);
                  resultPackage = res.package;
                  successMessage = `Paquete ${codeToUse} asignado a ${currentDriver.name}`;

                  // Upload photo in background
                  if (photoBase64 && resultPackage?.id) {
                      api.updatePackage(resultPackage.id, { flexLabelPhotoBase64: photoBase64 })
                         .catch(err => console.error("Error al subir foto de etiqueta en segundo plano:", err));
                  }
              }

              playBeep();
              setScannedCount(prev => prev + 1);
              setScanResult({ type: 'success', message: successMessage, package: resultPackage });
              if (isManual) setManualId('');

              setTimeout(() => {
                  setScanResult(null);
                  if (!isManual) {
                      setIsScanning(true);
                      scanLock.current = false;
                      setLastScannedPhoto(null);
                  } else {
                      setIsManualProcessing(false);
                  }
              }, 1500);
            } catch (error: any) {
              if (!isFalabellaDirect && error.status === 409 && error.body?.code === 'REASSIGN_PROMPT') {
                  setReassignConfirm({
                      message: error.message,
                      codeToUse,
                      rawCode,
                      isManual
                  });
                  return;
              }

              setScanResult({ type: 'error', message: error.message || 'Error al procesar el paquete.' });
              setTimeout(() => {
                setScanResult(null);
                if (!isManual) {
                    setIsScanning(true);
                    scanLock.current = false;
                } else {
                    setIsManualProcessing(false);
                }
              }, 4000);
            }
        };

        await performDispatch(forceReassign);
    }, [isScanning, currentDriverId, scannedCount, currentDriver.name, saveFlexLabelPhoto]);

    const handleManualSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (!manualId.trim() || isManualProcessing) return;
        handleScan(manualId, true);
    };
    
    const scanLoop = useCallback(async () => {
        if (!isScanning) return;
        const video = videoRef.current;
        const canvas = canvasRef.current;
        
        if (video && video.readyState === video.HAVE_ENOUGH_DATA && canvas) {
            const context = canvas.getContext('2d');
            canvas.height = video.videoHeight;
            canvas.width = video.videoWidth;
            if (!context) return;
            context.drawImage(video, 0, 0, canvas.width, canvas.height);
            
            // --- Strategy 1: Native BarcodeDetector (Supports linear barcodes + QR) ---
            if ('BarcodeDetector' in window) {
                try {
                    // @ts-ignore - BarcodeDetector might not be in types yet
                    const detector = new window.BarcodeDetector({ formats: ['code_128', 'ean_13', 'qr_code', 'code_39', 'pdf417'] });
                    const barcodes = await detector.detect(canvas);
                    if (barcodes.length > 0) {
                        handleScan(barcodes[0].rawValue);
                        return; // Found something, stop this frame
                    }
                } catch (e) {
                    console.error("BarcodeDetector error", e);
                }
            }

            // --- Strategy 2: jsQR Fallback (QR only) ---
            const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
            if (imageData) {
                const code = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'dontInvert' });
                if (code) handleScan(code.data);
            }
        }
        requestRef.current = requestAnimationFrame(scanLoop);
    }, [isScanning, handleScan]);
    
    useEffect(() => {
        let mediaStream: MediaStream | null = null;
        const startCamera = async () => {
            try {
                mediaStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
                setStream(mediaStream);
                if (videoRef.current) videoRef.current.srcObject = mediaStream;
            } catch (err) {
                setCameraError("No se pudo acceder a la cámara. Revisa los permisos.");
            }
        };
        startCamera();
        return () => mediaStream?.getTracks().forEach(track => track.stop());
    }, []);

    useEffect(() => {
        if (isScanning && stream) {
            requestRef.current = requestAnimationFrame(scanLoop);
        }
        return () => { if (requestRef.current) cancelAnimationFrame(requestRef.current); };
    }, [isScanning, stream, scanLoop]);

    return (
        <div className="bg-[var(--background-secondary)] shadow-md rounded-lg p-4 max-w-2xl mx-auto">
            <div className="mb-4">
                <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1 text-center">Asignando paquetes a:</label>
                <div className="relative">
                    <select 
                        value={currentDriverId} 
                        onChange={(e) => setCurrentDriverId(e.target.value)}
                        className="block w-full pl-10 pr-10 py-3 text-base font-bold border-2 border-[var(--brand-primary)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--brand-secondary)] bg-[var(--background-muted)] text-[var(--text-primary)] appearance-none text-center"
                    >
                        {allDrivers.map(driver => (
                            <option key={driver.id} value={driver.id}>{driver.name}</option>
                        ))}
                    </select>
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                        <IconTruck className="h-6 w-6 text-[var(--brand-primary)]" />
                    </div>
                    <div className="absolute inset-y-0 right-0 pr-3 flex items-center pointer-events-none">
                        <IconChevronDown className="h-5 w-5 text-[var(--text-muted)]" />
                    </div>
                </div>
            </div>

            <div className="relative bg-black rounded-md overflow-hidden aspect-video mb-4 border-4 border-[var(--border-primary)]">
                {cameraError ? <div className="flex items-center justify-center h-full text-white p-4 text-center">{cameraError}</div> : <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover" />}
                <canvas ref={canvasRef} className="hidden" />
                <div className="absolute inset-0 bg-black bg-opacity-20 flex items-center justify-center p-8 pointer-events-none"><div className="w-full h-full border-4 border-dashed border-white/50 rounded-lg"/></div>
            </div>

            <form onSubmit={handleManualSubmit} className="mb-4">
                <label className="block text-[10px] font-black text-[var(--text-muted)] uppercase tracking-widest mb-1.5">Ingreso Manual (Si el QR no es legible)</label>
                <div className="flex gap-2">
                    <input 
                        type="text"
                        placeholder="Ingresa ID o Código de Envío..."
                        value={manualId}
                        onChange={(e) => setManualId(e.target.value)}
                        className="flex-1 px-4 py-2.5 bg-[var(--background-muted)] border border-[var(--border-secondary)] rounded-lg text-sm font-bold focus:ring-2 focus:ring-blue-500 outline-none"
                    />
                    <button 
                        type="submit"
                        disabled={!manualId.trim() || isManualProcessing}
                        className="px-6 py-2.5 bg-blue-600 text-white font-bold rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 flex items-center gap-2"
                    >
                        {isManualProcessing ? <IconLoader className="w-4 h-4 animate-spin" /> : <IconChevronRight className="w-4 h-4" />}
                        Asignar
                    </button>
                </div>
            </form>
            
            <div className="text-center my-4 p-3 bg-[var(--background-muted)] rounded-lg flex justify-between items-center px-6">
                <div className="text-left">
                    <span className="text-sm font-semibold text-[var(--text-secondary)] block">Sesión Actual</span>
                    <span className="text-3xl font-extrabold text-[var(--brand-primary)] text-center">{scannedCount}</span>
                </div>
                {lastScannedPhoto && (
                    <div className="w-16 h-16 rounded-md overflow-hidden border-2 border-[var(--brand-primary)] animate-pulse">
                        <img src={lastScannedPhoto} alt="Label scan" className="w-full h-full object-cover" />
                    </div>
                )}
            </div>

            {lastScannedRaw && (
                <div className="mb-4 p-2 bg-[var(--background-muted)] rounded border border-[var(--border-secondary)] overflow-hidden">
                    <p className="text-[10px] text-[var(--text-muted)] uppercase font-bold mb-1">Código Leído:</p>
                    <p className="text-xs font-mono text-[var(--text-primary)] break-all truncate">{lastScannedRaw}</p>
                </div>
            )}
            
             <div className="min-h-[4rem] mt-2 flex items-center justify-center py-2">
                {scanResult ? (
                    <div className={`flex items-center p-4 rounded-md text-white shadow-lg transition-all transform scale-105 ${scanResult.type === 'success' ? 'bg-green-600' : 'bg-red-500'}`}>
                        {scanResult.type === 'success' ? <IconCheckCircle className="w-6 h-6 mr-3" /> : <IconAlertTriangle className="w-6 h-6 mr-3" />}
                        <div className="flex flex-col">
                            <span className="font-medium text-lg">{scanResult.message}</span>
                            {scanResult.type === 'success' && scanResult.package?.recipientCommune && (
                                <span className="text-xs font-bold bg-black bg-opacity-20 px-2 py-0.5 rounded mt-1 text-yellow-200 w-fit">
                                    Comuna: {scanResult.package.recipientCommune}
                                    {scanResult.package.sectorName ? ` | ${scanResult.package.sectorName}` : ''}
                                </span>
                            )}
                        </div>
                    </div>
                ) : (
                    <p className="text-center text-[var(--text-muted)] text-sm animate-pulse">Escanea el código QR del paquete...</p>
                )}
            </div>
            
            <button 
                onClick={onBack} 
                className="mt-4 w-full px-4 py-3 text-base font-medium text-[var(--text-secondary)] bg-[var(--background-secondary)] border border-[var(--border-secondary)] rounded-lg hover:bg-[var(--background-hover)]"
            >
                Volver a la lista
            </button>

            {reassignConfirm && (
                <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[9999] flex items-center justify-center p-4">
                    <div className="bg-white dark:bg-gray-800 rounded-2xl max-w-sm w-full p-6 shadow-2xl border border-gray-100">
                        <div className="flex items-center justify-center w-12 h-12 rounded-full bg-amber-100 text-amber-600 mx-auto mb-4">
                            <IconAlertTriangle className="w-6 h-6" />
                        </div>
                        <h3 className="text-lg font-bold text-gray-900 dark:text-white text-center mb-2">
                            Confirmar Reasignación
                        </h3>
                        <p className="text-sm text-gray-600 dark:text-gray-300 text-center mb-6">
                            {reassignConfirm.message}
                        </p>
                        <div className="flex gap-3">
                            <button
                                onClick={() => {
                                    if (!reassignConfirm.isManual) {
                                        scanLock.current = false;
                                    }
                                    setReassignConfirm(null);
                                    if (!reassignConfirm.isManual) setIsScanning(true);
                                }}
                                className="flex-1 px-4 py-2.5 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 rounded-xl text-sm font-semibold hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                            >
                                Cancelar
                            </button>
                            <button
                                onClick={() => {
                                    const { rawCode, isManual } = reassignConfirm;
                                    setReassignConfirm(null);
                                    handleScan(rawCode, isManual, true);
                                }}
                                className="flex-1 px-4 py-2.5 bg-amber-600 hover:bg-amber-700 text-white rounded-xl text-sm font-semibold shadow-md transition-colors"
                            >
                                Reasignar
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

const DispatchScanner: React.FC = () => {
    const [drivers, setDrivers] = useState<User[]>([]);
    const [selectedDriver, setSelectedDriver] = useState<User | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [searchQuery, setSearchQuery] = useState('');

    useEffect(() => {
        const fetchDrivers = async () => {
            setIsLoading(true);
            try {
                const allUsers = await api.getUsers();
                setDrivers(allUsers.filter(u => {
                    const role = String(u.role || '').toUpperCase();
                    const status = String(u.status || '').toUpperCase();
                    
                    // Robust check for roles (includes synonyms and different cases)
                    const isAdmin = role === 'ADMIN' || role === 'ADMINISTRADOR';
                    const isDriver = role === 'DRIVER' || role === 'CONDUCTOR' || role === 'CHOFER';
                    
                    // Check for explicit delivery permission if available
                    const hasDeliveryPermission = u.driverPermissions?.canDeliver === true;
                    
                    // Status check (Approved)
                    const isApproved = status === 'APROBADO' || status === 'APPROVED' || status === 'ACTIVO';
                    
                    return (isAdmin || isDriver || hasDeliveryPermission) && isApproved;
                }));
            } catch (error) {
                console.error("Failed to fetch drivers", error);
            } finally {
                setIsLoading(false);
            }
        };
        fetchDrivers();
    }, []);

    const filteredDrivers = useMemo(() => 
        drivers.filter(driver => 
            driver.name.toLowerCase().includes(searchQuery.toLowerCase())
        ).sort((a,b) => a.name.localeCompare(b.name)),
        [drivers, searchQuery]
    );

    if (selectedDriver) {
        return <ScannerView initialDriver={selectedDriver} allDrivers={drivers} onBack={() => setSelectedDriver(null)} />;
    }

    if (isLoading) {
        return <p className="p-6 text-center text-[var(--text-muted)]">Cargando conductores...</p>;
    }

    return (
        <div className="bg-[var(--background-secondary)] shadow-md rounded-lg max-w-2xl mx-auto">
            <div className="p-6 border-b border-[var(--border-primary)]">
                <h2 className="text-xl font-semibold text-[var(--text-primary)]">Seleccionar Conductor</h2>
                <p className="text-sm text-[var(--text-muted)] mt-1">Elige un conductor para comenzar el despacho. Podrás cambiarlo luego dentro del escáner.</p>
                <div className="relative mt-4">
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none"><IconSearch className="h-5 w-5 text-[var(--text-muted)]"/></div>
                    <input type="text" placeholder="Buscar conductor..." value={searchQuery} onChange={e => setSearchQuery(e.target.value)} className="w-full pl-10 pr-4 py-2 border border-[var(--border-secondary)] rounded-md bg-[var(--background-secondary)] text-[var(--text-primary)]"/>
                </div>
            </div>
            <div className="divide-y divide-[var(--border-primary)] max-h-[60vh] overflow-y-auto custom-scrollbar">
                {filteredDrivers.length > 0 ? (
                    filteredDrivers.map(driver => (
                        <button key={driver.id} onClick={() => setSelectedDriver(driver)} className="w-full text-left p-4 flex items-center justify-between hover:bg-[var(--background-hover)] transition-colors group">
                            <div className="flex items-center gap-4">
                                <div className="bg-[var(--background-muted)] p-2 rounded-full group-hover:bg-blue-100 group-hover:text-blue-600 transition-colors"><IconTruck className="w-6 h-6 text-[var(--text-muted)]" /></div>
                                <p className="font-semibold text-[var(--text-primary)]">{driver.name}</p>
                            </div>
                            <IconChevronRight className="w-5 h-5 text-[var(--text-muted)]" />
                        </button>
                    ))
                ) : (
                    <p className="p-6 text-center text-[var(--text-muted)]">No se encontraron conductores.</p>
                )}
            </div>
        </div>
    );
};

export default DispatchScanner;
