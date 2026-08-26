import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../../services/api';
import { IconFileUpload, IconCheckCircle, IconAlertTriangle, IconLoader, IconRefresh } from '../Icon';

interface LiveStatus {
    version: { versionCode: number; versionName: string; mandatory: boolean; apkUrl: string; notes: string } | null;
    apk: { exists: boolean; sizeBytes?: number; modifiedAt?: string };
}

const formatBytes = (bytes?: number) => {
    if (!bytes) return '—';
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const AppUpdatesPage: React.FC = () => {
    const [status, setStatus] = useState<LiveStatus | null>(null);
    const [isLoadingStatus, setIsLoadingStatus] = useState(true);

    const [file, setFile] = useState<File | null>(null);
    const [versionName, setVersionName] = useState('');
    const [notes, setNotes] = useState('');
    const [mandatory, setMandatory] = useState(true);

    const [isSubmitting, setIsSubmitting] = useState(false);
    const [result, setResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
    const [conflict, setConflict] = useState<{ currentVersionCode: number; message: string } | null>(null);

    const loadStatus = useCallback(async () => {
        setIsLoadingStatus(true);
        try {
            const data = await api.getAppUpdatesStatus();
            setStatus(data);
        } catch (e: any) {
            setResult({ type: 'error', message: e.message || 'No se pudo cargar el estado actual.' });
        } finally {
            setIsLoadingStatus(false);
        }
    }, []);

    useEffect(() => { loadStatus(); }, [loadStatus]);

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const f = e.target.files?.[0] || null;
        setFile(f);
        setResult(null);
        setConflict(null);
    };

    const doPublish = async (force = false) => {
        if (!file) return;

        setIsSubmitting(true);
        setResult(null);
        setConflict(null);
        try {
            const res = await api.publishAppUpdate(file, {
                versionName: versionName.trim(),
                mandatory,
                notes: notes.trim(),
                force,
            });
            setResult({ type: 'success', message: res.message });
            setFile(null);
            await loadStatus();
        } catch (e: any) {
            if (e.status === 409 && e.body?.currentVersionCode !== undefined) {
                setConflict({ currentVersionCode: e.body.currentVersionCode, message: e.message || '' });
            } else {
                setResult({ type: 'error', message: e.message || 'Error al publicar la actualización.' });
            }
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        doPublish(false);
    };

    return (
        <div className="max-w-2xl mx-auto pb-12">
            <h1 className="text-2xl font-bold text-[var(--text-primary)] mb-1">Actualizaciones de la App</h1>
            <p className="text-sm text-[var(--text-muted)] mb-6">
                Publica una nueva versión del APK que envuelve la web (Full Envíos). Los teléfonos que ya tienen la app
                instalada detectan la versión nueva solos la próxima vez que la abran — no hace falta tocar el servidor a mano.
            </p>

            <div className="bg-[var(--background-secondary)] border border-[var(--border-primary)] rounded-lg p-5 mb-6">
                <div className="flex items-center justify-between mb-3">
                    <h2 className="text-sm font-bold text-[var(--text-primary)] uppercase tracking-wide">Versión publicada actualmente</h2>
                    <button onClick={loadStatus} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]" aria-label="Actualizar" disabled={isLoadingStatus}>
                        <IconRefresh className={`w-4 h-4 ${isLoadingStatus ? 'animate-spin' : ''}`} />
                    </button>
                </div>
                {isLoadingStatus ? (
                    <p className="text-sm text-[var(--text-muted)]">Cargando...</p>
                ) : status?.version ? (
                    <div className="text-sm text-[var(--text-secondary)] space-y-1">
                        <p><span className="font-semibold text-[var(--text-primary)]">versionCode:</span> {status.version.versionCode}</p>
                        <p><span className="font-semibold text-[var(--text-primary)]">Nombre:</span> {status.version.versionName}</p>
                        <p><span className="font-semibold text-[var(--text-primary)]">Notas:</span> {status.version.notes || '—'}</p>
                        <p><span className="font-semibold text-[var(--text-primary)]">Tamaño del APK:</span> {formatBytes(status.apk.sizeBytes)}</p>
                        <p><span className="font-semibold text-[var(--text-primary)]">Última publicación:</span> {status.apk.modifiedAt ? new Date(status.apk.modifiedAt).toLocaleString('es-CL') : '—'}</p>
                    </div>
                ) : (
                    <p className="text-sm text-[var(--text-muted)]">No hay ninguna versión publicada todavía.</p>
                )}
            </div>

            <form onSubmit={handleSubmit} className="bg-[var(--background-secondary)] border border-[var(--border-primary)] rounded-lg p-5 space-y-4">
                <h2 className="text-sm font-bold text-[var(--text-primary)] uppercase tracking-wide">Publicar versión nueva</h2>

                <div>
                    <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Archivo APK</label>
                    <input
                        type="file"
                        accept=".apk"
                        onChange={handleFileChange}
                        className="w-full text-sm text-[var(--text-secondary)] file:mr-3 file:py-2 file:px-4 file:rounded-md file:border-0 file:bg-[var(--brand-primary)] file:text-white file:font-semibold hover:file:opacity-90"
                        required
                    />
                    {file && (
                        <p className="text-xs text-[var(--text-muted)] mt-1 flex items-center gap-1">
                            {file.name} — {formatBytes(file.size)}
                        </p>
                    )}
                    <p className="text-xs text-[var(--text-muted)] mt-1">
                        El número de versión (versionCode) ya no se escribe a mano — el servidor lo lee directo
                        del archivo APK al publicarlo, para que nunca quede desalineado con lo que realmente
                        instalan los teléfonos.
                    </p>
                </div>

                <div>
                    <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Nombre de versión (opcional, solo para mostrar)</label>
                    <input
                        type="text"
                        value={versionName}
                        onChange={(e) => setVersionName(e.target.value)}
                        placeholder="ej: 1.3"
                        className="w-full px-3 py-2 border border-[var(--border-secondary)] rounded-md bg-[var(--background-secondary)] text-[var(--text-primary)]"
                    />
                </div>

                <div>
                    <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Notas (se muestran al conductor)</label>
                    <textarea
                        value={notes}
                        onChange={(e) => setNotes(e.target.value)}
                        rows={2}
                        className="w-full px-3 py-2 border border-[var(--border-secondary)] rounded-md bg-[var(--background-secondary)] text-[var(--text-primary)]"
                        placeholder="ej: Corrige la selección múltiple de fotos desde galería."
                    />
                </div>

                <label className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
                    <input type="checkbox" checked={mandatory} onChange={(e) => setMandatory(e.target.checked)} className="rounded" />
                    Actualización obligatoria (no se puede posponer)
                </label>

                {conflict && (
                    <div className="bg-amber-50 border border-amber-300 text-amber-800 rounded-md p-3 text-sm">
                        <p className="font-semibold mb-2">{conflict.message || `El versionCode del archivo no es mayor al publicado actualmente (${conflict.currentVersionCode}). Los teléfonos no detectarán esta actualización.`}</p>
                        <button type="button" onClick={() => doPublish(true)} className="px-3 py-1.5 bg-amber-600 text-white rounded-md text-xs font-bold hover:bg-amber-700">
                            Publicar de todas formas
                        </button>
                    </div>
                )}

                {result && (
                    <div className={`flex items-center gap-2 p-3 rounded-md text-sm ${result.type === 'success' ? 'bg-green-50 text-green-800 border border-green-300' : 'bg-red-50 text-red-800 border border-red-300'}`}>
                        {result.type === 'success' ? <IconCheckCircle className="w-5 h-5 shrink-0" /> : <IconAlertTriangle className="w-5 h-5 shrink-0" />}
                        <span>{result.message}</span>
                    </div>
                )}

                <button
                    type="submit"
                    disabled={!file || isSubmitting}
                    className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-[var(--brand-primary)] text-white font-bold rounded-md hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    {isSubmitting ? <IconLoader className="w-5 h-5 animate-spin" /> : <IconFileUpload className="w-5 h-5" />}
                    {isSubmitting ? 'Publicando...' : 'Publicar Actualización'}
                </button>
            </form>
        </div>
    );
};

export default AppUpdatesPage;
