import React, { useState, useEffect, useRef, useCallback, useContext, useMemo } from 'react';
import jsQR from 'jsqr';
import { api } from '../../services/api';
import { IconCheckCircle, IconAlertTriangle, IconPencil, IconX, IconChevronLeft, IconLoader, IconTruck } from '../Icon';
import { AuthContext } from '../../contexts/AuthContext';
import type { Package } from '../../types';

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

interface ScanDispatchPageProps {
  onBack?: () => void;
}

export const ScanDispatchPage: React.FC<ScanDispatchPageProps> = ({ onBack }) => {
  const { user, systemSettings } = useContext(AuthContext)!;
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [scanResult, setScanResult] = useState<{ type: 'success' | 'error' | 'info'; message: string; package?: Package } | null>(null);
  const [isScanning, setIsScanning] = useState(true);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const requestRef = useRef<number | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [scannedCount, setScannedCount] = useState(0);
  const scanLock = useRef(false);
  const [isManualEntryOpen, setIsManualEntryOpen] = useState(false);
  const [manualCode, setManualCode] = useState('');
  const [isManualProcessing, setIsManualProcessing] = useState(false);
  const [lastScannedPhoto, setLastScannedPhoto] = useState<string | null>(null);
  const [lastScannedRaw, setLastScannedRaw] = useState<string>('');

  const [reassignConfirm, setReassignConfirm] = useState<{
    message: string;
    packageId: string;
    rawCode: string;
    isManual: boolean;
  } | null>(null);

  const saveFlexLabelPhoto = systemSettings?.saveFlexLabelPhoto || false;

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
    // rather than a scannable ID — treated as just another package source here, no separate screen.
    let isFalabellaDirect = false;

    // 1. Check if it is a JSON string
    if (cleanRawCode.startsWith('{')) {
        try {
            const jsonData = JSON.parse(cleanRawCode);
            if (jsonData.origin === 'Falabella' && jsonData.url) {
                isFalabellaDirect = true;
            } else {
                extractedId = jsonData.shipment_id || jsonData.id || jsonData.s || jsonData.order_id;
            }
        } catch (e) {}
    }

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
          if (isFalabellaDirect) {
              // Falabella Directo has no pre-existing package to dispatch — the scan itself
              // creates it already assigned to yourself, in one step. That requires a live
              // lookup against Falabella's API for the recipient's real data, which is the
              // actual source of the delay here — surface it so the wait doesn't read as the
              // scanner being stuck. No success message afterward (by request): once it
              // resolves, beep and resume scanning immediately instead of holding a toast.
              setScanResult({ type: 'info', message: 'Consultando a Falabella...' });
              await api.importFalabellaDirectScanned(rawCode, user!.id, photoBase64);
              playBeep();
              setScannedCount(prev => prev + 1);
              setScanResult(null);
              if (isManual) setManualCode('');
              if (!isManual) {
                  setIsScanning(true);
                  scanLock.current = false;
                  setLastScannedPhoto(null);
              } else {
                  setIsManualProcessing(false);
              }
              return;
          }

          const res = await api.scanPackageForDispatch(codeToUse, user.id, rawCode, undefined, force);
          const resultPackage = res.package;
          const successMessage = `Paquete ${codeToUse} asignado a tu ruta`;

          // Upload photo in background
          if (photoBase64 && resultPackage?.id) {
              api.updatePackage(resultPackage.id, { flexLabelPhotoBase64: photoBase64 })
                 .catch(err => console.error("Error al subir foto de etiqueta en segundo plano:", err));
          }

          playBeep();
          setScannedCount(prev => prev + 1);
          setScanResult({ type: 'success', message: successMessage, package: resultPackage });
          if (isManual) setManualCode('');

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
                  packageId: codeToUse,
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
  }, [isScanning, user, scannedCount, saveFlexLabelPhoto]);

  const handleManualSubmit = (e: React.FormEvent) => {
      e.preventDefault();
      if (!manualCode.trim() || isManualProcessing) return;
      handleScan(manualCode, true);
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
    <div className="bg-[var(--background-secondary)] shadow-md rounded-lg p-6 max-w-2xl mx-auto">
      <h2 className="text-xl font-semibold text-[var(--text-primary)] mb-2 text-center">Escanear Paquetes para Despacho</h2>
      <p className="text-center text-[var(--text-muted)] mb-4 -mt-1 text-sm">Escanea los paquetes que salen a reparto. Se asignarán a tu cuenta y se marcarán como "En Tránsito".</p>
      
      <div className="relative bg-black rounded-md overflow-hidden aspect-video mb-4 border-4 border-[var(--border-primary)]">
        {cameraError ? (
            <div className="flex items-center justify-center h-full text-white p-4 text-center">{cameraError}</div>
        ) : (
            <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover" />
        )}
        <canvas ref={canvasRef} className="hidden" />
        <div className="absolute inset-0 bg-black bg-opacity-20 flex items-center justify-center p-8 pointer-events-none">
            <div className="w-full h-full border-4 border-dashed border-white/50 rounded-lg"/>
        </div>
      </div>
      
      <form onSubmit={handleManualSubmit} className="mb-4">
          <label className="block text-[10px] font-black text-[var(--text-muted)] uppercase tracking-widest mb-1.5">Ingreso Manual (Si el código no es legible)</label>
          <div className="flex gap-2">
              <input 
                  type="text"
                  placeholder="Ingresa ID o Código de Envío..."
                  value={manualCode}
                  onChange={(e) => setManualCode(e.target.value)}
                  className="flex-1 px-4 py-2.5 bg-[var(--background-muted)] border border-[var(--border-secondary)] rounded-lg text-sm font-bold focus:ring-2 focus:ring-blue-500 outline-none"
              />
              <button 
                  type="submit"
                  disabled={!manualCode.trim() || isManualProcessing}
                  className="px-6 py-2.5 bg-blue-600 text-white font-bold rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 flex items-center gap-2"
              >
                  {isManualProcessing ? <IconLoader className="w-4 h-4 animate-spin" /> : <IconChevronLeft className="w-4 h-4 rotate-180" />}
                  Asignar
              </button>
          </div>
      </form>

      <div className="text-center my-4 p-3 bg-[var(--background-muted)] rounded-lg flex justify-between items-center px-6">
        <div className="text-left">
            <span className="text-sm font-semibold text-[var(--text-secondary)] block">Total Despachado</span>
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
            <div className={`flex items-center p-4 rounded-md text-white shadow-lg transition-all transform scale-105 ${scanResult.type === 'success' ? 'bg-green-600' : scanResult.type === 'info' ? 'bg-blue-600' : 'bg-red-500'}`}>
                {scanResult.type === 'success' ? <IconCheckCircle className="w-6 h-6 mr-3" /> : scanResult.type === 'info' ? <IconLoader className="w-6 h-6 mr-3 animate-spin" /> : <IconAlertTriangle className="w-6 h-6 mr-3" />}
                <div className="flex flex-col">
                    <span className="font-medium text-lg">{scanResult.message}</span>
                    {scanResult.type === 'success' && user?.driverPermissions?.canZoning === true && systemSettings?.gisSectorsEnabled && scanResult.package?.recipientCommune && (
                        <span className="text-xs font-bold bg-black bg-opacity-20 px-2 py-0.5 rounded mt-1 text-yellow-200 w-fit">
                            Comuna: {scanResult.package.recipientCommune}
                            {scanResult.package.sectorName ? ` | ${scanResult.package.sectorName}` : ''}
                        </span>
                    )}
                </div>
            </div>
        ) : (
             <p className="text-center text-[var(--text-muted)] text-sm animate-pulse">Apunta la cámara al código del paquete para agregarlo a tu ruta de despacho.</p>
        )}
      </div>

      <div className="mt-6 flex flex-col gap-3">
        <button 
          onClick={() => setIsManualEntryOpen(true)}
          className="w-full px-4 py-3 text-base font-semibold text-white bg-[var(--brand-primary)] rounded-lg hover:bg-[var(--brand-hover)] transition-all shadow-sm flex items-center justify-center gap-2"
        >
          <IconPencil className="w-5 h-5" /> Ingreso Manual Rápido
        </button>
        <button 
          onClick={onBack}
          className="w-full px-4 py-2 text-base font-medium text-[var(--text-secondary)] bg-[var(--background-secondary)] border border-[var(--border-secondary)] rounded-lg hover:bg-[var(--background-hover)] flex items-center justify-center gap-2"
        >
          <IconChevronLeft className="w-5 h-5" /> Volver
        </button>
      </div>

      {isManualEntryOpen && (
          <div className="fixed inset-0 z-50 flex justify-center items-center bg-black bg-opacity-70 p-4 animate-fade-in-up">
            <div className="bg-[var(--background-secondary)] rounded-xl shadow-2xl w-full max-w-md p-6 relative">
                <button onClick={() => setIsManualEntryOpen(false)} className="absolute top-4 right-4 p-2 text-[var(--text-muted)] hover:bg-[var(--background-hover)] rounded-full"><IconX className="w-6 h-6"/></button>
                <h3 className="text-lg font-bold text-[var(--text-primary)] text-center mb-4">Ingreso Manual de Código</h3>
                
                <div className="mb-6">
                     <input
                        type="text"
                        placeholder="Ingrese código de paquete"
                        value={manualCode}
                        onChange={(e) => setManualCode(e.target.value)}
                        className="block w-full text-center text-xl font-bold py-3 border-2 border-[var(--brand-primary)] rounded-md bg-[var(--background-muted)] text-[var(--text-primary)] focus:outline-none focus:ring-4 focus:ring-[var(--brand-muted)]"
                        autoFocus
                    />
                </div>

                <button 
                    onClick={() => {
                        handleScan(manualCode, true);
                        setManualCode('');
                        setIsManualEntryOpen(false);
                    }}
                    disabled={!manualCode.trim()}
                    className="w-full px-4 py-3 text-base font-semibold text-white bg-[var(--brand-primary)] rounded-lg hover:bg-[var(--brand-hover)] transition-colors shadow-sm disabled:bg-slate-400 disabled:cursor-not-allowed"
                >
                    Despachar Paquete
                </button>
            </div>
          </div>
      )}

      {reassignConfirm && (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[9999] flex items-center justify-center p-4">
              <div className="bg-white dark:bg-gray-800 rounded-2xl max-w-sm w-full p-6 shadow-2xl border border-gray-100 animate-fade-in-up">
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

      <style>{`
        @keyframes fade-in-up {
            from { opacity: 0; transform: translateY(10px); }
            to { opacity: 1; transform: translateY(0); }
        }
        .animate-fade-in-up {
            animation: fade-in-up 0.3s ease-out forwards;
        }
      `}</style>
    </div>
  );
};

export default ScanDispatchPage;