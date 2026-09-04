import React, { useMemo, useContext, useState } from 'react';
import type { Package, User } from '../../types';
import { PackageStatus, MessagingPlan } from '../../constants';
import { IconX, IconWhatsapp, IconMail, IconCheckCircle, IconAlertTriangle, IconUser } from '../Icon';
import { AuthContext } from '../../contexts/AuthContext';
import { getLogicalDateString } from '../../utils/dateUtils';
import { api } from '../../services/api';

interface ClientSummary {
    clientId: string;
    clientName: string;
    clientPhone?: string;
    clientEmail?: string;
    total: number;
    delivered: number;
    problems: number;
    undeliveredIds: string[];
}

interface EndOfDayReportModalProps {
  onClose: () => void;
  packages: Package[];
  driverName: string;
  users: User[];
  // true solo cuando el cierre automático (tryAutoCloseRoute, pending === 0) ya lo registró
  // antes de abrir este modal — en ese caso no hay nada más que confirmar, solo se muestra el
  // resumen. Cuando es false (el conductor lo abrió a mano, con pendientes todavía), se ofrece
  // el botón de cierre manual más abajo.
  alreadyClosed: boolean;
}

const EndOfDayReportModal: React.FC<EndOfDayReportModalProps> = ({ onClose, packages, driverName, users, alreadyClosed }) => {
  const auth = useContext(AuthContext);
  const [isClosing, setIsClosing] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);
  const [justClosed, setJustClosed] = useState(false);

  const clientSummaries: ClientSummary[] = useMemo(() => {
    const tz = auth?.systemSettings?.timezone || 'America/Santiago';
    const todayStr = getLogicalDateString(new Date(), tz);
    const summaries: { [clientId: string]: ClientSummary } = {};

    const dailyPackages = packages.filter(p => {
        const finalEvent = p.history[0];
        return finalEvent && getLogicalDateString(new Date(finalEvent.timestamp), tz) === todayStr;
    });

    for (const pkg of dailyPackages) {
        if (!pkg.creatorId) continue;

        if (!summaries[pkg.creatorId]) {
            const client = users.find(u => u.id === pkg.creatorId);
            summaries[pkg.creatorId] = {
                clientId: pkg.creatorId,
                clientName: client?.name || 'Cliente Desconocido',
                clientPhone: client?.phone,
                clientEmail: client?.email,
                total: 0,
                delivered: 0,
                problems: 0,
                undeliveredIds: [],
            };
        }
        
        const summary = summaries[pkg.creatorId];
        summary.total++;
        if (pkg.status === PackageStatus.Delivered) {
            summary.delivered++;
        } else if (pkg.status === PackageStatus.Problem) {
            summary.problems++;
            summary.undeliveredIds.push(pkg.id);
        } else {
             summary.undeliveredIds.push(pkg.id);
        }
    }
    
    return Object.values(summaries).sort((a,b) => a.clientName.localeCompare(b.clientName));
  }, [packages, users]);

  // A diferencia de clientSummaries (que solo mira paquetes ya resueltos hoy, para el aviso a
  // cada cliente), esto cuenta TODO lo asignado hoy — incluye los que siguen sin tocar, que es
  // justo lo que hace falta saber para permitir un cierre manual con pendientes.
  const todayTotals = useMemo(() => {
    const tz = auth?.systemSettings?.timezone || 'America/Santiago';
    const todayStr = getLogicalDateString(new Date(), tz);
    const assignedToday = packages.filter(p => p.assignedAt && getLogicalDateString(new Date(p.assignedAt), tz) === todayStr);

    let delivered = 0, problems = 0, pending = 0;
    for (const pkg of assignedToday) {
        if (pkg.status === PackageStatus.Delivered) delivered++;
        else if (pkg.status === PackageStatus.Problem) problems++;
        else pending++;
    }
    return { total: assignedToday.length, delivered, problems, pending };
  }, [packages, auth?.systemSettings?.timezone]);

  const handleConfirmClosure = async () => {
    setIsClosing(true);
    setCloseError(null);
    try {
        await api.submitClosure({
            total: todayTotals.total,
            delivered: todayTotals.delivered,
            problems: todayTotals.problems,
            pending: todayTotals.pending,
            notes: todayTotals.pending > 0
                ? `Cierre manual con ${todayTotals.pending} paquete(s) sin gestionar — quedan pendientes para el día siguiente.`
                : 'Cierre manual: jornada completa.',
        });
        setJustClosed(true);
    } catch (err) {
        console.error('Error al cerrar la jornada', err);
        setCloseError('No se pudo registrar el cierre. Intenta de nuevo.');
    } finally {
        setIsClosing(false);
    }
  };

  const handleNotifyClient = (summary: ClientSummary) => {
    const tz = auth?.systemSettings?.timezone || 'America/Santiago';
    const message = `Resumen de jornada para ${summary.clientName} - ${getLogicalDateString(new Date(), tz)}\n` +
                    `Conductor: ${driverName}\n\n`+
                    `📦 Total de paquetes gestionados hoy: ${summary.total}\n`+
                    `✅ Entregados: ${summary.delivered}\n`+
                    `⚠️ Con problemas o pendientes: ${summary.problems}\n\n`+
                    (summary.undeliveredIds.length > 0 ? `IDs no entregados: ${summary.undeliveredIds.join(', ')}\n\n` : '') +
                    `-- Fin del Reporte --`;

    if (auth?.systemSettings.messagingPlan === MessagingPlan.WhatsApp && summary.clientPhone) {
        const phone = summary.clientPhone.replace(/\D/g, '');
        const url = `https://api.whatsapp.com/send?phone=${phone}&text=${encodeURIComponent(message)}`;
        
        // @ts-ignore
        if (window.AndroidApp && window.AndroidApp.shareText) {
            // @ts-ignore
            window.AndroidApp.shareText(message, "Resumen de Jornada");
        } else {
            window.location.href = url;
        }
    /*
    } else if (auth?.systemSettings.messagingPlan === MessagingPlan.Email && summary.clientEmail) {
        const subject = `Resumen de jornada - ${new Date().toLocaleDateString('es-CL')}`;
        const url = `mailto:${summary.clientEmail}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(message)}`;
        window.location.href = url;
    */
    }
  };

  const messagingPlan = auth?.systemSettings.messagingPlan;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-60 z-50 flex justify-center items-center p-4" onClick={onClose}>
      <div className="bg-[var(--background-secondary)] rounded-xl shadow-2xl w-full max-w-lg h-[90vh] flex flex-col animate-fade-in-up" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center justify-between p-4 border-b border-[var(--border-primary)]">
          <h3 className="text-lg font-bold text-[var(--text-primary)]">Resumen de Fin de Jornada</h3>
          <button onClick={onClose} className="p-2 rounded-full text-[var(--text-muted)] hover:bg-[var(--background-hover)]" aria-label="Cerrar modal">
            <IconX className="w-6 h-6" />
          </button>
        </header>
        <div className="p-6 flex-1 overflow-y-auto custom-scrollbar">
            <p className="text-sm text-[var(--text-secondary)] mb-4">
                {alreadyClosed
                    ? 'Has finalizado tus entregas por hoy. Aquí tienes un resumen por cliente.'
                    : 'Resumen de tu jornada hasta ahora.'}
                {messagingPlan !== MessagingPlan.None && " Envía el reporte a cada uno."}
            </p>
            {!alreadyClosed && !justClosed && todayTotals.pending > 0 && (
                <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 text-amber-800 text-sm rounded-lg p-3 mb-4">
                    <IconAlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0"/>
                    <span>Te quedan <strong>{todayTotals.pending}</strong> paquete{todayTotals.pending !== 1 ? 's' : ''} sin gestionar. Si cierras ahora, quedan registrados para retomarlos mañana.</span>
                </div>
            )}
            {clientSummaries.length === 0 ? (
                <p className="text-center text-[var(--text-muted)] py-10">No hay actividad para reportar hoy.</p>
            ) : (
                <div className="space-y-3">
                    {clientSummaries.map(summary => (
                         <div key={summary.clientId} className="bg-[var(--background-muted)] p-4 rounded-lg flex items-center justify-between">
                            <div className="flex items-center gap-3">
                                <IconUser className="w-8 h-8 p-1.5 bg-[var(--background-secondary)] text-[var(--text-secondary)] rounded-full flex-shrink-0"/>
                                <div>
                                    <p className="font-semibold text-sm text-[var(--text-primary)]">{summary.clientName}</p>
                                    <div className="flex items-center gap-3 text-xs text-[var(--text-secondary)] mt-1">
                                        <span className="flex items-center gap-1"><IconCheckCircle className="w-3.5 h-3.5 text-green-500"/> {summary.delivered}</span>
                                        <span className="flex items-center gap-1"><IconAlertTriangle className="w-3.5 h-3.5 text-red-500"/> {summary.problems}</span>
                                    </div>
                                </div>
                            </div>
                            {messagingPlan === MessagingPlan.WhatsApp && summary.clientPhone && (
                                <button onClick={() => handleNotifyClient(summary)} className="p-2.5 bg-green-100 text-green-700 rounded-full hover:bg-green-200" title="Enviar por WhatsApp">
                                    <IconWhatsapp className="w-5 h-5"/>
                                </button>
                            )}
                            {messagingPlan === MessagingPlan.Email && summary.clientEmail && (
                                <button onClick={() => handleNotifyClient(summary)} className="p-2.5 bg-blue-100 text-blue-700 rounded-full hover:bg-blue-200" title="Enviar por Email">
                                    <IconMail className="w-5 h-5"/>
                                </button>
                            )}
                         </div>
                    ))}
                </div>
            )}
        </div>
        <footer className="px-6 py-4 bg-[var(--background-muted)] rounded-b-xl">
          {closeError && <p className="text-sm text-red-600 mb-2">{closeError}</p>}
          {justClosed ? (
              <div className="flex items-center justify-between gap-3">
                  <span className="text-sm text-green-700 flex items-center gap-1.5 font-medium">
                      <IconCheckCircle className="w-4 h-4"/> Jornada cerrada correctamente.
                  </span>
                  <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium text-[var(--text-secondary)] bg-[var(--background-secondary)] border border-[var(--border-secondary)] rounded-md hover:bg-[var(--background-hover)]">
                      Cerrar
                  </button>
              </div>
          ) : alreadyClosed ? (
              <div className="flex justify-end">
                  <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium text-[var(--text-secondary)] bg-[var(--background-secondary)] border border-[var(--border-secondary)] rounded-md hover:bg-[var(--background-hover)]">
                      Cerrar
                  </button>
              </div>
          ) : (
              <div className="flex justify-end gap-2">
                  <button type="button" onClick={onClose} disabled={isClosing} className="px-4 py-2 text-sm font-medium text-[var(--text-secondary)] bg-[var(--background-secondary)] border border-[var(--border-secondary)] rounded-md hover:bg-[var(--background-hover)] disabled:opacity-50">
                      Cancelar
                  </button>
                  <button type="button" onClick={handleConfirmClosure} disabled={isClosing} className="px-4 py-2 text-sm font-semibold text-white bg-[var(--brand-primary)] rounded-md hover:opacity-90 disabled:opacity-50">
                      {isClosing ? 'Cerrando...' : 'Confirmar Cierre de Jornada'}
                  </button>
              </div>
          )}
        </footer>
      </div>
    </div>
  );
};

export default EndOfDayReportModal;