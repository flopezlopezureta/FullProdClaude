

import React, { useState, useContext, useRef } from 'react';
import { PackageStatus, ShippingType, MessagingPlan, Role } from '../constants';
import type { Package, User } from '../types';
import { api } from '../services/api';
import { AuthContext } from '../contexts/AuthContext';
import { IconX, IconCalendar, IconMapPin, IconPhone, IconWhatsapp, IconAlertTriangle, IconCheckCircle, IconSun, IconZap, IconMoon, IconQrcode, IconChevronLeft, IconTruck, IconArrowUturnLeft, IconRefresh, IconCopy, IconPencil, IconClock, IconHistory, IconPlus, IconPhoto, IconTrash } from './Icon';
import QRCodeModal from './client/QRCodeModal';
import imageCompression from 'browser-image-compression';

interface PackageDetailModalProps {
  pkg: Package;
  onClose: () => void;
  onStartDelivery?: (pkg: Package) => void;
  onReportProblem?: (pkg: Package) => void;
  isFullScreen?: boolean;
  companyName?: string;
  creatorForReturn?: User;
  onStartReturn?: (pkg: Package) => void;
  creator?: User | null;
  onUpdatePackage?: (updatedPkg: Package) => void;
  onEdit?: (pkg: Package) => void;
  onRedelivery?: (pkg: Package) => void;
}

const PackageDetailModal: React.FC<PackageDetailModalProps> = ({ pkg, onClose, onStartDelivery, onReportProblem, onStartReturn, isFullScreen = false, companyName = "", creatorForReturn, creator, onUpdatePackage, onEdit, onRedelivery }) => {
  const auth = useContext(AuthContext);
  const [isQrModalOpen, setIsQrModalOpen] = useState(false);
  const [viewingPhoto, setViewingPhoto] = useState<string | null>(null);
  const [isFlexing, setIsFlexing] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);

  // --- Admin Closure States ---
  const [isAdminDelivering, setIsAdminDelivering] = useState(false);
  const [adminReceiverName, setAdminReceiverName] = useState(pkg.recipientName || '');
  const [adminReceiverId, setAdminReceiverId] = useState('');
  const [adminPhotos, setAdminPhotos] = useState<string[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleAdminPhotoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setIsUploading(true);
    const fileList = Array.from(files);

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

    try {
        const compressedPromises = fileList.map(async (file) => {
            try {
                const compressedFile = await imageCompression(file, compressionOptions);
                return new Promise<string>((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onloadend = () => resolve(reader.result as string);
                    reader.onerror = () => reject(new Error("Error al leer archivo comprimido"));
                    reader.readAsDataURL(compressedFile);
                });
            } catch (innerErr) {
                console.error(`Error compressing admin photo ${file.name}:`, innerErr);
                return new Promise<string>((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(reader.result as string);
                    reader.onerror = reject;
                    reader.readAsDataURL(file);
                });
            }
        });

        const base64Photos = await Promise.all(compressedPromises);
        setAdminPhotos(prev => [...prev, ...base64Photos]);
        alert("Imágenes optimizadas con éxito para una carga fluida.");
    } catch (err) {
        console.error("Error processing admin photos:", err);
        alert("Error al procesar y optimizar las imágenes.");
    } finally {
        setIsUploading(false);
        if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleRemoveAdminPhoto = (index: number) => {
    setAdminPhotos(prev => prev.filter((_, i) => i !== index));
  };

  const handleAdminConfirmDelivery = async () => {
    if (adminPhotos.length === 0) {
        alert("Debes añadir al menos una foto de evidencia.");
        return;
    }
    if (!adminReceiverName.trim()) {
        alert("El nombre del receptor es obligatorio.");
        return;
    }

    setIsAdminDelivering(true);
    try {
        const updatedPkg = await api.confirmDelivery(pkg.id, {
            receiverName: adminReceiverName,
            receiverId: adminReceiverId,
            photosBase64: adminPhotos
        });
        
        if (onUpdatePackage) {
            onUpdatePackage(updatedPkg);
        }
        alert("Envío cerrado con éxito.");
    } catch (error: any) {
        console.error("Error confirming delivery (admin):", error);
        alert(error.message || "Error al confirmar la entrega.");
    } finally {
        setIsAdminDelivering(false);
    }
  };
  // ----------------------------


  const isReturn = pkg.status === PackageStatus.ReturnPending && !!onStartReturn;

  const estimatedDelivery = pkg.estimatedDelivery 
    ? new Date(pkg.estimatedDelivery).toLocaleDateString('es-ES', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
      })
    : 'Fecha no disponible';
  
  const canInteract = onStartDelivery && onReportProblem && !isReturn;
  const canReturnInteract = onStartReturn && isReturn;

  const handleToggleFlex = async () => {
    if (isFlexing) return;
    setIsFlexing(true);
    try {
      const updatedPkg = await api.markPackageAsFlexed(pkg.id, !pkg.isFlexed);
      if (onUpdatePackage) {
        onUpdatePackage(updatedPkg);
      }
    } catch (error: any) {
      console.error("Error toggling flex status:", error);
      alert(error.message || "Error al cambiar el estado Flex.");
    } finally {
      setIsFlexing(false);
    }
  };

  const handleSyncMeli = async () => {
    if (isSyncing) return;
    setIsSyncing(true);
    try {
      const result = await api.syncPackageWithMeli(pkg.id);
      if (onUpdatePackage) {
        onUpdatePackage(result);
      }
      if (result.noChange) {
        alert(`Sincronización completa. No hay cambios de estado. Estado en ML: ${result.mlStatus}${result.mlSubstatus ? ` (${result.mlSubstatus})` : ''}`);
      } else {
        alert(`Paquete sincronizado. Nuevo estado: ${result.status}`);
      }
    } catch (error: any) {
      console.error("Error syncing with ML:", error);
      alert(error.message || "Error al sincronizar con Mercado Libre.");
    } finally {
      setIsSyncing(false);
    }
  };

  const recipientPhoneForNotif = isReturn ? creatorForReturn?.phone : pkg.recipientPhone;
  const enRouteMessage = isReturn
    ? `Hola ${creatorForReturn?.name || 'Cliente'}, soy el repartidor de ${companyName || 'la empresa'}. Voy en camino a devolver el paquete con ID ${pkg.id}. ¡Nos vemos pronto!`
    : `Hola, soy el repartidor de ${companyName || 'la empresa'}. Voy en camino a entregar tu paquete con ID ${pkg.id}. ¡Nos vemos pronto!`;
  const whatsappEnRouteUrl = recipientPhoneForNotif 
    ? `https://wa.me/${String(recipientPhoneForNotif).replace(/\D/g, '')}?text=${encodeURIComponent(enRouteMessage)}`
    : '#';


  const shippingTypeConfig: { [key in ShippingType]: { icon: React.ReactNode; text: string } } = {
    [ShippingType.SameDay]: { icon: <IconSun className="w-5 h-5 mt-0.5 mr-2 text-[var(--text-muted)] flex-shrink-0" />, text: 'Envío en el Día' },
    [ShippingType.Express]: { icon: <IconZap className="w-5 h-5 mt-0.5 mr-2 text-[var(--text-muted)] flex-shrink-0" />, text: 'Envío Express' },
    [ShippingType.NextDay]: { icon: <IconMoon className="w-5 h-5 mt-0.5 mr-2 text-[var(--text-muted)] flex-shrink-0" />, text: 'Envío Next Day' },
  };
  const typeConfig = shippingTypeConfig[pkg.shippingType] || { icon: null, text: pkg.shippingType };

  const modalClasses = isFullScreen 
    ? 'bg-[var(--background-primary)] h-full w-full' 
    : 'bg-[var(--background-secondary)] rounded-xl max-w-2xl max-h-[90vh] animate-fade-in-up';

  const mainContainerClasses = isFullScreen
    ? 'bg-[var(--background-primary)]'
    : 'bg-black bg-opacity-60 flex justify-center items-center p-4';
    
  const streetAddress = isReturn 
    ? (creatorForReturn?.pickupAddress || pkg.origin || '').split(',')[0]?.trim() || '' 
    : (pkg.recipientAddress || '').split(',')[0]?.trim() || '';
  const recipientNameForDisplay = isReturn ? creatorForReturn?.name : pkg.recipientName;
  const recipientPhoneForDisplay = isReturn ? creatorForReturn?.phone : pkg.recipientPhone;
  const recipientCommuneForDisplay = isReturn 
    ? (creatorForReturn?.address || '').split(',').pop()?.trim() || '' 
    : pkg.recipientCommune;
  
  const problemEvent = pkg.status === PackageStatus.Problem 
    ? pkg.history?.find(event => event.status === PackageStatus.Problem)
    : null;

  const isMeli = pkg.source === 'MERCADO_LIBRE';
  const needsFlex = isMeli && pkg.status === PackageStatus.InTransit && !pkg.isFlexed;
  const hasFlexPhoto = !!pkg.flexLabelPhotoBase64;
  const hasFalabellaDirectLabelPhoto = !!pkg.falabellaDirectLabelPhotoBase64;

  return (
    <>
      <div
        className={`fixed inset-0 z-50 ${mainContainerClasses}`}
        onClick={!isFullScreen ? onClose : undefined}
      >
        <div
          className={`shadow-2xl flex flex-col ${modalClasses}`}
          onClick={(e) => e.stopPropagation()}
        >
          <header className={`flex items-center justify-between p-4 flex-shrink-0 ${isFullScreen ? 'bg-[var(--background-primary)]' : 'border-b border-[var(--border-primary)]'}`}>
             {isFullScreen && (
                <button
                    onClick={onClose}
                    className="p-2 -ml-2 rounded-full text-[var(--text-muted)] hover:bg-[var(--background-hover)]"
                    aria-label="Volver"
                >
                    <IconChevronLeft className="w-6 h-6" />
                </button>
             )}
            <h3 className="text-lg font-bold text-[var(--brand-primary)] text-center flex-grow">{pkg.id}</h3>
            <div className="flex items-center gap-2">
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
                    className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold text-blue-700 bg-blue-100 rounded-full hover:bg-blue-200 transition-colors"
                    title="Copiar link de seguimiento para el cliente"
                >
                    <IconCopy className="w-4 h-4"/>
                    <span className="hidden sm:inline">Copiar Link</span>
                </button>
                {onEdit && pkg.status === PackageStatus.Pending && (
                    <button
                        onClick={() => {
                            onEdit(pkg);
                            onClose();
                        }}
                        className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold text-amber-700 bg-amber-100 rounded-full hover:bg-amber-200 transition-colors"
                        title="Editar detalles del paquete"
                    >
                        <IconPencil className="w-4 h-4"/>
                        <span className="hidden sm:inline">Editar</span>
                    </button>
                )}
                {pkg.meliOrderId ? (
                    <button
                        onClick={() => setIsQrModalOpen(true)}
                        className={`flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold rounded-full transition-colors ${
                            auth?.systemSettings.messagingPlan === MessagingPlan.WhatsApp 
                                ? "text-green-700 bg-green-100 hover:bg-green-200" 
                                : "text-blue-700 bg-blue-100 hover:bg-blue-200"
                        }`}
                        aria-label={auth?.systemSettings.messagingPlan === MessagingPlan.WhatsApp ? "Pedir Código QR por WhatsApp" : "Ver Código QR"}
                    >
                        {auth?.systemSettings.messagingPlan === MessagingPlan.WhatsApp ? (
                            <IconWhatsapp className="w-4 h-4"/>
                        ) : (
                            <IconQrcode className="w-4 h-4"/>
                        )}
                        <span>{auth?.systemSettings.messagingPlan === MessagingPlan.WhatsApp ? "Pedir QR" : "Ver QR"}</span>
                    </button>
                ) : (
                    <button
                        onClick={() => setIsQrModalOpen(true)}
                        className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold text-purple-700 bg-purple-100 rounded-full hover:bg-purple-200 transition-colors"
                        aria-label="Mostrar Código QR"
                    >
                        <IconQrcode className="w-4 h-4"/>
                        <span>QR</span>
                    </button>
                )}
                {!isFullScreen && (
                    <button
                        onClick={onClose}
                        className="p-2 rounded-full text-[var(--text-muted)] hover:bg-[var(--background-hover)] hover:text-[var(--text-primary)] transition-colors"
                        aria-label="Cerrar modal"
                    >
                        <IconX className="w-6 h-6" />
                    </button>
                )}
            </div>
          </header>

          <div className="p-4 overflow-y-auto custom-scrollbar space-y-4">
              {/* Flex Status Alert */}
              {needsFlex && (
                  <div className="bg-red-50 border-l-4 border-red-500 p-4 rounded-md flex items-start gap-3 animate-pulse">
                      <IconAlertTriangle className="w-6 h-6 text-red-600 flex-shrink-0" />
                      <div>
                          <p className="text-sm font-bold text-red-800">¡PAQUETE NO FLEXEADO!</p>
                          <p className="text-xs text-red-700 mt-1">Este paquete está en tránsito pero aún no ha sido marcado como "Flexeado" en el sistema de Mercado Libre.</p>
                      </div>
                  </div>
              )}

              {/* Flex Label Backup Photo */}
              {hasFlexPhoto && (
                  <div className="bg-[var(--background-secondary)] p-4 rounded-lg shadow-sm border border-[var(--border-primary)]">
                      <h4 className="text-sm font-semibold text-[var(--text-muted)] mb-3 flex items-center gap-2">
                          <IconQrcode className="w-4 h-4" />
                          Respaldo de Etiqueta Flex
                      </h4>
                      <div className="relative aspect-video bg-black rounded-md overflow-hidden border border-[var(--border-secondary)]">
                          <img 
                              src={pkg.flexLabelPhotoBase64} 
                              alt="Respaldo Etiqueta Flex" 
                              className="w-full h-full object-contain cursor-pointer hover:opacity-90 transition-opacity"
                              onClick={() => setViewingPhoto(pkg.flexLabelPhotoBase64!)}
                          />
                          <div className="absolute bottom-2 right-2 px-2 py-1 bg-black/60 rounded text-[10px] text-white font-mono">
                              {pkg.flexedAt ? new Date(pkg.flexedAt).toLocaleString() : 'Fecha desconocida'}
                          </div>
                      </div>
                  </div>
              )}

              {/* Falabella Directo Label Backup Photo */}
              {hasFalabellaDirectLabelPhoto && (
                  <div className="bg-[var(--background-secondary)] p-4 rounded-lg shadow-sm border border-[var(--border-primary)]">
                      <h4 className="text-sm font-semibold text-[var(--text-muted)] mb-3 flex items-center gap-2">
                          <IconQrcode className="w-4 h-4" />
                          Respaldo de Etiqueta Falabella Directo
                      </h4>
                      <div className="relative aspect-video bg-black rounded-md overflow-hidden border border-[var(--border-secondary)]">
                          <img
                              src={pkg.falabellaDirectLabelPhotoBase64}
                              alt="Respaldo Etiqueta Falabella Directo"
                              className="w-full h-full object-contain cursor-pointer hover:opacity-90 transition-opacity"
                              onClick={() => setViewingPhoto(pkg.falabellaDirectLabelPhotoBase64!)}
                          />
                          <div className="absolute bottom-2 right-2 px-2 py-1 bg-black/60 rounded text-[10px] text-white font-mono">
                              {pkg.createdAt ? new Date(pkg.createdAt).toLocaleString() : 'Fecha desconocida'}
                          </div>
                      </div>
                  </div>
              )}

              {/* Recipient Info Card */}
              <div className="bg-[var(--background-secondary)] p-4 rounded-lg shadow-sm border border-[var(--border-primary)]">
                  <div className="flex justify-between items-start mb-3">
                      <h4 className="text-sm font-semibold text-[var(--text-muted)]">{isReturn ? 'Información de Devolución' : 'Información del Destinatario'}</h4>
                       <div className="flex items-center gap-2">
                            {canInteract && auth?.systemSettings.messagingPlan === MessagingPlan.WhatsApp && (
                                <a href={whatsappEnRouteUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold text-orange-700 bg-orange-100 rounded-full hover:bg-orange-200 transition-colors" aria-label="Notificar que va en camino">
                                    <IconTruck className="w-4 h-4"/>
                                    <span>En Camino</span>
                                </a>
                            )}
                            {recipientPhoneForDisplay && (
                                <>
                                <a href={`tel:${String(recipientPhoneForDisplay).replace(/[^\d+]/g, '')}`} className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold text-blue-700 bg-blue-100 rounded-full hover:bg-blue-200 transition-colors" aria-label="Llamar">
                                    <IconPhone className="w-4 h-4"/>
                                    <span>Llamar</span>
                                </a>
                                {auth?.systemSettings.messagingPlan === MessagingPlan.WhatsApp && recipientPhoneForDisplay && (
                                    <a href={`https://wa.me/${String(recipientPhoneForDisplay).replace(/\D/g, '')}`} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold text-green-700 bg-green-100 rounded-full hover:bg-green-200 transition-colors" aria-label="Enviar WhatsApp">
                                        <IconWhatsapp className="w-4 h-4"/>
                                        <span>Chat</span>
                                    </a>
                                )}
                                </>
                            )}
                        </div>
                  </div>
                  <p className="font-bold text-[var(--text-primary)] text-lg">{streetAddress}</p>
                  <p className="text-[var(--text-secondary)] text-lg">{recipientNameForDisplay}</p>
                  <div className="mt-2 space-y-0.5 text-sm text-[var(--text-secondary)]">
                      <p><span className="font-medium text-[var(--text-primary)]">Teléfono:</span> {recipientPhoneForDisplay || 'N/A'}</p>
                      {pkg.recipientEmail && (
                          <p><span className="font-medium text-[var(--text-primary)]">Email:</span> {pkg.recipientEmail}</p>
                      )}
                      <p><span className="font-medium text-[var(--text-primary)]">Comuna:</span> {recipientCommuneForDisplay || 'N/A'}</p>
                      <p><span className="font-medium text-[var(--text-primary)]">Ciudad:</span> {pkg.recipientCity || 'N/A'}</p>
                      {pkg.meliFlexCode && (
                          <p><span className="font-medium text-[var(--text-primary)]">ID Envío ML:</span> {pkg.meliFlexCode}</p>
                      )}
                      {(pkg.falabellaTrackingId || pkg.falabellaOrderId) && (
                          <p><span className="font-medium text-[var(--text-primary)]">ID Envío Falabella:</span> {pkg.falabellaTrackingId || pkg.falabellaOrderId}</p>
                      )}
                      {pkg.trackingId && (
                          <p><span className="font-medium text-[var(--text-primary)]">Código Barra (SCA):</span> {pkg.trackingId}</p>
                      )}
                  </div>
              </div>

              {/* Status Card */}
              <div className="bg-[var(--background-secondary)] p-4 rounded-lg shadow-sm border border-[var(--border-primary)]">
                  <div className="flex justify-between items-center mb-2">
                      <h4 className="text-sm font-semibold text-[var(--text-muted)]">Estado Actual: <span className="text-[var(--brand-primary)] font-bold">{(pkg.status || '').replace('_', ' ')}</span></h4>
                      <div className="flex items-center gap-2">
                        {isMeli && (
                            <>
                            <button 
                                onClick={handleSyncMeli}
                                disabled={isSyncing}
                                className="inline-flex items-center px-2 py-0.5 rounded text-xs font-bold uppercase tracking-wide border border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 transition-colors"
                                title="Consultar estado actual en Mercado Libre"
                            >
                                {isSyncing ? <IconRefresh className="w-3 h-3 mr-1 animate-spin" /> : <IconRefresh className="w-3 h-3 mr-1" />}
                                Consultar Flex
                            </button>
                            <button 
                                onClick={handleToggleFlex}
                                disabled={isFlexing}
                                className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-bold uppercase tracking-wide border transition-colors ${pkg.isFlexed ? 'bg-green-100 text-green-700 border-green-200' : 'bg-gray-100 text-gray-600 border-gray-200 hover:bg-gray-200'}`}
                            >
                                {isFlexing ? <IconRefresh className="w-3 h-3 mr-1 animate-spin" /> : <IconCheckCircle className="w-3 h-3 mr-1" />}
                                {pkg.isFlexed ? 'Flexeado' : 'Marcar Flex'}
                            </button>
                            </>
                        )}
                        {(pkg.status !== PackageStatus.Pending && pkg.status !== PackageStatus.PickedUp) && (
                            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-bold uppercase tracking-wide bg-blue-100 text-blue-700 border border-blue-200">
                                <IconCheckCircle className="w-3 h-3 mr-1" />
                                Escaneado
                            </span>
                        )}
                      </div>
                  </div>
                   {problemEvent && (
                    <div className="my-3 p-3 bg-[var(--error-bg)] border-l-4 border-[var(--error-border)] rounded-r-md flex items-start gap-3">
                        <IconAlertTriangle className="w-5 h-5 text-[var(--error-text)] flex-shrink-0 mt-0.5" />
                        <div>
                            <p className="text-sm font-semibold text-[var(--error-text)]">Motivo del Problema:</p>
                            <p className="text-sm text-[var(--error-text)] opacity-90 mt-1">{(problemEvent.details || '').replace('Problema reportado: ', '')}</p>
                        </div>
                    </div>
                  )}
                  <div className="flex items-start text-[var(--text-secondary)]">
                       <IconCalendar className="w-5 h-5 mt-0.5 mr-2 text-[var(--text-muted)] flex-shrink-0" />
                       <div>
                          <p className="font-medium text-sm">Fecha Objetivo</p>
                          <p className="text-sm">{estimatedDelivery}</p>
                       </div>
                  </div>
                   <div className="flex items-start text-[var(--text-secondary)] mt-3">
                       {typeConfig.icon}
                       <div>
                          <p className="font-medium text-sm">Tipo de Envío Original</p>
                          <p className="text-sm">{typeConfig.text}</p>
                       </div>
                  </div>
                  {pkg.assignedAt && (
                    <div className="flex items-start text-[var(--text-secondary)] mt-3">
                        <IconClock className="w-5 h-5 mt-0.5 mr-2 text-[var(--text-muted)] flex-shrink-0" />
                        <div>
                            <p className="font-medium text-sm">Última Asignación/Reasignación</p>
                            <p className="text-sm">
                                {new Date(pkg.assignedAt).toLocaleDateString('es-ES', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
                                <span className="text-gray-400 ml-1">
                                    {new Date(pkg.assignedAt).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}
                                </span>
                            </p>
                        </div>
                    </div>
                  )}
              </div>

              {/* Proof of Delivery / Problem Card */}
              {pkg.deliveryPhotosBase64 && pkg.deliveryPhotosBase64.length > 0 && (
                <div className="bg-[var(--background-secondary)] p-4 rounded-lg shadow-sm border border-[var(--border-primary)]">
                    <h4 className="text-sm font-semibold text-[var(--text-muted)] mb-3">
                        {pkg.status === PackageStatus.Delivered ? 'Evidencia de Entrega' : pkg.status === PackageStatus.Returned ? 'Evidencia de Devolución' : 'Evidencia del Problema'}
                    </h4>
                    {(pkg.status === PackageStatus.Delivered || pkg.status === PackageStatus.Returned) && (
                        <div className="p-3 bg-[var(--background-muted)] rounded-md border border-[var(--border-secondary)] space-y-1">
                            <p className="text-sm"><span className="font-semibold text-[var(--text-primary)]">Recibido por:</span> {pkg.deliveryReceiverName}</p>
                            <p className="text-sm"><span className="font-semibold text-[var(--text-primary)]">RUT:</span> {pkg.deliveryReceiverId}</p>
                        </div>
                    )}
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mt-3">
                        {pkg.deliveryPhotosBase64.map((photo, index) => (
                            <img
                                key={index}
                                src={photo}
                                alt={`Evidencia ${index + 1}`}
                                className="aspect-square w-full rounded-md object-cover cursor-pointer hover:opacity-80 transition-opacity"
                                onClick={() => setViewingPhoto(photo)}
                            />
                        ))}
                    </div>
                </div>
              )}
            
              {/* Delivery Actions Card */}
              {canInteract && onStartDelivery && onReportProblem && (
                <div className="bg-[var(--background-secondary)] p-4 rounded-lg shadow-sm border border-[var(--border-primary)]">
                    <h4 className="text-sm font-semibold text-[var(--text-muted)] mb-3 text-center">Acciones de Entrega</h4>
                    <div className="space-y-3">
                        <button 
                            onClick={() => onStartDelivery(pkg)}
                            className="w-full px-4 py-3 text-base font-semibold text-white bg-green-600 rounded-lg hover:bg-green-700 transition-all shadow-sm flex items-center justify-center gap-2"
                        >
                            <IconCheckCircle className="w-5 h-5"/>
                            ENTREGAR
                        </button>
                        <button 
                            onClick={() => onReportProblem(pkg)} 
                            className="w-full px-4 py-2 text-base font-medium text-red-600 bg-[var(--background-secondary)] border border-red-500 rounded-lg hover:bg-red-50 transition-colors flex items-center justify-center gap-2"
                        >
                            <IconAlertTriangle className="w-4 h-4"/>
                            NO PUEDO ENTREGAR
                        </button>
                    </div>
                </div>
              )}

              {/* Redelivery Actions Card */}
              {pkg.status === PackageStatus.Problem && auth?.user?.role === 'DRIVER' && auth?.systemSettings?.allowRedelivery && onRedelivery && (
                <div className="bg-orange-50 p-4 rounded-lg shadow-sm border border-orange-200">
                    <h4 className="text-sm font-semibold text-orange-800 mb-3 text-center">Paquete con Problemas</h4>
                    <div className="space-y-3">
                        <button 
                            onClick={() => onRedelivery(pkg)}
                            className="w-full px-4 py-3 text-base font-semibold text-white bg-orange-600 rounded-lg hover:bg-orange-700 transition-all shadow-sm flex items-center justify-center gap-2"
                        >
                            <IconTruck className="w-5 h-5"/>
                            Reintentar Entrega
                        </button>
                    </div>
                </div>
              )}

              {/* Return Actions Card */}
              {canReturnInteract && (
                <div className="bg-[var(--background-secondary)] p-4 rounded-lg shadow-sm border border-[var(--border-primary)]">
                    <h4 className="text-sm font-semibold text-[var(--text-muted)] mb-3 text-center">Acciones de Devolución</h4>
                    <div className="space-y-3">
                        <button 
                            onClick={() => onStartReturn(pkg)}
                            className="w-full px-4 py-3 text-base font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-all shadow-sm flex items-center justify-center gap-2"
                        >
                            <IconArrowUturnLeft className="w-5 h-5"/>
                            Registrar Devolución
                        </button>
                    </div>
                </div>
              )}

              {/* Admin Closure Card */}
              {(auth?.user?.role === Role.Admin || (auth?.user?.role === Role.OperadorSistemas && auth?.user?.operatorPermissions?.canManagePackages)) && pkg.status !== PackageStatus.Delivered && pkg.status !== PackageStatus.Returned && pkg.status !== PackageStatus.Cancelled && (
                <div className="bg-indigo-50/50 p-4 rounded-lg shadow-sm border border-indigo-100 space-y-4">
                    <div className="flex items-center justify-center gap-2 mb-2">
                        <div className="w-8 h-8 rounded-full bg-indigo-600 flex items-center justify-center text-white">
                            <IconCheckCircle className="w-5 h-5" />
                        </div>
                        <h4 className="text-base font-black text-indigo-900 uppercase tracking-wider">Cierre Administrativo</h4>
                    </div>

                    <div className="space-y-3">
                        <div>
                            <label className="text-[10px] font-bold text-indigo-700 uppercase tracking-widest ml-1 mb-1 block">Recibido por (Nombre)</label>
                            <input 
                                type="text"
                                value={adminReceiverName}
                                onChange={(e) => setAdminReceiverName(e.target.value)}
                                placeholder="Nombre completo del receptor"
                                className="w-full px-3 py-2 text-sm bg-white border border-indigo-200 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none"
                            />
                        </div>
                        <div>
                            <label className="text-[10px] font-bold text-indigo-700 uppercase tracking-widest ml-1 mb-1 block">RUT del Receptor (Opcional)</label>
                            <input 
                                type="text"
                                value={adminReceiverId}
                                onChange={(e) => setAdminReceiverId(e.target.value)}
                                placeholder="12.345.678-k"
                                className="w-full px-3 py-2 text-sm bg-white border border-indigo-200 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none"
                            />
                        </div>

                        <div>
                            <label className="text-[10px] font-bold text-indigo-700 uppercase tracking-widest ml-1 mb-2 block">Evidencia de Entrega (Fotos)</label>
                            <div className="grid grid-cols-3 gap-2 mb-3">
                                {adminPhotos.map((photo, index) => (
                                    <div key={index} className="relative aspect-square rounded-lg overflow-hidden border border-indigo-200 group">
                                        <img src={photo} alt={`Admin Evidencia ${index + 1}`} className="w-full h-full object-cover" />
                                        <button 
                                            onClick={() => handleRemoveAdminPhoto(index)}
                                            className="absolute top-1 right-1 p-1 bg-red-600 text-white rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
                                        >
                                            <IconTrash className="w-3 h-3" />
                                        </button>
                                    </div>
                                ))}
                                <button 
                                    onClick={() => fileInputRef.current?.click()}
                                    disabled={isUploading}
                                    className="aspect-square flex flex-col items-center justify-center border-2 border-dashed border-indigo-300 rounded-lg bg-indigo-50 hover:bg-indigo-100 transition-colors text-indigo-500"
                                >
                                    {isUploading ? (
                                        <IconRefresh className="w-6 h-6 animate-spin" />
                                    ) : (
                                        <>
                                            <IconPlus className="w-6 h-6" />
                                            <span className="text-[9px] font-bold uppercase mt-1">Añadir</span>
                                        </>
                                    )}
                                </button>
                            </div>
                            <input 
                                type="file"
                                ref={fileInputRef}
                                onChange={handleAdminPhotoUpload}
                                accept="image/*"
                                multiple
                                className="hidden"
                            />
                        </div>

                        <button 
                            onClick={handleAdminConfirmDelivery}
                            disabled={isAdminDelivering || adminPhotos.length === 0 || !adminReceiverName}
                            className="w-full px-4 py-3 text-sm font-black text-white bg-indigo-600 rounded-xl hover:bg-indigo-700 transition-all shadow-md disabled:bg-gray-300 disabled:shadow-none flex items-center justify-center gap-2 uppercase tracking-[0.1em]"
                        >
                            {isAdminDelivering ? (
                                <IconRefresh className="w-5 h-5 animate-spin" />
                            ) : (
                                <>
                                    <IconCheckCircle className="w-5 h-5" />
                                    Finalizar Entrega (Admin)
                                </>
                            )}
                        </button>
                        <p className="text-[9px] text-indigo-400 text-center italic">Este proceso marcará el envío como entregado y registrará las fotos como evidencia oficial.</p>
                    </div>
                </div>
              )}



              {/* History Card - Always Visible */}
              <div className="bg-[var(--background-secondary)] p-4 rounded-lg shadow-sm border border-[var(--border-primary)]">
                  <h4 className="text-sm font-semibold text-[var(--text-muted)] mb-4 flex items-center gap-2">
                      <IconHistory className="w-4 h-4" />
                      Historial de Movimientos
                  </h4>
                  <div className="relative border-l-2 border-blue-200 ml-3 space-y-6 pb-2">
                  {pkg.history && pkg.history.length > 0 ? (
                      [...pkg.history].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()).map((event, index) => {
                          const isLast = index === 0;
                          return (
                              <div key={event.timestamp.toString() + index} className="relative ml-6">
                                  <span className={`absolute -left-[31px] top-0 flex items-center justify-center w-6 h-6 rounded-full ring-4 ring-[var(--background-secondary)] ${
                                      isLast ? 'bg-blue-600 text-white shadow-lg' : 'bg-gray-200 text-gray-500'
                                  }`}>
                                      {event.status === PackageStatus.Pending ? <IconPlus className="w-3 h-3" /> :
                                       event.status === PackageStatus.InTransit ? <IconTruck className="w-3 h-3" /> :
                                       event.status === PackageStatus.Delivered ? <IconCheckCircle className="w-3 h-3" /> :
                                       event.status === PackageStatus.Problem ? <IconAlertTriangle className="w-3 h-3" /> :
                                       event.status === PackageStatus.Returned ? <IconArrowUturnLeft className="w-3 h-3" /> :
                                       <IconClock className="w-3 h-3" />}
                                  </span>
                                  <div className={`p-3 rounded-lg border ${isLast ? 'bg-blue-50/50 border-blue-100' : 'bg-gray-50/30 border-gray-100'}`}>
                                      <div className="flex justify-between items-start mb-1">
                                          <div className="flex items-center gap-2">
                                              <h5 className={`font-black text-[10px] uppercase tracking-wider ${isLast ? 'text-blue-700' : 'text-gray-600'}`}>
                                                  {(event.status || '').replace('_', ' ')}
                                              </h5>
                                              {isLast && <span className="flex h-2 w-2 rounded-full bg-blue-600 animate-pulse"></span>}
                                          </div>
                                          <time className="text-[10px] font-bold text-gray-400 bg-white px-2 py-0.5 rounded-full border border-gray-100 shadow-sm">
                                              {new Date(event.timestamp).toLocaleString('es-ES', { 
                                                  day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' 
                                              })}
                                          </time>
                                      </div>
                                      <p className="text-xs text-gray-700 font-medium leading-relaxed">
                                          {event.details}
                                      </p>
                                      
                                      <div className="mt-2 pt-2 border-t border-gray-100/50 flex flex-wrap items-center gap-x-4 gap-y-1">
                                          <div className="flex items-center gap-1.5 text-[9px] font-black text-gray-400 uppercase tracking-tighter">
                                              <IconMapPin className="w-3 h-3 text-gray-300" />
                                              <span>{event.location}</span>
                                          </div>
                                          
                                          {/* Detectar conductor en el texto si no hay campo específico */}
                                          {event.details.toLowerCase().includes('conductor') && (
                                              <div className="flex items-center gap-1.5 text-[9px] font-black text-blue-500 uppercase tracking-tighter">
                                                  <IconTruck className="w-3 h-3" />
                                                  <span>Responsable: {event.details.split('conductor')[1]?.split('(')[0]?.trim().replace(':', '') || 'Asignado'}</span>
                                              </div>
                                          )}
                                      </div>
                                  </div>
                              </div>
                          );
                      })
                  ) : (
                      <div className="ml-6 py-4 text-center text-sm text-gray-400 italic">
                          No hay eventos registrados para este paquete.
                      </div>
                  )}
                  </div>
              </div>
          </div>
        </div>
        <style>{`
          @keyframes fade-in-up {
              from { opacity: 0; transform: translateY(20px); }
              to { opacity: 1; transform: translateY(0); }
          }
          .animate-fade-in-up {
              animation: fade-in-up 0.3s ease-out forwards;
          }
        `}</style>
      </div>

      {isQrModalOpen && (
        <QRCodeModal pkg={pkg} creator={creator} onClose={() => setIsQrModalOpen(false)} />
      )}

      {viewingPhoto && (
        <div 
            className="fixed inset-0 bg-black bg-opacity-80 z-50 flex items-center justify-center p-4 animate-fade-in-up"
            onClick={() => setViewingPhoto(null)}
        >
            <button
                onClick={() => setViewingPhoto(null)}
                className="absolute top-4 right-4 p-2 rounded-full text-white bg-black bg-opacity-50 hover:bg-opacity-75"
                aria-label="Cerrar imagen"
            >
                <IconX className="w-6 h-6" />
            </button>
            <img 
                src={viewingPhoto} 
                alt="Evidencia en tamaño completo" 
                className="max-h-[90vh] max-w-[90vw] object-contain rounded-lg"
                onClick={(e) => e.stopPropagation()}
            />
        </div>
      )}
    </>
  );
};

export default PackageDetailModal;
