import React, { useEffect, useState, useContext } from 'react';
import { createPortal } from 'react-dom';
import { IconX, IconCheck, IconSettings } from '../Icon';
import { Package } from '../../types';
import ShippingLabel from './ShippingLabel';
import { LabelFormat, PackageSource } from '../../constants';
import { AuthContext } from '../../contexts/AuthContext';
import { api } from '../../services/api';

interface ShippingLabelModalProps {
  pkg: Package;
  creatorName: string;
  onClose: () => void;
}

const formatOptions = [
    { id: LabelFormat.CompactThermal, name: 'Diseño 1', size: '100x150mm', desc: 'Logístico (Comuna XL)' },
    { id: LabelFormat.FullThermal, name: 'Diseño 2', size: '100x150mm', desc: 'Identidad (Nombre / RUT)' },
    { id: LabelFormat.ZebraZpl, name: 'Diseño 3', size: '4"x6"', desc: 'Industrial (QR Lateral)' },
    { id: LabelFormat.A4Single, name: 'Diseño 4', size: 'Hoja A4', desc: 'Instrucciones (Notas XL)' },
    { id: LabelFormat.A4Half, name: 'Diseño 5', size: 'Hoja A4 (x2)', desc: 'Despacho (Tracking Pro)' },
    { id: LabelFormat.MinimalSticker, name: 'Diseño 6', size: 'A6 / 105x148', desc: 'Compacto (Full Info)' },
    { id: LabelFormat.Thermal10x8, name: 'Diseño 7', size: '100x80mm', desc: 'Térmica 10x8 (Rotada)' },
];

const ShippingLabelModal: React.FC<ShippingLabelModalProps> = ({ pkg: initialPkg, creatorName, onClose }) => {
    const { systemSettings, user } = useContext(AuthContext)!;
    const [pkg, setPkg] = useState<Package>(initialPkg);
    const [format, setFormat] = useState<LabelFormat>(systemSettings.labelFormat || LabelFormat.CompactThermal);
    const [loadingTracking, setLoadingTracking] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        setMounted(true);
        return () => setMounted(false);
    }, []);

    // Effect to fetch authentic ML tracking ID if missing
    useEffect(() => {
        const fetchMeliTracking = async () => {
            if (initialPkg.source === PackageSource.MercadoLibre && !initialPkg.trackingId) {
                setLoadingTracking(true);
                try {
                    const result = await api.getMeliTracking(initialPkg.id);
                    if (result.trackingId) {
                        setPkg(prev => ({ ...prev, trackingId: result.trackingId }));
                    }
                } catch (err: any) {
                    console.error('Error fetching ML tracking:', err);
                    setError('No se pudo obtener el QR original de Mercado Libre. Se usará el ID de respaldo.');
                } finally {
                    setLoadingTracking(false);
                }
            }
        };
        fetchMeliTracking();
    }, [initialPkg]);

    const handlePrint = () => {
        window.print();
    };

    return (
        <>
        <div
            className="fixed inset-0 bg-black bg-opacity-70 z-50 flex justify-center items-center p-4 print:hidden backdrop-blur-sm"
            onClick={onClose}
        >
            <div
                className="bg-[var(--background-secondary)] rounded-2xl shadow-2xl w-full max-w-5xl h-[95vh] flex flex-col animate-fade-in-up border border-[var(--border-primary)]"
                onClick={(e) => e.stopPropagation()}
            >
                <header className="flex items-center justify-between p-5 border-b border-[var(--border-primary)]">
                    <div className="flex items-center space-x-3">
                        <div className="p-2.5 bg-black rounded-lg">
                            <IconSettings className="w-6 h-6 text-white" />
                        </div>
                        <div className="flex flex-col">
                            <h3 className="text-xl font-bold text-[var(--text-primary)]">Diseño de Información de Etiqueta</h3>
                            <p className="text-xs text-[var(--text-muted)] font-medium uppercase tracking-wider">
                                {loadingTracking ? 'Autenticando datos...' : 'Selecciona la forma en que aparecen los datos'}
                            </p>
                        </div>
                    </div>
                    <button onClick={onClose} className="p-2 rounded-full text-[var(--text-muted)] hover:bg-[var(--background-hover)] transition-colors">
                        <IconX className="w-6 h-6" />
                    </button>
                </header>

                <div className="flex flex-1 min-h-0 bg-[var(--background-muted)] overflow-hidden">
                    {/* Visual Design Selector Sidebar */}
                    <div className="w-80 bg-[var(--background-secondary)] border-r border-[var(--border-primary)] p-4 overflow-y-auto space-y-3">
                        <p className="text-[10px] font-bold text-[var(--text-muted)] uppercase tracking-widest px-2 mb-2 italic">Opciones de Diseño</p>
                        <div className="grid grid-cols-1 gap-3">
                            {formatOptions.map((opt) => (
                                <button 
                                    key={opt.id}
                                    onClick={() => setFormat(opt.id)}
                                    className={`w-full text-left p-4 rounded-xl border-2 transition-all flex flex-col relative group ${
                                        format === opt.id 
                                        ? 'border-black bg-black text-white' 
                                        : 'border-[var(--border-primary)] hover:border-black hover:bg-[var(--background-hover)]'
                                    }`}
                                >
                                    <div className="flex justify-between items-start">
                                        <span className={`text-md font-black ${format === opt.id ? 'text-white' : 'text-black'}`}>
                                            {opt.name}
                                        </span>
                                        {format === opt.id && <IconCheck className="w-5 h-5 text-white" />}
                                    </div>
                                    <span className={`text-[11px] font-bold mt-1 ${format === opt.id ? 'text-gray-300' : 'text-gray-500'}`}>
                                        {opt.desc}
                                    </span>
                                    <div className={`mt-2 h-1 w-0 group-hover:w-full transition-all duration-300 ${format === opt.id ? 'bg-white/30' : 'bg-black/20'}`}></div>
                                </button>
                            ))}
                        </div>

                        {error && (
                            <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg">
                                <p className="text-[10px] text-red-600 font-bold leading-tight">{error}</p>
                            </div>
                        )}
                    </div>

                    {/* Preview Area */}
                    <div className="flex-1 overflow-auto p-12 flex flex-col items-center justify-start custom-scrollbar bg-slate-200 shadow-inner">
                        <div className={`bg-white shadow-[0_35px_60px_-15px_rgba(0,0,0,0.5)] scale-90 origin-top transform transition-transform duration-300`}>
                             <ShippingLabel pkg={pkg} creatorName={creatorName} creatorLogoBase64={user?.logoBase64} format={format} />
                        </div>
                    </div>
                </div>

                <footer className="px-8 py-5 bg-[var(--background-secondary)] rounded-b-2xl flex justify-between items-center border-t border-[var(--border-primary)]">
                    <div className="flex items-center space-x-2 text-[var(--text-muted)]">
                       <span className="text-xs font-bold text-black bg-yellow-400 px-3 py-1 rounded-full">{formatOptions.find(f => f.id === format)?.name} SELECCIONADO</span>
                    </div>
                    <div className="flex space-x-3">
                        <button type="button" onClick={onClose} className="px-6 py-2.5 text-sm font-bold text-[var(--text-secondary)] bg-[var(--background-secondary)] border-2 border-[var(--border-secondary)] rounded-xl hover:bg-[var(--background-hover)] transition-all">Cancelar</button>
                        <button 
                            type="button" 
                            onClick={handlePrint} 
                            disabled={loadingTracking}
                            className={`px-10 py-3 text-sm font-black text-white bg-black rounded-xl shadow-xl hover:translate-y-[-2px] active:translate-y-[0] transition-all disabled:opacity-50 disabled:grayscale`}
                        >
                            Imprimir con este Diseño
                        </button>
                    </div>
                </footer>
            </div>
        </div>
        
        {mounted && createPortal(
            <div 
                className={`label-print-container format-${format}`}
                style={{
                    position: 'fixed',
                    top: '0',
                    left: '0',
                    width: '100%',
                    height: '100vh',
                    overflow: 'hidden',
                    visibility: 'hidden',
                    pointerEvents: 'none',
                    zIndex: -100
                }}
            >
                <ShippingLabel pkg={pkg} creatorName={creatorName} creatorLogoBase64={user?.logoBase64} format={format} />
            </div>,
            document.body
        )}

        <style>{`
            @media print {
              @page {
                margin: 0;
                padding: 0;
                ${format === LabelFormat.CompactThermal || format === LabelFormat.FullThermal || format === LabelFormat.ZebraZpl ? 'size: 100mm 150mm; margin: 0;' : ''}
                ${format === LabelFormat.Thermal10x8 ? 'size: 100mm 80mm; margin: 0;' : ''}
                ${format === LabelFormat.A4Single ? 'size: letter; margin: 0;' : ''}
                ${format === LabelFormat.A4Half ? 'size: letter; margin: 0;' : ''}
                ${format === LabelFormat.MinimalSticker ? 'size: 105mm 148mm; margin: 0;' : ''}
              }
              body > *:not(.label-print-container), #root {
                display: none !important;
                visibility: hidden !important;
              }
              .label-print-container {
                visibility: visible !important;
                display: flex !important;
                align-items: center;
                justify-content: center;
                position: relative !important;
                top: 0 !important;
                left: 0 !important;
                width: 100% !important;
                height: 100vh !important;
                margin: 0 !important;
                padding: 5mm 0 0 0 !important; /* Anti-cut safety margin */
                box-sizing: border-box;
                transform: scale(0.95);
                transform-origin: center center;
                background: white !important;
                pointer-events: auto !important;
                z-index: 999999 !important;
              }
              .label-print-container * {
                visibility: visible !important;
              }
            }
        `}</style>
        </>
    );
};

export default ShippingLabelModal;
