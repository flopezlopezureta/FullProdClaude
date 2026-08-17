
import React, { useState, useRef, useEffect, Children, cloneElement, isValidElement } from 'react';
import { PackageStatus, ShippingType, PackageSource } from '../constants';
import type { Package } from '../types';
import { IconAlertTriangle, IconCheckCircle, IconClock, IconTruck, IconPackage, IconUserPlus, IconDotsVertical, IconPencil, IconTrash, IconArchive, IconChevronRight, IconPrinter, IconSun, IconZap, IconMoon, IconMercadoLibre, IconWoocommerce, IconArrowUturnLeft, IconUser, IconMapPin, IconQrcode, IconX, IconCopy, IconMail, IconPlugConnected, IconShopify, IconJumpseller, IconFalabella } from './Icon';
import QRCodeModal from './client/QRCodeModal';

interface PackageListItemProps {
  pkg: Package;
  driverName?: string;
  creatorName?: string;
  onSelect: (pkg: Package) => void;
  onAssign?: (pkg: Package) => void;
  onEdit?: (pkg: Package) => void;
  onDelete?: (pkg: Package) => void;
  onPrint?: (pkg: Package) => void;
  onMarkForReturn?: (pkg: Package) => void;
  hideDriverName?: boolean;
  isSelected?: boolean;
  onSelectionChange?: (pkg: Package) => void;
  index: number;
  isSelectionDisabled?: boolean;
}

const statusIcons: { [key in PackageStatus]: React.ReactNode } = {
  [PackageStatus.Pending]: <IconPackage className="h-5 w-5" />,
  [PackageStatus.Assigned]: <IconUserPlus className="h-5 w-5" />,
  [PackageStatus.PickedUp]: <IconArchive className="h-5 w-5" />,
  [PackageStatus.InTransit]: <IconTruck className="h-5 w-5" />,
  [PackageStatus.Delivered]: <IconCheckCircle className="h-5 w-5" />,
  [PackageStatus.Delayed]: <IconClock className="h-5 w-5" />,
  [PackageStatus.Problem]: <IconAlertTriangle className="h-5 w-5" />,
  [PackageStatus.ReturnPending]: <IconArrowUturnLeft className="h-5 w-5" />,
  [PackageStatus.Returned]: <IconArchive className="h-5 w-5" />,
  [PackageStatus.Cancelled]: <IconX className="h-5 w-5" />,
  [PackageStatus.Rescheduled]: <IconClock className="h-5 w-5" />,
};

const shippingTypeIcons: { [key in ShippingType]: React.ReactNode } = {
  [ShippingType.SameDay]: <IconSun title="Envío en el Día" className="w-4 h-4 text-orange-500" />,
  [ShippingType.Express]: <IconZap title="Envío Express" className="w-4 h-4 text-red-500" />,
  [ShippingType.NextDay]: <IconMoon title="Envío Next Day" className="w-4 h-4 text-indigo-500" />,
};

const sourceIcons: { [key in PackageSource]?: React.ReactNode } = {
  'MERCADO_LIBRE': <IconMercadoLibre title="Paquete de Mercado Libre" className="w-4 h-4 text-yellow-500 flex-shrink-0" />,
  'WOOCOMMERCE': <IconWoocommerce title="Paquete de WooCommerce" className="w-4 h-4 text-purple-600 flex-shrink-0" />,
  'SHOPIFY': <IconShopify title="Paquete de Shopify" className="w-4 h-4 text-green-500 flex-shrink-0" />,
  'JUMPSELLER': <IconJumpseller title="Paquete de Jumpseller" className="w-4 h-4 text-sky-600 flex-shrink-0" />,
  'FALABELLA': <IconFalabella title="Paquete de Falabella" className="w-4 h-4 text-lime-600 flex-shrink-0" />,
  'MANUAL': <div title="Paquete Manual" className="w-4 h-4 bg-gray-200 text-gray-500 rounded flex items-center justify-center font-bold text-[8px] flex-shrink-0">M</div>
};

const ActionsMenu: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [isOpen, setIsOpen] = useState(false);
    const [openUpwards, setOpenUpwards] = useState(false);
    const menuRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    useEffect(() => {
        if (isOpen && menuRef.current) {
            const rect = menuRef.current.getBoundingClientRect();
            const spaceBelow = window.innerHeight - rect.bottom;
            // Si hay menos de 250px abajo, abrir hacia arriba
            setOpenUpwards(spaceBelow < 250);
        }
    }, [isOpen]);
    
    const childrenWithCloseAction = Children.map(children, child => {
        if (isValidElement(child)) {
            const originalOnClick = (child.props as { onClick?: () => void }).onClick;
            return cloneElement(child as React.ReactElement<any>, {
                onClick: () => {
                    if (originalOnClick) {
                        originalOnClick();
                    }
                    setIsOpen(false);
                },
            });
        }
        return child;
    });

    return (
        <div className="relative" ref={menuRef}>
            <button onClick={() => setIsOpen(!isOpen)} className="p-2 rounded-full hover:bg-[var(--background-hover)] transition-colors">
                <IconDotsVertical className="w-5 h-5 text-[var(--text-muted)]" />
            </button>
            {isOpen && (
                <div 
                    className={`absolute right-0 ${openUpwards ? 'bottom-full mb-1' : 'top-full mt-1'} w-56 bg-[var(--background-secondary)] rounded-lg shadow-2xl z-[100] border border-[var(--border-primary)] animate-fade-in-up`}
                >
                    <div className="py-1">
                        {childrenWithCloseAction}
                    </div>
                </div>
            )}
        </div>
    );
};

const PackageListItem: React.FC<PackageListItemProps> = ({ pkg, driverName, creatorName, onSelect, onAssign, onEdit, onDelete, onPrint, onMarkForReturn, hideDriverName, isSelected, onSelectionChange, index, isSelectionDisabled }) => {
  const [showQRCode, setShowQRCode] = useState(false);
  const [showNewLabel, setShowNewLabel] = useState(false);

  useEffect(() => {
    const created = new Date(pkg.createdAt).getTime();
    const now = Date.now();
    const diff = now - created;
    if (diff > 0 && diff < 3000) {
      setShowNewLabel(true);
      const timer = setTimeout(() => setShowNewLabel(false), 3000 - diff);
      return () => clearTimeout(timer);
    }
  }, [pkg.createdAt]);

  const canModify = /PENDIENTE|ASIGNADO|RETIRADO/i.test(String(pkg.status || ''));
  const canReassign = onAssign && pkg.status !== PackageStatus.Delivered && pkg.status !== PackageStatus.Returned;
  const canMarkForReturn = onMarkForReturn && pkg.status === PackageStatus.Problem;
  const hasActions = onPrint || (canModify && (onEdit || onDelete)) || canReassign || canMarkForReturn;

  const isUrgent = (pkg.shippingType === ShippingType.Express && pkg.status === PackageStatus.Pending && !pkg.driverId) || pkg.status === PackageStatus.ReturnPending;
  const customCheckboxClass = "appearance-none h-4 w-4 border border-[var(--border-secondary)] rounded bg-[var(--background-secondary)] checked:bg-[var(--brand-primary)] checked:border-transparent focus:outline-none focus:ring-2 focus:ring-[var(--brand-secondary)] checked:bg-[url(\"data:image/svg+xml,%3csvg viewBox='0 0 16 16' fill='white' xmlns='http://www.w3.org/2000/svg'%3e%3cpath d='M12.207 4.793a1 1 0 010 1.414l-5 5a1 1 0 01-1.414 0l-2-2a1 1 0 011.414-1.414L6.5 9.086l4.293-4.293a1 1 0 011.414 0z'/%3e%3c/svg%3e\")]";
  
  const statusSlug = (pkg.status || '').toLowerCase().replace('_','');
  const badgeClass = `bg-[var(--status-${statusSlug}-bg)] text-[var(--status-${statusSlug}-text)]`;
  const borderClass = `border-[var(--status-${statusSlug}-border)]`;

  // Alternating row colors
  const isEven = index % 2 === 0;
  const rowBgClass = isSelected 
    ? 'bg-[var(--brand-muted)]' 
    : isEven 
    ? 'bg-[var(--background-secondary)]' 
    : 'bg-[var(--background-muted)]';

  const isReturnFlow = pkg.status === PackageStatus.ReturnPending || pkg.status === PackageStatus.Returned;

  // VISUAL SEPARATION LOGIC
  const primaryText = isReturnFlow 
      ? `${pkg.status === PackageStatus.Returned ? 'DEVUELTO A' : 'DEVOLUCIÓN A'}: ${creatorName || 'Cliente'}` 
      : (creatorName || 'Sin Cliente (Seller)');
      
  const addressText = isReturnFlow 
      ? (pkg.origin || 'Sin Origen') 
      : (pkg.recipientAddress || 'Sin Dirección');

    const isScanned = pkg.status !== PackageStatus.Pending && pkg.status !== PackageStatus.Assigned;
    
    let displaySource = pkg.source;
    if (displaySource === PackageSource.Manual || !displaySource) {
        if (pkg.shopifyOrderId) displaySource = PackageSource.Shopify;
        else if (pkg.jumpsellerOrderId) displaySource = PackageSource.Jumpseller;
        else if (pkg.meliOrderId || pkg.meliFlexCode) displaySource = PackageSource.MercadoLibre;
        else if (pkg.wooOrderId) displaySource = PackageSource.WooCommerce;
        else displaySource = PackageSource.Manual;
    }

    return (
        <>
            <style>{`
                @keyframes pulse-border-red {
                    0%, 100% { border-left-color: #ef4444; } /* Tailwind red-500 */
                    50% { border-left-color: #fca5a5; }   /* Tailwind red-300 */
                }
                .animate-pulse-border-red {
                    animation: pulse-border-red 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
                }
                @keyframes pulse-border-yellow {
                    0%, 100% { border-left-color: #f59e0b; } /* Tailwind yellow-500 */
                    50% { border-left-color: #fcd34d; }   /* Tailwind yellow-300 */
                }
                .animate-pulse-border-yellow {
                    animation: pulse-border-yellow 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
                }
                @keyframes pulse-urgent-bg {
                    0%, 100% { background-color: var(--background-secondary); }
                    50% { background-color: var(--error-bg); }
                }
                .animate-pulse-urgent {
                    animation: pulse-urgent-bg 1.5s cubic-bezier(0.4, 0, 0.6, 1) infinite;
                }
            `}</style>
            <div
                className={`px-3 py-3 flex items-center hover:bg-[var(--background-hover)] transition-colors duration-200 border-l-4 ${borderClass} ${isUrgent ? 'animate-pulse-urgent' : ''} ${rowBgClass}`}
            >
                {onSelectionChange && (
                    <div className="mr-3 flex-shrink-0">
                        <input
                            type="checkbox"
                            className={`${customCheckboxClass} ${isSelectionDisabled ? 'opacity-30 cursor-not-allowed' : ''}`}
                            checked={!!isSelected}
                            onChange={() => onSelectionChange(pkg)}
                            onClick={(e) => e.stopPropagation()}
                            disabled={isSelectionDisabled}
                        />
                    </div>
                )}
                {/* Main Content Info */}
                <div onClick={() => onSelect(pkg)} className="flex items-start flex-grow min-w-0 cursor-pointer gap-3">
                    <div className="flex-shrink-0 mt-1">
                        <div className={`p-2 rounded-full ${badgeClass}`}>
                            {pkg.status && statusIcons[pkg.status]}
                        </div>
                    </div>
                    
                    {/* FORCE COLUMN LAYOUT FOR TEXT TO PREVENT MIXING */}
                    <div className="flex flex-col flex-grow min-w-0 space-y-1.5">
                        {/* 1. Primary Text: Name (Bold & Large) */}
                        <div className="flex items-center gap-2 w-full">
                            <p className="font-bold text-[var(--text-primary)] text-sm leading-tight truncate">
                                {primaryText}
                            </p>
                            {showNewLabel && (
                                <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-tighter bg-green-500 text-white animate-pulse">
                                    NUEVO
                                </span>
                            )}
                            {isScanned && (
                                <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-tighter bg-green-100 text-green-700 border border-green-200">
                                    <IconCheckCircle className="w-2.5 h-2.5 mr-0.5" />
                                    Escaneado
                                </span>
                            )}
                        </div>
                        
                        {/* 2. Secondary Text: Address (Smaller, different color, new line) */}
                        <div className="flex items-start gap-1.5 text-xs text-[var(--text-secondary)] w-full">
                            <IconMapPin className="w-3.5 h-3.5 text-[var(--text-muted)] flex-shrink-0 mt-0.5" />
                            <span className="leading-tight block break-words">{addressText}</span>
                        </div>

                        {/* 3. Third Line: Commune Badge + Icons */}
                        <div className="flex items-center gap-2 flex-wrap mt-1 w-full">
                            {!isReturnFlow && (
                                <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide bg-slate-200 text-slate-700 border border-slate-300">
                                    {pkg.recipientCommune || 'Sin Comuna'}
                                </span>
                            )}
                            {pkg.distance !== undefined && (
                                <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-bold bg-blue-50 text-blue-700 border border-blue-200">
                                    📍 {pkg.destIsApproximate ? '~' : ''}{pkg.distance >= 1 ? `${pkg.distance.toFixed(1)} km` : `${Math.round(pkg.distance * 1000)} m`}
                                    {pkg.destIsApproximate
                                        ? ` a ${pkg.recipientCommune || 'la comuna'} (aprox.)`
                                        : (pkg.isRoadDistance ? ' (por calle)' : ' (línea recta)')}
                                </span>
                            )}
                            {/* [NUEVO] Mostrar ID de Referencia / Mercado Libre para identificación rápida */}
                            {(pkg.meliOrderId || pkg.meliFlexCode || pkg.shopifyOrderId || pkg.shopifyOrderNumber || pkg.falabellaTrackingId || pkg.falabellaOrderId) && (
                                <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-indigo-50 text-indigo-700 border border-indigo-200">
                                    REF: {pkg.falabellaTrackingId || pkg.falabellaOrderId || pkg.shopifyOrderNumber || pkg.shopifyOrderId || pkg.meliOrderId || pkg.meliFlexCode}
                                    {pkg.shopifyOrderNumber && pkg.shopifyOrderId && pkg.shopifyOrderNumber !== pkg.shopifyOrderId && (
                                        <span className="ml-1 text-[9px] font-normal opacity-60">({pkg.shopifyOrderId})</span>
                                    )}
                                </span>
                            )}
                            <div className="flex items-center gap-1.5 pl-1 border-l border-[var(--border-secondary)]">
                                {pkg.source === 'FALABELLA_DIRECTO' && pkg.falabellaDirectLpn?.startsWith('TEST_LPN_') && (
                                    <span
                                        className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-black uppercase tracking-tight bg-amber-100 text-amber-800 border border-amber-300"
                                        title={`Paquete de pruebas UAT — LPN ${pkg.falabellaDirectLpn}, no es una entrega real.`}
                                    >
                                        ⚠ Prueba UAT
                                    </span>
                                )}
                                {displaySource && (
                                    <div className="flex items-center gap-1 bg-[var(--background-secondary)] px-1.5 py-0.5 rounded border border-[var(--border-secondary)]" title={displaySource === PackageSource.Manual ? `Creado por ${creatorName || 'Usuario'}` : `Importado desde ${displaySource}`}>
                                        {sourceIcons[displaySource] || (
                                            <div className="w-3.5 h-3.5 rounded-sm flex items-center justify-center bg-[var(--background-muted)] text-[var(--text-secondary)] font-black text-[8px]">
                                                M
                                            </div>
                                        )}
                                        <span className="text-[9px] font-bold text-[var(--text-secondary)] uppercase tracking-tight hidden sm:inline-block">
                                            {displaySource === PackageSource.Manual ? `Creado por ${creatorName || 'Usuario'}` : `Importado desde ${displaySource.replace('_', ' ')}`}
                                        </span>
                                    </div>
                                )}
                                {pkg.recipientEmail && <IconMail title={`Email: ${pkg.recipientEmail}`} className="w-3.5 h-3.5 text-blue-500 flex-shrink-0" />}
                                {pkg.source === 'MERCADO_LIBRE' && (
                                    pkg.isFlexed ? (
                                        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[8px] font-bold uppercase bg-green-100 text-green-800 border border-green-200">
                                            FLEX OK
                                        </span>
                                    ) : (
                                        pkg.status === PackageStatus.InTransit && (
                                            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[8px] font-bold uppercase bg-red-100 text-red-800 border border-red-200 animate-pulse">
                                                NO FLEX
                                            </span>
                                        )
                                    )
                                )}
                                {pkg.shippingType && shippingTypeIcons[pkg.shippingType]}
                            </div>
                        </div>

                        {/* Additional Info */}
                        {!isReturnFlow && (
                            <div className="flex items-center gap-1 text-[10px] text-[var(--text-muted)] pt-0.5">
                                <IconUser className="w-3 h-3" />
                                <span className="truncate">Comprador: {pkg.recipientName || 'Sin Nombre'}</span>
                            </div>
                        )}
                        {pkg.sourceAccountName && (
                            <div className="flex items-center gap-1 text-[10px] text-blue-600 font-bold bg-blue-50 px-1.5 py-0.5 rounded w-fit">
                                <IconPlugConnected className="w-3 h-3" />
                                <span className="truncate tracking-tight uppercase">Cuenta: {pkg.sourceAccountName}</span>
                            </div>
                        )}
                         {(pkg.status === PackageStatus.Delivered || pkg.status === PackageStatus.Returned) && pkg.deliveryReceiverName && (
                            <div className={`flex items-center gap-1 text-[10px] font-medium ${pkg.status === PackageStatus.Delivered ? 'text-green-600' : 'text-slate-600'}`}>
                                <IconCheckCircle className="w-3 h-3" />
                                <span className="truncate">Recibido por: {pkg.deliveryReceiverName}</span>
                            </div>
                        )}
                    </div>

                    {/* DATES SECTION (Creation or Assignment) */}
                    <div className="hidden lg:flex flex-col justify-center px-4 border-l border-r border-gray-100 min-w-[140px]">
                        <div className="flex flex-col">
                            <span className="text-[9px] font-black text-gray-400 uppercase tracking-wider">
                                {pkg.status === PackageStatus.Delivered ? 'Entrega' : 
                                 pkg.status === PackageStatus.Returned ? 'Devolución' : 
                                 pkg.assignedAt ? 'Asignación' : 'Creación'}
                            </span>
                            <span className="text-[11px] font-bold text-slate-600 whitespace-nowrap">
                                {new Date(
                                    (pkg.status === PackageStatus.Delivered || pkg.status === PackageStatus.Returned) 
                                    ? pkg.updatedAt 
                                    : (pkg.assignedAt || pkg.createdAt)
                                ).toLocaleDateString('es-CL', { day: '2-digit', month: '2-digit', year: '2-digit' })}
                                <span className="text-gray-400 ml-1 font-medium">
                                    {new Date(
                                        (pkg.status === PackageStatus.Delivered || pkg.status === PackageStatus.Returned) 
                                        ? pkg.updatedAt 
                                        : (pkg.assignedAt || pkg.createdAt)
                                    ).toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' })}
                                </span>
                            </span>
                        </div>
                    </div>
                </div>
          
                <div onClick={() => onSelect(pkg)} className="ml-3 flex-shrink-0 text-right hidden sm:block cursor-pointer">
            <div className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${badgeClass}`}>
                {(pkg.status || '').replace('_', ' ')}
            </div>
            {!hideDriverName && (
                <div className="text-xs text-[var(--text-muted)] mt-1">
                    {driverName ? (
                        <span className="flex items-center justify-end gap-1">
                            <IconTruck className="w-3 h-3"/> {driverName}
                        </span>
                    ) : (
                        <span className="text-[var(--text-muted)] opacity-70">No asignado</span>
                    )}
                </div>
            )}
        </div>

        <div className="ml-3 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-1">
                {pkg.source === 'MERCADO_LIBRE' && (
                    <button 
                        onClick={() => setShowQRCode(true)}
                        className="p-2 rounded-full bg-green-50 text-green-600 hover:bg-green-100 transition-colors border border-green-200 shadow-sm"
                        title="Ver Código FLEX QR"
                    >
                        <IconQrcode className="w-5 h-5" />
                    </button>
                )}
                {hasActions ? (
                    <ActionsMenu>
                    {onPrint && (
                         <button onClick={() => onPrint(pkg)} className="w-full text-left flex items-center px-4 py-2 text-sm text-[var(--text-secondary)] hover:bg-[var(--background-hover)]">
                            <IconPrinter className="w-4 h-4 mr-3" /> Imprimir Etiqueta
                        </button>
                    )}
                    <button 
                        onClick={async () => {
                            try {
                                const link = `${window.location.origin}/track/${pkg.id}`;
                                await navigator.clipboard.writeText(link);
                                alert('Link de seguimiento copiado al portapapeles');
                            } catch (err) {
                                console.error('Failed to copy link:', err);
                                alert('No se pudo copiar el link al portapapeles. Por favor, inténtalo de nuevo.');
                            }
                        }} 
                        className="w-full text-left flex items-center px-4 py-2 text-sm text-[var(--text-secondary)] hover:bg-[var(--background-hover)]"
                    >
                        <IconCopy className="w-4 h-4 mr-3" /> Copiar Link de Seguimiento
                    </button>
                    {onEdit && canModify && (
                        <button onClick={() => onEdit(pkg)} className="w-full text-left flex items-center px-4 py-2 text-sm text-[var(--text-secondary)] hover:bg-[var(--background-hover)]">
                            <IconPencil className="w-4 h-4 mr-3" /> Editar
                        </button>
                    )}
                    {canReassign && (
                        <button onClick={() => onAssign(pkg)} className="w-full text-left flex items-center px-4 py-2 text-sm text-[var(--text-secondary)] hover:bg-[var(--background-hover)]">
                            <IconUserPlus className="w-4 h-4 mr-3" /> {driverName ? 'Reasignar' : 'Asignar'}
                        </button>
                    )}
                    {canMarkForReturn && (
                         <button onClick={() => onMarkForReturn(pkg)} className="w-full text-left flex items-center px-4 py-2 text-sm text-amber-600 hover:bg-amber-50">
                            <IconArrowUturnLeft className="w-4 h-4 mr-3" /> Marcar para Devolución
                        </button>
                    )}
                    {onDelete && canModify && (
                        <button onClick={() => onDelete(pkg)} className="w-full text-left flex items-center px-4 py-2 text-sm text-red-600 hover:bg-red-50">
                            <IconTrash className="w-4 h-4 mr-3" /> Eliminar
                        </button>
                    )}
                </ActionsMenu>
            ) : (
              <button 
                onClick={() => onSelect(pkg)} 
                className="p-2 rounded-full hover:bg-[var(--background-hover)] transition-colors"
                aria-label={`Ver detalles del paquete ${pkg.id}`}
              >
                  <IconChevronRight className="w-5 h-5 text-[var(--text-muted)]" />
              </button>
            )}
            </div>
        </div>
      </div>
      {showQRCode && (
        <QRCodeModal 
            pkg={pkg}
            onClose={() => setShowQRCode(false)} 
        />
      )}
    </>
  );
};

export default PackageListItem;
