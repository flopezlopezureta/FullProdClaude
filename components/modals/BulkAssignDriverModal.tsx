
import React, { useState } from 'react';
import { User } from '../../types';
import { IconX, IconCalendar, IconUserPlus } from '../Icon';
import SearchableSelect from '../SearchableSelect';

interface BulkAssignDriverModalProps {
  packageCount: number;
  cancelledCount?: number;   // cuántos de los seleccionados están CANCELADOS (solo pueden volver al conductor "Bodega")
  drivers: User[];
  onClose: () => void;
  onAssign: (driverId: string | null, newDeliveryDate: Date) => void;
}

const formatDateForInput = (date: Date): string => {
    const d = new Date(date);
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().split('T')[0];
};

const BulkAssignDriverModal: React.FC<BulkAssignDriverModalProps> = ({ packageCount, cancelledCount = 0, drivers, onClose, onAssign }) => {
  const [selectedDriverId, setSelectedDriverId] = useState<string>('');
  const [deliveryDate, setDeliveryDate] = useState<string>(formatDateForInput(new Date()));

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedDriverId) return;
    const [year, month, day] = deliveryDate.split('-').map(Number);
    const localDate = new Date(year, month - 1, day);
    onAssign(selectedDriverId === 'none' ? null : selectedDriverId, localDate);
  };

  const today = formatDateForInput(new Date());

  return (
    <div className="fixed inset-0 bg-black bg-opacity-60 z-50 flex justify-center items-center p-4" onClick={onClose}>
      <div className="bg-[var(--background-secondary)] rounded-xl shadow-2xl w-full max-w-md animate-fade-in-up" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center justify-between p-4 border-b border-[var(--border-primary)]">
          <h3 className="text-lg font-bold text-[var(--text-primary)]">Asignación Masiva</h3>
          <button onClick={onClose} className="p-2 rounded-full text-[var(--text-muted)] hover:bg-[var(--background-hover)]" aria-label="Cerrar modal">
            <IconX className="w-6 h-6" />
          </button>
        </header>
        <form onSubmit={handleSubmit}>
          <div className="p-6 space-y-4">
            <p className="text-center font-semibold text-[var(--text-secondary)]">
              Vas a asignar <span className="text-[var(--brand-primary)] text-lg">{packageCount}</span> paquete(s) a un conductor.
            </p>
            {cancelledCount > 0 && (
              <p role="note" className="text-xs font-semibold text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                {cancelledCount === 1
                  ? '1 de los paquetes seleccionados está CANCELADO: solo puede volver al conductor «Bodega». Con cualquier otra opción se omitirá y el resto se asigna normalmente.'
                  : `${cancelledCount} de los paquetes seleccionados están CANCELADOS: solo pueden volver al conductor «Bodega». Con cualquier otra opción se omitirán y el resto se asigna normalmente.`}
              </p>
            )}
            <div>
              <label htmlFor="bulk-driver-select" className="block text-sm font-medium text-[var(--text-secondary)] mb-2">Conductor</label>
              <SearchableSelect
                items={drivers}
                selectedId={selectedDriverId || 'none'}
                onSelect={(id) => setSelectedDriverId(id)}
                placeholder="-- Seleccionar Conductor --"
                searchPlaceholder="Buscar conductor..."
                noneLabel="-- Sin Asignar (Disponible) --"
              />
            </div>
            <div>
              <label htmlFor="bulk-delivery-date" className="block text-sm font-medium text-[var(--text-secondary)] mb-2">Fecha de Entrega</label>
              <div className="relative">
                 <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none"><IconCalendar className="h-5 w-5 text-[var(--text-muted)]" /></div>
                 <input type="date" id="bulk-delivery-date" value={deliveryDate} onChange={(e) => setDeliveryDate(e.target.value)} min={today} required className="mt-1 block w-full pl-10 pr-3 py-2 text-base border-[var(--border-secondary)] focus:outline-none focus:ring-2 focus:ring-[var(--brand-secondary)] sm:text-sm rounded-md bg-[var(--background-secondary)] text-[var(--text-primary)]" />
              </div>
            </div>
          </div>
          <footer className="px-6 py-4 bg-[var(--background-muted)] rounded-b-xl flex justify-end">
            <button type="submit" className="flex items-center justify-center px-4 py-2 text-sm font-medium text-white bg-[var(--brand-primary)] border border-transparent rounded-md shadow-sm hover:bg-[var(--brand-secondary)]">
              <IconUserPlus className="w-5 h-5 mr-2" />
              Asignar Paquetes
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
};
export default BulkAssignDriverModal;
