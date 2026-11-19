const fs = require('fs');
const { GoogleGenAI, createPartFromUri } = require('@google/genai');
const { classifyMessageHint } = require('./categorizer');
const {
    buildMorningSystemPrompt,
    buildEveningSystemPrompt,
    buildChunkSystemPrompt,
    buildMergeSystemPrompt
} = require('./prompts');

function defaultSleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function formatTime(timestampMs, timezone = 'Europe/Rome') {
    try {
        return new Intl.DateTimeFormat('it-IT', {
            timeZone: timezone,
            hour: '2-digit',
            minute: '2-digit'
        }).format(new Date(timestampMs));
    } catch {
        return new Date(timestampMs).toISOString().slice(11, 16);
    }
}

function formatDateTime(timestampMs, timezone = 'Europe/Rome') {
    try {
        return new Intl.DateTimeFormat('it-IT', {
            timeZone: timezone,
            day: '2-digit',
            month: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
        }).format(new Date(timestampMs));
    } catch {
        return new Date(timestampMs).toISOString();
    }
}

function getTotalAudioDurationSeconds(messages) {
    return (messages || []).reduce((acc, m) => {
        if (m && m.audioPath && Number(m.audioDurationSec) > 0) {
            return acc + Number(m.audioDurationSec);
        }
        return acc;
    }, 0);
}

/**
 * Gestione "Mappazzone XL":
 * - Se durata totale vocali <= thresholdMinutes: 1 singolo blocco.
 * - Altrimenti divide cronologicamente in 2 blocchi (o N se supera 2x la soglia)
 *   bilanciando la durata dei vocali tra i blocchi.
 */
function splitMessagesIntoChunks(messages, thresholdMinutes = 60) {
    if (!Array.isArray(messages) || messages.length === 0) return [];

    const totalAudioSec = getTotalAudioDurationSeconds(messages);
    const thresholdSec = thresholdMinutes * 60;

    if (totalAudioSec <= thresholdSec) {
        return [messages];
    }

    const numBlocks = Math.max(2, Math.ceil(totalAudioSec / thresholdSec));
    const targetSecPerBlock = totalAudioSec / numBlocks;

    const chunks = [];
    let currentChunk = [];
    let currentAudioSec = 0;

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        const msgAudioSec = msg.audioPath ? Number(msg.audioDurationSec || 0) : 0;

        const remainingBlocks = numBlocks - chunks.length;
        const shouldCut =
            remainingBlocks > 1 &&
            currentChunk.length > 0 &&
            currentAudioSec >= targetSecPerBlock;

        if (shouldCut) {
            chunks.push(currentChunk);
            currentChunk = [];
            currentAudioSec = 0;
        }

        currentChunk.push(msg);
        currentAudioSec += msgAudioSec;
    }

    if (currentChunk.length > 0) {
        chunks.push(currentChunk);
    }

    return chunks;
}

/**
 * Converte i messaggi di un blocco in un transcript strutturato per chat,
 * mantenendo il riferimento esatto [AUDIO #N] ai file caricati via File API.
 */
function buildTranscriptAndAudioList(messages, config) {
    const byChat = new Map();
    const audioItems = [];

    for (const msg of messages) {
        const key = msg.chatId || msg.chatName || 'unknown';
        if (!byChat.has(key)) {
            byChat.set(key, {
                chatId: msg.chatId,
                chatName: msg.chatName || msg.chatId || 'Sconosciuto',
                isGroup: Boolean(msg.isGroup),
                hint: 'AUTO',
                entries: []
            });
        }

        const bucket = byChat.get(key);
        const msgHint = classifyMessageHint(msg, config);
        if (msgHint === 'WORK_HINT') {
            bucket.hint = 'WORK_HINT';
        }
        bucket.entries.push(msg);
    }

    const lines = [];
    let audioCounter = 0;

    for (const bucket of byChat.values()) {
        const kindLabel = bucket.isGroup ? 'GRUPPO' : 'CHAT PRIVATA';
        const hintLabel = bucket.hint === 'WORK_HINT' ? 'HINT: LAVORO' : 'HINT: AUTO';
        lines.push(`=== ${kindLabel}: "${bucket.chatName}" [${hintLabel}] ===`);

        for (const msg of bucket.entries) {
            const timeStr = formatTime(msg.timestamp, config.timezone);
            const speaker = msg.fromMe ? '[IO]' : msg.senderName || 'Sconosciuto';

            if (msg.audioPath && fs.existsSync(msg.audioPath)) {
                audioCounter++;
                const durSec = Math.round(Number(msg.audioDurationSec || 0));
                const audioTag = `AUDIO #${audioCounter}`;
                audioItems.push({
                    tag: audioTag,
                    chatName: bucket.chatName,
                    speaker,
                    timeStr,
                    audioPath: msg.audioPath,
                    mimeType: msg.audioMimeType || 'audio/ogg'
                });
                const caption = msg.body ? ` (testo: ${msg.body})` : '';
                lines.push(`[${timeStr}] ${speaker}: [${audioTag} | durata ~${durSec}s]${caption}`);
            } else if (msg.body && msg.body.trim()) {
                lines.push(`[${timeStr}] ${speaker}: ${msg.body.trim()}`);
            } else if (msg.type && msg.type !== 'chat') {
                lines.push(`[${timeStr}] ${speaker}: [Media: ${msg.type}]`);
            }
        }
        lines.push('');
    }

    return {
        transcript: lines.join('\n').trim(),
        audioItems
    };
}

class GeminiService {
    constructor(config, deps = {}) {
        this.config = config;
        this.sleep = deps.sleepFn || defaultSleep;
        this.ai = deps.aiClient || null;
    }

    _getClient() {
        if (!this.ai) {
            if (!this.config.geminiApiKey) {
                throw new Error('GEMINI_API_KEY non configurata nel file .env');
            }
            this.ai = new GoogleGenAI({ apiKey: this.config.geminiApiKey });
        }
        return this.ai;
    }

    async waitForFileActive(ai, uploadedFile, maxWaitMs = 60000) {
        if (!uploadedFile || !uploadedFile.state || uploadedFile.state === 'ACTIVE') {
            return uploadedFile;
        }

        const deadline = Date.now() + maxWaitMs;
        let current = uploadedFile;

        while (current.state === 'PROCESSING' && Date.now() < deadline) {
            await this.sleep(2000);
            if (typeof ai.files.get === 'function') {
                current = await ai.files.get({ name: current.name });
            } else {
                break;
            }
        }

        if (current.state === 'FAILED') {
            throw new Error(`File API processing fallito per ${current.name}`);
        }
        return current;
    }

    async uploadAudioItems(audioItems) {
        if (!audioItems || audioItems.length === 0) return [];
        const ai = this._getClient();
        const uploaded = [];

        for (const item of audioItems) {
            try {
                const fileRes = await ai.files.upload({
                    file: item.audioPath,
                    config: {
                        mimeType: item.mimeType,
                        displayName: `${item.tag}_${item.chatName}`.slice(0, 100)
                    }
                });
                const readyFile = await this.waitForFileActive(ai, fileRes);
                uploaded.push({
                    item,
                    file: readyFile
                });
            } catch (err) {
                console.error(
                    `[Gemini File API] Errore upload ${item.tag} (${item.audioPath}):`,
                    err.message
                );
            }
        }

        return uploaded;
    }

    async cleanupUploadedFiles(uploadedFiles) {
        if (!uploadedFiles || uploadedFiles.length === 0) return;
        const ai = this._getClient();

        for (const entry of uploadedFiles) {
            const name = entry?.file?.name;
            if (!name || typeof ai.files.delete !== 'function') continue;
            try {
                await ai.files.delete({ name });
            } catch (err) {
                console.warn(`[Gemini File API] Errore pulizia file ${name}:`, err.message);
            }
        }
    }

    async generateWithFallback({ systemInstruction, contents }) {
        const ai = this._getClient();
        const errors = [];

        for (const model of this.config.modelChain) {
            try {
                console.log(`[Gemini] Invio richiesta al modello: ${model}...`);
                const response = await ai.models.generateContent({
                    model,
                    contents,
                    config: {
                        systemInstruction
                    }
                });

                const text = (response?.text || '').trim();
                if (!text) {
                    throw new Error('Risposta vuota dal modello');
                }
                return { text, modelUsed: model };
            } catch (err) {
                console.error(`[Gemini] Modello ${model} fallito: ${err.message}`);
                errors.push(`${model}: ${err.message}`);
            }
        }

        throw new Error(`Tutti i modelli Gemini hanno fallito (${errors.join(' | ')})`);
    }

    _buildMultimodalContents(introText, transcript, uploadedFiles) {
        const contents = [introText, `TRASCRIZIONE CHAT:\n${transcript}`];

        for (const entry of uploadedFiles) {
            const { item, file } = entry;
            contents.push(
                `Riferimento audio seguente: [${item.tag} | Chat: ${item.chatName} | Mittente: ${item.speaker} | Ora: ${item.timeStr}]`
            );
            contents.push(createPartFromUri(file.uri, file.mimeType || item.mimeType));
        }

        return contents;
    }

    async summarizeMessages(messages, { mode = 'morning', dateLabel, sinceLabel } = {}) {
        const chunks = splitMessagesIntoChunks(messages, this.config.audioChunkThresholdMinutes);
        if (chunks.length === 0) {
            return { text: '', modelUsed: null, chunked: false, chunksCount: 0 };
        }

        const totalAudioMin = Math.round((getTotalAudioDurationSeconds(messages) / 60) * 10) / 10;

        // Caso standard: 1 chiamata unica
        if (chunks.length === 1) {
            const { transcript, audioItems } = buildTranscriptAndAudioList(chunks[0], this.config);
            const uploadedFiles = await this.uploadAudioItems(audioItems);

            try {
                const systemInstruction =
                    mode === 'evening'
                        ? buildEveningSystemPrompt(dateLabel, sinceLabel, this.config)
                        : buildMorningSystemPrompt(dateLabel, this.config);

                const intro = `Analizza tutti i messaggi e i ${uploadedFiles.length} file audio allegati (durata totale ~${totalAudioMin} min) e genera il riassunto finale.`;
                const contents = this._buildMultimodalContents(intro, transcript, uploadedFiles);
                const result = await this.generateWithFallback({ systemInstruction, contents });

                return {
                    ...result,
                    chunked: false,
                    chunksCount: 1,
                    audioCount: uploadedFiles.length,
                    totalAudioMin
                };
            } finally {
                await this.cleanupUploadedFiles(uploadedFiles);
            }
        }

        // Caso "Mappazzone XL": chunking in N blocchi (di norma 2) con pausa 65s + merge finale
        console.log(
            `[Gemini] Mappazzone XL rilevato (~${totalAudioMin} min > soglia ${this.config.audioChunkThresholdMinutes} min). Divisione in ${chunks.length} blocchi con pausa di ${this.config.chunkCooldownSeconds}s.`
        );

        const miniSummaries = [];
        let totalUploadedAudio = 0;

        for (let i = 0; i < chunks.length; i++) {
            const blockMessages = chunks[i];
            const firstTs = blockMessages[0].timestamp;
            const lastTs = blockMessages[blockMessages.length - 1].timestamp;
            const rangeLabel = `${formatDateTime(firstTs, this.config.timezone)} → ${formatDateTime(lastTs, this.config.timezone)}`;

            const { transcript, audioItems } = buildTranscriptAndAudioList(blockMessages, this.config);
            const uploadedFiles = await this.uploadAudioItems(audioItems);
            totalUploadedAudio += uploadedFiles.length;

            try {
                const systemInstruction = buildChunkSystemPrompt(
                    i + 1,
                    chunks.length,
                    rangeLabel,
                    this.config
                );
                const intro = `Elabora il blocco ${i + 1}/${chunks.length} (${rangeLabel}) con ${uploadedFiles.length} file audio allegati.`;
                const contents = this._buildMultimodalContents(intro, transcript, uploadedFiles);

                const blockResult = await this.generateWithFallback({ systemInstruction, contents });
                miniSummaries.push({
                    blockNumber: i + 1,
                    rangeLabel,
                    modelUsed: blockResult.modelUsed,
                    text: blockResult.text
                });
            } finally {
                await this.cleanupUploadedFiles(uploadedFiles);
            }

            // Pausa di 65 secondi tra un blocco e il successivo per azzerare il contatore TPM
            if (i < chunks.length - 1) {
                const waitMs = this.config.chunkCooldownSeconds * 1000;
                console.log(
                    `[Gemini] Pausa di ${this.config.chunkCooldownSeconds}s per reset finestra TPM prima del blocco ${i + 2}...`
                );
                await this.sleep(waitMs);
            }
        }

        // Chiamata finale di merge (solo testo, leggera)
        const mergeSystemInstruction = buildMergeSystemPrompt(
            mode,
            dateLabel,
            sinceLabel,
            this.config
        );
        const mergeInput = miniSummaries
            .map(
                s =>
                    `--- MINI-RIASSUNTO BLOCCO ${s.blockNumber} (${s.rangeLabel}) ---\n${s.text}`
            )
            .join('\n\n');

        const finalResult = await this.generateWithFallback({
            systemInstruction: mergeSystemInstruction,
            contents: [
                `Unisci questi ${miniSummaries.length} mini-riassunti nel messaggio finale formattato per WhatsApp:\n\n${mergeInput}`
            ]
        });

        return {
            ...finalResult,
            chunked: true,
            chunksCount: chunks.length,
            audioCount: totalUploadedAudio,
            totalAudioMin
        };
    }
}

module.exports = {
    GeminiService,
    splitMessagesIntoChunks,
    getTotalAudioDurationSeconds,
    buildTranscriptAndAudioList
};
