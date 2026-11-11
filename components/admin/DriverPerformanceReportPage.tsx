
import React, { useState, useEffect, useMemo, ReactNode, useRef } from 'react';
import { api } from '../../services/api';
import { Role, PackageStatus, ShippingType } from '../../constants';
import type { User, Package, AssignmentEvent, PickupRun } from '../../types';
import { IconPrinter, IconWhatsapp, IconMail, IconChecklist, IconClock, IconRoute, IconAlertTriangle, IconCalendar, IconFileSpreadsheet, IconRefresh, IconSearch, IconEye } from '../Icon';
import DriverDeliveryDetailModal from '../modals/DriverDeliveryDetailModal';
import { useContext } from 'react';
import { AuthContext } from '../../contexts/AuthContext';

// Declare Chart.js in the global scope to avoid TypeScript errors
declare const Chart: any;

import { getLocalDateString, getLogicalDateString } from '../../utils/dateUtils';

const getISODate = (date: Date, tz: string) => getLocalDateString(date, tz);

const KpiCard: React.FC<{ icon: ReactNode, title: string, value: string | number, subtext?: string, color: string, trend?: 'up' | 'down' | 'neutral' }> = ({ icon, title, value, subtext, color, trend }) => (
    <div className="bg-[var(--background-secondary)] rounded-xl p-5 shadow-lg border border-[var(--border-primary)] relative overflow-hidden group transition-all hover:shadow-xl hover:-translate-y-1">
        <div className={`absolute top-0 right-0 w-24 h-24 -mr-8 -mt-8 rounded-full opacity-10 ${color}`}></div>
        <div className="flex items-center relative z-10">
            <div className={`flex-shrink-0 p-3.5 rounded-xl shadow-inner ${color}`}>
                {icon}
            </div>
            <div className="ml-5">
                <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest mb-0.5">{title}</p>
                <div className="flex items-baseline gap-2">
                    <p className="text-3xl font-black text-[var(--text-primary)]">{value}</p>
                    {trend && (
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${trend === 'up' ? 'bg-green-100 text-green-600' : 'bg-red-100 text-red-600'}`}>
                            {trend === 'up' ? '↑' : '↓'}
                        </span>
                    )}
                </div>
                {subtext && <p className="text-[11px] font-bold text-[var(--text-muted)] mt-1">{subtext}</p>}
            </div>
        </div>
    </div>
);

interface DriverPerformanceReportPageProps {
    driverIdProp?: string;
}

export const DriverPerformanceReportPage: React.FC<DriverPerformanceReportPageProps> = ({ driverIdProp }) => {
    const auth = useContext(AuthContext);
    const systemSettings = auth?.systemSettings;
    const [packages, setPackages] = useState<Package[]>([]);
    const [users, setUsers] = useState<User[]>([]);
    const [assignmentEvents, setAssignmentEvents] = useState<AssignmentEvent[]>([]);
    const [pickupRuns, setPickupRuns] = useState<PickupRun[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isExporting, setIsExporting] = useState(false);
    const [isDetailModalOpen, setIsDetailModalOpen] = useState(false);
    const [selectedDriverId, setSelectedDriverId] = useState<string>(driverIdProp || '');
    
    const tz = auth?.systemSettings?.timezone || 'America/Santiago';
    const todayStr = getLogicalDateString(new Date(), tz);
    const today = new Date(todayStr + 'T12:00:00'); // Use noon to avoid DST/TZ issues when getting month start
    const firstDayOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);

    const [startDate, setStartDate] = useState(getISODate(firstDayOfMonth, tz));
    const [endDate, setEndDate] = useState(todayStr);
    
    const dailyDeliveriesChartRef = useRef<HTMLCanvasElement>(null);
    const deliveryTypeChartRef = useRef<HTMLCanvasElement>(null);
    const hourlyFlowChartRef = useRef<HTMLCanvasElement>(null);
    const chartInstances = useRef<{ daily?: any; type?: any; hourly?: any }>({});
    
    const [isDriverSearchOpen, setIsDriverSearchOpen] = useState(false);
    const [driverSearchTerm, setDriverSearchTerm] = useState('');
    const driverRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (driverRef.current && !driverRef.current.contains(event.target as Node)) {
                setIsDriverSearchOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);
    
    // Use a unified ID source
    const targetDriverId = driverIdProp || selectedDriverId;

    const fetchData = async () => {
        setIsLoading(true);
        try {
            // 1. Fetch users only if in admin mode (no fixed driverIdProp)
            if (!driverIdProp) {
                const allUsers = await api.getUsers();
                setUsers(allUsers);
            } else if (auth?.user) {
                // If we are a driver, we already have our user object
                setUsers([auth.user]);
            }

            // 2. Fetch all performance data ONLY if we have a selected driver
            if (targetDriverId) {
                const [packagesResponse, allEvents, runs] = await Promise.all([
                    api.getPackages({ 
                        limit: 0, 
                        driverFilter: targetDriverId,
                        startDate,
                        endDate,
                        statusFilter: [PackageStatus.Delivered, PackageStatus.Problem, PackageStatus.Returned].join(','),
                        // Panel de administración: pedir por fecha de CIERRE. Sin esto el servidor filtra a los administradores por fecha de CREACIÓN y se pierden
                        // las entregas de paquetes creados antes del rango. El teléfono del conductor (driverIdProp) no manda esto: ya recibía el número correcto.
                        ...(driverIdProp ? {} : { dateType: 'closed' })
                    }),
                    api.getAssignmentHistory(),
                    api.getPickupRuns({ startDate, endDate })
                ]);
                
                setPackages(packagesResponse.packages);
                setAssignmentEvents(allEvents || []);
                setPickupRuns(runs || []);
            } else {
                setPackages([]);
                setAssignmentEvents([]);
                setPickupRuns([]);
            }
        } catch (error) {
            console.error("Failed to fetch report data", error);
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        fetchData();
    }, [startDate, endDate, targetDriverId]);

    const drivers = useMemo(() => {
        return users
            .filter(u => String(u.role).toUpperCase() === 'DRIVER')
            .sort((a, b) => a.name.localeCompare(b.name));
    }, [users]);

    const filteredDrivers = useMemo(() => 
        drivers.filter(d => 
            d.name.toLowerCase().includes(driverSearchTerm.toLowerCase())
        ), 
        [drivers, driverSearchTerm]
    );

    const selectedDriver = useMemo(() => {
        if (driverIdProp && auth?.user?.id === driverIdProp) return auth.user;
        return drivers.find(c => c.id === targetDriverId);
    }, [drivers, targetDriverId, driverIdProp, auth?.user]);

    const filteredPackages = useMemo(() => {
        if (!targetDriverId) return [];
        
        // [v2.6.8] Trust the backend filter for targetDriverId. 
        // We only filter by date here to ensure the UI matches the selected range exactly.
        return packages.filter(pkg => {
            // Find the delivery/problem event to get the date. Fallback to updatedAt.
            const relevantEvent = pkg.history?.find(e => 
                e.status === PackageStatus.Delivered || 
                e.status === PackageStatus.Problem || 
                e.status === PackageStatus.Returned
            ) || { timestamp: pkg.updatedAt };

            // Robust timestamp comparison
            const startTimestamp = new Date(startDate + 'T00:00:00').getTime();
            const endTimestamp = new Date(endDate + 'T23:59:59.999').getTime();
            const eventTimestamp = new Date(relevantEvent.timestamp).getTime();
            
            return eventTimestamp >= startTimestamp && eventTimestamp <= endTimestamp;
        });
    }, [packages, targetDriverId, startDate, endDate]);

    const reportStats = useMemo(() => {
        const delivered = filteredPackages.filter(p => p.status === PackageStatus.Delivered);
        const problems = filteredPackages.filter(p => p.status === PackageStatus.Problem);
        const totalAttempted = delivered.length + problems.length;
        
        const successRate = totalAttempted > 0 ? ((delivered.length / totalAttempted) * 100).toFixed(1) : '0';
        
        // On time: Delivered same day it was assigned
        const onTime = delivered.filter(p => {
            if (!p.assignedAt) return true;
            const assignDate = new Date(p.assignedAt).toISOString().split('T')[0];
            const deliveryEvent = p.history.find(e => e.status === PackageStatus.Delivered);
            if (!deliveryEvent) return false;
            const deliveryDate = new Date(deliveryEvent.timestamp).toISOString().split('T')[0];
            return assignDate === deliveryDate;
        });

        const totalDelivered = delivered.length;
        const onTimeRate = totalDelivered > 0 ? ((onTime.length / totalDelivered) * 100).toFixed(0) : '0';
        
        // Avg delivery time: From ASSIGNMENT to DELIVERY (Last mile efficiency)
        const totalDeliveryMillis = delivered.reduce((sum, pkg) => {
            const assignEvent = pkg.history.find(e => e.status === 'ASIGNADO' || e.status === 'EN_TRANSITO') || { timestamp: pkg.assignedAt };
            const deliveryEvent = pkg.history.find(e => e.status === PackageStatus.Delivered);
            if (assignEvent?.timestamp && deliveryEvent) {
                return sum + (new Date(deliveryEvent.timestamp).getTime() - new Date(assignEvent.timestamp).getTime());
            }
            return sum;
        }, 0);
        
        const avgDeliveryHours = totalDelivered > 0 ? (totalDeliveryMillis / totalDelivered / (1000 * 60 * 60)).toFixed(1) : '0';

        return { 
            totalDelivered, 
            successRate: `${successRate}%`, 
            onTimeRate: `${onTimeRate}%`, 
            avgDeliveryHours: `${avgDeliveryHours}h`, 
            totalProblems: problems.length 
        };
    }, [filteredPackages]);
    
    const paymentStats = useMemo(() => {
        const emptyStats = { deliveryBreakdown: [], totalDeliveryCost: 0, pickupCount: 0, totalPackagesPickedUp: 0, pickupRate: 0, totalPickupCost: 0, grandTotal: 0 };
        if (!selectedDriver?.pricing) return emptyStats;

        const rates = selectedDriver.pricing;
        const deliveredPackages = filteredPackages.filter(p => p.status === PackageStatus.Delivered);

        const deliveryCounts = deliveredPackages.reduce((acc, pkg) => {
            acc[pkg.shippingType] = (acc[pkg.shippingType] || 0) + 1;
            return acc;
        }, {} as { [key in ShippingType]?: number });
    
        const deliveryBreakdown = [
            { type: ShippingType.SameDay, label: 'En el Día', count: deliveryCounts[ShippingType.SameDay] || 0, rate: rates.sameDay || 0, total: (deliveryCounts[ShippingType.SameDay] || 0) * (rates.sameDay || 0) },
            { type: ShippingType.Express, label: 'Express', count: deliveryCounts[ShippingType.Express] || 0, rate: rates.express || 0, total: (deliveryCounts[ShippingType.Express] || 0) * (rates.express || 0) },
            { type: ShippingType.NextDay, label: 'Next Day', count: deliveryCounts[ShippingType.NextDay] || 0, rate: rates.nextDay || 0, total: (deliveryCounts[ShippingType.NextDay] || 0) * (rates.nextDay || 0) },
        ];
        const totalDeliveryCost = deliveryBreakdown.reduce((sum, item) => sum + item.total, 0);
        
        const start = new Date(startDate.replace(/-/g, '/'));
        start.setHours(0, 0, 0, 0);
        const end = new Date(endDate.replace(/-/g, '/'));
        end.setHours(23, 59, 59, 999);
    
        // 1. Calculate from Legacy Assignment Events
        const startTimestamp = new Date(startDate + 'T00:00:00').getTime();
        const endTimestamp = new Date(endDate + 'T23:59:59.999').getTime();
        
        const relevantLegacyEvents = assignmentEvents.filter(event => {
            if (event.driverId !== targetDriverId || event.status !== 'COMPLETADO' || !event.completedAt) return false;
            const eventTimestamp = new Date(event.completedAt).getTime();
            return eventTimestamp >= startTimestamp && eventTimestamp <= endTimestamp;
        });

        // 2. Calculate from New Pickup System
        const relevantNewPickups = pickupRuns
            .filter(run => run.driverId === selectedDriverId)
            .flatMap(run => run.assignments)
            .filter(a => a.status === 'RETIRADO'); // Status RETIRADO means completed

        const legacyPickupCount = relevantLegacyEvents.length;
        const legacyPackagesCount = relevantLegacyEvents.reduce((sum, event) => sum + (event.packagesPickedUp || 0), 0);
        const legacyCost = relevantLegacyEvents.reduce((sum, event) => {
            const cost = event.pickupCost !== undefined && event.pickupCost !== null ? event.pickupCost : (rates.pickup || 0);
            return sum + cost;
        }, 0);

        const newPickupCount = relevantNewPickups.length;
        const newPackagesCount = relevantNewPickups.reduce((sum, a) => sum + (a.packagesPickedUp || 0), 0);
        const newCost = relevantNewPickups.reduce((sum, a) => sum + a.cost, 0);

        const pickupCount = legacyPickupCount + newPickupCount;
        const totalPackagesPickedUp = legacyPackagesCount + newPackagesCount;
        const totalPickupCost = legacyCost + newCost;
        const pickupRate = rates.pickup || 0; // Just for display reference

        return { deliveryBreakdown, totalDeliveryCost, pickupCount, totalPackagesPickedUp, pickupRate, totalPickupCost, grandTotal: totalDeliveryCost + totalPickupCost };
    }, [filteredPackages, selectedDriver, startDate, endDate, assignmentEvents, pickupRuns, selectedDriverId]);

    const dailyBreakdown = useMemo(() => {
        if (!selectedDriver) return [];

        const breakdown: { [date: string]: { deliveries: number, pickups: number, deliveryPay: number, pickupPay: number } } = {};
        const rates = selectedDriver.pricing || { sameDay: 0, express: 0, nextDay: 0, pickup: 0 };
        
        const initializeDate = (date: string) => {
             if (!breakdown[date]) {
                breakdown[date] = { deliveries: 0, pickups: 0, deliveryPay: 0, pickupPay: 0 };
            }
        }

        const getLocalDateString = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

        const d = new Date(startDate + 'T12:00:00'); // Use noon to avoid day shifts during increment
        const endD = new Date(endDate + 'T12:00:00');
        
        while (d <= endD) {
            const dateStr = getLocalDateString(d);
            initializeDate(dateStr);
            d.setDate(d.getDate() + 1);
        }

        // Calculate deliveries per day
        const deliveredPackages = filteredPackages.filter(p => p.status === PackageStatus.Delivered);
        deliveredPackages.forEach(pkg => {
            // Find the delivery event to get the actual date
            const deliveryEvent = pkg.history.find(e => e.status === PackageStatus.Delivered) || pkg.history[0];
            const deliveryDateStr = getLocalDateString(new Date(deliveryEvent.timestamp)); // YYYY-MM-DD
            initializeDate(deliveryDateStr);
            breakdown[deliveryDateStr].deliveries++;
            const payRate = pkg.shippingType === ShippingType.SameDay ? rates.sameDay : pkg.shippingType === ShippingType.Express ? rates.express : rates.nextDay;
            breakdown[deliveryDateStr].deliveryPay += payRate || 0;
        });

        // Legacy Pickups
        const startTimestamp = new Date(startDate + 'T00:00:00').getTime();
        const endTimestamp = new Date(endDate + 'T23:59:59.999').getTime();
        
        const relevantLegacyEvents = assignmentEvents.filter(event => {
            if (event.driverId !== selectedDriverId || event.status !== 'COMPLETADO' || !event.completedAt) return false;
            const eventTimestamp = new Date(event.completedAt).getTime();
            return eventTimestamp >= startTimestamp && eventTimestamp <= endTimestamp;
        });

        relevantLegacyEvents.forEach(event => {
            const dateStr = getLocalDateString(new Date(event.completedAt!)); // YYYY-MM-DD
            initializeDate(dateStr);
            breakdown[dateStr].pickups++;
            const cost = event.pickupCost !== undefined && event.pickupCost !== null ? event.pickupCost : (rates.pickup || 0);
            breakdown[dateStr].pickupPay += cost;
        });

        // New System Pickups
        const relevantNewRunPickups = pickupRuns
            .filter(run => run.driverId === selectedDriverId)
            .flatMap(run => {
                // Map assignments to include the run date
                return run.assignments.map(a => ({ ...a, runDate: run.date }));
            })
            .filter(a => a.status === 'RETIRADO');

        relevantNewRunPickups.forEach(a => {
            // runDate is already YYYY-MM-DD from API
            const dateStr = a.runDate;
            if (dateStr >= startDate && dateStr <= endDate) {
                initializeDate(dateStr);
                breakdown[dateStr].pickups++;
                breakdown[dateStr].pickupPay += a.cost;
            }
        });

        return Object.entries(breakdown)
            .map(([date, data]) => ({
                date,
                deliveries: data.deliveries,
                pickups: data.pickups,
                deliveryPay: data.deliveryPay,
                pickupPay: data.pickupPay,
                totalPay: data.deliveryPay + data.pickupPay
            }))
            .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    }, [filteredPackages, selectedDriver, startDate, endDate, assignmentEvents, pickupRuns, selectedDriverId]);


    // Chart logic
    useEffect(() => {
        const dailyCtx = dailyDeliveriesChartRef.current?.getContext('2d');
        const typeCtx = deliveryTypeChartRef.current?.getContext('2d');
        const hourlyCtx = hourlyFlowChartRef.current?.getContext('2d');

        if (chartInstances.current.daily) chartInstances.current.daily.destroy();
        if (chartInstances.current.type) chartInstances.current.type.destroy();
        if (chartInstances.current.hourly) chartInstances.current.hourly.destroy();

        if (dailyCtx && dailyBreakdown.length > 0) {
            const labels = dailyBreakdown.map(day => new Date(day.date + 'T12:00:00').toLocaleDateString('es-CL', { day: '2-digit', month: 'short' }));
            const data = dailyBreakdown.map(day => day.deliveries);
            
            chartInstances.current.daily = new Chart(dailyCtx, {
                type: 'bar',
                data: {
                    labels,
                    datasets: [{ 
                        label: 'Entregas por Día', 
                        data, 
                        backgroundColor: 'rgba(59, 130, 246, 0.8)', 
                        borderRadius: 6,
                        hoverBackgroundColor: 'rgba(59, 130, 246, 1)'
                    }]
                },
                options: { 
                    scales: { 
                        y: { beginAtZero: true, ticks: { stepSize: 1, font: { weight: 'bold' } }, grid: { display: false } },
                        x: { grid: { display: false }, ticks: { font: { weight: 'bold', size: 10 } } }
                    },
                    plugins: { legend: { display: false } },
                    responsive: true,
                    maintainAspectRatio: false
                }
            });
        }
        
        if (typeCtx && filteredPackages.length > 0) {
            const delivered = filteredPackages.filter(p => p.status === PackageStatus.Delivered);
            const typeCounts = delivered.reduce((acc, pkg) => {
                acc[pkg.shippingType] = (acc[pkg.shippingType] || 0) + 1;
                return acc;
            }, {} as { [key in ShippingType]?: number });

            chartInstances.current.type = new Chart(typeCtx, {
                type: 'doughnut',
                data: {
                    labels: Object.keys(typeCounts),
                    datasets: [{
                        data: Object.values(typeCounts),
                        backgroundColor: ['#6366f1', '#f59e0b', '#10b981'],
                        borderWidth: 0,
                        hoverOffset: 10
                    }]
                },
                options: { 
                    plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { weight: 'bold', size: 11 } } } },
                    cutout: '65%',
                    responsive: true, 
                    maintainAspectRatio: false 
                }
            });
        }

        if (hourlyCtx && filteredPackages.length > 0) {
            const hourCounts = new Array(24).fill(0);
            filteredPackages.filter(p => p.status === PackageStatus.Delivered).forEach(pkg => {
                const deliveryEvent = pkg.history.find(e => e.status === PackageStatus.Delivered);
                if (deliveryEvent) {
                    const hour = new Date(deliveryEvent.timestamp).getHours();
                    hourCounts[hour]++;
                }
            });

            // Only show hours from 8:00 to 22:00
            const labels = Array.from({length: 15}, (_, i) => `${i + 8}:00`);
            const data = hourCounts.slice(8, 23);

            chartInstances.current.hourly = new Chart(hourlyCtx, {
                type: 'line',
                data: {
                    labels,
                    datasets: [{
                        label: 'Flujo Horario',
                        data,
                        borderColor: '#6366f1',
                        backgroundColor: 'rgba(99, 102, 241, 0.1)',
                        fill: true,
                        tension: 0.4,
                        pointRadius: 4,
                        pointBackgroundColor: '#fff',
                        pointBorderWidth: 2
                    }]
                },
                options: {
                    scales: {
                        y: { beginAtZero: true, display: false },
                        x: { grid: { display: false }, ticks: { font: { size: 10, weight: 'bold' } } }
                    },
                    plugins: { legend: { display: false } },
                    responsive: true,
                    maintainAspectRatio: false
                }
            });
        }
    }, [filteredPackages, dailyBreakdown]);
    
    const inputClasses = "w-full px-3 py-2 border border-[var(--border-secondary)] rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-secondary)] bg-[var(--background-secondary)] text-[var(--text-primary)]";

    const formatForCurrency = (value: number) => value.toLocaleString('es-CL', { style: 'currency', currency: 'CLP' });

    const whatsappMessage = `Hola ${selectedDriver?.name},\n\nAquí está el resumen de tu pago para el período del ${new Date(startDate + 'T00:00:00').toLocaleDateString('es-CL')} al ${new Date(endDate + 'T00:00:00').toLocaleDateString('es-CL')}:\n\n*Total a Pagar: ${formatForCurrency(paymentStats.grandTotal)}*\n\n*Detalles:*\n- Entregas: ${reportStats.totalDelivered} paquetes\n- Retiros: ${paymentStats.pickupCount} solicitudes (${paymentStats.totalPackagesPickedUp} paq.)\n\nSaludos,\nEl equipo de administración.`;
    const emailSubject = `Resumen de Pago - ${selectedDriver?.name} - ${new Date(startDate + 'T00:00:00').toLocaleDateString('es-CL')} a ${new Date(endDate + 'T00:00:00').toLocaleDateString('es-CL')}`;
    const emailBody = `Hola ${selectedDriver?.name},\n\nAdjunto encontrarás el resumen de tu pago para el período del ${new Date(startDate + 'T00:00:00').toLocaleDateString('es-CL')} al ${new Date(endDate + 'T00:00:00').toLocaleDateString('es-CL')}.\n\n*Resumen General:*\n*Total a Pagar:* ${formatForCurrency(paymentStats.grandTotal)}\n\n*Desglose:*\n- Total por Entregas: ${formatForCurrency(paymentStats.totalDeliveryCost)}\n- Total por Retiros: ${formatForCurrency(paymentStats.totalPickupCost)}\n\nSi tienes alguna pregunta, no dudes en contactarnos.\n\nSaludos cordiales,\nEl equipo de administración.`;
    
    const handleExportCSV = async () => {
        if (!selectedDriver || isExporting) return;
        
        setIsExporting(true);
        try {
            // Small delay to allow UI to show loading state
            await new Promise(resolve => setTimeout(resolve, 100));

            const rates = selectedDriver.pricing || { sameDay: 0, express: 0, nextDay: 0 };
            
            const escapeCSV = (val: any) => {
                const str = String(val || '').replace(/"/g, '""');
                return `"${str}"`;
            };

            let csvContent = '\uFEFF'; // BOM for Excel

            // Section 1: Summary
            csvContent += escapeCSV("Informe de Rendimiento y Pago") + '\n';
            csvContent += escapeCSV("Conductor:") + ',' + escapeCSV(selectedDriver.name) + '\n';
            csvContent += escapeCSV("Período:") + ',' + escapeCSV(`${new Date(startDate + 'T00:00:00').toLocaleDateString('es-CL')} a ${new Date(endDate + 'T00:00:00').toLocaleDateString('es-CL')}`) + '\n\n';

            csvContent += escapeCSV("Métricas de Rendimiento (KPIs)") + '\n';
            csvContent += escapeCSV("Métrica") + ',' + escapeCSV("Valor") + '\n';
            csvContent += escapeCSV("Total Entregados") + ',' + escapeCSV(reportStats.totalDelivered) + '\n';
            csvContent += escapeCSV("Tasa de Entregas a Tiempo") + ',' + escapeCSV(reportStats.onTimeRate) + '\n';
            csvContent += escapeCSV("Tiempo Promedio de Entrega") + ',' + escapeCSV(reportStats.avgDeliveryHours) + '\n';
            csvContent += escapeCSV("Total Paquetes con Problema") + ',' + escapeCSV(reportStats.totalProblems) + '\n\n';

            csvContent += escapeCSV("Liquidación de Pagos") + '\n';
            csvContent += escapeCSV("Concepto") + ',' + escapeCSV("Cantidad") + ',' + escapeCSV("Tarifa") + ',' + escapeCSV("Subtotal") + '\n';
            paymentStats.deliveryBreakdown.forEach(item => {
                csvContent += escapeCSV(`Entregas ${item.label}`) + ',' + escapeCSV(item.count) + ',' + escapeCSV(item.rate) + ',' + escapeCSV(item.total) + '\n';
            });
            csvContent += escapeCSV("Retiros Realizados") + ',' + escapeCSV(paymentStats.pickupCount) + ',' + escapeCSV(paymentStats.pickupRate) + ',' + escapeCSV(paymentStats.totalPickupCost) + '\n';
            csvContent += escapeCSV("TOTAL A PAGAR") + ',,,' + escapeCSV(paymentStats.grandTotal) + '\n\n';

            // Section 2: Daily Breakdown
            csvContent += escapeCSV("Detalle Diario") + '\n';
            csvContent += escapeCSV("Fecha") + ',' + escapeCSV("N° Entregas") + ',' + escapeCSV("Pago Entregas") + ',' + escapeCSV("N° Retiros") + ',' + escapeCSV("Pago Retiros") + ',' + escapeCSV("Total Día") + '\n';
            dailyBreakdown.forEach(day => {
                csvContent += escapeCSV(new Date(day.date + 'T00:00:00').toLocaleDateString('es-CL')) + ',' + 
                              escapeCSV(day.deliveries) + ',' + 
                              escapeCSV(day.deliveryPay) + ',' + 
                              escapeCSV(day.pickups) + ',' + 
                              escapeCSV(day.pickupPay) + ',' + 
                              escapeCSV(day.totalPay) + '\n';
            });
            csvContent += '\n';

            // Section 3: Package List
            const deliveredPackages = filteredPackages.filter(p => p.status === PackageStatus.Delivered);
            const getPayRate = (pkg: Package) => {
                if (!rates) return 0;
                switch(pkg.shippingType) {
                    case ShippingType.SameDay: return rates.sameDay;
                    case ShippingType.Express: return rates.express;
                    case ShippingType.NextDay: return rates.nextDay;
                    default: return 0;
                }
            };

            csvContent += escapeCSV("Listado de Paquetes Entregados") + '\n';
            csvContent += escapeCSV("ID Paquete") + ',' + escapeCSV("Destinatario") + ',' + escapeCSV("Comuna") + ',' + escapeCSV("Fecha Entrega") + ',' + escapeCSV("Tipo Envío") + ',' + escapeCSV("Pago Conductor") + '\n';
            
            // Chunked processing for the package list
            const CHUNK_SIZE = 500;
            for (let i = 0; i < deliveredPackages.length; i += CHUNK_SIZE) {
                const chunk = deliveredPackages.slice(i, i + CHUNK_SIZE);
                chunk.forEach(pkg => {
                    csvContent += escapeCSV(pkg.id) + ',' + 
                                  escapeCSV(pkg.recipientName) + ',' + 
                                  escapeCSV(pkg.recipientCommune) + ',' + 
                                  escapeCSV(new Date(pkg.history[0].timestamp).toLocaleDateString('es-CL')) + ',' + 
                                  escapeCSV(pkg.shippingType) + ',' + 
                                  escapeCSV(getPayRate(pkg)) + '\n';
                });
                // Yield to main thread
                await new Promise(resolve => setTimeout(resolve, 0));
            }

            const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
            const link = document.createElement("a");
            const url = URL.createObjectURL(blob);
            
            link.setAttribute("href", url);
            link.setAttribute("download", `Liquidacion_${selectedDriver.name.replace(/\s+/g, '_')}_${startDate}_${endDate}.csv`);
            link.style.visibility = 'hidden';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
        } catch (error) {
            console.error("CSV export failed", error);
            alert("Error al exportar los datos.");
        } finally {
            setIsExporting(false);
        }
    };

    return (
        <>
        <div id="report-container" className="space-y-6">
            <div className="bg-[var(--background-secondary)] shadow-md rounded-lg p-6 print:hidden">
            <div className="bg-[var(--background-secondary)] shadow-sm rounded-xl p-4 border border-[var(--border-primary)] print:hidden">
                <div className="flex flex-wrap items-end gap-2 sm:gap-4">
                    {/* Searchable Driver Dropdown (Admin only) */}
                    {!driverIdProp && (
                    <div className="flex-1 min-w-[200px] relative" ref={driverRef}>
                        <label className="text-[9px] font-black text-gray-400 uppercase tracking-widest mb-1 block">Conductor</label>
                        <div 
                            className="w-full pl-3 pr-8 py-1.5 border border-[var(--border-secondary)] rounded-lg shadow-sm bg-[var(--background-primary)] text-left cursor-pointer text-xs font-bold flex justify-between items-center transition-all hover:border-[var(--brand-primary)] h-[38px]"
                            onClick={() => setIsDriverSearchOpen(!isDriverSearchOpen)}
                        >
                            <span className="truncate text-[var(--text-primary)]">
                                {selectedDriver ? selectedDriver.name.toUpperCase() : '-- SELECCIONAR --'}
                            </span>
                            <span className="text-[var(--text-muted)] ml-1 text-[9px]">{isDriverSearchOpen ? '▲' : '▼'}</span>
                        </div>
                        
                        {isDriverSearchOpen && (
                            <div className="absolute z-50 mt-1 w-full bg-[var(--background-secondary)] border border-[var(--border-primary)] rounded-md shadow-2xl overflow-hidden animate-in fade-in zoom-in duration-200">
                                <div className="p-2 border-b border-[var(--border-primary)] bg-[var(--background-muted)]">
                                    <div className="relative">
                                        <input
                                            type="text"
                                            placeholder="Buscar..."
                                            value={driverSearchTerm}
                                            onChange={(e) => setDriverSearchTerm(e.target.value)}
                                            className="w-full pl-8 pr-4 py-1.5 bg-[var(--background-primary)] border border-[var(--border-secondary)] rounded-md text-xs focus:ring-1 focus:ring-[var(--brand-primary)]"
                                            onClick={(e) => e.stopPropagation()}
                                        />
                                        <IconSearch className="absolute left-2.5 top-2 h-3.5 w-3.5 text-gray-400" />
                                    </div>
                                </div>
                                <div className="max-h-60 overflow-y-auto">
                                    {filteredDrivers.map(d => (
                                        <div 
                                            key={d.id}
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                setSelectedDriverId(d.id);
                                                setIsDriverSearchOpen(false);
                                            }}
                                            className={`px-4 py-2 text-xs font-bold cursor-pointer transition-colors hover:bg-[var(--brand-primary)] hover:text-white ${selectedDriverId === d.id ? 'bg-[var(--background-muted)] text-[var(--brand-primary)]' : 'text-[var(--text-secondary)]'}`}
                                        >
                                            {d.name.toUpperCase()}
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                    )}

                    <div className="flex-1 min-w-[110px]">
                        <label className="text-[9px] font-black text-gray-400 uppercase tracking-widest mb-1 block">Desde</label>
                        <div className="relative">
                            <div className="flex items-center justify-between w-full px-2 py-1.5 border border-[var(--border-secondary)] rounded-lg shadow-sm bg-[var(--background-primary)] text-left cursor-pointer text-xs font-bold transition-all hover:border-[var(--brand-primary)] h-[38px]">
                                <span className="text-[var(--text-primary)]">
                                    {new Date(startDate.replace(/-/g, '/')).toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit' })}
                                </span>
                                <IconCalendar className="h-4 w-4 text-[var(--text-muted)]" />
                            </div>
                            <input 
                                type="date" 
                                value={startDate} 
                                onChange={e => setStartDate(e.target.value)} 
                                className="absolute top-0 left-0 w-full h-full opacity-0 cursor-pointer"
                            />
                        </div>
                    </div>

                    <div className="flex-1 min-w-[110px]">
                        <label className="text-[9px] font-black text-gray-400 uppercase tracking-widest mb-1 block">Hasta</label>
                        <div className="relative">
                            <div className="flex items-center justify-between w-full px-2 py-1.5 border border-[var(--border-secondary)] rounded-lg shadow-sm bg-[var(--background-primary)] text-left cursor-pointer text-xs font-bold transition-all hover:border-[var(--brand-primary)] h-[38px]">
                                <span className="text-[var(--text-primary)]">
                                    {new Date(endDate.replace(/-/g, '/')).toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit' })}
                                </span>
                                <IconCalendar className="h-4 w-4 text-[var(--text-muted)]" />
                            </div>
                            <input 
                                type="date" 
                                value={endDate} 
                                onChange={e => setEndDate(e.target.value)} 
                                className="absolute top-0 left-0 w-full h-full opacity-0 cursor-pointer"
                            />
                        </div>
                    </div>

                    <button 
                        onClick={fetchData}
                        disabled={isLoading}
                        className="flex-shrink-0 flex items-center justify-center h-[38px] w-[38px] sm:w-auto sm:px-4 bg-[var(--brand-primary)] text-white text-xs font-black rounded-lg hover:bg-[var(--brand-hover)] transition-all shadow-md disabled:opacity-50 uppercase"
                    >
                        <IconRefresh className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
                        <span className="hidden sm:inline ml-2">Actualizar</span>
                    </button>
                </div>
            </div>
            </div>
            
            {!isLoading && selectedDriver && filteredPackages.length === 0 && (
                <div className="bg-[var(--background-secondary)] rounded-xl p-10 text-center border border-[var(--border-primary)] shadow-sm animate-fade-in">
                    <IconAlertTriangle className="w-12 h-12 text-amber-500 mx-auto mb-4 opacity-50"/>
                    <h3 className="text-lg font-bold text-[var(--text-primary)]">Sin actividad en este periodo</h3>
                    <p className="text-[var(--text-muted)] text-sm max-w-md mx-auto mt-2">
                        No se encontraron entregas o problemas registrados para {selectedDriver.name} entre el {startDate} y el {endDate}. Prueba seleccionando un rango de fechas distinto.
                    </p>
                </div>
            )}
            
            {selectedDriver && !isLoading && filteredPackages.length > 0 && (
                <div className="space-y-6 animate-fade-in-up">
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
                        <KpiCard icon={<IconChecklist className="w-6 h-6 text-indigo-600"/>} title="Entregados" value={reportStats.totalDelivered} trend="up" color="bg-indigo-100"/>
                        <KpiCard icon={<IconChecklist className="w-6 h-6 text-emerald-600"/>} title="Tasa Éxito" value={reportStats.successRate} trend="up" subtext="Efectividad en ruta" color="bg-emerald-100"/>
                        <KpiCard icon={<IconRoute className="w-6 h-6 text-amber-600"/>} title="Eficiencia" value={reportStats.avgDeliveryHours} subtext="Asignación a entrega" color="bg-amber-100"/>
                        <KpiCard icon={<IconAlertTriangle className="w-6 h-6 text-rose-600"/>} title="Problemas" value={reportStats.totalProblems} color="bg-rose-100"/>
                    </div>

                    <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
                        <div className="lg:col-span-2 bg-[var(--background-secondary)] p-6 rounded-xl border border-[var(--border-primary)] shadow-lg">
                            <div className="flex justify-between items-center mb-6">
                                <h4 className="text-xs font-black text-gray-400 uppercase tracking-widest">Volumen de Entregas</h4>
                                <IconCalendar className="w-4 h-4 text-gray-400"/>
                            </div>
                            <div className="h-72"><canvas ref={dailyDeliveriesChartRef}></canvas></div>
                        </div>
                        <div className={`lg:col-span-1 bg-[var(--background-secondary)] p-6 rounded-xl border border-[var(--border-primary)] shadow-lg ${driverIdProp ? 'hidden' : ''}`}>
                            <h4 className="text-xs font-black text-gray-400 uppercase tracking-widest mb-6">Mix de Servicios</h4>
                            <div className="h-72"><canvas ref={deliveryTypeChartRef}></canvas></div>
                        </div>
                        <div className="lg:col-span-1 bg-[var(--background-secondary)] p-6 rounded-xl border border-[var(--border-primary)] shadow-lg">
                            <h4 className="text-xs font-black text-gray-400 uppercase tracking-widest mb-6">Flujo Horario</h4>
                            <div className="h-72"><canvas ref={hourlyFlowChartRef}></canvas></div>
                        </div>
                    </div>

                    {/* Payment Section (Hidden for drivers per request) */}
                    {!driverIdProp && (
                    <div className="bg-[var(--background-secondary)] shadow-md rounded-lg p-6 border border-[var(--border-primary)]">
                        <h3 className="text-lg font-bold text-[var(--text-primary)] mb-4">Resumen de Pago Estimado</h3>
                        <div className="overflow-x-auto">
                            <table className="min-w-full divide-y divide-[var(--border-primary)] mb-6">
                                <thead className="bg-[var(--background-muted)]">
                                    <tr>
                                        <th className="px-6 py-3 text-left text-xs font-medium text-[var(--text-muted)] uppercase">Concepto</th>
                                        <th className="px-6 py-3 text-center text-xs font-medium text-[var(--text-muted)] uppercase">Cantidad</th>
                                        <th className="px-6 py-3 text-right text-xs font-medium text-[var(--text-muted)] uppercase">Tarifa</th>
                                        <th className="px-6 py-3 text-right text-xs font-medium text-[var(--text-muted)] uppercase">Total</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-[var(--border-primary)]">
                                    {paymentStats.deliveryBreakdown.map((item) => (
                                        <tr key={item.type}>
                                            <td className="px-6 py-3 text-sm text-[var(--text-primary)]">Entregas {item.label}</td>
                                            <td className="px-6 py-3 text-sm text-center text-[var(--text-secondary)]">{item.count}</td>
                                            <td className="px-6 py-3 text-sm text-right text-[var(--text-secondary)]">{formatForCurrency(item.rate)}</td>
                                            <td className="px-6 py-3 text-sm text-right font-medium text-[var(--text-primary)]">{formatForCurrency(item.total)}</td>
                                        </tr>
                                    ))}
                                    <tr className="bg-[var(--background-muted)]/50">
                                        <td className="px-6 py-3 text-sm font-semibold text-[var(--text-primary)]">Retiros Realizados</td>
                                        <td className="px-6 py-3 text-sm text-center font-semibold text-[var(--text-primary)]">{paymentStats.pickupCount} <span className="text-xs font-normal text-[var(--text-muted)]">({paymentStats.totalPackagesPickedUp} paq.)</span></td>
                                        <td className="px-6 py-3 text-sm text-right text-[var(--text-secondary)]">{paymentStats.pickupRate > 0 ? formatForCurrency(paymentStats.pickupRate) : 'Var'}</td>
                                        <td className="px-6 py-3 text-sm text-right font-medium text-[var(--text-primary)]">{formatForCurrency(paymentStats.totalPickupCost)}</td>
                                    </tr>
                                </tbody>
                                <tfoot className="bg-[var(--background-muted)]">
                                    <tr>
                                        <td colSpan={3} className="px-6 py-4 text-right font-bold text-lg text-[var(--text-primary)]">TOTAL A PAGAR</td>
                                        <td className="px-6 py-4 text-right font-bold text-lg text-[var(--brand-primary)]">{formatForCurrency(paymentStats.grandTotal)}</td>
                                    </tr>
                                </tfoot>
                            </table>
                        </div>
                    </div>
                    )}
                    
                    <div className="flex flex-wrap justify-center gap-3 print:hidden py-6 border-t border-[var(--border-primary)] mt-6">
                        <button 
                            onClick={() => setIsDetailModalOpen(true)}
                            className="inline-flex items-center px-6 py-3 text-sm font-black text-white bg-indigo-600 rounded-xl hover:bg-indigo-700 shadow-lg transition-all active:scale-95 uppercase tracking-wider"
                        >
                            <IconEye className="w-5 h-5 mr-2"/> Ver Detalle de Entregas
                        </button>
                        
                        <button 
                            onClick={handleExportCSV} 
                            disabled={isExporting}
                            className={`inline-flex items-center px-6 py-3 text-sm font-bold text-white bg-green-600 rounded-xl hover:bg-green-700 shadow-lg transition-all disabled:opacity-50 ${isExporting ? 'animate-pulse' : ''}`}
                        >
                            <IconFileSpreadsheet className={`w-5 h-5 mr-2 ${isExporting ? 'animate-spin' : ''}`}/> 
                            {isExporting ? 'Exportando...' : 'Exportar CSV'}
                        </button>
                        
                        <button 
                            onClick={() => {
                                const phone = driverIdProp ? '' : selectedDriver?.phone?.replace(/\D/g, '') || '';
                                const url = `https://api.whatsapp.com/send?${phone ? `phone=${phone}&` : ''}text=${encodeURIComponent(whatsappMessage)}`;
                                
                                // Priority 1: Use native bridge if in Go Delivery App
                                // @ts-ignore
                                if (window.AndroidApp && window.AndroidApp.shareText) {
                                    // @ts-ignore
                                    window.AndroidApp.shareText(whatsappMessage, "Resumen de Pago");
                                } else {
                                    // Priority 2: Use direct location change (Better for WebViews than window.open)
                                    window.location.href = url;
                                }
                            }}
                            className="inline-flex items-center px-6 py-3 text-sm font-bold text-white bg-[#25D366] rounded-xl hover:bg-[#128C7E] shadow-lg transition-all active:scale-95"
                        >
                            <IconWhatsapp className="w-5 h-5 mr-2"/> {driverIdProp ? 'Compartir por WhatsApp' : 'Compartir Resumen'}
                        </button>

                        {!driverIdProp && (
                            <>
                                <a href={`mailto:${selectedDriver.email}?subject=${encodeURIComponent(emailSubject)}&body=${encodeURIComponent(emailBody)}`} className="inline-flex items-center px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 shadow-sm">
                                    <IconMail className="w-5 h-5 mr-2"/> Enviar Correo
                                </a>
                                <button onClick={() => window.print()} className="inline-flex items-center px-4 py-2 text-sm font-medium text-[var(--text-secondary)] bg-[var(--background-secondary)] border border-[var(--border-secondary)] rounded-md hover:bg-[var(--background-hover)] shadow-sm">
                                    <IconPrinter className="w-5 h-5 mr-2"/> Imprimir
                                </button>
                            </>
                        )}
                    </div>
                </div>
            )}
        </div>
        <DriverDeliveryDetailModal 
            isOpen={isDetailModalOpen}
            onClose={() => setIsDetailModalOpen(false)}
            packages={filteredPackages.filter(p => p.status === PackageStatus.Delivered)}
            driverName={selectedDriver?.name || ''}
            startDate={new Date(startDate + 'T00:00:00').toLocaleDateString('es-CL')}
            endDate={new Date(endDate + 'T00:00:00').toLocaleDateString('es-CL')}
        />
        </>
    );
};

export default DriverPerformanceReportPage;
