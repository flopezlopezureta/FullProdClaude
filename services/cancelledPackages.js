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

/**
 * Estado en que queda un paquete cuando un conductor reporta un problema, según el motivo que eligió o escribió:
 *   «reagendar» / «reprogramar»  → REPROGRAMADO
 *   «cancel…»                    → CANCELADO  (salvo en Mercado Libre, ver abajo)
 *   cualquier otro               → PROBLEMA
 *
 * En Mercado Libre la cancelación la decide Mercado Libre, no lo que el cliente le diga al conductor en la puerta («cancelé», «hoy no»): el envío sigue
 * vivo, el comprador puede reprogramar desde su app y el paquete se entrega días después (en 60 días, 8 de 30 reportes «Cliente canceló el pedido» terminaron
 * entregados). Marcarlo CANCELADO lo cerraba, y un CANCELADO no vuelve a ruta (ver arriba). Por eso aquí queda PROBLEMA —abierto, reasignable—; cuando Mercado
 * Libre cancela de verdad, el sondeo de estados lo pasa a CANCELADO solo. En el resto de los orígenes (manual, tiendas) no hay otra fuente de verdad: se mantiene.
 * Igual que antes, un motivo que no sea texto falla (el llamador lo informa como error), en vez de crear un problema «undefined».
 */
const problemTargetStatus = (reason, source) => {
    const text = reason.toLowerCase();
    if (text.includes('reagendar') || text.includes('reprogramar')) return 'REPROGRAMADO';
    if (text.includes('cancel')) return source === 'MERCADO_LIBRE' ? 'PROBLEMA' : CANCELLED_STATUS;
    return 'PROBLEMA';
};

/** Estados de un envío de Mercado Libre en los que SIGUE VIVO y se puede entregar. Entregado, cancelado, no entregado/devuelto o no encontrado no cuentan. */
const ML_OPEN_STATUSES = Object.freeze(['pending', 'handling', 'ready_to_ship', 'shipped']);
const isOpenInMeli = (mlStatus) => ML_OPEN_STATUSES.includes(mlStatus);

/**
 * Condición SQL (sobre la tabla `packages`, sin alias) de los paquetes que un CONDUCTOR dejó CANCELADOS en Mercado Libre y que vale la pena volver a mirar allá:
 *   - origen Mercado Libre, sin facturar, tocados en los últimos 14 días;
 *   - hay un reporte de problema del conductor con «cancel» en el motivo (así llegaron a CANCELADO);
 *   - ni Mercado Libre confirmó la cancelación (evento «Cancelado» del sondeo) ni ya se reabrió una vez (evento «Reabierto:…»): se reabre a lo más UNA vez, para que
 *     una cancelación que el equipo decida después a mano no se deshaga sola en bucle.
 * Los CANCELADOS por el administrador o por Mercado Libre no cumplen la condición: no tienen el reporte del conductor / sí tienen el evento «Cancelado».
 */
const DRIVER_CANCEL_CANDIDATE_SQL = `(packages.status = 'CANCELADO' AND packages.source = 'MERCADO_LIBRE' AND packages.billed IS NOT TRUE
    AND packages."updatedAt" >= now() - interval '14 days'
    AND EXISTS (SELECT 1 FROM tracking_events d WHERE d."packageId" = packages.id AND d.status = 'PROBLEMA' AND d.details ILIKE '%cancel%')
    AND NOT EXISTS (SELECT 1 FROM tracking_events c WHERE c."packageId" = packages.id AND (c.status IN ('Cancelado', 'CANCELADO') OR (c.status = 'COMENTARIO' AND c.details LIKE 'Reabierto:%'))))`;

/** Texto del evento (interno: «COMENTARIO» no se publica en el seguimiento del comprador) que explica por qué un CANCELADO volvió a estar abierto. */
const reviveDetails = (ml) =>
    `Reabierto: Mercado Libre mantiene este envío activo (${ml.status}${ml.substatus ? '/' + ml.substatus : ''}) y no lo canceló. El estado CANCELADO venía de un reporte del conductor; el paquete vuelve a quedar disponible para asignar.`;

/**
 * Reabre (CANCELADO → PROBLEMA) un paquete que un conductor dejó cancelado mientras Mercado Libre sigue mostrando su envío vivo. `ml` = { status, substatus } del envío
 * en Mercado Libre, recién consultado. La condición se vuelve a comprobar dentro del UPDATE (DRIVER_CANCEL_CANDIDATE_SQL), así que no pisa un cambio hecho entre la
 * lectura y la escritura. No cambia conductor ni fechas de asignación, no avisa al comprador y no toca los facturados.
 * `run(text, params)` ejecuta una consulta (db.query o, dentro de una transacción, client.query). Devuelve la fila reabierta, o null si no correspondía.
 */
async function reviveIfOpenInMeli(run, pkgId, ml) {
    if (!ml || !isOpenInMeli(ml.status)) return null;
    const now = new Date();
    // Una sola sentencia: el cambio de estado y su evento se guardan juntos o no se guarda nada.
    const { rows } = await run(
        `WITH reopened AS (
             UPDATE packages SET status = 'PROBLEMA', "updatedAt" = $1 WHERE id = $2 AND ${DRIVER_CANCEL_CANDIDATE_SQL} RETURNING *
         ), logged AS (
             INSERT INTO tracking_events ("packageId", status, location, details, timestamp) SELECT id, 'COMENTARIO', 'Sistema', $3, $1 FROM reopened
         )
         SELECT * FROM reopened`,
        [now, pkgId, reviveDetails(ml)]
    );
    return rows.length > 0 ? rows[0] : null;
}

module.exports = {
    CANCELLED_STATUS, CANCELLED_CODE, MESSAGES, isCancelled, isWarehouseName, userName, warehouseReturnDetails, moveCancelledToWarehouse,
    problemTargetStatus, ML_OPEN_STATUSES, isOpenInMeli, DRIVER_CANCEL_CANDIDATE_SQL, reviveDetails, reviveIfOpenInMeli,
};
