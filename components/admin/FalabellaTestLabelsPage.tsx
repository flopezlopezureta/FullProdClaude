import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';

// UAT test LPNs Falabella provided — no real physical label exists for these, so this page
// generates a scannable stand-in encoding the same JSON payload a real Falabella Directo label's
// QR would contain, so the driver/Auxiliar scanner UI can be exercised against paper without
// needing an actual shipment. GOLIVERY2 dropped 2026-08-10 — Falabella's team re-listed 1/3/4 as
// still usable but not 2, likely already consumed/closed from earlier testing; 5-8 added same day.
const TEST_LPNS = ['TEST_LPN_GOLIVERY1', 'TEST_LPN_GOLIVERY3', 'TEST_LPN_GOLIVERY4', 'TEST_LPN_GOLIVERY5', 'TEST_LPN_GOLIVERY6', 'TEST_LPN_GOLIVERY7', 'TEST_LPN_GOLIVERY8'];
const QA_HOST = 'https://logistic-api-qa.falabella.com';

interface TestLabel {
    lpn: string;
    qrCodeUrl: string;
}

const FalabellaTestLabelsPage: React.FC = () => {
    const [labels, setLabels] = useState<TestLabel[]>([]);

    useEffect(() => {
        const generateAll = async () => {
            const generated = await Promise.all(TEST_LPNS.map(async (lpn) => {
                const payload = JSON.stringify({
                    origin: 'Falabella',
                    url: `${QA_HOST}/schn-trmg-3pl-directo/v1/orders/${lpn}`,
                    sellerId: 'SC478FA', // matches the real seller ID seen on Falabella's actual UAT test labels
                });
                const qrCodeUrl = await QRCode.toDataURL(payload, {
                    errorCorrectionLevel: 'M',
                    type: 'image/png',
                    width: 400,
                    margin: 1,
                    color: { dark: '#000000', light: '#ffffff' },
                });
                return { lpn, qrCodeUrl };
            }));
            setLabels(generated);
        };
        generateAll();
    }, []);

    return (
        <div className="max-w-4xl mx-auto pb-12">
            <div className="flex items-center justify-between mb-2">
                <h1 className="text-2xl font-bold text-[var(--text-primary)]">Etiquetas de Prueba — Falabella Directo</h1>
                <button
                    onClick={() => window.print()}
                    className="px-4 py-2 bg-[var(--brand-primary)] text-white text-sm font-bold rounded-md hover:opacity-90 print:hidden"
                >
                    Imprimir
                </button>
            </div>
            <p className="text-sm text-amber-600 font-semibold mb-6">
                Ambiente UAT — estas etiquetas no corresponden a envíos reales. Imprime y escanéalas con el escáner de Falabella Directo (menú Auxiliar) para probar el flujo completo sin depender de una etiqueta física real de Falabella.
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 print:grid-cols-2">
                {labels.map(({ lpn, qrCodeUrl }) => (
                    <div key={lpn} className="bg-[var(--background-secondary)] border-2 border-dashed border-[var(--border-primary)] rounded-lg p-6 flex flex-col items-center text-center break-inside-avoid">
                        <p className="text-xs font-bold uppercase tracking-widest text-[var(--text-muted)] mb-2">Falabella Directo — UAT</p>
                        {qrCodeUrl ? (
                            <img src={qrCodeUrl} alt={`QR ${lpn}`} className="w-48 h-48" />
                        ) : (
                            <div className="w-48 h-48 flex items-center justify-center text-[var(--text-muted)] text-sm">Generando...</div>
                        )}
                        <p className="mt-3 font-mono text-sm font-bold text-[var(--text-primary)]">{lpn}</p>
                    </div>
                ))}
            </div>
        </div>
    );
};

export default FalabellaTestLabelsPage;
