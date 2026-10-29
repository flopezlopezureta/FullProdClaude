/**
 * Reglas para los paquetes CANCELADOS (cancelados en Mercado Libre, en Falabella o por el administrador).
 *
 * Un paquete cancelado no se entrega, así que no debe asignarse, reasignarse, despacharse ni retirarse a un conductor de reparto: al hacerlo el
 * conductor pierde un viaje, el sistema le avisa al comprador de un envío que él mismo canceló, y el paquete vuelve a figurar "en tránsito".
 * Lo único legítimo es DEVOLVERLO A LA BODEGA. En el sistema la bodega es el conductor "Bodega": un contenedor de asignación, no un conductor
 * (ver routes/users.js y routes/billing.js, que lo identifican por el nombre). Ese movimiento cambia el conductor pero deja el paquete CANCELADO,
 * sin avisar al destinatario ni a Falabella.
 *
 * Sin base de datos ni dependencias: solo reglas y textos, para poder probarlas sueltas.
 */

const CANCELLED_STATUS = 'CANCELADO';
const CANCELLED_CODE = 'PACKAGE_CANCELLED';

const isCancelled = (status) => status === CANCELLED_STATUS;

/** ¿El nombre es el del conductor-contenedor de la bodega ("Bodega")? Misma convención que el resto del sistema: nombre que contiene "bodega". */
const isWarehouseName = (name) => /bodega/i.test(String(name == null ? '' : name));

const MESSAGES = {
    // Lo ve el conductor o el auxiliar en rojo al escanear (igual que "¡PAQUETE DUPLICADO!").
    dispatch: '¡PAQUETE CANCELADO! Este paquete fue cancelado y no se puede despachar a ruta. Sepáralo y devuélvelo a Bodega.',
    assign: 'Este paquete está CANCELADO: no se puede asignar ni reasignar a un conductor de reparto. Para devolverlo a la bodega, asígnalo al conductor «Bodega».',
    unassign: 'Este paquete está CANCELADO: no se puede dejar disponible. Para devolverlo a la bodega, asígnalo al conductor «Bodega».',
    pickup: 'Este paquete está CANCELADO y no se puede retirar.',
    flex: 'Este paquete está CANCELADO: no se puede marcar como Flex ni sacar a ruta.',
    falabellaRescan: (lpn) => `El paquete con LPN ${lpn} está CANCELADO — no se puede redespachar.`,
    alreadyInWarehouse: (name) => `El paquete cancelado ya está en ${name}.`,
    allCancelled: (n) => `${n === 1 ? 'El paquete seleccionado está CANCELADO' : `Los ${n} paquetes seleccionados están CANCELADOS`}: solo se pueden devolver al conductor «Bodega».`,
};

/**
 * Nombre de un usuario por id (null si no existe o no se indicó). Consulta propia a propósito: esta rama es poco frecuente, y así el cambio no depende
 * de los cachés de nombres que tiene routes/packages.js en unos entornos y no en otros (Producción no tenía getCachedDriverName).
 */
async function userName(run, userId) {
    if (!userId) return null;
    const { rows } = await run('SELECT name FROM users WHERE id = $1', [userId]);
    return rows[0] ? rows[0].name : null;
}

/** Texto del evento que queda en el historial de un paquete cancelado cuando vuelve a la bodega. */
const warehouseReturnDetails = (warehouseName, previousDriverName) =>
    `Paquete cancelado devuelto a ${warehouseName}${previousDriverName && !isWarehouseName(previousDriverName) ? ` (lo tenía ${previousDriverName})` : ''}.`;

/**
 * Devuelve un paquete CANCELADO a la bodega: cambia el conductor, NO el estado, y registra el movimiento.
 * Solo toca quién lo tiene (y cuándo): no es una reasignación de reparto, así que no marca "isReassigned" (lo cuenta la facturación como reasignado)
 * ni reabre la alerta del paquete ("alertChecked"), que el operador revisa aparte.
 * `run(text, params)` ejecuta una consulta (db.query o, dentro de una transacción, client.query).
 * Devuelve la fila actualizada, o null si el paquete dejó de estar cancelado entre la lectura y la escritura (nada se modifica).
 */
async function moveCancelledToWarehouse(run, pkgId, warehouse, previousDriverName) {
    const now = new Date();
    const { rows } = await run(
        `UPDATE packages SET "driverId" = $1, "updatedAt" = $2, "assignedAt" = $2
         WHERE id = $3 AND status = 'CANCELADO' RETURNING *`,
        [warehouse.id, now, pkgId]
    );
    if (rows.length === 0) return null;
    await run(
        'INSERT INTO tracking_events ("packageId", status, location, details, timestamp) VALUES ($1, $2, $3, $4, $5)',
        [pkgId, 'RETIRADO', 'Centro de Distribución', warehouseReturnDetails(warehouse.name, previousDriverName), now]
    );
    return rows[0];
}

module.exports = { CANCELLED_STATUS, CANCELLED_CODE, MESSAGES, isCancelled, isWarehouseName, userName, warehouseReturnDetails, moveCancelledToWarehouse };
