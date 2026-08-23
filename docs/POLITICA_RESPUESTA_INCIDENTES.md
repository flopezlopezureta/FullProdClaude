# Política de Respuesta a Incidentes de Seguridad — Full Envíos

**Última actualización:** 22 de agosto de 2026

## Propósito

Este documento define cómo Full Envíos detecta, contiene y responde ante un incidente de
seguridad que afecte la plataforma (acceso no autorizado, filtración de datos, vulnerabilidad
explotada, etc.), y cómo se comunica a los clientes afectados cuando corresponde.

## Responsable

Fabián López es el responsable de seguridad de la plataforma. Ante cualquier sospecha de
incidente, es quien coordina la investigación, la corrección y, si corresponde, la comunicación
a clientes y autoridades.

## Detección

La plataforma cuenta con:
- Un registro de auditoría (`system_logs` / `logAction`) que deja constancia de acciones
  sensibles: inicio de sesión con permisos elevados, entrar al portal de otro usuario, ver una
  contraseña, borrado masivo de datos, cambios de configuración de integraciones.
- Un historial de solicitudes HTTP por ruta, con IP, con una ventana de 7 días
  (`request_log_recent`), consultable desde el panel de Tráfico de Red.
- Límite de intentos de inicio de sesión (rate limiting) para frenar ataques de fuerza bruta.

## Pasos de respuesta

1. **Confirmar el alcance:** revisar los logs de auditoría y de tráfico para determinar qué se
   accedió, cuándo, desde qué IP, y si hubo modificación de datos (no solo lectura).
2. **Contener:** cerrar la vía de acceso usada (revocar credenciales comprometidas, rotar
   `JWT_SECRET` si corresponde, deshabilitar la cuenta o endpoint afectado) tan pronto se
   identifique.
3. **Corregir la causa raíz:** parchar la vulnerabilidad específica que permitió el acceso, no
   solo el síntoma. Desplegar primero a Staging, verificar en vivo, y solo después a Producción.
4. **Reparar datos afectados:** si se modificaron o corrompieron datos reales, identificar
   exactamente qué registros y revertirlos a su estado correcto, verificando el resultado
   directamente (no solo revisando el código).
5. **Evaluar obligación de notificar:** determinar si el incidente involucró datos personales de
   clientes o compradores, y si corresponde notificar a los afectados o a la autoridad, según la
   normativa vigente al momento del incidente.
6. **Documentar:** dejar un registro técnico del incidente (qué pasó, cuándo se detectó, qué se
   hizo, qué evidencia lo respalda) — necesario tanto para uso interno como, si corresponde, para
   una eventual denuncia.

## Comunicación a clientes

Si un incidente comprometió datos personales de compradores de un cliente (tienda) de Full
Envíos, se le notificará directamente a ese cliente, describiendo qué datos pudieron verse
afectados y qué medidas se tomaron.

## Revisión posterior

Después de cerrado un incidente, se revisan los controles existentes para evitar que se repita
el mismo tipo de falla (por ejemplo: si el incidente fue por una credencial débil o compartida,
se revisan todas las credenciales similares del sistema, no solo la que falló).
