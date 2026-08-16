import React, { useEffect, useState, useContext } from 'react';
import { createPortal } from 'react-dom';
import { IconX, IconPrinter } from '../Icon';
import { Package } from '../../types';
import ShippingLabel from './ShippingLabel';
import { LabelFormat, PackageSource } from '../../constants';
import { api } from '../../services/api';
import { AuthContext } from '../../contexts/AuthContext';

interface BatchShippingLabelModalProps {
  packages: Package[];
  creatorName: string;
  onClose: () => void;
}

const formatOptions = [
    { id: LabelFormat.CompactThermal, name: 'Diseño 1', size: '100x150mm' },
    { id: LabelFormat.FullThermal, name: 'Diseño 2', size: '100x150mm' },
    { id: LabelFormat.ZebraZpl, name: 'Diseño 3', size: '4"x6"' },
    { id: LabelFormat.A4Single, name: 'Diseño 4', size: 'Hoja Carta' },
    { id: LabelFormat.A4Half, name: 'Diseño 5', size: 'Media Carta' },
    { id: LabelFormat.MinimalSticker, name: 'Diseño 6', size: 'A6 / 105x148' },
    { id: LabelFormat.LetterMulti, name: 'Hoja Carta (x4)', size: '8.5"x11" (x4)' },
    { id: LabelFormat.Thermal10x8, name: 'Diseño 7', size: '100x80mm' },
];

const BatchShippingLabelModal: React.FC<BatchShippingLabelModalProps> = ({ packages: initialPackages, creatorName, onClose }) => {
    const { user } = useContext(AuthContext)!;
    const [packages, setPackages] = useState<Package[]>(initialPackages);
    // Hardcode Carta as default
    const [format, setFormat] = useState<LabelFormat>(LabelFormat.LetterMulti);
    const [loadingIds, setLoadingIds] = useState<Set<string>>(new Set());
    const [progress, setProgress] = useState(0);
    const [isMultiLabel, setIsMultiLabel] = useState(false);
    const [letterDesign, setLetterDesign] = useState<LabelFormat>(LabelFormat.CompactThermal);
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        setMounted(true);
        return () => setMounted(false);
    }, []);

    // Effect to fetch authentic ML tracking IDs for all packages in batch
    useEffect(() => {
        const fetchAllMeliTrackings = async () => {
             const mlPackages = initialPackages.filter(p => p.source === PackageSource.MercadoLibre && !p.trackingId);
             if (mlPackages.length === 0) return;

             setLoadingIds(new Set(mlPackages.map(p => p.id)));
             
             for (let i = 0; i < mlPackages.length; i++) {
                 const pkg = mlPackages[i];
                 try {
                     const result = await api.getMeliTracking(pkg.id);
                     if (result.trackingId) {
                         setPackages(prev => prev.map(p => p.id === pkg.id ? { ...p, trackingId: result.trackingId } : p));
                     }
                 } catch (err) {
                     console.error(`Error fetching ML tracking for ${pkg.id}:`, err);
                 } finally {
                     setLoadingIds(prev => {
                         const next = new Set(prev);
                         next.delete(pkg.id);
                         return next;
                     });
                     setProgress(Math.round(((i + 1) / mlPackages.length) * 100));
                 }
             }
        };
        fetchAllMeliTrackings();
    }, [initialPackages]);

    const handlePrint = () => {
        window.print();
    };

    const isScaleFormat = format === LabelFormat.CompactThermal || format === LabelFormat.FullThermal || format === LabelFormat.ZebraZpl || format === LabelFormat.MinimalSticker || format === LabelFormat.LetterMulti || format === LabelFormat.Thermal10x8;

    const printableArea = (
        <div 
            id="print-portal-container"
            className={`batch-print-container format-${format} ${isMultiLabel ? 'is-multi-label' : ''}`}
            style={{
                position: 'fixed',
                top: '0',
                left: '0',
                width: '100%',
                height: 'auto',
                overflow: 'visible',
                visibility: 'hidden',
                pointerEvents: 'none',
                zIndex: -100
            }}
        >
            {format === LabelFormat.LetterMulti || isMultiLabel ? (
                // Chunk by 4 for Letter Multi (2x2 grid per page)
                Array.from({ length: Math.ceil(packages.length / 4) }).map((_, pageIdx, pageArr) => (
                    <div key={pageIdx} className={`letter-page ${pageIdx < pageArr.length - 1 ? 'print-page-break' : ''}`}>
                        <div className="letter-grid">
                            {packages.slice(pageIdx * 4, pageIdx * 4 + 4).map((pkg) => (
                                <div key={pkg.id} className="label-wrapper-letter">
                                    <ShippingLabel pkg={pkg} creatorName={creatorName} creatorLogoBase64={user?.logoBase64} format={format === LabelFormat.LetterMulti ? letterDesign : format} />
                                </div>
                            ))}
                        </div>
                    </div>
                ))
            ) : (
                packages.map((pkg, idx) => (
                    <div key={pkg.id} className={`label-wrapper ${idx < packages.length - 1 ? 'print-page-break' : 'last-label'}`}>
                        <ShippingLabel pkg={pkg} creatorName={creatorName} creatorLogoBase64={user?.logoBase64} format={format} />
                    </div>
                ))
            )}
        </div>
    );

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
                         <div className="p-2.5 bg-indigo-100 rounded-lg">
                            <IconPrinter className="w-6 h-6 text-indigo-600" />
                        </div>
                        <div className="flex flex-col">
                            <h3 className="text-xl font-bold text-[var(--text-primary)]">Formato de Datos (Masivo)</h3>
                            <p className="text-xs text-[var(--text-muted)] font-medium">Imprimiendo {packages.length} etiquetas</p>
                        </div>
                    </div>
                    
                    <div className="flex items-center space-x-3">
                        <div className="flex items-center space-x-2 bg-[var(--background-muted)] px-3 py-1.5 rounded-xl border border-[var(--border-primary)]">
                             <span className="text-xs font-bold text-[var(--text-muted)]">Papel:</span>
                             <select 
                                value={format} 
                                onChange={(e) => {
                                    setFormat(e.target.value as LabelFormat);
                                    if (e.target.value === LabelFormat.LetterMulti) {
                                        setIsMultiLabel(false);
                                    }
                                }}
                                className="bg-transparent border-none text-sm font-black text-[var(--text-primary)] focus:ring-0 cursor-pointer"
                             >
                                {formatOptions.map(opt => <option key={opt.id} value={opt.id}>{opt.name} ({opt.size})</option>)}
                             </select>
                        </div>

                        {format === LabelFormat.LetterMulti && (
                             <div className="flex items-center space-x-2 bg-[var(--background-muted)] px-3 py-1.5 rounded-xl border border-[var(--border-primary)] animate-fade-in">
                                <span className="text-xs font-bold text-indigo-600">Diseño:</span>
                                <select 
                                    value={letterDesign} 
                                    onChange={(e) => setLetterDesign(e.target.value as LabelFormat)}
                                    className="bg-transparent border-none text-sm font-black text-[var(--text-primary)] focus:ring-0 cursor-pointer"
                                >
                                    <option value={LabelFormat.CompactThermal}>Diseño 1</option>
                                    <option value={LabelFormat.FullThermal}>Diseño 2</option>
                                    <option value={LabelFormat.ZebraZpl}>Diseño 3</option>
                                    <option value={LabelFormat.MinimalSticker}>Diseño 6</option>
                                </select>
                           </div>
                        )}
                    </div>

                    <div className="flex items-center space-x-6">
                        {(format !== LabelFormat.LetterMulti && format !== LabelFormat.A4Single && format !== LabelFormat.A4Half) && (
                            <label className="flex items-center space-x-2 cursor-pointer bg-white/50 px-3 py-1.5 rounded-xl border border-[var(--border-primary)] hover:bg-white/80 transition-colors">
                                <input 
                                    type="checkbox" 
                                    checked={isMultiLabel} 
                                    onChange={(e) => setIsMultiLabel(e.target.checked)}
                                    className="w-4 h-4 text-indigo-600 border-gray-300 rounded focus:ring-indigo-500"
                                />
                                <span className="text-xs font-black text-[var(--text-primary)]">Varias por hoja (Carta)</span>
                            </label>
                        )}

                        <button onClick={onClose} className="p-2 rounded-full text-[var(--text-muted)] hover:bg-[var(--background-hover)] transition-all">
                            <IconX className="w-6 h-6" />
                        </button>
                    </div>
                </header>

                <div className="flex-1 overflow-y-auto p-10 bg-slate-200 shadow-inner custom-scrollbar">
                    {loadingIds.size > 0 && (
                        <div className="mb-6 bg-white p-4 rounded-xl border border-black shadow-sm animate-pulse">
                             <div className="flex justify-between items-center mb-2">
                                <p className="text-sm font-bold text-black uppercase tracking-tighter">Autenticando etiquetas con Mercado Libre...</p>
                                <p className="text-xs font-black">{progress}%</p>
                             </div>
                             <div className="w-full bg-gray-200 h-2 rounded-full overflow-hidden">
                                <div className="bg-black h-full transition-all duration-300" style={{ width: `${progress}%` }}></div>
                             </div>
                        </div>
                    )}
                    
                    <div className={`grid gap-10 items-start justify-items-center ${format === LabelFormat.LetterMulti || isMultiLabel ? 'grid-cols-1 lg:grid-cols-2' : 'grid-cols-1 md:grid-cols-2'}`}>
                        {packages.map((pkg) => (
                            <div key={pkg.id} className={`bg-white shadow-2xl relative ${isScaleFormat ? (format === LabelFormat.LetterMulti || isMultiLabel ? 'scale-90' : 'scale-75') : 'w-full'} origin-top`}>
                                <div className="absolute top-2 right-2 flex space-x-1 print:hidden z-10">
                                     {loadingIds.has(pkg.id) && <div className="w-4 h-4 border-2 border-black border-t-transparent rounded-full animate-spin"></div>}
                                     {pkg.source === PackageSource.MercadoLibre && !loadingIds.has(pkg.id) && pkg.trackingId && <div className="text-[10px] font-black bg-black text-white px-2 py-0.5 rounded-full">SCA OK</div>}
                                </div>
                                <ShippingLabel pkg={pkg} creatorName={creatorName} creatorLogoBase64={user?.logoBase64} format={format === LabelFormat.LetterMulti ? letterDesign : (isMultiLabel ? format : format)} />
                            </div>
                        ))}
                    </div>
                </div>

                <footer className="px-8 py-5 bg-[var(--background-secondary)] rounded-b-2xl flex justify-between items-center border-t border-[var(--border-primary)]">
                    <p className="text-xs font-bold text-gray-400 italic">CONSEJO: Asegúrate de que el tamaño del papel en la configuración de tu navegador coincida con el diseño seleccionado.</p>
                    <div className="flex space-x-3">
                        <button type="button" onClick={onClose} className="px-6 py-2.5 text-sm font-bold text-[var(--text-secondary)] bg-[var(--background-secondary)] border-2 border-[var(--border-secondary)] rounded-xl hover:bg-[var(--background-hover)]">Cancelar</button>
                        <button 
                            type="button" 
                            disabled={loadingIds.size > 0}
                            onClick={handlePrint} 
                            className="px-8 py-2.5 text-sm font-black text-white bg-black rounded-xl shadow-lg hover:translate-y-[-2px] transition-all disabled:opacity-50"
                        >
                            Imprimir {packages.length} Etiquetas
                        </button>
                    </div>
                </footer>
            </div>
        </div>

        {/* Portal for printing - Outside of #root div during print events */}
        {mounted && createPortal(printableArea, document.body)}

        <style>{`
            @media print {
              @page {
                margin: 0;
                padding: 0;
                ${!isMultiLabel && (format === LabelFormat.CompactThermal || format === LabelFormat.FullThermal || format === LabelFormat.ZebraZpl) ? 'size: 100mm 150mm; margin: 0;' : ''}
                ${!isMultiLabel && format === LabelFormat.Thermal10x8 ? 'size: 100mm 80mm; margin: 0;' : ''}
                ${format === LabelFormat.A4Single || format === LabelFormat.A4Half || format === LabelFormat.LetterMulti || isMultiLabel ? 'size: letter; margin: 0;' : ''}
                ${!isMultiLabel && format === LabelFormat.MinimalSticker ? 'size: 105mm 148mm; margin: 0;' : ''}
              }

              /* Hide everything related to #root and UI */
              body > *:not(.batch-print-container) {
                display: none !important;
                visibility: hidden !important;
              }

              /* Ensure Portal container is visible */
              .batch-print-container {
                visibility: visible !important;
                display: block !important;
                position: relative !important;
                top: 0 !important;
                left: 0 !important;
                width: 100% !important;
                height: auto !important;
                opacity: 1 !important;
                pointer-events: auto !important;
                z-index: 999999 !important;
                background: white !important;
                overflow: visible !important;
              }

              .batch-print-container * {
                visibility: visible !important;
                display: block !important;
              }

              .batch-print-container.is-multi-label,
              .batch-print-container.format-letter_multi .letter-grid {
                display: grid !important;
              }

              /* Letter Multi-label (2x2) */
              .letter-page {
                width: 8.5in;
                height: 10.5in; /* Conservative safe height for Letter size */
                max-height: 10.5in;
                padding: 0; 
                margin: 0;
                page-break-after: auto;
                page-break-inside: avoid;
                background-color: white;
                display: block !important;
                overflow: hidden;
                box-sizing: border-box;
              }
              .letter-grid {
                display: grid !important;
                grid-auto-flow: row;
                grid-template-columns: repeat(2, 1fr);
                grid-template-rows: repeat(2, 1fr);
                width: 100%;
                height: 100%;
                gap: 0;
              }
               .label-wrapper-letter {
                width: 100%;
                height: 5.25in; /* Exactly half of the grid bounds */
                max-height: 5.25in;
                display: flex !important;
                align-items: center;
                justify-content: center;
                overflow: hidden;
                box-sizing: border-box;
              }
               .label-wrapper-letter > div {
                 /* Zoom actually recalculates layout bounds in Chromium, preventing page jumps */
                 zoom: 0.82;
                 /* Fallback scale */
                 transform: scale(0.82); 
                 transform-origin: center center;
               }

              .print-page-break {
                page-break-after: always;
                page-break-inside: avoid;
                display: flex !important;
                align-items: center;
                justify-content: center;
                width: 100%;
              }

              .label-wrapper {
                 width: 100%;
                 height: 100vh;
                 padding-top: 5mm; /* Anti-cut safety margin */
                 display: flex !important;
                 align-items: center;
                 justify-content: center;
                 page-break-after: auto;
                 box-sizing: border-box;
              }

              .is-multi-label .label-wrapper {
                 height: 5.5in;
              }

              .is-multi-label .label-wrapper > div {
                 transform: scale(0.96);
                 transform-origin: center center;
              }

              .last-label {
                page-break-after: avoid !important;
              }
            }
        `}</style>
        </>
    );
};

export default BatchShippingLabelModal;
