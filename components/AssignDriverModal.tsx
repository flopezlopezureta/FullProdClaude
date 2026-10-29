import React, { useMemo, useState } from 'react';
import type { Package, User } from '../types';
import { PackageStatus } from '../constants';
import { IconX, IconCalendar } from './Icon';
import SearchableSelect from './SearchableSelect';

interface AssignDriverModalProps {
  pkg: Package;
  drivers: User[];
  onClose: () => void;
  onAssign: (pkgId: string, driverId: string | null, newDeliveryDate: Date) => void;
}

const formatDateForInput = (date: Date): string => {
    const d = new Date(date);
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().split('T')[0];
};

const AssignDriverModal: React.FC<AssignDriverModalProps> = ({ pkg, drivers, onClose, onAssign }) => {
  // Un paquete CANCELADO no se asigna ni se reasigna a un conductor de reparto ni se deja disponible: solo puede volver a la bodega (conductor "Bodega").
  const isCancelled = pkg.status === PackageStatus.Cancelled;
  const warehouseDrivers = useMemo(() => drivers.filter(d => /bodega/i.test(d.name)), [drivers]);
  // Con el selector vacío, un cancelado no debe leerse como "dejar sin asignar" (eso está prohibido): el texto vacío dice qué falta.
  const emptyLabel = isCancelled ? 'Sin conductor «Bodega»' : '-- Sin Asignar --';
  const [selectedDriverId, setSelectedDriverId] = useState<string>(isCancelled ? (warehouseDrivers[0]?.id || '') : (pkg.driverId || ''));
  const [deliveryDate, setDeliveryDate] = useState<string>(formatDateForInput(pkg.estimatedDelivery));

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const [year, month, day] = deliveryDate.split('-').map(Number);
    const localDate = new Date(year, month - 1, day);
    onAssign(pkg.id, selectedDriverId || null, localDate);
  };

  const today = formatDateForInput(new Date());

  return (
    <div
      className="fixed inset-0 bg-black bg-opacity-60 z-50 flex justify-center items-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-[var(--background-secondary)] rounded-xl shadow-2xl w-full max-w-md animate-fade-in-up"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between p-4 border-b border-[var(--border-primary)]">
          <h3 className="text-lg font-bold text-[var(--text-primary)]">{isCancelled ? 'Devolver paquete cancelado a Bodega' : 'Asignar/Reasignar Paquete'}</h3>
          <button
            onClick={onClose}
            className="p-2 rounded-full text-[var(--text-muted)] hover:bg-[var(--background-hover)] hover:text-[var(--text-primary)] transition-colors"
            aria-label="Cerrar modal"
          >
            <IconX className="w-6 h-6" />
          </button>
        </header>

        <form onSubmit={handleSubmit}>
          <div className="p-6 space-y-4">
            {isCancelled && (
              <p role="note" className="text-xs font-semibold text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                Este paquete está CANCELADO: no se puede asignar ni reasignar a un conductor de reparto. Solo puede volver a la bodega, que es el conductor «Bodega».
                {warehouseDrivers.length === 0 && ' No hay un conductor «Bodega» en el sistema.'}
              </p>
            )}
            <div>
              <label htmlFor="driver-select" className="block text-sm font-medium text-[var(--text-secondary)] mb-2">
                Conductor
              </label>
              <SearchableSelect
                items={isCancelled ? warehouseDrivers : drivers}
                selectedId={selectedDriverId || 'none'}
                onSelect={(id) => setSelectedDriverId(id === 'none' ? '' : id)}
                placeholder={emptyLabel}
                searchPlaceholder="Buscar conductor..."
                noneLabel={emptyLabel}
                showNoneOption={!isCancelled}
              />
            </div>
            {!isCancelled && (
            <div>
              <label htmlFor="delivery-date" className="block text-sm font-medium text-[var(--text-secondary)] mb-2">
                Nueva Fecha de Entrega
              </label>
              <div className="relative">
                 <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                     <IconCalendar className="h-5 w-5 text-[var(--text-muted)]" />
                 </div>
                 <input
                    type="date"
                    id="delivery-date"
                    value={deliveryDate}
                    onChange={(e) => setDeliveryDate(e.target.value)}
                    min={today}
                    required
                    className="mt-1 block w-full pl-10 pr-3 py-2 text-base border-[var(--border-secondary)] focus:outline-none focus:ring-2 focus:ring-[var(--brand-secondary)] sm:text-sm rounded-md bg-[var(--background-secondary)] text-[var(--text-primary)]"
                />
              </div>
            </div>
            )}
          </div>

          <footer className="px-6 py-4 bg-[var(--background-muted)] rounded-b-xl flex justify-end space-x-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-[var(--text-secondary)] bg-[var(--background-secondary)] border border-[var(--border-secondary)] rounded-md hover:bg-[var(--background-hover)] focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[var(--brand-secondary)]"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={isCancelled && !selectedDriverId}
              className="px-4 py-2 text-sm font-medium text-white bg-[var(--brand-primary)] border border-transparent rounded-md shadow-sm hover:bg-[var(--brand-secondary)] focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[var(--brand-secondary)] disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isCancelled ? 'Devolver a Bodega' : 'Guardar Cambios'}
            </button>
          </footer>
        </form>
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
  );
};

export default AssignDriverModal;