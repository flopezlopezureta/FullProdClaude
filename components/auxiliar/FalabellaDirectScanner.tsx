import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import jsQR from 'jsqr';
import { api } from '../../services/api';
import { IconCheckCircle, IconAlertTriangle, IconChevronRight, IconSearch, IconTruck, IconChevronDown } from '../Icon';
import type { User } from '../../types';

// Sound utility, same pattern as other scanner components.
const playBeep = () => {
    if (window.AudioContext || (window as any).webkitAudioContext) {
        const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
        const osc1 = audioCtx.createOscillator();
        osc1.type = 'sine';
        osc1.frequency.setValueAtTime(1200, audioCtx.currentTime);
        osc1.connect(audioCtx.destination);
        osc1.start(audioCtx.currentTime);
        osc1.stop(audioCtx.currentTime + 0.08);
        const osc2 = audioCtx.createOscillator();
        osc2.type = 'sine';
        osc2.frequency.setValueAtTime(1600, audioCtx.currentTime + 0.09);
        osc2.connect(audioCtx.destination);
        osc2.start(audioCtx.currentTime + 0.09);
        osc2.stop(audioCtx.currentTime + 0.17);
    }
};

interface ScannerViewProps {
    initialDriver: User;
    allDrivers: User[];
    onBack: () => void;
}

const ScannerView: React.FC<ScannerViewProps> = ({ initialDriver, allDrivers, onBack }) => {
    const [stream, setStream] = useState<MediaStream | null>(null);
    const [scanFeedback, setScanFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
    const [isScanning, setIsScanning] = useState(true);
    const [currentDriverId, setCurrentDriverId] = useState(initialDriver.id);
    const videoRef = useRef<HTMLVideoElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const requestRef = useRef<number | null>(null);
    const [cameraError, setCameraError] = useState<string | null>(null);
    const [scannedCount, setScannedCount] = useState(0);
    // Dedupe on the raw scanned text — unlike Mercado Libre's numeric-only IDs, Falabella
    // Directo's QR payload is a JSON blob, so the LPN itself isn't known until after the import
    // call succeeds (extraction happens server-side).
    const scannedInSession = useRef(new Set<string>());

    const handleScan = useCallback(async (rawCode: string) => {
        if (!isScanning || scannedInSession.current.has(rawCode)) return;

        setIsScanning(false);
        scannedInSession.current.add(rawCode);

        const showFeedbackAndResume = (type: 'success' | 'error', message: string, duration: number) => {
            setScanFeedback({ type, message });
            setTimeout(() => {
                setScanFeedback(null);
                setIsScanning(true);
            }, duration);
        };

        // Snapshot the physical label at the moment of a successful scan — same pattern as the
        // Mercado Libre Flex label photo (ScanDispatchPage.tsx), a small backup reference photo
        // kept alongside the package, separate from the delivery-evidence photos taken later.
        let labelPhotoBase64: string | undefined;
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
                labelPhotoBase64 = photoCanvas.toDataURL('image/jpeg', 0.5);
            }
        }

        try {
            const result = await api.importFalabellaDirectScanned(rawCode, currentDriverId, labelPhotoBase64);
            playBeep();
            if (!result.alreadyImported) {
                setScannedCount(prev => prev + 1);
            }
            showFeedbackAndResume('success', result.message, 2500);
        } catch (error: any) {
            scannedInSession.current.delete(rawCode);
            showFeedbackAndResume('error', error.message || 'Error al importar el paquete de Falabella Directo.', 4000);
        }
    }, [isScanning, currentDriverId]);

    const tick = useCallback(() => {
        if (videoRef.current && videoRef.current.readyState === videoRef.current.HAVE_ENOUGH_DATA && canvasRef.current) {
            const video = videoRef.current;
            const canvas = canvasRef.current;
            const context = canvas.getContext('2d');

            canvas.height = video.videoHeight;
            canvas.width = video.videoWidth;
            context?.drawImage(video, 0, 0, canvas.width, canvas.height);
            const imageData = context?.getImageData(0, 0, canvas.width, canvas.height);
            if (imageData) {
                const code = jsQR(imageData.data, imageData.width, imageData.height, {
                    inversionAttempts: 'dontInvert',
                });
                if (code && code.data) {
                    handleScan(code.data);
                }
            }
        }
        if (isScanning) {
            requestRef.current = requestAnimationFrame(tick);
        }
    }, [isScanning, handleScan]);

    useEffect(() => {
        let mediaStream: MediaStream | null = null;
        const startCamera = async () => {
            try {
                mediaStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
                setStream(mediaStream);
                if (videoRef.current) {
                    videoRef.current.srcObject = mediaStream;
                    videoRef.current.play().catch(e => console.error("Error playing video:", e));
                }
            } catch (err: any) {
                let message = "No se pudo acceder a la cámara. Revisa los permisos.";
                if (err.name === "NotAllowedError") {
                    message = "Permiso de cámara denegado. Habilítalo en la configuración del navegador.";
                }
                setCameraError(message);
            }
        };
        startCamera();
        return () => {
            mediaStream?.getTracks().forEach(track => track.stop());
        };
    }, []);

    useEffect(() => {
        if (isScanning && stream) {
            requestRef.current = requestAnimationFrame(tick);
        } else if (requestRef.current) {
            cancelAnimationFrame(requestRef.current);
        }
        return () => {
            if (requestRef.current) cancelAnimationFrame(requestRef.current);
        };
    }, [isScanning, stream, tick]);

    return (
        <div className="bg-[var(--background-secondary)] shadow-md rounded-lg p-6 max-w-2xl mx-auto">
            <h2 className="text-xl font-semibold text-[var(--text-primary)] text-center mb-2">
                Recepción y Asignación — Falabella Directo
            </h2>

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

            <div className="relative bg-black rounded-md overflow-hidden aspect-video border-4 border-[var(--border-primary)]">
                {cameraError ? (
                    <div className="flex items-center justify-center h-full text-white p-4 text-center">{cameraError}</div>
                ) : (
                    <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover" />
                )}
                <canvas ref={canvasRef} className="hidden" />
                <div className="absolute inset-0 bg-black bg-opacity-20 flex items-center justify-center p-8 pointer-events-none">
                    <div className="w-full h-full border-4 border-dashed border-white/50 rounded-lg" />
                </div>
            </div>
            <div className="h-16 mt-4 flex items-center justify-center">
                {scanFeedback ? (
                    <div className={`flex items-center p-4 rounded-md text-white ${scanFeedback.type === 'success' ? 'bg-green-500' : 'bg-red-500'}`}>
                        {scanFeedback.type === 'success' ? <IconCheckCircle className="w-6 h-6 mr-3" /> : <IconAlertTriangle className="w-6 h-6 mr-3" />}
                        <span className="font-medium">{scanFeedback.message}</span>
                    </div>
                ) : (
                    <p className="text-center text-[var(--text-muted)]">Apunta al código QR de la etiqueta de Falabella Directo.</p>
                )}
            </div>
            <div className="text-center my-4 p-4 bg-[var(--background-muted)] rounded-lg">
                <span className="text-lg font-bold text-[var(--text-primary)]">Total Recibido:</span>
                <span className="ml-2 text-3xl font-extrabold text-[var(--brand-primary)]">{scannedCount}</span>
            </div>

            <button
                onClick={onBack}
                className="mt-2 w-full px-4 py-3 text-base font-medium text-[var(--text-secondary)] bg-[var(--background-secondary)] border border-[var(--border-secondary)] rounded-lg hover:bg-[var(--background-hover)]"
            >
                Volver a la lista
            </button>
        </div>
    );
};

const FalabellaDirectScanner: React.FC = () => {
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
        ).sort((a, b) => a.name.localeCompare(b.name)),
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
                <p className="text-sm text-[var(--text-muted)] mt-1">Elige el conductor que recibirá los paquetes de Falabella Directo. Podrás cambiarlo luego dentro del escáner.</p>
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

export default FalabellaDirectScanner;
