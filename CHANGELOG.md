# Changelog - Fullenvios

Todos los cambios notables en este proyecto serán documentados en este archivo.

---

## 🔖 CONTEXTO DE SESIÓN — 31-07-2026

### ✅ Completado hoy
- **v2.8.0:** Centro de Control Multimodal de Flotas — Implementación de 4 modalidades de visualización (Auditoría de Cierres, Cadencia & Tiempos, Cronometría de Jornada, SLA & Rendimiento), notificador 1-click a choferes en mora, y control de visibilidad exclusivo para el Superadministrador en Ajustes (Setup). Auto-migración de BD incluida (`fleetControlEnabled`).

---

## 🔖 CONTEXTO DE SESIÓN — 30-07-2026

### ✅ Completado hoy
- **v2.7.5:** Gestión de Paquetes — corregido el conteo masivo inflado (31,000+ paquetes). Se eliminó la cláusula `p."updatedAt"` en el filtro por defecto por fecha de creación (`dateType = 'created'`) en `routes/packages.js`, dejando la coincidencia únicamente por `createdAt` y `estimatedDelivery`. Subido a los repositorios `Fullenvios2` (CLIENTE2) y `Test1`.

---

## 🔖 CONTEXTO DE SESIÓN — 29-07-2026

### ✅ Completado hoy
- **v2.7.4:** Análisis Logístico BI — corregido conteo de pendientes en `fleet-status`. El JOIN de estadísticas ahora incluye paquetes por `estimatedDelivery` OR `updatedAt` del día.

### ⏳ Pendiente
1. **Redeploy en Coolify** del servicio `fullenvios` → botón "Deploy" en el panel.
2. **Consultar tamaño real de BD** → `https://fullenvios.selcom.cl/api/packages/sys/db-size`
3. **Instalar rclone en el servidor** (vía Google Escritorio Remoto → "Desarrollo Selcom"):
   ```bash
   curl https://rclone.org/install.sh | sudo bash
   rclone config   # nombre: gdrive, tipo: drive, autenticar con cuenta Google corporativa
   rclone lsd gdrive:   # verificar que funciona
   ```
4. **Agregar subida automática a Google Drive** en `scripts/backup_db.sh` (pendiente de modificar).
5. **Restaurar el cron** de respaldo automático a las 03:00 hrs (lleva 58 días sin ejecutarse).

### 📌 Datos clave del entorno
- **Producción:** `https://fullenvios.selcom.cl` — Coolify apunta a `Fullenvios2.git` (remote `clon`)
- **Servidor:** `191.113.87.123:5433` — acceso vía Google Chrome Remote Desktop ("Desarrollo Selcom")
- **Google Drive:** 145 GB Workspace — 16.47 GB usados — **~128 GB libres** ✅ suficiente para respaldos
- **Último respaldo válido en pendrive:** 31 mayo 2026 (~4.3 GB comprimido)
- **Estimación tamaño BD actual comprimido:** ~10 GB

---

## [2.7.4] - 2026-07-29
### Corregido
* **Análisis Logístico BI (Fleet Monitor):** Se corrigió un bug en el endpoint `/api/users/fleet-status` donde los paquetes pendientes de un conductor **no eran contados** si su `updatedAt` era de un día anterior. El JOIN de estadísticas ahora filtra por `estimatedDelivery` OR `updatedAt` del día seleccionado, igual que el CTE de conductores activos. Esto garantiza que los paquetes asignados previamente pero programados para hoy sean visibles en la columna "Pendientes".

## [2.7.3] - 2026-07-28
### Añadido
* **Diagnóstico de BD:** Endpoint `GET /api/packages/sys/db-size` que retorna tamaño de base de datos, total de paquetes y total de eventos de tracking. Útil para estimar tamaño de respaldos.
* **Script de respaldo:** Política de retención cambiada de 30 días a conservar solo los **2 respaldos más recientes**. El script NO borra respaldos anteriores si el nuevo falla.

## [2.7.2] - 2026-07-28
### Corregido
* **Dashboard Principal:** Se restauró la consulta de fecha amplia original (`createdAt` OR `updatedAt` OR `estimatedDelivery`) para la opción por defecto `"created"`. Esto soluciona la regresión crítica de la versión 2.7.0 que ocultaba paquetes activos del día creados en fechas anteriores.

## [2.7.1] - 2026-07-28
### Corregido
* **App Móvil de Conductores:** Se incluyó el estado `ASIGNADO` en la consulta del endpoint `/api/mobile/entregas`. Esto soluciona el problema donde los choferes no veían los pedidos recién asignados hasta que se cambiaban manualmente a tránsito.

## [2.7.0] - 2026-07-28
### Añadido
* **Filtros Estrictos en Alertas Críticas:** 
  * Las alertas de reasignación (`isReassigned = true`) ahora se filtran estrictamente por la columna `assignedAt` en lugar de `updatedAt`. Esto evita falsos positivos causados por el servicio de sincronización automática de Mercado Libre (`meliPollingService.js`) al actualizar paquetes antiguos de meses anteriores.
  * Las alertas de duplicados (`isDuplicate = true`) ahora se filtran estrictamente por la columna `createdAt`.
* **Mejora en Dashboard UI:** Las tarjetas de reasignación ahora muestran la hora real del evento (`assignedAt`) en lugar de la hora de sincronización.
