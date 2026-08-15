import React, { useState, useRef } from 'react';
import { IconLoader } from '../Icon';

type DotResult = 'ok' | 'fail';

interface PhaseState {
    dots: DotResult[];
    ok: number;
    fail: number;
    status: 'pending' | 'running' | 'done';
    meta: string;
}

interface ColoResult {
    colo: string;
    count: number;
}

const DOMAINS = [
    { value: 'fullenvios.selcom.cl', label: 'Producción (fullenvios.selcom.cl)' },
    { value: 'full2.fullenvios.cl', label: 'Staging (full2.fullenvios.cl)' },
];

const fetchWithTimeout = async (url: string, ms: number): Promise<{ ok: boolean; ms: number; text?: string }> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    const start = performance.now();
    try {
        const res = await fetch(url, { signal: controller.signal, cache: 'no-store' });
        const elapsed = Math.round(performance.now() - start);
        if (res.ok) {
            const text = await res.text().catch(() => undefined);
            return { ok: true, ms: elapsed, text };
        }
        return { ok: false, ms: elapsed };
    } catch {
        return { ok: false, ms: Math.round(performance.now() - start) };
    } finally {
        clearTimeout(timer);
    }
};

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

const emptyPhase = (): PhaseState => ({ dots: [], ok: 0, fail: 0, status: 'pending', meta: 'Sin datos todavía.' });

const CloudflareDiagnosticsPage: React.FC = () => {
    const [domain, setDomain] = useState(DOMAINS[0].value);
    const [running, setRunning] = useState(false);
    const [phase1, setPhase1] = useState<PhaseState>(emptyPhase());
    const [phase2, setPhase2] = useState<PhaseState>(emptyPhase());
    const [colos, setColos] = useState<ColoResult[]>([]);
    const [coloStatus, setColoStatus] = useState<'pending' | 'running' | 'done'>('pending');
    const [showSummary, setShowSummary] = useState(false);

    // Avoids a stale-closure read of phase state while looping — we mutate this ref and mirror it
    // into state after every step, since React state updates inside a tight async loop can't be
    // relied on to have committed yet when the next iteration reads "the current count".
    const liveRef = useRef({ ok1: 0, fail1: 0, ok2: 0, fail2: 0, sclCount: 0 });

    const runAll = async () => {
        setRunning(true);
        setShowSummary(false);
        liveRef.current = { ok1: 0, fail1: 0, ok2: 0, fail2: 0, sclCount: 0 };

        // Fase 1: ráfaga rápida
        setPhase1({ ...emptyPhase(), status: 'running' });
        const times1: number[] = [];
        for (let i = 0; i < 20; i++) {
            const r = await fetchWithTimeout(`https://${domain}/`, 8000);
            if (r.ok) { liveRef.current.ok1++; times1.push(r.ms); } else { liveRef.current.fail1++; }
            setPhase1(p => ({
                ...p,
                dots: [...p.dots, r.ok ? 'ok' : 'fail'],
                ok: liveRef.current.ok1,
                fail: liveRef.current.fail1,
                meta: `OK: ${liveRef.current.ok1} / FALLO: ${liveRef.current.fail1} (de ${i + 1})`,
            }));
        }
        const avg1 = times1.length ? Math.round(times1.reduce((a, b) => a + b, 0) / times1.length) : 0;
        setPhase1(p => ({ ...p, status: 'done', meta: `OK: ${liveRef.current.ok1} / FALLO: ${liveRef.current.fail1} (de 20) — promedio exitosos: ${avg1}ms` }));

        // Fase 2: tráfico espaciado
        setPhase2({ ...emptyPhase(), status: 'running' });
        for (let i = 0; i < 8; i++) {
            const r = await fetchWithTimeout(`https://${domain}/`, 8000);
            if (r.ok) liveRef.current.ok2++; else liveRef.current.fail2++;
            setPhase2(p => ({
                ...p,
                dots: [...p.dots, r.ok ? 'ok' : 'fail'],
                ok: liveRef.current.ok2,
                fail: liveRef.current.fail2,
                meta: `OK: ${liveRef.current.ok2} / FALLO: ${liveRef.current.fail2} (de ${i + 1})`,
            }));
            if (i < 7) await sleep(6000);
        }
        setPhase2(p => ({ ...p, status: 'done' }));

        // Fase 3: colo
        setColoStatus('running');
        const coloMap: Record<string, number> = {};
        for (let i = 0; i < 5; i++) {
            const r = await fetchWithTimeout(`https://${domain}/cdn-cgi/trace`, 8000);
            let colo = 'sin respuesta';
            if (r.ok && r.text) {
                const m = r.text.match(/colo=(\w+)/);
                colo = m ? m[1] : 'desconocido';
            }
            coloMap[colo] = (coloMap[colo] || 0) + 1;
            if (colo === 'SCL') liveRef.current.sclCount = coloMap[colo];
            setColos(Object.entries(coloMap).map(([c, n]) => ({ colo: c, count: n })));
            if (i < 4) await sleep(1000);
        }
        setColoStatus('done');

        setShowSummary(true);
        setRunning(false);
    };

    const pct = (n: number, total: number) => Math.round((n / total) * 100);
    const barColor = (p: number, goodAt100 = true) => {
        if (goodAt100 && p === 100) return '#22c55e';
        if (p >= 70) return '#f59e0b';
        return '#ef4444';
    };

    const allHealthy = phase1.status === 'done' && phase2.status === 'done' && coloStatus === 'done'
        && phase1.fail === 0 && phase2.fail === 0 && liveRef.current.sclCount === 5;

    return (
        <div className="max-w-3xl mx-auto">
            <p className="text-sm text-[var(--text-muted)] mb-6">
                Repite las mismas pruebas de conexión que se usaron para diagnosticar el enrutamiento de Cloudflare: ráfaga rápida, tráfico espaciado, y a qué centro de datos conecta.
            </p>

            <div className="flex flex-wrap items-center gap-3 bg-[var(--background-secondary)] border border-[var(--border-primary)] rounded-xl p-4 mb-5">
                <select
                    value={domain}
                    onChange={e => setDomain(e.target.value)}
                    disabled={running}
                    className="px-3 py-2 rounded-lg border border-[var(--border-secondary)] bg-[var(--background-primary)] text-[var(--text-primary)] text-sm"
                >
                    {DOMAINS.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
                </select>
                <button
                    onClick={runAll}
                    disabled={running}
                    className="flex items-center gap-2 px-5 py-2 rounded-lg bg-[var(--brand-primary)] text-white font-semibold text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    {running ? <IconLoader className="w-4 h-4 animate-spin" /> : <span>▶</span>}
                    {running ? 'Corriendo...' : (showSummary ? 'Repetir prueba' : 'Iniciar prueba')}
                </button>
            </div>

            {/* Fase 1 */}
            <div className={`bg-[var(--background-secondary)] border rounded-xl p-4 mb-4 transition-opacity ${phase1.status === 'pending' ? 'opacity-40' : 'opacity-100'} ${phase1.status === 'running' ? 'border-[var(--brand-primary)]' : 'border-[var(--border-primary)]'}`}>
                <div className="flex items-center justify-between mb-2">
                    <h3 className="text-sm font-bold text-[var(--text-primary)]">1. Ráfaga rápida (20 peticiones seguidas)</h3>
                    <span className={`text-xs font-bold px-2.5 py-0.5 rounded-full ${
                        phase1.status === 'pending' ? 'bg-[var(--background-muted)] text-[var(--text-muted)]' :
                        phase1.fail === 0 && phase1.status === 'done' ? 'bg-green-50 text-green-600' :
                        phase1.status === 'running' ? 'bg-blue-50 text-blue-600' : 'bg-red-50 text-red-600'
                    }`}>
                        {phase1.status === 'pending' ? 'Esperando' : phase1.status === 'running' ? 'En curso...' : (phase1.fail === 0 ? 'Sano' : `${phase1.fail} fallas`)}
                    </span>
                </div>
                <div className="flex flex-wrap gap-1 mb-2">
                    {phase1.dots.map((d, i) => (
                        <div key={i} className={`w-4 h-4 rounded ${d === 'ok' ? 'bg-green-500' : 'bg-red-500'}`} />
                    ))}
                </div>
                <div className="text-xs text-[var(--text-muted)]">{phase1.meta}</div>
            </div>

            {/* Fase 2 */}
            <div className={`bg-[var(--background-secondary)] border rounded-xl p-4 mb-4 transition-opacity ${phase2.status === 'pending' ? 'opacity-40' : 'opacity-100'} ${phase2.status === 'running' ? 'border-[var(--brand-primary)]' : 'border-[var(--border-primary)]'}`}>
                <div className="flex items-center justify-between mb-2">
                    <h3 className="text-sm font-bold text-[var(--text-primary)]">2. Tráfico espaciado (8 peticiones, cada 6s)</h3>
                    <span className={`text-xs font-bold px-2.5 py-0.5 rounded-full ${
                        phase2.status === 'pending' ? 'bg-[var(--background-muted)] text-[var(--text-muted)]' :
                        phase2.fail === 0 && phase2.status === 'done' ? 'bg-green-50 text-green-600' :
                        phase2.status === 'running' ? 'bg-blue-50 text-blue-600' : 'bg-red-50 text-red-600'
                    }`}>
                        {phase2.status === 'pending' ? 'Esperando' : phase2.status === 'running' ? 'En curso...' : (phase2.fail === 0 ? 'Sano' : `${phase2.fail} fallas`)}
                    </span>
                </div>
                <div className="flex flex-wrap gap-1 mb-2">
                    {phase2.dots.map((d, i) => (
                        <div key={i} className={`w-4 h-4 rounded ${d === 'ok' ? 'bg-green-500' : 'bg-red-500'}`} />
                    ))}
                </div>
                <div className="text-xs text-[var(--text-muted)]">{phase2.meta}</div>
            </div>

            {/* Fase 3 */}
            <div className={`bg-[var(--background-secondary)] border rounded-xl p-4 mb-4 transition-opacity ${coloStatus === 'pending' ? 'opacity-40' : 'opacity-100'} ${coloStatus === 'running' ? 'border-[var(--brand-primary)]' : 'border-[var(--border-primary)]'}`}>
                <div className="flex items-center justify-between mb-2">
                    <h3 className="text-sm font-bold text-[var(--text-primary)]">3. Centro de datos de Cloudflare (5 consultas)</h3>
                    <span className={`text-xs font-bold px-2.5 py-0.5 rounded-full ${
                        coloStatus === 'pending' ? 'bg-[var(--background-muted)] text-[var(--text-muted)]' :
                        coloStatus === 'done' && liveRef.current.sclCount === 5 ? 'bg-green-50 text-green-600' :
                        coloStatus === 'running' ? 'bg-blue-50 text-blue-600' : 'bg-red-50 text-red-600'
                    }`}>
                        {coloStatus === 'pending' ? 'Esperando' : coloStatus === 'running' ? 'En curso...' : (liveRef.current.sclCount === 5 ? 'Sano' : 'Desvío detectado')}
                    </span>
                </div>
                <div className="flex flex-col gap-1 text-xs">
                    {colos.map(c => (
                        <div key={c.colo} className="flex justify-between border-b border-[var(--border-primary)] py-1 last:border-0">
                            <span className={c.colo === 'SCL' ? 'text-green-600 font-semibold' : 'text-red-600 font-semibold'}>
                                {c.colo}{c.colo === 'SCL' ? ' (Santiago, correcto)' : ' (desvío)'}
                            </span>
                            <span className="text-[var(--text-muted)]">{c.count} / 5</span>
                        </div>
                    ))}
                    {colos.length === 0 && <div className="text-[var(--text-muted)]">Sin datos todavía.</div>}
                </div>
            </div>

            {/* Resumen */}
            {showSummary && (
                <div className="bg-[var(--background-secondary)] border border-[var(--border-primary)] rounded-xl p-5 mt-2">
                    <h2 className="text-base font-bold text-[var(--text-primary)] mb-4">Resumen final</h2>
                    {[
                        { label: 'Ráfaga rápida', n: liveRef.current.ok1, total: 20 },
                        { label: 'Tráfico espaciado', n: liveRef.current.ok2, total: 8 },
                        { label: 'Centro de datos correcto (SCL)', n: liveRef.current.sclCount, total: 5 },
                    ].map(row => {
                        const p = pct(row.n, row.total);
                        return (
                            <div key={row.label} className="mb-3">
                                <div className="flex justify-between text-xs text-[var(--text-muted)] mb-1">
                                    <span>{row.label}</span><span>{row.n}/{row.total} ({p}%)</span>
                                </div>
                                <div className="h-2.5 rounded-full bg-[var(--background-muted)] overflow-hidden">
                                    <div className="h-full rounded-full transition-all" style={{ width: `${p}%`, backgroundColor: barColor(p) }} />
                                </div>
                            </div>
                        );
                    })}
                    <div className={`mt-4 px-4 py-3 rounded-lg text-sm font-semibold ${allHealthy ? 'bg-green-50 text-green-700' : 'bg-amber-50 text-amber-700'}`}>
                        {allHealthy
                            ? '✓ Todo se ve sano en esta prueba — sin fallas ni desvío de centro de datos.'
                            : '⚠ Sigue habiendo señales del problema conocido (fallas de conexión y/o desvío a un centro de datos que no es Santiago).'}
                    </div>
                </div>
            )}
        </div>
    );
};

export default CloudflareDiagnosticsPage;
