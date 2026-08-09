import React, { useState, useEffect, useContext } from 'react';
import { PackageStatus } from '../../constants';
import type { Package, User } from '../../types';
import { api, ApiError, DeliveryConfirmationData } from '../../services/api';
import PackageList from '../PackageList';
import PackageDetailModal from '../PackageDetailModal';
import ReturnConfirmationModal from './ReturnConfirmationModal';
import { AuthContext } from '../../contexts/AuthContext';
import { offlineQueue } from '../../services/offlineQueue';
import { IconAlertTriangle } from '../Icon';

// See DriverDashboard.tsx's isNetworkFailure for the full rationale.
const isNetworkFailure = (error: any) => !navigator.onLine || !(error instanceof ApiError) || !error.status;

const ReturnsDashboard: React.FC = () => {
  const [returnPackages, setReturnPackages] = useState<Package[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [selectedPackage, setSelectedPackage] = useState<Package | null>(null);

  const handleSelectPackageDetails = async (pkg: Package) => {
    setSelectedPackage(pkg);
    try {
      const fullPkg = await api.getPackage(pkg.id);
      setSelectedPackage(fullPkg);
    } catch (err) {
      console.error("Error fetching full package details:", err);
    }
  };
  const [returningPackage, setReturningPackage] = useState<Package | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [offlinePendingCount, setOfflinePendingCount] = useState(0);
  const auth = useContext(AuthContext);

  // Reflect the offline queue's pending count here for the banner below. The actual draining
  // happens in DriverMobileLayout.tsx (see DriverDashboard.tsx for the full rationale).
  useEffect(() => {
    if (!auth?.user) return;
    setOfflinePendingCount(offlineQueue.getPendingCount());
    const onQueueChange = () => setOfflinePendingCount(offlineQueue.getPendingCount());
    window.addEventListener('offline-queue-changed', onQueueChange);
    return () => window.removeEventListener('offline-queue-changed', onQueueChange);
  }, [auth?.user]);

  // Load from cache on mount
  useEffect(() => {
    if (!auth?.user) return;
    const cachedReturns = localStorage.getItem(`driver_returns_${auth.user.id}`);
    const cachedUsers = localStorage.getItem(`driver_users`);
    
    if (cachedReturns) {
      try {
        const parsed = JSON.parse(cachedReturns);
        setReturnPackages(parsed);
        setIsLoading(false);
      } catch (e) {
        console.error("Error parsing cached returns", e);
      }
    }
    
    if (cachedUsers) {
      try {
        const parsed = JSON.parse(cachedUsers);
        setUsers(parsed);
      } catch (e) {
        console.error("Error parsing cached users", e);
      }
    }
  }, [auth?.user?.id]);

  const fetchData = async (silent = false) => {
    if (!auth?.user) return;
    if (!silent) setIsLoading(true);
    try {
        const [{ packages: pkgs }, allUsers] = await Promise.all([
            api.getPackages({ driverFilter: auth.user.id, statusFilter: PackageStatus.ReturnPending, limit: 0 }),
            api.getUsers()
        ]);
        setReturnPackages(pkgs);
        setUsers(allUsers);
        
        localStorage.setItem(`driver_returns_${auth.user.id}`, JSON.stringify(pkgs));
        localStorage.setItem(`driver_users`, JSON.stringify(allUsers));
    } catch (error) {
        console.error("Failed to fetch driver return data", error);
    } finally {
        setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchData(true); // Initial background fetch
    const intervalId = setInterval(() => fetchData(true), 20000); // Poll every 20 seconds
    return () => clearInterval(intervalId);
  }, [auth?.user]);

  const handleStartReturn = (pkg: Package) => {
    setReturningPackage(pkg);
  };

  const handleConfirmReturn = async (pkgId: string, data: DeliveryConfirmationData) => {
    try {
      await api.confirmReturn(pkgId, data);
      setReturnPackages(prev => prev.filter(p => p.id !== pkgId));
      setReturningPackage(null);
    } catch (error: any) {
        if (isNetworkFailure(error)) {
          offlineQueue.enqueue('RETURN', pkgId, data);
          setReturnPackages(prev => prev.filter(p => p.id !== pkgId));
          setReturningPackage(null);
          return;
        }
        console.error("Failed to confirm return", error);
        throw error;
    }
  };

  return (
    <div>
      <div className="flex justify-between items-center mb-4 px-4">
        <h1 className="text-xl font-bold text-[var(--text-primary)]">
          Mis Devoluciones
        </h1>
        <span className="bg-amber-100 text-amber-800 text-xs font-bold px-3 py-1.5 rounded-full whitespace-nowrap">
            Pendientes: {returnPackages.length}
        </span>
      </div>

      {offlinePendingCount > 0 && (
        <div className="mb-6 mx-4 p-4 bg-amber-50 border-2 border-amber-200 rounded-xl shadow-sm">
          <div className="flex items-start">
            <div className="p-2 bg-amber-100 rounded-lg text-amber-600 mr-4">
              <IconAlertTriangle className="w-6 h-6" />
            </div>
            <div className="flex-1">
              <h3 className="text-lg font-bold text-amber-900">Sin conexión — Guardado local</h3>
              <p className="text-amber-800 text-sm mt-1">
                Tienes <strong>{offlinePendingCount}</strong> {offlinePendingCount === 1 ? 'registro pendiente' : 'registros pendientes'} de sincronizar. Se enviarán automáticamente en cuanto recuperes conexión a internet — no necesitas hacer nada.
              </p>
            </div>
          </div>
        </div>
      )}

      <div className="bg-[var(--background-secondary)] shadow-md rounded-lg">
        <PackageList
            packages={returnPackages}
            users={users}
            isLoading={isLoading}
            onSelectPackage={handleSelectPackageDetails}
            hideDriverName={true}
        />
      </div>

      {selectedPackage && (
        <PackageDetailModal 
            isFullScreen={true}
            pkg={selectedPackage} 
            onClose={() => setSelectedPackage(null)}
            creatorForReturn={users.find(u => u.id === selectedPackage.creatorId)}
            onStartReturn={(pkg) => {
                setSelectedPackage(null);
                handleStartReturn(pkg);
            }}
        />
      )}

      {returningPackage && (
        <ReturnConfirmationModal
          pkg={returningPackage}
          onClose={() => setReturningPackage(null)}
          onConfirm={handleConfirmReturn}
        />
      )}
    </div>
  );
};

export default ReturnsDashboard;