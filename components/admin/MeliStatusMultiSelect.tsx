import React from 'react';
import { MELI_STATUS_OPTIONS, MELI_PENDING_PRESET, meliFilterSummary, MeliStatusKey } from '../../utils/meliStatus';

interface MeliStatusMultiSelectProps {
  value: MeliStatusKey[];
  onChange: (value: MeliStatusKey[]) => void;
  buttonClassName?: string;
}

/**
 * Selector de VARIOS estados de Mercado Libre a la vez (casillas), para ver juntos, por ejemplo, "listo para enviar" y "en camino". Sin ninguno marcado se muestran
 * todos. "Solo pendientes" marca lo que ML aún no da por entregado ni cancelado (listo para enviar + en camino). La selección sale siempre en el mismo orden.
 */
const MeliStatusMultiSelect: React.FC<MeliStatusMultiSelectProps> = ({ value, onChange, buttonClassName = '' }) => {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const toggle = (key: MeliStatusKey) => {
    const next = value.includes(key) ? value.filter(k => k !== key) : [...value, key];
    onChange(MELI_STATUS_OPTIONS.map(o => o.value).filter(k => next.includes(k)));
  };

  return (
    <div className="relative" ref={ref} data-testid="meli-status-multiselect">
      <button
        type="button"
        id="meli-status-filter"
        aria-haspopup="true"
        aria-expanded={open}
        aria-labelledby="meli-status-filter-label meli-status-filter"
        onClick={() => setOpen(o => !o)}
        className={`${buttonClassName} flex items-center justify-between gap-2 text-left cursor-pointer`}
        title={value.length > 1 ? value.map(k => MELI_STATUS_OPTIONS.find(o => o.value === k)?.label || k).join(' · ') : undefined}
      >
        <span className="truncate">{meliFilterSummary(value)}</span>
        <span className="text-gray-400 text-[10px] flex-shrink-0" aria-hidden="true">▼</span>
      </button>

      {open && (
        <div role="group" aria-label="Estados en Mercado Libre" className="absolute z-50 mt-1 w-64 bg-white border border-gray-200 rounded-md shadow-2xl">
          <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-gray-100 bg-gray-50 rounded-t-md">
            <button type="button" onClick={() => onChange([...MELI_PENDING_PRESET])} className="text-[10px] font-black uppercase tracking-wider text-blue-700 hover:underline">
              Solo pendientes
            </button>
            <button type="button" onClick={() => onChange([])} disabled={value.length === 0} className="text-[10px] font-black uppercase tracking-wider text-gray-500 hover:underline disabled:opacity-40 disabled:no-underline disabled:cursor-default">
              Limpiar
            </button>
          </div>
          <ul className="py-1">
            {MELI_STATUS_OPTIONS.map(o => {
              const checked = value.includes(o.value);
              return (
                <li key={o.value}>
                  <label className={`flex items-center gap-3 px-3 py-2 cursor-pointer transition-colors ${checked ? 'bg-blue-50' : 'hover:bg-gray-50'}`}>
                    <input type="checkbox" checked={checked} onChange={() => toggle(o.value)} className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
                    <span className="font-bold text-[11px] uppercase tracking-wider text-gray-800">{o.label}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
};

export default MeliStatusMultiSelect;
