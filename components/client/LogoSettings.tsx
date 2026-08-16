import React, { useContext, useRef, useState } from 'react';
import { AuthContext } from '../../contexts/AuthContext';
import { api } from '../../services/api';
import ShippingLabel from './ShippingLabel';
import { LabelFormat, PackageSource, PackageStatus, ShippingType } from '../../constants';
import type { Package } from '../../types';
import { IconFileUpload, IconTrash, IconCheck, IconLoader } from '../Icon';

const MAX_DIMENSION = 400; // px — plenty for a label logo, keeps the stored base64 small

// Resizes/compresses the picked image client-side before it ever leaves the browser, so a
// driver's phone camera photo (several MB) doesn't turn into a multi-MB row in the users table.
const resizeImage = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                let { width, height } = img;
                if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
                    const ratio = Math.min(MAX_DIMENSION / width, MAX_DIMENSION / height);
                    width = Math.round(width * ratio);
                    height = Math.round(height * ratio);
                }
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                if (!ctx) return reject(new Error('No se pudo procesar la imagen.'));
                ctx.drawImage(img, 0, 0, width, height);
                resolve(canvas.toDataURL('image/png'));
            };
            img.onerror = () => reject(new Error('El archivo no es una imagen válida.'));
            img.src = e.target?.result as string;
        };
        reader.onerror = () => reject(new Error('No se pudo leer el archivo.'));
        reader.readAsDataURL(file);
    });
};

const SAMPLE_PACKAGE: Package = {
    id: 'SAMPLE-0001',
    recipientName: 'Juan Pérez',
    recipientPhone: '+56912345678',
    recipientRut: '12.345.678-9',
    status: PackageStatus.Pending,
    shippingType: ShippingType.NextDay,
    origin: 'Bodega Central',
    destination: 'Domicilio',
    recipientAddress: 'Av. Siempre Viva 742',
    recipientCommune: 'Providencia',
    recipientCity: 'Santiago',
    notes: 'Ejemplo de etiqueta',
    estimatedDelivery: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    history: [],
    driverId: null,
    creatorId: null,
    source: PackageSource.Manual,
};

const LogoSettings: React.FC = () => {
    const auth = useContext(AuthContext);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [previewLogo, setPreviewLogo] = useState<string | undefined>(auth?.user?.logoBase64);
    const [isSaving, setIsSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [previewFormat, setPreviewFormat] = useState<LabelFormat>(LabelFormat.CompactThermal);

    if (!auth?.user) return null;

    const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        setError(null);
        setSaved(false);
        try {
            const resized = await resizeImage(file);
            setPreviewLogo(resized);
        } catch (err: any) {
            setError(err.message || 'No se pudo procesar la imagen.');
        }
    };

    const handleSave = async () => {
        setIsSaving(true);
        setError(null);
        try {
            await api.updateUser(auth.user!.id, { logoBase64: previewLogo || '' });
            await auth.refetchUser();
            setSaved(true);
            setTimeout(() => setSaved(false), 3000);
        } catch (err: any) {
            setError(err.message || 'No se pudo guardar el logo.');
        } finally {
            setIsSaving(false);
        }
    };

    const handleRemove = () => {
        setPreviewLogo(undefined);
        setSaved(false);
    };

    const hasChanges = previewLogo !== auth.user.logoBase64;

    return (
        <div className="bg-[var(--background-secondary)] rounded-2xl shadow-xl border border-[var(--border-primary)] overflow-hidden">
            <div className="p-1 bg-gradient-to-r from-blue-600 to-indigo-600"></div>
            <div className="p-8">
                <h3 className="text-lg font-black text-[var(--text-primary)] uppercase tracking-tight mb-1">Logo en Etiquetas</h3>
                <p className="text-sm text-[var(--text-secondary)] mb-6">Sube tu logo para que aparezca en tus etiquetas de envío. Se ajusta automáticamente al tamaño de la etiqueta.</p>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                    <div>
                        <div className="flex items-center gap-4 mb-4">
                            <button
                                onClick={() => fileInputRef.current?.click()}
                                className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-[var(--brand-primary)] text-white text-sm font-semibold hover:opacity-90 transition-opacity"
                            >
                                <IconFileUpload className="w-4 h-4" /> Elegir imagen
                            </button>
                            {previewLogo && (
                                <button
                                    onClick={handleRemove}
                                    className="flex items-center gap-2 px-3 py-2.5 rounded-lg border border-[var(--border-secondary)] text-[var(--text-secondary)] text-sm font-semibold hover:bg-[var(--background-hover)] transition-colors"
                                >
                                    <IconTrash className="w-4 h-4" /> Quitar
                                </button>
                            )}
                        </div>
                        <input ref={fileInputRef} type="file" accept="image/*" onChange={handleFileChange} className="hidden" />

                        {error && <p className="text-sm text-red-600 mb-3">{error}</p>}

                        {previewLogo && (
                            <div className="p-4 bg-[var(--background-muted)] border border-[var(--border-primary)] rounded-lg mb-4 flex items-center justify-center">
                                <img src={previewLogo} alt="Logo" className="max-h-24 max-w-full object-contain" />
                            </div>
                        )}

                        <div className="mb-4">
                            <label className="block text-xs font-bold text-[var(--text-muted)] uppercase tracking-wide mb-2">Formato de etiqueta a previsualizar</label>
                            <select
                                value={previewFormat}
                                onChange={(e) => setPreviewFormat(e.target.value as LabelFormat)}
                                className="w-full px-3 py-2 rounded-lg border border-[var(--border-secondary)] bg-[var(--background-primary)] text-[var(--text-primary)] text-sm"
                            >
                                <option value={LabelFormat.CompactThermal}>Térmica Logística (100x150mm)</option>
                                <option value={LabelFormat.FullThermal}>Térmica Identidad (100x150mm)</option>
                                <option value={LabelFormat.A4Single}>Hoja A4</option>
                                <option value={LabelFormat.A4Half}>Media Hoja A4</option>
                                <option value={LabelFormat.Thermal10x8}>Térmica 10x8</option>
                            </select>
                        </div>

                        <button
                            onClick={handleSave}
                            disabled={isSaving || !hasChanges}
                            className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-green-600 text-white text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed hover:bg-green-700 transition-colors"
                        >
                            {isSaving ? <IconLoader className="w-4 h-4 animate-spin" /> : (saved ? <IconCheck className="w-4 h-4" /> : null)}
                            {isSaving ? 'Guardando...' : (saved ? 'Guardado' : 'Guardar Logo')}
                        </button>
                    </div>

                    <div className="flex flex-col items-center">
                        <p className="text-xs font-bold text-[var(--text-muted)] uppercase tracking-wide mb-3 self-start">Vista previa</p>
                        <div className="w-full overflow-auto flex justify-center p-4 bg-gray-100 rounded-lg border border-[var(--border-primary)]" style={{ maxHeight: '500px' }}>
                            <div style={{ transform: 'scale(0.85)', transformOrigin: 'top center' }}>
                                <ShippingLabel
                                    pkg={SAMPLE_PACKAGE}
                                    creatorName={auth.user.companyName || auth.user.name}
                                    creatorLogoBase64={previewLogo}
                                    format={previewFormat}
                                />
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default LogoSettings;
