
import ExcelJS from 'exceljs';
import { Package, User } from '../types';
import { PackageStatus } from '../constants';

const mapStatus = (status: PackageStatus): string => {
    switch (status) {
        case PackageStatus.Pending: return 'PENDIENTE';
        case PackageStatus.PickedUp: return 'PICKEADO';
        case PackageStatus.InTransit: return 'EN RUTA';
        case PackageStatus.Delivered: return 'ENTREGADO';
        case PackageStatus.Delayed: return 'RETRASADO';
        case PackageStatus.Problem: return 'PROBLEMA';
        case PackageStatus.ReturnPending: return 'PEND. DEVOLUCION';
        case PackageStatus.Returned: return 'DEVUELTO';
        case PackageStatus.Cancelled: return 'CANCELADO';
        case PackageStatus.Rescheduled: return 'REPROGRAMADO';
        case PackageStatus.Assigned: return 'ASIGNADO';
        default: return status;
    }
};

export const exportToExcel = async (packages: Package[], filename: string, users: User[] = [], timeFormat: '12h' | '24h' = '12h') => {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('BASE');

    const userMap = new Map(users.map(u => [u.id, u.name]));
    const clientIdMap = new Map(users.map(u => [u.id, u.clientIdentifier || u.name.substring(0, 4).toUpperCase()]));

    // Define columns
    worksheet.columns = [
        { header: 'ID PAQUETE', key: 'idPaquete', width: 25 },
        { header: 'PEDIDO', key: 'pedido', width: 15 },
        { header: 'CLIENTE', key: 'sellerName', width: 20 },
        { header: 'ID_CLIENTE', key: 'sellerId', width: 15 },
        { header: 'FECHA DE PEDIDO', key: 'fecha', width: 25 },
        { header: 'DESTINATARIO', key: 'destinatario', width: 25 },
        { header: 'TELEFONO', key: 'telefono', width: 15 },
        { header: 'DIRECCION', key: 'direccion', width: 35 },
        { header: 'COMUNA', key: 'comuna', width: 20 },
        { header: 'CORREO', key: 'correo', width: 25 },
        { header: 'ESTADO_PICK', key: 'estado', width: 15 },
        { header: 'BULTOS', key: 'bultos', width: 10 },
        { header: 'FECHA DE EGRESO', key: 'fechaEgreso', width: 25 },
        { header: 'CONDUCTOR', key: 'conductor', width: 20 },
    ];

    // Add rows
    packages.forEach(pkg => {
        worksheet.addRow({
            idPaquete: pkg.id,
            pedido: pkg.meliOrderId || pkg.shopifyOrderId || pkg.wooOrderId || pkg.jumpsellerOrderId || pkg.id,
            // pkg.clientName (computed backend-side, routes/packages.js) is authoritative when
            // present — for Falabella Directo packages, creatorId is whoever scanned the label
            // (driver or auxiliar), not the real seller, so resolving the name from creatorId here
            // showed the scanner's name on exports clients actually receive (real report 2026-09-30).
            sellerName: pkg.clientName || (pkg.creatorId ? (userMap.get(pkg.creatorId) || 'No encontrado') : 'N/A'),
            sellerId: pkg.clientName ? '' : (pkg.creatorId ? (clientIdMap.get(pkg.creatorId) || 'N/A') : 'N/A'),
            fecha: new Date(
                (pkg.status === PackageStatus.Delivered || pkg.status === PackageStatus.Returned) 
                ? pkg.updatedAt 
                : pkg.createdAt
            ).toLocaleString('es-CL', { hour12: timeFormat === '12h' }).replace(/\//g, '-'),
            destinatario: pkg.recipientName,
            telefono: pkg.recipientPhone,
            direccion: pkg.recipientAddress,
            comuna: pkg.recipientCommune,
            correo: '',
            estado: mapStatus(pkg.status),
            bultos: 1,
            fechaEgreso: pkg.assignedAt ? new Date(pkg.assignedAt).toLocaleString('es-CL', { hour12: timeFormat === '12h' }).replace(/\//g, '-') : 'Pendiente',
            conductor: pkg.driverId ? (userMap.get(pkg.driverId) || 'No encontrado') : 'No asignado'
        });
    });

    // Style header
    const headerRow = worksheet.getRow(1);
    headerRow.height = 25;
    headerRow.eachCell((cell) => {
        cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FF4472C4' } // Blue from image
        };
        cell.font = {
            color: { argb: 'FFFFFFFF' }, // White
            bold: true,
            size: 11
        };
        cell.alignment = { vertical: 'middle', horizontal: 'center' };
        cell.border = {
            top: { style: 'thin', color: { argb: 'FF000000' } },
            left: { style: 'thin', color: { argb: 'FF000000' } },
            bottom: { style: 'thin', color: { argb: 'FF000000' } },
            right: { style: 'thin', color: { argb: 'FF000000' } }
        };
    });

    // Style rows (zebra stripes and borders)
    worksheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;
        row.height = 20;
        row.eachCell((cell) => {
            cell.border = {
                top: { style: 'thin', color: { argb: 'FF000000' } },
                left: { style: 'thin', color: { argb: 'FF000000' } },
                bottom: { style: 'thin', color: { argb: 'FF000000' } },
                right: { style: 'thin', color: { argb: 'FF000000' } }
            };
            cell.alignment = { vertical: 'middle', horizontal: 'left' };
            if (rowNumber % 2 === 0) {
                cell.fill = {
                    type: 'pattern',
                    pattern: 'solid',
                    fgColor: { argb: 'FFD9E1F2' } // Light blue from image
                };
            }
        });
    });

    // Add second sheet
    workbook.addWorksheet('RESUMEN_PICKING');

    // Generate and download
    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = window.URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    window.URL.revokeObjectURL(url);
};

export const exportToCSV = (packages: Package[], filename: string, users: User[] = []) => {
    const userMap = new Map(users.map(u => [u.id, u.name]));
    const clientIdMap = new Map(users.map(u => [u.id, u.clientIdentifier || u.name.substring(0, 4).toUpperCase()]));
    const headers = [
        'ID Paquete',
        'Pedido',
        'Cliente',
        'ID Cliente',
        'Fecha Creación',
        'Estado',
        'Destinatario',
        'Dirección',
        'Comuna',
        'Ciudad',
        'Tipo Envío',
        'Fecha de Egreso',
        'Conductor'
    ];

    const escapeCSV = (val: any) => {
        const str = String(val || '').replace(/"/g, '""');
        return `"${str}"`;
    };

    const rows = packages.map(pkg => [
        pkg.id,
        pkg.meliOrderId || pkg.shopifyOrderId || pkg.wooOrderId || pkg.jumpsellerOrderId || pkg.id,
        // Same override as exportToExcel above — pkg.clientName is authoritative when present.
        pkg.clientName || (pkg.creatorId ? (userMap.get(pkg.creatorId) || 'No encontrado') : 'N/A'),
        pkg.clientName ? '' : (pkg.creatorId ? (clientIdMap.get(pkg.creatorId) || 'N/A') : 'N/A'),
        new Date(pkg.createdAt).toLocaleString('es-CL'),
        (pkg.status || '').replace('_', ' '),
        pkg.recipientName,
        pkg.recipientAddress,
        pkg.recipientCommune,
        pkg.recipientCity,
        pkg.shippingType,
        pkg.assignedAt ? new Date(pkg.assignedAt).toLocaleString('es-CL') : 'Pendiente',
        pkg.driverId ? (userMap.get(pkg.driverId) || 'No encontrado') : 'No asignado'
    ].map(escapeCSV).join(','));

    const csvContent = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([`\uFEFF${csvContent}`], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", filename);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
};

export const exportSuperAdminBillingToExcel = async (reportData: any, filename: string) => {
    const workbook = new ExcelJS.Workbook();
    
    // 1. Cover summary sheet: "Resumen General"
    const summarySheet = workbook.addWorksheet('Resumen General');
    summarySheet.views = [{ showGridLines: true }];
    
    // Add Client Info & Summary block
    summarySheet.addRow([]);
    const titleRow = summarySheet.addRow(['', 'REPORTE DE COBRO MENSUAL UF']);
    titleRow.getCell(2).font = { size: 16, bold: true, color: { argb: 'FF1F497D' } };
    summarySheet.addRow([]);
    
    // Client Metadata
    summarySheet.addRow(['', 'Cliente:', reportData.client.companyName || reportData.client.name]);
    summarySheet.addRow(['', 'Período:', `${reportData.period.month}/${reportData.period.year}`]);
    summarySheet.addRow(['', 'UF de Referencia:', reportData.uf.value]);
    summarySheet.addRow(['', 'Fecha UF:', reportData.uf.date]);
    summarySheet.addRow(['', 'Fuente UF:', reportData.uf.source]);
    summarySheet.addRow([]);

    // Style Metadata labels
    for (let r = 4; r <= 8; r++) {
        const row = summarySheet.getRow(r);
        row.getCell(2).font = { bold: true };
        row.getCell(3).alignment = { horizontal: 'left' };
    }

    // Financial summary table headers
    const financeHeaderRow = summarySheet.addRow(['', 'Detalle Factura', 'Valor CLP', 'Valor UF']);
    financeHeaderRow.height = 24;
    financeHeaderRow.eachCell((cell, colNum) => {
        if (colNum < 2) return;
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F497D' } };
        cell.font = { color: { argb: 'FFFFFFFF' }, bold: true };
        cell.border = { bottom: { style: 'medium' } };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
    });

    // Add financial lines
    const rowNet = summarySheet.addRow(['', 'Total Costo Neto Despachado', reportData.summary.totalCostClpNet || 0, reportData.summary.totalCostUf]);
    rowNet.getCell(3).numFmt = '$#,##0';
    rowNet.getCell(4).numFmt = '0.00000000';
    
    const rowIva = summarySheet.addRow(['', 'IVA Despachos (19%)', reportData.summary.totalCostClpIva || 0, '']);
    rowIva.getCell(3).numFmt = '$#,##0';
    
    const rowGross = summarySheet.addRow(['', 'Total Bruto Despachos CLP', reportData.summary.totalCostClpGross || 0, '']);
    rowGross.getCell(3).numFmt = '$#,##0';
    rowGross.getCell(2).font = { bold: true };
    rowGross.getCell(3).font = { bold: true };

    // Format financial cells directly
    [rowNet, rowIva, rowGross].forEach(row => {
        row.getCell(2).border = { bottom: { style: 'thin' } };
        row.getCell(3).border = { bottom: { style: 'thin' } };
        row.getCell(3).alignment = { horizontal: 'right' };
        row.getCell(4).alignment = { horizontal: 'right' };
    });

    // License Billing Section
    if (reportData.licenseBilling) {
        summarySheet.addRow([]);
        const licenseHeaderRow = summarySheet.addRow(['', 'Detalle de Facturación por Licencias (Exceso)', 'Valor CLP', 'Valor UF']);
        licenseHeaderRow.height = 24;
        licenseHeaderRow.eachCell((cell, colNum) => {
            if (colNum < 2) return;
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF5B9BD5' } };
            cell.font = { color: { argb: 'FFFFFFFF' }, bold: true };
            cell.alignment = { horizontal: 'center', vertical: 'middle' };
        });

        summarySheet.addRow(['', `Licencias Ocupadas (Total): ${reportData.licenseBilling.active} / Límite: ${reportData.licenseBilling.limit}`, '', '']);
        
        const rowLicNet = summarySheet.addRow(['', `Costo Neto Licencias en Exceso (${reportData.licenseBilling.excess} * ${reportData.licenseBilling.overageFee} UF)`, reportData.licenseBilling.costClpNet, reportData.licenseBilling.costUf]);
        rowLicNet.getCell(3).numFmt = '$#,##0';
        rowLicNet.getCell(4).numFmt = '0.00000000';

        const rowLicIva = summarySheet.addRow(['', 'IVA Licencias (19%)', reportData.licenseBilling.costClpIva, '']);
        rowLicIva.getCell(3).numFmt = '$#,##0';

        const rowLicGross = summarySheet.addRow(['', 'Total Bruto Licencias CLP', reportData.licenseBilling.costClpGross, '']);
        rowLicGross.getCell(3).numFmt = '$#,##0';
        rowLicGross.getCell(2).font = { bold: true };
        rowLicGross.getCell(3).font = { bold: true };

        [rowLicNet, rowLicIva, rowLicGross].forEach(row => {
            row.getCell(2).border = { bottom: { style: 'thin' } };
            row.getCell(3).border = { bottom: { style: 'thin' } };
            row.getCell(3).alignment = { horizontal: 'right' };
            row.getCell(4).alignment = { horizontal: 'right' };
        });

        // Combined Totals Section
        summarySheet.addRow([]);
        const combHeaderRow = summarySheet.addRow(['', 'TOTAL FACTURACIÓN COMBINADA (DESPACHOS + LICENCIAS)', 'Valor CLP', 'Valor UF']);
        combHeaderRow.height = 24;
        combHeaderRow.eachCell((cell, colNum) => {
            if (colNum < 2) return;
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF70AD47' } }; // Green accent
            cell.font = { color: { argb: 'FFFFFFFF' }, bold: true };
            cell.alignment = { horizontal: 'center', vertical: 'middle' };
        });

        const totalNetComb = (reportData.summary.totalCostClpNet || 0) + reportData.licenseBilling.costClpNet;
        const totalUfComb = reportData.summary.totalCostUf + reportData.licenseBilling.costUf;
        const rowCombNet = summarySheet.addRow(['', 'Total Neto Combinado', totalNetComb, totalUfComb]);
        rowCombNet.getCell(3).numFmt = '$#,##0';
        rowCombNet.getCell(4).numFmt = '0.00000000';

        const totalIvaComb = (reportData.summary.totalCostClpIva || 0) + reportData.licenseBilling.costClpIva;
        const rowCombIva = summarySheet.addRow(['', 'Total IVA Combinado (19%)', totalIvaComb, '']);
        rowCombIva.getCell(3).numFmt = '$#,##0';

        const totalGrossComb = (reportData.summary.totalCostClpGross || 0) + reportData.licenseBilling.costClpGross;
        const rowCombGross = summarySheet.addRow(['', 'Total Bruto Combinado CLP', totalGrossComb, '']);
        rowCombGross.getCell(3).numFmt = '$#,##0';
        rowCombGross.getCell(2).font = { bold: true };
        rowCombGross.getCell(3).font = { bold: true };

        [rowCombNet, rowCombIva, rowCombGross].forEach(row => {
            row.getCell(2).border = { bottom: { style: 'thin' } };
            row.getCell(3).border = { bottom: { style: 'thin' } };
            row.getCell(3).alignment = { horizontal: 'right' };
            row.getCell(4).alignment = { horizontal: 'right' };
        });
    }
    summarySheet.addRow([]);
    summarySheet.addRow([]);

    // Add daily breakdown table headers
    const dailyHeaderRow = summarySheet.addRow(['', 'Fecha', 'Ingresados', 'Sin Procesar', 'Reasignados', 'Cobrados (Despachados)', 'Costo UF', 'Costo Neto CLP']);
    dailyHeaderRow.height = 24;
    dailyHeaderRow.eachCell((cell, colNum) => {
        if (colNum < 2) return;
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4F81BD' } };
        cell.font = { color: { argb: 'FFFFFFFF' }, bold: true };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
    });

    // Add daily details rows
    reportData.dailyDetails.forEach((day: any) => {
        const row = summarySheet.addRow([
            '',
            day.date,
            day.totalCreated,
            day.assignedToBodega,
            day.reassignedCount || 0,
            day.packagesCount,
            day.costUf,
            day.costClp || 0
        ]);
        row.getCell(2).alignment = { horizontal: 'center' };
        row.getCell(3).alignment = { horizontal: 'center' };
        row.getCell(4).alignment = { horizontal: 'center' };
        row.getCell(5).alignment = { horizontal: 'center' };
        row.getCell(6).alignment = { horizontal: 'center' };
        row.getCell(7).alignment = { horizontal: 'right' };
        row.getCell(8).alignment = { horizontal: 'right' };
        row.getCell(7).numFmt = '0.00000000';
        row.getCell(8).numFmt = '$#,##0';
    });

    // Add total daily details row
    const totalRow = summarySheet.addRow([
        '',
        'Total General',
        reportData.summary.totalCreated,
        reportData.summary.totalAssignedToBodega,
        reportData.summary.totalReassigned || 0,
        reportData.summary.totalPackages,
        reportData.summary.totalCostUf,
        reportData.summary.totalCostClpNet || 0
    ]);
    totalRow.eachCell((cell, colNum) => {
        if (colNum < 2) return;
        cell.font = { bold: true };
        cell.border = { top: { style: 'thin' }, bottom: { style: 'double' } };
    });
    totalRow.getCell(2).alignment = { horizontal: 'center' };
    totalRow.getCell(3).alignment = { horizontal: 'center' };
    totalRow.getCell(4).alignment = { horizontal: 'center' };
    totalRow.getCell(5).alignment = { horizontal: 'center' };
    totalRow.getCell(6).alignment = { horizontal: 'center' };
    totalRow.getCell(7).alignment = { horizontal: 'right' };
    totalRow.getCell(8).alignment = { horizontal: 'right' };
    totalRow.getCell(7).numFmt = '0.00000000';
    totalRow.getCell(8).numFmt = '$#,##0';

    // Set widths for Summary Sheet columns
    summarySheet.getColumn(1).width = 4;
    summarySheet.getColumn(2).width = 25;
    summarySheet.getColumn(3).width = 20;
    summarySheet.getColumn(4).width = 18;
    summarySheet.getColumn(5).width = 18; // Reasignados
    summarySheet.getColumn(6).width = 25; // Cobrados
    summarySheet.getColumn(7).width = 18; // Costo UF
    summarySheet.getColumn(8).width = 20; // Costo Neto CLP

    // 2. Daily detail sheets
    // Group package details by date
    const packagesByDate: { [date: string]: any[] } = {};
    if (reportData.packagesDetail && Array.isArray(reportData.packagesDetail)) {
        reportData.packagesDetail.forEach((pkg: any) => {
            if (!packagesByDate[pkg.date]) {
                packagesByDate[pkg.date] = [];
            }
            packagesByDate[pkg.date].push(pkg);
        });
    }

    // Sort dates ascending
    const dates = Object.keys(packagesByDate).sort();

    // Create a sheet for each date
    dates.forEach(dateStr => {
        const datePkgs = packagesByDate[dateStr];
        const chargedPkgs = datePkgs.filter(p => p.isCharged);
        const unchargedPkgs = datePkgs.filter(p => !p.isCharged);

        // Sheet name is just the date (e.g. 2026-07-01), which is 10 chars
        const sheet = workbook.addWorksheet(dateStr);
        sheet.views = [{ showGridLines: true }];

        // Style helper for columns
        const setupColumns = (s: any) => {
            s.getColumn(1).width = 5;   // #
            s.getColumn(2).width = 20;  // ID Paquete
            s.getColumn(3).width = 15;  // Pedido
            s.getColumn(4).width = 18;  // Tracking
            s.getColumn(5).width = 25;  // Destinatario
            s.getColumn(6).width = 15;  // Teléfono (Added/Fixed)
            s.getColumn(7).width = 30;  // Dirección
            s.getColumn(8).width = 15;  // Comuna
            s.getColumn(9).width = 18;  // Conductor
            s.getColumn(10).width = 12; // Reasignado (Added)
            s.getColumn(11).width = 12; // Estado
            s.getColumn(12).width = 18; // Creación
            s.getColumn(13).width = 18; // Asignación
            s.getColumn(14).width = 18; // Entrega
            s.getColumn(15).width = 12; // Tarifa UF
            s.getColumn(16).width = 12; // Tarifa CLP
            s.getColumn(17).width = 25; // Motivo Exclusión (Table 2 only)
        };
        setupColumns(sheet);

        // Date Title at the top
        const pageTitleRow = sheet.addRow([`DETALLE DE ENVÍOS - DÍA: ${dateStr}`]);
        pageTitleRow.getCell(1).font = { size: 14, bold: true, color: { argb: 'FF1F497D' } };
        sheet.addRow([]);

        // Table 1: Charged Packages
        const section1Row = sheet.addRow(['1. DETALLE DE ENVÍOS COBRADOS (FACTURABLES)']);
        section1Row.getCell(1).font = { bold: true, size: 11, color: { argb: 'FF2E75B6' } };

        const headerRow1 = sheet.addRow([
            '#', 'ID Paquete', 'Nº Pedido', 'Código Seguimiento', 'Destinatario', 'Teléfono', 'Dirección', 'Comuna', 
            'Conductor', 'Reasignado', 'Estado', 'Fecha Creación', 'Fecha Asignación', 'Fecha Entrega', 'Tarifa (UF)', 'Valor (CLP)'
        ]);
        headerRow1.height = 24;
        headerRow1.eachCell((cell) => {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } }; // Soft blue
            cell.font = { bold: true, size: 9, color: { argb: 'FF1F497D' } };
            cell.alignment = { horizontal: 'center', vertical: 'middle' };
            cell.border = { top: { style: 'thin' }, bottom: { style: 'medium' } };
        });

        let idx1 = 1;
        chargedPkgs.forEach(pkg => {
            const rowValUf = reportData.summary.ratePerPackageUf;
            const rowValClp = reportData.uf.value ? rowValUf * reportData.uf.value : 0;
            const row = sheet.addRow([
                idx1++,
                pkg.id,
                pkg.orderId,
                pkg.trackingId || '',
                pkg.recipientName,
                pkg.recipientPhone || '',
                pkg.recipientAddress,
                pkg.recipientCommune,
                pkg.driverName || 'No asignado',
                pkg.isReassigned ? 'Sí' : 'No',
                pkg.status,
                pkg.createdAt || '',
                pkg.assignedAt || '',
                pkg.updatedAt || '',
                rowValUf,
                Math.round(rowValClp)
            ]);
            row.eachCell((cell, colNum) => {
                cell.font = { size: 9 };
                cell.border = { bottom: { style: 'thin', color: { argb: 'FFE0E0E0' } } };
                if (colNum <= 4 || colNum === 6 || colNum === 8 || colNum === 10 || colNum === 11 || colNum >= 12) {
                    cell.alignment = { horizontal: 'center' };
                }
            });
            row.getCell(15).numFmt = '0.00000000';
            row.getCell(16).numFmt = '$#,##0';
        });

        // Add summary row for Charged Packages
        const sumRow1 = sheet.addRow([
            'TOTAL COBRADOS', '', '', '', '', '', '', '', '', '', '', '', '', '',
            `=${reportData.summary.ratePerPackageUf}*${chargedPkgs.length}`,
            `=${Math.round(reportData.uf.value ? reportData.summary.ratePerPackageUf * reportData.uf.value : 0)}*${chargedPkgs.length}`
        ]);
        sumRow1.getCell(1).font = { bold: true };
        sumRow1.getCell(15).font = { bold: true };
        sumRow1.getCell(16).font = { bold: true };
        sumRow1.getCell(15).numFmt = '0.00000000';
        sumRow1.getCell(16).numFmt = '$#,##0';
        sumRow1.getCell(1).border = { top: { style: 'thin' }, bottom: { style: 'medium' } };
        sumRow1.getCell(15).border = { top: { style: 'thin' }, bottom: { style: 'medium' } };
        sumRow1.getCell(16).border = { top: { style: 'thin' }, bottom: { style: 'medium' } };

        sheet.addRow([]);
        sheet.addRow([]);

        // Table 2: Uncharged Packages
        const section2Row = sheet.addRow(['2. DETALLE DE ENVÍOS NO COBRADOS (EXCLUIDOS)']);
        section2Row.getCell(1).font = { bold: true, size: 11, color: { argb: 'FFC00000' } };

        const headerRow2 = sheet.addRow([
            '#', 'ID Paquete', 'Nº Pedido', 'Código Seguimiento', 'Destinatario', 'Teléfono', 'Dirección', 'Comuna', 
            'Conductor', 'Reasignado', 'Estado', 'Fecha Creación', 'Fecha Asignación', 'Fecha Entrega', 'Tarifa (UF)', 'Valor (CLP)', 'Motivo Exclusión'
        ]);
        headerRow2.height = 24;
        headerRow2.eachCell((cell) => {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFCE4D6' } }; // Soft peach/red
            cell.font = { bold: true, size: 9, color: { argb: 'FFC00000' } };
            cell.alignment = { horizontal: 'center', vertical: 'middle' };
            cell.border = { top: { style: 'thin' }, bottom: { style: 'medium' } };
        });

        let idx2 = 1;
        unchargedPkgs.forEach(pkg => {
            const row = sheet.addRow([
                idx2++,
                pkg.id,
                pkg.orderId,
                pkg.trackingId || '',
                pkg.recipientName,
                pkg.recipientPhone || '',
                pkg.recipientAddress,
                pkg.recipientCommune,
                pkg.driverName || 'No asignado',
                pkg.isReassigned ? 'Sí' : 'No',
                pkg.status,
                pkg.createdAt || '',
                pkg.assignedAt || '',
                pkg.updatedAt || '',
                0.0,
                0,
                pkg.exclusionReason || 'Otro'
            ]);
            row.eachCell((cell, colNum) => {
                cell.font = { size: 9 };
                cell.border = { bottom: { style: 'thin', color: { argb: 'FFE0E0E0' } } };
                if (colNum <= 4 || colNum === 6 || colNum === 8 || colNum === 10 || colNum === 11 || colNum >= 12) {
                    cell.alignment = { horizontal: 'center' };
                }
            });
            row.getCell(15).numFmt = '0.00000000';
            row.getCell(16).numFmt = '$#,##0';
            row.getCell(17).font = { italic: true, bold: true, color: { argb: 'FFC00000' } };
        });

        // Add summary row for Uncharged Packages
        const sumRow2 = sheet.addRow([
            'TOTAL EXCLUIDOS', '', '', '', '', '', '', '', '', '', '', '', '', '', 0.0, 0, ''
        ]);
        sumRow2.getCell(1).font = { bold: true };
        sumRow2.getCell(15).font = { bold: true };
        sumRow2.getCell(16).font = { bold: true };
        sumRow2.getCell(15).numFmt = '0.00000000';
        sumRow2.getCell(16).numFmt = '$#,##0';
        sumRow2.getCell(1).border = { top: { style: 'thin' }, bottom: { style: 'medium' } };
        sumRow2.getCell(15).border = { top: { style: 'thin' }, bottom: { style: 'medium' } };
        sumRow2.getCell(16).border = { top: { style: 'thin' }, bottom: { style: 'medium' } };
    });

    // Generate and download
    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = window.URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    window.URL.revokeObjectURL(url);
};
