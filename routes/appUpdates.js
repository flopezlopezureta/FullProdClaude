const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const authMiddleware = require('../middleware/auth');
const db = require('../db');
const { logAction } = require('../services/logger');
const { getVersionCodeFromApk } = require('../services/apkManifestReader');

// Files live outside the git repo, on a persistent volume, so uploading a new APK
// (replace latest.apk + edit version.json) survives every code redeploy without
// needing a commit. Path is configurable via env var since the actual mount point
// depends on how the volume is set up in Coolify.
const UPDATES_DIR = process.env.APP_UPDATES_DIR || '/data/app-updates';

const isSuperUser = (email) => email === 'admin' || email === 'admin@admin.cl';

// The JWT payload only ever carries { id, role, sessionId } (see routes/auth.js) — never email —
// so isSuperUser(req.user?.email) would always be false here. Look it up from the DB instead.
async function requireSuperUser(req, res, next) {
    try {
        const { rows } = await db.query('SELECT email FROM users WHERE id = $1', [req.user?.id]);
        if (isSuperUser(rows[0]?.email)) return next();
    } catch (e) {
        console.error('[AppUpdates] Error checking super user status:', e);
    }
    return res.status(403).json({ message: 'Solo el super admin puede publicar actualizaciones de la app.' });
}

// Uploads land on the same volume/filesystem as the final destination (under a
// temp name) so the "publish" step below is a same-filesystem rename — atomic,
// and never leaves a half-written latest.apk if something goes wrong mid-upload.
const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            fs.mkdirSync(UPDATES_DIR, { recursive: true });
            cb(null, UPDATES_DIR);
        },
        filename: (req, file, cb) => cb(null, `upload-${Date.now()}.tmp`),
    }),
    limits: { fileSize: 200 * 1024 * 1024 }, // 200MB — comfortably above the ~95MB driver-app APK
});

// GET /api/app-updates/version
// Public (no auth) — the wrapper app checks this on every launch, before the driver
// is necessarily logged in, to decide whether to show the mandatory update prompt.
router.get('/version', (req, res) => {
    const versionPath = path.join(UPDATES_DIR, 'version.json');
    if (!fs.existsSync(versionPath)) {
        return res.status(404).json({ message: 'No hay información de actualización configurada.' });
    }
    try {
        const data = JSON.parse(fs.readFileSync(versionPath, 'utf8'));
        res.json(data);
    } catch (e) {
        console.error('[AppUpdates] Error reading version.json', e);
        res.status(500).json({ message: 'Error leyendo la versión disponible.' });
    }
});

// GET /api/app-updates/latest.apk
router.get('/latest.apk', (req, res) => {
    const apkPath = path.join(UPDATES_DIR, 'latest.apk');
    if (!fs.existsSync(apkPath)) {
        return res.status(404).json({ message: 'APK no encontrado.' });
    }
    res.download(apkPath, 'FullEnvios.apk');
});

// GET /api/app-updates/check?versionCode=N
// Authenticated — called from inside the driver's web session (not from native code before
// login) once the app has finished loading. Only tells a driver to update if an admin
// specifically flagged their account (users.forceAppUpdate) — lets updates be rolled out to a
// handful of drivers first instead of forcing everyone the moment a new APK is published.
router.get('/check', authMiddleware, async (req, res) => {
    const clientVersionCode = parseInt(req.query.versionCode, 10);
    if (!Number.isInteger(clientVersionCode)) {
        return res.status(400).json({ message: 'versionCode inválido.' });
    }

    try {
        const { rows } = await db.query('SELECT "forceAppUpdate" FROM users WHERE id = $1', [req.user.id]);
        if (!rows[0]?.forceAppUpdate) {
            return res.json({ shouldUpdate: false });
        }

        const versionPath = path.join(UPDATES_DIR, 'version.json');
        if (!fs.existsSync(versionPath)) {
            return res.json({ shouldUpdate: false });
        }
        const versionData = JSON.parse(fs.readFileSync(versionPath, 'utf8'));

        if (versionData.versionCode > clientVersionCode) {
            return res.json({ shouldUpdate: true, ...versionData });
        }
        return res.json({ shouldUpdate: false });
    } catch (err) {
        console.error('[AppUpdates] Error checking update eligibility:', err);
        res.status(500).json({ message: 'Error al verificar actualización.' });
    }
});

// POST /api/app-updates/force-all
// Super-admin only — activa (o desactiva) el aviso de actualización para TODA la flota de una
// vez. Antes esto sólo se podía hacer conductor por conductor desde Gestión de Usuarios, lo que
// con una flota completa tomaba demasiado tiempo justo cuando una actualización es urgente.
// Restringido al súper admin (no cualquier ADMIN) después de un incidente real: un admin
// regular lo activó apuntando a una versión que todavía no se había probado de punta a punta, y
// dejó a toda la flota de conductores atascada en un aviso de actualización que nunca avanzaba.
// Cubre las variantes de rol que existen en la base ('CHOFER'/'CONDUCTOR' además de 'DRIVER'),
// porque el rol se normaliza al leer el token pero se guarda tal cual se creó el usuario.
router.post('/force-all', authMiddleware, requireSuperUser, async (req, res) => {
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
        return res.status(400).json({ message: 'El parámetro "enabled" debe ser true o false.' });
    }

    try {
        const { rowCount } = await db.query(
            `UPDATE users SET "forceAppUpdate" = $1
             WHERE UPPER(role) IN ('DRIVER', 'CHOFER', 'CONDUCTOR', 'AUXILIAR')`,
            [enabled]
        );
        // El token sólo lleva { id, role } — el nombre hay que buscarlo para que el registro de
        // auditoría no quede en blanco (misma razón que requireSuperUser arriba).
        const { rows: actorRows } = await db.query('SELECT name FROM users WHERE id = $1', [req.user.id]);
        await logAction(
            req.user.id,
            actorRows[0]?.name || req.user.id,
            enabled ? 'FORCE_APP_UPDATE_ALL_ON' : 'FORCE_APP_UPDATE_ALL_OFF',
            { affectedUsers: rowCount }
        );
        res.json({ updated: rowCount, enabled });
    } catch (err) {
        console.error('[AppUpdates] Error setting fleet-wide update flag:', err);
        res.status(500).json({ message: 'Error al actualizar la flota completa.' });
    }
});

// GET /api/app-updates/admin-status
// Super-admin only — shows what's actually live right now (size/hash-free but with mtime,
// which is enough to eyeball "did my last publish really take") before publishing a new one.
router.get('/admin-status', authMiddleware, requireSuperUser, (req, res) => {
    const versionPath = path.join(UPDATES_DIR, 'version.json');
    const apkPath = path.join(UPDATES_DIR, 'latest.apk');
    const result = { version: null, apk: null };
    try {
        if (fs.existsSync(versionPath)) {
            result.version = JSON.parse(fs.readFileSync(versionPath, 'utf8'));
        }
    } catch (e) { /* leave null, surfaced below via apk.exists check */ }
    if (fs.existsSync(apkPath)) {
        const stat = fs.statSync(apkPath);
        result.apk = { exists: true, sizeBytes: stat.size, modifiedAt: stat.mtime };
    } else {
        result.apk = { exists: false };
    }
    res.json(result);
});

// POST /api/app-updates/upload
// Super-admin only — replaces the publishing routine that used to require shell access to the
// server (docker cp into the persistent volume). Validates the upload is a real APK and that the
// new versionCode doesn't accidentally go backwards, then atomically publishes both files.
router.post('/upload', authMiddleware, requireSuperUser, upload.single('apk'), async (req, res) => {
    const tempPath = req.file?.path;
    const cleanup = () => { if (tempPath) fs.promises.unlink(tempPath).catch(() => {}); };

    try {
        if (!req.file) {
            return res.status(400).json({ message: 'Falta el archivo APK.' });
        }

        // APKs are ZIP files under the hood — a real one always starts with the ZIP magic bytes.
        // Catches "accidentally selected the wrong file" before it ever reaches a driver's phone.
        const header = Buffer.alloc(4);
        const fd = fs.openSync(tempPath, 'r');
        fs.readSync(fd, header, 0, 4, 0);
        fs.closeSync(fd);
        const isZip = header[0] === 0x50 && header[1] === 0x4b && header[2] === 0x03 && header[3] === 0x04;
        if (!isZip || req.file.size < 1024 * 1024) {
            cleanup();
            return res.status(400).json({ message: 'El archivo no parece ser un APK válido (muy pequeño o no es un paquete Android/ZIP).' });
        }

        // El versionCode se lee del propio APK, nunca del número que se escribió en el
        // formulario — un número mal digitado (o el archivo equivocado con la etiqueta
        // correcta) llevaba a un bucle infinito de "hay actualización" en el teléfono, porque
        // el servidor comparaba contra un número que el archivo real nunca iba a alcanzar.
        let versionCode;
        try {
            versionCode = getVersionCodeFromApk(tempPath);
        } catch (readErr) {
            cleanup();
            return res.status(400).json({ message: `No se pudo leer la versión real del APK: ${readErr.message}` });
        }
        if (!Number.isInteger(versionCode) || versionCode < 1) {
            cleanup();
            return res.status(400).json({ message: 'El APK no tiene un versionCode válido en su AndroidManifest.xml.' });
        }

        const versionPath = path.join(UPDATES_DIR, 'version.json');
        let currentVersionCode = 0;
        try {
            if (fs.existsSync(versionPath)) {
                currentVersionCode = JSON.parse(fs.readFileSync(versionPath, 'utf8')).versionCode || 0;
            }
        } catch (e) { /* treat unreadable current version as 0, allow publishing over it */ }

        if (versionCode <= currentVersionCode && req.body.force !== 'true') {
            cleanup();
            return res.status(409).json({
                message: `El versionCode (${versionCode}) debe ser mayor al que ya está publicado (${currentVersionCode}). Los teléfonos no detectarán la actualización si no sube.`,
                currentVersionCode,
            });
        }

        const apkPath = path.join(UPDATES_DIR, 'latest.apk');
        fs.renameSync(tempPath, apkPath); // same filesystem — atomic, no half-written file window

        const versionData = {
            versionCode,
            versionName: req.body.versionName || String(versionCode),
            mandatory: req.body.mandatory !== 'false',
            // Host derived from the actual incoming request (publishing from Staging's admin panel
            // must produce a Staging apkUrl, not Production's) — but protocol is hardcoded to https,
            // never req.protocol: behind two proxy hops (Cloudflare Tunnel + coolify-proxy) it
            // reported plain http, and Android refuses cleartext downloads by default, so the
            // update would silently fail to download with no visible error.
            apkUrl: `https://${req.get('host')}/api/app-updates/latest.apk`,
            notes: req.body.notes || '',
        };
        // Written with fs directly (never through a text editor), so this can never carry a BOM
        // or wrong-file mixup the way the manual docker-cp process did.
        fs.writeFileSync(versionPath, JSON.stringify(versionData, null, 2), 'utf8');

        console.log(`[AppUpdates] Published versionCode ${versionCode} by ${req.user.email || req.user.id}.`);
        res.json({ message: `Versión ${versionCode} publicada correctamente.`, version: versionData, apkSizeBytes: req.file.size });
    } catch (error) {
        cleanup();
        console.error('[AppUpdates] Error publishing update:', error);
        res.status(500).json({ message: error.message || 'Error al publicar la actualización.' });
    }
});

module.exports = router;
