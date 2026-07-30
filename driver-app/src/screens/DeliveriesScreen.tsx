import React, { useState, useEffect, useContext, useMemo, useRef } from 'react';
import { 
  StyleSheet, 
  View, 
  Text, 
  FlatList, 
  TouchableOpacity, 
  RefreshControl,
  SafeAreaView,
  StatusBar,
  Share,
  Alert,
  Platform,
  TextInput,
  Animated,
  Easing
} from 'react-native';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { AuthContext } from '../contexts/AuthContext';
import { api } from '../services/api';
import { OfflineManager } from '../services/OfflineManager';
import { COLORS } from '../constants';
import { MaterialCommunityIcons as Icon } from '@expo/vector-icons';

export default function DeliveriesScreen({ navigation }: any) {
  const { user } = useContext(AuthContext);
  const [packages, setPackages] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState<'pending' | 'closed'>('pending');
  const [searchQuery, setSearchQuery] = useState('');
  const [settings, setSettings] = useState<any>(null);
  const [isOnline, setIsOnline] = useState(true);

  const fetchPackages = async () => {
    setLoading(true);
    try {
      const online = await OfflineManager.isConnected();
      setIsOnline(!!online);
      const data = await api.getDriverPackages(user.id);
      setPackages(data || []);
    } catch (error) {
      console.error("Error fetching packages", error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const blinkAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(blinkAnim, {
          toValue: 1,
          duration: 800,
          useNativeDriver: false,
          easing: Easing.inOut(Easing.ease)
        }),
        Animated.timing(blinkAnim, {
          toValue: 0,
          duration: 800,
          useNativeDriver: false,
          easing: Easing.inOut(Easing.ease)
        })
      ])
    ).start();
  }, []);

  useEffect(() => {
    fetchPackages();
    const fetchSettings = async () => {
      try {
        const data = await api.getSystemSettings();
        setSettings(data);
      } catch (e) {}
    };
    fetchSettings();
    // Poll every 30 seconds
    const interval = setInterval(fetchPackages, 30000);
    return () => clearInterval(interval);
  }, []);

  const onRefresh = () => {
    setRefreshing(true);
    fetchPackages();
  };

  const filteredPackages = useMemo(() => {
    const CLOSED_STATUSES = ['ENTREGADO', 'PROBLEMA', 'DEVUELTO', 'CANCELADO'];
    const today = new Date().toISOString().split('T')[0];
    
    let result = packages;
    if (activeTab === 'pending') {
      // Mostrar TODO lo que no esté cerrado (sin importar la fecha)
      result = packages.filter(p => !CLOSED_STATUSES.includes(p.status));
    } else {
      // Mostrar TODO lo que esté cerrado (el API ya nos dará los relevantes)
      result = packages.filter(p => CLOSED_STATUSES.includes(p.status));
    }

    if (searchQuery.trim() !== '') {
        const query = searchQuery.toLowerCase().trim();
        result = result.filter(p => 
            (p.recipientName && p.recipientName.toLowerCase().includes(query)) ||
            (p.recipientAddress && p.recipientAddress.toLowerCase().includes(query)) ||
            (p.id && p.id.toLowerCase().includes(query)) ||
            (p.recipientPhone && p.recipientPhone.includes(query))
        );
    }
    return result;
  }, [packages, activeTab, searchQuery]);

  const handleExportCircuit = async () => {
    const pending = packages.filter(p => p.status !== 'ENTREGADO' && p.status !== 'PROBLEMA');
    const csvContent = "Address\n" + pending
      .map(p => `"${p.recipientAddress}, ${p.recipientCommune}"`)
      .join('\n');

    try {
      const filename = `Ruta_Circuit_${new Date().getTime()}.csv`;
      const fileUri = `${FileSystem.cacheDirectory}${filename}`;
      
      await FileSystem.writeAsStringAsync(fileUri, "\uFEFF" + csvContent, {
        encoding: FileSystem.EncodingType.UTF8,
      });

      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(fileUri, {
          mimeType: 'text/csv',
          dialogTitle: 'Enviar a Circuit',
          UTI: 'public.comma-separated-values-text',
        });
      } else {
        // Fallback to text sharing if file sharing not available
        await Share.share({
          message: pending.map(p => `${p.recipientAddress}, ${p.recipientCommune}`).join('\n'),
          title: 'Ruta Circuit'
        });
      }
    } catch (error: any) {
      Alert.alert('Error', error.message);
    }
  };

  const renderItem = ({ item }: { item: any }) => {
    const isCancelled = item.status === 'CANCELADO';
    const isRescheduled = item.status === 'REPROGRAMADO';
    const isCritical = isCancelled || isRescheduled;

    const backgroundColor = isCritical ? blinkAnim.interpolate({
      inputRange: [0, 1],
      outputRange: isCancelled ? ['#fee2e2', '#fecaca'] : ['#fef3c7', '#fde68a']
    }) : '#fff';

    const borderColor = isCancelled ? '#ef4444' : isRescheduled ? '#f59e0b' : '#fff';

    return (
      <Animated.View style={[
        styles.card,
        { backgroundColor, borderColor, borderWidth: isCritical ? 2 : 0 }
      ]}>
        <TouchableOpacity 
          onPress={() => navigation.navigate('DeliveryDetail', { pkg: item })}
          activeOpacity={0.7}
        >
          <View style={styles.cardHeader}>
            <View style={[
                styles.statusBadge, 
                { backgroundColor: 
                    item.status === 'ENTREGADO' ? '#dcfce7' : 
                    isCancelled ? '#991b1b' :
                    isRescheduled ? '#92400e' :
                    '#f1f5f9' 
                }
            ]}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                {isCancelled && <Icon name="close-circle" size={14} color="#fff" />}
                {isRescheduled && <Icon name="calendar-clock" size={14} color="#fff" />}
                <Text style={[
                    styles.statusText, 
                    { color: 
                        item.status === 'ENTREGADO' ? '#166534' : 
                        isCritical ? '#fff' :
                        '#475569' 
                    }
                ]}>
                  {isCancelled ? 'CANCELADO - NO VISITAR' : isRescheduled ? 'REPROGRAMADO' : item.status}
                </Text>
              </View>
            </View>
            <Text style={styles.idText}>#{item.id.slice(-6)}</Text>
          </View>
          
          <Text style={styles.recipientName}>{item.recipientName}</Text>
          <View style={styles.addressContainer}>
            <Icon name="map-marker" size={16} color={isCancelled ? "#991b1b" : "#ef4444"} />
            <Text style={[
              styles.addressText, 
              isCancelled && { color: '#991b1b', fontWeight: '700' }
            ]} numberOfLines={2}>
              {item.recipientAddress}, {item.recipientCommune}
            </Text>
          </View>

          <View style={styles.cardFooter}>
             <View style={styles.metaInfo}>
                <Icon name="clock-outline" size={14} color={isCancelled ? "#991b1b" : "#94a3b8"} />
                <Text style={[styles.metaText, isCancelled && { color: '#991b1b' }]}>
                  {isCancelled ? 'ALERTA: Entrega cancelada' : isRescheduled ? 'ALERTA: Entrega reagendada' : 'Prioridad: Estándar'}
                </Text>
             </View>
             <Icon name="chevron-right" size={20} color={isCancelled ? "#991b1b" : "#cbd5e1"} />
          </View>
        </TouchableOpacity>
      </Animated.View>
    );
  };

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="dark-content" />
      
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Icon name="chevron-left" size={28} color="#0f172a" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Entregas</Text>
        {settings?.circuitExportEnabled && (
          <TouchableOpacity onPress={handleExportCircuit} style={styles.circuitBtn}>
            <Icon name="share-variant" size={20} color="#2563eb" />
            <Text style={styles.circuitBtnText}>Circuit</Text>
          </TouchableOpacity>
        )}
      </View>

      <View style={styles.tabBar}>
        <TouchableOpacity 
          style={[styles.tab, activeTab === 'pending' && styles.activeTab]}
          onPress={() => setActiveTab('pending')}
        >
          <Text style={[styles.tabText, activeTab === 'pending' && styles.activeTabText]}>
            Pendientes ({packages.filter(p => !['ENTREGADO', 'PROBLEMA', 'DEVUELTO', 'CANCELADO'].includes(p.status)).length})
          </Text>
        </TouchableOpacity>
        <TouchableOpacity 
          style={[styles.tab, activeTab === 'closed' && styles.activeTab]}
          onPress={() => setActiveTab('closed')}
        >
          <Text style={[styles.tabText, activeTab === 'closed' && styles.activeTabText]}>
            Cerrados ({packages.filter(p => ['ENTREGADO', 'PROBLEMA', 'DEVUELTO', 'CANCELADO'].includes(p.status)).length})
          </Text>
        </TouchableOpacity>
      </View>

      <View style={styles.searchContainer}>
        <Icon name="magnify" size={20} color="#94a3b8" />
        <TextInput
          style={styles.searchInput}
          placeholder="Buscar por nombre, calle o ID..."
          value={searchQuery}
          onChangeText={setSearchQuery}
          placeholderTextColor="#94a3b8"
          autoCorrect={false}
        />
        {searchQuery.length > 0 && (
          <TouchableOpacity onPress={() => setSearchQuery('')} style={styles.clearBtn}>
            <Icon name="close" size={16} color="#fff" />
          </TouchableOpacity>
        )}
      </View>

      <FlatList
        data={filteredPackages}
        renderItem={renderItem}
        keyExtractor={item => item.id}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#2563eb" />
        }
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Icon name="package-variant" size={64} color="#e2e8f0" />
            <Text style={styles.emptyText}>No hay paquetes en esta sección</Text>
          </View>
        }
      />

      {activeTab === 'pending' && (
        <TouchableOpacity 
          style={styles.fab}
          onPress={() => navigation.navigate('Scanner')}
        >
          <Icon name="qrcode-scan" size={28} color="#fff" />
        </TouchableOpacity>
      )}
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
  backBtn: {
    padding: 4,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#0f172a',
  },
  circuitBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#eff6ff',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    gap: 4,
  },
  circuitBtnText: {
    color: '#2563eb',
    fontSize: 12,
    fontWeight: '700',
  },
  tabBar: {
    flexDirection: 'row',
    backgroundColor: '#fff',
    paddingHorizontal: 16,
    paddingVertical: 8,
    gap: 8,
  },
  tab: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
    borderRadius: 12,
    backgroundColor: '#f1f5f9',
  },
  activeTab: {
    backgroundColor: '#2563eb',
  },
  tabText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#64748b',
  },
  activeTabText: {
    color: '#fff',
  },
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 4,
    paddingHorizontal: 12,
    height: 44,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  searchInput: {
    flex: 1,
    marginLeft: 8,
    fontSize: 14,
    color: '#0f172a',
  },
  clearBtn: {
    backgroundColor: '#cbd5e1',
    padding: 2,
    borderRadius: 10,
  },
  listContent: {
    padding: 16,
    paddingBottom: 100,
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 20,
    padding: 16,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 10,
    elevation: 2,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  statusBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
  },
  statusText: {
    fontSize: 10,
    fontWeight: 'bold',
    textTransform: 'uppercase',
  },
  idText: {
    color: '#94a3b8',
    fontSize: 12,
    fontFamily: 'monospace',
  },
  recipientName: {
    fontSize: 17,
    fontWeight: '700',
    color: '#1e293b',
    marginBottom: 6,
  },
  addressContainer: {
    flexDirection: 'row',
    gap: 6,
    marginBottom: 16,
  },
  addressText: {
    flex: 1,
    color: '#64748b',
    fontSize: 14,
    lineHeight: 18,
  },
  cardFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#f1f5f9',
  },
  metaInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  metaText: {
    fontSize: 12,
    color: '#94a3b8',
  },
  emptyContainer: {
    alignItems: 'center',
    marginTop: 80,
  },
  emptyText: {
    color: '#94a3b8',
    fontSize: 15,
    marginTop: 12,
  },
  fab: {
    position: 'absolute',
    bottom: 24,
    right: 24,
    backgroundColor: '#2563eb',
    width: 60,
    height: 60,
    borderRadius: 30,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#2563eb',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 8,
  }
});
