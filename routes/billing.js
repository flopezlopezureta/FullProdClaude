const express = require('express');
const router = express.Router();
const db = require('../db');
const authMiddleware = require('../middleware/auth');
const billingInvoices = require('../services/billingInvoices');
const { logAction } = require('../services/logger');

/**
 * GET /api/billing/summary
 * Returns a summary of packages grouped by client and status for a given date range.
 * Restricted to Super Admin.
 */
router.get('/summary', authMiddleware, async (req, res) => {
    // Check if user is Super Admin
    if (req.user.role !== 'ADMIN') {
        return res.status(403).json({ message: 'Acceso denegado. Solo administradores.' });
    }

    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
        return res.status(400).json({ message: 'Se requieren fechas de inicio y fin.' });
    }

    try {
        // We use a query that joins packages with users to get client names
        // We filter by createdAt range and group by client and status
        const query = `
            SELECT 
                u.id as "clientId", 
                u.name as "clientName", 
                u."companyName",
                p.status, 
                COUNT(*) as count
            FROM packages p
            JOIN users u ON p."creatorId" = u.id
            WHERE p."createdAt" >= $1 AND p."createdAt" <= $2
            GROUP BY u.id, u.name, u."companyName", p.status
            ORDER BY u.name ASC;
        `;

        const result = await db.query(query, [startDate + ' 00:00:00', endDate + ' 23:59:59']);
        
        // Transform the flat result into a more usable structure for the frontend
        // Structure: { [clientId]: { clientName, companyName, statuses: { [status]: count }, total } }
        const summary = {};
        
        result.rows.forEach(row => {
            if (!summary[row.clientId]) {
                summary[row.clientId] = {
                    clientId: row.clientId,
                    clientName: row.clientName,
                    companyName: row.companyName,
                    statuses: {},
                    total: 0
                };
            }
            
            summary[row.clientId].statuses[row.status] = parseInt(row.count);
            summary[row.clientId].total += parseInt(row.count);
        });

        res.json(Object.values(summary));
    } catch (err) {
        console.error('Error fetching billing summary:', err);
        res.status(500).json({ message: 'Error interno del servidor.' });
    }
});

const https = require('https');

function getUfValueFromApi(dateStr) {
    return new Promise((resolve, reject) => {
        const url = `https://mindicador.cl/api/uf/${dateStr}`;
        https.get(url, { timeout: 5000 }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.serie && parsed.serie.length > 0) {
                        resolve(parsed.serie[0].valor);
                    } else {
                        resolve(null);
                    }
                } catch (e) {
                    resolve(null);
                }
            });
        }).on('error', (e) => {
            resolve(null);
        });
    });
}

/**
 * GET /api/billing/superadmin-monthly-report
 * Exclusively for ADMIN_SISTEMAS. Returns daily detail of dispatches, costs in UF, and conversions to CLP using the UF value of the 1st day of the next month.
 * Subtracts packages that remained in warehouse (assigned to 'Bodega' driver user).
 * La lógica (rezagados de meses anteriores y meses ya facturados, congelados) vive en services/billingInvoices.js.
 */
router.get('/superadmin-monthly-report', authMiddleware, async (req, res) => {
    try {
        const { rows: userRows } = await db.query('SELECT email FROM users WHERE id = $1', [req.user.id]);
        if (userRows.length === 0 || userRows[0].email !== 'admin') {
            return res.status(403).json({ message: 'Acceso denegado. Exclusivo para el Administrador Principal.' });
        }

        const { clientId, year, month, ufValue } = req.query;

        if (!clientId || !year || !month) {
            return res.status(400).json({ message: 'Se requieren clientId, year y month.' });
        }

        const report = await billingInvoices.buildMonthlyReport(db, { clientId, year, month, ufValue, getUfValue: getUfValueFromApi });
        res.json(report);

    } catch (err) {
        console.error('Error generating superadmin billing report:', err);
        res.status(500).json({ message: 'Error interno al generar el reporte.' });
    }
});

// Mismo chequeo que superadmin-monthly-report arriba (el JWT solo trae id+role, no email, así que
// hay que resolverlo contra la BD) — factorizado acá porque los 4 endpoints de gastos lo repiten.
async function requireSuperAdmin(req, res) {
    const { rows } = await db.query('SELECT email FROM users WHERE id = $1', [req.user.id]);
    if (rows.length === 0 || rows[0].email !== 'admin') {
        res.status(403).json({ message: 'Acceso denegado. Exclusivo para el Administrador Principal.' });
        return false;
    }
    return true;
}

/**
 * Gastos operativos propios de Full Envíos (servidor, Cloudflare, IA, electricidad, etc.) para ver
 * la rentabilidad real del proyecto en el Reporte de Cobro UF, además de lo facturado a clientes.
 * Exclusivo para el Administrador Principal, igual que el resto de este reporte.
 */
router.get('/expenses', authMiddleware, async (req, res) => {
    if (!(await requireSuperAdmin(req, res))) return;
    try {
        const { rows } = await db.query('SELECT * FROM fullenvios_expenses ORDER BY "startYear" DESC, "startMonth" DESC, "createdAt" DESC');
        res.json(rows);
    } catch (err) {
        console.error('Error fetching Full Envíos expenses:', err);
        res.status(500).json({ message: 'Error interno del servidor.' });
    }
});

router.post('/expenses', authMiddleware, async (req, res) => {
    if (!(await requireSuperAdmin(req, res))) return;
    const { concept, totalAmount, installments, startYear, startMonth, notes, isRecurring, endYear, endMonth } = req.body;
    if (!concept || !totalAmount || !startYear || !startMonth) {
        return res.status(400).json({ message: 'Faltan campos requeridos (concepto, monto, año y mes de inicio).' });
    }
    // Un gasto recurrente no usa cuotas (se repite indefinido o hasta endYear/endMonth), así que
    // esa validación solo aplica al modo no-recurrente.
    if (parseFloat(totalAmount) <= 0 || (!isRecurring && parseInt(installments || 1) < 1)) {
        return res.status(400).json({ message: 'El monto debe ser mayor a 0 y las cuotas al menos 1.' });
    }
    try {
        const { rows } = await db.query(
            `INSERT INTO fullenvios_expenses (concept, "totalAmount", installments, "startYear", "startMonth", notes, "isRecurring", "endYear", "endMonth")
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
            [concept, totalAmount, isRecurring ? 1 : (installments || 1), startYear, startMonth, notes || null, !!isRecurring, endYear || null, endMonth || null]
        );
        res.status(201).json(rows[0]);
    } catch (err) {
        console.error('Error creating Full Envíos expense:', err);
        res.status(500).json({ message: 'Error interno del servidor.' });
    }
});

router.put('/expenses/:id', authMiddleware, async (req, res) => {
    if (!(await requireSuperAdmin(req, res))) return;
    const { concept, totalAmount, installments, startYear, startMonth, notes, isRecurring, endYear, endMonth } = req.body;
    if (!concept || !totalAmount || !startYear || !startMonth) {
        return res.status(400).json({ message: 'Faltan campos requeridos (concepto, monto, año y mes de inicio).' });
    }
    if (parseFloat(totalAmount) <= 0 || (!isRecurring && parseInt(installments || 1) < 1)) {
        return res.status(400).json({ message: 'El monto debe ser mayor a 0 y las cuotas al menos 1.' });
    }
    try {
        const { rows } = await db.query(
            `UPDATE fullenvios_expenses SET concept = $1, "totalAmount" = $2, installments = $3, "startYear" = $4, "startMonth" = $5, notes = $6, "isRecurring" = $7, "endYear" = $8, "endMonth" = $9, "updatedAt" = NOW()
             WHERE id = $10 RETURNING *`,
            [concept, totalAmount, isRecurring ? 1 : (installments || 1), startYear, startMonth, notes || null, !!isRecurring, endYear || null, endMonth || null, req.params.id]
        );
        if (rows.length === 0) return res.status(404).json({ message: 'Gasto no encontrado.' });
        res.json(rows[0]);
    } catch (err) {
        console.error('Error updating Full Envíos expense:', err);
        res.status(500).json({ message: 'Error interno del servidor.' });
    }
});

router.delete('/expenses/:id', authMiddleware, async (req, res) => {
    if (!(await requireSuperAdmin(req, res))) return;
    try {
        const { rows } = await db.query('DELETE FROM fullenvios_expenses WHERE id = $1 RETURNING id', [req.params.id]);
        if (rows.length === 0) return res.status(404).json({ message: 'Gasto no encontrado.' });
        res.json({ message: 'Gasto eliminado.' });
    } catch (err) {
        console.error('Error deleting Full Envíos expense:', err);
        res.status(500).json({ message: 'Error interno del servidor.' });
    }
});

/**
 * Facturas del Reporte de Cobro UF (exclusivo del Administrador Principal). Ver services/billingInvoices.js.
 *   GET  /api/billing/invoices            → facturas registradas (vigentes y anuladas)
 *   POST /api/billing/invoices            → factura el mes pedido (guarda los valores y marca los envíos cobrados)
 *   POST /api/billing/invoices/:id/void   → anula la ÚLTIMA factura registrada
 */
async function loadSuperAdmin(req, res) {
    const { rows } = await db.query('SELECT email, name FROM users WHERE id = $1', [req.user.id]);
    if (rows.length === 0 || rows[0].email !== 'admin') {
        res.status(403).json({ message: 'Acceso denegado. Exclusivo para el Administrador Principal.' });
        return null;
    }
    return { id: req.user.id, name: rows[0].name || 'Administrador' };
}

function sendBillingError(res, err, fallback) {
    if (err instanceof billingInvoices.BillingError) {
        return res.status(err.status).json({ message: err.message, ...(err.extra || {}) });
    }
    console.error(fallback, err);
    return res.status(500).json({ message: 'Error interno del servidor.' });
}

router.get('/invoices', authMiddleware, async (req, res) => {
    try {
        if (!(await loadSuperAdmin(req, res))) return;
        let invoices = [];
        try { invoices = await billingInvoices.listInvoices(db); } catch (err) { if (!err || err.code !== '42P01') throw err; }
        res.json(invoices);
    } catch (err) {
        sendBillingError(res, err, 'Error listing billing invoices:');
    }
});

router.post('/invoices', authMiddleware, async (req, res) => {
    let client;
    try {
        const admin = await loadSuperAdmin(req, res);
        if (!admin) return;
        client = await db.getClient();
        const invoice = await billingInvoices.createInvoice(client, req.body || {}, { userId: admin.id, userName: admin.name });
        await logAction(admin.id, admin.name, 'BILLING_INVOICE_CREATED', {
            invoiceId: invoice.id, period: `${invoice.year}-${String(invoice.month).padStart(2, '0')}`, packages: invoice.packagesCount, carryOver: invoice.packagesCarryOver,
            ufValue: invoice.ufValue, totalGrossClp: invoice.totalGrossClp, documentNumber: invoice.documentNumber,
        });
        res.status(201).json(invoice);
    } catch (err) {
        sendBillingError(res, err, 'Error creating billing invoice:');
    } finally {
        if (client) client.release();
    }
});

router.post('/invoices/:id/void', authMiddleware, async (req, res) => {
    let client;
    try {
        const admin = await loadSuperAdmin(req, res);
        if (!admin) return;
        client = await db.getClient();
        const result = await billingInvoices.voidInvoice(client, req.params.id, { reason: (req.body || {}).reason, userId: admin.id, userName: admin.name });
        await logAction(admin.id, admin.name, 'BILLING_INVOICE_VOIDED', { invoiceId: req.params.id, reason: String((req.body || {}).reason || '').trim(), releasedPackages: result.releasedPackages });
        res.json(result);
    } catch (err) {
        sendBillingError(res, err, 'Error voiding billing invoice:');
    } finally {
        if (client) client.release();
    }
});

module.exports = router;
