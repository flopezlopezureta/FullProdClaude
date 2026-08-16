import React, { useEffect, useState, useContext } from 'react';
import QRCode from 'qrcode';
import { Package } from '../../types';
import { AuthContext } from '../../contexts/AuthContext';
import { LabelFormat, PackageSource } from '../../constants';

interface ShippingLabelProps {
  pkg: Package;
  creatorName: string;
  creatorLogoBase64?: string;
  format?: LabelFormat;
}

const ShippingLabel: React.FC<ShippingLabelProps> = ({ pkg, creatorName, creatorLogoBase64, format = LabelFormat.CompactThermal }) => {
    const [qrCodeUrl, setQrCodeUrl] = useState('');
    const { systemSettings } = useContext(AuthContext)!;

    const isMeli = pkg.source === PackageSource.MercadoLibre;
    
    // Format date for display (Example: "2 ABR")
    const tz = systemSettings.timezone || 'America/Santiago';
    const dateObj = pkg.createdAt ? new Date(pkg.createdAt) : new Date();
    const formattedDate = `${dateObj.getDate()} ${dateObj.toLocaleDateString('es-CL', { month: 'short', timeZone: tz }).toUpperCase().replace('.', '')}`;

    // Version: 2.3.4 - Global Font Reduction
    // Determine QR content for Driver (Flexeo)
    let qrContent = pkg.id;
    if (isMeli) {
        qrContent = pkg.trackingId || pkg.meliFlexCode || pkg.meliOrderId || pkg.id;
    } else {
        qrContent = pkg.trackingId || pkg.id;
    }

    let refNumber = pkg.falabellaTrackingId || pkg.falabellaOrderId || pkg.shopifyOrderNumber || pkg.shopifyOrderId || pkg.wooOrderId || pkg.jumpsellerOrderId || pkg.meliOrderId || pkg.meliFlexCode;
    let secondaryRef = (pkg.shopifyOrderNumber && pkg.shopifyOrderId && pkg.shopifyOrderNumber !== pkg.shopifyOrderId) ? pkg.shopifyOrderId : null;

    // Custom format for Shopify if both references exist: "Short / Long"
    if (pkg.source === PackageSource.Shopify && pkg.shopifyOrderNumber && pkg.shopifyOrderId && pkg.shopifyOrderNumber !== pkg.shopifyOrderId) {
        refNumber = `${pkg.shopifyOrderNumber} / ${pkg.shopifyOrderId}`;
        secondaryRef = null; // Clear secondary to avoid duplication
    }

    useEffect(() => {
        const generateQR = async () => {
            try {
                const qrUrl = await QRCode.toDataURL(qrContent, {
                    errorCorrectionLevel: 'M',
                    type: 'image/png',
                    width: 600,
                    margin: 1,
                    color: { dark: '#000000', light: '#ffffff' }
                });
                setQrCodeUrl(qrUrl);
            } catch (err) {
                console.error('Failed to generate QR code', err);
            }
        };
        generateQR();
    }, [qrContent]);

    // --- 6 DISEÑOS DE INFORMACIÓN ---
    
    // DISEÑO 1: ENFOQUE LOGÍSTICO (COMUNA XL -> L)
    if (format === LabelFormat.CompactThermal) {
        return (
            <div className="bg-white p-5 font-sans text-black w-[100mm] h-[150mm] border-4 border-black flex flex-col overflow-hidden">
                <div className="text-center mb-2">
                    {creatorLogoBase64 && (
                        <img src={creatorLogoBase64} alt="" className="h-8 max-w-[50mm] mx-auto mb-1 object-contain" />
                    )}
                    <h2 className="text-md font-black tracking-tight leading-none">{systemSettings.companyName.toUpperCase()}</h2>
                    <div className="flex flex-row flex-nowrap justify-between items-center mt-1.5 border-y border-black/10 py-1 px-2 overflow-hidden">
                        <span className="text-[10px] font-black text-black uppercase truncate max-w-[60mm] text-left">{creatorName}</span>
                        <span className="text-[10px] font-black text-black whitespace-nowrap text-right">{formattedDate}</span>
                    </div>
                </div>
                <div className="bg-white text-black p-3 text-center border-2 border-black rounded-xl mb-4">
                    <p className="text-[9px] font-black uppercase tracking-[0.3em] mb-1 opacity-50">Destino Prioritario</p>
                    <p className={`font-[1000] uppercase leading-none ${pkg.recipientCommune.length > 12 ? 'text-2xl' : 'text-3xl'}`}>{pkg.recipientCommune}</p>
                </div>
                <div className="flex-1 space-y-3">
                    <div className="border-l-2 border-black pl-3">
                        <p className="text-[9px] font-black uppercase text-gray-400">Entrega para:</p>
                        <p className="text-lg font-black leading-none">{pkg.recipientName}</p>
                        <div className="flex space-x-2 items-center mt-1">
                             {pkg.recipientPhone && <p className="text-sm font-bold">📞 {pkg.recipientPhone}</p>}
                             {pkg.recipientRut && <p className="text-sm font-bold opacity-60">RUT: {pkg.recipientRut}</p>}
                        </div>
                    </div>
                    <div className="pt-2 border-t border-dashed border-gray-300">
                        <p className="text-[9px] font-black uppercase text-gray-400">Dirección:</p>
                        <p className="text-md font-bold leading-tight">{pkg.recipientAddress}</p>
                        <p className="text-xs font-medium mt-1 italic text-gray-600">{pkg.recipientCommune}, {pkg.recipientCity}</p>
                    </div>
                </div>
                <div className="mt-auto border-t border-black pt-3 flex items-center justify-between">
                    <div className="flex flex-col items-center">
                        {qrCodeUrl && <img src={qrCodeUrl} alt="QR" className="w-28 h-28" style={{ imageRendering: 'pixelated' }} />}
                    </div>
                    <div className="flex-1 pl-4 text-right flex flex-col justify-end">
                         {refNumber && (
                             <div className="mb-2">
                                 <p className="text-[8px] font-bold text-gray-400 uppercase leading-none">Orden / REF:</p>
                                 <p className={`${(refNumber?.toString().length || 0) > 15 ? 'text-lg' : 'text-2xl'} font-black leading-none tracking-tighter`}>{refNumber}</p>
                                 {secondaryRef && <p className="text-[10px] font-bold opacity-60 leading-none mt-1">({secondaryRef})</p>}
                             </div>
                         )}
                         <div className="mt-auto">
                             <p className="text-[7px] font-bold text-gray-400 uppercase leading-none">ID Operativo:</p>
                             <p className="text-[10px] font-mono font-black break-all leading-tight">{qrContent}</p>
                             <div className="w-full h-1.5 bg-black mt-1"></div>
                         </div>
                    </div>
                </div>
            </div>
        );
    }

    // DISEÑO 2: ENFOQUE IDENTIDAD (NOMBRE & RUT)
    if (format === LabelFormat.FullThermal) {
        return (
            <div className="bg-white p-4 font-sans text-black w-[100mm] h-[150mm] border-2 border-black flex flex-col overflow-hidden">
                <div className="bg-black text-white p-1.5 text-center mb-1">
                    <p className="text-lg font-black tracking-tighter">IDENTIFICACIÓN DE ENTREGA</p>
                </div>
                <div className="flex justify-between items-center px-4 mb-2 bg-gray-50 border-b border-black py-1">
                    <div className="text-left flex-1 overflow-hidden pr-2 flex items-center gap-2">
                        {creatorLogoBase64 && <img src={creatorLogoBase64} alt="" className="h-6 max-w-[20mm] object-contain flex-shrink-0" />}
                        <p className="text-[11px] font-black text-black truncate uppercase">{creatorName}</p>
                    </div>
                    <div className="text-right whitespace-nowrap">
                        <p className="text-[11px] font-black text-black">{formattedDate}</p>
                    </div>
                </div>
                <div className="flex-1 flex flex-col items-center justify-center text-center space-y-4">
                    <div className="w-full border-b border-black pb-4">
                         <p className="text-[9px] font-black uppercase text-gray-400 mb-2 tracking-widest">Titular de la Orden:</p>
                         <p className={`font-black leading-none break-words underline underline-offset-4 ${pkg.recipientName.length > 20 ? 'text-xl' : 'text-2xl'}`}>{pkg.recipientName}</p>
                         {pkg.recipientPhone && <p className="text-md font-bold mt-2">📞 {pkg.recipientPhone}</p>}
                    </div>
                    <div className="flex justify-between w-full px-2">
                        <div className="text-left">
                            <p className="text-[8px] font-black text-gray-400 uppercase">Documento (RUT):</p>
                            <p className="text-md font-black">{pkg.recipientRut || 'NO REGISTRADO'}</p>
                        </div>
                        <div className="text-right">
                             <p className="text-[8px] font-black text-gray-400 uppercase">Comuna:</p>
                             <p className="text-md font-black">{pkg.recipientCommune}</p>
                        </div>
                    </div>
                    <div className="w-full bg-gray-50 border border-black p-2.5 rounded-lg">
                        <p className="text-[8px] font-black text-gray-400 uppercase mb-1">Punto de Entrega:</p>
                        <p className="text-sm font-bold leading-tight">{pkg.recipientAddress}</p>
                    </div>
                </div>
                <div className="mt-auto grid grid-cols-2 gap-4 border-t border-black pt-4">
                    <div className="flex flex-col justify-center">
                         {refNumber && (
                             <div className="mb-2">
                                 <p className="text-[7px] font-bold text-gray-400 uppercase leading-none">Orden / REF:</p>
                                 <p className="text-xl font-black leading-none tracking-tighter">{refNumber}</p>
                                 {secondaryRef && <p className="text-[10px] font-bold opacity-60 leading-none mt-1">({secondaryRef})</p>}
                             </div>
                         )}
                        <p className="text-[8px] font-black tracking-widest text-blue-600">DISEÑO 2</p>
                        <p className="text-[8px] font-bold mt-1 italic">{systemSettings.companyName}</p>
                    </div>
                    <div className="flex justify-end">
                         {qrCodeUrl && <img src={qrCodeUrl} alt="QR" className="w-24 h-24" style={{ imageRendering: 'pixelated' }} />}
                    </div>
                </div>
            </div>
        );
    }

    // DISEÑO 3: ENFOQUE INDUSTRIAL (SIDEBAR QR)
    if (format === LabelFormat.ZebraZpl) {
        return (
            <div className="bg-white font-sans text-black w-[101.6mm] h-[152.4mm] border border-black flex overflow-hidden">
                <div className="w-1/4 bg-white text-black p-2 flex flex-col items-center justify-between border-r border-black border-dashed">
                    <div className="rotate-90 origin-center whitespace-nowrap mt-16 max-h-[80mm] flex items-center justify-center">
                         <p className={`font-black tracking-widest leading-none ${pkg.recipientCommune.length > 12 ? 'text-sm' : 'text-md'}`}>{ (pkg.recipientCommune || '').toUpperCase()}</p>
                    </div>
                    {qrCodeUrl && <img src={qrCodeUrl} alt="QR" className="w-full p-1" style={{ imageRendering: 'pixelated' }} />}
                    <p className="text-[7px] font-black uppercase tracking-widest opacity-30">DISEÑO 3</p>
                </div>
                <div className="flex-1 p-4 flex flex-col">
                    <div className="border-b border-black pb-2 mb-3">
                        <h2 className="text-sm font-black tracking-tighter">{systemSettings.companyName}</h2>
                        <div className="mt-1 flex justify-between items-end pb-1 border-b border-gray-100">
                             <div className="flex-1 overflow-hidden pr-2">
                                <p className="text-[10px] font-black text-black uppercase truncate">{creatorName}</p>
                             </div>
                             <div className="text-right whitespace-nowrap">
                                <p className="text-[10px] font-black text-black">{formattedDate}</p>
                             </div>
                        </div>
                    </div>
                    <div className="mb-3">
                        <p className="text-[8px] font-black uppercase text-gray-500 mb-0.5">Destinatario:</p>
                        <p className="text-lg font-black leading-tight mb-0.5">{pkg.recipientName}</p>
                        <p className="text-md font-bold tracking-tighter">📞 {pkg.recipientPhone}</p>
                    </div>
                    <div className="flex-1 bg-yellow-50/30 border-b border-yellow-400 p-2">
                        <p className="text-[8px] font-black uppercase text-gray-400 mb-0.5">Dirección / Instrucciones:</p>
                        <p className="text-md font-black leading-tight">{pkg.recipientAddress}</p>
                        <p className="text-sm font-bold mt-1 italic text-gray-500">{pkg.recipientCommune}, {pkg.recipientCity}</p>
                    </div>
                    <div className="mt-3">
                         <div className="flex justify-between items-end">
                             <div>
                                 <p className="text-[7px] font-black text-gray-300 uppercase">Track ID:</p>
                                 <p className="text-[9px] font-mono font-black break-all leading-none">{qrContent}</p>
                             </div>
                             {refNumber && (
                                 <div className="text-right">
                                     <p className="text-[7px] font-black text-gray-300 uppercase">REF:</p>
                                     <p className="text-lg font-black leading-none">{refNumber}</p>
                                     {secondaryRef && <p className="text-[9px] font-bold opacity-60 leading-none mt-0.5">({secondaryRef})</p>}
                                 </div>
                             )}
                         </div>
                    </div>
                </div>
            </div>
        );
    }

    // DISEÑO 4: ENFOQUE INSTRUCCIONES (NOTAS XL)
    if (format === LabelFormat.A4Single) {
        return (
            <div className="bg-white p-8 font-sans text-black w-full h-full min-h-[297mm] flex flex-col border-4 border-gray-100">
                <div className="flex justify-between items-center border-b-2 border-black pb-4 mb-6">
                    <div className="flex items-center gap-4">
                        {creatorLogoBase64 && <img src={creatorLogoBase64} alt="" className="h-14 max-w-[35mm] object-contain flex-shrink-0" />}
                        <div>
                            <h1 className="text-2xl font-black tracking-tighter">{systemSettings.companyName.toUpperCase()}</h1>
                            <div className="flex items-center space-x-6 mt-1">
                                <p className="text-xl font-black text-black uppercase truncate max-w-[100mm]">{creatorName}</p>
                                <p className="text-xl font-black text-black border-l-2 border-black pl-6">{formattedDate}</p>
                            </div>
                        </div>
                    </div>
                    <div className="bg-black text-white px-3 py-1 font-black text-xs">DISEÑO 4</div>
                </div>
                <div className="grid grid-cols-2 gap-8 flex-1">
                    <div className="space-y-6">
                         <div className="bg-gray-50 p-6 rounded-2xl border border-black shadow-sm">
                            <p className="text-xs font-black uppercase text-gray-400 mb-2 tracking-widest">Importante / Notas:</p>
                            <p className="text-xl font-black italic leading-tight text-blue-900 break-words">
                                {pkg.notes || 'SIN OBSERVACIONES'}
                            </p>
                         </div>
                         <div className="p-3 border-l-4 border-black">
                            <p className="text-xs font-black uppercase text-gray-400">Dirección Completa:</p>
                            <p className="text-lg font-bold">{pkg.recipientAddress}</p>
                            <p className="text-md font-medium mt-1">{pkg.recipientCommune}, {pkg.recipientCity}</p>
                         </div>
                    </div>
                    <div className="flex flex-col items-center justify-start space-y-6">
                        <div className="p-4 bg-white shadow-xl border border-black rounded-lg">
                            {qrCodeUrl && <img src={qrCodeUrl} alt="QR" className="w-56 h-56" style={{ imageRendering: 'pixelated' }} />}
                        </div>
                        <div className="text-center">
                            <p className="text-xs font-black uppercase text-gray-400 mb-1">Nombre Destinatario:</p>
                            <p className="text-2xl font-black">{pkg.recipientName}</p>
                            {pkg.recipientPhone && <p className="text-xl font-bold mt-2">📞 {pkg.recipientPhone}</p>}
                        </div>
                    </div>
                </div>
                <div className="mt-auto border-t-2 border-black pt-6 flex justify-between items-end">
                    <div>
                         {refNumber && (
                             <div className="mb-2">
                                 <p className="text-sm font-bold text-gray-400 uppercase leading-none">Orden / REF:</p>
                                 <p className="text-xl font-black leading-none tracking-tighter">{refNumber}</p>
                                 {secondaryRef && <p className="text-[12px] font-bold opacity-60 leading-none mt-1">({secondaryRef})</p>}
                             </div>
                         )}
                         <p className="text-md font-mono font-black tracking-widest text-gray-400 mt-2">{qrContent}</p>
                    </div>
                    <div className="w-40 h-10 bg-black"></div>
                </div>
            </div>
        );
    }

    // DISEÑO 5: ENFOQUE DESPACHO (TRACKING ID PRO)
    if (format === LabelFormat.A4Half) {
        return (
            <div className="bg-white p-5 font-sans text-black w-full h-[148mm] border-2 border-black flex flex-col overflow-hidden relative">
                <div className="absolute top-0 right-0 bg-black text-white p-1.5 font-black text-[7px] uppercase tracking-widest leading-none">DISEÑO 5</div>
                <div className="flex justify-between items-end mb-4 border-b border-gray-100 pb-2">
                    <div className="flex items-center gap-2 flex-1 overflow-hidden pr-3">
                        {creatorLogoBase64 && <img src={creatorLogoBase64} alt="" className="h-7 max-w-[20mm] object-contain flex-shrink-0" />}
                        <p className="text-[13px] font-[1000] text-black uppercase truncate">{creatorName}</p>
                    </div>
                    <div className="text-right whitespace-nowrap">
                        <p className="text-[12px] font-black text-black border border-black px-2 py-0.5 rounded-sm bg-gray-50">{formattedDate}</p>
                    </div>
                </div>
                <div className="border-b border-black pb-2 mb-3 flex justify-between items-end">
                    <div>
                        <p className="text-[8px] font-black uppercase text-gray-400">Clave de Envío:</p>
                        <p className="text-xl font-mono font-[1000] tracking-tighter break-all leading-none">{qrContent}</p>
                    </div>
                    {refNumber && (
                        <div className="text-right">
                            <p className="text-[8px] font-black uppercase text-gray-400">Orden / REF:</p>
                            <p className="text-lg font-black tracking-tighter leading-none">{refNumber}</p>
                            {secondaryRef && <p className="text-[11px] font-bold opacity-60 leading-none mt-1">({secondaryRef})</p>}
                        </div>
                    )}
                </div>
                <div className="flex-1 grid grid-cols-2 gap-4">
                    <div className="border-r border-black pr-4 space-y-3">
                         <div>
                            <p className="text-[8px] font-black uppercase text-gray-400">Destinatario:</p>
                            <p className="text-lg font-black leading-none">{pkg.recipientName}</p>
                         </div>
                         <div>
                            <p className="text-[8px] font-black uppercase text-gray-400">Teléfono:</p>
                            <p className="text-md font-bold">{pkg.recipientPhone}</p>
                         </div>
                    </div>
                    <div className="space-y-3">
                         <div>
                            <p className="text-[8px] font-black uppercase text-gray-400">Comuna:</p>
                            <p className="text-lg font-black bg-black text-white px-1.5 inline-block rounded-sm">{pkg.recipientCommune}</p>
                         </div>
                         <div>
                            <p className="text-[8px] font-black uppercase text-gray-400">Ubicación:</p>
                            <p className="text-xs font-bold leading-tight">{pkg.recipientAddress}</p>
                         </div>
                    </div>
                </div>
                <div className="mt-3 pt-3 border-t border-dashed border-gray-300 flex items-center justify-between">
                    <div className="flex flex-col">
                        <p className="text-[7px] font-black uppercase opacity-30 tracking-[0.4em] mb-2">SCAN AREA</p>
                        {qrCodeUrl && <img src={qrCodeUrl} alt="QR" className="w-16 h-16" style={{ imageRendering: 'pixelated' }} />}
                    </div>
                    <div className="text-right">
                         <p className="text-[7px] font-black italic">{systemSettings.companyName}</p>
                    </div>
                </div>
            </div>
        );
    }

    // DISEÑO 6: ENFOQUE COMPACTO (FULL INFO)
    if (format === LabelFormat.MinimalSticker) {
        return (
            <div className="bg-white p-2 font-sans text-black w-[105mm] h-[148mm] border border-slate-300 flex flex-col overflow-hidden leading-tight">
                <div className="bg-slate-100 px-2 py-1 border-b border-black flex justify-between items-center mb-1">
                    <div className="flex flex-col flex-1 overflow-hidden pr-2">
                        <p className="text-[8px] font-black uppercase leading-none">{systemSettings.companyName}</p>
                        <div className="flex items-center justify-between mt-1">
                            <p className="text-[8px] font-black text-black truncate max-w-[40mm]">{creatorName}</p>
                            <p className="text-[8px] font-black text-black">{formattedDate}</p>
                        </div>
                    </div>
                    <p className="text-[7px] font-black text-slate-400 ml-2">D6</p>
                </div>
                <div className="grid grid-cols-2 gap-1 mb-2">
                    <div className="border border-black p-1">
                         <p className="text-[6px] font-black uppercase text-gray-400 leading-none">Destinatario:</p>
                         <p className="text-[9px] font-black truncate">{pkg.recipientName}</p>
                    </div>
                    <div className="border border-black p-1 text-right">
                         <p className="text-[6px] font-black uppercase text-gray-400 leading-none">RUT:</p>
                         <p className="text-[8px] font-bold">{pkg.recipientRut || 'S/N'}</p>
                    </div>
                </div>
                <div className="border-2 border-black p-1.5 text-center mb-2 flex justify-between items-center">
                    <div className="text-left">
                        <p className="text-[7px] font-black uppercase opacity-50 mb-0.5 tracking-widest">Sector de Entrega</p>
                        <p className="text-xl font-black uppercase tracking-tighter leading-none">{pkg.recipientCommune}</p>
                    </div>
                    {refNumber && (
                        <div className="text-right border-l-2 border-black pl-2">
                            <p className="text-[5px] font-black uppercase opacity-50 mb-0.5 tracking-widest">REF</p>
                            <p className="text-md font-black uppercase tracking-tighter leading-none">{refNumber}</p>
                            {secondaryRef && <p className="text-[9px] font-bold opacity-60 leading-none mt-0.5">({secondaryRef})</p>}
                        </div>
                    )}
                </div>
                <div className="border border-black p-1.5 flex-1 mb-2 space-y-1">
                     <p className="text-[6px] font-black uppercase text-gray-400 leading-none">Dirección / Instrucciones:</p>
                     <p className="text-[9px] font-bold leading-tight">{pkg.recipientAddress}</p>
                </div>
                <div className="bg-black text-white p-1.5 text-center flex items-center justify-between">
                     <div className="text-left">
                        <p className="text-[6px] font-bold text-gray-400 uppercase leading-none">Contacto:</p>
                        <p className="text-[10px] font-black tracking-tight leading-none">{pkg.recipientPhone}</p>
                     </div>
                </div>
                <div className="mt-auto flex items-center justify-center py-2">
                     {qrCodeUrl && <img src={qrCodeUrl} alt="QR" className="w-16 h-16" style={{ imageRendering: 'pixelated' }} />}
                </div>
            </div>
        );
    }

    // DISEÑO 7: TÉRMICA 10x8 (ROTADA 90°)
    if (format === LabelFormat.Thermal10x8) {
        return (
            <div className="bg-white font-sans text-black w-[100mm] h-[80mm] flex items-center justify-center overflow-hidden">
                {/* 
                   Contenedor interno de 80x100 rotado 90 grados.
                */}
                <div className="w-[80mm] h-[100mm] border-4 border-black p-3 flex flex-col rotate-90 origin-center scale-[0.98]">
                    <div className="text-center mb-2">
                        {creatorLogoBase64 && <img src={creatorLogoBase64} alt="" className="h-6 max-w-[35mm] mx-auto mb-0.5 object-contain" />}
                        <h2 className="text-[11px] font-black tracking-tight leading-none">{systemSettings.companyName.toUpperCase()}</h2>
                        <div className="flex flex-row flex-nowrap justify-between items-center mt-1 border-y border-black/10 py-1 px-2 overflow-hidden">
                            <span className="text-[8px] font-black text-black uppercase truncate max-w-[40mm] text-left">{creatorName}</span>
                            <span className="text-[8px] font-black text-black whitespace-nowrap text-right">{formattedDate}</span>
                        </div>
                    </div>

                    <div className="bg-white text-black p-2 text-center border-2 border-black rounded-xl mb-2">
                        <p className="text-[8px] font-black uppercase tracking-[0.2em] mb-0.5 opacity-50 leading-none">Destino Prioritario</p>
                        <p className={`font-[1000] uppercase leading-none ${pkg.recipientCommune.length > 12 ? 'text-xl' : 'text-2xl'}`}>{pkg.recipientCommune}</p>
                    </div>

                    <div className="flex-1 space-y-2">
                        <div className="border-l-2 border-black pl-2">
                            <p className="text-[8px] font-black uppercase text-gray-400 leading-none mb-1">Entrega para:</p>
                            <p className="text-[13px] font-black leading-none truncate">{pkg.recipientName}</p>
                            <div className="flex space-x-2 items-center mt-1">
                                 {pkg.recipientPhone && <p className="text-[10px] font-bold">📞 {pkg.recipientPhone}</p>}
                                 {pkg.recipientRut && <p className="text-[10px] font-bold opacity-60">RUT: {pkg.recipientRut}</p>}
                            </div>
                        </div>
                        <div className="pt-1 border-t border-dashed border-gray-300">
                            <p className="text-[8px] font-black uppercase text-gray-400 leading-none mb-1">Dirección:</p>
                            <p className="text-[11px] font-bold leading-tight">{pkg.recipientAddress}</p>
                            <p className="text-[9px] font-medium mt-0.5 italic text-gray-600">{pkg.recipientCommune}, {pkg.recipientCity}</p>
                        </div>
                    </div>

                    <div className="mt-auto border-t border-black pt-2 flex items-center justify-between">
                        <div className="flex flex-col items-center">
                            {qrCodeUrl && <img src={qrCodeUrl} alt="QR" className="w-20 h-20" style={{ imageRendering: 'pixelated' }} />}
                        </div>
                        <div className="flex-1 pl-3 text-right flex flex-col justify-end overflow-hidden">
                             {refNumber && (
                                 <div className="mb-1">
                                     <p className="text-[6px] font-bold text-gray-400 uppercase leading-none">Orden / REF:</p>
                                     <p className="text-xl font-black leading-none tracking-tighter">{refNumber}</p>
                                     {secondaryRef && <p className="text-[10px] font-bold opacity-60 leading-none mt-0.5">({secondaryRef})</p>}
                                 </div>
                             )}
                             <div className="mt-auto">
                                 <p className="text-[6px] font-bold text-gray-400 uppercase leading-none mb-0.5">ID Operativo:</p>
                                 <p className="text-[8px] font-mono font-black break-all leading-tight">{qrContent}</p>
                                 <div className="w-full h-1.5 bg-black mt-1"></div>
                             </div>
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    // Default fallback
    return <div>Formato de diseño no soportado</div>;
};

export default ShippingLabel;