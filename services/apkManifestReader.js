const fs = require('fs');
const zlib = require('zlib');

// Reads the real versionCode out of an uploaded APK's own AndroidManifest.xml, instead of
// trusting whatever number an admin typed into the publish form. That mismatch (form says 15,
// file is actually 14) has twice put drivers into an infinite "update available" loop — the
// server compares its stored number against the phone's real installed version forever, since
// installing the mislabeled file never actually reaches the number the server expects.
//
// An APK is a ZIP file; AndroidManifest.xml inside it is Android's compiled binary XML (AXML),
// not plain text. Both formats are long-stable and well-documented, so this is a small, direct
// reader rather than a general-purpose ZIP/AXML library dependency — same reasoning as the
// hand-rolled TOTP implementation elsewhere in this codebase.

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIR_SIGNATURE = 0x02014b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;

function findEndOfCentralDirectory(buf) {
    // The EOCD record sits at the very end of the file, but a variable-length comment field
    // (max 65535 bytes) can follow it — scan backward far enough to cover the worst case.
    const maxCommentLength = 65535;
    const searchStart = Math.max(0, buf.length - (22 + maxCommentLength));
    for (let i = buf.length - 22; i >= searchStart; i--) {
        if (buf.readUInt32LE(i) === EOCD_SIGNATURE) return i;
    }
    return -1;
}

function findCentralDirectoryEntry(buf, targetName) {
    const eocdOffset = findEndOfCentralDirectory(buf);
    if (eocdOffset === -1) throw new Error('No es un archivo ZIP/APK válido (no se encontró el índice central).');

    const entryCount = buf.readUInt16LE(eocdOffset + 10);
    const centralDirOffset = buf.readUInt32LE(eocdOffset + 16);

    let offset = centralDirOffset;
    for (let i = 0; i < entryCount; i++) {
        if (buf.readUInt32LE(offset) !== CENTRAL_DIR_SIGNATURE) {
            throw new Error('Archivo ZIP/APK corrupto (entrada del índice central inválida).');
        }
        const compressionMethod = buf.readUInt16LE(offset + 10);
        const compressedSize = buf.readUInt32LE(offset + 20);
        const filenameLength = buf.readUInt16LE(offset + 28);
        const extraLength = buf.readUInt16LE(offset + 30);
        const commentLength = buf.readUInt16LE(offset + 32);
        const localHeaderOffset = buf.readUInt32LE(offset + 42);
        const filename = buf.toString('utf8', offset + 46, offset + 46 + filenameLength);

        if (filename === targetName) {
            return { compressionMethod, compressedSize, localHeaderOffset };
        }
        offset += 46 + filenameLength + extraLength + commentLength;
    }
    return null;
}

function extractZipEntry(buf, entry) {
    const { localHeaderOffset, compressionMethod, compressedSize } = entry;
    if (buf.readUInt32LE(localHeaderOffset) !== LOCAL_FILE_SIGNATURE) {
        throw new Error('Archivo ZIP/APK corrupto (encabezado local inválido).');
    }
    const filenameLength = buf.readUInt16LE(localHeaderOffset + 26);
    const extraLength = buf.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + filenameLength + extraLength;
    const compressed = buf.subarray(dataStart, dataStart + compressedSize);

    if (compressionMethod === 0) return compressed; // stored, no compression
    if (compressionMethod === 8) return zlib.inflateRawSync(compressed); // deflate
    throw new Error(`Método de compresión ZIP no soportado (${compressionMethod}).`);
}

// --- Android Binary XML (AXML) — just enough to read one root-element integer attribute ---

const CHUNK_STRING_POOL = 0x0001;
const CHUNK_XML_START_ELEMENT = 0x0102;
const UTF8_FLAG = 1 << 8;

function readAxmlStringPool(buf, chunkStart) {
    const stringCount = buf.readUInt32LE(chunkStart + 8);
    const flags = buf.readUInt32LE(chunkStart + 16);
    const stringsStart = buf.readUInt32LE(chunkStart + 20);
    const isUtf8 = (flags & UTF8_FLAG) !== 0;

    const strings = [];
    const offsetsStart = chunkStart + 28;
    for (let i = 0; i < stringCount; i++) {
        const relOffset = buf.readUInt32LE(offsetsStart + i * 4);
        const strOffset = chunkStart + stringsStart + relOffset;
        if (isUtf8) {
            let pos = strOffset;
            // UTF-16 char-length byte(s) — value itself unused here, only need to skip past it.
            if (buf[pos] & 0x80) pos += 2; else pos += 1;
            let byteLen = buf[pos];
            pos += 1;
            if (byteLen & 0x80) {
                byteLen = ((byteLen & 0x7f) << 8) | buf[pos];
                pos += 1;
            }
            strings.push(buf.toString('utf8', pos, pos + byteLen));
        } else {
            let pos = strOffset;
            let charLen = buf.readUInt16LE(pos);
            pos += 2;
            if (charLen & 0x8000) {
                charLen = ((charLen & 0x7fff) << 16) | buf.readUInt16LE(pos);
                pos += 2;
            }
            strings.push(buf.toString('utf16le', pos, pos + charLen * 2));
        }
    }
    return strings;
}

// Returns the versionCode declared on the root <manifest> element, or null if it can't be found
// (caller decides how strict to be — this is a best-effort safety net, not the only check).
function readVersionCodeFromAxml(buf) {
    if (buf.readUInt32LE(0) !== 0x00080003) {
        throw new Error('AndroidManifest.xml no tiene el formato binario esperado.');
    }

    let stringPool = null;
    let offset = 8; // past the top-level chunk header (type u16, headerSize u16, size u32)

    while (offset < buf.length) {
        const chunkType = buf.readUInt16LE(offset);
        const chunkSize = buf.readUInt32LE(offset + 4);
        if (chunkSize <= 0) break;

        if (chunkType === CHUNK_STRING_POOL) {
            stringPool = readAxmlStringPool(buf, offset);
        } else if (chunkType === CHUNK_XML_START_ELEMENT) {
            const elementNameIdx = buf.readUInt32LE(offset + 20);
            const elementName = stringPool && stringPool[elementNameIdx];

            if (elementName === 'manifest') {
                const attrCount = buf.readUInt16LE(offset + 28);
                let attrOffset = offset + 36; // start of attribute array
                for (let i = 0; i < attrCount; i++) {
                    const attrNameIdx = buf.readUInt32LE(attrOffset + 4);
                    const attrName = stringPool && stringPool[attrNameIdx];
                    const dataType = buf[attrOffset + 15];
                    const data = buf.readUInt32LE(attrOffset + 16);
                    // TYPE_INT_DEC = 0x10, TYPE_INT_HEX = 0x11 — versionCode is always a plain
                    // integer, never a string/reference, in every APK produced by real tooling.
                    if (attrName === 'versionCode' && (dataType === 0x10 || dataType === 0x11)) {
                        return data;
                    }
                    attrOffset += 20;
                }
                return null; // found <manifest> but no versionCode attribute on it
            }
        }
        offset += chunkSize;
    }
    return null;
}

// Returns the real versionCode from an APK file on disk, or null if it genuinely can't be read
// (corrupt/unexpected format) — callers should treat null as "couldn't verify", not "version 0".
function getVersionCodeFromApk(apkPath) {
    const buf = fs.readFileSync(apkPath);
    const entry = findCentralDirectoryEntry(buf, 'AndroidManifest.xml');
    if (!entry) throw new Error('El archivo no contiene AndroidManifest.xml — no parece ser un APK válido.');
    const manifestBuf = extractZipEntry(buf, entry);
    return readVersionCodeFromAxml(manifestBuf);
}

module.exports = { getVersionCodeFromApk };
