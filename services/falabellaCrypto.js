const crypto = require('crypto');

const ENCRYPTION_KEY = crypto.createHash('sha256')
    .update(process.env.JWT_SECRET || 'fullenvios_jwt_secret_2024')
    .digest();
const IV_LENGTH = 16;

function encrypt(text) {
    if (!text) return null;
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
    let encrypted = cipher.update(text, 'utf8');
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decrypt(text) {
    if (!text) return null;
    try {
        const textParts = text.split(':');
        const iv = Buffer.from(textParts.shift(), 'hex');
        const encryptedText = Buffer.from(textParts.join(':'), 'hex');
        const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
        let decrypted = decipher.update(encryptedText);
        decrypted = Buffer.concat([decrypted, decipher.final()]);
        return decrypted.toString('utf8');
    } catch (e) {
        return text;
    }
}

// Signs a (packageId, photoIndex) pair so the delivery-evidence photo route can be reached by
// Falabella's servers (no session/JWT available there) without being a fully open, enumerable
// URL — package IDs are short and guessable, and these are real people's photos/addresses.
function signPhotoToken(packageId, index) {
    return crypto.createHmac('sha256', ENCRYPTION_KEY)
        .update(`${packageId}:${index}`)
        .digest('hex');
}

function verifyPhotoToken(packageId, index, token) {
    if (!token) return false;
    const expected = signPhotoToken(packageId, index);
    const expectedBuf = Buffer.from(expected, 'hex');
    const tokenBuf = Buffer.from(String(token), 'hex');
    if (expectedBuf.length !== tokenBuf.length) return false;
    return crypto.timingSafeEqual(expectedBuf, tokenBuf);
}

function buildFalabellaSignature(params, apiKey) {
    const sortedKeys = Object.keys(params).sort();
    const sortedParams = {};
    sortedKeys.forEach(key => {
        sortedParams[key] = params[key];
    });

    const queryString = Object.entries(sortedParams)
        .map(([key, val]) => `${encodeURIComponent(key)}=${encodeURIComponent(val)}`)
        .join('&');

    return crypto.createHmac('sha256', apiKey)
        .update(queryString)
        .digest('hex');
}

module.exports = {
    encrypt,
    decrypt,
    buildFalabellaSignature,
    signPhotoToken,
    verifyPhotoToken
};
