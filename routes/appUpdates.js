const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

// Files live outside the git repo, on a persistent volume, so uploading a new APK
// (replace latest.apk + edit version.json) survives every code redeploy without
// needing a commit. Path is configurable via env var since the actual mount point
// depends on how the volume is set up in Coolify.
const UPDATES_DIR = process.env.APP_UPDATES_DIR || '/data/app-updates';

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

module.exports = router;
