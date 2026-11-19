const fs = require('fs');
const path = require('path');

const MIME_EXT_MAP = {
    'audio/ogg': '.ogg',
    'audio/mpeg': '.mp3',
    'audio/mp3': '.mp3',
    'audio/mp4': '.m4a',
    'audio/aac': '.aac',
    'audio/wav': '.wav',
    'audio/webm': '.webm',
    'audio/amr': '.amr'
};

function normalizeAudioMimeType(rawMime) {
    if (!rawMime || typeof rawMime !== 'string') return 'audio/ogg';
    const clean = rawMime.split(';')[0].trim().toLowerCase();
    return clean.startsWith('audio/') ? clean : 'audio/ogg';
}

/**
 * Parses duration in seconds from an Ogg/Opus buffer by reading the last OggS page granule position (48 kHz).
 * Returns null if not a valid Ogg buffer.
 */
function parseOggOpusDurationSec(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 27) return null;
    // Check magic "OggS" at start
    if (buffer.toString('ascii', 0, 4) !== 'OggS') return null;

    // Scan backwards from the end for the last "OggS" page header
    const maxScan = Math.min(buffer.length, 65536);
    const startOffset = buffer.length - maxScan;
    let lastPageIdx = -1;

    for (let i = buffer.length - 14; i >= startOffset; i--) {
        if (
            buffer[i] === 0x4f && // O
            buffer[i + 1] === 0x67 && // g
            buffer[i + 2] === 0x67 && // g
            buffer[i + 3] === 0x53 // S
        ) {
            lastPageIdx = i;
            break;
        }
    }

    if (lastPageIdx === -1 || lastPageIdx + 14 > buffer.length) return null;

    // Granule position is a 64-bit little-endian integer at offset +6..+13
    const granule = buffer.readBigInt64LE(lastPageIdx + 6);
    if (granule <= 0n) return null;

    // Opus granule position is always at 48000 Hz
    const seconds = Number(granule) / 48000;
    return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 10) / 10 : null;
}

function estimateAudioDurationSec(buffer, mimeType, rawDuration) {
    const parsedRaw = Number(rawDuration);
    if (Number.isFinite(parsedRaw) && parsedRaw > 0) {
        return Math.round(parsedRaw * 10) / 10;
    }

    if (Buffer.isBuffer(buffer) && buffer.length > 0) {
        if (mimeType === 'audio/ogg') {
            const oggSec = parseOggOpusDurationSec(buffer);
            if (oggSec !== null) return oggSec;
        }
        // Fallback estimate: WhatsApp voice notes are typically ~16-24 kbps (~2.5 KB/s)
        const estimated = buffer.length / 2500;
        return Math.max(1, Math.round(estimated * 10) / 10);
    }

    return 0;
}

function sanitizeFilename(input) {
    return String(input || 'msg').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
}

class MessageStorage {
    constructor(dataDir) {
        this.dataDir = dataDir;
        this.audioDir = path.join(dataDir, 'audio');
        this.messagesFile = path.join(dataDir, 'messages.jsonl');
        this.stateFile = path.join(dataDir, 'state.json');
        this.seenIds = new Set();

        this._ensureDirs();
        this.state = this._loadState();
        this._loadSeenIds();
    }

    _ensureDirs() {
        fs.mkdirSync(this.dataDir, { recursive: true });
        fs.mkdirSync(this.audioDir, { recursive: true });
    }

    _loadState() {
        const defaultState = {
            lastMorningRunAt: null,
            lastEveningRunAt: null,
            sentBotMessageIds: []
        };
        try {
            if (fs.existsSync(this.stateFile)) {
                const parsed = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
                return {
                    ...defaultState,
                    ...parsed,
                    sentBotMessageIds: Array.isArray(parsed.sentBotMessageIds)
                        ? parsed.sentBotMessageIds
                        : []
                };
            }
        } catch (err) {
            console.error('[Storage] Errore lettura state.json, uso stato di default:', err.message);
        }
        return defaultState;
    }

    _saveState() {
        const tmpFile = `${this.stateFile}.tmp`;
        fs.writeFileSync(tmpFile, JSON.stringify(this.state, null, 2), 'utf8');
        fs.renameSync(tmpFile, this.stateFile);
    }

    _loadSeenIds() {
        if (!fs.existsSync(this.messagesFile)) return;
        try {
            const content = fs.readFileSync(this.messagesFile, 'utf8');
            for (const line of content.split('\n')) {
                if (!line.trim()) continue;
                try {
                    const rec = JSON.parse(line);
                    if (rec && rec.id) this.seenIds.add(rec.id);
                } catch {
                    // Ignore malformed lines
                }
            }
        } catch (err) {
            console.error('[Storage] Errore caricamento seenIds:', err.message);
        }
    }

    isBotSentMessage(msgId) {
        return Boolean(msgId && this.state.sentBotMessageIds.includes(msgId));
    }

    recordBotSentMessage(msgId) {
        if (!msgId) return;
        if (!this.state.sentBotMessageIds.includes(msgId)) {
            this.state.sentBotMessageIds.push(msgId);
            if (this.state.sentBotMessageIds.length > 500) {
                this.state.sentBotMessageIds = this.state.sentBotMessageIds.slice(-500);
            }
            this._saveState();
        }
    }

    getState() {
        return { ...this.state };
    }

    setLastMorningRunAt(timestampMs) {
        this.state.lastMorningRunAt = timestampMs;
        this._saveState();
    }

    setLastEveningRunAt(timestampMs) {
        this.state.lastEveningRunAt = timestampMs;
        this._saveState();
    }

    saveAudioMedia(msgId, base64Data, rawMimeType, rawDuration) {
        const audioMimeType = normalizeAudioMimeType(rawMimeType);
        const ext = MIME_EXT_MAP[audioMimeType] || '.ogg';
        const buffer = Buffer.from(base64Data, 'base64');
        const filename = `${Date.now()}_${sanitizeFilename(msgId)}${ext}`;
        const audioPath = path.join(this.audioDir, filename);

        fs.writeFileSync(audioPath, buffer);
        const audioDurationSec = estimateAudioDurationSec(buffer, audioMimeType, rawDuration);

        return {
            audioPath,
            audioMimeType,
            audioDurationSec
        };
    }

    appendMessage(record) {
        if (!record || !record.id) return false;
        if (this.seenIds.has(record.id)) return false;
        if (this.isBotSentMessage(record.id)) return false;

        this.seenIds.add(record.id);
        fs.appendFileSync(this.messagesFile, `${JSON.stringify(record)}\n`, 'utf8');
        return true;
    }

    getMessagesBetween(startMs, endMs) {
        if (!fs.existsSync(this.messagesFile)) return [];
        const botSet = new Set(this.state.sentBotMessageIds);
        const results = [];

        const content = fs.readFileSync(this.messagesFile, 'utf8');
        for (const line of content.split('\n')) {
            if (!line.trim()) continue;
            try {
                const rec = JSON.parse(line);
                if (!rec || typeof rec.timestamp !== 'number') continue;
                if (botSet.has(rec.id)) continue;
                if (rec.timestamp >= startMs && rec.timestamp <= endMs) {
                    results.push(rec);
                }
            } catch {
                // Skip corrupted line
            }
        }

        results.sort((a, b) => a.timestamp - b.timestamp);
        return results;
    }

    cleanupOldData(retentionHours = 72, nowMs = Date.now()) {
        const cutoffMs = nowMs - retentionHours * 3600 * 1000;
        const keptLines = [];
        const activeAudioPaths = new Set();

        if (fs.existsSync(this.messagesFile)) {
            const content = fs.readFileSync(this.messagesFile, 'utf8');
            for (const line of content.split('\n')) {
                if (!line.trim()) continue;
                try {
                    const rec = JSON.parse(line);
                    if (rec && typeof rec.timestamp === 'number' && rec.timestamp >= cutoffMs) {
                        keptLines.push(JSON.stringify(rec));
                        if (rec.audioPath) {
                            activeAudioPaths.add(path.resolve(rec.audioPath));
                        }
                    }
                } catch {
                    // Drop malformed lines during cleanup
                }
            }

            const tmpFile = `${this.messagesFile}.tmp`;
            fs.writeFileSync(tmpFile, keptLines.length ? `${keptLines.join('\n')}\n` : '', 'utf8');
            fs.renameSync(tmpFile, this.messagesFile);
        }

        let deletedAudioCount = 0;
        if (fs.existsSync(this.audioDir)) {
            for (const file of fs.readdirSync(this.audioDir)) {
                const fullPath = path.resolve(this.audioDir, file);
                if (activeAudioPaths.has(fullPath)) continue;
                try {
                    const stat = fs.statSync(fullPath);
                    if (stat.mtimeMs < cutoffMs) {
                        fs.unlinkSync(fullPath);
                        deletedAudioCount++;
                    }
                } catch {
                    // Ignore race errors
                }
            }
        }

        return {
            keptMessages: keptLines.length,
            deletedAudioCount
        };
    }
}

module.exports = {
    MessageStorage,
    normalizeAudioMimeType,
    parseOggOpusDurationSec,
    estimateAudioDurationSec
};
