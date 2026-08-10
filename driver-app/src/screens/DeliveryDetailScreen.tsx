import React, { useState, useContext, useEffect } from 'react';
import { 
  StyleSheet, 
  View, 
  Text, 
  TouchableOpacity, 
  ScrollView,
  TextInput,
  Alert,
  Image,
  SafeAreaView,
  StatusBar,
  Linking,
  ActivityIndicator,
  Platform,
  Modal
} from 'react-native';
import { COLORS } from '../constants';
import { MaterialCommunityIcons as Icon } from '@expo/vector-icons';
import { AuthContext } from '../contexts/AuthContext';
import * as ImagePicker from 'expo-image-picker';
import { api } from '../services/api';
import { PhotoService } from '../services/PhotoService';

export default function DeliveryDetailScreen({ route, navigation }: any) {
  const { pkg } = route.params;
  const { user, serverUrl } = useContext(AuthContext);
  const isCompleted = ['ENTREGADO', 'CANCELADO', 'DEVUELTO'].includes(pkg.status);
  const isFailedAttempt = ['PROBLEMA', 'REPROGRAMADO'].includes(pkg.status);
  // Falabella Directo's DELIVERED_001 webhook hard-requires a non-empty deliveryProof.recipientId
  // (rejects the whole push with a 400 otherwise — confirmed against their real API) and >=2
  // evidence photos — scoped to this source specifically, regardless of the global system
  // settings, since those are optional for every other source by design.
  const isFalabellaDirectDelivery = pkg.source === 'FALABELLA_DIRECTO';

  // Parse initial photos if any
  const getInitialPhotos = () => {
    if (pkg.photos && pkg.photos.length > 0) return pkg.photos;
    if (pkg.deliveryPhotosBase64) {
      try {
        const parsed = typeof pkg.deliveryPhotosBase64 === 'string'
          ? JSON.parse(pkg.deliveryPhotosBase64)
          : pkg.deliveryPhotosBase64;
        if (Array.isArray(parsed)) return parsed;
      } catch (e) {}
    }
    return [];
  };

  const [currentStatus, setCurrentStatus] = useState(pkg.status);
  const [isRetrying, setIsRetrying] = useState(false);
  const [receiverName, setReceiverName] = useState(isCompleted ? (pkg.receiverName || '') : '');
  const [receiverId, setReceiverId] = useState(pkg.receiverId || '');
  const [photos, setPhotos] = useState<string[]>(getInitialPhotos());
  const [serverPhotos, setServerPhotos] = useState<string[]>(getInitialPhotos());
  const [loading, setLoading] = useState(false);
  const [settings, setSettings] = useState<any>(null);
  const [packageHistory, setPackageHistory] = useState<any[]>(pkg.events || pkg.history || []);

  // Sync settings and package details
  useEffect(() => {
    const fetchSettings = async () => {
      try {
        const data = await api.getSystemSettings();
        setSettings(data);
      } catch (e) {}
    };

    const fetchPackageDetails = async () => {
      try {
        const fullPkg = await api.getPackageDetails(pkg.id);
        if (fullPkg) {
          if (fullPkg.status) setCurrentStatus(fullPkg.status);
          const fullPkgCompleted = ['ENTREGADO', 'CANCELADO', 'DEVUELTO'].includes(fullPkg.status);
          if (fullPkgCompleted) {
            setReceiverName(fullPkg.receiverName || '');
          } else {
            setReceiverName('');
          }
          if (fullPkg.receiverId) setReceiverId(fullPkg.receiverId);
          if (fullPkg.history) setPackageHistory(fullPkg.history);
          
          let fetchedPhotos: string[] = [];
          if (fullPkg.photos && fullPkg.photos.length > 0) {
            fetchedPhotos = fullPkg.photos;
          } else if (fullPkg.deliveryPhotosBase64) {
            try {
              const parsed = typeof fullPkg.deliveryPhotosBase64 === 'string'
                ? JSON.parse(fullPkg.deliveryPhotosBase64)
                : fullPkg.deliveryPhotosBase64;
              if (Array.isArray(parsed)) {
                fetchedPhotos = parsed;
              }
            } catch (err) {}
          }
          
          if (fetchedPhotos.length > 0) {
            setPhotos(fetchedPhotos);
            setServerPhotos(fetchedPhotos);
          }
        }
      } catch (err) {
        console.log('Error fetching package details on mount:', err);
      }
    };

    fetchSettings();
    fetchPackageDetails();
  }, []);

  // Helpers to get image URL
  const getImageUrl = (path: string) => {
    if (path.startsWith('http')) return path;
    const baseUrl = serverUrl.endsWith('/') ? serverUrl.slice(0, -1) : serverUrl;
    return `${baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
  };
  
  // Problem Report State
  const [problemModalVisible, setProblemModalVisible] = useState(false);
  const [problemReason, setProblemReason] = useState('');
  const [customReason, setCustomReason] = useState('');

  const PROBLEM_REASONS = [
    "Destinatario ausente en domicilio",
    "Dirección de entrega incorrecta o incompleta",
    "Entrega rechazada por el destinatario",
    "Acceso denegado o zona peligrosa",
    "Cliente solicita reagendar entrega",
    "Otro motivo (especificar)",
  ];

  const pickImage = async (useCamera: boolean) => {
    if (isCompleted) return;

    setLoading(true);
    try {
      const hasPermission = await PhotoService.requestPermissions();
      if (!hasPermission) {
        Alert.alert("Permisos Denegados", "Necesitamos acceso a la cámara y galería para subir evidencia.");
        return;
      }

      if (useCamera) {
        const photo = await PhotoService.takePhoto();
        if (photo) {
          setPhotos(prev => [...prev, photo]);
        }
      } else {
        const newPhotos = await PhotoService.selectFromGallery(true);
        if (newPhotos && newPhotos.length > 0) {
          setPhotos(prev => [...prev, ...newPhotos]);
        }
      }
    } catch (error) {
      console.error(error);
      Alert.alert("Error", "Ocurrió un problema al procesar la imagen.");
    } finally {
      setLoading(false);
    }
  };

  const handleConfirm = async () => {
    if (isCompleted) return;
    
    // Validation based on settings
    const requiredPhotos = isFalabellaDirectDelivery ? Math.max(2, settings?.requiredPhotos || 1) : (settings?.requiredPhotos || 1);
    if (photos.length < requiredPhotos) {
      Alert.alert("Acción Requerida", `Debes añadir al menos ${requiredPhotos} foto(s) de evidencia`);
      return;
    }

    const isRutRequired = isFalabellaDirectDelivery || (settings?.isRutRequired ?? true);
    if (isRutRequired && !receiverId.trim()) {
      Alert.alert("Dato Obligatorio", isFalabellaDirectDelivery ? "Falabella Directo exige el RUT de quien recibe para poder cerrar la entrega." : "El RUT del receptor es obligatorio según la configuración del sistema.");
      return;
    }

    setLoading(true);
    try {
      await api.confirmDelivery(pkg.id, {
        receiverName,
        receiverId,
        photosBase64: photos
      });
      
      Alert.alert("¡Envío Entregado!", "La información se ha sincronizado correctamente", [
        { text: "Cerrar", onPress: () => navigation.goBack() }
      ]);
    } catch (error: any) {
       const errorMsg = error.response?.data?.message || error.message || "No se pudo confirmar la entrega";
       Alert.alert("Error", errorMsg);
    } finally {
      setLoading(false);
    }
  };

  const handleReportProblem = async () => {
    if (isCompleted) return;
    const finalReason = problemReason === "Otro motivo (especificar)" ? customReason : problemReason;
    
    if (!finalReason) {
      Alert.alert("Error", "Por favor selecciona o escribe un motivo.");
      return;
    }

    const requiredPhotos = settings?.requiredPhotos || 1;
    if (photos.length < requiredPhotos) {
      Alert.alert("Error", `Debes añadir al menos ${requiredPhotos} foto(s) de evidencia del problema.`);
      return;
    }

    setLoading(true);
    try {
      await api.markAsProblem(pkg.id, finalReason, photos);
      setProblemModalVisible(false);
      Alert.alert("Problema Reportado", "El paquete ha sido marcado con problema.", [
        { text: "Cerrar", onPress: () => navigation.goBack() }
      ]);
    } catch (error: any) {
      const errorMsg = error.response?.data?.message || error.message || "No se pudo reportar el problema";
      Alert.alert("Error", errorMsg);
    } finally {
      setLoading(false);
    }
  };

  const openWhatsApp = () => {
    const phone = pkg.recipientPhone.replace(/\D/g, '');
    const url = `whatsapp://send?phone=${phone}&text=Hola ${pkg.recipientName}, soy el conductor de Full Envíos...`;
    Linking.openURL(url).catch(() => Alert.alert('Error', 'WhatsApp no está instalado'));
  };

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="dark-content" />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Icon name="chevron-left" size={28} color="#0f172a" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{isCompleted ? 'Resumen de Entrega' : 'Detalle de Entrega'}</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {(pkg.status === 'CANCELADO' || pkg.status === 'REPROGRAMADO' || pkg.status === 'PROBLEMA') && (
          <View style={[
            styles.warningBanner, 
            { backgroundColor: 
                pkg.status === 'CANCELADO' ? '#fee2e2' : 
                pkg.status === 'REPROGRAMADO' ? '#fef3c7' : 
                '#f1f5f9' 
            }
          ]}>
            <Icon 
              name="alert-circle" 
              size={24} 
              color={
                pkg.status === 'CANCELADO' ? '#991b1b' : 
                pkg.status === 'REPROGRAMADO' ? '#92400e' : 
                '#475569'
              } 
            />
            <Text style={[
              styles.warningText, 
              { color: 
                  pkg.status === 'CANCELADO' ? '#991b1b' : 
                  pkg.status === 'REPROGRAMADO' ? '#92400e' : 
                  '#475569'
              }
            ]}>
              {pkg.status === 'CANCELADO' 
                ? 'ESTE PEDIDO HA SIDO CANCELADO. NO REALIZAR LA ENTREGA.' 
                : pkg.status === 'REPROGRAMADO'
                ? 'ESTE PEDIDO HA SIDO REPROGRAMADO.'
                : 'SE HA REPORTADO UN PROBLEMA CON ESTE PEDIDO.'}
            </Text>
            {isFailedAttempt && !isRetrying && (
              <TouchableOpacity 
                style={styles.retryBtn} 
                onPress={() => {
                  setIsRetrying(true);
                  Alert.alert("Modo Reintento", "Ahora puedes editar los datos y finalizar la entrega.");
                }}
              >
                <Text style={styles.retryBtnText}>REINTENTAR</Text>
              </TouchableOpacity>
            )}
          </View>
        )}
        <View style={styles.infoCard}>
          <View style={styles.statusRow}>
             <View style={styles.idBadge}>
               <Text style={styles.idText}>ORDEN #{pkg.id.slice(-8)}</Text>
             </View>
             {isCompleted && (
               <View style={[styles.doneBadge, { backgroundColor: pkg.status === 'ENTREGADO' ? '#dcfce7' : '#fee2e2' }]}>
                 <Text style={[styles.doneText, { color: pkg.status === 'ENTREGADO' ? '#166534' : '#991b1b' }]}>{pkg.status}</Text>
               </View>
             )}
          </View>
          <Text style={styles.recipientName}>{pkg.recipientName}</Text>
          <View style={styles.addressBox}>
            <Icon name="map-marker" size={20} color="#ef4444" />
            <Text style={styles.addressText}>{pkg.recipientAddress}, {pkg.recipientCommune}</Text>
          </View>
          
           {!isCompleted && (
            <View style={styles.contactRow}>
              <TouchableOpacity style={styles.contactBtn} onPress={() => Linking.openURL(`tel:${pkg.recipientPhone}`)}>
                <Icon name="phone" size={22} color="#2563eb" />
                <Text style={styles.contactBtnText}>Llamar</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.contactBtn, styles.waBtn]} onPress={openWhatsApp}>
                <Icon name="whatsapp" size={22} color="#22c55e" />
                <Text style={[styles.contactBtnText, styles.waText]}>WhatsApp</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>

        <View style={styles.formSection}>
          <Text style={styles.sectionTitle}>Datos del Receptor</Text>
          
          <View style={styles.inputGroup}>
            <Text style={styles.label}>Nombre completo</Text>
            <TextInput 
              style={[styles.input, (isCompleted || (isFailedAttempt && !isRetrying)) && styles.disabledInput]}
              value={receiverName}
              onChangeText={setReceiverName}
              editable={!isCompleted && (!isFailedAttempt || isRetrying)}
              placeholder="Ej: Juan Pérez"
            />
          </View>

          <View style={styles.inputGroup}>
            <Text style={styles.label}>RUT / Cédula {(isFalabellaDirectDelivery || settings?.isRutRequired) ? '(Obligatorio)' : '(Opcional/Recomendado)'}</Text>
            <TextInput 
              style={[styles.input, (isCompleted || (isFailedAttempt && !isRetrying)) && styles.disabledInput]}
              value={receiverId}
              onChangeText={setReceiverId}
              editable={!isCompleted && (!isFailedAttempt || isRetrying)}
              placeholder="12.345.678-k"
            />
          </View>

          <Text style={styles.sectionTitle}>Evidencia Fotográfica</Text>
          <View style={styles.photoGrid}>
            {photos.map((photo, index) => (
              <View key={index} style={styles.photoWrapper}>
                <Image source={{ uri: photo }} style={styles.photoThumb} />
                {!isCompleted && (
                  <TouchableOpacity 
                    style={styles.removePhoto}
                    onPress={() => setPhotos(photos.filter((_, i) => i !== index))}
                  >
                    <Icon name="close-circle" size={20} color="#ef4444" />
                  </TouchableOpacity>
                )}
              </View>
            ))}
            
            {(!isCompleted && (!isFailedAttempt || isRetrying)) && (
              <View style={styles.photoActions}>
                <TouchableOpacity style={styles.addPhotoBtn} onPress={() => pickImage(true)}>
                  <Icon name="camera-plus" size={32} color="#94a3b8" />
                  <Text style={styles.addPhotoText}>Cámara</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.addPhotoBtn} onPress={() => pickImage(false)}>
                  <Icon name="image-plus" size={32} color="#94a3b8" />
                  <Text style={styles.addPhotoText}>Galería</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
          
          {/* Fotos ya en el servidor */}
          {serverPhotos && serverPhotos.length > 0 && (
            <View style={{ marginTop: 20 }}>
              <Text style={styles.sectionTitle}>Fotos en Servidor</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                <View style={styles.photoGrid}>
                  {serverPhotos.map((photoPath: string, index: number) => (
                    <TouchableOpacity key={index} onPress={() => Linking.openURL(getImageUrl(photoPath))}>
                       <Image source={{ uri: getImageUrl(photoPath) }} style={styles.photoThumb} />
                    </TouchableOpacity>
                  ))}
                </View>
              </ScrollView>
            </View>
          )}
          
          {/* Historial del Paquete */}
          <View style={{ marginTop: 30 }}>
            <Text style={styles.sectionTitle}>Historial del Paquete</Text>
            {packageHistory.length > 0 ? (
              <View style={styles.timeline}>
                {packageHistory.map((event: any, index: number) => (
                  <View key={index} style={styles.timelineItem}>
                    <View style={styles.timelineIconContainer}>
                      <View style={[styles.timelineLine, index === packageHistory.length - 1 && { height: 0 }]} />
                      <View style={styles.timelineDot}>
                        <Icon 
                          name={
                            event.status === 'ENTREGADO' ? 'check-circle' :
                            event.status === 'DESPACHADO' ? 'truck-delivery' :
                            event.status === 'RETIRADO' ? 'package-variant-closed' :
                            'circle-outline'
                          } 
                          size={16} 
                          color={COLORS.PRIMARY} 
                        />
                      </View>
                    </View>
                    <View style={styles.timelineContent}>
                      <Text style={styles.timelineStatus}>{event.status}</Text>
                      <Text style={styles.timelineDetail}>{event.notes || 'Evento registrado'}</Text>
                      <Text style={styles.timelineDate}>{new Date(event.createdAt).toLocaleString()}</Text>
                    </View>
                  </View>
                ))}
              </View>
            ) : (
              <Text style={styles.noHistoryText}>No hay eventos registrados aún.</Text>
            )}
          </View>
          
          {/* Indicador de fotos restantes */}
          {!isCompleted && settings && (() => {
            const effectiveRequiredPhotos = isFalabellaDirectDelivery ? Math.max(2, settings.requiredPhotos || 1) : settings.requiredPhotos;
            return (
              <View style={styles.photoStatus}>
                 {photos.length < effectiveRequiredPhotos ? (
                   <Text style={styles.photoStatusText}>
                     Faltan {effectiveRequiredPhotos - photos.length} foto(s) de evidencia
                   </Text>
                 ) : (
                   <Text style={[styles.photoStatusText, { color: '#16a34a' }]}>
                     ✓ Evidencia fotográfica completa
                   </Text>
                 )}
              </View>
            );
          })()}
        </View>
      </ScrollView>

      {(!isCompleted && (!isFailedAttempt || isRetrying)) && (
        <View style={styles.footer}>
          <TouchableOpacity 
            style={[styles.problemBtn, loading && styles.disabledBtn]}
            onPress={() => setProblemModalVisible(true)}
            disabled={loading}
          >
            <Text style={styles.problemBtnText}>NO PUEDO ENTREGAR</Text>
          </TouchableOpacity>
          
          <TouchableOpacity
            style={[
              styles.confirmBtn,
              (loading || photos.length < (isFalabellaDirectDelivery ? Math.max(2, settings?.requiredPhotos || 1) : (settings?.requiredPhotos || 1)) || ((isFalabellaDirectDelivery || settings?.isRutRequired) && !receiverId)) && styles.disabledBtn
            ]}
            onPress={handleConfirm}
            disabled={loading || photos.length < (isFalabellaDirectDelivery ? Math.max(2, settings?.requiredPhotos || 1) : (settings?.requiredPhotos || 1)) || ((isFalabellaDirectDelivery || settings?.isRutRequired) && !receiverId)}
          >
            {loading ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.confirmBtnText}>ENTREGAR</Text>
            )}
          </TouchableOpacity>
        </View>
      )}

      {/* Modal de Reporte de Problemas */}
      <Modal
        visible={problemModalVisible}
        transparent={true}
        animationType="slide"
        onRequestClose={() => setProblemModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Reportar Problema</Text>
              <TouchableOpacity onPress={() => setProblemModalVisible(false)}>
                <Icon name="close" size={24} color="#64748b" />
              </TouchableOpacity>
            </View>

            <ScrollView style={styles.modalBody}>
              <Text style={styles.modalLabel}>Motivo del problema:</Text>
              {PROBLEM_REASONS.map((reason) => (
                <TouchableOpacity 
                  key={reason} 
                  style={[
                    styles.reasonOption,
                    problemReason === reason && styles.selectedReason
                  ]}
                  onPress={() => setProblemReason(reason)}
                >
                  <View style={styles.radioContainer}>
                    <View style={[styles.radio, problemReason === reason && styles.radioSelected]} />
                  </View>
                  <Text style={[styles.reasonText, problemReason === reason && styles.selectedReasonText]}>
                    {reason}
                  </Text>
                </TouchableOpacity>
              ))}

              {problemReason === "Otro motivo (especificar)" && (
                <TextInput
                  style={styles.customReasonInput}
                  placeholder="Describe el motivo detalladamente..."
                  value={customReason}
                  onChangeText={setCustomReason}
                  multiline
                  numberOfLines={3}
                />
              )}
              
              <View style={{ height: 20 }} />
            </ScrollView>

            <View style={styles.modalFooter}>
              <TouchableOpacity 
                style={[styles.modalConfirmBtn, (!problemReason || loading) && styles.disabledBtn]}
                onPress={handleReportProblem}
                disabled={!problemReason || loading}
              >
                {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.modalConfirmBtnText}>CONFIRMAR REPORTE</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f8fafc',
    paddingTop: Platform.OS === 'android' ? StatusBar.currentHeight : 0,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#0f172a',
  },
  backBtn: { padding: 4 },
  content: {
    padding: 16,
    paddingBottom: 100,
  },
  infoCard: {
    backgroundColor: '#fff',
    borderRadius: 24,
    padding: 24,
    marginBottom: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.05,
    shadowRadius: 12,
    elevation: 3,
  },
  idBadge: {
    backgroundColor: '#eff6ff',
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
    marginBottom: 12,
  },
  idText: {
    color: '#2563eb',
    fontSize: 11,
    fontWeight: '800',
    fontFamily: 'monospace',
  },
  recipientName: {
    fontSize: 22,
    fontWeight: '800',
    color: '#1e293b',
    marginBottom: 8,
  },
  addressBox: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 24,
  },
  addressText: {
    flex: 1,
    fontSize: 15,
    color: '#64748b',
    lineHeight: 22,
  },
  contactRow: {
    flexDirection: 'row',
    gap: 12,
  },
  photoStatus: {
    marginTop: 12,
    alignItems: 'center',
  },
  photoStatusText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#ef4444',
  },
  contactBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f1f5f9',
    paddingVertical: 12,
    borderRadius: 16,
    gap: 8,
  },
  waBtn: {
    backgroundColor: '#f0fdf4',
  },
  contactBtnText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#2563eb',
  },
  waText: {
    color: '#16a34a',
  },
  formSection: {
    paddingHorizontal: 4,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: '#0f172a',
    marginTop: 12,
    marginBottom: 16,
  },
  inputGroup: {
    marginBottom: 20,
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    color: '#64748b',
    marginBottom: 8,
    marginLeft: 4,
  },
  input: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 16,
    padding: 16,
    fontSize: 15,
    color: '#1e293b',
  },
  photoGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  photoWrapper: {
    position: 'relative',
  },
  photoThumb: {
    width: 100,
    height: 100,
    borderRadius: 16,
  },
  removePhoto: {
    position: 'absolute',
    top: -5,
    right: -5,
    backgroundColor: '#fff',
    borderRadius: 10,
  },
  addPhotoBtn: {
    width: 80,
    height: 100,
    borderRadius: 16,
    borderWidth: 2,
    borderStyle: 'dashed',
    borderColor: '#cbd5e1',
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#f8fafc',
  },
  addPhotoText: {
    fontSize: 10,
    color: '#94a3b8',
    marginTop: 4,
    fontWeight: '700',
  },
  photoActions: {
    flexDirection: 'row',
    gap: 12,
  },
  statusRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  doneBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
  },
  doneText: {
    fontSize: 11,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  disabledInput: {
    backgroundColor: '#f1f5f9',
    color: '#64748b',
    borderColor: '#e2e8f0',
  },
  footer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: '#fff',
    padding: 16,
    paddingBottom: Platform.OS === 'ios' ? 40 : 20,
    borderTopWidth: 1,
    borderTopColor: '#f1f5f9',
    flexDirection: 'row',
    gap: 12,
  },
  confirmBtn: {
    flex: 2,
    backgroundColor: '#2563eb',
    borderRadius: 16,
    paddingVertical: 18,
    alignItems: 'center',
    shadowColor: '#2563eb',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 8,
  },
  problemBtn: {
    flex: 1,
    backgroundColor: '#fff',
    borderRadius: 16,
    paddingVertical: 18,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#ef4444',
  },
  problemBtnText: {
    color: '#ef4444',
    fontSize: 12,
    fontWeight: '800',
    textAlign: 'center',
  },
  disabledBtn: {
    backgroundColor: '#cbd5e1',
    borderColor: '#cbd5e1',
    shadowOpacity: 0,
    elevation: 0,
  },
  confirmBtnText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '800',
    letterSpacing: 1,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 32,
    borderTopRightRadius: 32,
    maxHeight: '80%',
    paddingBottom: 40,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 24,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: '#0f172a',
  },
  modalBody: {
    padding: 24,
  },
  modalLabel: {
    fontSize: 14,
    fontWeight: '700',
    color: '#64748b',
    marginBottom: 16,
  },
  reasonOption: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 12,
    marginBottom: 8,
    backgroundColor: '#f8fafc',
  },
  selectedReason: {
    backgroundColor: '#fee2e2',
  },
  radioContainer: {
    marginRight: 12,
  },
  radio: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: '#cbd5e1',
    justifyContent: 'center',
    alignItems: 'center',
  },
  radioSelected: {
    borderColor: '#ef4444',
    backgroundColor: '#ef4444',
  },
  reasonText: {
    fontSize: 15,
    color: '#334155',
    flex: 1,
  },
  selectedReasonText: {
    fontWeight: '700',
    color: '#991b1b',
  },
  customReasonInput: {
    marginTop: 12,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 12,
    padding: 12,
    fontSize: 15,
    color: '#1e293b',
    textAlignVertical: 'top',
  },
  modalFooter: {
    paddingHorizontal: 24,
    paddingTop: 12,
  },
  modalConfirmBtn: {
    backgroundColor: '#ef4444',
    borderRadius: 16,
    paddingVertical: 18,
    alignItems: 'center',
  },
  modalConfirmBtnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '800',
  },
  warningBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderRadius: 16,
    marginBottom: 16,
    gap: 12,
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.05)',
  },
  warningText: {
    flex: 1,
    fontSize: 14,
    fontWeight: '800',
  },
  retryBtn: {
    backgroundColor: '#0f172a',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  retryBtnText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '800',
  },
  timeline: {
    marginTop: 8,
    paddingLeft: 4,
  },
  timelineItem: {
    flexDirection: 'row',
    marginBottom: 0,
  },
  timelineIconContainer: {
    width: 30,
    alignItems: 'center',
  },
  timelineLine: {
    width: 2,
    backgroundColor: '#e2e8f0',
    flex: 1,
    marginTop: 20,
  },
  timelineDot: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#fff',
    borderWidth: 2,
    borderColor: '#e2e8f0',
    justifyContent: 'center',
    alignItems: 'center',
    position: 'absolute',
    top: 0,
    zIndex: 10,
  },
  timelineContent: {
    flex: 1,
    paddingLeft: 12,
    paddingBottom: 24,
  },
  timelineStatus: {
    fontSize: 14,
    fontWeight: '800',
    color: '#1e293b',
    textTransform: 'uppercase',
  },
  timelineDetail: {
    fontSize: 13,
    color: '#64748b',
    marginTop: 2,
  },
  timelineDate: {
    fontSize: 11,
    color: '#94a3b8',
    marginTop: 4,
  },
  noHistoryText: {
    fontSize: 14,
    color: '#94a3b8',
    fontStyle: 'italic',
    textAlign: 'center',
    marginTop: 10,
  }
});
