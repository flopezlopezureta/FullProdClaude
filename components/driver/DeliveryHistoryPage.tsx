

import React, { useState, useEffect, useContext, useMemo, ReactNode } from 'react';
import type { Package, User } from '../../types';
import { PackageStatus } from '../../constants';
import { api } from '../../services/api';
import { AuthContext } from '../../contexts/AuthContext';
import PackageList from '../PackageList';
import PackageDetailModal from '../PackageDetailModal';
import { IconCalendar, IconCheckCircle, IconArchive, IconArrowUturnLeft, IconWhatsapp, IconCube, IconRefresh } from '../Icon';

declare const html2pdf: any;

const getISODate = (date: Date) => date.toISOString().split('T')[0];

type HistoryView = 'delivered' | 'picked-up' | 'returned';

interface ReportData {
    delivered: Package[];
    pickedUp: Package[];
    returned: Package[];
    uniquePickupClients: number;
}

const ReportContent: React.FC<{
    reportData: ReportData;
    driver: User;
    users: User[];
    startDate: string;
    endDate: string;
    companyName: string;
}> = ({ reportData, driver, users, startDate, endDate, companyName }) => {
    const formattedStartDate = new Date(startDate.replace(/-/g, '/')).toLocaleDateString('es-CL');
    const formattedEndDate = new Date(endDate.replace(/-/g, '/')).toLocaleDateString('es-CL');
    
    // Prefiere pkg.clientName (ya calculado por el backend, p.ej. "Falabella Directo" para ese
    // origen) sobre buscar a mano por creatorId - un paquete escaneado y creado por el mismo
    // conductor (creatorId === driverId) mostraba al conductor como si fuera el cliente.
    const findClientName = (pkg: Package) => (pkg as any).clientName || users.find(u => u.id === pkg.creatorId)?.name || 'Cliente Particular';
    
    const findEventTimestamp = (pkg: Package, status: PackageStatus) => {
        const event = pkg.history.find(e => e.status === status);
        return event ? new Date(event.timestamp) : null;
    };

    return (
        <div className="p-10 font-sans text-slate-800 bg-white" style={{ width: '210mm', minHeight: '297mm', position: 'relative' }}>
            {/* Professional Header */}
            <header className="flex justify-between items-center pb-6 border-b-4 border-slate-900">
                <div className="flex items-center gap-4">
                    <div className="w-16 h-16 bg-slate-900 rounded-lg flex items-center justify-center">
                        <IconCube className="w-10 h-10 text-white" />
                    </div>
                    <div>
                        <h1 className="text-3xl font-black tracking-tight text-slate-900 uppercase">{companyName}</h1>
                        <div className="flex items-center gap-2 text-slate-500 font-medium">
                            <IconArchive className="w-4 h-4" />
                            <span>Reporte de Operaciones Logísticas</span>
                        </div>
                    </div>
                </div>
                <div className="text-right">
                    <p className="text-xs uppercase tracking-widest text-slate-400 font-bold mb-1">Documento Oficial</p>
                    <div className="bg-slate-100 px-4 py-2 rounded-md">
                        <p className="text-sm font-bold text-slate-800">{formattedStartDate} — {formattedEndDate}</p>
                    </div>
                </div>
            </header>

            {/* Information Grid */}
            <div className="grid grid-cols-2 gap-8 my-8">
                <div className="space-y-1">
                    <p className="text-xs uppercase text-slate-400 font-bold">Información del Conductor</p>
                    <p className="text-lg font-bold text-slate-900">{driver.name}</p>
                    <p className="text-sm text-slate-500">{driver.email}</p>
                </div>
                <div className="space-y-1 text-right">
                    <p className="text-xs uppercase text-slate-400 font-bold">Fecha de Emisión</p>
                    <p className="text-sm font-medium">{new Date().toLocaleString('es-CL')}</p>
                </div>
            </div>

            {/* Premium Summary Cards */}
            <section className="grid grid-cols-4 gap-4 my-8">
                {[
                    { label: 'Entregados', value: reportData.delivered.length, color: 'bg-green-50 text-green-700 border-green-200' },
                    { label: 'Retiros', value: reportData.pickedUp.length, color: 'bg-blue-50 text-blue-700 border-blue-200' },
                    { label: 'Clientes', value: reportData.uniquePickupClients, color: 'bg-indigo-50 text-indigo-700 border-indigo-200' },
                    { label: 'Devueltos', value: reportData.returned.length, color: 'bg-amber-50 text-amber-700 border-amber-200' }
                ].map((card, i) => (
                    <div key={i} className={`p-4 rounded-xl border-2 ${card.color} text-center`}>
                        <p className="text-[10px] uppercase font-black tracking-wider mb-1 opacity-70">{card.label}</p>
                        <p className="text-3xl font-black">{card.value}</p>
                    </div>
                ))}
            </section>

            {/* Main Tables */}
            <div className="space-y-10">
                {/* Delivered Section */}
                <section>
                    <div className="flex items-center gap-2 mb-4 border-l-4 border-green-500 pl-3">
                        <h3 className="text-lg font-bold text-slate-900 uppercase tracking-tight">Detalle de Entregas</h3>
                    </div>
                    <table className="w-full text-xs border-collapse">
                        <thead>
                            <tr className="bg-slate-900 text-white">
                                <th className="p-3 text-left font-bold rounded-tl-lg">Tracking / Ref</th>
                                <th className="p-3 text-left font-bold">Destinatario</th>
                                <th className="p-3 text-left font-bold">Comuna</th>
                                <th className="p-3 text-right font-bold rounded-tr-lg">Fecha/Hora</th>
                            </tr>
                        </thead>
                        <tbody>
                            {reportData.delivered.length > 0 ? reportData.delivered.map((pkg, index) => (
                                <tr key={pkg.id} className={index % 2 === 0 ? 'bg-white' : 'bg-slate-50'}>
                                    <td className="p-3 border-b border-slate-100 font-mono text-[10px]">
                                        <div className="font-bold text-slate-900">{pkg.id}</div>
                                        <div className="text-slate-400">{pkg.reference || 'Sin Ref'}</div>
                                    </td>
                                    <td className="p-3 border-b border-slate-100 font-medium">{pkg.recipientName}</td>
                                    <td className="p-3 border-b border-slate-100 uppercase">{pkg.recipientCommune}</td>
                                    <td className="p-3 border-b border-slate-100 text-right text-slate-500">
                                        {findEventTimestamp(pkg, PackageStatus.Delivered)?.toLocaleString('es-CL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) || 'N/A'}
                                    </td>
                                </tr>
                            )) : (
                                <tr><td colSpan={4} className="p-8 text-center text-slate-400 italic bg-slate-50 rounded-b-lg">No se registraron entregas en este período.</td></tr>
                            )}
                        </tbody>
                    </table>
                </section>

                {/* Pickups Section */}
                <section>
                    <div className="flex items-center gap-2 mb-4 border-l-4 border-blue-500 pl-3">
                        <h3 className="text-lg font-bold text-slate-900 uppercase tracking-tight">Detalle de Retiros</h3>
                    </div>
                    <table className="w-full text-xs border-collapse">
                        <thead>
                            <tr className="bg-slate-800 text-white">
                                <th className="p-3 text-left font-bold rounded-tl-lg">ID Paquete</th>
                                <th className="p-3 text-left font-bold">Cliente / Origen</th>
                                <th className="p-3 text-right font-bold rounded-tr-lg">Fecha/Hora</th>
                            </tr>
                        </thead>
                        <tbody>
                            {reportData.pickedUp.length > 0 ? reportData.pickedUp.map((pkg, index) => (
                                <tr key={pkg.id} className={index % 2 === 0 ? 'bg-white' : 'bg-slate-50'}>
                                    <td className="p-3 border-b border-slate-100 font-mono text-[10px] font-bold text-slate-900">{pkg.id}</td>
                                    <td className="p-3 border-b border-slate-100 font-medium">{findClientName(pkg)}</td>
                                    <td className="p-3 border-b border-slate-100 text-right text-slate-500">
                                        {findEventTimestamp(pkg, PackageStatus.PickedUp)?.toLocaleString('es-CL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) || 'N/A'}
                                    </td>
                                </tr>
                            )) : (
                                <tr><td colSpan={3} className="p-8 text-center text-slate-400 italic bg-slate-50 rounded-b-lg">No se registraron retiros en este período.</td></tr>
                            )}
                        </tbody>
                    </table>
                </section>
            </div>

            {/* Signature Section */}
            <div className="mt-20 grid grid-cols-2 gap-20">
                <div className="text-center">
                    <div className="border-t-2 border-slate-300 pt-3">
                        <p className="text-sm font-bold text-slate-900">{driver.name}</p>
                        <p className="text-[10px] uppercase text-slate-400 font-bold tracking-widest">Firma del Conductor</p>
                    </div>
                </div>
                <div className="text-center">
                    <div className="border-t-2 border-slate-300 pt-3">
                        <p className="text-sm font-bold text-slate-900">Operaciones {companyName}</p>
                        <p className="text-[10px] uppercase text-slate-400 font-bold tracking-widest">Firma Responsable</p>
                    </div>
                </div>
            </div>

            {/* Professional Footer */}
            <footer className="absolute bottom-10 left-10 right-10 text-[9px] text-slate-400 flex justify-between border-t border-slate-100 pt-4">
                <p>Este documento es una representación digital de la actividad logística de {companyName}.</p>
                <p>Página 1 de 1</p>
            </footer>
        </div>
    );
};


const TabButton: React.FC<{ label: string; count: string | number; active: boolean; onClick: () => void; icon: ReactNode }> = ({ label, count, active, onClick, icon }) => {
    const baseClasses = "flex flex-col items-center justify-center flex-1 text-center p-3 rounded-lg transition-colors duration-200";
    const activeClasses = "bg-[var(--brand-muted)] text-[var(--brand-text)] shadow-inner";
    const inactiveClasses = "bg-[var(--background-muted)] hover:bg-[var(--background-hover)]";
    const countIsString = typeof count === 'string';

    return (
        <button onClick={onClick} className={`${baseClasses} ${active ? activeClasses : inactiveClasses}`}>
            <div className="flex items-center gap-2">
                {icon}
                <span className={`block font-bold ${countIsString ? 'text-xl' : 'text-2xl'}`}>{count}</span>
            </div>
            <span className="block text-xs font-semibold mt-1">{label}</span>
        </button>
    );
};

const DeliveryHistoryPage: React.FC = () => {
  const [allDriverPackages, setAllDriverPackages] = useState<Package[]>([]);
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
  const [isLoading, setIsLoading] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [historyView, setHistoryView] = useState<HistoryView>('delivered');
  const auth = useContext(AuthContext);

  const today = new Date();
  const oneWeekAgo = new Date(today);
  oneWeekAgo.setDate(today.getDate() - 7);

  const [startDate, setStartDate] = useState(getISODate(oneWeekAgo));
  const [endDate, setEndDate] = useState(getISODate(today));

  // Load from cache on mount
  useEffect(() => {
    if (!auth?.user) return;
    const cachedHistory = localStorage.getItem(`driver_history_${auth.user.id}`);
    const cachedUsers = localStorage.getItem(`driver_users`);
    
    if (cachedHistory) {
      try {
        const parsed = JSON.parse(cachedHistory);
        setAllDriverPackages(parsed);
        setIsLoading(false);
      } catch (e) {
        console.error("Error parsing cached history", e);
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

  const fetchData = async (silent = false, currentStart = startDate, currentEnd = endDate) => {
    if (!auth?.user) return;
    if (!silent) setIsLoading(true);
    try {
      // Pasamos explícitamente startDate y endDate para que el backend aplique el filtro y nos ahorre memoria
      const packagesPromise = api.getPackages({ 
          driverFilter: auth.user.id, 
          limit: 0,
          startDate: currentStart,
          endDate: currentEnd
      });
      const usersPromise = api.getUsers().catch(err => {
        console.warn("[Auth] Could not fetch users list, using cache if available.", err);
        const cachedUsers = localStorage.getItem(`driver_users`);
        return cachedUsers ? JSON.parse(cachedUsers) : [];
      });

      const [{ packages: pkgs }, allUsers] = await Promise.all([
          packagesPromise,
          usersPromise
      ]);

      const driverPackages = pkgs
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
      
      setAllDriverPackages(driverPackages);
      setUsers(allUsers);
      
      localStorage.setItem(`driver_history_${auth.user.id}`, JSON.stringify(driverPackages));
      if (allUsers.length > 0) {
        localStorage.setItem(`driver_users`, JSON.stringify(allUsers));
      }
    } catch (error) {
      console.error("Failed to fetch history data", error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchData(true, startDate, endDate);
  }, [auth?.user, startDate, endDate]);

  const { deliveredInRange, pickedUpInRange, returnedInRange, uniquePickupClientsCount } = useMemo(() => {
    const start = new Date(startDate.replace(/-/g, '/'));
    start.setHours(0, 0, 0, 0);
    const end = new Date(endDate.replace(/-/g, '/'));
    end.setHours(23, 59, 59, 999);

    const delivered: Package[] = [];
    const pickedUp: Package[] = [];
    const returned: Package[] = [];
    const pickupClients = new Set<string>();

    allDriverPackages.forEach(pkg => {
        // Encontrar el evento relevante, al igual que en DriverPerformanceReportPage
        const relevantEvent = pkg.history?.find(e => 
            e.status === PackageStatus.Delivered || 
            e.status === PackageStatus.Problem || 
            e.status === PackageStatus.Returned ||
            e.status === PackageStatus.PickedUp
        ) || pkg.history?.[0];

        const eventDate = relevantEvent ? new Date(relevantEvent.timestamp) : new Date(pkg.updatedAt);

        if (eventDate >= start && eventDate <= end) {
            if (pkg.status === PackageStatus.Delivered) {
                delivered.push(pkg);
            } else if (pkg.status === PackageStatus.Returned) {
                returned.push(pkg);
            } else if (pkg.status === PackageStatus.PickedUp || pkg.status === PackageStatus.InTransit) {
                // Incluir InTransit como fallback para retiros
                pickedUp.push(pkg);
                if (pkg.creatorId) {
                    pickupClients.add(pkg.creatorId);
                }
            }
        }
    });

    return { deliveredInRange: delivered, pickedUpInRange: pickedUp, returnedInRange: returned, uniquePickupClientsCount: pickupClients.size };
  }, [allDriverPackages, startDate, endDate]);

  const packagesToShow = useMemo(() => {
    switch (historyView) {
        case 'picked-up': return pickedUpInRange;
        case 'returned': return returnedInRange;
        case 'delivered':
        default:
            return deliveredInRange;
    }
  }, [historyView, deliveredInRange, pickedUpInRange, returnedInRange]);
  
  const handleShareReport = async () => {
    setIsGenerating(true);
    const reportElement = document.getElementById('report-content-for-pdf');
    if (!reportElement) {
        console.error("Report element not found");
        setIsGenerating(false);
        return;
    }
    
    const driverName = auth?.user?.name.replace(/\s+/g, '_') || 'conductor';
    const dateRange = `${startDate}_to_${endDate}`;
    const fileName = `Reporte_${driverName}_${dateRange}.pdf`;

    const opt = {
        margin: 0.5,
        filename: fileName,
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: { scale: 2, useCORS: true, logging: false },
        jsPDF: { unit: 'in', format: 'letter', orientation: 'portrait' }
    };

    try {
        const pdfBlob = await html2pdf().from(reportElement).set(opt).output('blob');
        const pdfFile = new File([pdfBlob], fileName, { type: 'application/pdf' });

        if (navigator.share && navigator.canShare({ files: [pdfFile] })) {
            await navigator.share({
                title: 'Reporte de Actividad',
                text: `Reporte de actividad para ${auth?.user?.name} (${startDate} al ${endDate}).`,
                files: [pdfFile],
            });
        } else {
            const link = document.createElement('a');
            link.href = URL.createObjectURL(pdfBlob);
            link.download = fileName;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(link.href);
        }
    } catch (error) {
        console.error("Error generating or sharing PDF:", error);
        alert("Ocurrió un error al generar o compartir el PDF.");
    } finally {
        setIsGenerating(false);
    }
  };

  const hasDataToReport = deliveredInRange.length > 0 || pickedUpInRange.length > 0 || returnedInRange.length > 0;

  return (
    <div>
      <div className="print:hidden">
        <div className="bg-[var(--background-secondary)] p-4 rounded-lg shadow-md mb-6">
          <div className="flex justify-between items-center mb-3">
              <h3 className="text-lg font-semibold text-[var(--text-primary)]">Historial de Actividad</h3>
              <button 
                onClick={() => fetchData()} 
                disabled={isLoading}
                className="p-2 bg-[var(--background-secondary)] border border-[var(--border-secondary)] rounded-full shadow-sm active:bg-[var(--background-hover)] transition-colors disabled:opacity-50"
                title="Actualizar datos"
              >
                <IconRefresh className={`w-5 h-5 text-[var(--brand-primary)] ${isLoading ? 'animate-spin' : ''}`}/>
              </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 items-end gap-2 sm:gap-4 mb-4">
            <div>
              <label htmlFor="start-date" className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Desde</label>
              <div className="relative">
                <div className="flex items-center justify-between w-full px-3 py-2 border border-[var(--border-secondary)] rounded-md shadow-sm bg-[var(--background-secondary)] text-left cursor-pointer sm:text-sm">
                  <span className={startDate ? "text-[var(--text-primary)]" : "text-[var(--text-muted)]"}>
                    {startDate ? new Date(startDate.replace(/-/g, '/')).toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' }) : 'dd/mm/aaaa'}
                  </span>
                  <IconCalendar className="h-5 w-5 text-[var(--text-muted)]" />
                </div>
                <input type="date" id="start-date" value={startDate} onChange={e => setStartDate(e.target.value)} className="absolute top-0 left-0 w-full h-full opacity-0 cursor-pointer" aria-label="Seleccionar fecha de inicio" />
              </div>
            </div>
            <div>
              <label htmlFor="end-date" className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Hasta</label>
              <div className="relative">
                <div className="flex items-center justify-between w-full px-3 py-2 border border-[var(--border-secondary)] rounded-md shadow-sm bg-[var(--background-secondary)] text-left cursor-pointer sm:text-sm">
                  <span className={endDate ? "text-[var(--text-primary)]" : "text-[var(--text-muted)]"}>
                    {endDate ? new Date(endDate.replace(/-/g, '/')).toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' }) : 'dd/mm/aaaa'}
                  </span>
                  <IconCalendar className="h-5 w-5 text-[var(--text-muted)]" />
                </div>
                <input type="date" id="end-date" max={getISODate(new Date())} onChange={e => setEndDate(e.target.value)} className="absolute top-0 left-0 w-full h-full opacity-0 cursor-pointer" aria-label="Seleccionar fecha de fin" />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-transparent mb-1">Acciones</label>
              <div className="flex flex-col items-stretch gap-2">
                <button onClick={handleShareReport} disabled={isGenerating || !hasDataToReport} className="w-full inline-flex items-center justify-center px-3 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-green-600 hover:bg-green-700 disabled:bg-slate-400 disabled:cursor-not-allowed">
                  <IconWhatsapp className="w-5 h-5 mr-2 -ml-1"/>
                  {isGenerating ? 'Generando...' : 'Compartir Informe'}
                </button>
                <p className="text-xs text-center text-[var(--text-muted)] mt-1">En PC se descargará el archivo PDF.</p>
              </div>
            </div>
          </div>
          <div className="border-t border-[var(--border-primary)] mt-4 pt-4">
            <div className="flex space-x-2">
              <TabButton label="Entregados" count={deliveredInRange.length} active={historyView === 'delivered'} onClick={() => setHistoryView('delivered')} icon={<IconCheckCircle className="w-5 h-5"/>} />
              <TabButton label="Retiros (Clientes / Paquetes)" count={`${uniquePickupClientsCount} / ${pickedUpInRange.length}`} active={historyView === 'picked-up'} onClick={() => setHistoryView('picked-up')} icon={<IconArchive className="w-5 h-5"/>} />
              <TabButton label="Devueltos" count={returnedInRange.length} active={historyView === 'returned'} onClick={() => setHistoryView('returned')} icon={<IconArrowUturnLeft className="w-5 h-5"/>} />
            </div>
          </div>
        </div>
        <div className="bg-[var(--background-secondary)] shadow-md rounded-lg overflow-hidden">
          <PackageList packages={packagesToShow} users={users} isLoading={isLoading} onSelectPackage={handleSelectPackageDetails} isDateFiltering={true} />
        </div>
        {selectedPackage && (
          <PackageDetailModal 
            isFullScreen={true} 
            pkg={selectedPackage} 
            onClose={() => setSelectedPackage(null)} 
            creator={users.find(u => u.id === selectedPackage.creatorId)}
          />
        )}
      </div>
      
      {/* Hidden container for PDF generation */}
      <div className="hidden print:block print-container">
        <div id="report-content-for-pdf" className="relative">
          {auth?.user && (
            <ReportContent 
              reportData={{
                delivered: deliveredInRange,
                pickedUp: pickedUpInRange,
                returned: returnedInRange,
                uniquePickupClients: uniquePickupClientsCount,
              }}
              driver={auth.user}
              users={users}
              startDate={startDate}
              endDate={endDate}
              companyName={auth.systemSettings.companyName}
            />
          )}
        </div>
      </div>
    </div>
  );
};

export default DeliveryHistoryPage;