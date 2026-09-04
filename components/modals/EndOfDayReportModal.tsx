import React, { useMemo, useContext } from 'react';
import type { Package, User } from '../../types';
import { PackageStatus, MessagingPlan } from '../../constants';
import { IconX, IconWhatsapp, IconMail, IconCheckCircle, IconAlertTriangle, IconUser } from '../Icon';
import { AuthContext } from '../../contexts/AuthContext';
import { getLogicalDateString } from '../../utils/dateUtils';

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
}

const EndOfDayReportModal: React.FC<EndOfDayReportModalProps> = ({ onClose, packages, driverName, users }) => {
  const auth = useContext(AuthContext);

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
                Has finalizado tus entregas por hoy. Aquí tienes un resumen por cliente.
                {messagingPlan !== MessagingPlan.None && " Envía el reporte a cada uno."}
            </p>
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
        <footer className="px-6 py-4 bg-[var(--background-muted)] rounded-b-xl flex justify-end">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium text-[var(--text-secondary)] bg-[var(--background-secondary)] border border-[var(--border-secondary)] rounded-md hover:bg-[var(--background-hover)]">
            Cerrar
          </button>
        </footer>
      </div>
    </div>
  );
};

export default EndOfDayReportModal;
