
import React from 'react';
import { PackageStatus, ShippingType } from '../constants';
import type { Package, User } from '../types';
import PackageListItem from './PackageListItem';
import { IconPackage } from './Icon';

interface PackageListProps {
  packages: Package[];
  users: User[];
  isLoading: boolean;
  onSelectPackage: (pkg: Package) => void;
  onAssignPackage?: (pkg: Package) => void;
  onEditPackage?: (pkg: Package) => void;
  onDeletePackage?: (pkg: Package) => void;
  onPrintLabel?: (pkg: Package) => void;
  onMarkForReturn?: (pkg: Package) => void;
  isFiltering?: boolean;
  isDateFiltering?: boolean;
  hideDriverName?: boolean;
  selectedPackages?: Set<string>;
  onSelectionChange?: (pkg: Package) => void;
  onSelectAll?: () => void;
  disableSorting?: boolean;
  isSelectionDisabled?: (pkg: Package) => boolean;
}

const statusPriority: { [key in PackageStatus]: number } = {
  [PackageStatus.Problem]: 1,
  [PackageStatus.ReturnPending]: 2,
  [PackageStatus.Pending]: 3, // Moved up priority to ensure new packages are seen
  [PackageStatus.Assigned]: 3.5, // Between Pending and Delayed
  [PackageStatus.Delayed]: 4,
  [PackageStatus.PickedUp]: 5,
  [PackageStatus.InTransit]: 6,
  [PackageStatus.Delivered]: 7,
  [PackageStatus.Returned]: 8,
  [PackageStatus.Cancelled]: 9,
  [PackageStatus.Rescheduled]: 10,
};

const PackageList: React.FC<PackageListProps> = ({ packages, users, isLoading, onSelectPackage, onAssignPackage, onEditPackage, onDeletePackage, onPrintLabel, onMarkForReturn, isFiltering, isDateFiltering, hideDriverName, selectedPackages, onSelectionChange, onSelectAll, disableSorting, isSelectionDisabled }) => {
  const userMap = React.useMemo(() => {
    const map: Record<string, User> = {};
    users.forEach(u => {
      map[u.id] = u;
    });
    return map;
  }, [users]);

  if (isLoading) {
    return <p className="p-6 text-center text-[var(--text-muted)]">Cargando paquetes...</p>;
  }
  
  if (!Array.isArray(packages) || packages.length === 0) {
    let message = 'No hay paquetes para mostrar.';
    if (isDateFiltering) {
        message = 'No existen envíos en el rango de fechas seleccionado.';
    } else if (isFiltering) {
        message = 'No se encontraron paquetes que coincidan con los filtros.';
    }
    return (
        <div className="p-12 text-center">
            <IconPackage className="mx-auto h-12 w-12 text-[var(--text-muted)] opacity-50" />
            <h3 className="mt-2 text-sm font-medium text-[var(--text-primary)]">No se encontraron paquetes</h3>
            <p className="mt-1 text-sm text-[var(--text-muted)]">{message}</p>
        </div>
    );
  }

  const sortedPackages = disableSorting ? packages : [...packages].sort((a, b) => {
    // Urgent packages (SameDay/Express pending assignment) always float to top
    const isAUrgent = (a.shippingType === ShippingType.Express || a.shippingType === ShippingType.SameDay) && a.status === PackageStatus.Pending && !a.driverId;
    const isBUrgent = (b.shippingType === ShippingType.Express || b.shippingType === ShippingType.SameDay) && b.status === PackageStatus.Pending && !b.driverId;

    if (isAUrgent && !isBUrgent) return -1;
    if (!isAUrgent && isBUrgent) return 1;

    const priorityA = statusPriority[a.status];
    const priorityB = statusPriority[b.status];

    if (priorityA !== priorityB) {
      return priorityA - priorityB;
    }

    // Secondary sort by update time (newest first)
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });

  const allSelected = packages.length > 0 && selectedPackages?.size === packages.length;

  return (
    <div className="flex flex-col">
      {onSelectAll && (
          <div className="px-3 py-2 bg-[var(--background-muted)] border-b border-[var(--border-primary)] flex items-center sticky top-0 z-10">
              <div className="mr-3 flex items-center">
                  <input
                      type="checkbox"
                      className="h-4 w-4 border border-[var(--border-secondary)] rounded bg-[var(--background-secondary)] text-[var(--brand-primary)] focus:ring-[var(--brand-secondary)]"
                      checked={allSelected}
                      onChange={onSelectAll}
                  />
                  <span className="ml-2 text-xs font-bold text-[var(--text-muted)] uppercase tracking-wider">Seleccionar Todo</span>
              </div>
              <div className="flex-grow grid grid-cols-4 gap-4 text-[10px] font-bold text-[var(--text-muted)] uppercase tracking-wider hidden sm:grid pl-8">
                  <div className="col-span-2 pl-4">Destinatario / Dirección</div>
                  <div className="text-right pr-4">Estado</div>
                  <div className="text-right pr-8">Acciones</div>
              </div>
          </div>
      )}
      <div className="divide-y divide-[var(--border-primary)]">
      {sortedPackages.filter(p => p && p.id).map((pkg, index) => {
        const driver = userMap[pkg.driverId || ''];
        const creator = userMap[pkg.creatorId || ''];
        // El backend ya manda el nombre correcto en pkg.clientName (p.ej. "Falabella Directo"
        // para ese origen, en vez de quien escaneó/creó el registro - ver el CASE WHEN en
        // routes/packages.js). Buscar el creador a mano aqui, sin ese campo, mostraba al
        // conductor como si fuera el cliente en cualquier paquete que el mismo conductor
        // hubiera escaneado y creado (creatorId === driverId).
        const clientName = (pkg as any).clientName || creator?.name;
        return (
            <PackageListItem
                key={pkg.id}
                index={index}
                pkg={pkg}
                driverName={driver?.name}
                creatorName={clientName}
                onSelect={onSelectPackage}
                onAssign={onAssignPackage}
                onEdit={onEditPackage}
                onDelete={onDeletePackage}
                onPrint={onPrintLabel}
                onMarkForReturn={onMarkForReturn}
                hideDriverName={hideDriverName}
                isSelected={selectedPackages?.has(pkg.id)}
                onSelectionChange={onSelectionChange}
                isSelectionDisabled={isSelectionDisabled?.(pkg)}
            />
        );
      })}
      </div>
    </div>
  );
};

export default PackageList;
