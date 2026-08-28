

import React, { useState, useEffect, useMemo, useRef, useContext } from 'react';
import { api } from '../../services/api';
import { Role, PackageStatus, ShippingType } from '../../constants';
import type { User, Package, DeliveryZone } from '../../types';
import { IconPrinter, IconCube, IconCalendar, IconChecklist, IconPackage, IconDollarSign, IconFileSpreadsheet, IconAlertTriangle } from '../Icon';
import { AuthContext } from '../../contexts/AuthContext';

// Declare Chart.js in the global scope to avoid TypeScript errors
declare const Chart: any;

const getISODate = (date: Date) => date.toISOString().split('T')[0];

const KpiCard: React.FC<{ icon: React.ReactNode, title: string, value: string | number, subtext?: string, colorClass: string }> = ({ icon, title, value, subtext, colorClass }) => (
    <div className="bg-[var(--background-secondary)] rounded-lg p-4 shadow-sm border border-[var(--border-primary)] flex items-center">
        <div className={`flex-shrink-0 p-3 rounded-full ${colorClass}`}>
            {icon}
        </div>
        <div className="ml-4">
            <p className="text-sm font-medium text-[var(--text-muted)]">{title}</p>
            <p className="text-2xl font-bold text-[var(--text-primary)]">{value}</p>
            {subtext && <p className="text-xs text-[var(--text-muted)] opacity-70">{subtext}</p>}
        </div>
    </div>
);

const BillingReportPage: React.FC = () => {
    const auth = useContext(AuthContext);
    const [packages, setPackages] = useState<Package[]>([]);
    const [users, setUsers] = useState<User[]>([]);
    const [zones, setZones] = useState<DeliveryZone[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isExporting, setIsExporting] = useState(false);
    const [selectedClientId, setSelectedClientId] = useState<string>('');
    const [clientSearchQuery, setClientSearchQuery] = useState<string>('');
    
    const today = new Date();
    const firstDayOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);

    const [startDate, setStartDate] = useState(getISODate(firstDayOfMonth));
    const [endDate, setEndDate] = useState(getISODate(today));

    const statusChartRef = useRef<HTMLCanvasElement>(null);
    const volumeChartRef = useRef<HTMLCanvasElement>(null);
    const chartInstances = useRef<{ status?: any; volume?: any }>({});

    const finalizedPackageStatuses: PackageStatus[] = [PackageStatus.Delivered, PackageStatus.Problem, PackageStatus.Returned];

    const fetchData = async () => {
        setIsLoading(true);
        try {
            const [allUsers, deliveryZones] = await Promise.all([
                api.getUsers(),
                api.getDeliveryZones()
            ]);
            setUsers(allUsers);
            setZones(deliveryZones);
        } catch (error) {
            console.error("Failed to fetch billing data", error);
        } finally {
            setIsLoading(false);
        }
    };
    
    useEffect(() => {
        fetchData();
    }, []);

    useEffect(() => {
        const fetchClientPackages = async () => {
            if (!selectedClientId) {
                setPackages([]);
                return;
            }
            setIsLoading(true);
            try {
                const response = await api.getPackages({
                    limit: 0,
                    clientFilter: selectedClientId,
                    startDate: startDate,
                    endDate: endDate,
                    excludePhotos: 'true'
                });
                setPackages(response.packages);
            } catch (error) {
                console.error("Failed to fetch packages for client", error);
                setPackages([]);
            } finally {
                setIsLoading(false);
            }
        };
        fetchClientPackages();
    }, [selectedClientId, startDate, endDate]);

    const clients = useMemo(() => 
        users.filter(u => u.role === Role.Client).sort((a, b) => a.name.localeCompare(b.name)),
        [users]
    );

    const filteredClients = useMemo(() => 
        clients.filter(c => 
            c.name.toLowerCase().includes(clientSearchQuery.toLowerCase())
        ), 
        [clients, clientSearchQuery]
    );

    const selectedClient = clients.find(c => c.id === selectedClientId);
    
    const communeToZoneMap = useMemo(() => {
        const map = new Map<string, DeliveryZone>();
        zones.forEach(zone => {
            zone.communes.forEach(commune => {
                map.set(commune.toLowerCase().trim(), zone);
            });
        });
        return map;
    }, [zones]);

    const getPackageCost = (pkg: Package): number => {
        const clientPricing = selectedClient?.pricing;
        if (clientPricing) {
            switch (pkg.shippingType) {
                case ShippingType.SameDay: if (clientPricing.sameDay > 0) return clientPricing.sameDay; break;
                case ShippingType.Express: if (clientPricing.express > 0) return clientPricing.express; break;
                case ShippingType.NextDay: if (clientPricing.nextDay > 0) return clientPricing.nextDay; break;
            }
        }
    
        const zone = communeToZoneMap.get(pkg.recipientCommune.toLowerCase().trim());
        if (!zone) return 0;

        switch (pkg.shippingType) {
            case ShippingType.SameDay: return zone.pricing.sameDay;
            case ShippingType.Express: return zone.pricing.express;
            case ShippingType.NextDay: return zone.pricing.nextDay;
            default: return 0;
        }
    };
    
    const {
        packagesInPeriod,
        billablePackages,
        alreadyBilledPackages,
        deliveredInPeriodCount,
        deliveredNotClosedPackages
    } = useMemo(() => {
        if (!selectedClientId) {
            return { packagesInPeriod: [], billablePackages: [], alreadyBilledPackages: [], deliveredInPeriodCount: 0, deliveredNotClosedPackages: [] };
        }
        
        const pkgsInPeriod = packages.filter(pkg => {
            if (pkg.creatorId !== selectedClientId) return false;
            
            const creationEvent = pkg.history.find(e => e.status === 'Creado') || pkg.history[pkg.history.length - 1];
            if (!creationEvent) return false;
            
            const creationDate = new Date(creationEvent.timestamp);
            if (startDate) {
                const start = new Date(startDate.replace(/-/g, '/'));
                start.setHours(0, 0, 0, 0);
                if (creationDate < start) return false;
            }
            if (endDate) {
                const end = new Date(endDate.replace(/-/g, '/'));
                end.setHours(23, 59, 59, 999);
                if (creationDate > end) return false;
            }
            return true;
        });

        const delivered = pkgsInPeriod.filter(p => p.status === PackageStatus.Delivered);
        const billable = delivered.filter(p => !p.billed);
        const alreadyBilled = delivered.filter(p => p.billed);

        // Paquetes en tránsito, con conductor real asignado y con orden de Mercado Libre — el
        // conductor nunca los cerró en el sistema, así que hoy no cuentan para la factura, aunque
        // Mercado Libre pueda tenerlos como entregados. No es una confirmación en vivo contra ML
        // (sería lento consultarla al cargar el informe) — es la misma condición de candidato que
        // usa la herramienta de reconciliación (POST /api/packages/billing/reconcile-meli-delivered),
        // que sí verifica cada uno contra Mercado Libre antes de cerrarlo.
        const bodegaUserId = users.find(u => u.name?.toLowerCase().includes('bodega'))?.id;
        const notClosed = pkgsInPeriod.filter(p =>
            p.status === PackageStatus.InTransit &&
            !!p.driverId &&
            p.driverId !== bodegaUserId &&
            (!!p.meliOrderId || !!p.meliFlexCode)
        );

        return {
            packagesInPeriod: pkgsInPeriod,
            billablePackages: billable,
            alreadyBilledPackages: alreadyBilled,
            deliveredInPeriodCount: delivered.length,
            deliveredNotClosedPackages: notClosed
        };
    }, [packages, users, selectedClientId, startDate, endDate]);


    const pickupActionsCount = useMemo(() => {
        if (!selectedClientId) return 0;

        const pickupDates = new Set<string>();

        packages.forEach(pkg => {
            if (pkg.creatorId !== selectedClientId) return;

            const pickupEvent = pkg.history.find(e => e.status === PackageStatus.PickedUp);
            if (!pickupEvent) return;

            const pickupDate = new Date(pickupEvent.timestamp);
            const start = new Date(startDate.replace(/-/g, '/'));
            start.setHours(0, 0, 0, 0);
            const end = new Date(endDate.replace(/-/g, '/'));
            end.setHours(23, 59, 59, 999);

            if (pickupDate >= start && pickupDate <= end) {
                pickupDates.add(pickupDate.toISOString().split('T')[0]);
            }
        });
        return pickupDates.size;
    }, [packages, selectedClientId, startDate, endDate]);


    const { totalDeliveriesCost, totalPickupsCost, grandTotal } = useMemo(() => {
        const deliveriesCost = billablePackages.reduce((sum, pkg) => sum + getPackageCost(pkg), 0);
        const pickupCostPerAction = selectedClient?.pickupCost || 0;
        const pickupsCost = pickupActionsCount * pickupCostPerAction;
        return {
            totalDeliveriesCost: deliveriesCost,
            totalPickupsCost: pickupsCost,
            grandTotal: deliveriesCost + pickupsCost
        };
    }, [billablePackages, getPackageCost, pickupActionsCount, selectedClient]);

    const performanceStats = useMemo(() => {
        const finalizedPackages = packagesInPeriod.filter(p => 
            finalizedPackageStatuses.includes(p.status)
        );
        const deliveredCount = finalizedPackages.filter(p => p.status === PackageStatus.Delivered).length;
        const successRate = finalizedPackages.length > 0 ? ((deliveredCount / finalizedPackages.length) * 100) : 0;
        
        return {
            successRate: `${successRate.toFixed(0)}%`,
        };
    }, [packagesInPeriod]);


    useEffect(() => {
        const statusCtx = statusChartRef.current?.getContext('2d');
        const volumeCtx = volumeChartRef.current?.getContext('2d');

        if (chartInstances.current.status) chartInstances.current.status.destroy();
        if (chartInstances.current.volume) chartInstances.current.volume.destroy();
        
        if (!selectedClient) return;

        if (statusCtx && packagesInPeriod.length > 0) {
            const finalizedStatusesCounts = packagesInPeriod.reduce((acc, pkg) => {
                 if (finalizedPackageStatuses.includes(pkg.status)) {
                    const statusKey = (pkg.status || '').replace('_', ' ');
                    acc[statusKey] = (acc[statusKey] || 0) + 1;
                }
                return acc;
            }, {} as { [key: string]: number });
            
            chartInstances.current.status = new Chart(statusCtx, {
                type: 'pie',
                data: {
                    labels: Object.keys(finalizedStatusesCounts),
                    datasets: [{
                        data: Object.values(finalizedStatusesCounts),
                        backgroundColor: ['#22c55e', '#ef4444', '#64748b'],
                    }]
                },
                options: { responsive: true, plugins: { legend: { position: 'top' } } }
            });
        }

        if (volumeCtx && packagesInPeriod.length > 0) {
            const packagesByDay = packagesInPeriod.reduce((acc, pkg) => {
                const date = new Date(pkg.history[pkg.history.length - 1].timestamp).toISOString().split('T')[0];
                acc[date] = (acc[date] || 0) + 1;
                return acc;
            }, {} as { [key: string]: number });
            
            const sortedDates = Object.keys(packagesByDay).sort();
            chartInstances.current.volume = new Chart(volumeCtx, {
                type: 'bar',
                data: {
                    labels: sortedDates.map(date => new Date(date + 'T00:00:00').toLocaleDateString('es-CL', { day: '2-digit', month: 'short' })),
                    datasets: [{
                        label: 'Envíos Creados',
                        data: sortedDates.map(date => packagesByDay[date]),
                        backgroundColor: 'rgba(79, 70, 229, 0.5)',
                        borderColor: 'rgba(79, 70, 229, 1)',
                        borderWidth: 1
                    }]
                },
                options: { scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } } }
            });
        }

    }, [packagesInPeriod, selectedClient]);


    const handleExportCSV = async () => {
        if (!selectedClient || isExporting) return;
        
        setIsExporting(true);
        try {
            await new Promise(resolve => setTimeout(resolve, 100));

            const escapeCSV = (val: any) => {
                const str = String(val || '').replace(/"/g, '""');
                return `"${str}"`;
            };

            let csvContent = '\uFEFF'; // BOM for Excel

            // Section 1: Summary
            csvContent += escapeCSV("Estado de Cuenta - Informe de Facturación") + '\n';
            csvContent += escapeCSV("Cliente:") + ',' + escapeCSV(selectedClient.name) + '\n';
            csvContent += escapeCSV("Período:") + ',' + escapeCSV(`${new Date(startDate + 'T00:00:00').toLocaleDateString('es-CL')} a ${new Date(endDate + 'T00:00:00').toLocaleDateString('es-CL')}`) + '\n\n';

            csvContent += escapeCSV("Resumen General") + '\n';
            csvContent += escapeCSV("Concepto") + ',' + escapeCSV("Valor") + '\n';
            csvContent += escapeCSV("Total Envíos Entregados") + ',' + escapeCSV(deliveredInPeriodCount) + '\n';
            csvContent += escapeCSV("Tasa de Éxito") + ',' + escapeCSV(performanceStats.successRate) + '\n';
            csvContent += escapeCSV("Total Días con Retiros") + ',' + escapeCSV(pickupActionsCount) + '\n';
            csvContent += escapeCSV("TOTAL A FACTURAR") + ',' + escapeCSV(grandTotal) + '\n\n';

            // Section 2: Detailed List
            csvContent += escapeCSV("Detalle de Envíos") + '\n';
            csvContent += escapeCSV("ID Paquete") + ',' + escapeCSV("Destinatario") + ',' + escapeCSV("Tipo Envío") + ',' + escapeCSV("Fecha Entrega") + ',' + escapeCSV("Costo") + '\n';
            
            // Chunked processing for the package list
            const CHUNK_SIZE = 500;
            for (let i = 0; i < billablePackages.length; i += CHUNK_SIZE) {
                const chunk = billablePackages.slice(i, i + CHUNK_SIZE);
                chunk.forEach(pkg => {
                    csvContent += escapeCSV(pkg.id) + ',' + 
                                  escapeCSV(pkg.recipientName) + ',' + 
                                  escapeCSV(pkg.shippingType) + ',' + 
                                  escapeCSV(new Date(pkg.history.find(e => e.status === 'ENTREGADO')?.timestamp || pkg.updatedAt).toLocaleDateString('es-CL')) + ',' + 
                                  escapeCSV(getPackageCost(pkg)) + '\n';
                });
                await new Promise(resolve => setTimeout(resolve, 0));
            }

            const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
            const link = document.createElement("a");
            const url = URL.createObjectURL(blob);
            
            link.setAttribute("href", url);
            link.setAttribute("download", `Estado_Cuenta_${selectedClient.name.replace(/\s+/g, '_')}_${startDate}_${endDate}.csv`);
            link.style.visibility = 'hidden';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        } catch (error) {
            console.error("Export failed", error);
            alert("Error al exportar.");
        } finally {
            setIsExporting(false);
        }
    };

    const handleGenerateAndBill = async () => {
        if (!selectedClient) return;
        const packageIdsToBill = billablePackages.map(p => p.id);
        if (packageIdsToBill.length === 0 && pickupActionsCount === 0) return;
        
        try {
            await api.createInvoice(selectedClient.id, packageIdsToBill, totalDeliveriesCost, pickupActionsCount, totalPickupsCost);
            await api.markPackagesAsBilled(packageIdsToBill);
            window.print();
            fetchData();
        } catch (error) {
            console.error("Failed to generate and bill report", error);
            alert("Error al generar la factura. Inténtalo de nuevo.");
        }
    };
    
    const inputClasses = "w-full px-3 py-2 border border-[var(--border-secondary)] rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-secondary)] bg-[var(--background-secondary)] text-[var(--text-primary)]";

    return (
        <>
        <div className="space-y-6 print:hidden">
            <div className="bg-[var(--background-secondary)] shadow-md rounded-lg p-6">
                <h2 className="text-xl font-bold text-[var(--text-primary)] mb-4">Generar Informe de Facturación</h2>
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                    <div>
                        <label htmlFor="client-search" className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Buscar Cliente</label>
                        <input 
                            type="text" 
                            id="client-search"
                            value={clientSearchQuery}
                            onChange={e => setClientSearchQuery(e.target.value)}
                            placeholder="Escribe para filtrar..."
                            className={inputClasses}
                        />
                    </div>
                    <div>
                        <label htmlFor="client-select" className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Cliente</label>
                        <select id="client-select" value={selectedClientId} onChange={e => setSelectedClientId(e.target.value)} className={inputClasses}>
                            <option value="">-- Seleccionar Cliente --</option>
                            {filteredClients.map(client => <option key={client.id} value={client.id}>{client.name}</option>)}
                        </select>
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Desde</label>
                        <div className="relative"><div className="flex items-center justify-between w-full px-3 py-2 border border-[var(--border-secondary)] rounded-md shadow-sm bg-[var(--background-secondary)] text-left cursor-pointer sm:text-sm"><span className={startDate ? "text-[var(--text-primary)]" : "text-[var(--text-muted)]"}>{startDate ? new Date(startDate.replace(/-/g, '/')).toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' }) : 'dd/mm/aaaa'}</span><IconCalendar className="h-5 w-5 text-[var(--text-muted)]" /></div><input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className="absolute top-0 left-0 w-full h-full opacity-0 cursor-pointer" aria-label="Seleccionar fecha de inicio" /></div>
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Hasta</label>
                        <div className="relative"><div className="flex items-center justify-between w-full px-3 py-2 border border-[var(--border-secondary)] rounded-md shadow-sm bg-[var(--background-secondary)] text-left cursor-pointer sm:text-sm"><span className={endDate ? "text-[var(--text-primary)]" : "text-[var(--text-muted)]"}>{endDate ? new Date(endDate.replace(/-/g, '/')).toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' }) : 'dd/mm/aaaa'}</span><IconCalendar className="h-5 w-5 text-[var(--text-muted)]" /></div><input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} className="absolute top-0 left-0 w-full h-full opacity-0 cursor-pointer" aria-label="Seleccionar fecha de fin" /></div>
                    </div>
                </div>
            </div>

            {isLoading && <p className="text-center text-[var(--text-muted)] mt-6">Cargando datos...</p>}

            {selectedClientId && !isLoading && (
                <div className="space-y-6">
                     <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
                        <KpiCard
                            icon={<IconPackage className="w-6 h-6 text-blue-800"/>}
                            title="Envíos Entregados en Período"
                            value={deliveredInPeriodCount}
                            subtext={`${billablePackages.length} a facturar / ${alreadyBilledPackages.length} ya facturados`}
                            colorClass="bg-blue-100"
                        />
                        <KpiCard icon={<IconChecklist className="w-6 h-6 text-green-800"/>} title="Tasa de Éxito" value={performanceStats.successRate} subtext="Sobre envíos finalizados" colorClass="bg-green-100" />
                        <KpiCard icon={<IconCube className="w-6 h-6 text-purple-800"/>} title="Total Retiros" value={pickupActionsCount} subtext="Días con retiros" colorClass="bg-purple-100" />
                        <KpiCard
                            icon={<IconAlertTriangle className="w-6 h-6 text-amber-800"/>}
                            title="Entregados y No Cerrados"
                            value={deliveredNotClosedPackages.length}
                            subtext="Mercado Libre los tiene en tránsito sin cierre — se sumarán a la facturación una vez verificados"
                            colorClass="bg-amber-100"
                        />
                        <KpiCard icon={<IconDollarSign className="w-6 h-6 text-emerald-800"/>} title="Total a Facturar" value={grandTotal.toLocaleString('es-CL', { style: 'currency', currency: 'CLP' })} colorClass="bg-emerald-100" />
                    </div>

                    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                        <div className="lg:col-span-1 bg-[var(--background-secondary)] p-4 rounded-lg border border-[var(--border-primary)] shadow-sm"><h4 className="text-md font-semibold text-[var(--text-primary)] mb-2 text-center">Desglose de Estados</h4><canvas ref={statusChartRef}></canvas></div>
                        <div className="lg:col-span-2 bg-[var(--background-secondary)] p-4 rounded-lg border border-[var(--border-primary)] shadow-sm"><h4 className="text-md font-semibold text-[var(--text-primary)] mb-2 text-center">Volumen de Envíos Creados</h4><canvas ref={volumeChartRef}></canvas></div>
                    </div>

                    <div className="bg-[var(--background-secondary)] shadow-md rounded-lg p-6">
                         <div className="flex justify-between items-center mb-4">
                            <h3 className="text-lg font-semibold text-[var(--text-primary)]">Detalle para Facturación</h3>
                            <div className="flex gap-2">
                                {(billablePackages.length > 0 || pickupActionsCount > 0) && (
                                    <>
                                        <button 
                                            onClick={handleExportCSV} 
                                            disabled={isExporting}
                                            className="inline-flex items-center px-4 py-2 text-sm font-medium text-[var(--text-primary)] bg-[var(--background-secondary)] border border-[var(--border-secondary)] rounded-md shadow-sm hover:bg-[var(--background-hover)] disabled:opacity-50"
                                        >
                                            <IconFileSpreadsheet className={`w-4 h-4 mr-2 ${isExporting ? 'animate-spin' : ''}`}/>
                                            {isExporting ? 'Exportando...' : 'Exportar CSV'}
                                        </button>
                                        <button onClick={handleGenerateAndBill} className="inline-flex items-center px-4 py-2 text-sm font-medium text-[var(--text-on-brand)] bg-[var(--brand-primary)] border border-transparent rounded-md shadow-sm hover:bg-[var(--brand-secondary)]">
                                            <IconPrinter className="w-4 h-4 mr-2"/> Generar y Facturar
                                        </button>
                                    </>
                                )}
                            </div>
                         </div>
                        <div className="border border-[var(--border-primary)] rounded-lg overflow-hidden">
                            <table className="min-w-full divide-y divide-[var(--border-primary)]">
                                <thead className="bg-[var(--background-muted)]">
                                    <tr>
                                        <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider">Detalle</th>
                                        <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider">Tipo/Fecha</th>
                                        <th scope="col" className="px-6 py-3 text-right text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider">Costo</th>
                                    </tr>
                                </thead>
                                <tbody className="bg-[var(--background-secondary)] divide-y divide-[var(--border-primary)]">
                                    {billablePackages.length === 0 && pickupActionsCount === 0 ? (
                                        <tr><td colSpan={3} className="px-6 py-4 text-center text-[var(--text-muted)]">No se encontraron items para facturar.</td></tr>
                                    ) : (
                                        <>
                                            {billablePackages.map(pkg => (
                                                <tr key={pkg.id}>
                                                    <td className="px-6 py-3 whitespace-nowrap text-sm font-medium text-[var(--text-primary)]">{pkg.id}<br/><span className="font-normal text-xs text-[var(--text-secondary)]">{pkg.recipientName}</span></td>
                                                    <td className="px-6 py-3 whitespace-nowrap text-sm text-[var(--text-secondary)]">{pkg.shippingType}<br/><span className="text-xs">{new Date(pkg.history.find(e => e.status === 'ENTREGADO')?.timestamp || pkg.updatedAt).toLocaleDateString('es-CL')}</span></td>
                                                    <td className="px-6 py-3 whitespace-nowrap text-sm text-[var(--text-secondary)] text-right font-semibold">{getPackageCost(pkg).toLocaleString('es-CL', { style: 'currency', currency: 'CLP' })}</td>
                                                </tr>
                                            ))}
                                        </>
                                    )}
                                </tbody>
                                <tfoot className="bg-[var(--background-muted)] font-semibold">
                                     <tr>
                                        <td colSpan={2} className="px-6 py-3 text-right text-sm text-[var(--text-primary)]">Subtotal Entregas</td>
                                        <td className="px-6 py-3 text-right text-sm text-[var(--text-primary)]">{totalDeliveriesCost.toLocaleString('es-CL', { style: 'currency', currency: 'CLP' })}</td>
                                    </tr>
                                     <tr>
                                        <td colSpan={2} className="px-6 py-3 text-right text-sm text-[var(--text-primary)]">Subtotal Retiros ({pickupActionsCount} @ {(selectedClient?.pickupCost || 0).toLocaleString('es-CL', { style: 'currency', currency: 'CLP' })})</td>
                                        <td className="px-6 py-3 text-right text-sm text-[var(--text-primary)]">{totalPickupsCost.toLocaleString('es-CL', { style: 'currency', currency: 'CLP' })}</td>
                                    </tr>
                                     <tr className="border-t-2 border-[var(--border-primary)]">
                                        <td colSpan={2} className="px-6 py-4 text-right font-bold text-lg text-[var(--brand-primary)]">TOTAL</td>
                                        <td className="px-6 py-4 text-right font-bold text-lg text-[var(--brand-primary)]">{grandTotal.toLocaleString('es-CL', { style: 'currency', currency: 'CLP' })}</td>
                                    </tr>
                                </tfoot>
                            </table>
                        </div>
                    </div>
                </div>
            )}
        </div>

        {/* --- Printable Report --- */}
        <div className="hidden print:block print-container font-sans bg-white text-gray-800">
             {selectedClient && (
                <div className="p-8" style={{ width: '8.5in', minHeight: '11in' }}>
                    <header className="flex justify-between items-start pb-4 border-b-2 border-gray-800">
                        <div className="flex items-center gap-4">
                            <IconCube className="w-10 h-10 text-gray-800"/>
                            <h1 className="text-3xl font-bold text-gray-900">ESTADO DE CUENTA</h1>
                        </div>
                        <div className="text-right">
                             <h2 className="text-xl font-semibold text-gray-800">{auth?.systemSettings.companyName || 'FULL ENVIOS'}</h2>
                             <p className="text-sm text-gray-600">Servicios de Logística</p>
                        </div>
                    </header>
                    <section className="my-8 grid grid-cols-2 gap-x-8 text-sm">
                        <div>
                            <h3 className="font-bold text-gray-500 uppercase tracking-wider mb-2">Facturar a</h3>
                            <p className="font-semibold text-base text-gray-900">{selectedClient?.billingName || selectedClient?.name}</p>
                            <p>{selectedClient?.billingRut || selectedClient?.rut}</p>
                            <p>{selectedClient?.billingAddress}, {selectedClient?.billingCommune}</p>
                            <p>Giro: {selectedClient?.billingGiro}</p>
                        </div>
                        <div className="text-right bg-gray-50 p-4 rounded-lg">
                            <p className="text-gray-500">Fecha de Emisión:</p>
                            <p className="font-semibold text-gray-800">{new Date().toLocaleDateString('es-CL')}</p>
                            <p className="text-gray-500 mt-2">Período de Facturación:</p>
                            <p className="font-semibold text-gray-800">{new Date(startDate + 'T00:00:00').toLocaleDateString('es-CL')} al {new Date(endDate + 'T00:00:00').toLocaleDateString('es-CL')}</p>
                        </div>
                    </section>
                    
                    <table className="min-w-full text-sm">
                        <thead className="bg-gray-100">
                            <tr>
                                <th className="p-2 text-left font-semibold text-gray-600 border-b-2 border-gray-300">Descripción</th>
                                <th className="p-2 text-right font-semibold text-gray-600 border-b-2 border-gray-300">Cantidad</th>
                                <th className="p-2 text-right font-semibold text-gray-600 border-b-2 border-gray-300">Valor Unitario</th>
                                <th className="p-2 text-right font-semibold text-gray-600 border-b-2 border-gray-300">Subtotal</th>
                            </tr>
                        </thead>
                        <tbody>
                             <tr className="border-b border-gray-200">
                                <td className="p-2">Servicio de Entregas</td>
                                <td className="p-2 text-right">{billablePackages.length}</td>
                                <td className="p-2 text-right">-</td>
                                <td className="p-2 text-right">{totalDeliveriesCost.toLocaleString('es-CL', { style: 'currency', currency: 'CLP' })}</td>
                            </tr>
                             <tr className="border-b border-gray-200">
                                <td className="p-2">Servicio de Retiros</td>
                                <td className="p-2 text-right">{pickupActionsCount}</td>
                                <td className="p-2 text-right">{(selectedClient?.pickupCost || 0).toLocaleString('es-CL', { style: 'currency', currency: 'CLP' })}</td>
                                <td className="p-2 text-right">{totalPickupsCost.toLocaleString('es-CL', { style: 'currency', currency: 'CLP' })}</td>
                            </tr>
                        </tbody>
                        <tfoot>
                            <tr>
                                <td colSpan={3} className="p-2 text-right font-bold text-lg text-gray-800 border-t-2 border-gray-400 mt-4">TOTAL A FACTURAR</td>
                                <td className="p-2 text-right font-bold text-lg text-gray-800 border-t-2 border-gray-400 mt-4">{grandTotal.toLocaleString('es-CL', { style: 'currency', currency: 'CLP' })}</td>
                            </tr>
                        </tfoot>
                    </table>
                    
                    <div className="mt-8 pt-4 border-t border-gray-200">
                        <h4 className="font-semibold text-gray-700 mb-2">Detalle de Envíos ({billablePackages.length})</h4>
                        <table className="w-full text-xs">
                             <thead className="bg-gray-50">
                                <tr>
                                    <th className="p-1 text-left font-medium text-gray-500">ID Paquete</th>
                                    <th className="p-1 text-left font-medium text-gray-500">Destinatario</th>
                                    <th className="p-1 text-left font-medium text-gray-500">Fecha</th>
                                    <th className="p-1 text-right font-medium text-gray-500">Costo</th>
                                </tr>
                            </thead>
                            <tbody>
                            {billablePackages.map(pkg => (
                                <tr key={pkg.id} className="border-b border-gray-100">
                                    <td className="p-1 font-mono">{pkg.id}</td>
                                    <td className="p-1">{pkg.recipientName}</td>
                                    <td className="p-1">{new Date(pkg.history.find(e => e.status === 'ENTREGADO')?.timestamp || pkg.updatedAt).toLocaleDateString('es-CL')}</td>
                                    <td className="p-1 text-right">{getPackageCost(pkg).toLocaleString('es-CL', { style: 'currency', currency: 'CLP' })}</td>
                                </tr>
                            ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}
        </div>
        </>
    );
};

export default BillingReportPage;